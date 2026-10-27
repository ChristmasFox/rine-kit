import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

const MIGRATIONS = ['0001_pubg_schema.sql', '0002_pubg_account_claims.sql', '0003_review_shares.sql', '0004_sync_job_dirty.sql'] as const;
const LOCK_ID = 7192041303;

/** Applies the schema to an empty or existing database; safe to run on every start. */
export async function migratePubgDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS pubg_schema_migrations (
      migration_id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    for (const id of MIGRATIONS) {
      const applied = await client.query('SELECT 1 FROM pubg_schema_migrations WHERE migration_id=$1', [id]);
      if (applied.rowCount) continue;
      const sql = await readFile(new URL(`../migrations/${id}`, import.meta.url), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO pubg_schema_migrations(migration_id) VALUES ($1)', [id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* keep the migration error */
  }
}
