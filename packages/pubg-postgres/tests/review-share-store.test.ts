import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { issueReviewShare, reviewShareOpen, reviewShareTokenHash } from '@rine-kit/pubg-domain';
import { migratePubgDatabase, PostgresReviewShareStore } from '../src/index.js';
import { DATABASE_URL } from './helpers.js';

test('a share is stored by token hash, a newer one revokes the older of its session, and expiry is honoured', { skip: !DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await migratePubgDatabase(pool);
    const tenant = `t-${randomUUID()}`;
    const store = new PostgresReviewShareStore(pool, tenant);
    const now = new Date('2026-10-20T10:00:00.000Z');
    const first = issueReviewShare(store, { squadId: 'room-1', sessionKey: 's1', matchIds: ['m1'], presentationJson: '{"a":1}', now, kind: 'query' });
    await store.flush();
    const found = await PostgresReviewShareStore.find(pool, reviewShareTokenHash(first.token));
    assert.equal(found?.tenantId, tenant);
    assert.equal(found?.squadId, 'room-1');
    assert.deepEqual(found?.matchIds, ['m1']);
    assert.equal(reviewShareOpen(found!, new Date('2026-10-21T10:00:00.000Z')), true);
    assert.equal(reviewShareOpen(found!, new Date('2026-11-20T10:00:00.000Z')), false);

    const second = issueReviewShare(store, { squadId: 'room-1', sessionKey: 's1', matchIds: ['m2'], presentationJson: '{"a":2}', now: new Date('2026-10-20T10:05:00.000Z'), kind: 'query' });
    await store.flush();
    assert.notEqual((await PostgresReviewShareStore.find(pool, reviewShareTokenHash(first.token)))?.revokedAt, null);
    assert.equal((await PostgresReviewShareStore.find(pool, reviewShareTokenHash(second.token)))?.revokedAt, null);
    assert.equal(await PostgresReviewShareStore.find(pool, reviewShareTokenHash('x'.repeat(22))), null);
  } finally {
    await pool.end();
  }
});
