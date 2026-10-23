import type {
  NormalizedMatch,
  NormalizedPlayer,
  ResultSetRecord,
  SessionContextRecord,
  TeamContext,
  TelemetryFeatureKey,
  TelemetryFeatureRecord,
  TelemetryPrefetchAttempt,
  TelemetryPrefetchAttemptStatus,
  TelemetryPrefetchRun,
  PubgRepositoryPort,
  SyncState,
  UpsertMatchesResult,
  MatchWriteMetadata,
} from '@rine-kit/pubg-domain/core';
import { normalizeRecords, parseTeamContext } from '@rine-kit/pubg-domain/core';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createHash } from 'node:crypto';
import { parseStoredTeamLeaderboardMetric, type TeamLeaderboardMetric } from './contracts/team-preferences.js';

/** Who is asking, where, and in which server-created session. The host decides what these mean
 * (RINE: the signed-in user, the room, a session it issued); never copy them from a model/tool argument. */
export interface TrustedConversationScope {
  /** Host-defined kind of conversation (e.g. "room", "direct"); only the host's authorize() reads it. */
  kind: string;
  actorId: string;
  channelId: string;
  /** Server-derived opaque ID; never copy this from a model/tool argument. */
  sessionId: string;
}

/** Runs inside every scoped transaction after the team check, on the same connection. It must throw to
 * deny. Take row locks (FOR SHARE) on whatever grants access, so a revoke either commits before the read
 * (and is rejected) or after it completes. */
export type ConversationAuthorizer = (
  client: PoolClient,
  scope: { tenantId: string; teamId: string; teamRevision: number; conversation: TrustedConversationScope },
) => Promise<void>;

export interface PostgresPubgRepositoryOptions {
  /** A conversation scope is mandatory (public query runtime). */
  requireConversation?: boolean;
  /** Host check that the conversation may read this team now; see ConversationAuthorizer. */
  authorize?: ConversationAuthorizer;
}

export interface PublicModelUsageRecord {
  requestId: string;
  provider: string;
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`invalid_${name}`);
  return normalized;
}

function teamConfigHash(team: TeamContext['team']): string {
  const canonical = {
    id: team.id,
    label: team.label,
    platform: team.platform,
    players: [...team.players]
      .map(player => ({ id: player.id, name: player.name, aliases: [...player.aliases].sort() }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function objectValue<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value === null || value === undefined ? fallback : value as T;
}

function rowToPlayer(row: QueryResultRow): NormalizedPlayer {
  return {
    accountId: String(row.account_id),
    playerName: String(row.player_name ?? row.account_id),
    displayName: String(row.display_name ?? row.player_name ?? row.account_id),
    rank: nullableNumber(row.rank),
    kills: number(row.kills),
    assists: number(row.assists),
    damage: number(row.damage),
    dbnos: number(row.dbnos),
    revives: number(row.revives),
    headshotKills: number(row.headshot_kills),
    survivalTime: number(row.survival_time),
    longestKill: number(row.longest_kill),
    deaths: nullableNumber(row.deaths),
    deathSemantics: String(row.death_semantics ?? 'unknown') as NormalizedPlayer['deathSemantics'],
  };
}

function rowToMatch(row: QueryResultRow, players: NormalizedPlayer[]): NormalizedMatch {
  return {
    schemaVersion: number(row.schema_version, 3),
    matchId: String(row.match_id),
    shard: String(row.shard ?? 'steam'),
    createdAt: row.created_at === null || row.created_at === undefined ? null : String(row.created_at),
    timestamp: number(row.timestamp_ms),
    matchType: String(row.match_type ?? ''),
    gameMode: String(row.game_mode ?? ''),
    isCompetitive: boolean(row.is_competitive),
    mapName: String(row.map_name ?? ''),
    duration: number(row.duration),
    patchVersion: String(row.patch_version ?? ''),
    players,
    telemetryUrl: row.telemetry_url ? String(row.telemetry_url) : null,
  };
}

function runFromRow(row: QueryResultRow): TelemetryPrefetchRun {
  return {
    runId: String(row.run_id),
    reportDate: String(row.report_date),
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: new Date(row.finished_at).toISOString(),
    trigger: String(row.trigger) as TelemetryPrefetchRun['trigger'],
    discoveredMatchCount: number(row.discovered_match_count),
    newMatchCount: number(row.new_match_count),
    candidateMatchCount: number(row.candidate_match_count),
    fetchedCount: number(row.fetched_count),
    cacheHitCount: number(row.cache_hit_count),
    unavailableCount: number(row.unavailable_count),
    pendingCount: number(row.pending_count),
    failedMatchIds: objectValue<string[]>(row.failed_match_ids_json, []),
  };
}

function attemptFromRow(row: QueryResultRow): TelemetryPrefetchAttempt {
  return {
    matchId: String(row.match_id),
    parserVersion: String(row.parser_version),
    featureVersion: String(row.feature_version),
    status: String(row.status) as TelemetryPrefetchAttemptStatus,
    attemptCount: number(row.attempt_count),
    lastAttemptedAt: row.last_attempted_at ? new Date(row.last_attempted_at).toISOString() : null,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at).toISOString() : null,
    ...(row.error ? { error: String(row.error) } : {}),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await action(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** PostgreSQL implementation of the PUBG repository port. Its team and optional
 * conversation scopes are fixed from server-verified authorization state. */
export class PostgresPubgRepository implements PubgRepositoryPort {
  readonly store = 'postgres';
  readonly scope: TeamContext;
  readonly conversation: TrustedConversationScope | null;
  private readonly accountIds: string[];
  private readonly shard: string;
  private readonly teamConfigHash: string;

  constructor(
    private readonly pool: Pool,
    scope: TeamContext,
    conversation: TrustedConversationScope | null = null,
    private readonly options: PostgresPubgRepositoryOptions = {},
  ) {
    if (options.requireConversation && !conversation) throw new Error('conversation_scope_required');
    this.scope = parseTeamContext(scope);
    this.shard = this.scope.team.platform;
    this.accountIds = this.scope.team.players.map((player) => player.id);
    this.teamConfigHash = teamConfigHash(this.scope.team);
    this.conversation = conversation ? {
      kind: requiredText(conversation.kind, 'conversation_kind'),
      actorId: requiredText(conversation.actorId, 'actor_id'),
      channelId: requiredText(conversation.channelId, 'channel_id'),
      sessionId: requiredText(conversation.sessionId, 'session_id'),
    } : null;
  }

  private async assertTeamScope(client: PoolClient): Promise<void> {
    const result = await client.query(
      `SELECT team.pubg_shard,COALESCE(array_agg(member.pubg_account_id ORDER BY member.pubg_account_id)
       FILTER (WHERE member.pubg_account_id IS NOT NULL),'{}') AS accounts
       FROM pubg_teams team LEFT JOIN pubg_team_members member ON member.tenant_id=team.tenant_id AND member.team_id=team.team_id
       WHERE team.tenant_id=$1 AND team.team_id=$2 GROUP BY team.pubg_shard`, [this.scope.tenantId, this.scope.teamId],
    );
    const row = result.rows[0];
    if (!row || row.pubg_shard !== this.shard || !Array.isArray(row.accounts)
      || row.accounts.length !== this.accountIds.length || row.accounts.some((account: unknown) => !this.accountIds.includes(String(account)))) throw new Error('repository_team_scope_mismatch');
  }

  private async assertReadScope(client: PoolClient): Promise<void> {
    await this.assertTeamScope(client);
    if (this.conversation) await this.assertConversation(this.conversation.sessionId, client);
  }

  private async assertConversation(sessionId: string, client: PoolClient): Promise<TrustedConversationScope> {
    await this.assertTeamScope(client);
    const trusted = this.conversation;
    if (!trusted) throw new Error('conversation_scope_required');
    if (sessionId !== trusted.sessionId) throw new Error('conversation_scope_mismatch');
    if (this.options.authorize) {
      const team = await client.query(
        'SELECT query_revision FROM pubg_teams WHERE tenant_id=$1 AND team_id=$2',
        [this.scope.tenantId, this.scope.teamId],
      );
      await this.options.authorize(client, {
        tenantId: this.scope.tenantId,
        teamId: this.scope.teamId,
        teamRevision: number(team.rows[0]?.query_revision),
        conversation: trusted,
      });
    }
    return trusted;
  }

  /** Lock the team revision and conversation authority until the bounded read
   * finishes. Roster/admin triggers update teams.query_revision, so a revoke
   * either commits before this read (and is rejected) or after it completes. */
  private async withReadScope<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async client => {
      const team = await client.query(
        'SELECT query_revision FROM pubg_teams WHERE tenant_id=$1 AND team_id=$2 FOR SHARE',
        [this.scope.tenantId, this.scope.teamId],
      );
      if (!team.rowCount) throw new Error('repository_team_scope_mismatch');
      await this.assertReadScope(client);
      return action(client);
    });
  }

  private async verifyScope(): Promise<void> {
    await this.withReadScope(async () => undefined);
  }

  async getLeaderboardMetricPreference(): Promise<TeamLeaderboardMetric | null> {
    return this.withReadScope(async client => {
      const result = await client.query(
        `SELECT preference_json FROM pubg_team_preferences
         WHERE tenant_id=$1 AND team_id=$2 AND preference_key='leaderboard_metric'`,
        [this.scope.tenantId, this.scope.team.id],
      );
      return parseStoredTeamLeaderboardMetric(result.rows[0]?.preference_json);
    });
  }

  private async withConversationScope<T>(
    sessionId: string,
    action: (client: PoolClient, conversation: TrustedConversationScope) => Promise<T>,
  ): Promise<T> {
    return this.withReadScope(async client => action(client, await this.assertConversation(sessionId, client)));
  }

  private async matchVisible(client: PoolClient, matchId: string): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM pubg_matches AS match WHERE match.match_id=$1 AND match.shard=$3 AND EXISTS (
         SELECT 1 FROM pubg_match_players AS member WHERE member.shard=match.shard AND member.match_id=match.match_id
           AND member.account_id=ANY($2::TEXT[])
       )`, [matchId, this.accountIds, this.shard],
    );
    return result.rowCount === 1;
  }

  async countMatches(): Promise<number> {
    return this.withReadScope(async client => {
      const result = await client.query(
        `SELECT COUNT(*)::bigint AS count FROM pubg_matches AS match
         WHERE match.shard=$2 AND EXISTS (
           SELECT 1 FROM pubg_match_players AS member
           WHERE member.shard=match.shard AND member.match_id = match.match_id AND member.account_id = ANY($1::text[])
         )`,
        [this.accountIds, this.shard],
      );
      return number(result.rows[0]?.count);
    });
  }

  async getMatch(matchId: string): Promise<NormalizedMatch | null> {
    return this.withReadScope(async client => {
      const result = await client.query(
        `SELECT match.* FROM pubg_matches AS match
         WHERE match.match_id = $1 AND match.shard=$3 AND EXISTS (
           SELECT 1 FROM pubg_match_players AS member
           WHERE member.shard=match.shard AND member.match_id = match.match_id AND member.account_id = ANY($2::text[])
         )`,
        [matchId, this.accountIds, this.shard],
      );
      const row = result.rows[0];
      if (!row) return null;
      const players = await client.query(
        'SELECT * FROM pubg_match_players WHERE match_id = $1 AND shard=$2 AND account_id=ANY($3::text[]) ORDER BY account_id',
        [matchId, this.shard, this.accountIds],
      );
      return rowToMatch(row, players.rows.map(rowToPlayer));
    });
  }

  async listMatches(options: { fromMs?: number; toMs?: number; limit?: number } = {}): Promise<NormalizedMatch[]> {
    return this.withReadScope(async client => {
      const clauses = ['match.shard=$2', 'EXISTS (SELECT 1 FROM pubg_match_players AS member WHERE member.shard=match.shard AND member.match_id = match.match_id AND member.account_id = ANY($1::text[]))'];
      const values: unknown[] = [this.accountIds, this.shard];
      if (options.fromMs !== undefined) { values.push(options.fromMs); clauses.push(`match.timestamp_ms >= $${values.length}`); }
      if (options.toMs !== undefined) { values.push(options.toMs); clauses.push(`match.timestamp_ms < $${values.length}`); }
      const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10000), 1), 10000);
      values.push(limit);
      const selected = await client.query(
        `SELECT match.* FROM pubg_matches AS match WHERE ${clauses.join(' AND ')}
         ORDER BY match.timestamp_ms ASC, match.match_id ASC LIMIT $${values.length}`,
        values,
      );
      if (!selected.rowCount) return [];
      const matchIds = selected.rows.map((row) => String(row.match_id));
      const players = await client.query(
        `SELECT player.*, selected.timestamp_ms AS selected_timestamp
         FROM unnest($1::text[]) AS chosen(match_id)
         JOIN pubg_matches AS selected ON selected.match_id = chosen.match_id AND selected.shard=$2
         JOIN pubg_match_players AS player ON player.match_id = selected.match_id AND player.shard=selected.shard AND player.account_id=ANY($3::text[])
         ORDER BY selected.timestamp_ms ASC, selected.match_id ASC, player.account_id ASC`,
        [matchIds, this.shard, this.accountIds],
      );
      const byMatch = new Map<string, NormalizedPlayer[]>();
      for (const player of players.rows) {
        const id = String(player.match_id);
        const group = byMatch.get(id) ?? [];
        group.push(rowToPlayer(player));
        byMatch.set(id, group);
      }
      return selected.rows.map((row) => rowToMatch(row, byMatch.get(String(row.match_id)) ?? []));
    });
  }

  async upsertMatches(input: unknown[], metadata: MatchWriteMetadata = {}): Promise<UpsertMatchesResult> {
    await this.verifyScope();
    const individuallyNormalized = input.flatMap((item) => normalizeRecords([item]));
    if (individuallyNormalized.some(match => match.shard !== this.shard)) throw new Error('repository_shard_mismatch');
    const records = normalizeRecords(input).filter((match) => match.matchId && Number.isFinite(match.timestamp));
    const duplicateInputs = Math.max(0, individuallyNormalized.length - records.length);
    const invalidInputs = Math.max(0, input.length - individuallyNormalized.length);
    const fetchedAt = metadata.fetchedAt ?? new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    await withTransaction(this.pool, async (client) => {
      for (const match of records) {
        const prior = await client.query('SELECT 1 FROM pubg_matches WHERE match_id = $1 AND shard=$2', [match.matchId, this.shard]);
        await client.query(
          `INSERT INTO pubg_matches (
             match_id, shard, created_at, timestamp_ms, match_type, game_mode, is_competitive,
             map_name, duration, patch_version, telemetry_url, schema_version, parser_version,
             fetched_at, source, checked_player_ids_json, raw_json
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb)
           ON CONFLICT (shard,match_id) DO UPDATE SET
             shard=EXCLUDED.shard, created_at=EXCLUDED.created_at, timestamp_ms=EXCLUDED.timestamp_ms,
             match_type=EXCLUDED.match_type, game_mode=EXCLUDED.game_mode,
             is_competitive=EXCLUDED.is_competitive, map_name=EXCLUDED.map_name,
             duration=EXCLUDED.duration, patch_version=EXCLUDED.patch_version,
             telemetry_url=EXCLUDED.telemetry_url, schema_version=EXCLUDED.schema_version,
             parser_version=EXCLUDED.parser_version, fetched_at=EXCLUDED.fetched_at,
             source=EXCLUDED.source, checked_player_ids_json=EXCLUDED.checked_player_ids_json,
             raw_json=EXCLUDED.raw_json`,
          [match.matchId, match.shard, match.createdAt, match.timestamp, match.matchType, match.gameMode,
          match.isCompetitive, match.mapName, match.duration, match.patchVersion, match.telemetryUrl ?? null,
          match.schemaVersion, metadata.parserVersion ?? null, fetchedAt, metadata.source ?? 'unknown',
          JSON.stringify(metadata.checkedPlayerIds ?? match.players.map((player) => player.accountId)),
          metadata.rawJson === undefined ? null : JSON.stringify(metadata.rawJson)],
        );
        for (const player of match.players) {
          await client.query(
            `INSERT INTO pubg_match_players (
              match_id, account_id, player_name, display_name, rank, kills, assists, damage,
              dbnos, revives, headshot_kills, survival_time, longest_kill, deaths, death_semantics,shard
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
            ON CONFLICT (shard,match_id,account_id) DO UPDATE SET
              player_name=EXCLUDED.player_name, display_name=EXCLUDED.display_name, rank=EXCLUDED.rank,
              kills=EXCLUDED.kills, assists=EXCLUDED.assists, damage=EXCLUDED.damage, dbnos=EXCLUDED.dbnos,
              revives=EXCLUDED.revives, headshot_kills=EXCLUDED.headshot_kills, survival_time=EXCLUDED.survival_time,
              longest_kill=EXCLUDED.longest_kill, deaths=EXCLUDED.deaths, death_semantics=EXCLUDED.death_semantics`,
            [match.matchId, player.accountId, player.playerName, player.displayName, player.rank,
            player.kills, player.assists, player.damage, player.dbnos, player.revives,
            player.headshotKills, player.survivalTime, player.longestKill, player.deaths, player.deathSemantics, this.shard],
          );
        }
        if (prior.rowCount) updated += 1;
        else inserted += 1;
      }
    });
    return { inserted, updated, duplicateInputs, invalidInputs };
  }

  async setSyncState(state: SyncState): Promise<void> {
    await this.withReadScope(async client => client.query(
      `INSERT INTO pubg_sync_state(tenant_id, team_id, state_key, checked_at, state_json)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (tenant_id, team_id, state_key) DO UPDATE
       SET checked_at=EXCLUDED.checked_at, state_json=EXCLUDED.state_json`,
      [this.scope.tenantId, this.scope.teamId, state.key, state.checkedAt, JSON.stringify(state)],
    ).then(() => undefined));
  }

  async getSyncState(key: string): Promise<SyncState | null> {
    return this.withReadScope(async client => {
      const result = await client.query(
        'SELECT state_json FROM pubg_sync_state WHERE tenant_id=$1 AND team_id=$2 AND state_key=$3',
        [this.scope.tenantId, this.scope.teamId, key],
      );
      return result.rows[0] ? objectValue<SyncState | null>(result.rows[0].state_json, null) : null;
    });
  }

  async get(key: TelemetryFeatureKey): Promise<TelemetryFeatureRecord | null> {
    return this.withReadScope(async client => {
      if (!await this.matchVisible(client, key.matchId)) return null;
      const result = await client.query(
        `SELECT facts_json, created_at FROM pubg_telemetry_team_features
         WHERE tenant_id=$1 AND team_id=$2 AND team_config_hash=$3 AND match_id=$4
           AND parser_version=$5 AND feature_version=$6 AND shard=$7`,
        [this.scope.tenantId, this.scope.teamId, this.teamConfigHash, key.matchId, key.parserVersion, key.featureVersion, this.shard],
      );
      const row = result.rows[0];
      if (!row) return null;
      const facts = objectValue<unknown>(row.facts_json, null);
      if (!facts || typeof facts !== 'object') return null;
      return { ...key, facts: facts as TelemetryFeatureRecord['facts'], createdAt: new Date(row.created_at).toISOString() };
    });
  }

  async set(record: TelemetryFeatureRecord): Promise<void> {
    await this.withReadScope(async client => {
      if (!await this.matchVisible(client, record.matchId)) throw new Error('telemetry_match_not_in_team');
      await client.query(
        `INSERT INTO pubg_telemetry_team_features(tenant_id,team_id,team_config_hash,match_id,parser_version,feature_version,facts_json,created_at,shard)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
         ON CONFLICT (tenant_id,team_id,team_config_hash,shard,match_id,parser_version,feature_version) DO UPDATE
         SET facts_json=EXCLUDED.facts_json, created_at=EXCLUDED.created_at`,
        [this.scope.tenantId, this.scope.teamId, this.teamConfigHash, record.matchId, record.parserVersion, record.featureVersion, JSON.stringify(record.facts), record.createdAt, this.shard],
      );
    });
  }

  async getTelemetryPrefetchAttempt(key: TelemetryFeatureKey): Promise<TelemetryPrefetchAttempt | null> {
    return this.withReadScope(async client => {
      if (!await this.matchVisible(client, key.matchId)) return null;
      const result = await client.query(
        `SELECT * FROM pubg_telemetry_team_prefetch_attempts
         WHERE tenant_id=$1 AND team_id=$2 AND team_config_hash=$3 AND match_id=$4
           AND parser_version=$5 AND feature_version=$6 AND shard=$7`,
        [this.scope.tenantId, this.scope.teamId, this.teamConfigHash, key.matchId, key.parserVersion, key.featureVersion, this.shard],
      );
      return result.rows[0] ? attemptFromRow(result.rows[0]) : null;
    });
  }

  async listDueTelemetryPrefetchAttempts(parserVersion: string, featureVersion: string, now: Date, limit = 100): Promise<TelemetryPrefetchAttempt[]> {
    return this.withReadScope(async client => {
      const bounded = Math.min(Math.max(Math.trunc(limit), 1), 1000);
      const result = await client.query(
        `SELECT attempt.* FROM pubg_telemetry_team_prefetch_attempts attempt
         WHERE tenant_id=$1 AND team_id=$2 AND team_config_hash=$3 AND parser_version=$4 AND feature_version=$5 AND attempt.shard=$8
           AND EXISTS (SELECT 1 FROM pubg_match_players member WHERE member.shard=attempt.shard AND member.match_id=attempt.match_id AND member.account_id=ANY($7::TEXT[]))
           AND status IN ('PENDING','UNAVAILABLE') AND (next_retry_at IS NULL OR next_retry_at <= $9)
         ORDER BY COALESCE(next_retry_at, '-infinity'::timestamptz), updated_at, match_id
         LIMIT $6`,
        [this.scope.tenantId, this.scope.teamId, this.teamConfigHash, parserVersion, featureVersion, bounded, this.accountIds, this.shard, now],
      );
      return result.rows.map(attemptFromRow);
    });
  }

  async setTelemetryPrefetchAttempt(attempt: TelemetryPrefetchAttempt): Promise<void> {
    await this.withReadScope(async client => {
      if (!await this.matchVisible(client, attempt.matchId)) throw new Error('telemetry_match_not_in_team');
      await client.query(
        `INSERT INTO pubg_telemetry_team_prefetch_attempts(
           tenant_id,team_id,team_config_hash,shard,match_id,parser_version,feature_version,status,attempt_count,
           last_attempted_at, next_retry_at, error, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tenant_id,team_id,team_config_hash,shard,match_id,parser_version,feature_version) DO UPDATE SET
           status=EXCLUDED.status, attempt_count=EXCLUDED.attempt_count,
           last_attempted_at=EXCLUDED.last_attempted_at, next_retry_at=EXCLUDED.next_retry_at,
           error=EXCLUDED.error, updated_at=EXCLUDED.updated_at`,
        [this.scope.tenantId, this.scope.teamId, this.teamConfigHash, this.shard, attempt.matchId, attempt.parserVersion, attempt.featureVersion, attempt.status,
        attempt.attemptCount, attempt.lastAttemptedAt, attempt.nextRetryAt, attempt.error ?? null, attempt.updatedAt],
      );
    });
  }

  async recordTelemetryPrefetchRun(run: TelemetryPrefetchRun): Promise<void> {
    await this.withReadScope(async client => client.query(
      `INSERT INTO pubg_telemetry_prefetch_runs(
         tenant_id, team_id, run_id, report_date, started_at, finished_at, trigger,
         discovered_match_count, new_match_count, candidate_match_count, fetched_count,
         cache_hit_count, unavailable_count, pending_count, failed_match_ids_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
       ON CONFLICT (tenant_id, team_id, run_id) DO UPDATE SET
         report_date=EXCLUDED.report_date, started_at=EXCLUDED.started_at,
         finished_at=EXCLUDED.finished_at, trigger=EXCLUDED.trigger,
         discovered_match_count=EXCLUDED.discovered_match_count, new_match_count=EXCLUDED.new_match_count,
         candidate_match_count=EXCLUDED.candidate_match_count, fetched_count=EXCLUDED.fetched_count,
         cache_hit_count=EXCLUDED.cache_hit_count, unavailable_count=EXCLUDED.unavailable_count,
         pending_count=EXCLUDED.pending_count, failed_match_ids_json=EXCLUDED.failed_match_ids_json`,
      [this.scope.tenantId, this.scope.teamId, run.runId, run.reportDate, run.startedAt, run.finishedAt,
      run.trigger, run.discoveredMatchCount, run.newMatchCount, run.candidateMatchCount,
      run.fetchedCount, run.cacheHitCount, run.unavailableCount, run.pendingCount,
      JSON.stringify([...new Set(run.failedMatchIds)])],
    ).then(() => undefined));
  }

  async listTelemetryPrefetchRuns(reportDate: string): Promise<TelemetryPrefetchRun[]> {
    return this.withReadScope(async client => {
      const result = await client.query(
        `SELECT * FROM pubg_telemetry_prefetch_runs
         WHERE tenant_id=$1 AND team_id=$2 AND report_date=$3 ORDER BY started_at, run_id`,
        [this.scope.tenantId, this.scope.teamId, reportDate],
      );
      return result.rows.map(runFromRow);
    });
  }

  async setResultSet(record: ResultSetRecord): Promise<void> {
    await this.withConversationScope(record.sessionId, async (client, conversation) => client.query(
      `INSERT INTO pubg_result_sets(
         tenant_id, team_id, actor_id, channel_id, session_id,
         result_set_id, expires_at, result_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (tenant_id, team_id, actor_id, channel_id, session_id, result_set_id)
       DO UPDATE SET expires_at=EXCLUDED.expires_at, result_json=EXCLUDED.result_json`,
      [this.scope.tenantId, this.scope.teamId, conversation.actorId, conversation.channelId,
      conversation.sessionId, record.id, record.expiresAt, JSON.stringify(record)],
    ).then(() => undefined));
  }

  async getResultSet(sessionId: string, resultSetId: string, now = new Date()): Promise<ResultSetRecord | null> {
    return this.withConversationScope(sessionId, async (client, conversation) => {
      const result = await client.query(
        `SELECT result_json FROM pubg_result_sets
         WHERE tenant_id=$1 AND team_id=$2 AND actor_id=$3 AND channel_id=$4
           AND session_id=$5 AND result_set_id=$6 AND expires_at>$7`,
        [this.scope.tenantId, this.scope.teamId, conversation.actorId, conversation.channelId,
        conversation.sessionId, resultSetId, now],
      );
      return result.rows[0] ? objectValue<ResultSetRecord | null>(result.rows[0].result_json, null) : null;
    });
  }

  async setContext(context: SessionContextRecord): Promise<void> {
    await this.withConversationScope(context.sessionId, async (client, conversation) => client.query(
       `INSERT INTO pubg_session_contexts(
         tenant_id, team_id, actor_id, channel_id, session_id,
         expires_at, context_json
       ) VALUES ($1,$2,$3,$4,$5,'infinity'::timestamptz,$6::jsonb)
       ON CONFLICT (tenant_id, team_id, actor_id, channel_id, session_id)
       DO UPDATE SET expires_at='infinity'::timestamptz, context_json=EXCLUDED.context_json`,
      [this.scope.tenantId, this.scope.teamId, conversation.actorId, conversation.channelId,
      conversation.sessionId, JSON.stringify(context)],
    ).then(() => undefined));
  }

  async getContext(sessionId: string, now = new Date()): Promise<SessionContextRecord | null> {
    return this.withConversationScope(sessionId, async (client, conversation) => {
      const result = await client.query(
        `SELECT context_json FROM pubg_session_contexts
         WHERE tenant_id=$1 AND team_id=$2 AND actor_id=$3 AND channel_id=$4
           AND session_id=$5 AND expires_at>$6`,
        [this.scope.tenantId, this.scope.teamId, conversation.actorId, conversation.channelId,
        conversation.sessionId, now],
      );
      return result.rows[0] ? objectValue<SessionContextRecord | null>(result.rows[0].context_json, null) : null;
    });
  }

  async recordModelUsage(sessionId: string, usage: PublicModelUsageRecord): Promise<void> {
    const requestId = requiredText(usage.requestId, 'request_id');
    const provider = requiredText(usage.provider, 'model_provider');
    const modelId = requiredText(usage.modelId, 'model_id');
    if (requestId.length > 256 || provider.length > 100 || modelId.length > 200) throw new Error('model_usage_record_invalid');
    const tokens = (value: number | null): number | null => value !== null && Number.isSafeInteger(value)
      && value >= 0 && value <= 2_147_483_647 ? value : null;
    await this.withConversationScope(sessionId, async (client, conversation) => client.query(
      `INSERT INTO pubg_usage_records(tenant_id,team_id,actor_id,request_id,provider,model_id,input_tokens,output_tokens)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,request_id) DO NOTHING`,
      [this.scope.tenantId, this.scope.teamId, conversation.actorId,
        requestId, provider, modelId, tokens(usage.inputTokens), tokens(usage.outputTokens)],
    ).then(() => undefined));
  }

  async cleanupExpired(now = new Date()): Promise<void> {
    await this.withReadScope(async client => {
      await client.query('DELETE FROM pubg_result_sets WHERE tenant_id=$1 AND team_id=$2 AND expires_at <= $3', [this.scope.tenantId, this.scope.teamId, now]);
      await client.query('DELETE FROM pubg_session_contexts WHERE tenant_id=$1 AND team_id=$2 AND expires_at <= $3', [this.scope.tenantId, this.scope.teamId, now]);
    });
  }
}
