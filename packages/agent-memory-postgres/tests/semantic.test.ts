import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MemoryRecallService } from '@rine-kit/agent-memory';
import {
  enableMemoryVectorIndex,
  MemoryIndexGenerationManager,
  MemoryIndexWorker,
  memoryVectorAvailable,
  migrateMemoryDatabase,
  PostgresMemoryStore,
} from '../src/index.js';
import { auth, DATABASE_URL, fakeEmbedding, freshPool } from './helpers.js';

describe(
  'semantic recall on pgvector',
  { skip: !DATABASE_URL && 'MEMORY_TEST_DATABASE_URL not set' },
  () => {
    let db: Awaited<ReturnType<typeof freshPool>>;
    const embedding = fakeEmbedding({ dimensions: 128 });
    before(async () => {
      db = await freshPool('semantic');
      await migrateMemoryDatabase(db.pool);
      await db.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      assert.equal(await memoryVectorAvailable(db.pool), true);
      await enableMemoryVectorIndex(db.pool);
      await enableMemoryVectorIndex(db.pool); // idempotent
    });
    after(async () => {
      await db.drop();
    });

    async function drain(worker: MemoryIndexWorker): Promise<string[]> {
      const done: string[] = [];
      for (let i = 0; i < 50; i++) {
        const result = await worker.processOne();
        if (result === 'empty') break;
        done.push(result);
      }
      return done;
    }

    it('indexes writes in the background and degrades step by step when something is missing', async () => {
      const a = auth('user', 'sem', 'e1');
      const plain = new PostgresMemoryStore(db.pool);
      const store = new PostgresMemoryStore(db.pool, { embedding });
      await plain.create(a, { key: 'pet', content: 'owns a cat called Mochi' });
      await plain.create(a, { key: 'game', content: 'plays ranked every friday night' });
      await plain.create(auth('user', 'other', 'e2'), { key: 'pet', content: 'owns a cat' });

      // Before any vector exists the generation is not active: lexical only, with the reason.
      await store.withAuthorizedSearch(a, async (s) =>
        assert.deepEqual(await s.semantic('cat'), { matches: [], reason: 'semantic_unavailable' }),
      );

      const worker = new MemoryIndexWorker(db.pool, embedding);
      assert.deepEqual(await drain(worker), ['indexed', 'indexed', 'indexed']);
      const { rows } = await db.pool.query(
        'SELECT count(*)::int AS n FROM agent_memory_embeddings',
      );
      assert.equal(rows[0].n, 3);

      await store.withAuthorizedSearch(a, async (s) => {
        const { matches, reason } = await s.semantic('a cat named Mochi');
        assert.equal(reason, null);
        assert.ok(matches.length >= 1 && matches.length <= 2);
        assert.equal(matches[0]!.key, 'pet');
        assert.ok(matches[0]!.semanticSimilarity! > 0.5);
        assert.ok(matches.every((m) => m.content !== 'owns a cat')); // the other user's memory never appears
      });

      // The full recall service fuses all three sources.
      const recall = new MemoryRecallService<ReturnType<typeof auth>>({
        withAuthorizedSearch: (x, w) => store.withAuthorizedSearch(x, w),
        recordUsageSignals: (x, kind, list) => store.recordUsageSignals(x, kind, list),
      });
      const result = await recall.recall(a, 'owns a cat called Mochi');
      assert.equal(result.mode, 'hybrid');
      assert.equal(result.candidates[0]?.key, 'pet');
      assert.ok(result.candidates[0]!.sources.length >= 2);

      // A provider failure degrades to lexical with a reason instead of failing recall.
      const broken = new PostgresMemoryStore(db.pool, {
        embedding: {
          ...embedding,
          embedMany: async () => {
            throw new Error('agent_memory_embedding_timeout');
          },
        },
      });
      await broken.withAuthorizedSearch(a, async (s) =>
        assert.deepEqual(await s.semantic('cat'), { matches: [], reason: 'semantic_timeout' }),
      );
    });

    it('removes a forgotten memory from the vector index', async () => {
      const a = auth('user', 'sem2', 'f1');
      const store = new PostgresMemoryStore(db.pool, { embedding });
      await store.create(a, { key: 'secret_hobby', content: 'collects vintage keyboards' });
      const worker = new MemoryIndexWorker(db.pool, embedding);
      await drain(worker);
      await store.withAuthorizedSearch(a, async (s) =>
        assert.equal((await s.semantic('vintage keyboards')).matches.length, 1),
      );
      assert.equal(await store.forget(auth('user', 'sem2', 'f2'), 'secret_hobby'), true);
      assert.ok((await drain(worker)).includes('deleted'));
      const gone = await db.pool.query(
        `SELECT count(*)::int AS n FROM agent_memory_embeddings WHERE scope_key='sem2'`,
      );
      assert.equal(gone.rows[0].n, 0);
    });

    it('reindexes into a new generation without downtime', async () => {
      const a = auth('user', 'sem3', 'g1');
      const v1 = new PostgresMemoryStore(db.pool, { embedding });
      await v1.create(a, { key: 'drink', content: 'prefers green tea' });
      await drain(new MemoryIndexWorker(db.pool, embedding));
      const next = fakeEmbedding({ dimensions: 128, modelId: 'bag-of-words-2', indexVersion: 2 });
      const manager = new MemoryIndexGenerationManager(db.pool);
      await manager.beginShadowReindex('rine', next.contract);
      assert.equal((await manager.scanNextPage('rine', 100)).complete, true);
      // Old generation keeps serving while the new one is built.
      await v1.withAuthorizedSearch(a, async (s) =>
        assert.equal((await s.semantic('green tea')).reason, null),
      );
      await assert.rejects(manager.activate('rine'), /missing_vectors/);
      await drain(new MemoryIndexWorker(db.pool, next));
      await manager.activate('rine');
      const v2 = new PostgresMemoryStore(db.pool, { embedding: next });
      await v2.withAuthorizedSearch(a, async (s) =>
        assert.equal((await s.semantic('green tea')).reason, null),
      );
      await v1.withAuthorizedSearch(a, async (s) =>
        assert.equal((await s.semantic('green tea')).reason, 'semantic_unavailable'),
      );
    });
  },
);

describe('without pgvector', { skip: !DATABASE_URL && 'MEMORY_TEST_DATABASE_URL not set' }, () => {
  it('still stores and recalls (exact + lexical) and says why semantic is off', async () => {
    const db = await freshPool('novector');
    try {
      await migrateMemoryDatabase(db.pool); // the vector table is simply never created here
      const embedding = fakeEmbedding();
      const store = new PostgresMemoryStore(db.pool, { embedding });
      const a = auth('user', 'plain', 'h1');
      await store.create(a, { key: 'pet', content: 'owns a cat' });
      const worker = new MemoryIndexWorker(db.pool, embedding);
      assert.equal(await worker.processOne(), 'semantic_unconfigured'); // job waits, nothing breaks
      await store.withAuthorizedSearch(a, async (s) => {
        assert.deepEqual(await s.semantic('cat'), {
          matches: [],
          reason: 'vector_index_unavailable',
        });
        assert.deepEqual(
          (await s.lexical('cat')).map((e) => e.key),
          ['pet'],
        );
      });
    } finally {
      await db.drop();
    }
  });
});
