import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Pool } from 'pg';
import type { Coverage, ResultSetRecord, SessionContextRecord, SourceInfo, TeamContext, TelemetryFeatureRecord } from '@rine-kit/pubg-domain';
import { createTeamContext, DeterministicQueryEngine, PubgDomainService, SqlitePubgRepository, SqlitePubgRepositoryAdapter } from '@rine-kit/pubg-domain';
import { migratePubgDatabase, PostgresPubgRepository } from '../src/index.js';
import { authorize, createHostTables, DATABASE_URL } from './helpers.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/shared-domain-golden.json', import.meta.url), 'utf8')) as {
  contract: string;
  matches: Array<Record<string, unknown>>;
  query: Record<string, unknown>;
  coverage: Coverage;
  source: SourceInfo;
  syntheticMatchIdsInRange: string[];
  expectedPlayers: Array<Record<string, string | number | null>>;
};

const databaseUrl = DATABASE_URL;

test('PostgreSQL tenant and conversation scope is enforced at the repository boundary', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const suffix = randomUUID();
  const tenantA = `tenant-a-${suffix}`;
  const tenantB = `tenant-b-${suffix}`;
  const teamA = `team-a-${suffix}`;
  const teamB = `team-b-${suffix}`;
  const channelA = `channel-a-${suffix}`;
  const channelB = `channel-b-${suffix}`;
  const accountA = `account-a-${suffix}`;
  const accountB = `account-b-${suffix}`;
  const sharedSession = `trusted-session-${suffix}`;
  const conversationA = {
    kind: 'room',
    actorId: `user-a-${suffix}`,
    channelId: channelA,
    sessionId: sharedSession,
  };
  const contextA: TeamContext = {
    tenantId: tenantA,
    teamId: teamA,
    team: { id: teamA, label: 'Squad A', platform: 'steam', players: [{ id: accountA, name: 'Same Nickname', aliases: [] }] },
  };
  const contextB: TeamContext = {
    tenantId: tenantB,
    teamId: teamB,
    team: { id: teamB, label: 'Squad B', platform: 'steam', players: [{ id: accountB, name: 'Same Nickname', aliases: [] }] },
  };

  try {
    await migratePubgDatabase(pool);
    await migratePubgDatabase(pool);
    assert.throws(() => new PostgresPubgRepository(pool, undefined as never), /invalid_team_context/u);
    await createHostTables(pool);
    await pool.query('INSERT INTO pubg_tenants(tenant_id) VALUES ($1),($2)', [tenantA, tenantB]);
    await pool.query('INSERT INTO pubg_teams(tenant_id, team_id, label, pubg_shard) VALUES ($1,$2,$3,$7),($4,$5,$6,$7)', [tenantA, teamA, 'Squad A', tenantB, teamB, 'Squad B', 'steam']);
    await pool.query("INSERT INTO pubg_team_members(tenant_id,team_id,pubg_account_id,added_by) VALUES ($1,$2,$3,'fixture'),($4,$5,$6,'fixture')", [tenantA, teamA, accountA, tenantB, teamB, accountB]);
    await pool.query(
      `INSERT INTO test_bindings(tenant_id, channel_id, team_id) VALUES ($1,$2,$3),($4,$5,$6)`,
      [tenantA, channelA, teamA, tenantB, channelB, teamB],
    );
    await assert.rejects(
      pool.query(`INSERT INTO test_bindings(tenant_id,channel_id,team_id) VALUES ($1,$2,$3)`, [tenantB, channelA, teamB]),
      { code: '23505' },
    );

    const repoA = new PostgresPubgRepository(pool, contextA, conversationA, { authorize });
    const repoB = new PostgresPubgRepository(pool, contextB, {
      ...conversationA,
      actorId: `user-b-${suffix}`,
      channelId: channelB,
    }, { authorize });
    const unboundRepo = new PostgresPubgRepository(pool, contextA, { ...conversationA, channelId: `unbound-${suffix}` }, { authorize });
    await assert.rejects(unboundRepo.getContext(sharedSession), /conversation_channel_not_bound/u);
    const matchAt = Date.now();
    await repoA.upsertMatches([{
      matchId: `match-a-${suffix}`,
      shard: 'steam',
      createdAt: new Date(matchAt).toISOString(),
      timestamp: matchAt,
      matchType: 'official',
      gameMode: 'squad-fpp',
      mapName: 'Baltic_Main',
      duration: 900,
      patchVersion: 'test',
      players: [
        { accountId: accountA, playerName: 'Same Nickname', kills: 2, damage: 180 },
        { accountId: `opponent-${suffix}`, playerName: 'Opponent', kills: 1, damage: 90 },
      ],
    }]);
    await repoA.upsertMatches([{
      matchId: `match-b-${suffix}`,
      shard: 'steam',
      timestamp: matchAt + 1,
      matchType: 'official',
      gameMode: 'squad-fpp',
      mapName: 'Baltic_Main',
      duration: 900,
      patchVersion: 'test',
      players: [{ accountId: accountB, playerName: 'Same Nickname', kills: 4, damage: 360 }],
    }]);

    assert.equal(await repoA.countMatches(), 1);
    assert.equal(await repoB.countMatches(), 1);
    assert.deepEqual((await repoA.listMatches()).map((match) => match.matchId), [`match-a-${suffix}`]);
    assert.equal((await repoA.getMatch(`match-b-${suffix}`)), null);
    assert.deepEqual((await repoA.getMatch(`match-a-${suffix}`))?.players.map((player) => player.accountId), [accountA]);

    const featureKey = { parserVersion: 'r5-gate-fixture-parser', featureVersion: 'r5-gate-fixture-features' };
    const featureRecord = (matchId: string): TelemetryFeatureRecord => ({
      matchId, ...featureKey, createdAt: new Date(matchAt).toISOString(), facts: { match: { matchId } } as never,
    });
    const featureA = featureRecord(`match-a-${suffix}`);
    const featureB = featureRecord(`match-b-${suffix}`);
    await repoA.set(featureA);
    await repoB.set(featureB);
    assert.deepEqual(await repoA.get({ matchId: featureA.matchId, ...featureKey }), featureA);
    assert.equal(await repoA.get({ matchId: featureB.matchId, ...featureKey }), null);
    assert.deepEqual(await repoB.get({ matchId: featureB.matchId, ...featureKey }), featureB);
    assert.equal(await repoB.get({ matchId: featureA.matchId, ...featureKey }), null);

    const state = {
      key: 'team-sync',
      checkedAt: new Date(matchAt).toISOString(),
      coverage: { status: 'OK', complete: true } as never,
      source: { store: 'postgres' } as never,
      discoveredMatchIds: [`match-a-${suffix}`],
      failedMatchIds: [],
    };
    await repoA.setSyncState(state);
    assert.equal((await repoB.getSyncState('team-sync')), null);

    const context: SessionContextRecord = {
      schemaVersion: 3,
      sessionId: sharedSession,
      activeDomain: 'pubg',
      lastQuery: null,
      lastSelector: null,
      lastResultSetId: null,
      lastSubject: null,
      references: {},
      updatedAt: new Date(matchAt).toISOString(),
      expiresAt: new Date(matchAt + 60_000).toISOString(),
    };
    await repoA.setContext(context);
    assert.equal((await repoA.getContext(sharedSession))?.sessionId, sharedSession);
    assert.equal(await repoB.getContext(sharedSession), null);
    await assert.rejects(repoA.getContext(`forged-${suffix}`), /conversation_scope_mismatch/u);

    const directScope = {
      ...conversationA,
      kind: 'direct',
      channelId: `dm-${suffix}`,
      sessionId: `dm-session-${suffix}`,
    };
    const directRepo = new PostgresPubgRepository(pool, contextA, directScope, { authorize });
    await assert.rejects(directRepo.getContext(directScope.sessionId), /direct_team_access_denied/u);
    await pool.query('INSERT INTO test_access(tenant_id,team_id,actor_id) VALUES ($1,$2,$3)', [tenantA, teamA, conversationA.actorId]);
    await directRepo.setContext({ ...context, sessionId: directScope.sessionId });
    assert.equal((await directRepo.getContext(directScope.sessionId))?.sessionId, directScope.sessionId);

    const fakeResultSet = { id: 'rs-a', sessionId: sharedSession, expiresAt: new Date(matchAt + 60_000).toISOString() } as ResultSetRecord;
    await repoA.setResultSet(fakeResultSet);
    assert.equal(await repoB.getResultSet(sharedSession, 'rs-a'), null);
    await assert.rejects(repoA.setResultSet({ ...fakeResultSet, sessionId: `forged-${suffix}` }), /conversation_scope_mismatch/u);

    const publicService = new PubgDomainService({
      teamContext: contextA,
      repository: repoA,
      now: () => new Date(matchAt + 2_000),
    });
    const serviceResult = await publicService.queryStats({
      sessionId: sharedSession,
      selector: {
        type: 'time_range',
        from: new Date(matchAt - 60_000).toISOString(),
        to: new Date(matchAt + 60_000).toISOString(),
        timezone: 'Asia/Shanghai',
        businessDayStart: '06:00',
      },
      metrics: ['kills', 'kd', 'assists'],
    });
    assert.ok(serviceResult.resultSetId);
    const persistedServiceResult = await repoA.getResultSet(sharedSession, serviceResult.resultSetId!, new Date(matchAt + 3_000));
    assert.equal(persistedServiceResult?.source.store, 'postgres');

    const goldenTeam = `golden-${teamA}`;
    await pool.query("INSERT INTO pubg_teams(tenant_id,team_id,label,pubg_shard) VALUES ($1,$2,'Golden Team','steam')", [tenantA, goldenTeam]);
    await pool.query("INSERT INTO pubg_team_members(tenant_id,team_id,pubg_account_id,added_by) VALUES ($1,$2,'p1','fixture'),($1,$2,'p2','fixture')", [tenantA, goldenTeam]);
    const goldenContext = createTeamContext(tenantA, {
      id: goldenTeam,
      label: 'Golden Team',
      platform: 'steam',
      players: [{ id: 'p1', name: 'Alice', aliases: [] }, { id: 'p2', name: 'Bob', aliases: [] }],
    });
    const goldenMatches = golden.matches.map((record) => ({ ...record, matchId: `${suffix}-${String(record.matchId)}` }));
    const sqlite = new SqlitePubgRepository(':memory:');
    try {
      const sqliteRepository = new SqlitePubgRepositoryAdapter(sqlite, goldenContext);
      const pgGoldenRepository = new PostgresPubgRepository(pool, goldenContext);
      await sqliteRepository.upsertMatches(goldenMatches);
      await pgGoldenRepository.upsertMatches(goldenMatches);
      const sqliteResult = new DeterministicQueryEngine({ teamContext: goldenContext, now: new Date('2026-09-17T00:00:00.000Z') })
        .execute(golden.query as never, await sqliteRepository.listMatches(), golden.coverage, golden.source);
      const postgresResult = new DeterministicQueryEngine({ teamContext: goldenContext, now: new Date('2026-09-17T00:00:00.000Z') })
        .execute(golden.query as never, await pgGoldenRepository.listMatches(), golden.coverage, golden.source);
      assert.deepEqual(postgresResult, sqliteResult);
      assert.deepEqual(postgresResult.evidence.matchIds, golden.syntheticMatchIdsInRange.map((matchId) => `${suffix}-${matchId}`));
      assert.deepEqual(postgresResult.data.rows.map((row) => {
        const expected = golden.expectedPlayers.find((item) => item.key === row.key)!;
        return Object.fromEntries(Object.keys(expected)
          .filter((key) => key !== 'key')
          .map((key) => [key, row.metrics[key] ?? null])
          .concat([['key', row.key]]));
      }), golden.expectedPlayers);
    } finally {
      sqlite.close();
    }

    const migrationRows = await pool.query('SELECT migration_id FROM pubg_schema_migrations');
    assert.equal(migrationRows.rows.filter((row) => row.migration_id === '0001_pubg_schema.sql').length, 1);

    let signalLock!: () => void;
    let releaseReader!: () => void;
    const teamReadLocked = new Promise<void>(resolve => { signalLock = resolve; });
    const readerMayContinue = new Promise<void>(resolve => { releaseReader = resolve; });
    let intercepted = false;
    const gatedPool = new Proxy(pool, {
      get(target, property, receiver) {
        if (property !== 'connect') return Reflect.get(target, property, receiver);
        return async () => {
          const client = await target.connect();
          const originalQuery = client.query.bind(client);
          const wrappedClient = new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty !== 'query') return Reflect.get(clientTarget, clientProperty, clientReceiver);
              return async (...args: Parameters<typeof client.query>) => {
                const result = await originalQuery(...args);
                const sql = typeof args[0] === 'string' ? args[0] : '';
                if (!intercepted && sql.includes('SELECT query_revision FROM pubg_teams') && sql.includes('FOR SHARE')) {
                  intercepted = true;
                  signalLock();
                  await readerMayContinue;
                }
                return result;
              };
            },
          });
          return wrappedClient;
        };
      },
    });
    const racedRepo = new PostgresPubgRepository(gatedPool, contextA, conversationA, { authorize });
    const racedRead = racedRepo.listMatches();
    const readerLockTimeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('team_read_lock_not_acquired')), 2_000));
    await Promise.race([teamReadLocked, readerLockTimeout]);
    const rosterWriter = await pool.connect();
    const writerApplication = `roster-revoke-${suffix}`;
    let rosterDelete: Promise<unknown> | undefined;
    try {
      await rosterWriter.query('BEGIN');
      await rosterWriter.query("SELECT set_config('application_name',$1,false)", [writerApplication]);
      rosterDelete = rosterWriter.query(
        'DELETE FROM pubg_team_members WHERE tenant_id=$1 AND team_id=$2 AND pubg_account_id=$3',
        [tenantA, teamA, accountA],
      );
      let waitingForTeamLock = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`,
          [writerApplication],
        );
        if (activity.rowCount) {
          waitingForTeamLock = true;
          break;
        }
        const writerFinished = await Promise.race([rosterDelete.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10))]);
        if (writerFinished) break;
      }
      assert.equal(waitingForTeamLock, true, 'roster revocation waits for the bounded authorized read');
    } finally {
      releaseReader();
      try {
        if (rosterDelete) await rosterDelete;
        await rosterWriter.query('COMMIT');
      } catch (error) {
        await rosterWriter.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        rosterWriter.release();
      }
    }
    assert.deepEqual((await racedRead).map(match => match.matchId), [`match-a-${suffix}`]);
    await assert.rejects(repoA.listMatches(), /repository_team_scope_mismatch/u);
  } finally {
    await pool.query('DELETE FROM pubg_tenants WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB]]).catch(() => undefined);
    await pool.query('DELETE FROM pubg_matches WHERE match_id = ANY($1::text[])', [[`match-a-${suffix}`, `match-b-${suffix}`, ...golden.matches.map((record) => `${suffix}-${String(record.matchId)}`)]]).catch(() => undefined);
    await pool.end();
  }
});
