import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryPolicyError,
  fuseMemoryCandidates,
  memorySearchTokens,
  rankMemoryEntries,
  validateMemoryDraft,
} from '../src/index.js';
import type { MemoryEntry } from '../src/index.js';

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    key: 'favorite_map',
    content: '我常去艾伦格的森林区域',
    revision: 2,
    updatedAt: '2026-10-16T00:00:00.000Z',
    sourceEventId: 'evidence-1',
    sourceKind: 'user_confirmed',
    sourceReliability: 95,
    validUntil: null,
    ...overrides,
  };
}

test('memory drafts normalize keys, trim content, and reject unsafe controls', () => {
  assert.deepEqual(validateMemoryDraft({ key: ' Favorite_Map ', content: ' Erangel ' }), {
    key: 'favorite_map',
    content: 'Erangel',
  });
  assert.deepEqual(validateMemoryDraft({ key: 'emoji', content: '一家人👨‍👩‍👧、猫🐈️' }), {
    key: 'emoji',
    content: '一家人👨‍👩‍👧、猫🐈️',
  });
  assert.throws(
    () => validateMemoryDraft({ key: 'x', content: 'x'.repeat(801) }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'input_invalid',
  );
  assert.throws(
    () => validateMemoryDraft({ key: 'x', content: 'a\u200bb' }),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'input_invalid',
  );
});

test('script-aware lexical tokens and deterministic fallback ranking are reusable', () => {
  assert.deepEqual(memorySearchTokens('abc中文'), ['abc', '中文']);
  assert.deepEqual(memorySearchTokens('猫'), []);
  assert.deepEqual(memorySearchTokens('🐈'), []);
  const facts = [
    entry(),
    entry({ key: 'favorite_map', content: 'Erangel 森林跳点', revision: 3 }),
    entry({ key: 'sport', content: '每周踢足球', sourceEventId: 'evidence-2' }),
  ];
  assert.deepEqual(
    rankMemoryEntries(facts, '艾伦格森林').map((item) => item.revision),
    [2, 3],
  );
  assert.deepEqual(
    rankMemoryEntries(facts, '踢足球').map((item) => item.key),
    ['sport'],
  );
  assert.throws(
    () => rankMemoryEntries([], 'query', 25),
    (error: unknown) => error instanceof MemoryPolicyError && error.code === 'limit_invalid',
  );
});

test('recall fusion keeps current revisions and rejects expired or unknown facts', () => {
  const current = entry({ revision: 3, semanticSimilarity: 0.95 });
  const result = fuseMemoryCandidates(
    'Erangel forest',
    [entry({ revision: 2 })],
    [current],
    [
      current,
      entry({ key: 'old', validUntil: '2020-01-01T00:00:00.000Z' }),
      entry({ key: 'unknown', sourceKind: 'unknown' }),
    ],
    { topK: 6, semanticSimilarityThreshold: 0.72, minimumScore: 0.005 },
    new Date('2026-10-16T00:00:00.000Z'),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.revision, 3);
  assert.ok(result[0]?.sources.includes('semantic'));
  assert.equal(result[0]?.sourceEventId, 'evidence-1');
});
