import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { MemoryEmbeddingClient } from '@rine-kit/agent-memory';
import type { MemoryAuthorization } from '../src/index.js';

export const DATABASE_URL = process.env.MEMORY_TEST_DATABASE_URL;

/** A throwaway database inside the test server, so every test file starts clean. */
export async function freshPool(name: string): Promise<{ pool: Pool; drop(): Promise<void> }> {
  const admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const db = `mem_${name}_${process.pid}_${Date.now() % 100000}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${db}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  pool.on('error', () => undefined); // dropping the database kills idle connections
  return {
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export const auth = (
  kind: string,
  key: string,
  eventId: string,
  receivedAt = new Date(),
  namespace = 'rine',
): MemoryAuthorization => ({ scope: { namespace, kind, key }, eventId, receivedAt });

/** Deterministic unit vectors: texts that share words are close, which is all semantic tests need. */
export function fakeEmbedding(
  over: { dimensions?: number; modelId?: string; indexVersion?: number } = {},
): MemoryEmbeddingClient {
  const dimensions = over.dimensions ?? 16;
  const contract = {
    providerId: 'fake',
    modelId: over.modelId ?? 'bag-of-words',
    dimensions,
    normalization: 'l2_unit' as const,
    indexVersion: over.indexVersion ?? 1,
  };
  const vectorOf = (text: string) => {
    const v = new Array<number>(dimensions).fill(0);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      v[createHash('sha256').update(word).digest()[0]! % dimensions]! += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  };
  return {
    contract,
    dailyTokenBudget: 1_000_000,
    dailyRequestBudget: 10_000,
    async embedMany(values) {
      return {
        contract,
        vectors: values.map(vectorOf),
        contentHashes: values.map((v) => createHash('sha256').update(v).digest('hex')),
        inputTokens: values.reduce((s, v) => s + v.length, 0),
      };
    },
  };
}
