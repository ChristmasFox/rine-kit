import type { Coverage, SourceInfo } from '../schema/status.js';
import type { NormalizedMatch, ResultSetRecord, SessionContextRecord } from '../data/model.js';
import type {
  TelemetryFeatureKey,
  TelemetryFeatureRecord,
  TelemetryFeatureStore,
} from '../review/telemetry.js';
import type { TeamContext } from '../context/team-context.js';

export interface MatchWriteMetadata {
  fetchedAt?: string;
  source?: string;
  parserVersion?: string;
  rawJson?: unknown;
  checkedPlayerIds?: string[];
}

export interface UpsertMatchesResult {
  inserted: number;
  updated: number;
  duplicateInputs: number;
  invalidInputs: number;
}

export interface SyncState {
  key: string;
  checkedAt: string;
  coverage: Coverage;
  source: SourceInfo;
  discoveredMatchIds: string[];
  failedMatchIds: string[];
  error?: string;
}

export type TelemetryPrefetchAttemptStatus = 'PENDING' | 'FETCHED' | 'HIT' | 'UNAVAILABLE';

export interface TelemetryPrefetchAttempt {
  matchId: string;
  parserVersion: string;
  featureVersion: string;
  status: TelemetryPrefetchAttemptStatus;
  attemptCount: number;
  lastAttemptedAt: string | null;
  nextRetryAt: string | null;
  error?: string;
  updatedAt: string;
}

export interface TelemetryPrefetchRun {
  runId: string;
  reportDate: string;
  startedAt: string;
  finishedAt: string;
  trigger: 'hourly' | 'manual';
  discoveredMatchCount: number;
  newMatchCount: number;
  candidateMatchCount: number;
  fetchedCount: number;
  cacheHitCount: number;
  unavailableCount: number;
  pendingCount: number;
  failedMatchIds: string[];
}

/**
 * Storage contract for one tenant-aware PUBG Domain service. Implementations
 * are asynchronous so the same domain service can use private SQLite or a
 * public PostgreSQL repository without importing either driver.
 */
export interface PubgRepositoryPort extends TelemetryFeatureStore {
  /** Scope is resolved by the application and fixed when the adapter is created. */
  readonly scope: TeamContext;
  /** Storage provenance used when no upstream synchronization state exists. */
  readonly store: string;
  countMatches(): Promise<number>;
  getMatch(matchId: string): Promise<NormalizedMatch | null>;
  listMatches(options?: {
    fromMs?: number;
    toMs?: number;
    limit?: number;
  }): Promise<NormalizedMatch[]>;
  upsertMatches(input: unknown[], metadata?: MatchWriteMetadata): Promise<UpsertMatchesResult>;
  setSyncState(state: SyncState): Promise<void>;
  getSyncState(key: string): Promise<SyncState | null>;
  getTelemetryPrefetchAttempt(key: TelemetryFeatureKey): Promise<TelemetryPrefetchAttempt | null>;
  listDueTelemetryPrefetchAttempts(
    parserVersion: string,
    featureVersion: string,
    now: Date,
    limit?: number,
  ): Promise<TelemetryPrefetchAttempt[]>;
  setTelemetryPrefetchAttempt(attempt: TelemetryPrefetchAttempt): Promise<void>;
  recordTelemetryPrefetchRun(run: TelemetryPrefetchRun): Promise<void>;
  listTelemetryPrefetchRuns(reportDate: string): Promise<TelemetryPrefetchRun[]>;
  setResultSet(result: ResultSetRecord): Promise<void>;
  getResultSet(sessionId: string, resultSetId: string, now?: Date): Promise<ResultSetRecord | null>;
  setContext(context: SessionContextRecord): Promise<void>;
  getContext(sessionId: string, now?: Date): Promise<SessionContextRecord | null>;
  cleanupExpired(now?: Date): Promise<void>;
}
