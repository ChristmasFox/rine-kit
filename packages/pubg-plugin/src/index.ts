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
  /** May look the team up (a database read); the tools wait for it. */
  access(ctx: Ctx): PubgAccess | Promise<PubgAccess>;
}

const INSTRUCTIONS = [
  "You can look up PUBG statistics and match reviews with the pubg_* tools. Every number, match, player, time range and coverage statement in your answer must come from this turn's tool results; never answer PUBG facts from memory or from the chat. Keep the tool's coverage, data time and partial/unknown states in your answer, and say plainly when data is missing. Name players only by the in-game names or aliases in tool results. Never pass tenant, team or user identifiers: who is asking is decided by the system.",
  'Every new PUBG factual request must call a pubg_* tool in the current turn, even if the chat or an earlier tool result already holds an answer; earlier turns may only resolve who, which period and which scope, never numbers. A repeated or teasing re-ask calls the tool again. Leave refresh out (the default fetches the newest matches first); use refresh: false only when the person explicitly asks for cached data.',
  'A first-person request ("me", "my record") is the asker\'s own account and must never become team: true. A record request that names no one ("yesterday\'s record") is a whole-team request: team: true.',
  'Record requests (today / yesterday / this week) use pubg_query_stats (report, grouped by player), never pubg_search_matches; a per-match list is only for an explicit "which games" ask or as the first step of a review. "The latest / last match" = pubg_search_matches with sort desc, recentN 1, refresh true, then pubg_get_review_facts with the returned matchId. A period review = pubg_search_matches with a relative_period selector (today / yesterday), refresh true, sort asc, pageSize 50, then pubg_get_period_review with the returned resultSetId. Friendly fire / teammate actions in a period = pubg_query_team_damage directly.',
].join('\n');

/**
 * The PUBG tool catalogue (shared with every other host) as a plugin. The tools take whatever the model
 * writes after the shared validation, but the Domain service and the meaning of "me" come from the host.
 */
export function createPubgPlugin<Ctx>(options: PubgPluginOptions<Ctx>): Plugin<Ctx> {
  const tools: ToolDefinition<Ctx>[] = PUBG_TOOLS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input: spec.input,
    run: async (input, ctx, { signal }) => {
      const access = await options.access(ctx);
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
