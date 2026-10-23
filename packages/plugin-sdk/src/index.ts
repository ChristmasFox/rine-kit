import type { z } from 'zod';

/**
 * What an AI plugin looks like to the host that runs it. A plugin knows nothing about the host
 * (RINE's API, LiveKit, OpenClaw, ...) beyond the trusted context type `Ctx` it asks for.
 *
 * The rule that keeps multi-tenant hosts safe: **the model never decides who is acting.** `Ctx` is
 * built by the host from authenticated data (who is asking, which room / tenant / team) and handed
 * to `run`; it must not appear in a tool's `input` schema, which is all the model can write. A tool
 * can therefore only touch what that context allows.
 */
export interface ToolDefinition<Ctx = unknown, S extends z.ZodType = z.ZodType> {
  /** What the model calls it: snake_case, unique across the plugins a host loads. */
  name: string;
  /** Told to the model: when to use the tool and what it does. */
  description: string;
  /** The arguments the model may write; they are checked against this before `run`. */
  input: S;
  /**
   * Does the work for the principal in `ctx`. The result is shown to the model as JSON; a throw is
   * turned into `{error}` data by the plugin's `toolError` (default: a generic message), not a crash.
   */
  run(input: z.output<S>, ctx: Ctx, options: { signal?: AbortSignal }): Promise<unknown>;
}

export interface Plugin<Ctx = unknown> {
  /** Stable, namespaced id such as "rine.reminders". */
  id: string;
  /** Added to the system prompt while the plugin is loaded: when and how to use its tools. */
  instructions?: string;
  tools: ToolDefinition<Ctx>[];
  /**
   * Memory hook: background the plugin knows that is relevant to what was just asked, as short plain
   * lines. The host shows them to the model as untrusted reference data, never as instructions. Like
   * tools it works for the principal in `ctx` only; it must be quick (a slow or failing hook is skipped).
   */
  recall?(query: string, ctx: Ctx, options: { signal?: AbortSignal }): Promise<string[]>;
  /**
   * Memory hook: told after a turn finished normally, with what the member asked and what the AI
   * answered. For learning from conversation; best effort, never delays or fails the answer.
   */
  observe?(
    turn: { query: string; answer: string },
    ctx: Ctx,
    options: { signal?: AbortSignal },
  ): Promise<void>;
  /** Turns an error thrown by one of this plugin's tools into the data the model reads. */
  toolError?(err: unknown): unknown;
}

/** Declares a plugin; only fixes the type of its trusted context. */
export function definePlugin<Ctx>(plugin: Plugin<Ctx>): Plugin<Ctx> {
  return plugin;
}

/**
 * `const tool = defineTool<MyCtx>();` then `tool({ ... })`: the context type is given once and the
 * input type is inferred from the schema.
 */
export function defineTool<Ctx>() {
  return <S extends z.ZodType>(def: ToolDefinition<Ctx, S>): ToolDefinition<Ctx> =>
    def as unknown as ToolDefinition<Ctx>;
}

export const DEFAULT_TOOL_ERROR = { error: 'the tool failed' };

/** The plugins a host has loaded, with their tool names checked for clashes. */
export class PluginRegistry<Ctx = unknown> {
  private readonly plugins = new Map<string, Plugin<Ctx>>();
  private readonly owners = new Map<string, { plugin: Plugin<Ctx>; tool: ToolDefinition<Ctx> }>();

  register(plugin: Plugin<Ctx>): this {
    if (this.plugins.has(plugin.id)) throw new Error(`plugin ${plugin.id} is already registered`);
    for (const tool of plugin.tools) {
      const taken = this.owners.get(tool.name);
      if (taken)
        throw new Error(
          `tool ${tool.name} of ${plugin.id} is already provided by ${taken.plugin.id}`,
        );
    }
    this.plugins.set(plugin.id, plugin);
    for (const tool of plugin.tools) this.owners.set(tool.name, { plugin, tool });
    return this;
  }

  get pluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  get toolCount(): number {
    return this.owners.size;
  }

  /** Prompt fragments of the loaded plugins, in registration order. */
  instructions(): string[] {
    return [...this.plugins.values()].flatMap((p) => (p.instructions ? [p.instructions] : []));
  }

  /**
   * The lines the plugins recall for this question. A hook that fails or takes longer than
   * `timeoutMs` contributes nothing (`onError` hears about it): memory is a help, never a reason to
   * fail or delay an answer.
   */
  async recall(
    query: string,
    ctx: Ctx,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onError?: (pluginId: string, err: unknown) => void;
    } = {},
  ): Promise<string[]> {
    const timeoutMs = options.timeoutMs ?? 1500;
    const hooks = [...this.plugins.values()].filter((p) => p.recall);
    const lines = await Promise.all(
      hooks.map(async (plugin) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
        try {
          const result = await Promise.race([
            plugin.recall!(query, ctx, { signal }),
            new Promise<never>((_, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            ),
          ]);
          return result.filter((l) => typeof l === 'string');
        } catch (err) {
          if (!options.signal?.aborted) options.onError?.(plugin.id, err);
          return [];
        }
      }),
    );
    return lines.flat();
  }

  /** Tells the plugins' observe hooks about a finished turn. A hook that fails or is slow is skipped. */
  async observe(
    turn: { query: string; answer: string },
    ctx: Ctx,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onError?: (pluginId: string, err: unknown) => void;
    } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5000;
    await Promise.all(
      [...this.plugins.values()]
        .filter((p) => p.observe)
        .map(async (plugin) => {
          const timeout = AbortSignal.timeout(timeoutMs);
          const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
          try {
            await Promise.race([
              plugin.observe!(turn, ctx, { signal }),
              new Promise<never>((_, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
              ),
            ]);
          } catch (err) {
            options.onError?.(plugin.id, err);
          }
        }),
    );
  }

  /** Every tool with the function that makes its failures into model-readable data. */
  tools(): { tool: ToolDefinition<Ctx>; toolError: (err: unknown) => unknown }[] {
    return [...this.owners.values()].map(({ plugin, tool }) => ({
      tool,
      toolError: (err) => (plugin.toolError ? plugin.toolError(err) : DEFAULT_TOOL_ERROR),
    }));
  }
}
