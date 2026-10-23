import { definePlugin, type Plugin, type ToolDefinition } from '@rine-kit/plugin-sdk';
import type { PubgDomainService } from '@rine-kit/pubg-domain';
import { PUBG_TOOLS, runPubgTool, type PubgSubjectHost } from '@rine-kit/pubg-tools';

/** What the host decides for one request from its trusted context. */
export interface PubgAccess {
  /** The Domain service of the one tenant / team this request may see (its repository is scoped). */
  service: PubgDomainService;
  /** Who is asking, in PUBG terms (the asker's own accounts, the persons the host knows). */
  host: PubgSubjectHost;
  /** Names the conversation so result sets stay private to it. */
  sessionId: string;
}

export interface PubgPluginOptions<Ctx> {
  access(ctx: Ctx): PubgAccess;
}

const INSTRUCTIONS =
  "You can look up PUBG statistics and match reviews with the pubg_* tools. Every number, match, player, time range and coverage statement in your answer must come from this turn's tool results; never answer PUBG facts from memory or from the chat. Keep the tool's coverage, data time and partial/unknown states in your answer, and say plainly when data is missing. For today / yesterday / this week record requests use pubg_query_stats; use pubg_search_matches first when a match review needs a fresh resultSetId. Name players only by the in-game names or aliases in tool results. Never pass tenant, team or user identifiers: who is asking is decided by the system.";

/**
 * The PUBG tool catalogue (shared with every other host) as a plugin. The tools take whatever the model
 * writes after the shared validation, but the Domain service and the meaning of "me" come from the host.
 */
export function createPubgPlugin<Ctx>(options: PubgPluginOptions<Ctx>): Plugin<Ctx> {
  const tools: ToolDefinition<Ctx>[] = PUBG_TOOLS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input: spec.input,
    run: (input, ctx, { signal }) => {
      const access = options.access(ctx);
      return runPubgTool(spec, input, {
        service: access.service,
        host: access.host,
        sessionId: access.sessionId,
        ...(signal ? { signal } : {}),
      });
    },
  }));
  return definePlugin<Ctx>({ id: 'rine.pubg', instructions: INSTRUCTIONS, tools });
}
