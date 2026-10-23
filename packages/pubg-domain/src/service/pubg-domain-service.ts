import { randomUUID } from 'node:crypto';
import type { TeamConfig, TeamPlayer } from '../config/team.js';
import { parseTeamContext, type TeamContext } from '../context/team-context.js';
import type { Coverage, DataStatus, Evidence, SourceInfo } from '../schema/status.js';
import type { CanonicalQuery, GroupBy, Metric, Selector } from '../schema/query.js';
import { CanonicalQuerySchema } from '../schema/query.js';
import type {
  NormalizedMatch,
  QueryRow,
  ResultSetRecord,
  StructuredResult,
} from '../data/model.js';
import { DeterministicQueryEngine, resultSetFromResult } from '../engine/query-engine.js';
import { PubgApiClient, PubgApiError } from '../data/pubg-api-client.js';
import type {
  PubgRepositoryPort,
  SyncState,
  TelemetryPrefetchRun,
} from '../storage/repository-port.js';
import {
  TelemetryWorker,
  PubgApiTelemetryDownloader,
  type RawTelemetryArchivePort,
} from '../review/telemetry.js';
import {
  emptyMatchReviewFacts,
  scopeMatchReviewFacts,
  selectMatchReviewFactCategories,
} from '../review/review-facts.js';
import { analyzeMatchReview } from '../review/review-analyzer.js';
import type { MatchReviewResult, TeamDamageFact, TeamDamageSource } from '../review/types.js';
import {
  BUSINESS_DAY_START,
  DEFAULT_TIMEZONE,
  localDateLabel,
  resolveSelector,
} from '../time/selector-resolver.js';

export const PUBGMETRIC_VERSION = 'pubg-metrics-v1';
export const PUBG_QUERY_VERSION = 'pubg-query-v1';
export const PUBG_RESULT_SET_TTL_MS = 30 * 60 * 1000;
export const PUBG_REVIEW_SEARCH_MAX_AGE_MS = 5 * 60 * 1000;

export type ToolStatus = 'ok' | 'partial' | 'no_matches' | 'error';

export interface ToolError {
  code: string;
  retryable: boolean;
  reason: string;
}

export interface ToolEnvelope<T = unknown> {
  status: ToolStatus;
  data: T;
  coverage: Coverage;
  asOf: string;
  metricVersion: string;
  queryResolved: Record<string, unknown>;
  evidenceRefs: Evidence;
  resultSetId?: string;
  error?: ToolError;
}

export interface SubjectInput {
  playerIds?: string[];
  playerNames?: string[];
  signal?: AbortSignal;
}

export interface TimeRangeInput {
  type: 'time_range';
  from: string;
  to: string;
  timezone?: string;
  businessDayStart?: string;
}

export interface RelativePeriodInput {
  type: 'relative_period';
  value: string;
  label?: string;
}

export interface RecentDaysInput {
  type: 'recent_days';
  count: number;
  label?: string;
}

export interface LastMatchesInput {
  type: 'last_n_matches';
  count: number;
  offset?: number;
}

export interface ResultSetInput {
  type: 'result_set';
  resultSetId: string;
}

export type ToolSelectorInput =
  TimeRangeInput | RelativePeriodInput | RecentDaysInput | LastMatchesInput | ResultSetInput;

export type SearchSelectorInput = TimeRangeInput | RelativePeriodInput | RecentDaysInput;

export interface StatsToolInput extends SubjectInput {
  sessionId: string;
  selector: ToolSelectorInput;
  metrics: Metric[];
  operation?: 'report' | 'detail' | 'rank' | 'strongest' | 'weakest' | 'trend' | 'list';
  groupBy?: GroupBy;
  orderBy?: { metric: Metric; direction: 'asc' | 'desc' };
  limit?: number;
  refresh?: boolean;
}

export interface CompareToolInput extends SubjectInput {
  sessionId: string;
  segments: Array<{ label: string; selector: ToolSelectorInput }>;
  metrics: Metric[];
  groupBy?: GroupBy;
  orderBy?: { metric: Metric; direction: 'asc' | 'desc' };
  limit?: number;
  refresh?: boolean;
}

export interface SearchMatchesInput extends SubjectInput {
  sessionId: string;
  selector?: SearchSelectorInput;
  from?: string;
  to?: string;
  timezone?: string;
  gameMode?: string;
  mapName?: string;
  sort?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  recentN?: number;
  refresh?: boolean;
}

export interface ResolvePlayersInput {
  sessionId: string;
  playerNames?: string[];
  playerIds?: string[];
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface GetMatchInput {
  sessionId: string;
  matchId: string;
  refresh?: boolean;
  signal?: AbortSignal;
}

export interface GetReviewFactsInput extends GetMatchInput {
  searchResultSetId: string;
  playerIds?: string[];
  categories?: string[];
}

export interface GetPeriodReviewInput {
  sessionId: string;
  searchResultSetId: string;
  playerIds?: string[];
  categories?: string[];
  signal?: AbortSignal;
}

export interface TeamDamageQueryInput {
  sessionId: string;
  selector: SearchSelectorInput;
  /** Explicit configured PUBG name, alias, or account ID; omit both for all directions. */
  actorPlayer?: string;
  /** Explicit configured PUBG name, alias, or account ID; omit both for all directions. */
  victimPlayer?: string;
  source?: TeamDamageSource;
  meleeKind?: NonNullable<TeamDamageFact['meleeKind']>;
  refresh?: boolean;
  signal?: AbortSignal;
}

function sourceRangeFromUnknown(selector: unknown): Record<string, string> | null {
  if (
    !selector ||
    typeof selector !== 'object' ||
    (selector as { type?: unknown }).type !== 'time_range'
  )
    return null;
  const value = selector as {
    start?: unknown;
    end?: unknown;
    timezone?: unknown;
    businessDayStart?: unknown;
  };
  if (
    typeof value.start !== 'string' ||
    typeof value.end !== 'string' ||
    typeof value.timezone !== 'string' ||
    typeof value.businessDayStart !== 'string'
  )
    return null;
  return {
    from: value.start,
    to: value.end,
    timezone: value.timezone,
    businessDayStart: value.businessDayStart,
  };
}

function sourceRangeFromSelector(selector: Selector): Record<string, string> | null {
  return sourceRangeFromUnknown(selector);
}

export interface PrefetchTelemetryInput {
  maxMatches?: number;
  maxFetches?: number;
  concurrency?: number;
  trigger?: 'hourly' | 'manual';
  signal?: AbortSignal;
}

export interface TelemetrySyncReportInput {
  reportDate?: string;
}

interface TelemetrySyncSummary {
  reportDate: string;
  timezone: string;
  runCount: number;
  discoveredMatchCount: number;
  newMatchCount: number;
  candidateMatchCount: number;
  fetchedCount: number;
  cacheHitCount: number;
  unavailableCount: number;
  pendingCount: number;
  failedMatchIds: string[];
  lastRunAt: string | null;
}

function asFiniteDate(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceForLocal(
  records: NormalizedMatch[],
  now: Date,
  state: SyncState | null,
  store: string,
): SourceInfo {
  if (state) return { ...state.source, localMatchCount: records.length };
  return {
    store,
    syncInvoked: false,
    playerApiCalls: 0,
    matchApiCalls: 0,
    localMatchCount: records.length,
  };
}

function coverageForLocal(
  records: NormalizedMatch[],
  now: Date,
  state: SyncState | null,
): Coverage {
  if (state) {
    const coverage = {
      ...state.coverage,
      checkedAt: state.checkedAt,
      availableMatchCount: records.length,
    };
    return coverage.status === 'SOURCE_UNAVAILABLE' && records.length > 0
      ? staleCoverage(coverage, records, now)
      : coverage;
  }
  const timestamps = records
    .map((record) => record.timestamp)
    .filter((value) => Number.isFinite(value));
  return {
    status: 'OK',
    complete: true,
    coverageStart: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    coverageEnd: now.toISOString(),
    checkedAt: now.toISOString(),
    failedMatchIds: [],
    sourceUnavailable: false,
    freshness: 'unknown',
    localComplete: true,
    queryCovered: true,
    requiredMatchCount: records.length,
    availableMatchCount: records.length,
  };
}

function staleCoverage(
  coverage: Coverage,
  records: NormalizedMatch[],
  now: Date,
  failedMatchIds: string[] = [],
): Coverage {
  const timestamps = records
    .map((record) => record.timestamp)
    .filter((value) => Number.isFinite(value));
  const failures = [...new Set([...coverage.failedMatchIds, ...failedMatchIds])];
  return {
    ...coverage,
    status: 'STALE',
    complete: false,
    coverageStart:
      coverage.coverageStart ??
      (timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null),
    coverageEnd:
      coverage.coverageEnd ??
      (timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null),
    checkedAt: now.toISOString(),
    failedMatchIds: failures,
    sourceUnavailable: true,
    freshness: 'stale',
    localComplete: coverage.localComplete ?? false,
    queryCovered: coverage.queryCovered ?? false,
    requiredMatchCount: Math.max(
      coverage.requiredMatchCount ?? 0,
      records.length + failures.length,
    ),
    availableMatchCount: records.length,
  };
}

function coverageWithRecords(coverage: Coverage, records: NormalizedMatch[], now: Date): Coverage {
  const timestamps = records
    .map((record) => record.timestamp)
    .filter((value) => Number.isFinite(value));
  return {
    ...coverage,
    coverageStart: timestamps.length
      ? new Date(Math.min(...timestamps)).toISOString()
      : (coverage.coverageStart ?? null),
    coverageEnd: now.toISOString(),
    checkedAt: now.toISOString(),
    requiredMatchCount: records.length + coverage.failedMatchIds.length,
    availableMatchCount: records.length,
  };
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function searchOrder(input: SearchMatchesInput): 'asc' | 'desc' {
  // A bounded period is presented as a play-by-play review, so its implicit
  // order is chronological. Explicit recentN keeps the latest-match contract
  // newest-first; callers can still override the order explicitly.
  if (input.sort) return input.sort;
  if (input.selector && input.recentN === undefined) return 'asc';
  return 'desc';
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

const TEAM_DAMAGE_SOURCES: TeamDamageSource[] = ['MELEE', 'GUN', 'EXPLOSIVE', 'VEHICLE'];

function roundDamage(value: number): number {
  return Math.round(value * 100) / 100;
}

function teamDamageFactMatches(
  fact: TeamDamageFact,
  actorPlayerId: string | undefined,
  victimPlayerId: string | undefined,
  source: TeamDamageSource | undefined,
  meleeKind: NonNullable<TeamDamageFact['meleeKind']> | undefined,
): boolean {
  return (
    (!actorPlayerId || fact.actorPlayerId === actorPlayerId) &&
    (!victimPlayerId || fact.victimPlayerId === victimPlayerId) &&
    (!source || fact.source === source) &&
    (!meleeKind || fact.meleeKind === meleeKind)
  );
}

function retryAt(now: Date, attemptCount: number): string {
  const delayMs = Math.min(
    24 * 60 * 60 * 1000,
    60 * 60 * 1000 * 2 ** Math.max(0, attemptCount - 1),
  );
  return new Date(now.getTime() + delayMs).toISOString();
}

function previousLocalDate(now: Date, timezone: string): string {
  return localDateLabel(now.getTime() - 24 * 60 * 60 * 1000, timezone);
}

function summarizePrefetchRuns(
  reportDate: string,
  timezone: string,
  runs: TelemetryPrefetchRun[],
): TelemetrySyncSummary {
  const sum = (selector: (run: TelemetryPrefetchRun) => number): number =>
    runs.reduce((total, run) => total + selector(run), 0);
  return {
    reportDate,
    timezone,
    runCount: runs.length,
    discoveredMatchCount: sum((run) => run.discoveredMatchCount),
    newMatchCount: sum((run) => run.newMatchCount),
    candidateMatchCount: sum((run) => run.candidateMatchCount),
    fetchedCount: sum((run) => run.fetchedCount),
    cacheHitCount: sum((run) => run.cacheHitCount),
    unavailableCount: sum((run) => run.unavailableCount),
    pendingCount: sum((run) => run.pendingCount),
    failedMatchIds: [...new Set(runs.flatMap((run) => run.failedMatchIds))],
    lastRunAt: runs.length ? runs[runs.length - 1]!.finishedAt : null,
  };
}

function playerIdsFromSubject(
  input: SubjectInput,
  team: TeamConfig,
): { ids: string[]; names: string[] } {
  const ids = uniqueStrings(input.playerIds);
  const names = uniqueStrings(input.playerNames);
  if (!ids.length && !names.length)
    return { ids: team.players.map((player) => player.id), names: [] };
  return { ids, names };
}

function lowerStatus(status: DataStatus): ToolStatus {
  if (status === 'NO_MATCHES') return 'no_matches';
  if (status === 'OK') return 'ok';
  if (
    status === 'PARTIAL' ||
    status === 'COVERAGE_GAP' ||
    status === 'STALE' ||
    status === 'REVIEW_PARTIAL'
  )
    return 'partial';
  return 'error';
}

function errorFor(
  status: DataStatus,
  diagnostics: Record<string, unknown>,
  source: SourceInfo,
): ToolError | undefined {
  if (
    status === 'OK' ||
    status === 'NO_MATCHES' ||
    status === 'PARTIAL' ||
    status === 'COVERAGE_GAP' ||
    status === 'STALE' ||
    status === 'REVIEW_PARTIAL'
  )
    return undefined;
  const code =
    typeof diagnostics.errorCode === 'string'
      ? diagnostics.errorCode
      : status === 'SOURCE_UNAVAILABLE'
        ? 'source_unavailable'
        : status.toLowerCase();
  return {
    code,
    retryable: status === 'SOURCE_UNAVAILABLE',
    reason:
      typeof source.error === 'string'
        ? source.error
        : String((diagnostics.errors as string[] | undefined)?.[0] ?? status),
  };
}

function evidenceFor(result: StructuredResult): Evidence {
  return {
    ...result.evidence,
    calculation: result.evidence.calculation || PUBG_QUERY_VERSION,
  };
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

function selectorToCanonical(
  selector: ToolSelectorInput,
  timezone: string,
  businessDayStart: string,
): Selector {
  if (selector.type === 'time_range') {
    return {
      type: 'time_range',
      start: selector.from,
      end: selector.to,
      timezone: selector.timezone ?? timezone,
      businessDayStart: selector.businessDayStart ?? businessDayStart,
    };
  }
  if (selector.type === 'relative_period') {
    return {
      type: 'relative_period',
      value: selector.value,
      ...(selector.label ? { label: selector.label } : {}),
    };
  }
  if (selector.type === 'recent_days') {
    return {
      type: 'recent_days',
      count: Math.min(Math.max(Math.trunc(selector.count), 1), 366),
      ...(selector.label ? { label: selector.label } : {}),
    };
  }
  if (selector.type === 'last_n_matches') {
    return {
      type: 'last_n_matches',
      count: Math.min(Math.max(Math.trunc(selector.count), 1), 100),
      offset: Math.max(0, Math.trunc(selector.offset ?? 0)),
    };
  }
  return { type: 'result_set', resultSetId: selector.resultSetId };
}

function queryForStats(
  input: StatsToolInput,
  subjectIds: string[],
  timezone: string,
  businessDayStart: string,
): CanonicalQuery {
  const operation = input.operation ?? 'report';
  const groupBy = input.groupBy ?? 'player';
  const metrics = uniqueStrings(input.metrics as string[]) as Metric[];
  const orderBy = input.orderBy ?? { metric: metrics[0] ?? 'kills', direction: 'desc' as const };
  return CanonicalQuerySchema.parse({
    version: 3,
    queryId: 'pubg-' + randomUUID(),
    domain: 'pubg',
    subject: { type: subjectIds.length === 1 ? 'player' : 'players', ids: subjectIds },
    operation,
    selector: selectorToCanonical(input.selector, timezone, businessDayStart),
    matchSelector: null,
    segments: [],
    groupBy,
    metrics: metrics.length ? metrics : ['kills'],
    filters: {},
    orderBy,
    limit: input.limit === undefined ? null : Math.min(Math.max(Math.trunc(input.limit), 1), 100),
    reference: {
      sessionId: input.sessionId,
      selectorExplicit: true,
      subjectExplicit: Boolean(input.playerIds?.length || input.playerNames?.length),
      useResultSet: input.selector.type === 'result_set',
      resultSetId: input.selector.type === 'result_set' ? input.selector.resultSetId : undefined,
      inheritedFromContext: false,
      planner: 'provided',
    },
    presentation: { compact: true },
  });
}

function queryForCompare(
  input: CompareToolInput,
  subjectIds: string[],
  timezone: string,
  businessDayStart: string,
): CanonicalQuery {
  const metrics = uniqueStrings(input.metrics as string[]) as Metric[];
  return CanonicalQuerySchema.parse({
    version: 3,
    queryId: 'pubg-' + randomUUID(),
    domain: 'pubg',
    subject: { type: subjectIds.length === 1 ? 'player' : 'players', ids: subjectIds },
    operation: 'compare',
    selector: selectorToCanonical(
      input.segments[0]?.selector ?? { type: 'last_n_matches', count: 1 },
      timezone,
      businessDayStart,
    ),
    matchSelector: null,
    segments: input.segments.slice(0, 2).map((segment) => ({
      label: segment.label,
      selector: selectorToCanonical(segment.selector, timezone, businessDayStart),
    })),
    groupBy: input.groupBy ?? 'player',
    metrics: metrics.length ? metrics : ['kills'],
    filters: {},
    orderBy: input.orderBy ?? { metric: metrics[0] ?? 'kills', direction: 'desc' as const },
    limit: input.limit === undefined ? null : Math.min(Math.max(Math.trunc(input.limit), 1), 100),
    reference: {
      sessionId: input.sessionId,
      selectorExplicit: true,
      subjectExplicit: Boolean(input.playerIds?.length || input.playerNames?.length),
      inheritedFromContext: false,
      planner: 'provided',
    },
    presentation: { compact: true },
  });
}

function resultEnvelope(
  result: StructuredResult,
  query: CanonicalQuery,
  resultSetId?: string,
): ToolEnvelope {
  const diagnostics = result.diagnostics ?? {};
  const resolvedSelector = diagnostics.resolvedSelector;
  const resolvedSegments = Array.isArray(diagnostics.resolvedSegments)
    ? diagnostics.resolvedSegments
    : [];
  const resolvedRange = sourceRangeFromUnknown(resolvedSelector);
  const resolvedQuery = {
    ...(sanitize(query) as Record<string, unknown>),
    ...(resolvedSelector && typeof resolvedSelector === 'object'
      ? { resolvedSelector: sanitize(resolvedSelector) }
      : {}),
    ...(resolvedSegments.length ? { resolvedSegments: sanitize(resolvedSegments) } : {}),
    ...(resolvedRange ? { sourceRange: resolvedRange } : {}),
  };
  const envelope: ToolEnvelope = {
    status: lowerStatus(result.status),
    data: sanitize(result.data),
    coverage: sanitize(result.coverage) as Coverage,
    asOf: result.coverage.checkedAt ?? new Date().toISOString(),
    metricVersion: PUBGMETRIC_VERSION,
    queryResolved: resolvedQuery,
    evidenceRefs: sanitize(evidenceFor(result)) as Evidence,
    ...(resultSetId ? { resultSetId } : {}),
  };
  const error = errorFor(result.status, result.diagnostics, result.source);
  if (error) envelope.error = error;
  return envelope;
}

export interface PubgDomainServiceOptions {
  teamContext: TeamContext;
  repository: PubgRepositoryPort;
  apiClient?: PubgApiClient;
  telemetryWorker?: TelemetryWorker;
  rawTelemetryArchive?: RawTelemetryArchivePort;
  timezone?: string;
  businessDayStart?: string;
  maxMatches?: number;
  now?: () => Date;
  freshnessMs?: number;
}

export class PubgDomainService {
  readonly teamContext: TeamContext;
  readonly repository: PubgRepositoryPort;
  private readonly apiClient: PubgApiClient | undefined;
  private readonly telemetryWorker: TelemetryWorker;
  private readonly timezone: string;
  private readonly businessDayStart: string;
  private readonly maxMatches: number;
  private readonly now: () => Date;
  private readonly freshnessMs: number;
  private readonly queryEngine: DeterministicQueryEngine;
  private prefetchInFlight: Promise<ToolEnvelope> | undefined;

  constructor(options: PubgDomainServiceOptions) {
    this.teamContext = parseTeamContext(options.teamContext);
    if (
      options.repository.scope.tenantId !== this.teamContext.tenantId ||
      options.repository.scope.teamId !== this.teamContext.teamId
    ) {
      throw new Error('repository_scope_mismatch');
    }
    this.repository = options.repository;
    const apiClient = options.apiClient;
    this.apiClient = apiClient;
    this.timezone = options.timezone ?? DEFAULT_TIMEZONE;
    this.businessDayStart = options.businessDayStart ?? BUSINESS_DAY_START;
    this.maxMatches = Math.min(Math.max(1, Math.trunc(options.maxMatches ?? 500)), 1000);
    this.now = options.now ?? (() => new Date());
    this.freshnessMs = options.freshnessMs ?? 5 * 60 * 1000;
    this.telemetryWorker =
      options.telemetryWorker ??
      new TelemetryWorker({
        team: this.team,
        store: this.repository,
        ...(apiClient
          ? {
              downloader: new PubgApiTelemetryDownloader({
                apiKey: apiClient.apiKey,
                baseUrl: apiClient.baseUrl,
                ...(options.rawTelemetryArchive ? { archive: options.rawTelemetryArchive } : {}),
              }),
            }
          : {}),
      });
    this.queryEngine = new DeterministicQueryEngine({
      teamContext: this.teamContext,
      timezone: this.timezone,
      businessDayStart: this.businessDayStart,
      now: this.now(),
    });
  }

  get team(): TeamConfig {
    return this.teamContext.team;
  }

  private async refresh(
    refresh = true,
    maxMatches = 500,
    signal?: AbortSignal,
  ): Promise<{
    records: NormalizedMatch[];
    coverage: Coverage;
    source: SourceInfo;
    diagnostics: Record<string, unknown>;
    newMatchIds: string[];
  }> {
    const now = this.now();
    const existing = await this.repository.listMatches();
    const state = await this.repository.getSyncState('team:' + this.team.id);
    const stateChecked = state ? Date.parse(state.checkedAt) : Number.NaN;
    if (
      !refresh &&
      state &&
      Number.isFinite(stateChecked) &&
      now.getTime() - stateChecked < this.freshnessMs
    ) {
      return {
        records: existing,
        coverage: coverageForLocal(existing, now, state),
        source: sourceForLocal(existing, now, state, this.repository.store),
        diagnostics: { refreshed: false, reason: 'fresh_cache' },
        newMatchIds: [],
      };
    }
    if (!this.apiClient)
      return {
        records: existing,
        coverage: coverageForLocal(existing, now, state),
        source: sourceForLocal(existing, now, state, this.repository.store),
        diagnostics: { refreshed: false, reason: 'api_not_configured' },
        newMatchIds: [],
      };
    const knownIds =
      state?.coverage.status !== 'SOURCE_UNAVAILABLE' && Array.isArray(state?.discoveredMatchIds)
        ? new Set(state.discoveredMatchIds)
        : new Set<string>();
    const synced = await this.apiClient.syncTeam(this.team, {
      maxMatches,
      // Match rows are shared public cache entries in PostgreSQL. Only the
      // team-scoped sync ledger proves this roster has already expanded each
      // discovered match into its own authorized player subset.
      knownMatchIds: existing
        .map((record) => record.matchId)
        .filter((matchId) => knownIds.has(matchId)),
      ...(signal ? { signal } : {}),
    });
    if (synced.records.length) {
      await this.repository.upsertMatches(synced.records, {
        source: 'pubg-api',
        fetchedAt: now.toISOString(),
        checkedPlayerIds: this.team.players.map((player) => player.id),
      });
    }
    const merged = await this.repository.listMatches();
    const coverage =
      synced.coverage.status === 'SOURCE_UNAVAILABLE' && merged.length > 0
        ? staleCoverage(
            state?.coverage ?? synced.coverage,
            merged,
            now,
            synced.coverage.failedMatchIds,
          )
        : coverageWithRecords(synced.coverage, merged, now);
    const stateValue = {
      key: 'team:' + this.team.id,
      checkedAt: now.toISOString(),
      coverage,
      source: { ...synced.source, localMatchCount: merged.length },
      discoveredMatchIds: synced.discoveredMatchIds,
      failedMatchIds: coverage.failedMatchIds,
      ...(synced.source.error ? { error: synced.source.error } : {}),
    };
    await this.repository.setSyncState(stateValue);
    return {
      records: merged,
      coverage: stateValue.coverage,
      source: stateValue.source,
      diagnostics: synced.diagnostics ?? {},
      newMatchIds: synced.records.map((record) => record.matchId),
    };
  }

  private resolveSubject(input: SubjectInput): {
    ids: string[];
    players: TeamPlayer[];
    error?: ToolError;
  } {
    const requested = playerIdsFromSubject(input, this.team);
    const aliasMap = new Map<string, TeamPlayer>();
    for (const player of this.team.players) {
      aliasMap.set(player.id.toLowerCase(), player);
      aliasMap.set(player.name.toLowerCase(), player);
      for (const alias of player.aliases) aliasMap.set(alias.toLowerCase(), player);
    }
    const players = [
      ...requested.ids
        .map((id) => this.team.players.find((player) => player.id === id))
        .filter((player): player is TeamPlayer => Boolean(player)),
    ];
    for (const name of requested.names) {
      const player = aliasMap.get(name.toLowerCase());
      if (!player)
        return {
          ids: [],
          players: [],
          error: { code: 'unknown_player', retryable: false, reason: name },
        };
      if (!players.some((item) => item.id === player.id)) players.push(player);
    }
    const unknownIds = requested.ids.filter(
      (id) => !this.team.players.some((player) => player.id === id),
    );
    if (unknownIds.length)
      return {
        ids: [],
        players: [],
        error: { code: 'unknown_player', retryable: false, reason: unknownIds.join(',') },
      };
    return { ids: players.map((player) => player.id), players };
  }

  async resolvePlayers(input: ResolvePlayersInput): Promise<ToolEnvelope> {
    const requested = playerIdsFromSubject(input, this.team);
    const subject = this.resolveSubject(input);
    if (subject.error && input.playerNames?.length && this.apiClient) {
      try {
        const entries = await this.apiClient.discoverPlayers(
          this.team.platform,
          [],
          input.playerNames,
          input.signal,
        );
        const resolved = entries
          .map((entry) => ({
            accountId: String(entry.id ?? ''),
            apiName: String((entry.attributes as Record<string, unknown> | undefined)?.name ?? ''),
          }))
          .filter((item) => item.accountId);
        const exact = resolved.filter((item) =>
          input.playerNames?.some((name) => item.apiName.toLowerCase() === name.toLowerCase()),
        );
        return {
          status: exact.length === 1 ? 'ok' : exact.length > 1 ? 'error' : 'no_matches',
          data: { requestedNames: input.playerNames, matches: exact, configured: false },
          coverage: coverageForLocal([], this.now(), null),
          asOf: this.now().toISOString(),
          metricVersion: PUBGMETRIC_VERSION,
          queryResolved: { tool: 'pubg_resolve_players', platform: this.team.platform },
          evidenceRefs: {
            matchIds: [],
            playerIds: exact.map((item) => item.accountId),
            fields: ['accountId', 'apiName'],
            calculation: 'configured_alias_or_official_player_lookup',
          },
          ...(exact.length > 1
            ? {
                error: {
                  code: 'ambiguous_player',
                  retryable: false,
                  reason: 'multiple official players matched',
                },
              }
            : {}),
        };
      } catch (error) {
        return this.errorEnvelope(
          'player_lookup_failed',
          error instanceof PubgApiError ? error.retryable : true,
          error instanceof Error ? error.message : 'player lookup failed',
        );
      }
    }
    if (subject.error)
      return this.errorEnvelope(subject.error.code, subject.error.retryable, subject.error.reason);
    return {
      status: 'ok',
      data: {
        platform: this.team.platform,
        teamId: this.team.id,
        teamLabel: this.team.label,
        players: subject.players.map((player) => ({
          accountId: player.id,
          name: player.name,
          aliases: player.aliases,
        })),
      },
      coverage: coverageForLocal([], this.now(), null),
      asOf: this.now().toISOString(),
      metricVersion: PUBGMETRIC_VERSION,
      queryResolved: { tool: 'pubg_resolve_players', requested: requested },
      evidenceRefs: {
        matchIds: [],
        playerIds: subject.ids,
        fields: ['accountId', 'name', 'aliases'],
        calculation: 'configured_team_aliases',
      },
    };
  }

  private errorEnvelope(code: string, retryable: boolean, reason: string): ToolEnvelope {
    return {
      status: 'error',
      data: {},
      coverage: coverageForLocal([], this.now(), null),
      asOf: this.now().toISOString(),
      metricVersion: PUBGMETRIC_VERSION,
      queryResolved: {},
      evidenceRefs: { matchIds: [], playerIds: [], fields: [], calculation: PUBG_QUERY_VERSION },
      error: { code, retryable, reason },
    };
  }

  async queryStats(input: StatsToolInput): Promise<ToolEnvelope> {
    const subject = this.resolveSubject(input);
    if (subject.error)
      return this.errorEnvelope(subject.error.code, subject.error.retryable, subject.error.reason);
    const source = await this.refresh(
      input.refresh !== false || input.selector.type === 'last_n_matches',
      this.maxMatches,
      input.signal,
    );
    let resultSetMatchIds: string[] | undefined;
    if (input.selector.type === 'result_set') {
      const resultSet = await this.repository.getResultSet(
        input.sessionId,
        input.selector.resultSetId,
        this.now(),
      );
      if (!resultSet)
        return this.errorEnvelope(
          'result_set_not_found_or_session_mismatch',
          false,
          'result set is missing, expired, or belongs to another session',
        );
      resultSetMatchIds = resultSet.matchIds;
    }
    const query = queryForStats(input, subject.ids, this.timezone, this.businessDayStart);
    const result = this.queryEngine.execute(query, source.records, source.coverage, source.source, {
      teamContext: this.teamContext,
      now: this.now(),
      ...(resultSetMatchIds ? { resultSetMatchIds } : {}),
    });
    const resultSet = resultSetFromResult(result, query, input.sessionId, PUBG_RESULT_SET_TTL_MS);
    await this.repository.setResultSet(resultSet);
    return resultEnvelope(result, query, resultSet.id);
  }

  async compareStats(input: CompareToolInput): Promise<ToolEnvelope> {
    const subject = this.resolveSubject(input);
    if (subject.error)
      return this.errorEnvelope(subject.error.code, subject.error.retryable, subject.error.reason);
    const source = await this.refresh(input.refresh !== false, this.maxMatches, input.signal);
    const query = queryForCompare(input, subject.ids, this.timezone, this.businessDayStart);
    const result = this.queryEngine.execute(query, source.records, source.coverage, source.source, {
      teamContext: this.teamContext,
      now: this.now(),
    });
    const resultSet = resultSetFromResult(result, query, input.sessionId, PUBG_RESULT_SET_TTL_MS);
    await this.repository.setResultSet(resultSet);
    return resultEnvelope(result, query, resultSet.id);
  }

  async searchMatches(input: SearchMatchesInput): Promise<ToolEnvelope> {
    const subject = this.resolveSubject(input);
    if (subject.error)
      return this.errorEnvelope(subject.error.code, subject.error.retryable, subject.error.reason);
    const forceFreshSearch = input.recentN !== undefined || input.selector !== undefined;
    const source = await this.refresh(
      input.refresh !== false || forceFreshSearch,
      this.maxMatches,
      input.signal,
    );
    const now = this.now();
    const selectorTimezone =
      input.selector?.type === 'time_range'
        ? (input.selector.timezone ?? this.timezone)
        : this.timezone;
    const selectorBusinessDayStart =
      input.selector?.type === 'time_range'
        ? (input.selector.businessDayStart ?? this.businessDayStart)
        : this.businessDayStart;
    const canonicalSearchSelector: Selector | null = input.selector
      ? input.selector.type === 'time_range'
        ? {
            type: 'time_range',
            start: input.selector.from,
            end: input.selector.to,
            timezone: input.selector.timezone ?? this.timezone,
            businessDayStart: input.selector.businessDayStart ?? this.businessDayStart,
          }
        : input.selector
      : null;
    const resolvedSelector = canonicalSearchSelector
      ? resolveSelector(canonicalSearchSelector, {
          timezone: selectorTimezone,
          businessDayStart: selectorBusinessDayStart,
          now,
        })
      : null;
    const from = resolvedSelector
      ? Date.parse(resolvedSelector.start)
      : input.from
        ? asFiniteDate(input.from)
        : 0;
    const to = resolvedSelector
      ? Date.parse(resolvedSelector.end)
      : input.to
        ? asFiniteDate(input.to)
        : now.getTime();
    if (from === null || to === null || from >= to)
      return this.errorEnvelope('invalid_time_range', false, 'from/to must be valid and from < to');
    const selected = source.records.filter(
      (match) =>
        match.timestamp >= from &&
        match.timestamp < to &&
        match.isCompetitive !== false &&
        match.players.some((player) => subject.ids.includes(player.accountId)) &&
        (!input.gameMode || match.gameMode.toLowerCase() === input.gameMode.toLowerCase()) &&
        (!input.mapName || match.mapName.toLowerCase() === input.mapName.toLowerCase()),
    );
    const order = searchOrder(input);
    const ordered = [...selected].sort((left, right) =>
      order === 'desc'
        ? right.timestamp - left.timestamp || right.matchId.localeCompare(left.matchId)
        : left.timestamp - right.timestamp || left.matchId.localeCompare(right.matchId),
    );
    const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? 20), 1), 50);
    const page = Math.min(Math.max(Math.trunc(input.page ?? 0), 0), 100);
    const recent = input.recentN
      ? ordered.slice(0, Math.min(Math.max(Math.trunc(input.recentN), 1), 100))
      : ordered.slice(page * pageSize, page * pageSize + pageSize);
    const rows = recent.map((match) => {
      const players = match.players.filter((player) => subject.ids.includes(player.accountId));
      const ranks = players
        .map((player) => player.rank)
        .filter((rank): rank is number => rank !== null);
      return {
        matchId: match.matchId,
        startedAt: match.createdAt,
        timestamp: match.timestamp,
        mapName: match.mapName,
        gameMode: match.gameMode,
        duration: match.duration,
        patchVersion: match.patchVersion,
        placement: ranks.length ? Math.min(...ranks) : null,
        players: players.map((player) => ({
          accountId: player.accountId,
          name: player.playerName,
          kills: player.kills,
          assists: player.assists,
          damage: player.damage,
          dbnos: player.dbnos,
          rank: player.rank,
        })),
      };
    });
    const query = {
      tool: 'pubg_search_matches',
      sessionId: input.sessionId,
      selector: {
        ...(input.selector ?? { type: 'time_range' }),
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        timezone: resolvedSelector?.timezone ?? input.timezone ?? this.timezone,
        businessDayStart: resolvedSelector?.businessDayStart ?? selectorBusinessDayStart,
      },
      subject: subject.ids,
      filters: { gameMode: input.gameMode ?? null, mapName: input.mapName ?? null },
      order,
      page,
      pageSize,
      refresh: {
        requested: input.refresh !== false || forceFreshSearch,
        forcedForRecent: input.recentN !== undefined,
        forcedForSelector: input.selector !== undefined,
        syncInvoked: source.source.syncInvoked,
        playerApiCalls: source.source.playerApiCalls,
        matchApiCalls: source.source.matchApiCalls,
        newMatchCount: source.diagnostics.newMatchCount ?? 0,
        cachedMatchCount: source.diagnostics.cachedMatchCount ?? 0,
        cacheReason: source.diagnostics.reason ?? null,
      },
    };
    const resultSetId = 'mrs_' + randomUUID();
    const resultSet: ResultSetRecord = {
      id: resultSetId,
      queryId: 'search-' + randomUUID(),
      sessionId: input.sessionId,
      resolvedQuery: queryForStats(
        {
          sessionId: input.sessionId,
          selector: {
            type: 'time_range',
            from: new Date(from).toISOString(),
            to: new Date(to).toISOString(),
          },
          metrics: ['matches'],
          operation: 'list',
          groupBy: 'match',
        },
        subject.ids,
        this.timezone,
        this.businessDayStart,
      ),
      resolvedSelector: {
        type: 'time_range',
        start: new Date(from).toISOString(),
        end: new Date(to).toISOString(),
        timezone: resolvedSelector?.timezone ?? selectorTimezone,
        businessDayStart: resolvedSelector?.businessDayStart ?? selectorBusinessDayStart,
      },
      playerIds: subject.ids,
      matchIds: recent.map((match) => match.matchId),
      rows: [],
      aggregates: {
        candidateCount: selected.length,
        returnedCount: rows.length,
        page,
        pageSize,
        order,
      },
      rankings: [],
      coverage: source.coverage,
      status: rows.length
        ? source.coverage.status === 'OK'
          ? 'OK'
          : source.coverage.status
        : source.coverage.complete
          ? 'NO_MATCHES'
          : source.coverage.status,
      source: source.source,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PUBG_RESULT_SET_TTL_MS).toISOString(),
    };
    await this.repository.setResultSet(resultSet);
    const usableCachedCoverage = ['STALE', 'PARTIAL', 'COVERAGE_GAP'].includes(
      source.coverage.status,
    );
    const status: ToolStatus = rows.length
      ? source.coverage.status === 'OK'
        ? 'ok'
        : 'partial'
      : usableCachedCoverage
        ? 'partial'
        : source.coverage.complete
          ? 'no_matches'
          : 'error';
    const envelope: ToolEnvelope = {
      status,
      data: {
        matches: sanitize(rows),
        total: selected.length,
        page,
        pageSize,
        hasMore: (page + 1) * pageSize < selected.length,
      },
      coverage: source.coverage,
      asOf: source.coverage.checkedAt ?? now.toISOString(),
      metricVersion: PUBGMETRIC_VERSION,
      queryResolved: query,
      evidenceRefs: {
        matchIds: recent.map((match) => match.matchId),
        playerIds: subject.ids,
        fields: [
          'matchId',
          'startedAt',
          'mapName',
          'gameMode',
          'placement',
          'players.kills',
          'players.damage',
        ],
        calculation: 'deterministic_match_search',
      },
      resultSetId,
    };
    if (source.coverage.status === 'SOURCE_UNAVAILABLE')
      envelope.error = {
        code: 'source_unavailable',
        retryable: true,
        reason: source.source.error ?? 'PUBG API unavailable',
      };
    return envelope;
  }

  async prefetchTelemetry(input: PrefetchTelemetryInput = {}): Promise<ToolEnvelope> {
    if (this.prefetchInFlight) return this.prefetchInFlight;
    const pending = this.runTelemetryPrefetch(input);
    this.prefetchInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.prefetchInFlight === pending) this.prefetchInFlight = undefined;
    }
  }

  private async runTelemetryPrefetch(input: PrefetchTelemetryInput): Promise<ToolEnvelope> {
    const started = this.now();
    const maxMatches = Math.min(Math.max(Math.trunc(input.maxMatches ?? this.maxMatches), 1), 1000);
    const maxFetches = Math.min(Math.max(Math.trunc(input.maxFetches ?? 20), 1), 50);
    const concurrency = Math.min(Math.max(Math.trunc(input.concurrency ?? 2), 1), 4);
    const source = await this.refresh(true, maxMatches, input.signal);
    const key = {
      parserVersion: this.telemetryWorker.parserVersion,
      featureVersion: this.telemetryWorker.featureVersion,
    };
    const retryCandidates = await this.repository.listDueTelemetryPrefetchAttempts(
      key.parserVersion,
      key.featureVersion,
      started,
      1000,
    );
    const candidateIds = [
      ...new Set([...source.newMatchIds, ...retryCandidates.map((attempt) => attempt.matchId)]),
    ];
    const candidateMatches: NormalizedMatch[] = [];
    for (const matchId of candidateIds) {
      const match = await this.repository.getMatch(matchId);
      if (match) candidateMatches.push(match);
    }
    const selected = candidateMatches.slice(0, maxFetches);
    const deferred = candidateMatches.slice(maxFetches);
    for (const match of deferred) {
      const previous = await this.repository.getTelemetryPrefetchAttempt({
        ...key,
        matchId: match.matchId,
      });
      await this.repository.setTelemetryPrefetchAttempt({
        matchId: match.matchId,
        ...key,
        status: 'PENDING',
        attemptCount: previous?.attemptCount ?? 0,
        lastAttemptedAt: previous?.lastAttemptedAt ?? null,
        nextRetryAt: started.toISOString(),
        ...(previous?.error ? { error: previous.error } : {}),
        updatedAt: started.toISOString(),
      });
    }
    const outcomes = await mapWithConcurrency(selected, concurrency, async (match) => ({
      matchId: match.matchId,
      result: await this.telemetryWorker.ensure(match, 1, input.signal),
    }));
    let fetchedCount = 0;
    let cacheHitCount = 0;
    let unavailableCount = 0;
    const unavailableIds: string[] = [];
    for (const outcome of outcomes) {
      const previous = await this.repository.getTelemetryPrefetchAttempt({
        ...key,
        matchId: outcome.matchId,
      });
      const result = outcome.result;
      if (result.status === 'FETCHED') fetchedCount += 1;
      else if (result.status === 'HIT') cacheHitCount += 1;
      else {
        unavailableCount += 1;
        unavailableIds.push(outcome.matchId);
      }
      const attemptCount =
        result.status === 'UNAVAILABLE'
          ? (previous?.attemptCount ?? 0) + 1
          : (previous?.attemptCount ?? 0);
      await this.repository.setTelemetryPrefetchAttempt({
        matchId: outcome.matchId,
        ...key,
        status: result.status === 'FETCHED' ? 'FETCHED' : result.status,
        attemptCount,
        lastAttemptedAt: started.toISOString(),
        nextRetryAt: result.status === 'UNAVAILABLE' ? retryAt(started, attemptCount) : null,
        ...(result.error ? { error: result.error } : {}),
        updatedAt: started.toISOString(),
      });
    }
    const diagnosticFailedIds = Array.isArray(source.diagnostics.failedMatchIds)
      ? source.diagnostics.failedMatchIds.map(String)
      : [];
    const failedMatchIds = [...new Set([...diagnosticFailedIds, ...unavailableIds])];
    const finished = this.now();
    const run: TelemetryPrefetchRun = {
      runId: 'tp_' + randomUUID(),
      reportDate: localDateLabel(started.getTime(), this.timezone),
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      trigger: input.trigger ?? 'hourly',
      discoveredMatchCount: Number(
        source.diagnostics.discoveredMatchCount ?? source.newMatchIds.length,
      ),
      newMatchCount: source.newMatchIds.length,
      candidateMatchCount: candidateMatches.length,
      fetchedCount,
      cacheHitCount,
      unavailableCount,
      pendingCount: deferred.length + unavailableCount,
      failedMatchIds,
    };
    await this.repository.recordTelemetryPrefetchRun(run);
    const status: ToolStatus =
      source.coverage.status === 'SOURCE_UNAVAILABLE' ||
      run.unavailableCount > 0 ||
      run.pendingCount > 0
        ? 'partial'
        : 'ok';
    return {
      status,
      data: {
        run,
        matchSync: {
          coverage: source.coverage,
          source: source.source,
          diagnostics: source.diagnostics,
        },
        parserVersion: key.parserVersion,
        featureVersion: key.featureVersion,
      },
      coverage: source.coverage,
      asOf: finished.toISOString(),
      metricVersion: PUBGMETRIC_VERSION,
      queryResolved: {
        tool: 'pubg_prefetch_telemetry',
        timezone: this.timezone,
        maxMatches,
        maxFetches,
        concurrency,
        trigger: run.trigger,
      },
      evidenceRefs: {
        matchIds: [...new Set([...candidateIds, ...failedMatchIds])].slice(0, 1000),
        playerIds: this.team.players.map((player) => player.id),
        fields: ['matchSync', 'telemetryFeatures', 'prefetchAttempts', 'retrySchedule'],
        calculation: 'pubg_hourly_telemetry_prefetch_v1',
      },
      ...(source.coverage.status === 'SOURCE_UNAVAILABLE'
        ? {
            error: {
              code: 'source_unavailable',
              retryable: true,
              reason: source.source.error ?? 'PUBG API unavailable',
            },
          }
        : {}),
    };
  }

  async getTelemetrySyncReport(input: TelemetrySyncReportInput = {}): Promise<ToolEnvelope> {
    const now = this.now();
    const reportDate = input.reportDate?.trim() || previousLocalDate(now, this.timezone);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(reportDate) ||
      !Number.isFinite(Date.parse(`${reportDate}T00:00:00Z`))
    ) {
      return this.errorEnvelope('invalid_report_date', false, 'reportDate must be YYYY-MM-DD');
    }
    const runs = await this.repository.listTelemetryPrefetchRuns(reportDate);
    const summary = summarizePrefetchRuns(reportDate, this.timezone, runs);
    const asOf = summary.lastRunAt ?? now.toISOString();
    const status: ToolStatus =
      summary.unavailableCount || summary.pendingCount || summary.failedMatchIds.length
        ? 'partial'
        : 'ok';
    const [matches, syncState] = await Promise.all([
      this.repository.listMatches(),
      this.repository.getSyncState('team:' + this.team.id),
    ]);
    return {
      status,
      data: {
        summary,
        runs,
      },
      coverage: coverageForLocal(matches, now, syncState),
      asOf,
      metricVersion: PUBGMETRIC_VERSION,
      queryResolved: {
        tool: 'pubg_telemetry_sync_report',
        reportDate,
        timezone: this.timezone,
        period: 'previous_calendar_day',
      },
      evidenceRefs: {
        matchIds: summary.failedMatchIds.slice(0, 1000),
        playerIds: this.team.players.map((player) => player.id),
        fields: [
          'prefetchRuns',
          'fetchedCount',
          'cacheHitCount',
          'unavailableCount',
          'pendingCount',
          'dataUpdatedAt',
        ],
        calculation: 'pubg_daily_telemetry_sync_report_v1',
      },
    };
  }

  async getMatch(input: GetMatchInput): Promise<ToolEnvelope> {
    let match = await this.repository.getMatch(input.matchId);
    const [initialCount, initialMatches, initialState] = await Promise.all([
      this.repository.countMatches(),
      this.repository.listMatches(),
      this.repository.getSyncState('team:' + this.team.id),
    ]);
    let source: SourceInfo = {
      store: this.repository.store,
      syncInvoked: false,
      playerApiCalls: 0,
      matchApiCalls: 0,
      localMatchCount: initialCount,
    };
    let coverage = coverageForLocal(initialMatches, this.now(), initialState);
    if (!match && input.refresh !== false && this.apiClient) {
      try {
        const fetched = await this.apiClient.getMatch(
          this.team.platform,
          input.matchId,
          this.team,
          input.signal,
        );
        await this.repository.upsertMatches([fetched], {
          source: 'pubg-api',
          fetchedAt: this.now().toISOString(),
          checkedPlayerIds: this.team.players.map((player) => player.id),
        });
        match = fetched;
        const [matchCount, matches] = await Promise.all([
          this.repository.countMatches(),
          this.repository.listMatches(),
        ]);
        source = {
          store: 'pubg-api',
          syncInvoked: true,
          playerApiCalls: 0,
          matchApiCalls: 1,
          localMatchCount: matchCount,
        };
        coverage = coverageForLocal(matches, this.now(), null);
      } catch (error) {
        const apiError = error instanceof PubgApiError;
        return this.errorEnvelope(
          apiError ? error.code : 'match_fetch_failed',
          apiError ? error.retryable : true,
          error instanceof Error ? error.message : 'match fetch failed',
        );
      }
    }
    if (!match) return this.errorEnvelope('match_not_found', false, input.matchId);
    const row: QueryRow = {
      key: match.matchId,
      label: match.matchId,
      groupBy: 'match',
      matchId: match.matchId,
      timestamp: match.timestamp,
      createdAt: match.createdAt,
      mapName: match.mapName,
      gameMode: match.gameMode,
      duration: match.duration,
      players: match.players,
      metrics: {
        matches: 1,
        kills: match.players.reduce((sum, player) => sum + player.kills, 0),
        assists: match.players.reduce((sum, player) => sum + player.assists, 0),
        damage: match.players.reduce((sum, player) => sum + player.damage, 0),
        rank:
          match.players
            .map((player) => player.rank)
            .filter((rank): rank is number => rank !== null)
            .sort((a, b) => a - b)[0] ?? null,
      },
      activityStatus: 'ACTIVE',
    };
    return {
      status: 'ok',
      data: { match: sanitize({ ...match, telemetryUrl: undefined, row }) },
      coverage,
      asOf: this.now().toISOString(),
      metricVersion: PUBGMETRIC_VERSION,
      queryResolved: {
        tool: 'pubg_get_match',
        matchId: input.matchId,
        sourceRange: (() => {
          const from =
            match.createdAt ??
            (Number.isFinite(match.timestamp) ? new Date(match.timestamp).toISOString() : null);
          const fromTimestamp = from ? Date.parse(from) : Number.NaN;
          const to =
            Number.isFinite(fromTimestamp) && Number.isFinite(match.duration)
              ? new Date(fromTimestamp + Math.max(0, match.duration) * 1000).toISOString()
              : null;
          return { from, to, timezone: this.timezone, businessDayStart: this.businessDayStart };
        })(),
      },
      evidenceRefs: {
        matchIds: [match.matchId],
        playerIds: match.players.map((player) => player.accountId),
        fields: ['matchId', 'createdAt', 'mapName', 'gameMode', 'players'],
        calculation: 'sqlite_match_store',
      },
    };
  }

  async getReviewFacts(input: GetReviewFactsInput): Promise<ToolEnvelope> {
    const searchResultSet = await this.repository.getResultSet(
      input.sessionId,
      input.searchResultSetId,
      this.now(),
    );
    const searchCreatedAt = searchResultSet ? Date.parse(searchResultSet.createdAt) : Number.NaN;
    const searchAge = Number.isFinite(searchCreatedAt)
      ? this.now().getTime() - searchCreatedAt
      : Number.POSITIVE_INFINITY;
    if (
      !searchResultSet ||
      !searchResultSet.source.syncInvoked ||
      searchAge < 0 ||
      searchAge > PUBG_REVIEW_SEARCH_MAX_AGE_MS
    ) {
      return this.errorEnvelope(
        'review_search_required',
        true,
        'call pubg_search_matches with refresh=true in the current turn, then pass its resultSetId to pubg_get_review_facts',
      );
    }
    if (!searchResultSet.matchIds.includes(input.matchId)) {
      return this.errorEnvelope('match_not_in_search_result', false, input.matchId);
    }
    const match = await this.repository.getMatch(input.matchId);
    if (!match) {
      const result = await this.getMatch({
        sessionId: input.sessionId,
        matchId: input.matchId,
        ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (result.status === 'error') return result;
    }
    const target = await this.repository.getMatch(input.matchId);
    if (!target) return this.errorEnvelope('match_not_found', false, input.matchId);
    const telemetry = await this.telemetryWorker.ensure(target, 1, input.signal);
    const fullFacts = input.playerIds?.length
      ? scopeMatchReviewFacts(
          telemetry.facts ?? emptyMatchReviewFacts(target, this.team, 1),
          input.playerIds,
        )
      : (telemetry.facts ?? emptyMatchReviewFacts(target, this.team, 1));
    const facts = selectMatchReviewFactCategories(fullFacts, input.categories);
    const analysis = analyzeMatchReview(facts);
    const review: MatchReviewResult = {
      schemaVersion: 1,
      match: facts.match,
      facts,
      analysis,
      telemetry: {
        status: telemetry.status,
        cacheStatus: telemetry.cacheStatus,
        cacheLookup: telemetry.cacheLookup,
        availability: telemetry.availability,
        parserVersion: telemetry.parserVersion,
        featureVersion: telemetry.featureVersion,
        ...(telemetry.error ? { error: telemetry.error } : {}),
      },
    };
    const status: ToolStatus =
      telemetry.status === 'UNAVAILABLE' ? 'partial' : facts.fightIntegrity.pass ? 'ok' : 'partial';
    const sourceRange = searchResultSet
      ? sourceRangeFromSelector(searchResultSet.resolvedSelector)
      : null;
    const [allMatches, syncState] = await Promise.all([
      this.repository.listMatches(),
      this.repository.getSyncState('team:' + this.team.id),
    ]);
    const result: ToolEnvelope = {
      status,
      data: {
        facts: sanitize(facts),
        telemetry: sanitize(review.telemetry),
        derivedAnalysis: sanitize(analysis),
      },
      coverage: coverageForLocal(allMatches, this.now(), syncState),
      asOf: this.now().toISOString(),
      metricVersion: PUBGMETRIC_VERSION,
      queryResolved: {
        tool: 'pubg_get_review_facts',
        matchId: input.matchId,
        searchResultSetId: input.searchResultSetId,
        playerIds: input.playerIds ?? null,
        categories: input.categories ?? null,
        ...(sourceRange ? { sourceRange } : {}),
      },
      evidenceRefs: {
        matchIds: [target.matchId],
        playerIds: facts.squad.playerIds,
        fields: ['match', 'players', 'combat', 'fights', 'weapons', 'vehicles', 'evidence'],
        calculation: 'telemetry_facts_v1',
      },
    };
    if (telemetry.status === 'UNAVAILABLE')
      result.error = {
        code: 'telemetry_unavailable',
        retryable: true,
        reason: telemetry.error ?? 'telemetry unavailable',
      };
    return result;
  }

  async getPeriodReview(input: GetPeriodReviewInput): Promise<ToolEnvelope> {
    const now = this.now();
    const searchResultSet = await this.repository.getResultSet(
      input.sessionId,
      input.searchResultSetId,
      now,
    );
    const searchCreatedAt = searchResultSet ? Date.parse(searchResultSet.createdAt) : Number.NaN;
    const searchAge = Number.isFinite(searchCreatedAt)
      ? now.getTime() - searchCreatedAt
      : Number.POSITIVE_INFINITY;
    if (
      !searchResultSet ||
      !searchResultSet.source.syncInvoked ||
      searchAge < 0 ||
      searchAge > PUBG_REVIEW_SEARCH_MAX_AGE_MS
    ) {
      return this.errorEnvelope(
        'review_search_required',
        true,
        'call pubg_search_matches with refresh=true in the current turn, then pass its resultSetId to pubg_get_period_review',
      );
    }

    const sourceRange = sourceRangeFromSelector(searchResultSet.resolvedSelector);
    const orderedMatchIds = [...searchResultSet.matchIds];
    const reviews: Array<Record<string, unknown>> = [];
    const selectedMatches = new Map<string, NormalizedMatch>();
    for (const matchId of orderedMatchIds) {
      const review = await this.getReviewFacts({
        sessionId: input.sessionId,
        matchId,
        searchResultSetId: input.searchResultSetId,
        ...(input.playerIds?.length ? { playerIds: input.playerIds } : {}),
        ...(input.categories?.length ? { categories: input.categories } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const match = await this.repository.getMatch(matchId);
      if (match) selectedMatches.set(matchId, match);
      reviews.push({
        matchId,
        status: review.status,
        data: sanitize(review.data),
        ...(review.error ? { error: review.error } : {}),
        ...(match
          ? {
              match: {
                matchId: match.matchId,
                createdAt: match.createdAt,
                mapName: match.mapName,
                gameMode: match.gameMode,
                duration: match.duration,
              },
            }
          : {}),
      });
    }
    const partial =
      reviews.some((review) => review.status !== 'ok') || searchResultSet.status !== 'OK';
    const status: ToolStatus =
      orderedMatchIds.length === 0 ? 'no_matches' : partial ? 'partial' : 'ok';
    return {
      status,
      data: {
        period: {
          label:
            typeof searchResultSet.resolvedSelector.label === 'string'
              ? searchResultSet.resolvedSelector.label
              : 'PUBG 周期复盘',
          orderedMatchIds,
        },
        reviews,
        matches: orderedMatchIds.map((matchId) => {
          const match = selectedMatches.get(matchId);
          return match
            ? {
                matchId,
                startedAt: match.createdAt,
                mapName: match.mapName,
                gameMode: match.gameMode,
              }
            : { matchId, startedAt: null, mapName: '未知地图', gameMode: '未知模式' };
        }),
      },
      coverage: searchResultSet.coverage,
      asOf: now.toISOString(),
      metricVersion: PUBGMETRIC_VERSION,
      queryResolved: {
        tool: 'pubg_get_period_review',
        sessionId: input.sessionId,
        searchResultSetId: input.searchResultSetId,
        selector: searchResultSet.resolvedSelector,
        order: orderedMatchIds,
        ...(sourceRange ? { sourceRange } : {}),
        categories: input.categories ?? null,
      },
      evidenceRefs: {
        matchIds: orderedMatchIds,
        playerIds: input.playerIds ?? searchResultSet.playerIds,
        fields: ['orderedMatchIds', 'reviews', 'telemetry', 'dataUpdatedAt'],
        calculation: 'pubg_period_review_v1',
      },
      ...(partial
        ? {
            error: {
              code: 'period_review_partial',
              retryable: true,
              reason: 'one or more selected matches did not have complete review facts',
            },
          }
        : {}),
      resultSetId: input.searchResultSetId,
    };
  }

  async queryTeamDamage(input: TeamDamageQueryInput): Promise<ToolEnvelope> {
    const actorReference = input.actorPlayer?.trim() || null;
    const victimReference = input.victimPlayer?.trim() || null;
    if (Boolean(actorReference) !== Boolean(victimReference)) {
      return this.errorEnvelope(
        'team_damage_direction_incomplete',
        false,
        'actorPlayer and victimPlayer must be provided together, or both omitted for all directions',
      );
    }
    if (input.meleeKind && input.source && input.source !== 'MELEE') {
      return this.errorEnvelope(
        'team_damage_source_conflict',
        false,
        'meleeKind requires source=MELEE',
      );
    }

    let actor: TeamPlayer | undefined;
    let victim: TeamPlayer | undefined;
    if (actorReference && victimReference) {
      const actorResult = this.resolveSubject({ playerNames: [actorReference] });
      if (actorResult.error)
        return this.errorEnvelope(
          actorResult.error.code,
          actorResult.error.retryable,
          actorResult.error.reason,
        );
      actor = actorResult.players[0];
      const victimResult = this.resolveSubject({ playerNames: [victimReference] });
      if (victimResult.error)
        return this.errorEnvelope(
          victimResult.error.code,
          victimResult.error.retryable,
          victimResult.error.reason,
        );
      victim = victimResult.players[0];
      if (!actor || !victim)
        return this.errorEnvelope('unknown_player', false, `${actorReference},${victimReference}`);
      if (actor.id === victim.id)
        return this.errorEnvelope(
          'team_damage_same_player',
          false,
          'actorPlayer and victimPlayer must be different team players',
        );
    }

    const now = this.now();
    const canonicalSelector = selectorToCanonical(
      input.selector,
      this.timezone,
      this.businessDayStart,
    );
    let resolvedSelector;
    try {
      resolvedSelector = resolveSelector(canonicalSelector, {
        timezone: this.timezone,
        businessDayStart: this.businessDayStart,
        now,
      });
    } catch {
      return this.errorEnvelope(
        'invalid_time_range',
        false,
        'selector must resolve to a valid time range',
      );
    }
    const from = Date.parse(resolvedSelector.start);
    const to = Date.parse(resolvedSelector.end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      return this.errorEnvelope(
        'invalid_time_range',
        false,
        'selector must resolve to a non-empty time range',
      );
    }

    const matchSource = await this.refresh(input.refresh !== false, this.maxMatches, input.signal);
    const teamIds = new Set(this.team.players.map((player) => player.id));
    const directionIds = actor && victim ? new Set([actor.id, victim.id]) : null;
    const selected = matchSource.records
      .filter(
        (match) => match.timestamp >= from && match.timestamp < to && match.isCompetitive !== false,
      )
      .filter((match) => match.players.some((player) => teamIds.has(player.accountId)))
      .filter(
        (match) =>
          !directionIds || match.players.some((player) => directionIds.has(player.accountId)),
      )
      .sort(
        (left, right) =>
          left.timestamp - right.timestamp || left.matchId.localeCompare(right.matchId),
      );
    const effectiveSource = input.meleeKind ? 'MELEE' : input.source;
    const matchInputs = selected.map((match, index) => ({ match, ordinal: index + 1 }));
    const outcomes = await mapWithConcurrency(matchInputs, 2, async ({ match, ordinal }) => {
      const telemetry = await this.telemetryWorker.ensure(match, ordinal, input.signal);
      const facts = telemetry.facts?.teamDamage;
      const matchingFacts = facts
        ? facts
            .filter((fact) =>
              teamDamageFactMatches(fact, actor?.id, victim?.id, effectiveSource, input.meleeKind),
            )
            .sort(
              (left, right) =>
                (left.timestamp ?? Number.POSITIVE_INFINITY) -
                  (right.timestamp ?? Number.POSITIVE_INFINITY) || left.id.localeCompare(right.id),
            )
        : null;
      return { match, telemetry, matchingFacts };
    });

    const unavailableMatchIds = outcomes
      .filter((outcome) => outcome.matchingFacts === null)
      .map((outcome) => outcome.match.matchId);
    const telemetryComplete = unavailableMatchIds.length === 0;
    const telemetryStatusCounts = outcomes.reduce<Record<string, number>>((counts, outcome) => {
      counts[outcome.telemetry.status] = (counts[outcome.telemetry.status] ?? 0) + 1;
      return counts;
    }, {});
    const playerRef = (player: TeamPlayer): { playerId: string; name: string } => ({
      playerId: player.id,
      name: player.name,
    });
    const nameForPlayerId = (playerId: string): { playerId: string; name: string } => {
      const player = this.team.players.find((candidate) => candidate.id === playerId);
      return { playerId, name: player?.name ?? playerId };
    };
    const directionAggregates = new Map<
      string,
      {
        actorPlayerId: string;
        victimPlayerId: string;
        hitCount: number;
        damage: number;
        matchIds: string[];
      }
    >();
    for (const outcome of outcomes) {
      for (const fact of outcome.matchingFacts ?? []) {
        const key = `${fact.actorPlayerId}:${fact.victimPlayerId}`;
        const aggregate = directionAggregates.get(key) ?? {
          actorPlayerId: fact.actorPlayerId,
          victimPlayerId: fact.victimPlayerId,
          hitCount: 0,
          damage: 0,
          matchIds: [],
        };
        aggregate.hitCount += fact.hitCount;
        aggregate.damage += fact.damage;
        if (!aggregate.matchIds.includes(outcome.match.matchId))
          aggregate.matchIds.push(outcome.match.matchId);
        directionAggregates.set(key, aggregate);
      }
    }
    if (actor && victim) {
      const key = `${actor.id}:${victim.id}`;
      if (!directionAggregates.has(key)) {
        directionAggregates.set(key, {
          actorPlayerId: actor.id,
          victimPlayerId: victim.id,
          hitCount: 0,
          damage: 0,
          matchIds: [],
        });
      }
    }
    const knownHitCount = outcomes.reduce(
      (sum, outcome) =>
        sum + (outcome.matchingFacts?.reduce((inner, fact) => inner + fact.hitCount, 0) ?? 0),
      0,
    );
    const knownDamage = roundDamage(
      outcomes.reduce(
        (sum, outcome) =>
          sum + (outcome.matchingFacts?.reduce((inner, fact) => inner + fact.damage, 0) ?? 0),
        0,
      ),
    );
    const matchRows = outcomes.map((outcome) => {
      const players = outcome.match.players.filter((player) => teamIds.has(player.accountId));
      const ranks = players
        .map((player) => player.rank)
        .filter((rank): rank is number => rank !== null);
      const hitCount = outcome.matchingFacts?.reduce((sum, fact) => sum + fact.hitCount, 0) ?? null;
      const damage =
        outcome.matchingFacts === null
          ? null
          : roundDamage(outcome.matchingFacts.reduce((sum, fact) => sum + fact.damage, 0));
      return {
        matchId: outcome.match.matchId,
        startedAt: outcome.match.createdAt,
        mapName: outcome.match.mapName,
        gameMode: outcome.match.gameMode,
        placement: ranks.length ? Math.min(...ranks) : null,
        hitCount,
        damage,
        teamDamage: sanitize(outcome.matchingFacts),
        telemetry: {
          status: outcome.telemetry.status,
          cacheStatus: outcome.telemetry.cacheStatus,
          cacheLookup: outcome.telemetry.cacheLookup,
          availability: outcome.telemetry.availability,
          ...(outcome.telemetry.error ? { error: outcome.telemetry.error } : {}),
        },
      };
    });
    const directionRows = [...directionAggregates.values()]
      .sort(
        (left, right) =>
          right.hitCount - left.hitCount ||
          right.damage - left.damage ||
          left.actorPlayerId.localeCompare(right.actorPlayerId) ||
          left.victimPlayerId.localeCompare(right.victimPlayerId),
      )
      .map((aggregate) => ({
        actor: nameForPlayerId(aggregate.actorPlayerId),
        victim: nameForPlayerId(aggregate.victimPlayerId),
        hitCount: telemetryComplete ? aggregate.hitCount : null,
        damage: telemetryComplete ? roundDamage(aggregate.damage) : null,
        knownHitCount: aggregate.hitCount,
        knownDamage: roundDamage(aggregate.damage),
        complete: telemetryComplete,
        matchIds: aggregate.matchIds,
      }));
    const sourceRows = TEAM_DAMAGE_SOURCES.flatMap((source) => {
      const facts = outcomes
        .flatMap((outcome) => outcome.matchingFacts ?? [])
        .filter((fact) => fact.source === source);
      if (!facts.length) return [];
      const hitCount = facts.reduce((sum, fact) => sum + fact.hitCount, 0);
      const damage = roundDamage(facts.reduce((sum, fact) => sum + fact.damage, 0));
      return [
        {
          source,
          hitCount: telemetryComplete ? hitCount : null,
          damage: telemetryComplete ? damage : null,
          knownHitCount: hitCount,
          knownDamage: damage,
        },
      ];
    });
    const coverage: Coverage = unavailableMatchIds.length
      ? {
          ...matchSource.coverage,
          status: matchSource.coverage.status === 'OK' ? 'PARTIAL' : matchSource.coverage.status,
          complete: false,
          failedMatchIds: [
            ...new Set([...matchSource.coverage.failedMatchIds, ...unavailableMatchIds]),
          ],
          requiredMatchCount: Math.max(
            matchSource.coverage.requiredMatchCount ?? 0,
            selected.length,
          ),
        }
      : matchSource.coverage;
    const status: ToolStatus =
      selected.length === 0
        ? matchSource.coverage.complete
          ? 'no_matches'
          : 'partial'
        : telemetryComplete && matchSource.coverage.status === 'OK'
          ? 'ok'
          : 'partial';
    const sourceRange = {
      from: resolvedSelector.start,
      to: resolvedSelector.end,
      timezone: resolvedSelector.timezone,
      businessDayStart: resolvedSelector.businessDayStart,
    };
    const result: ToolEnvelope = {
      status,
      data: sanitize({
        actor: actor ? playerRef(actor) : null,
        victim: victim ? playerRef(victim) : null,
        direction: actor && victim ? `${actor.name} → ${victim.name}` : 'all directions',
        source: effectiveSource ?? null,
        meleeKind: input.meleeKind ?? null,
        totalHitCount: telemetryComplete ? knownHitCount : null,
        totalDamage: telemetryComplete ? knownDamage : null,
        knownHitCount,
        knownDamage,
        complete: telemetryComplete,
        directions: directionRows,
        bySource: sourceRows,
        matches: matchRows,
        telemetry: {
          requestedMatchCount: selected.length,
          availableMatchCount: selected.length - unavailableMatchIds.length,
          unavailableMatchIds,
          statusCounts: telemetryStatusCounts,
        },
      }),
      coverage,
      asOf: this.now().toISOString(),
      metricVersion: PUBGMETRIC_VERSION,
      queryResolved: {
        tool: 'pubg_query_team_damage',
        sessionId: input.sessionId,
        selector: {
          ...input.selector,
          from: resolvedSelector.start,
          to: resolvedSelector.end,
          timezone: resolvedSelector.timezone,
          businessDayStart: resolvedSelector.businessDayStart,
        },
        sourceRange,
        direction: actor && victim ? { actorPlayerId: actor.id, victimPlayerId: victim.id } : null,
        source: effectiveSource ?? null,
        meleeKind: input.meleeKind ?? null,
        matchCount: selected.length,
        refresh: {
          requested: input.refresh !== false,
          syncInvoked: matchSource.source.syncInvoked,
          playerApiCalls: matchSource.source.playerApiCalls,
          matchApiCalls: matchSource.source.matchApiCalls,
          newMatchCount: matchSource.diagnostics.newMatchCount ?? 0,
          cachedMatchCount: matchSource.diagnostics.cachedMatchCount ?? 0,
          cacheReason: matchSource.diagnostics.reason ?? null,
        },
        telemetry: {
          complete: telemetryComplete,
          unavailableMatchIds,
          statusCounts: telemetryStatusCounts,
        },
      },
      evidenceRefs: {
        matchIds: selected.map((match) => match.matchId),
        playerIds:
          actor && victim ? [actor.id, victim.id] : this.team.players.map((player) => player.id),
        fields: [
          'matchId',
          'startedAt',
          'mapName',
          'placement',
          'actorPlayerId',
          'victimPlayerId',
          'source',
          'meleeKind',
          'hitCount',
          'damage',
          'phase',
          'evidenceIds',
        ],
        calculation: 'pubg_team_damage_query_v1',
      },
    };
    if (unavailableMatchIds.length)
      result.error = {
        code: 'telemetry_unavailable',
        retryable: true,
        reason: `${unavailableMatchIds.length} selected match(es) have unavailable Telemetry`,
      };
    return result;
  }
}
