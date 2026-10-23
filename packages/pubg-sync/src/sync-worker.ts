import {
  createTeamContext,
  PubgApiClient,
  PubgApiTelemetryDownloader,
  PubgDomainService,
  TelemetryWorker,
  type TeamConfig,
  type TeamContext,
  type TelemetryDownloader,
} from '@rine-kit/pubg-domain/core';
import type { Pool, QueryResultRow } from 'pg';
import type { PublicPubgAdmission } from './request-limiter.js';
import { validatePublicPubgShard } from './player-resolver.js';
import {
  MAX_TEAM_ROSTER_SIZE,
  PostgresPubgRepository,
  PublicSyncQueue,
  type PublicSyncJob,
  type PublicSyncQueueSnapshot,
} from '@rine-kit/pubg-postgres';

const API_ORIGIN = 'https://api.pubg.com';
const TELEMETRY_HOSTS = new Set(['telemetry-cdn.pubg.com', 'telemetry-cdn.playbattlegrounds.com']);
const MAX_API_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_TELEMETRY_RESPONSE_BYTES = 96 * 1024 * 1024;
const DEFAULT_MAX_MATCHES = 500;
const DEFAULT_MAX_TELEMETRY_FETCHES = 20;
const DEFAULT_TELEMETRY_CONCURRENCY = 2;
const DEFAULT_TEAM_CONCURRENCY = 2;
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000;
const ACCOUNT_ID = /^account\.[A-Za-z0-9_-]{1,128}$/u;
const MATCH_ID = /^[A-Za-z0-9_.-]{1,128}$/u;

export interface PublicSyncCycleResult {
  teamsDiscovered: number;
  teamsAttempted: number;
  teamsCompleted: number;
  teamsFailed: number;
  matchesDiscovered: number;
  telemetryFetched: number;
  telemetryUnavailable: number;
}

export interface PublicSyncWorkerOptions {
  apiKey: string;
  admission: PublicPubgAdmission;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxMatches?: number;
  maxTelemetryFetches?: number;
  telemetryConcurrency?: number;
  teamConcurrency?: number;
  syncIntervalMs?: number;
  leaseMs?: number;
  onTeamError?: (code: 'public_sync_team_invalid' | 'public_sync_team_failed') => void;
}

interface TeamRow extends QueryResultRow {
  tenant_id: string;
  team_id: string;
  label: string;
  pubg_shard: string;
  pubg_account_id: string | null;
  official_name: string | null;
  display_alias: string | null;
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('public_sync_config_invalid');
  return value || fallback;
}

function boundedResponse(response: Response, maxBytes: number): Response {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('public_sync_response_too_large');
  }
  if (!response.body || response.status === 204 || response.status === 304) return response;
  let size = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        controller.error(new Error('public_sync_response_too_large'));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function endpoint(url: URL): { kind: 'api' | 'telemetry'; rateLimited: boolean; maxBytes: number } {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('public_sync_endpoint_invalid');
  if (url.origin === API_ORIGIN) {
    const isPlayers = /^\/shards\/(steam|kakao|psn|xbox)\/players$/u.test(url.pathname);
    const isMatch = /^\/shards\/(steam|kakao|psn|xbox)\/matches\/[A-Za-z0-9_.-]{1,128}$/u.test(url.pathname);
    if (isPlayers) {
      const ids = url.searchParams.getAll('filter[playerIds]');
      if (url.searchParams.size !== 1 || ids.length !== 1 || ids[0]!.split(',').length > MAX_TEAM_ROSTER_SIZE
        || ids[0]!.split(',').some((id) => !ACCOUNT_ID.test(id))) throw new Error('public_sync_endpoint_invalid');
    } else if (!isMatch || url.search !== '') {
      throw new Error('public_sync_endpoint_invalid');
    }
    // PUBG's rate-limited player discovery endpoint uses shared admission.
    // Match detail requests are not counted by PUBG and follow Kurisu's
    // behavior without an extra public-only gate.
    return { kind: 'api', rateLimited: isPlayers, maxBytes: MAX_API_RESPONSE_BYTES };
  }
  if (TELEMETRY_HOSTS.has(url.hostname) && url.search === ''
    && /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]*-telemetry\.json$/u.test(url.pathname)) {
    return { kind: 'telemetry', rateLimited: false, maxBytes: MAX_TELEMETRY_RESPONSE_BYTES };
  }
  throw new Error('public_sync_endpoint_invalid');
}

/** Restricts the worker to official public PUBG API and telemetry endpoints.
 * Rate-limited player discovery uses shared admission; match details follow the
 * provider's unmetered endpoint policy. Public telemetry CDN objects never
 * receive the API key. Redirects are rejected. */
export function createPublicSyncFetch(
  admission: PublicPubgAdmission,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const target = endpoint(url);
    if ((init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'GET') throw new Error('public_sync_method_invalid');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (target.kind === 'telemetry' && headers.has('authorization')) throw new Error('public_sync_telemetry_auth_forbidden');
    if (target.kind === 'api' && !/^Bearer\s+\S+$/iu.test(headers.get('authorization') ?? '')) throw new Error('public_sync_api_auth_missing');
    if (target.rateLimited) await admission.acquire(init?.signal ?? (input instanceof Request ? input.signal : undefined));
    const response = await fetchImpl(url, { ...init, headers, redirect: 'error' });
    if (target.rateLimited) await admission.observe(response.headers, response.status);
    return boundedResponse(response, target.maxBytes);
  };
}

class InvalidTeamError extends Error {
  constructor() { super('public_sync_team_invalid'); }
}

async function registeredTeam(pool: Pool, tenantId: string, teamId: string): Promise<TeamContext> {
  const result = await pool.query<TeamRow>(
    `SELECT team.tenant_id,team.team_id,team.label,team.pubg_shard,member.pubg_account_id,
       COALESCE(account.display_name,member.pubg_account_id) AS official_name,alias.display_alias
     FROM pubg_teams team
     LEFT JOIN pubg_team_members member ON member.tenant_id=team.tenant_id AND member.team_id=team.team_id
     LEFT JOIN pubg_account_names account ON account.shard=team.pubg_shard AND account.account_id=member.pubg_account_id
     LEFT JOIN pubg_team_aliases alias ON alias.tenant_id=member.tenant_id AND alias.team_id=member.team_id
       AND alias.pubg_account_id=member.pubg_account_id
     WHERE team.tenant_id=$1 AND team.team_id=$2
     ORDER BY member.pubg_account_id,alias.alias_key`,
    [tenantId, teamId],
  );
  if (!result.rows.length) throw new InvalidTeamError();
  const first = result.rows[0]!;
  const players = new Map<string, { id: string; name: string; aliases: string[] }>();
  for (const row of result.rows) {
    if (!row.pubg_account_id) continue;
    let player = players.get(row.pubg_account_id);
    if (!player) {
      player = { id: row.pubg_account_id, name: row.official_name?.trim() || row.pubg_account_id, aliases: [] };
      players.set(row.pubg_account_id, player);
    }
    if (row.display_alias?.trim() && !player.aliases.includes(row.display_alias.trim())) player.aliases.push(row.display_alias.trim());
  }
  try {
    validatePublicPubgShard(first.pubg_shard);
    const team: TeamConfig = {
      id: first.team_id,
      label: first.label,
      platform: first.pubg_shard,
      players: [...players.values()],
    };
    if (team.players.length < 1 || team.players.length > MAX_TEAM_ROSTER_SIZE
      || team.players.some((player) => !ACCOUNT_ID.test(player.id) || player.name.length > 100
        || player.aliases.some((alias) => alias.length > 100 || /[\u0000-\u001f]/u.test(alias)))) {
      throw new InvalidTeamError();
    }
    return createTeamContext(first.tenant_id, team);
  } catch (error) {
    if (error instanceof InvalidTeamError) throw error;
    throw new InvalidTeamError();
  }
}

function numberFrom(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? Math.trunc(result) : 0;
}

function telemetryRun(value: unknown): { discovered: number; fetched: number; unavailable: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { discovered: 0, fetched: 0, unavailable: 0 };
  const data = value as Record<string, unknown>;
  const run = data.run && typeof data.run === 'object' && !Array.isArray(data.run)
    ? data.run as Record<string, unknown>
    : {};
  return {
    discovered: numberFrom(run.discoveredMatchCount),
    fetched: numberFrom(run.fetchedCount),
    unavailable: numberFrom(run.unavailableCount),
  };
}

/** Independent public-SaaS ingestion process. It loads only registered SaaS
 * rosters, syncs them through the shared PUBG Domain and writes to PG through
 * the tenant/team scoped repository. */
export class PublicSyncWorker {
  private readonly client: PubgApiClient;
  private readonly telemetryDownloader: TelemetryDownloader;
  private readonly now: () => Date;
  private readonly maxMatches: number;
  private readonly maxTelemetryFetches: number;
  private readonly telemetryConcurrency: number;
  private readonly teamConcurrency: number;
  private readonly syncIntervalMs: number;
  private readonly leaseMs: number;
  private readonly queue: PublicSyncQueue;

  constructor(private readonly pool: Pool, options: PublicSyncWorkerOptions) {
    if (!options.apiKey.trim()) throw new Error('public_pubg_api_key_missing');
    this.maxMatches = boundedInteger(options.maxMatches ?? DEFAULT_MAX_MATCHES, DEFAULT_MAX_MATCHES, 1, 1000);
    this.maxTelemetryFetches = boundedInteger(options.maxTelemetryFetches ?? DEFAULT_MAX_TELEMETRY_FETCHES, DEFAULT_MAX_TELEMETRY_FETCHES, 1, 50);
    this.telemetryConcurrency = boundedInteger(options.telemetryConcurrency ?? DEFAULT_TELEMETRY_CONCURRENCY, DEFAULT_TELEMETRY_CONCURRENCY, 1, 4);
    this.teamConcurrency = boundedInteger(options.teamConcurrency ?? DEFAULT_TEAM_CONCURRENCY, DEFAULT_TEAM_CONCURRENCY, 1, 16);
    this.syncIntervalMs = boundedInteger(options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS, DEFAULT_SYNC_INTERVAL_MS, 1_000, 24 * 60 * 60_000);
    this.leaseMs = boundedInteger(options.leaseMs ?? 120_000, 120_000, 1_000, 15 * 60_000);
    this.queue = new PublicSyncQueue(pool, { leaseMs: this.leaseMs });
    this.now = options.now ?? (() => new Date());
    const fetchImpl = createPublicSyncFetch(options.admission, options.fetchImpl);
    // Use the shared Domain client's retry, concurrency, and timeout defaults,
    // matching the private Kurisu plugin configuration. Upstream admission is
    // still enforced independently by the shared PostgreSQL limiter.
    this.client = new PubgApiClient({ apiKey: options.apiKey, baseUrl: API_ORIGIN, fetchImpl });
    this.telemetryDownloader = new PubgApiTelemetryDownloader({
      apiKey: options.apiKey,
      baseUrl: API_ORIGIN,
      timeoutMs: 60_000,
      fetchImpl,
    });
    this.onTeamError = options.onTeamError ?? (() => undefined);
  }

  private readonly onTeamError: (code: 'public_sync_team_invalid' | 'public_sync_team_failed') => void;

  async runOnce(signal?: AbortSignal): Promise<PublicSyncCycleResult> {
    const teamsDiscovered = await this.queue.ensureTeams();
    const summary: PublicSyncCycleResult = {
      teamsDiscovered,
      teamsAttempted: 0,
      teamsCompleted: 0,
      teamsFailed: 0,
      matchesDiscovered: 0,
      telemetryFetched: 0,
      telemetryUnavailable: 0,
    };
    // A stop request prevents new claims. Jobs already leased finish and are
    // checkpointed before the caller closes the PG pool, which gives shutdown
    // a bounded, recoverable boundary without dropping in-flight work.
    while (!signal?.aborted) {
      const jobs = await this.queue.claimDue(this.teamConcurrency);
      if (jobs.length === 0) break;
      summary.teamsAttempted += jobs.length;
      const results = await Promise.all(jobs.map((job) => this.processJob(job)));
      for (const result of results) {
        if (!result.ok) {
          summary.teamsFailed += 1;
          this.onTeamError(result.invalid ? 'public_sync_team_invalid' : 'public_sync_team_failed');
          continue;
        }
        summary.teamsCompleted += 1;
        summary.matchesDiscovered += result.telemetry.discovered;
        summary.telemetryFetched += result.telemetry.fetched;
        summary.telemetryUnavailable += result.telemetry.unavailable;
      }
    }
    return summary;
  }

  getQueueSnapshot(): Promise<PublicSyncQueueSnapshot> {
    return this.queue.getSnapshot();
  }

  private async processJob(job: PublicSyncJob): Promise<
    | { ok: true; telemetry: { discovered: number; fetched: number; unavailable: number } }
    | { ok: false; invalid: boolean }
  > {
    const stopIfLeaseLost = new AbortController();
    let renewalInFlight = false;
    const heartbeat = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void this.queue.renew(job).then((renewed) => {
        if (!renewed) stopIfLeaseLost.abort();
      }).catch(() => stopIfLeaseLost.abort()).finally(() => { renewalInFlight = false; });
    }, Math.max(250, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    try {
      const teamContext = await registeredTeam(this.pool, job.tenantId, job.teamId);
      const repository = new PostgresPubgRepository(this.pool, teamContext);
      const telemetryWorker = new TelemetryWorker({
        team: teamContext.team,
        store: repository,
        downloader: this.telemetryDownloader,
      });
      const service = new PubgDomainService({
        teamContext,
        repository,
        apiClient: this.client,
        telemetryWorker,
        maxMatches: this.maxMatches,
        now: this.now,
      });
      const result = await service.prefetchTelemetry({
        maxMatches: this.maxMatches,
        maxFetches: this.maxTelemetryFetches,
        concurrency: this.telemetryConcurrency,
        trigger: 'hourly',
        signal: stopIfLeaseLost.signal,
      });
      if (stopIfLeaseLost.signal.aborted || !await this.queue.complete(job, this.syncIntervalMs)) {
        return { ok: false, invalid: false };
      }
      return { ok: true, telemetry: telemetryRun(result.data) };
    } catch (error) {
      const invalid = error instanceof InvalidTeamError;
      await this.queue.fail(job, invalid ? 'public_sync_team_invalid' : 'public_sync_team_failed').catch(() => false);
      return { ok: false, invalid };
    } finally {
      clearInterval(heartbeat);
    }
  }

}
