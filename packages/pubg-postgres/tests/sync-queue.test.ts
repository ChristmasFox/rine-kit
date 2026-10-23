import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { migratePubgDatabase, PublicSyncQueue } from '../src/index.js';
import { DATABASE_URL } from './helpers.js';

const databaseUrl = DATABASE_URL;

test('public sync queue uses tenant-team keys, disjoint leases, fencing tokens, and retry backoff', { skip: !databaseUrl }, async () => {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const schema = `public_sync_queue_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6 });
  const suffix = randomUUID().replaceAll('-', '');
  const tenantA = `queue-tenant-a-${suffix}`;
  const tenantB = `queue-tenant-b-${suffix}`;

  try {
    await migratePubgDatabase(pool);
    await pool.query('INSERT INTO pubg_tenants(tenant_id) VALUES ($1),($2)', [tenantA, tenantB]);
    await pool.query(`INSERT INTO pubg_teams(tenant_id,team_id,label,pubg_shard)
      VALUES ($1,'shared-team','A','steam'),($2,'shared-team','B','steam')`, [tenantA, tenantB]);
    const first = new PublicSyncQueue(pool, { leaseMs: 60_000, baseRetryMs: 500, maxRetryMs: 2_000 });
    const second = new PublicSyncQueue(pool, { leaseMs: 60_000, baseRetryMs: 500, maxRetryMs: 2_000 });
    assert.equal(await first.ensureTeams(), 2);
    const initialSnapshot = await first.getSnapshot();
    assert.equal(initialSnapshot.totalJobs, 2);
    assert.equal(initialSnapshot.dueJobs, 2);
    assert.equal(initialSnapshot.oldestDueAgeSeconds !== null && initialSnapshot.oldestDueAgeSeconds >= 0, true);

    const [claimedA, claimedB] = await Promise.all([first.claimDue(1), second.claimDue(1)]);
    assert.equal(claimedA.length, 1);
    assert.equal(claimedB.length, 1);
    assert.notDeepEqual(
      [claimedA[0]?.tenantId, claimedA[0]?.teamId],
      [claimedB[0]?.tenantId, claimedB[0]?.teamId],
      'parallel worker processes must not lease the same tenant/team job',
    );
    assert.notEqual(claimedA[0]?.leaseToken, claimedB[0]?.leaseToken);
    const leasedSnapshot = await first.getSnapshot();
    assert.equal(leasedSnapshot.activeLeases, 2);
    assert.equal(leasedSnapshot.oldestDueAgeSeconds, null);

    const expired = claimedA[0]!;
    await pool.query(`UPDATE pubg_sync_jobs SET lease_until=now()-interval '1 second'
      WHERE tenant_id=$1 AND team_id=$2`, [expired.tenantId, expired.teamId]);
    const expiredSnapshot = await first.getSnapshot();
    assert.equal(expiredSnapshot.expiredLeases, 1);
    assert.equal(expiredSnapshot.activeLeases, 1);
    const reclaimed = await second.claimDue(1);
    assert.equal(reclaimed.length, 1);
    assert.deepEqual([reclaimed[0]?.tenantId, reclaimed[0]?.teamId], [expired.tenantId, expired.teamId]);
    assert.notEqual(reclaimed[0]?.leaseToken, expired.leaseToken, 'recovery must fence an expired worker');
    assert.equal(await first.complete(expired, 60_000), false, 'an expired lease cannot complete after reclaim');

    const retryJob = reclaimed[0]!;
    assert.equal(await second.fail(retryJob, 'provider_unavailable'), true);
    const retryRow = await pool.query(`SELECT attempt_count,last_error_code,next_attempt_at>now() AS delayed
      FROM pubg_sync_jobs WHERE tenant_id=$1 AND team_id=$2`, [retryJob.tenantId, retryJob.teamId]);
    assert.equal(Number(retryRow.rows[0]?.attempt_count), 2);
    assert.equal(retryRow.rows[0]?.last_error_code, 'provider_unavailable');
    assert.equal(retryRow.rows[0]?.delayed, true);
    assert.equal((await second.claimDue(1)).length, 0, 'backoff must keep the failed job out of the immediate queue');
    const retrySnapshot = await first.getSnapshot();
    assert.equal(retrySnapshot.delayedJobs, 1);
    assert.equal(retrySnapshot.retryingJobs, 1);
    assert.equal(retrySnapshot.activeLeases, 1);

    await pool.query(`UPDATE pubg_sync_jobs SET next_attempt_at=now()-interval '1 second'
      WHERE tenant_id=$1 AND team_id=$2`, [retryJob.tenantId, retryJob.teamId]);
    const nextAttempt = await first.claimDue(1);
    assert.equal(nextAttempt.length, 1);
    assert.equal(nextAttempt[0]?.attemptCount, 3);
    assert.equal(await first.complete(nextAttempt[0]!, 60_000), true);
    assert.equal((await second.claimDue(3)).length, 0, 'successful syncs remain scheduled for a later interval');

    await pool.query('DELETE FROM pubg_teams WHERE tenant_id=$1 AND team_id=$2', [tenantB, 'shared-team']);
    assert.equal((await pool.query('SELECT 1 FROM pubg_sync_jobs WHERE tenant_id=$1 AND team_id=$2', [tenantB, 'shared-team'])).rowCount, 0,
      'team deletion cascades only its own durable job');
    assert.equal((await pool.query('SELECT 1 FROM pubg_sync_jobs WHERE tenant_id=$1 AND team_id=$2', [tenantA, 'shared-team'])).rowCount, 1,
      'same team id in another tenant remains isolated');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test('public sync queue rejects an unbounded claim batch', async () => {
  const queue = new PublicSyncQueue({} as Pool);
  await assert.rejects(queue.claimDue(65), /public_sync_queue_config_invalid/u);
});
