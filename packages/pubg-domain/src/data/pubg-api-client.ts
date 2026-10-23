import type { TeamConfig, TeamPlayer } from '../config/team.js';
import type { DataLayerResult, NormalizedMatch, NormalizedPlayer } from './model.js';
import type { Coverage, SourceInfo } from '../schema/status.js';

const DEFAULT_BASE_URL = 'https://api.pubg.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MODES = new Set(['solo', 'solo-fpp', 'duo', 'duo-fpp', 'squad', 'squad-fpp']);

export type PubgApiErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'upstream'
  | 'invalid_response'
  | 'cancelled';

export class PubgApiError extends Error {
  constructor(
    readonly code: PubgApiErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PubgApiError';
  }
}

export interface PubgApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  allowedCompetitiveModes?: Iterable<string>;
}

export interface PlayerMatchSnapshot {
  configured: TeamPlayer;
  found: boolean;
  apiName: string | null;
  matchIds: string[];
}

export interface SyncTeamOptions {
  shard?: string;
  maxMatches?: number;
  knownMatchIds?: Iterable<string>;
  signal?: AbortSignal;
  now?: Date;
}

export interface SyncTeamResult extends DataLayerResult {
  snapshots: PlayerMatchSnapshot[];
  discoveredMatchIds: string[];
}

interface JsonObject {
  [key: string]: unknown;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringValue(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return text || null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function positiveNumberOrNull(value: unknown): number | null {
  const result = finiteNumber(value, Number.NaN);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function authorizationValue(apiKey: string): string {
  const value = apiKey.trim();
  return /^Bearer\s+/iu.test(value) ? value : 'Bearer ' + value;
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), 30_000);
  return undefined;
}

function safeErrorDetail(value: unknown): string {
  const body = objectValue(value);
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const first = objectValue(errors[0]);
  return stringValue(first.title ?? first.detail) ?? 'PUBG API request failed';
}

function isoFromTimestamp(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sourceFrom(
  store: string,
  now: Date,
  calls: { player: number; match: number },
  localMatchCount: number,
  error?: string,
): SourceInfo {
  return {
    store,
    syncInvoked: true,
    playerApiCalls: calls.player,
    matchApiCalls: calls.match,
    localMatchCount,
    ...(error ? { error } : {}),
  };
}

function coverageFor(
  records: NormalizedMatch[],
  now: Date,
  failedMatchIds: string[],
  discoveryOk: boolean,
): Coverage {
  const timestamps = records
    .map((record) => record.timestamp)
    .filter((value) => Number.isFinite(value) && value > 0);
  const partial = failedMatchIds.length > 0;
  const status = !discoveryOk ? 'SOURCE_UNAVAILABLE' : partial ? 'PARTIAL' : 'OK';
  return {
    status,
    complete: discoveryOk && !partial,
    coverageStart: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    coverageEnd: now.toISOString(),
    checkedAt: now.toISOString(),
    failedMatchIds: [...new Set(failedMatchIds)],
    sourceUnavailable: !discoveryOk,
    freshness: discoveryOk ? 'fresh' : 'unknown',
    localComplete: discoveryOk && !partial,
    queryCovered: discoveryOk && !partial,
    requiredMatchCount: records.length + failedMatchIds.length,
    availableMatchCount: records.length,
  };
}

function playerNameFromEntry(entry: JsonObject): string | null {
  return stringValue(objectValue(entry.attributes).name);
}

function matchIdsFromEntry(entry: JsonObject): string[] {
  const relationships = objectValue(entry.relationships);
  const matches = objectValue(relationships.matches).data;
  return Array.isArray(matches)
    ? [
        ...new Set(
          matches
            .map((item) => stringValue(objectValue(item).id))
            .filter((id): id is string => id !== null),
        ),
      ]
    : [];
}

/** PUBG returns each player's recent matches newest-first. Round-robin the
 * player lists before applying the shared sync ceiling so roster ordering
 * cannot let one account consume every available slot. */
function fairMatchSelection(
  snapshots: readonly PlayerMatchSnapshot[],
  maxMatches: number,
): string[] {
  const perPlayer = snapshots.map((snapshot) => [...new Set(snapshot.matchIds)]);
  const cursors = perPlayer.map(() => 0);
  const selected: string[] = [];
  const seen = new Set<string>();
  while (selected.length < maxMatches) {
    let selectedThisRound = false;
    for (
      let playerIndex = 0;
      playerIndex < perPlayer.length && selected.length < maxMatches;
      playerIndex += 1
    ) {
      const matchIds = perPlayer[playerIndex]!;
      while (cursors[playerIndex]! < matchIds.length) {
        const matchId = matchIds[cursors[playerIndex]!]!;
        cursors[playerIndex]! += 1;
        if (seen.has(matchId)) continue;
        seen.add(matchId);
        selected.push(matchId);
        selectedThisRound = true;
        break;
      }
    }
    if (!selectedThisRound) break;
  }
  return selected;
}

function normalizeMatchPayload(
  payload: unknown,
  configuredById: Map<string, TeamPlayer>,
  shard: string,
  allowedModes: Set<string>,
): NormalizedMatch {
  const body = objectValue(payload);
  const data = objectValue(body.data);
  const attributes = objectValue(data.attributes);
  const matchId = stringValue(data.id);
  if (!matchId)
    throw new PubgApiError('invalid_response', 'PUBG match response has no match id', false);
  const createdAt = isoFromTimestamp(attributes.createdAt);
  const timestamp = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(timestamp))
    throw new PubgApiError('invalid_response', 'PUBG match response has no valid createdAt', false);
  const matchType = String(attributes.matchType ?? '').toLowerCase();
  const gameMode = String(attributes.gameMode ?? '').toLowerCase();
  const isCompetitive = matchType === 'competitive' && allowedModes.has(gameMode);
  const included = Array.isArray(body.included) ? body.included : [];
  const participants = included
    .filter((entry) => objectValue(entry).type === 'participant')
    .map(objectValue);
  const rosters = new Map(
    included
      .filter((entry) => objectValue(entry).type === 'roster')
      .map((entry) => {
        const item = objectValue(entry);
        return [String(item.id ?? ''), item] as const;
      }),
  );
  const players = participants.flatMap((participant) => {
    const stats = objectValue(participant.attributes).stats;
    const participantStats = objectValue(stats);
    const relationships = objectValue(participant.relationships);
    const playerData = objectValue(relationships.player).data;
    const accountId = stringValue(participantStats.playerId ?? objectValue(playerData).id);
    if (!accountId) return [];
    const configured = configuredById.get(accountId);
    if (!configured) return [];
    const rosterId = objectValue(relationships.roster).data;
    const roster = rosters.get(String(objectValue(rosterId).id ?? ''));
    const rosterStats = objectValue(roster?.attributes).stats;
    const rank = positiveNumberOrNull(participantStats.winPlace ?? objectValue(rosterStats).rank);
    return [
      {
        accountId,
        playerName: configured.name,
        displayName: configured.name,
        rank,
        kills: Math.max(0, finiteNumber(participantStats.kills)),
        assists: Math.max(0, finiteNumber(participantStats.assists)),
        damage: Math.max(0, finiteNumber(participantStats.damageDealt)),
        dbnos: Math.max(0, finiteNumber(participantStats.DBNOs)),
        revives: Math.max(0, finiteNumber(participantStats.revives)),
        headshotKills: Math.max(0, finiteNumber(participantStats.headshotKills)),
        survivalTime: Math.max(0, finiteNumber(participantStats.timeSurvived)),
        longestKill: Math.max(0, finiteNumber(participantStats.longestKill)),
        deaths: rank === null ? null : rank > 1 ? 1 : 0,
        deathSemantics: (rank === null
          ? 'unknown'
          : 'placement_proxy') as NormalizedPlayer['deathSemantics'],
      },
    ];
  });
  const relationships = objectValue(data.relationships);
  const assets = Array.isArray(objectValue(relationships.assets).data)
    ? (objectValue(relationships.assets).data as unknown[])
    : [];
  const assetIds = new Set(assets.map((item) => String(objectValue(item).id ?? '')));
  const asset = included
    .map(objectValue)
    .find(
      (item) =>
        item.type === 'asset' && (assetIds.size === 0 || assetIds.has(String(item.id ?? ''))),
    );
  const assetAttributes = objectValue(asset?.attributes);
  const telemetryUrl = stringValue(assetAttributes.URL ?? assetAttributes.url);
  return {
    schemaVersion: 3,
    matchId,
    shard,
    createdAt,
    timestamp,
    matchType,
    gameMode,
    isCompetitive,
    mapName: String(attributes.mapName ?? '未知地图'),
    duration: Math.max(0, finiteNumber(attributes.duration)),
    patchVersion: String(attributes.patchVersion ?? ''),
    players,
    telemetryUrl,
  };
}

class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class PubgApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrlValue: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly concurrency: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly allowedCompetitiveModes: Set<string>;

  constructor(private readonly options: PubgApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrlValue = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/u, '');
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxRetries = Math.min(Math.max(0, options.maxRetries ?? DEFAULT_RETRIES), 4);
    this.concurrency = Math.min(Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY), 8);
    this.sleep =
      options.sleep ??
      ((ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new PubgApiError('cancelled', 'PUBG API request cancelled', false));
            },
            { once: true },
          );
        }));
    this.allowedCompetitiveModes = new Set(options.allowedCompetitiveModes ?? DEFAULT_MODES);
  }

  get apiKey(): string {
    return this.options.apiKey;
  }

  get baseUrl(): string {
    return this.baseUrlValue;
  }

  private async request(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ body: unknown; headers: Headers }> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) throw new PubgApiError('cancelled', 'PUBG API request cancelled', false);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await this.fetchImpl(this.baseUrlValue + path, {
          headers: {
            accept: 'application/vnd.api+json',
            authorization: authorizationValue(this.options.apiKey),
          },
          signal: controller.signal,
        });
        if (response.ok) {
          const text = await response.text();
          let body: unknown = {};
          if (text.trim()) {
            try {
              body = JSON.parse(text) as unknown;
            } catch (error) {
              throw new PubgApiError(
                'invalid_response',
                'PUBG API returned invalid JSON',
                false,
                response.status,
              );
            }
          }
          return { body, headers: response.headers };
        }
        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        if (!retryable || attempt >= this.maxRetries) {
          const code: PubgApiErrorCode =
            response.status === 401 || response.status === 403
              ? 'unauthorized'
              : response.status === 404
                ? 'not_found'
                : response.status === 429
                  ? 'rate_limited'
                  : 'upstream';
          throw new PubgApiError(
            code,
            safeErrorDetail(await response.json().catch(() => null)),
            retryable,
            response.status,
            retryAfterMilliseconds(response.headers.get('retry-after')),
          );
        }
        const delay =
          retryAfterMilliseconds(response.headers.get('retry-after')) ??
          Math.min(1000 * 2 ** attempt, 10_000);
        await this.sleep(delay, signal);
      } catch (error) {
        if (error instanceof PubgApiError) throw error;
        if (signal?.aborted)
          throw new PubgApiError('cancelled', 'PUBG API request cancelled', false);
        if (controller.signal.aborted) {
          if (attempt >= this.maxRetries)
            throw new PubgApiError('timeout', 'PUBG API request timed out', true);
          await this.sleep(Math.min(1000 * 2 ** attempt, 10_000), signal);
          continue;
        }
        if (attempt >= this.maxRetries)
          throw new PubgApiError('upstream', 'PUBG API request failed', true);
        await this.sleep(Math.min(1000 * 2 ** attempt, 10_000), signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    }
    throw new PubgApiError('upstream', 'PUBG API request failed', true);
  }

  async discoverPlayers(
    shard: string,
    playerIds: string[] = [],
    playerNames: string[] = [],
    signal?: AbortSignal,
  ): Promise<JsonObject[]> {
    const params = new URLSearchParams();
    if (playerIds.length) params.set('filter[playerIds]', playerIds.join(','));
    if (playerNames.length) params.set('filter[playerNames]', playerNames.join(','));
    const suffix = params.toString() ? '?' + params.toString() : '';
    const result = await this.request(
      '/shards/' + encodeURIComponent(shard) + '/players' + suffix,
      signal,
    );
    const data = objectValue(result.body).data;
    if (!Array.isArray(data))
      throw new PubgApiError('invalid_response', 'PUBG players response has no data', false);
    return data.map(objectValue);
  }

  async getMatch(
    shard: string,
    matchId: string,
    team?: TeamConfig,
    signal?: AbortSignal,
  ): Promise<NormalizedMatch> {
    const result = await this.request(
      '/shards/' + encodeURIComponent(shard) + '/matches/' + encodeURIComponent(matchId),
      signal,
    );
    const configuredById = new Map((team?.players ?? []).map((player) => [player.id, player]));
    return normalizeMatchPayload(result.body, configuredById, shard, this.allowedCompetitiveModes);
  }

  async syncTeam(team: TeamConfig, options: SyncTeamOptions = {}): Promise<SyncTeamResult> {
    const shard = options.shard ?? team.platform;
    const now = options.now ?? new Date();
    const maxMatches = Math.min(Math.max(1, Math.trunc(options.maxMatches ?? 500)), 1000);
    const configuredById = new Map(team.players.map((player) => [player.id, player]));
    let entries: JsonObject[];
    try {
      entries = await this.discoverPlayers(
        shard,
        team.players.map((player) => player.id),
        [],
        options.signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'player_discovery_failed';
      const coverage = coverageFor([], now, [], false);
      return {
        records: [],
        coverage,
        source: sourceFrom('pubg-api', now, { player: 1, match: 0 }, 0, message),
        diagnostics: {
          errorCode: error instanceof PubgApiError ? error.code : 'upstream',
          retryable: error instanceof PubgApiError ? error.retryable : true,
        },
        snapshots: team.players.map((configured) => ({
          configured,
          found: false,
          apiName: null,
          matchIds: [],
        })),
        discoveredMatchIds: [],
      };
    }
    const byId = new Map(entries.map((entry) => [String(entry.id ?? ''), entry]));
    const snapshots = team.players.map((configured) => {
      const entry = byId.get(configured.id);
      return {
        configured,
        found: Boolean(entry),
        apiName: playerNameFromEntry(entry ?? {}),
        matchIds: matchIdsFromEntry(entry ?? {}),
      };
    });
    const discoveredMatchIds = fairMatchSelection(snapshots, maxMatches);
    const knownMatchIds = new Set(options.knownMatchIds ?? []);
    const matchIdsToFetch = discoveredMatchIds.filter((matchId) => !knownMatchIds.has(matchId));
    const gate = new ConcurrencyGate(this.concurrency);
    const records: NormalizedMatch[] = [];
    const failedMatchIds: string[] = [];
    let matchApiCalls = 0;
    await Promise.all(
      matchIdsToFetch.map(async (matchId) => {
        try {
          matchApiCalls += 1;
          const result = await gate.run(() =>
            this.request(
              '/shards/' + encodeURIComponent(shard) + '/matches/' + encodeURIComponent(matchId),
              options.signal,
            ),
          );
          records.push(
            normalizeMatchPayload(result.body, configuredById, shard, this.allowedCompetitiveModes),
          );
        } catch {
          failedMatchIds.push(matchId);
        }
      }),
    );
    records.sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.matchId.localeCompare(right.matchId),
    );
    const coverage = coverageFor(records, now, failedMatchIds, true);
    return {
      records,
      coverage,
      source: sourceFrom('pubg-api', now, { player: 1, match: matchApiCalls }, records.length),
      diagnostics: {
        discoveredMatchCount: discoveredMatchIds.length,
        cachedMatchCount: discoveredMatchIds.length - matchIdsToFetch.length,
        newMatchCount: matchIdsToFetch.length,
        failedMatchIds: [...new Set(failedMatchIds)],
        snapshots: snapshots.map((snapshot) => ({
          accountId: snapshot.configured.id,
          found: snapshot.found,
          matchCount: snapshot.matchIds.length,
        })),
      },
      snapshots,
      discoveredMatchIds,
    };
  }
}

export { normalizeMatchPayload };
