import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

const MIGRATIONS = [
  '0001_memory_foundation.sql',
  '0002_memory_embedding_index.sql',
  '0003_memory_dreaming_runs.sql',
  '0004_memory_consolidation.sql',
  '0005_memory_conversation_checkpoints.sql',
] as const;
const VECTOR_MIGRATIONS = ['vector/0001_memory_pgvector.sql'] as const;
const LOCK_ID = 7192041302;

async function apply(pool: Pool, ids: readonly string[], ledger: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS agent_memory_schema_migrations (
      migration_id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    for (const id of ids) {
      const key = `${ledger}${id}`;
      if (
        (
          await client.query('SELECT 1 FROM agent_memory_schema_migrations WHERE migration_id=$1', [
            key,
          ])
        ).rowCount
      )
        continue;
      const sql = await readFile(new URL(`../migrations/${id}`, import.meta.url), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO agent_memory_schema_migrations(migration_id) VALUES ($1)', [
        key,
      ]);
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

/** Creates or upgrades the memory tables. Needs nothing but built-in PostgreSQL types. */
export function migrateMemoryDatabase(pool: Pool): Promise<void> {
  return apply(pool, MIGRATIONS, '');
}

/** Whether the vector extension is installed (semantic recall can only work if it is). */
export async function memoryVectorAvailable(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector') AS ok`,
  );
  return result.rows[0]?.ok === true;
}

/**
 * Creates the embeddings table. Requires the `vector` extension to be installed by an operator first;
 * without it nothing else breaks and recall stays exact + lexical.
 */
export function enableMemoryVectorIndex(pool: Pool): Promise<void> {
  return apply(pool, VECTOR_MIGRATIONS, 'vector:');
}
