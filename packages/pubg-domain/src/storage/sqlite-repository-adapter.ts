import type { TelemetryFeatureKey, TelemetryFeatureRecord } from '../review/telemetry.js';
import { parseTeamContext, type TeamContext } from '../context/team-context.js';
import type { PubgRepositoryPort } from './repository-port.js';
import { SqlitePubgRepository } from './sqlite-repository.js';

/** Async domain port adapter over the existing private SQLite repository. */
export class SqlitePubgRepositoryAdapter implements PubgRepositoryPort {
  readonly store = 'sqlite';
  readonly scope: TeamContext;

  constructor(
    readonly sqlite: SqlitePubgRepository,
    scope: TeamContext,
  ) {
    this.scope = parseTeamContext(scope);
  }

  async countMatches(): Promise<number> {
    return this.sqlite.countMatches();
  }
  async getMatch(matchId: string) {
    return this.sqlite.getMatch(matchId);
  }
  async listMatches(options?: { fromMs?: number; toMs?: number; limit?: number }) {
    return this.sqlite.listMatches(options);
  }
  async upsertMatches(
    input: unknown[],
    metadata?: Parameters<SqlitePubgRepository['upsertMatches']>[1],
  ) {
    return this.sqlite.upsertMatches(input, metadata);
  }
  async setSyncState(state: Parameters<SqlitePubgRepository['setSyncState']>[0]) {
    this.sqlite.setSyncState(state);
  }
  async getSyncState(key: string) {
    return this.sqlite.getSyncState(key);
  }
  async get(key: TelemetryFeatureKey): Promise<TelemetryFeatureRecord | null> {
    return this.sqlite.get(key);
  }
  async set(record: TelemetryFeatureRecord): Promise<void> {
    await this.sqlite.set(record);
  }
  async getTelemetryPrefetchAttempt(key: TelemetryFeatureKey) {
    return this.sqlite.getTelemetryPrefetchAttempt(key);
  }
  async listDueTelemetryPrefetchAttempts(
    parserVersion: string,
    featureVersion: string,
    now: Date,
    limit?: number,
  ) {
    return this.sqlite.listDueTelemetryPrefetchAttempts(parserVersion, featureVersion, now, limit);
  }
  async setTelemetryPrefetchAttempt(
    attempt: Parameters<SqlitePubgRepository['setTelemetryPrefetchAttempt']>[0],
  ) {
    this.sqlite.setTelemetryPrefetchAttempt(attempt);
  }
  async recordTelemetryPrefetchRun(
    run: Parameters<SqlitePubgRepository['recordTelemetryPrefetchRun']>[0],
  ) {
    this.sqlite.recordTelemetryPrefetchRun(run);
  }
  async listTelemetryPrefetchRuns(reportDate: string) {
    return this.sqlite.listTelemetryPrefetchRuns(reportDate);
  }
  async setResultSet(result: Parameters<SqlitePubgRepository['setResultSet']>[0]) {
    this.sqlite.setResultSet(result);
  }
  async getResultSet(sessionId: string, resultSetId: string, now?: Date) {
    return this.sqlite.getResultSet(sessionId, resultSetId, now);
  }
  async setContext(context: Parameters<SqlitePubgRepository['setContext']>[0]) {
    this.sqlite.setContext(context);
  }
  async getContext(sessionId: string, now?: Date) {
    return this.sqlite.getContext(sessionId, now);
  }
  async cleanupExpired(now?: Date) {
    this.sqlite.cleanupExpired(now);
  }
}
