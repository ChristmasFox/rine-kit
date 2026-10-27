import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { migratePubgDatabase, PublicSyncQueue } from '@rine-kit/pubg-postgres';
import { syncTeamNow, type PublicPubgAdmission } from '../src/index.js';
import { createTeam, DATABASE_URL } from './helpers.js';

const skip = !DATABASE_URL;

const admission: PublicPubgAdmission = { acquire: async () => undefined, observe: async () => undefined };

/** A PUBG that knows one player with `matchIds`, each with a tiny telemetry file. */
function pubgFixture(accountId: string, matchIds: string[]): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.origin === 'https://api.pubg.com') {
      if (url.pathname.endsWith('/players')) {
        return Response.json({ data: [{
          type: 'player', id: accountId, attributes: { name: 'Alice' },
          relationships: { matches: { data: matchIds.map((id) => ({ type: 'match', id })) } },
        }] });
      }
      const matchId = url.pathname.split('/').at(-1) ?? '';
      return Response.json({
        data: {
          type: 'match', id: matchId,
          attributes: { createdAt: '2026-10-12T10:00:00.000Z', matchType: 'competitive', gameMode: 'squad-fpp', mapName: 'Baltic_Main', duration: 1200, patchVersion: 'fixture' },
          relationships: { assets: { data: [{ type: 'asset', id: `asset-${matchId}` }] } },
        },
        included: [
          { type: 'asset', id: `asset-${matchId}`, attributes: { URL: `https://telemetry-cdn.pubg.com/fixture/${matchId}-telemetry.json` } },
          { type: 'participant', id: 'p0', attributes: { stats: { playerId: accountId, kills: 1, assists: 0, damageDealt: 100, DBNOs: 0, revives: 0, headshotKills: 0, timeSurvived: 900, longestKill: 0, winPlace: 3 } } },
        ],
      });
    }
    return Response.json({ events: [] });
  };
}

async function scratch() {
  const admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const schema = `sync_team_now_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
  await migratePubgDatabase(pool);
  return { pool, close: async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
}

test('syncTeamNow syncs one team that is not due, and a telemetry backlog is scheduled soon, not at the next hourly slot', { skip }, async () => {
  const { pool, close } = await scratch();
  const suffix = randomUUID().replaceAll('-', '');
  const account = `account.a_${suffix}`;
  const ids = [1, 2, 3].map((n) => `m${n}-${suffix}`);
  const tenantId = `t-${suffix}`;
  const teamId = `room-${suffix}`;
  try {
    await createTeam(pool, { tenantId, teamId, label: 'Room', shard: 'steam', members: [{ accountId: account, displayName: 'Alice' }] });
    const queue = new PublicSyncQueue(pool);
    // The hourly run finished a moment ago: the team is an hour away.
    const first = await queue.claimTeam(tenantId, teamId);
    assert.ok(first);
    await queue.complete(first, 3_600_000);
    assert.equal(await queue.claimDue(1).then((jobs) => jobs.length), 0);

    const result = await syncTeamNow(pool, {
      tenantId, teamId, apiKey: 'fixture-only', admission, fetchImpl: pubgFixture(account, ids),
      maxTelemetryFetches: 1, catchupDelayMs: 300_000, nextSyncDelayMs: () => 3_600_000,
    });
    assert.equal(result.status, 'synced');
    if (result.status !== 'synced') return;
    assert.equal(result.telemetry.discovered, 3);
    assert.equal(result.telemetry.fetched, 1);
    assert.equal(result.telemetry.deferred, 2, 'two matches wait for a later run');
    const row = await pool.query<{ seconds: number; leased: boolean }>(
      `SELECT EXTRACT(EPOCH FROM (next_attempt_at-now()))::float AS seconds, lease_token IS NOT NULL AS leased
         FROM pubg_sync_jobs WHERE tenant_id=$1 AND team_id=$2`, [tenantId, teamId]);
    assert.equal(row.rows[0]?.leased, false, 'the lease is released');
    assert.ok(row.rows[0]!.seconds > 200 && row.rows[0]!.seconds <= 300, `catch-up in about 5 minutes, got ${row.rows[0]?.seconds}`);
    const state = await pool.query(`SELECT state_json->>'checkedAt' AS checked FROM pubg_sync_state WHERE tenant_id=$1 AND team_id=$2`, [tenantId, teamId]);
    assert.ok(state.rows[0]?.checked, 'sync state is written');
    const pending = await pool.query(`SELECT count(*)::int AS n FROM pubg_telemetry_team_prefetch_attempts WHERE tenant_id=$1 AND team_id=$2 AND status='PENDING'`, [tenantId, teamId]);
    assert.equal(pending.rows[0]?.n, 2);

    // Second run: the backlog shrinks; without catch-up configured the normal slot applies.
    const again = await syncTeamNow(pool, {
      tenantId, teamId, apiKey: 'fixture-only', admission, fetchImpl: pubgFixture(account, ids),
      maxTelemetryFetches: 5, nextSyncDelayMs: () => 3_600_000,
    });
    assert.equal(again.status, 'synced');
    if (again.status === 'synced') assert.equal(again.telemetry.deferred, 0);
    const slot = await pool.query<{ seconds: number }>(`SELECT EXTRACT(EPOCH FROM (next_attempt_at-now()))::float AS seconds FROM pubg_sync_jobs WHERE tenant_id=$1 AND team_id=$2`, [tenantId, teamId]);
    assert.ok(slot.rows[0]!.seconds > 3_000, 'back on the hourly slot once nothing is waiting');
  } finally {
    await close();
  }
});

test('syncTeamNow does not run beside a worker: it waits for the lease holder, or reports busy / unknown team', { skip }, async () => {
  const { pool, close } = await scratch();
  const suffix = randomUUID().replaceAll('-', '');
  const account = `account.a_${suffix}`;
  const tenantId = `t-${suffix}`;
  const teamId = `room-${suffix}`;
  let playerCalls = 0;
  const counting: typeof fetch = async (input, init) => {
    if (String(input).includes('/players')) playerCalls += 1;
    return pubgFixture(account, [`m1-${suffix}`])(input, init);
  };
  const options = { tenantId, teamId, apiKey: 'fixture-only', admission, fetchImpl: counting, maxTelemetryFetches: 2 };
  try {
    await createTeam(pool, { tenantId, teamId, label: 'Room', shard: 'steam', members: [{ accountId: account, displayName: 'Alice' }] });
    assert.deepEqual(await syncTeamNow(pool, { ...options, teamId: 'nope' }), { status: 'unknown_team' });

    const queue = new PublicSyncQueue(pool);
    const held = await queue.claimTeam(tenantId, teamId);
    assert.ok(held);
    assert.deepEqual(await syncTeamNow(pool, { ...options, waitMs: 0 }), { status: 'busy' });
    assert.deepEqual(await syncTeamNow(pool, { ...options, waitMs: 700 }), { status: 'busy' }, 'gives up after waitMs');
    assert.equal(playerCalls, 0, 'never talks to PUBG while another process holds the team');

    const waiting = syncTeamNow(pool, { ...options, waitMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await queue.complete(held, 3_600_000); // the other process finishes
    assert.deepEqual(await waiting, { status: 'joined' });
    assert.equal(playerCalls, 0, 'the finished run is used as is');
  } finally {
    await close();
  }
});

test('a member who joins later gets their earlier games in matches that were already stored, once (the real worker path)', { skip }, async () => {
  const { pool, close } = await scratch();
  const suffix = randomUUID().replaceAll('-', '');
  const [a1, a2] = [`account.a1_${suffix}`, `account.a2_${suffix}`];
  const matchIds = [`m1-${suffix}`, `m2-${suffix}`];
  const tenantId = `t-${suffix}`;
  const teamId = `room-${suffix}`;
  const detailRequests: string[] = [];
  const pubg: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.pubg.com') return Response.json({ events: [] });
    if (url.pathname.endsWith('/players')) {
      const ids = (url.searchParams.get('filter[playerIds]') ?? '').split(',').filter(Boolean);
      return Response.json({
        data: ids.map((id) => ({
          type: 'player', id, attributes: { name: id },
          relationships: { matches: { data: matchIds.map((m) => ({ type: 'match', id: m })) } },
        })),
      });
    }
    const matchId = url.pathname.split('/').at(-1) ?? '';
    detailRequests.push(matchId);
    const stat = (playerId: string, kills: number) => ({
      type: 'participant', id: `p-${playerId}`,
      attributes: { stats: { playerId, kills, assists: 0, damageDealt: kills * 100, DBNOs: 0, revives: 0, headshotKills: 0, timeSurvived: 900, longestKill: 0, winPlace: 3 } },
    });
    return Response.json({
      data: {
        type: 'match', id: matchId,
        attributes: { createdAt: '2026-10-12T10:00:00.000Z', matchType: 'competitive', gameMode: 'squad-fpp', mapName: 'Baltic_Main', duration: 1200, patchVersion: 'fixture' },
        relationships: { assets: { data: [] } },
      },
      included: [stat(a1, 1), stat(a2, 3)],
    });
  };
  const sync = () => syncTeamNow(pool, {
    tenantId, teamId, apiKey: 'fixture-only', admission, fetchImpl: pubg, maxTelemetryFetches: 2, nextSyncDelayMs: () => 3_600_000,
  });
  const rowsOf = async (account: string) =>
    (await pool.query('SELECT count(*)::int AS n FROM pubg_match_players WHERE account_id=$1', [account])).rows[0]!.n as number;
  try {
    // Alice alone
    await createTeam(pool, { tenantId, teamId, label: 'Room', shard: 'steam', members: [{ accountId: a1, displayName: 'Alice' }] });
    assert.equal((await sync()).status, 'synced');
    assert.deepEqual([await rowsOf(a1), await rowsOf(a2)], [2, 0]);
    assert.ok(matchIds.every((id) => detailRequests.includes(id)), 'both matches were fetched (and their Telemetry resolved)');

    // Bob joins; the job is made due like a link does
    await pool.query("INSERT INTO pubg_team_members(tenant_id,team_id,pubg_account_id,added_by) VALUES ($1,$2,$3,'fixture')", [tenantId, teamId, a2]);
    await pool.query("INSERT INTO pubg_account_names(shard,account_id,display_name) VALUES ('steam',$1,'Bob') ON CONFLICT DO NOTHING", [a2]);
    detailRequests.length = 0;
    assert.equal((await sync()).status, 'synced');
    assert.deepEqual([await rowsOf(a1), await rowsOf(a2)], [2, 2], "Bob's rows are added next to Alice's");
    assert.deepEqual([...detailRequests].sort(), [...matchIds].sort(), 'the stored matches were fetched again for him');

    // once only
    detailRequests.length = 0;
    assert.equal((await sync()).status, 'synced');
    assert.deepEqual(detailRequests, []);
    assert.deepEqual([await rowsOf(a1), await rowsOf(a2)], [2, 2]);
  } finally {
    await close();
  }
});
