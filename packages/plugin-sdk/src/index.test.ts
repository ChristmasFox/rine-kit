import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { definePlugin, defineTool, PluginRegistry, type Plugin } from './index.js';

interface Ctx {
  userId: string;
}
const tool = defineTool<Ctx>();
const hello = tool({
  name: 'hello',
  description: 'say hello',
  input: z.object({ who: z.string() }),
  run: async ({ who }, ctx) => `${who} from ${ctx.userId}`,
});
const plugin = (id: string, name = 'hello') =>
  definePlugin<Ctx>({ id, instructions: `use ${name}`, tools: [{ ...hello, name }] });

describe('PluginRegistry', () => {
  it('collects tools and instructions in registration order', () => {
    const r = new PluginRegistry<Ctx>().register(plugin('a', 'one')).register(plugin('b', 'two'));
    expect(r.pluginIds).toEqual(['a', 'b']);
    expect(r.tools().map((t) => t.tool.name)).toEqual(['one', 'two']);
    expect(r.instructions()).toEqual(['use one', 'use two']);
    expect(r.toolCount).toBe(2);
  });

  it('refuses a duplicate plugin id or tool name, so one plugin cannot shadow another', () => {
    const r = new PluginRegistry<Ctx>().register(plugin('a'));
    expect(() => r.register(plugin('a', 'other'))).toThrow(/already registered/);
    expect(() => r.register(plugin('b'))).toThrow(/already provided by a/);
    expect(r.pluginIds).toEqual(['a']);
  });

  it("uses the owning plugin's error mapping, else a generic one", () => {
    const own = definePlugin<Ctx>({
      id: 'own',
      tools: [{ ...hello, name: 'x' }],
      toolError: () => ({ error: 'custom' }),
    });
    const r = new PluginRegistry<Ctx>().register(own).register(plugin('plain', 'y'));
    const [x, y] = r.tools();
    expect(x!.toolError(new Error('boom'))).toEqual({ error: 'custom' });
    expect(y!.toolError(new Error('boom'))).toEqual({ error: 'the tool failed' });
  });
});

describe('PluginRegistry.recall', () => {
  const memory = (id: string, recall: NonNullable<Plugin<Ctx>['recall']>) =>
    definePlugin<Ctx>({ id, tools: [], recall });

  it("collects the lines of every plugin's hook, with the host's context", async () => {
    const r = new PluginRegistry<Ctx>()
      .register(memory('a', async (q, ctx) => [`${ctx.userId} asked ${q}`]))
      .register(memory('b', async () => ['b knows']))
      .register(plugin('none'));
    expect(await r.recall('hi', { userId: 'u1' })).toEqual(['u1 asked hi', 'b knows']);
  });

  it('skips a hook that fails or is too slow, and says so', async () => {
    const errors: string[] = [];
    const r = new PluginRegistry<Ctx>()
      .register(memory('bad', async () => Promise.reject(new Error('db down'))))
      .register(memory('slow', () => new Promise(() => undefined)))
      .register(memory('ok', async () => ['fine']));
    const lines = await r.recall(
      'x',
      { userId: 'u' },
      { timeoutMs: 30, onError: (id) => errors.push(id) },
    );
    expect(lines).toEqual(['fine']);
    expect(errors.sort()).toEqual(['bad', 'slow']);
  });

  it('stays silent when the turn itself was cancelled', async () => {
    const errors: string[] = [];
    const r = new PluginRegistry<Ctx>().register(
      memory('slow', () => new Promise(() => undefined)),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    expect(
      await r.recall(
        'x',
        { userId: 'u' },
        { signal: controller.signal, onError: (id) => errors.push(id) },
      ),
    ).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('PluginRegistry.observe', () => {
  it('tells every observing plugin about the finished turn and skips failures', async () => {
    const seen: string[] = [];
    const errors: string[] = [];
    const r = new PluginRegistry<Ctx>()
      .register(
        definePlugin<Ctx>({
          id: 'a',
          tools: [],
          observe: async (t, c) => void seen.push(`${c.userId}:${t.query}->${t.answer}`),
        }),
      )
      .register(
        definePlugin<Ctx>({
          id: 'bad',
          tools: [],
          observe: async () => Promise.reject(new Error('x')),
        }),
      )
      .register(
        definePlugin<Ctx>({ id: 'slow', tools: [], observe: () => new Promise(() => undefined) }),
      )
      .register(plugin('none'));
    await r.observe(
      { query: 'q', answer: 'a' },
      { userId: 'u1' },
      { timeoutMs: 30, onError: (id) => errors.push(id) },
    );
    expect(seen).toEqual(['u1:q->a']);
    expect(errors.sort()).toEqual(['bad', 'slow']);
  });
});
