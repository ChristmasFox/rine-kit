import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MemoryRecallService, MemoryWriteService } from '@rine-kit/agent-memory';
import { migrateMemoryDatabase, PostgresMemoryStore } from '../src/index.js';
import { auth, DATABASE_URL, freshPool } from './helpers.js';

describe(
  'PostgresMemoryStore',
  { skip: !DATABASE_URL && 'MEMORY_TEST_DATABASE_URL not set' },
  () => {
    let db: Awaited<ReturnType<typeof freshPool>>;
    let store: PostgresMemoryStore;
    before(async () => {
      db = await freshPool('store');
      await migrateMemoryDatabase(db.pool);
      await migrateMemoryDatabase(db.pool); // idempotent
      store = new PostgresMemoryStore(db.pool);
    });
    after(async () => {
      await db.drop();
    });

    const mei = (event: string, at = new Date()) => auth('user', 'mei', event, at);

    it('creates, rejects a duplicate key, revises with a revision fence and keeps scopes apart', async () => {
      assert.equal(
        await store.create(
          mei('e1'),
          { key: 'Main Role', content: '常玩辅助位' },
          { sourceKind: 'user_confirmed' },
        ),
        'created',
      );
      assert.equal(
        await store.create(mei('e2'), { key: 'main role', content: 'other' }),
        'already_exists',
      );
      const state = await store.getWriteState(mei('e3'), 'main_role');
      assert.deepEqual([state?.revision, state?.content, state?.revoked], [1, '常玩辅助位', false]);
      assert.equal(
        await store.revise(mei('e4'), { key: 'main_role', content: '改玩狙击' }, 7),
        false,
      ); // stale revision
      assert.equal(
        await store.revise(mei('e5'), { key: 'main_role', content: '改玩狙击' }, 1),
        true,
      );
      assert.equal((await store.getWriteState(mei('e6'), 'main_role'))?.revision, 2);
      // Another person, another room, another namespace see nothing.
      assert.equal(await store.getWriteState(auth('user', 'ken', 'x'), 'main_role'), null);
      assert.equal(await store.getWriteState(auth('room', 'mei', 'x'), 'main_role'), null);
      assert.equal(
        await store.getWriteState(auth('user', 'mei', 'x', new Date(), 'other-agent'), 'main_role'),
        null,
      );
    });

    it('finds memories exactly and lexically, in English and Chinese, only inside the scope', async () => {
      const a = auth('user', 'finder', 'f1');
      await store.create(a, { key: 'pet', content: 'has a cat named Mochi' });
      await store.create(a, { key: 'game_time', content: '周五晚上开黑' });
      await store.create(auth('user', 'someone', 'f2'), { key: 'pet', content: 'has a dog' });
      await store.withAuthorizedSearch(a, async (s) => {
        assert.deepEqual(
          (await s.exact('pet')).map((e) => e.key),
          ['pet'],
        );
        assert.deepEqual(
          (await s.exact('周五晚上开黑')).map((e) => e.key),
          ['game_time'],
        );
        assert.deepEqual(
          (await s.lexical('cat Mochi')).map((e) => e.content),
          ['has a cat named Mochi'],
        );
        assert.deepEqual(
          (await s.lexical('周五')).map((e) => e.key),
          ['game_time'],
        );
        assert.deepEqual(await s.lexical('submarine'), []);
        assert.deepEqual(await s.semantic('cat'), { matches: [], reason: 'semantic_unconfigured' });
      });
    });

    it('forgets with a tombstone, and only a later event can bring it back', async () => {
      const early = new Date(Date.now() - 60_000);
      const a = auth('user', 'forgetter', 'g1', early);
      await store.create(a, { key: 'diet', content: 'vegetarian' });
      assert.equal(await store.forget(auth('user', 'forgetter', 'g2'), 'diet', 99), false); // wrong revision
      assert.equal(await store.forget(auth('user', 'forgetter', 'g2'), 'diet', 1), true);
      const tomb = await store.getWriteState(a, 'diet');
      assert.deepEqual([tomb?.revoked, tomb?.content, tomb?.revision], [true, '', 2]);
      await store.withAuthorizedSearch(a, async (s) => assert.deepEqual(await s.exact('diet'), []));
      // An event received before the revocation cannot restore it; a later one can.
      assert.equal(
        await store.rememberAgain(
          auth('user', 'forgetter', 'g3', early),
          { key: 'diet', content: 'vegan' },
          2,
        ),
        false,
      );
      assert.equal(
        await store.rememberAgain(
          auth('user', 'forgetter', 'g4', new Date(Date.now() + 5_000)),
          { key: 'diet', content: 'vegan' },
          2,
        ),
        true,
      );
      assert.equal((await store.getWriteState(a, 'diet'))?.content, 'vegan');
    });

    it('runs the generic recall and write services over it', async () => {
      const a = auth('user', 'service', 's1');
      const writes = new MemoryWriteService(store);
      assert.deepEqual(
        await writes.remember(
          a,
          { operation: 'remember', key: 'Role', content: 'plays support' },
          { sourceEventId: 's1' },
        ),
        { status: 'created' },
      );
      assert.deepEqual(
        await writes.remember(
          a,
          { operation: 'remember', key: 'role', content: 'plays support' },
          { sourceEventId: 's2' },
        ),
        { status: 'already_present' },
      );
      const signals: string[] = [];
      const recall = new MemoryRecallService<ReturnType<typeof auth>>({
        withAuthorizedSearch: (x, w) => store.withAuthorizedSearch(x, w),
        recordUsageSignals: async (x, kind, list) => {
          signals.push(kind);
          await store.recordUsageSignals(x, kind, list);
        },
      });
      const result = await recall.recall(a, 'what role does he play support');
      assert.equal(result.mode, 'lexical_only');
      assert.equal(result.reason, 'semantic_unconfigured');
      assert.deepEqual(
        result.candidates.map((c) => c.key),
        ['role'],
      ); // keys are canonicalised
      assert.deepEqual(signals, ['recalled']);
      const { rows } = await db.pool.query(
        `SELECT signal_kind,count(*)::int AS n FROM agent_memory_usage_signals WHERE scope_key='service' GROUP BY 1`,
      );
      assert.deepEqual(rows, [{ signal_kind: 'recalled', n: 1 }]);
      assert.deepEqual(await writes.forget(a, { key: 'role' }, { sourceEventId: 's3' }), {
        status: 'forgotten',
      });
      // Forgetting removes the usage evidence too.
      const left = await db.pool.query(
        `SELECT count(*)::int AS n FROM agent_memory_usage_signals WHERE scope_key='service'`,
      );
      assert.equal(left.rows[0].n, 0);
    });

    it('refuses a scope with a malformed kind and runs the host re-check before every operation', async () => {
      await assert.rejects(
        store.listRecent(auth('User Scope', 'x', 'e')),
        /agent_memory_scope_invalid/,
      );
      const guarded = new PostgresMemoryStore(db.pool, {
        authorize: (a) => {
          if (a.scope.key === 'revoked') throw new Error('revoked');
        },
      });
      await assert.rejects(guarded.listRecent(auth('user', 'revoked', 'e')), /revoked/);
      await assert.doesNotReject(guarded.listRecent(auth('user', 'fine', 'e')));
    });
  },
);
