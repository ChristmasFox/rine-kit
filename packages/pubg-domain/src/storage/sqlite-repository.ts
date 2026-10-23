import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type {
  NormalizedMatch,
  NormalizedPlayer,
  ResultSetRecord,
  SessionContextRecord,
} from '../data/model.js';
import { normalizeRecords } from '../data/model.js';
import type { ReviewShareRecord, ReviewShareStore } from '../review/review-share.js';
import type {
  SessionReviewLedger,
  SessionReviewRecord,
  SessionReviewStatus,
} from '../review/session-review.js';
import type {
  TelemetryFeatureKey,
  TelemetryFeatureRecord,
  TelemetryFeatureStore,
} from '../review/telemetry.js';
import type {
  MatchWriteMetadata,
  SyncState,
  TelemetryPrefetchAttempt,
  TelemetryPrefetchAttemptStatus,
  TelemetryPrefetchRun,
  UpsertMatchesResult,
} from './repository-port.js';

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

function numeric(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToPlayer(row: Record<string, unknown>): NormalizedPlayer {
  return {
    accountId: String(row.account_id),
    playerName: String(row.player_name ?? row.account_id),
    displayName: String(row.display_name ?? row.player_name ?? row.account_id),
    rank: nullableNumber(row.rank),
    kills: numeric(row.kills),
    assists: numeric(row.assists),
    damage: numeric(row.damage),
    dbnos: numeric(row.dbnos),
    revives: numeric(row.revives),
    headshotKills: numeric(row.headshot_kills),
    survivalTime: numeric(row.survival_time),
    longestKill: numeric(row.longest_kill),
    deaths: nullableNumber(row.deaths),
    deathSemantics: String(row.death_semantics ?? 'unknown') as NormalizedPlayer['deathSemantics'],
  };
}

function rowToMatch(row: Record<string, unknown>, players: NormalizedPlayer[]): NormalizedMatch {
  return {
    schemaVersion: numeric(row.schema_version, 3),
    matchId: String(row.match_id),
    shard: String(row.shard ?? 'steam'),
    createdAt:
      row.created_at === null || row.created_at === undefined ? null : String(row.created_at),
    timestamp: numeric(row.timestamp_ms),
    matchType: String(row.match_type ?? ''),
    gameMode: String(row.game_mode ?? ''),
    isCompetitive: bool(row.is_competitive),
    mapName: String(row.map_name ?? ''),
    duration: numeric(row.duration),
    patchVersion: String(row.patch_version ?? ''),
    players,
    telemetryUrl: row.telemetry_url ? String(row.telemetry_url) : null,
  };
}

function keyForFeature(key: TelemetryFeatureKey): string {
  return key.matchId + ':' + key.parserVersion + ':' + key.featureVersion;
}

export class SqlitePubgRepository
  implements SessionReviewLedger, ReviewShareStore, TelemetryFeatureStore
{
  readonly db: SqliteDatabase;

  constructor(
    readonly filename = ':memory:',
    options: { readOnly?: boolean } = {},
  ) {
    if (!options.readOnly && filename !== ':memory:')
      mkdirSync(dirname(filename), { recursive: true });
    this.db = options.readOnly
      ? new DatabaseSync(filename, { readOnly: true })
      : new DatabaseSync(filename);
    if (!options.readOnly) {
      this.db.exec(
        'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;',
      );
      this.migrate();
    }
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        shard TEXT NOT NULL,
        created_at TEXT,
        timestamp_ms INTEGER NOT NULL,
        match_type TEXT NOT NULL,
        game_mode TEXT NOT NULL,
        is_competitive INTEGER NOT NULL,
        map_name TEXT NOT NULL,
        duration REAL NOT NULL,
        patch_version TEXT NOT NULL,
        telemetry_url TEXT,
        schema_version INTEGER NOT NULL,
        parser_version TEXT,
        fetched_at TEXT NOT NULL,
        source TEXT NOT NULL,
        checked_player_ids_json TEXT NOT NULL DEFAULT '[]',
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pubg_matches_timestamp ON matches(timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_pubg_matches_mode_map ON matches(game_mode, map_name);

      CREATE TABLE IF NOT EXISTS match_players (
        match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        player_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        rank REAL,
        kills REAL NOT NULL,
        assists REAL NOT NULL,
        damage REAL NOT NULL,
        dbnos REAL NOT NULL,
        revives REAL NOT NULL,
        headshot_kills REAL NOT NULL,
        survival_time REAL NOT NULL,
        longest_kill REAL NOT NULL,
        deaths REAL,
        death_semantics TEXT NOT NULL,
        PRIMARY KEY(match_id, account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pubg_match_players_account ON match_players(account_id, match_id);

      CREATE TABLE IF NOT EXISTS sync_state (
        state_key TEXT PRIMARY KEY,
        checked_at TEXT NOT NULL,
        state_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry_features (
        match_id TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        feature_version TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(match_id, parser_version, feature_version)
      );

      CREATE TABLE IF NOT EXISTS telemetry_prefetch_attempts (
        match_id TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        feature_version TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempted_at TEXT,
        next_retry_at TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(match_id, parser_version, feature_version)
      );
      CREATE INDEX IF NOT EXISTS idx_pubg_telemetry_prefetch_due
        ON telemetry_prefetch_attempts(parser_version, feature_version, status, next_retry_at);

      CREATE TABLE IF NOT EXISTS telemetry_prefetch_runs (
        run_id TEXT PRIMARY KEY,
        report_date TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        trigger TEXT NOT NULL,
        discovered_match_count INTEGER NOT NULL,
        new_match_count INTEGER NOT NULL,
        candidate_match_count INTEGER NOT NULL,
        fetched_count INTEGER NOT NULL,
        cache_hit_count INTEGER NOT NULL,
        unavailable_count INTEGER NOT NULL,
        pending_count INTEGER NOT NULL,
        failed_match_ids_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_pubg_telemetry_prefetch_runs_date
        ON telemetry_prefetch_runs(report_date, started_at);

      CREATE TABLE IF NOT EXISTS result_sets (
        session_id TEXT NOT NULL,
        result_set_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY(session_id, result_set_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pubg_result_sets_expiry ON result_sets(expires_at);

      CREATE TABLE IF NOT EXISTS session_contexts (
        session_id TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        context_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS squad_session_reviews (
        squad_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        match_ids_json TEXT NOT NULL,
        last_match_end_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(squad_id, session_key)
      );

      CREATE TABLE IF NOT EXISTS squad_session_review_meta (
        meta_key TEXT PRIMARY KEY,
        meta_value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_shares (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        squad_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        match_ids_json TEXT NOT NULL,
        presentation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_review_shares_session ON review_shares(squad_id, session_key, created_at);

      CREATE TABLE IF NOT EXISTS migration_runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        report_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  countMatches(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM matches').get();
    return numeric(row?.count);
  }

  getMatch(matchId: string): NormalizedMatch | null {
    const row = this.db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);
    if (!row) return null;
    const players = this.db
      .prepare('SELECT * FROM match_players WHERE match_id = ? ORDER BY account_id')
      .all(matchId)
      .map(rowToPlayer);
    return rowToMatch(row, players);
  }

  listMatches(
    options: { fromMs?: number; toMs?: number; limit?: number; order?: 'asc' | 'desc' } = {},
  ): NormalizedMatch[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.fromMs !== undefined) {
      clauses.push('timestamp_ms >= ?');
      params.push(options.fromMs);
    }
    if (options.toMs !== undefined) {
      clauses.push('timestamp_ms < ?');
      params.push(options.toMs);
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10000), 1), 10000);
    const direction = options.order === 'desc' ? 'DESC' : 'ASC';
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const selectedMatchesSql = `
      SELECT match_id, timestamp_ms
      FROM matches${where}
      ORDER BY timestamp_ms ${direction}, match_id ${direction}
      LIMIT ?
    `;
    const rows = this.db
      .prepare(
        'SELECT * FROM matches' +
          where +
          ` ORDER BY timestamp_ms ${direction}, match_id ${direction} LIMIT ?`,
      )
      .all(...params, limit);
    const players = this.db
      .prepare(
        `
      WITH selected_matches AS (${selectedMatchesSql})
      SELECT player.*
      FROM selected_matches AS selected
      JOIN match_players AS player ON player.match_id = selected.match_id
      ORDER BY selected.timestamp_ms ${direction}, selected.match_id ${direction}, player.account_id ASC
    `,
      )
      .all(...params, limit);
    const byMatch = new Map<string, NormalizedPlayer[]>();
    for (const player of players) {
      const id = String(player.match_id);
      const bucket = byMatch.get(id) ?? [];
      bucket.push(rowToPlayer(player));
      byMatch.set(id, bucket);
    }
    return rows.map((row) => rowToMatch(row, byMatch.get(String(row.match_id)) ?? []));
  }

  upsertMatches(input: unknown[], metadata: MatchWriteMetadata = {}): UpsertMatchesResult {
    const normalizedInputs = input.flatMap((item) => normalizeRecords([item]));
    const records = normalizeRecords(input).filter(
      (match) => match.matchId && Number.isFinite(match.timestamp),
    );
    const duplicateInputs = Math.max(0, normalizedInputs.length - records.length);
    const invalidInputs = Math.max(0, input.length - normalizedInputs.length);
    const unique = records;
    const now = metadata.fetchedAt ?? new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const match of unique) {
        const existing = this.db
          .prepare('SELECT match_id FROM matches WHERE match_id = ?')
          .get(match.matchId);
        this.db
          .prepare(
            `
          INSERT INTO matches (
            match_id, shard, created_at, timestamp_ms, match_type, game_mode,
            is_competitive, map_name, duration, patch_version, telemetry_url,
            schema_version, parser_version, fetched_at, source, checked_player_ids_json, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(match_id) DO UPDATE SET
            shard=excluded.shard, created_at=excluded.created_at, timestamp_ms=excluded.timestamp_ms,
            match_type=excluded.match_type, game_mode=excluded.game_mode,
            is_competitive=excluded.is_competitive, map_name=excluded.map_name,
            duration=excluded.duration, patch_version=excluded.patch_version,
            telemetry_url=excluded.telemetry_url, schema_version=excluded.schema_version,
            parser_version=excluded.parser_version, fetched_at=excluded.fetched_at,
            source=excluded.source, checked_player_ids_json=excluded.checked_player_ids_json,
            raw_json=excluded.raw_json
        `,
          )
          .run(
            match.matchId,
            match.shard,
            match.createdAt,
            match.timestamp,
            match.matchType,
            match.gameMode,
            match.isCompetitive ? 1 : 0,
            match.mapName,
            match.duration,
            match.patchVersion,
            match.telemetryUrl ?? null,
            match.schemaVersion,
            metadata.parserVersion ?? null,
            now,
            metadata.source ?? 'unknown',
            JSON.stringify(
              metadata.checkedPlayerIds ?? match.players.map((player) => player.accountId),
            ),
            metadata.rawJson === undefined ? null : JSON.stringify(metadata.rawJson),
          );
        this.db.prepare('DELETE FROM match_players WHERE match_id = ?').run(match.matchId);
        const playerStatement = this.db.prepare(`
          INSERT INTO match_players (
            match_id, account_id, player_name, display_name, rank, kills, assists,
            damage, dbnos, revives, headshot_kills, survival_time, longest_kill,
            deaths, death_semantics
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const player of match.players) {
          playerStatement.run(
            match.matchId,
            player.accountId,
            player.playerName,
            player.displayName,
            player.rank,
            player.kills,
            player.assists,
            player.damage,
            player.dbnos,
            player.revives,
            player.headshotKills,
            player.survivalTime,
            player.longestKill,
            player.deaths,
            player.deathSemantics,
          );
        }
        if (existing) updated += 1;
        else inserted += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { inserted, updated, duplicateInputs, invalidInputs };
  }

  setSyncState(state: SyncState): void {
    this.db
      .prepare(
        `
      INSERT INTO sync_state(state_key, checked_at, state_json) VALUES (?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET checked_at=excluded.checked_at, state_json=excluded.state_json
    `,
      )
      .run(state.key, state.checkedAt, JSON.stringify(state));
  }

  getSyncState(key: string): SyncState | null {
    const row = this.db.prepare('SELECT state_json FROM sync_state WHERE state_key = ?').get(key);
    return row ? jsonValue<SyncState | null>(row.state_json, null) : null;
  }

  async get(key: TelemetryFeatureKey): Promise<TelemetryFeatureRecord | null> {
    const row = this.db
      .prepare(
        `
      SELECT facts_json, created_at FROM telemetry_features
      WHERE match_id = ? AND parser_version = ? AND feature_version = ?
    `,
      )
      .get(key.matchId, key.parserVersion, key.featureVersion);
    if (!row) return null;
    const facts = jsonValue<unknown>(row.facts_json, null);
    if (!facts || typeof facts !== 'object') return null;
    return {
      ...key,
      facts: facts as TelemetryFeatureRecord['facts'],
      createdAt: String(row.created_at),
    };
  }

  async set(record: TelemetryFeatureRecord): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO telemetry_features(match_id, parser_version, feature_version, facts_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(match_id, parser_version, feature_version) DO UPDATE SET
        facts_json=excluded.facts_json, created_at=excluded.created_at
    `,
      )
      .run(
        record.matchId,
        record.parserVersion,
        record.featureVersion,
        JSON.stringify(record.facts),
        record.createdAt,
      );
  }

  getTelemetryPrefetchAttempt(key: TelemetryFeatureKey): TelemetryPrefetchAttempt | null {
    const row = this.db
      .prepare(
        `
      SELECT match_id, parser_version, feature_version, status, attempt_count,
        last_attempted_at, next_retry_at, error, updated_at
      FROM telemetry_prefetch_attempts
      WHERE match_id = ? AND parser_version = ? AND feature_version = ?
    `,
      )
      .get(key.matchId, key.parserVersion, key.featureVersion);
    if (!row) return null;
    return {
      matchId: String(row.match_id),
      parserVersion: String(row.parser_version),
      featureVersion: String(row.feature_version),
      status: String(row.status) as TelemetryPrefetchAttemptStatus,
      attemptCount: numeric(row.attempt_count),
      lastAttemptedAt: row.last_attempted_at ? String(row.last_attempted_at) : null,
      nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : null,
      ...(row.error ? { error: String(row.error) } : {}),
      updatedAt: String(row.updated_at),
    };
  }

  listDueTelemetryPrefetchAttempts(
    parserVersion: string,
    featureVersion: string,
    now: Date,
    limit = 100,
  ): TelemetryPrefetchAttempt[] {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    const rows = this.db
      .prepare(
        `
      SELECT match_id, parser_version, feature_version, status, attempt_count,
        last_attempted_at, next_retry_at, error, updated_at
      FROM telemetry_prefetch_attempts
      WHERE parser_version = ? AND feature_version = ?
        AND status IN ('PENDING', 'UNAVAILABLE')
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY COALESCE(next_retry_at, '') ASC, updated_at ASC, match_id ASC
      LIMIT ?
    `,
      )
      .all(parserVersion, featureVersion, now.toISOString(), boundedLimit);
    return rows.map((row) => ({
      matchId: String(row.match_id),
      parserVersion: String(row.parser_version),
      featureVersion: String(row.feature_version),
      status: String(row.status) as TelemetryPrefetchAttemptStatus,
      attemptCount: numeric(row.attempt_count),
      lastAttemptedAt: row.last_attempted_at ? String(row.last_attempted_at) : null,
      nextRetryAt: row.next_retry_at ? String(row.next_retry_at) : null,
      ...(row.error ? { error: String(row.error) } : {}),
      updatedAt: String(row.updated_at),
    }));
  }

  setTelemetryPrefetchAttempt(attempt: TelemetryPrefetchAttempt): void {
    this.db
      .prepare(
        `
      INSERT INTO telemetry_prefetch_attempts(
        match_id, parser_version, feature_version, status, attempt_count,
        last_attempted_at, next_retry_at, error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id, parser_version, feature_version) DO UPDATE SET
        status=excluded.status, attempt_count=excluded.attempt_count,
        last_attempted_at=excluded.last_attempted_at, next_retry_at=excluded.next_retry_at,
        error=excluded.error, updated_at=excluded.updated_at
    `,
      )
      .run(
        attempt.matchId,
        attempt.parserVersion,
        attempt.featureVersion,
        attempt.status,
        attempt.attemptCount,
        attempt.lastAttemptedAt,
        attempt.nextRetryAt,
        attempt.error ?? null,
        attempt.updatedAt,
      );
  }

  recordTelemetryPrefetchRun(run: TelemetryPrefetchRun): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO telemetry_prefetch_runs(
        run_id, report_date, started_at, finished_at, trigger,
        discovered_match_count, new_match_count, candidate_match_count,
        fetched_count, cache_hit_count, unavailable_count, pending_count,
        failed_match_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        run.runId,
        run.reportDate,
        run.startedAt,
        run.finishedAt,
        run.trigger,
        run.discoveredMatchCount,
        run.newMatchCount,
        run.candidateMatchCount,
        run.fetchedCount,
        run.cacheHitCount,
        run.unavailableCount,
        run.pendingCount,
        JSON.stringify([...new Set(run.failedMatchIds)]),
      );
  }

  listTelemetryPrefetchRuns(reportDate: string): TelemetryPrefetchRun[] {
    const rows = this.db
      .prepare(
        `
      SELECT run_id, report_date, started_at, finished_at, trigger,
        discovered_match_count, new_match_count, candidate_match_count,
        fetched_count, cache_hit_count, unavailable_count, pending_count,
        failed_match_ids_json
      FROM telemetry_prefetch_runs
      WHERE report_date = ?
      ORDER BY started_at ASC, run_id ASC
    `,
      )
      .all(reportDate);
    return rows.map((row) => ({
      runId: String(row.run_id),
      reportDate: String(row.report_date),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      trigger: String(row.trigger) as TelemetryPrefetchRun['trigger'],
      discoveredMatchCount: numeric(row.discovered_match_count),
      newMatchCount: numeric(row.new_match_count),
      candidateMatchCount: numeric(row.candidate_match_count),
      fetchedCount: numeric(row.fetched_count),
      cacheHitCount: numeric(row.cache_hit_count),
      unavailableCount: numeric(row.unavailable_count),
      pendingCount: numeric(row.pending_count),
      failedMatchIds: jsonValue<string[]>(row.failed_match_ids_json, []),
    }));
  }

  getSessionReview(squadId: string, sessionKey: string): SessionReviewRecord | null {
    const row = this.db
      .prepare(
        `
      SELECT squad_id, session_key, match_ids_json, last_match_end_ms, status, detail, message, attempts, updated_at
      FROM squad_session_reviews WHERE squad_id = ? AND session_key = ?
    `,
      )
      .get(squadId, sessionKey);
    if (!row) return null;
    return {
      squadId: String(row.squad_id),
      sessionKey: String(row.session_key),
      matchIds: jsonValue<string[]>(row.match_ids_json, []),
      lastMatchEndMs: numeric(row.last_match_end_ms),
      status: String(row.status) as SessionReviewStatus,
      detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
      message: row.message === null || row.message === undefined ? null : String(row.message),
      attempts: numeric(row.attempts),
      updatedAt: String(row.updated_at),
    };
  }

  putSessionReview(record: SessionReviewRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO squad_session_reviews(squad_id, session_key, match_ids_json, last_match_end_ms, status, detail, message, attempts, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(squad_id, session_key) DO UPDATE SET
        match_ids_json = excluded.match_ids_json, last_match_end_ms = excluded.last_match_end_ms, status = excluded.status,
        detail = excluded.detail, message = excluded.message, attempts = excluded.attempts, updated_at = excluded.updated_at
    `,
      )
      .run(
        record.squadId,
        record.sessionKey,
        JSON.stringify(record.matchIds),
        record.lastMatchEndMs,
        record.status,
        record.detail,
        record.message,
        record.attempts,
        record.updatedAt,
      );
  }

  getSessionReviewMeta(key: string): string | null {
    const row = this.db
      .prepare('SELECT meta_value FROM squad_session_review_meta WHERE meta_key = ?')
      .get(key);
    return row ? String(row.meta_value) : null;
  }

  setSessionReviewMeta(key: string, value: string): void {
    this.db
      .prepare(
        `
      INSERT INTO squad_session_review_meta(meta_key, meta_value) VALUES (?, ?)
      ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value
    `,
      )
      .run(key, value);
  }

  putReviewShare(record: ReviewShareRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO review_shares(token_hash, kind, squad_id, session_key, match_ids_json, presentation_json, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        record.tokenHash,
        record.kind,
        record.squadId,
        record.sessionKey,
        JSON.stringify(record.matchIds),
        record.presentationJson,
        record.createdAt,
        record.expiresAt,
        record.revokedAt,
      );
  }

  getReviewShare(tokenHash: string): ReviewShareRecord | null {
    const row = this.db.prepare('SELECT * FROM review_shares WHERE token_hash = ?').get(tokenHash);
    return row ? shareRecord(row) : null;
  }

  latestReviewShare(squadId: string, sessionKey: string): ReviewShareRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM review_shares WHERE squad_id = ? AND session_key = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(squadId, sessionKey);
    return row ? shareRecord(row) : null;
  }

  revokeReviewShares(squadId: string, sessionKey: string, revokedAt: string): number {
    return Number(
      this.db
        .prepare(
          'UPDATE review_shares SET revoked_at = ? WHERE squad_id = ? AND session_key = ? AND revoked_at IS NULL',
        )
        .run(revokedAt, squadId, sessionKey).changes,
    );
  }

  /** Every stored share, for readers of a database copy (the Intelligence Lab snapshot). */
  listReviewShares(): ReviewShareRecord[] {
    try {
      return this.db.prepare('SELECT * FROM review_shares').all().map(shareRecord);
    } catch {
      // A read-only copy made before the table existed.
      return [];
    }
  }

  latestPrefetchFinishedMs(): number | null {
    const row = this.db
      .prepare('SELECT MAX(finished_at) AS finished_at FROM telemetry_prefetch_runs')
      .get();
    const parsed = row?.finished_at ? Date.parse(String(row.finished_at)) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }

  setResultSet(result: ResultSetRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO result_sets(session_id, result_set_id, expires_at, result_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, result_set_id) DO UPDATE SET
        expires_at=excluded.expires_at, result_json=excluded.result_json
    `,
      )
      .run(result.sessionId, result.id, result.expiresAt, JSON.stringify(result));
  }

  getResultSet(sessionId: string, resultSetId: string, now = new Date()): ResultSetRecord | null {
    const row = this.db
      .prepare(
        'SELECT expires_at, result_json FROM result_sets WHERE session_id = ? AND result_set_id = ?',
      )
      .get(sessionId, resultSetId);
    if (!row || Date.parse(String(row.expires_at)) <= now.getTime()) return null;
    return jsonValue<ResultSetRecord | null>(row.result_json, null);
  }

  setContext(context: SessionContextRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO session_contexts(session_id, expires_at, context_json)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        expires_at=excluded.expires_at, context_json=excluded.context_json
    `,
      )
      .run(context.sessionId, context.expiresAt, JSON.stringify(context));
  }

  getContext(sessionId: string, now = new Date()): SessionContextRecord | null {
    const row = this.db
      .prepare('SELECT expires_at, context_json FROM session_contexts WHERE session_id = ?')
      .get(sessionId);
    if (!row || Date.parse(String(row.expires_at)) <= now.getTime()) return null;
    return jsonValue<SessionContextRecord | null>(row.context_json, null);
  }

  cleanupExpired(now = new Date()): void {
    const iso = now.toISOString();
    this.db.prepare('DELETE FROM result_sets WHERE expires_at <= ?').run(iso);
    this.db.prepare('DELETE FROM session_contexts WHERE expires_at <= ?').run(iso);
  }

  recordMigration(
    id: string,
    source: string,
    report: unknown,
    startedAt: string,
    finishedAt: string,
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO migration_runs(id, source, started_at, finished_at, report_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, source, startedAt, finishedAt, JSON.stringify(report));
  }

  getMigration(id: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM migration_runs WHERE id = ?').get(id);
    return row ?? null;
  }

  snapshot(): {
    matches: number;
    players: number;
    features: number;
    resultSets: number;
    contexts: number;
    prefetchAttempts: number;
    prefetchRuns: number;
  } {
    const count = (table: string): number =>
      numeric(this.db.prepare('SELECT COUNT(*) AS count FROM ' + table).get()?.count);
    return {
      matches: count('matches'),
      players: count('match_players'),
      features: count('telemetry_features'),
      resultSets: count('result_sets'),
      contexts: count('session_contexts'),
      prefetchAttempts: count('telemetry_prefetch_attempts'),
      prefetchRuns: count('telemetry_prefetch_runs'),
    };
  }
}

function shareRecord(row: Record<string, unknown>): ReviewShareRecord {
  return {
    tokenHash: String(row.token_hash),
    kind:
      String(row.kind) === 'match' ? 'match' : String(row.kind) === 'query' ? 'query' : 'session',
    squadId: String(row.squad_id),
    sessionKey: String(row.session_key),
    matchIds: jsonValue<string[]>(row.match_ids_json, []),
    presentationJson: String(row.presentation_json),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    revokedAt:
      row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
  };
}
