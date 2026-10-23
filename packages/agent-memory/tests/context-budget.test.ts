import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkingContext,
  DEFAULT_CONTEXT_BUDGET_POLICY,
  estimateContextTokens,
} from '../src/index.js';

test('working context keeps a stable conservative budget across 10, 1,000, and 10,000 synthetic turns', () => {
  const currentMessage = '这个问题必须原样保留。';
  for (const count of [10, 1_000, 10_000]) {
    const turns = Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `消息 ${index}: 这是一段用于预算回归的合成中文历史，包含一些 English terms 和 emoji 👩‍🚀。`,
    }));
    const context = buildWorkingContext(
      {
        turns,
        currentSpeakerLabel: '成员1',
        currentQuoteContext: `引用目标消息 quote-123，来自成员2：${'较早的引用内容。'.repeat(10_000)}`,
      },
      currentMessage,
    );

    assert.equal(context.currentMessage, currentMessage);
    assert.ok(context.turns.length > 0);
    assert.equal(context.turns.at(-1)?.content, turns.at(-1)?.content);
    assert.ok(context.estimatedRecentTokens <= DEFAULT_CONTEXT_BUDGET_POLICY.recentTurnsTokens);
    assert.ok(context.estimatedQuoteTokens <= DEFAULT_CONTEXT_BUDGET_POLICY.quotedMessageTokens);
    assert.ok(
      estimateContextTokens(context.currentMessage) <= context.estimatedCurrentMessageTokens,
    );
    assert.equal(context.estimateMethod, 'conservative_unicode_char_v1');
    assert.match(context.currentQuoteContext ?? '', /quote-123/u);
    assert.match(context.currentQuoteContext ?? '', /截断/u);
  }
});

test('working context skips an oversized historic turn without cutting the current question', () => {
  const currentMessage = '请完整保留这条当前问题，不要截断。';
  const context = buildWorkingContext(
    {
      turns: [
        { role: 'user', content: 'small older detail' },
        { role: 'assistant', content: 'oversized'.repeat(20_000) },
        { role: 'user', content: 'most recent useful detail' },
      ],
      currentSpeakerLabel: '成员1',
      currentQuoteContext: null,
    },
    currentMessage,
    { ...DEFAULT_CONTEXT_BUDGET_POLICY, recentTurnsTokens: 40 },
  );

  assert.deepEqual(
    context.turns.map((turn) => turn.content),
    ['small older detail', 'most recent useful detail'],
  );
  assert.equal(context.currentMessage, currentMessage);
});

test('rolling checkpoint stays low-trust, provenance-carrying data inside the provider reserve', () => {
  const context = buildWorkingContext(
    {
      turns: [
        { role: 'user', content: '较早的近期对话'.repeat(800) },
        { role: 'assistant', content: '更新的近期对话'.repeat(800) },
      ],
      currentSpeakerLabel: '成员1',
      currentQuoteContext: null,
      rollingCheckpoint: {
        text: `较早的原文摘录。${'旧讨论内容'.repeat(2_000)}`,
        generation: 4,
        coverageFrom: '2026-10-15T10:00:00.000Z',
        coverageThrough: '2026-10-15T11:00:00.000Z',
        coveredMessageCount: 100,
        sourceEventIds: ['source-a', 'source-b'],
      },
    },
    '请保留当前问题',
    {
      ...DEFAULT_CONTEXT_BUDGET_POLICY,
      estimatedProviderContextTokens: 15_000,
      systemAndToolSchemaReserveTokens: 4_000,
      toolResultReserveTokens: 5_000,
      finalAnswerReserveTokens: 2_000,
    },
  );

  assert.equal(context.currentMessage, '请保留当前问题');
  assert.equal(context.episodicSummarySourceEventIds.join(','), 'source-a,source-b');
  assert.ok(context.estimatedRecentTokens <= DEFAULT_CONTEXT_BUDGET_POLICY.recentTurnsTokens);
  assert.ok(
    context.estimatedEpisodicSummaryTokens <= DEFAULT_CONTEXT_BUDGET_POLICY.episodicSummaryTokens,
  );
  assert.ok(context.estimatedTotalContextTokens <= 15_000);
  assert.match(context.episodicSummaryContext ?? '', /低信任原文片段/u);
  assert.match(context.episodicSummaryContext ?? '', /第 4 代/u);
});

test('long-term memory is bounded by its dedicated context slot and remains separate from history', () => {
  const memory = `不可信长期记忆参考：${'偏好事实'.repeat(2_000)}`;
  const context = buildWorkingContext(
    {
      turns: [{ role: 'user', content: '近期对话' }],
      currentSpeakerLabel: '成员1',
      currentQuoteContext: null,
    },
    '今天聊什么？',
    DEFAULT_CONTEXT_BUDGET_POLICY,
    memory,
  );

  assert.match(context.longTermMemoryContext ?? '', /不可信长期记忆参考/u);
  assert.match(context.longTermMemoryContext ?? '', /截断/u);
  assert.ok(
    context.estimatedLongTermMemoryTokens <= DEFAULT_CONTEXT_BUDGET_POLICY.longTermRecallTokens,
  );
  assert.ok(
    context.estimatedTotalContextTokens <=
      DEFAULT_CONTEXT_BUDGET_POLICY.estimatedProviderContextTokens,
  );
  assert.equal(context.turns[0]?.content, '近期对话');
});
