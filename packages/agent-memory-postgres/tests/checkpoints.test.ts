import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildWorkingContext } from '@rine-kit/agent-memory';
import {
  loadConversationCheckpoint,
  migrateMemoryDatabase,
  refreshConversationCheckpoint,
} from '../src/index.js';
import { DATABASE_URL, freshPool } from './helpers.js';

const rows = (n: number, text = '早些时候聊到的内容') =>
  Array.from({ length: n }, (_, i) => ({
    sourceEventId: `e${i}`,
    speakerKind: i % 2 ? 'assistant' : 'human',
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    content: `${text}${i}`,
  })).reverse();

describe(
  'rolling conversation checkpoints',
  { skip: !DATABASE_URL && 'MEMORY_TEST_DATABASE_URL not set' },
  () => {
    let db: Awaited<ReturnType<typeof freshPool>>;
    before(async () => {
      db = await freshPool('checkpoints');
      await migrateMemoryDatabase(db.pool);
    });
    after(async () => {
      await db.drop();
    });

    it('stores one checkpoint per conversation, moves the generation only when the covered rows change', async () => {
      const scope = { namespace: 'rine', conversationKey: 'room:r1' };
      assert.equal(await loadConversationCheckpoint(db.pool, scope), null);
      await refreshConversationCheckpoint(db.pool, scope, rows(5));
      const first = await loadConversationCheckpoint(db.pool, scope);
      assert.equal(first?.generation, 1);
      assert.equal(first?.coveredMessageCount, 5);
      await refreshConversationCheckpoint(db.pool, scope, rows(5)); // same rows: same generation
      assert.equal((await loadConversationCheckpoint(db.pool, scope))?.generation, 1);
      await refreshConversationCheckpoint(db.pool, scope, rows(6)); // more history: next generation
      assert.equal((await loadConversationCheckpoint(db.pool, scope))?.generation, 2);
      assert.equal(
        await loadConversationCheckpoint(db.pool, {
          namespace: 'rine',
          conversationKey: 'room:r2',
        }),
        null,
      );
    });

    it('feeds the budgeted working context as low-trust data with its provenance', async () => {
      const scope = { namespace: 'rine', conversationKey: 'room:r3' };
      await refreshConversationCheckpoint(db.pool, scope, rows(30));
      const checkpoint = await loadConversationCheckpoint(db.pool, scope);
      const context = buildWorkingContext(
        {
          turns: [{ role: 'user', content: '最近的一句' }],
          currentQuoteContext: null,
          rollingCheckpoint: checkpoint,
        },
        '现在的问题',
      );
      assert.match(context.episodicSummaryContext ?? '', /低信任原文片段/u);
      assert.equal(context.episodicSummarySourceEventIds.length, checkpoint?.sourceEventIds.length);
      assert.equal(context.turns[0]?.content, '最近的一句');
    });
  },
);
