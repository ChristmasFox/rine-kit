import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExtractiveCheckpoint,
  MAX_CHECKPOINT_TOKENS,
  estimateContextTokens,
} from '../src/index.js';

const row = (i: number, speakerKind = i % 2 ? 'assistant' : 'human', content = `第${i}条消息`) => ({
  sourceEventId: `e${i}`,
  speakerKind,
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  content,
});

test('an extractive checkpoint covers the older rows chronologically with provenance and no model', () => {
  const newestFirst = [row(3), row(2), row(1)];
  const checkpoint = buildExtractiveCheckpoint(newestFirst)!;
  assert.equal(
    checkpoint.text,
    '助手说：第1条消息\n成员说：第2条消息\n助手说：第3条消息'.replace(
      '助手说：第1条',
      '助手说：第1条',
    ),
  );
  assert.equal(checkpoint.coverageFrom, row(1).createdAt);
  assert.equal(checkpoint.coverageThrough, row(3).createdAt);
  assert.equal(checkpoint.coveredMessageCount, 3);
  assert.deepEqual(checkpoint.sourceEventIds, ['e1', 'e2', 'e3']);
  assert.match(checkpoint.sourceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(buildExtractiveCheckpoint([]), null);
});

test('the digest changes only when the covered rows change, and unknown speakers are not quoted', () => {
  const a = buildExtractiveCheckpoint([row(2), row(1)])!;
  assert.equal(buildExtractiveCheckpoint([row(2), row(1)])!.sourceDigest, a.sourceDigest);
  assert.notEqual(
    buildExtractiveCheckpoint([row(2, 'human', 'edited'), row(1)])!.sourceDigest,
    a.sourceDigest,
  );
  const system = buildExtractiveCheckpoint([row(2, 'system'), row(1)])!;
  assert.deepEqual(system.sourceEventIds, ['e1']);
});

test('the checkpoint is capped in tokens and rows however much history there is', () => {
  const rows = Array.from({ length: 500 }, (_, i) =>
    row(i, 'human', '很长的历史内容。'.repeat(50)),
  );
  const checkpoint = buildExtractiveCheckpoint(rows.reverse())!;
  assert.ok(estimateContextTokens(checkpoint.text) <= MAX_CHECKPOINT_TOKENS);
  assert.ok(checkpoint.coveredMessageCount <= 100);
  assert.ok(checkpoint.sourceEventIds.length <= 48);
});
