import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '@rine-kit/plugin-sdk';
import type {
  AgentMemoryPlugin,
  ExplicitMemoryWrite,
  MemoryForgetRequest,
  MemoryObservation,
  MemoryRetrievedCandidate,
} from '@rine-kit/agent-memory';
import { createMemoryPlugin } from './index.js';

interface Ctx {
  user: string;
  room: string;
}
type Auth = { scope: string };

const candidate = (
  key: string,
  content: string,
  score: number,
  revision = 1,
): MemoryRetrievedCandidate => ({
  canonicalKey: key,
  key,
  content,
  revision,
  updatedAt: '2026-10-01T00:00:00Z',
  sourceEventId: 'e',
  sourceKind: 'user_confirmed',
  score,
  sources: ['lexical'],
  reasons: [],
});

function fakeMemory(byScope: Record<string, MemoryRetrievedCandidate[]> = {}) {
  const calls: unknown[] = [];
  const memory: AgentMemoryPlugin<Auth> = {
    async recall(a, request) {
      calls.push(['recall', a.scope, request.query]);
      return { mode: 'hybrid', reason: null, candidates: byScope[a.scope] ?? [], context: null };
    },
    async remember(a: Auth, write: ExplicitMemoryWrite) {
      calls.push(['remember', a.scope, write]);
      return { status: write.operation === 'correct' ? 'revised' : 'created' };
    },
    async forget(a: Auth, request: MemoryForgetRequest) {
      calls.push(['forget', a.scope, request]);
      return { status: request.key === 'missing' ? 'not_found' : 'forgotten' };
    },
    async observe(a: Auth, observation: MemoryObservation) {
      calls.push(['observe', a.scope, observation.content]);
    },
    async recordUsed() {},
    async runDreaming() {
      throw new Error('unused');
    },
    async health() {
      return { status: 'ready', lastDreamingAt: null, reason: null };
    },
  };
  return { memory, calls };
}

const ctx: Ctx = { user: 'mei', room: 'r1' };
function setup(byScope?: Record<string, MemoryRetrievedCandidate[]>, withObservation = true) {
  const { memory, calls } = fakeMemory(byScope);
  const plugin = createMemoryPlugin<Ctx, Auth>({
    memory,
    access: (c) => ({
      read: [{ scope: `user:${c.user}` }, { scope: `room:${c.room}` }],
      write: { scope: `user:${c.user}` },
    }),
    ...(withObservation
      ? {
          observation: (c, turn) => ({
            authorization: { scope: `user:${c.user}` },
            observation: { content: turn.query, observedAt: '2026-10-01T00:00:00Z', evidence: [] },
          }),
        }
      : {}),
    recallLimit: 3,
  });
  const registry = new PluginRegistry<Ctx>().register(plugin);
  const tools = Object.fromEntries(registry.tools().map((t) => [t.tool.name, t.tool]));
  return { registry, tools, calls, plugin };
}

describe('the memory plugin', () => {
  it('offers remember, correct_memory and forget_memory with no identity in what the model writes', () => {
    const { tools } = setup();
    expect(Object.keys(tools)).toEqual(['remember', 'correct_memory', 'forget_memory']);
    const fields = (n: string) =>
      Object.keys((tools[n]!.input as unknown as { shape: object }).shape);
    expect(fields('remember')).toEqual(['key', 'content']);
    expect(fields('correct_memory')).toEqual(['key', 'content', 'expected_revision']);
    expect(fields('forget_memory')).toEqual(['key']);
    expect(tools.remember!.input.safeParse({ key: 'k', content: 'x'.repeat(301) }).success).toBe(
      false,
    );
  });

  it('recalls from every readable scope, merged, de-duplicated and best first, with key@revision', async () => {
    const { registry, calls } = setup({
      'user:mei': [candidate('role', 'plays support', 0.5, 3), candidate('tea', 'likes tea', 0.1)],
      'room:r1': [
        candidate('night', 'plays on friday', 0.9),
        candidate('role', 'plays support', 0.4),
      ],
    });
    const lines = await registry.recall('what do I play', ctx);
    expect(lines).toEqual([
      '[night@1] plays on friday',
      '[role@3] plays support',
      '[tea@1] likes tea',
    ]);
    expect(calls).toEqual([
      ['recall', 'user:mei', 'what do I play'],
      ['recall', 'room:r1', 'what do I play'],
    ]);
    // The limit applies to the merged list.
    const many = setup({
      'user:mei': ['a', 'b', 'c', 'd', 'e'].map((k, i) => candidate(k, k, 1 - i / 10)),
    });
    expect(await many.registry.recall('q', ctx)).toHaveLength(3);
  });

  it('offers the host fallback only when recall found nothing', async () => {
    const { memory } = fakeMemory({ 'user:mei': [candidate('role', 'plays support', 0.5)] });
    const make = (fallbackLines: string[]) =>
      new PluginRegistry<Ctx>().register(
        createMemoryPlugin<Ctx, Auth>({
          memory,
          access: (c) => ({
            read: [{ scope: `user:${c.user}` }],
            write: { scope: `user:${c.user}` },
          }),
          fallback: async () => fallbackLines,
        }),
      );
    expect(await make(['[x@1] recent']).recall('q', ctx)).toEqual(['[role@1] plays support']);
    expect(await make(['[x@1] recent']).recall('q', { user: 'ken', room: 'r1' })).toEqual([
      '[x@1] recent',
    ]);
  });

  it('writes only to the host-chosen scope and reports what the engine said', async () => {
    const { tools, calls } = setup();
    expect(await tools.remember!.run({ key: 'role', content: 'plays support' }, ctx, {})).toEqual({
      ok: true,
      status: 'created',
    });
    expect(
      await tools.correct_memory!.run(
        { key: 'role', content: 'plays sniper', expected_revision: 2 },
        ctx,
        {},
      ),
    ).toEqual({ ok: true, status: 'revised' });
    expect(await tools.forget_memory!.run({ key: 'role' }, ctx, {})).toEqual({
      ok: true,
      status: 'forgotten',
    });
    expect(await tools.forget_memory!.run({ key: 'missing' }, ctx, {})).toMatchObject({
      ok: false,
      status: 'not_found',
    });
    expect(calls).toEqual([
      ['remember', 'user:mei', { operation: 'remember', key: 'role', content: 'plays support' }],
      [
        'remember',
        'user:mei',
        { operation: 'correct', key: 'role', content: 'plays sniper', expectedRevision: 2 },
      ],
      ['forget', 'user:mei', { key: 'role' }],
      ['forget', 'user:mei', { key: 'missing' }],
    ]);
  });

  it('hands finished turns to the engine for learning, and learns nothing when the host says so', async () => {
    const learning = setup();
    await learning.registry.observe({ query: '我喜欢辅助', answer: '好的' }, ctx);
    expect(learning.calls).toEqual([['observe', 'user:mei', '我喜欢辅助']]);
    const silent = setup(undefined, false);
    await silent.registry.observe({ query: 'x', answer: 'y' }, ctx);
    expect(silent.calls).toEqual([]);
  });

  it('turns engine policy errors into a message the model can relay', () => {
    const { plugin } = setup();
    expect(plugin.toolError!(new Error('memory_input_invalid'))).toMatchObject({
      error: expect.stringContaining('short key'),
    });
    expect(plugin.toolError!(new Error('boom'))).toEqual({ error: 'the memory tool failed' });
  });
});
