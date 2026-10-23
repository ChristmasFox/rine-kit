import { tool, type ToolSet } from 'ai';
import type { PluginRegistry } from '@rine-kit/plugin-sdk';

/**
 * The AI SDK tool set for one turn: every tool of the loaded plugins, bound to the trusted context of
 * that turn. Results go to the model as JSON text; a tool that throws becomes the plugin's error data
 * (unless the turn was cancelled, which must stop the loop).
 */
export function toToolSet<Ctx>(registry: PluginRegistry<Ctx>, ctx: Ctx): ToolSet {
  const tools: ToolSet = {};
  for (const { tool: def, toolError } of registry.tools()) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: def.input,
      execute: async (input, { abortSignal }) => {
        if (abortSignal?.aborted) throw new Error('cancelled');
        try {
          return JSON.stringify(await def.run(input, ctx, { signal: abortSignal }));
        } catch (err) {
          if (abortSignal?.aborted) throw err;
          return JSON.stringify(toolError(err));
        }
      },
    });
  }
  return tools;
}
