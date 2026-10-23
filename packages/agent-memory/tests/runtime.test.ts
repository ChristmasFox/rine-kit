import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentMemoryRuntime } from '../src/runtime.js';
import type {
  DreamingReport,
  MemoryObservation,
  MemoryRetrievedCandidate,
} from '../src/contracts.js';

const candidate: MemoryRetrievedCandidate = {
  canonicalKey: 'map',
  key: 'map',
  content: 'Erangel',
  revision: 1,
  updatedAt: '2026-10-01T00:00:00.000Z',
  sourceEventId: 'event-1',
  sourceKind: 'user_confirmed',
  score: 0.8,
  sources: ['exact'],
  reasons: ['fixture'],
};
const observation: MemoryObservation = {
  content: '我喜欢 Erangel',
  observedAt: '2026-10-01T00:00:00.000Z',
  evidence: [{ id: 'event-1', observedAt: '2026-10-01T00:00:00.000Z', source: 'conversation' }],
};
const report: DreamingReport = {
  startedAt: '2026-10-02T03:00:00.000Z',
  completedAt: '2026-10-02T03:01:00.000Z',
  stages: [
    { stage: 'light', status: 'completed', processed: 1 },
    { stage: 'rem', status: 'skipped', processed: 0 },
    { stage: 'deep', status: 'completed', processed: 1 },
  ],
};

test('memory runtime defaults enabled and routes every operation through host adapters', async () => {
  const seen: string[] = [];
  const runtime = new AgentMemoryRuntime({
    adapters: {
      observe: async (auth, turn) => {
        seen.push(`observe:${auth}:${turn.content}`);
      },
      recall: {
        async recall(auth, request) {
          seen.push(`recall:${auth}:${request.query}`);
          return {
            mode: 'hybrid',
            reason: null,
            candidates: [candidate],
            context: 'fixture-context',
          };
        },
        async recordUsed(auth, query, candidates) {
          seen.push(`used:${auth}:${query}:${candidates.length}`);
        },
      },
      writes: {
        async remember(auth, write) {
          seen.push(`remember:${auth}:${write.key}`);
          return { status: 'created' };
        },
        async forget(auth, request) {
          seen.push(`forget:${auth}:${request.key}`);
          return { status: 'forgotten' };
        },
      },
      async runDreaming() {
        seen.push('dreaming');
        return report;
      },
    },
  });

  await runtime.observe('scope-a', observation);
  assert.deepEqual(await runtime.recall('scope-a', { query: 'map' }), {
    mode: 'hybrid',
    reason: null,
    candidates: [candidate],
    context: 'fixture-context',
  });
  await runtime.recordUsed('scope-a', 'map', [candidate]);
  assert.deepEqual(
    await runtime.remember('scope-a', { operation: 'remember', key: 'map', content: 'Erangel' }),
    { status: 'created' },
  );
  assert.deepEqual(await runtime.forget('scope-a', { key: 'map' }), { status: 'forgotten' });
  assert.deepEqual(await runtime.runDreaming(), report);
  assert.deepEqual(await runtime.health(), {
    status: 'ready',
    lastDreamingAt: report.completedAt,
    reason: null,
  });
  assert.deepEqual(seen, [
    'observe:scope-a:我喜欢 Erangel',
    'recall:scope-a:map',
    'used:scope-a:map:1',
    'remember:scope-a:map',
    'forget:scope-a:map',
    'dreaming',
  ]);
});

test('explicitly disabled features short-circuit without invoking adapters', async () => {
  let calls = 0;
  const runtime = new AgentMemoryRuntime({
    features: { read: false, write: false, autoLearn: false },
    adapters: {
      observe: async () => {
        calls += 1;
      },
      recall: {
        async recall() {
          calls += 1;
          throw new Error('must not recall');
        },
        async recordUsed() {
          calls += 1;
        },
      },
      writes: {
        async remember() {
          calls += 1;
          return { status: 'created' };
        },
        async forget() {
          calls += 1;
          return { status: 'forgotten' };
        },
      },
      async runDreaming() {
        calls += 1;
        return report;
      },
    },
  });

  await runtime.observe('scope-a', observation);
  assert.equal((await runtime.recall('scope-a', { query: 'map' })).reason, 'disabled_by_operator');
  await runtime.recordUsed('scope-a', 'map', [candidate]);
  assert.deepEqual(
    await runtime.remember('scope-a', { operation: 'remember', key: 'map', content: 'Erangel' }),
    { status: 'not_found' },
  );
  assert.deepEqual(await runtime.forget('scope-a', { key: 'map' }), { status: 'not_found' });
  assert.equal(
    (await runtime.runDreaming()).stages.every((stage) => stage.status === 'skipped'),
    true,
  );
  assert.equal(calls, 0);
});

test('failed Dreaming exposes only a content-free failure code and degrades health', async () => {
  const runtime = new AgentMemoryRuntime({
    adapters: {
      observe: async () => {},
      recall: {
        async recall() {
          return {
            mode: 'lexical_only',
            reason: 'semantic_unavailable',
            candidates: [],
            context: null,
          };
        },
        async recordUsed() {},
      },
      writes: {
        async remember() {
          return { status: 'created' };
        },
        async forget() {
          return { status: 'forgotten' };
        },
      },
      async runDreaming() {
        throw new Error('private transcript must not escape');
      },
    },
  });
  await assert.rejects(runtime.runDreaming(), /memory_dreaming_run_failed/);
  assert.deepEqual(await runtime.health(), {
    status: 'degraded',
    lastDreamingAt: null,
    reason: 'dreaming_run_failed',
  });
});
