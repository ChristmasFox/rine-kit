import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Pool } from 'pg';
import {
  createTeamContext,
  PubgDomainService,
  SqlitePubgRepository,
  SqlitePubgRepositoryAdapter,
  type ToolEnvelope,
} from '@rine-kit/pubg-domain';
import { migratePubgDatabase, PostgresPubgRepository } from '../src/index.js';
import { authorize, createHostTables, DATABASE_URL } from './helpers.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/shared-domain-golden.json', import.meta.url), 'utf8')) as {
  matches: Array<Record<string, unknown>>;
};

/*
 * Lab answers from SQLite, a multi-tenant host from PostgreSQL. Both sit under the same PubgDomainService, so the
 * same question must give the same answer. This runs the tool surface (stats, ranking, search, match detail) on both
 * and compares the envelopes with the things that legitimately differ (store name, result-set / session ids) removed.
 */
const NOW = new Date('2026-09-17T00:00:00.000Z');
// Public match records are shared by every team of the database, so each run uses match ids of its own.
let PREFIX_MARK = '';
let IDS_MARK = '';

function normalise(envelope: ToolEnvelope): unknown {
  const text = JSON.stringify(envelope, (key, value) => {
    if (['resultSetId', 'sessionId', 'queryId', 'store', 'storeName'].includes(key)) return undefined;
    if (typeof value === 'string') return value.replaceAll(PREFIX_MARK, '').replaceAll(IDS_MARK, '');
    return value;
  });
  return JSON.parse(text);
}

test('the same tool questions give the same answers from SQLite and from PostgreSQL', { skip: !DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  const suffix = randomUUID().replaceAll('-', '');
  const tenant = `eq-${suffix}`;
  const team = `team-${suffix}`;
  const channel = `room-${suffix}`;
  // Accounts of their own too: a public match shows up for every team that has one of its players.
  const p1 = `p1_${suffix}`;
  const p2 = `p2_${suffix}`;
  const players = [
    { id: p1, name: 'Alice', aliases: [] },
    { id: p2, name: 'Bob', aliases: [] },
  ];
  const sqlite = new SqlitePubgRepository(':memory:');
  try {
    await migratePubgDatabase(pool);
    await createHostTables(pool);
    await pool.query('INSERT INTO pubg_tenants(tenant_id) VALUES ($1)', [tenant]);
    await pool.query("INSERT INTO pubg_teams(tenant_id,team_id,label,pubg_shard) VALUES ($1,$2,'Eq','steam')", [tenant, team]);
    await pool.query("INSERT INTO pubg_team_members(tenant_id,team_id,pubg_account_id,added_by) VALUES ($1,$2,$3,'fixture'),($1,$2,$4,'fixture')", [tenant, team, p1, p2]);
    await pool.query('INSERT INTO test_bindings(tenant_id, channel_id, team_id) VALUES ($1,$2,$3)', [tenant, channel, team]);

    const context = createTeamContext(tenant, { id: team, label: 'Eq', platform: 'steam', players });
    PREFIX_MARK = `${suffix}-`;
    IDS_MARK = `_${suffix}`;
    const matches = (JSON.parse(
      JSON.stringify(golden.matches).replaceAll('"p1"', `"${p1}"`).replaceAll('"p2"', `"${p2}"`),
    ) as Array<Record<string, unknown>>).map((record) => ({ ...record, matchId: `${suffix}-${String(record.matchId)}` }));
    const sqliteRepository = new SqlitePubgRepositoryAdapter(sqlite, context);
    const pgRepository = new PostgresPubgRepository(
      pool,
      context,
      { kind: 'room', actorId: 'u1', channelId: channel, sessionId: 's1' },
      { authorize },
    );
    await sqliteRepository.upsertMatches(matches);
    await pgRepository.upsertMatches(matches);

    // The stored matches themselves come back the same, in the same order.
    const listed = async (repository: { listMatches(): Promise<Array<{ matchId: string }>> }) =>
      (await repository.listMatches()).map((match) => match.matchId);
    assert.deepEqual(await listed(pgRepository), await listed(sqliteRepository));

    const services = {
      sqlite: new PubgDomainService({ teamContext: context, repository: sqliteRepository, now: () => NOW }),
      postgres: new PubgDomainService({ teamContext: context, repository: pgRepository, now: () => NOW }),
    };
    const range = { type: 'time_range', from: '2026-09-15T00:00:00.000Z', to: '2026-09-17T00:00:00.000Z', timezone: 'Asia/Shanghai' } as const;
    const calls: Array<[string, (service: PubgDomainService) => Promise<ToolEnvelope>]> = [
      ['stats report by player', (s) => s.queryStats({ sessionId: 's1', playerIds: [p1, p2], selector: range as never, metrics: ['matches', 'kills', 'damage', 'kd', 'assists'] as never, operation: 'report', groupBy: 'player', refresh: false } as never)],
      ['stats rank by kills', (s) => s.queryStats({ sessionId: 's1', playerIds: [p1, p2], selector: range as never, metrics: ['kills'] as never, operation: 'rank', orderBy: { metric: 'kills', direction: 'desc' }, refresh: false } as never)],
      ['stats for one player', (s) => s.queryStats({ sessionId: 's1', playerIds: [p1], selector: range as never, metrics: ['matches', 'kills'] as never, refresh: false } as never)],
      ['search latest match', (s) => s.searchMatches({ sessionId: 's1', playerIds: [p1, p2], sort: 'desc', recentN: 1, refresh: false } as never)],
      ['search the period, oldest first', (s) => s.searchMatches({ sessionId: 's1', playerIds: [p1, p2], selector: range as never, sort: 'asc', pageSize: 50, refresh: false } as never)],
    ];
    for (const [label, call] of calls) {
      const fromSqlite = await call(services.sqlite);
      const fromPostgres = await call(services.postgres);
      assert.deepEqual(normalise(fromPostgres), normalise(fromSqlite), label);
      assert.notEqual(fromSqlite.status, 'error', `${label}: the question itself must work`);
    }

    // One concrete match, by id.
    const firstId = (await listed(sqliteRepository))[0]!;
    const detail = (service: PubgDomainService) => service.getMatch({ sessionId: 's1', matchId: firstId, refresh: false } as never);
    assert.deepEqual(normalise(await detail(services.postgres)), normalise(await detail(services.sqlite)), 'match detail');
  } finally {
    sqlite.close();
    await pool.end();
  }
});
