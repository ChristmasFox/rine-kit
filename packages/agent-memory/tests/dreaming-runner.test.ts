import assert from 'node:assert/strict';
import test from 'node:test';
import { runMemoryDreamingStages } from '../src/dreaming/runner.js';

test('generic Dreaming drains bounded Light and REM batches before Deep', async () => {
  const calls: string[] = [];
  const counts = { light: 0, rem: 0 };
  const runner = {
    async processNext(stage: 'light' | 'rem') {
      calls.push(stage);
      counts[stage] += 1;
      return counts[stage] <= 2 ? ('processed' as const) : ('skipped' as const);
    },
    async processDeep() {
      calls.push('deep');
      return { status: 'processed' as const, processed: 3 };
    },
  };
  let clock = 0;
  const report = await runMemoryDreamingStages(runner, new AbortController().signal, {
    maxLightBatches: 2,
    maxRemBatches: 2,
    now: () => new Date(Date.parse('2026-10-16T03:00:00.000Z') + clock++ * 1_000),
  });
  assert.deepEqual(calls, ['light', 'light', 'rem', 'rem', 'deep']);
  assert.deepEqual(report.stages, [
    { stage: 'light', status: 'completed', processed: 2 },
    { stage: 'rem', status: 'completed', processed: 2 },
    { stage: 'deep', status: 'completed', processed: 3 },
  ]);
});

test('generic Dreaming never proceeds past a failed stage', async () => {
  const calls: string[] = [];
  await assert.rejects(
    runMemoryDreamingStages(
      {
        async processNext(stage) {
          calls.push(stage);
          return 'retry';
        },
        async processDeep() {
          calls.push('deep');
          return { status: 'processed', processed: 1 };
        },
      },
      new AbortController().signal,
    ),
    /memory_dreaming_light_failed/,
  );
  assert.deepEqual(calls, ['light']);
});
