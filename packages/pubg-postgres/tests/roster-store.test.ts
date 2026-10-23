import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { migratePubgDatabase, PostgresPubgRepository, PostgresPubgRosterStore } from '../src/index.js';
import { DATABASE_URL } from './helpers.js';

const skip = !DATABASE_URL;

test('claims build a team: one account per member, replaced on re-claim, scoped by tenant and team', { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const suffix = randomUUID().replaceAll('-', '');
  const tenant = `rt-${suffix}`;
  const room = `room-${suffix}`;
  const otherRoom = `other-${suffix}`;
  const acct = (n: string) => `account.${n}_${suffix}`;
  try {
    await migratePubgDatabase(pool);
    const store = new PostgresPubgRosterStore(pool);
    const base = { tenantId: tenant, teamId: room, teamLabel: 'Room 1', shard: 'steam' };

    assert.equal(await store.getTeamContext(tenant, room), null, 'no claims, no team');
    await store.claim({ ...base, actorId: 'u1', accountId: acct('a'), displayName: 'Alice' });
    await store.claim({ ...base, actorId: 'u2', accountId: acct('b'), displayName: 'Bob' });
    let context = await store.getTeamContext(tenant, room);
    assert.deepEqual(context?.team.players.map((p) => [p.id, p.name]), [
      [acct('a'), 'Alice'],
      [acct('b'), 'Bob'],
    ]);
    assert.equal(context?.team.platform, 'steam');
    assert.equal((await store.getClaim(tenant, room, 'u2'))?.accountId, acct('b'));

    // the same account cannot be claimed by two members of one team
    await assert.rejects(
      store.claim({ ...base, actorId: 'u3', accountId: acct('a'), displayName: 'Alice' }),
      /pubg_account_taken/u,
    );
    // re-claiming replaces the member's earlier account, and renames it
    await store.claim({ ...base, actorId: 'u1', accountId: acct('c'), displayName: 'Carol' });
    context = await store.getTeamContext(tenant, room);
    assert.deepEqual(context?.team.players.map((p) => p.name).sort(), ['Bob', 'Carol']);
    // the freed account can be claimed by someone else
    await store.claim({ ...base, actorId: 'u3', accountId: acct('a'), displayName: 'Alice' });

    // another room is a separate team: same account, same member, no clash
    await store.claim({ ...base, teamId: otherRoom, teamLabel: 'Room 2', actorId: 'u1', accountId: acct('c'), displayName: 'Carol' });
    assert.equal((await store.listClaims(tenant, otherRoom)).length, 1);

    // one shard per team
    await assert.rejects(
      store.claim({ ...base, actorId: 'u4', shard: 'kakao', accountId: acct('d'), displayName: 'Dave' }),
      /pubg_team_shard_conflict/u,
    );
    await assert.rejects(store.claim({ ...base, actorId: 'u4', shard: 'moon', accountId: acct('d'), displayName: 'D' }), /pubg_shard_invalid/u);

    // a claim schedules the team's sync at once
    const job = await pool.query('SELECT next_attempt_at <= now() AS due FROM pubg_sync_jobs WHERE tenant_id=$1 AND team_id=$2', [tenant, room]);
    assert.equal(job.rows[0]?.due, true);

    // the repository sees exactly the claimed roster
    const repo = new PostgresPubgRepository(pool, context!);
    await assert.rejects(repo.countMatches(), /repository_team_scope_mismatch/u, 'stale context (roster changed since)');
    const fresh = (await store.getTeamContext(tenant, room))!;
    assert.equal(await new PostgresPubgRepository(pool, fresh).countMatches(), 0);

    // release: the member leaves; the team disappears with its last member
    assert.equal(await store.release(tenant, room, 'u2'), true);
    assert.equal(await store.release(tenant, room, 'u2'), false);
    await store.release(tenant, room, 'u1');
    await store.release(tenant, room, 'u3');
    assert.equal(await store.getTeamContext(tenant, room), null);
    assert.equal((await store.listClaims(tenant, otherRoom)).length, 1, 'other team untouched');
  } finally {
    await pool.query('DELETE FROM pubg_tenants WHERE tenant_id=$1', [tenant]).catch(() => undefined);
    await pool.end();
  }
});

test('a team holds at most the roster limit', { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const suffix = randomUUID().replaceAll('-', '');
  const tenant = `cap-${suffix}`;
  try {
    await migratePubgDatabase(pool);
    const store = new PostgresPubgRosterStore(pool);
    for (let i = 0; i < 8; i++) {
      await store.claim({ tenantId: tenant, teamId: 't', teamLabel: 'T', actorId: `u${i}`, shard: 'steam', accountId: `account.p${i}_${suffix}`, displayName: `P${i}` });
    }
    await assert.rejects(
      store.claim({ tenantId: tenant, teamId: 't', teamLabel: 'T', actorId: 'u9', shard: 'steam', accountId: `account.p9_${suffix}`, displayName: 'P9' }),
      /pubg_team_full/u,
    );
  } finally {
    await pool.query('DELETE FROM pubg_tenants WHERE tenant_id=$1', [tenant]).catch(() => undefined);
    await pool.end();
  }
});
