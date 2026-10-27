import {
  createTeamContext,
  PubgApiClient,
  PubgApiTelemetryDownloader,
  PubgDomainService,
  TelemetryWorker,
  type TeamConfig,
  type RawTelemetryArchivePort,
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
  /** Where raw telemetry files are kept once downloaded, so any process (this worker, the AI that answers
   * questions) reads a match's telemetry from disk instead of fetching it again. Optional. */
  rawTelemetryArchive?: RawTelemetryArchivePort;
  /** When set, a finished team is scheduled with this delay instead of `syncIntervalMs`.
   * Lab's hourly prefetch uses the delay until the next minute-5 slot. */
  nextSyncDelayMs?: (now: Date) => number;
  /** When a finished team still has telemetry waiting for a later run (more candidates than `maxTelemetryFetches`),
   * schedule it again after this delay instead of at the normal slot, until the backlog is gone. Unset: off. */
  catchupDelayMs?: number;
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

interface TelemetryRunCounts { discovered: number; fetched: number; unavailable: number; deferred: number }

function telemetryRun(value: unknown, maxFetches: number): TelemetryRunCounts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { discovered: 0, fetched: 0, unavailable: 0, deferred: 0 };
  const data = value as Record<string, unknown>;
  const run = data.run && typeof data.run === 'object' && !Array.isArray(data.run)
    ? data.run as Record<string, unknown>
    : {};
  return {
    discovered: numberFrom(run.discoveredMatchCount),
    fetched: numberFrom(run.fetchedCount),
    unavailable: numberFrom(run.unavailableCount),
    // Candidates beyond this run's fetch budget were marked PENDING and wait for the next run.
    deferred: Math.max(0, numberFrom(run.candidateMatchCount) - maxFetches),
  };
}

export type SyncTeamResult =
  | { status: 'synced'; telemetry: { discovered: number; fetched: number; unavailable: number; deferred: number } }
  /** Another process was already syncing the team; it had finished when this returned. */
  | { status: 'joined' }
  /** Another process still held the team when the wait ran out. */
  | { status: 'busy' }
  | { status: 'failed'; invalid: boolean }
  | { status: 'unknown_team' };

export interface SyncTeamOptions {
  signal?: AbortSignal;
  /** How long to wait for a worker that is already syncing the team. Default 0 (do not wait). */
  waitMs?: number;
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
  private readonly nextSyncDelayMs: ((now: Date) => number) | undefined;
  private readonly catchupDelayMs: number | undefined;
  private readonly leaseMs: number;
  private readonly queue: PublicSyncQueue;

  constructor(private readonly pool: Pool, options: PublicSyncWorkerOptions) {
    if (!options.apiKey.trim()) throw new Error('public_pubg_api_key_missing');
    this.maxMatches = boundedInteger(options.maxMatches ?? DEFAULT_MAX_MATCHES, DEFAULT_MAX_MATCHES, 1, 1000);
    this.maxTelemetryFetches = boundedInteger(options.maxTelemetryFetches ?? DEFAULT_MAX_TELEMETRY_FETCHES, DEFAULT_MAX_TELEMETRY_FETCHES, 1, 50);
    this.telemetryConcurrency = boundedInteger(options.telemetryConcurrency ?? DEFAULT_TELEMETRY_CONCURRENCY, DEFAULT_TELEMETRY_CONCURRENCY, 1, 4);
    this.teamConcurrency = boundedInteger(options.teamConcurrency ?? DEFAULT_TEAM_CONCURRENCY, DEFAULT_TEAM_CONCURRENCY, 1, 16);
    this.syncIntervalMs = boundedInteger(options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS, DEFAULT_SYNC_INTERVAL_MS, 1_000, 24 * 60 * 60_000);
    this.nextSyncDelayMs = options.nextSyncDelayMs;
    this.catchupDelayMs = options.catchupDelayMs === undefined
      ? undefined
      : boundedInteger(options.catchupDelayMs, 1_000, 1_000, 24 * 60 * 60_000);
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
      ...(options.rawTelemetryArchive ? { archive: options.rawTelemetryArchive } : {}),
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

  /** Syncs one team now, due or not, through the same job (lease, heartbeat, schedule) the hourly run uses, so it
   * never works in parallel with a worker on the same team. Where a live lease already holds the team it waits
   * (up to `waitMs`) for that run to finish instead of starting a second one. */
  async syncTeam(tenantId: string, teamId: string, options: SyncTeamOptions = {}): Promise<SyncTeamResult> {
    const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
    for (;;) {
      if (options.signal?.aborted) return { status: 'failed', invalid: false };
      const job = await this.queue.claimTeam(tenantId, teamId);
      if (job) {
        const result = await this.processJob(job, options.signal);
        if (result.ok) return { status: 'synced', telemetry: result.telemetry };
        this.onTeamError(result.invalid ? 'public_sync_team_invalid' : 'public_sync_team_failed');
        return { status: 'failed', invalid: result.invalid };
      }
      const state = await this.queue.leaseState(tenantId, teamId);
      if (state === 'unknown') return { status: 'unknown_team' };
      if (state === 'free') continue; // released between the claim and this read
      if (Date.now() >= deadline) return { status: 'busy' };
      while (Date.now() < deadline && !options.signal?.aborted && await this.queue.leaseState(tenantId, teamId) === 'leased') {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
      if (Date.now() >= deadline && await this.queue.leaseState(tenantId, teamId) === 'leased') return { status: 'busy' };
      return { status: 'joined' };
    }
  }

  private async processJob(job: PublicSyncJob, outer?: AbortSignal): Promise<
    | { ok: true; telemetry: TelemetryRunCounts }
    | { ok: false; invalid: boolean }
  > {
    const stopIfLeaseLost = new AbortController();
    const stop = outer ? AbortSignal.any([stopIfLeaseLost.signal, outer]) : stopIfLeaseLost.signal;
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
        signal: stop,
      });
      const telemetry = telemetryRun(result.data, this.maxTelemetryFetches);
      const regularDelayMs = this.nextSyncDelayMs ? this.nextSyncDelayMs(this.now()) : this.syncIntervalMs;
      const delayMs = this.catchupDelayMs !== undefined && telemetry.deferred > 0
        ? Math.min(this.catchupDelayMs, regularDelayMs)
        : regularDelayMs;
      if (stop.aborted || !await this.queue.complete(job, delayMs)) {
        return { ok: false, invalid: false };
      }
      return { ok: true, telemetry };
    } catch (error) {
      const invalid = error instanceof InvalidTeamError;
      await this.queue.fail(job, invalid ? 'public_sync_team_invalid' : 'public_sync_team_failed').catch(() => false);
      return { ok: false, invalid };
    } finally {
      clearInterval(heartbeat);
    }
  }

}

export interface SyncTeamNowOptions extends PublicSyncWorkerOptions, SyncTeamOptions {
  tenantId: string;
  teamId: string;
}

/** Syncs one team right now (a host calls it when a question arrives for a team whose data is behind). Same job,
 * lease and schedule as the worker; see `PublicSyncWorker.syncTeam`. */
export async function syncTeamNow(pool: Pool, options: SyncTeamNowOptions): Promise<SyncTeamResult> {
  const { tenantId, teamId, signal, waitMs, ...workerOptions } = options;
  return new PublicSyncWorker(pool, workerOptions).syncTeam(tenantId, teamId, {
    ...(signal ? { signal } : {}),
    ...(waitMs !== undefined ? { waitMs } : {}),
  });
}
