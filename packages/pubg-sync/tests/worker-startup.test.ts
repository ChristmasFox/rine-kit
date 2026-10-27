import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { migratePubgDatabase } from '@rine-kit/pubg-postgres';
import { publicSyncWorkerMain } from '../src/index.js';
import { DATABASE_URL } from './helpers.js';

const skip = !DATABASE_URL;

/** A connection string whose search_path is one scratch schema. */
function urlFor(schema: string): string {
  const url = new URL(DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

function workerEnv(schema: string, port: number): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: urlFor(schema),
    PUBLIC_PUBG_API_KEY: 'fixture-only',
    PUBLIC_SYNC_HEALTH_PORT: String(port),
    PUBG_SAAS_WORKER_METRICS_PORT: String(port + 1),
    PUBLIC_SYNC_INTERVAL_MS: '60000',
  };
}

async function scratch() {
  const admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const schema = `worker_startup_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: urlFor(schema), max: 2 });
  return { schema, pool, close: async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
}

const applied = async (pool: Pool) =>
  (await pool.query<{ migration_id: string }>('SELECT migration_id FROM pubg_schema_migrations ORDER BY 1')).rows.map((r) => r.migration_id);

test('a worker started before the host migrated brings the schema up to date itself and runs, instead of exiting', { skip }, async () => {
  const { schema, pool, close } = await scratch();
  try {
    // The real case: the database is one migration behind (the host has not started yet to apply it).
    await migratePubgDatabase(pool);
    await pool.query("DELETE FROM pubg_schema_migrations WHERE migration_id='0004_sync_job_dirty.sql'");
    await pool.query('ALTER TABLE pubg_sync_jobs DROP COLUMN dirty_at');

    await publicSyncWorkerMain(['--apply', '--once'], workerEnv(schema, 38410));

    assert.ok((await applied(pool)).includes('0004_sync_job_dirty.sql'), 'the missing migration was applied');
    const column = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='pubg_sync_jobs' AND column_name='dirty_at'", [schema]);
    assert.equal(column.rowCount, 1);
  } finally {
    await close();
  }
});

test('a worker started on an empty database creates the schema; the host and the worker may start together', { skip }, async () => {
  const { schema, pool, close } = await scratch();
  try {
    // Two workers and the host's own migration all at once: the advisory lock serialises them, none fails.
    await Promise.all([
      publicSyncWorkerMain(['--apply', '--once'], workerEnv(schema, 38420)),
      publicSyncWorkerMain(['--apply', '--once'], workerEnv(schema, 38430)),
      migratePubgDatabase(pool),
    ]);
    assert.deepEqual(await applied(pool), [
      '0001_pubg_schema.sql',
      '0002_pubg_account_claims.sql',
      '0003_review_shares.sql',
      '0004_sync_job_dirty.sql',
    ]);
  } finally {
    await close();
  }
});

test('the health port is configurable and validated', { skip }, async () => {
  const { schema, close } = await scratch();
  try {
    await assert.rejects(publicSyncWorkerMain(['--apply', '--once'], { ...workerEnv(schema, 38440), PUBLIC_SYNC_HEALTH_PORT: '99999' }), /pubg_saas_worker_config_invalid/u);
  } finally {
    await close();
  }
});
