import assert from 'node:assert/strict';
import test from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { AiSdkConsolidationPlanner } from '../src/index.js';

const toolCall = (input: unknown) => ({
  content: [
    {
      type: 'tool-call' as const,
      toolCallId: 'c1',
      toolName: 'submit_memory_candidates',
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});

test('the planner returns validated candidates from the forced tool call and nothing for garbage', async () => {
  const good = {
    candidates: [
      {
        confidence: 'high',
        subject: 'self',
        kind: 'stable_preference',
        key: 'role',
        content: '我玩辅助',
        evidence: '我玩辅助',
        validity: 'stable',
      },
    ],
  };
  const model = new MockLanguageModelV4({ doGenerate: async () => toolCall(good) as never });
  const planner = new AiSdkConsolidationPlanner(model);
  const signal = new AbortController().signal;
  const out = await planner.plan(
    { workflow: 'light', messages: [{ content: '我玩辅助', createdAt: '2026-10-01T00:00:00Z' }] },
    signal,
  );
  assert.equal(out.length, 1);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(model.doGenerateCalls[0]!.toolChoice?.type, 'tool');

  const bad = new AiSdkConsolidationPlanner(
    new MockLanguageModelV4({
      doGenerate: async () => toolCall({ candidates: [{ nope: 1 }] }) as never,
    }),
  );
  assert.deepEqual(
    await bad.plan(
      { workflow: 'rem', messages: [{ content: 'x', createdAt: '2026-10-01T00:00:00Z' }] },
      signal,
    ),
    [],
  );
  const broken = new AiSdkConsolidationPlanner(
    new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('down');
      },
    }),
  );
  assert.deepEqual(
    await broken.plan(
      { workflow: 'rem', messages: [{ content: 'x', createdAt: '2026-10-01T00:00:00Z' }] },
      signal,
    ),
    [],
  );
  // No messages: the model is not even called.
  assert.deepEqual(await planner.plan({ workflow: 'light', messages: [] }, signal), []);
  assert.equal(model.doGenerateCalls.length, 1);
});
