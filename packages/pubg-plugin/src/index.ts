import { definePlugin, type Plugin, type ToolDefinition } from '@rine-kit/plugin-sdk';
import type { PubgDomainService } from '@rine-kit/pubg-domain';
import {
  forceTeamScope,
  isBareRecordRequest,
  jsonToolResult,
  pubgChatRules,
  type ReplyGuideProvider,
  type ShareAppender,
} from '@rine-kit/pubg-reply';
import { PUBG_TOOLS, runPubgTool, type PubgSubjectHost } from '@rine-kit/pubg-tools';

/** What the host decides for one request from its trusted context. */
export interface PubgAccess {
  /** The Domain service of the one tenant / team this request may see (its repository is scoped). */
  service: PubgDomainService;
  /** Who is asking, in PUBG terms (the asker's own accounts, the persons the host knows). */
  host: PubgSubjectHost;
  /** Names the conversation so result sets stay private to it. */
  sessionId: string;
  /** IANA zone the answers are written in ("today" and clock times). Default Asia/Shanghai, as in Lab. */
  timezone?: string;
  /** The share step for one tool's answer; absent, or returning undefined = no link (the answer then has no 🔗 line). */
  share?(toolName: string): ShareAppender | undefined;
  /** Runs after a result was built, e.g. to store the share that was just issued before the link is shown. */
  afterReply?(): Promise<void>;
}

export interface PubgPluginOptions<Ctx> {
  /** May look the team up (a database read); the tools wait for it. */
  access(ctx: Ctx): PubgAccess | Promise<PubgAccess>;
  /**
   * Deliver results the way Lab does: every tool result carries the validated `presentation`, the chat-layout
   * `displayText` and the `replyGuide` (and `replyLink` when a share link was issued) instead of the bare Domain
   * envelope. Without it the plugin returns the envelope as before.
   */
  reply?: {
    /** Worked examples / voice of the reply guide; default is Lab's (Kurisu). */
    guide?: ReplyGuideProvider;
    /** What the member asked in this turn, so a bare record request ("今日战绩") is forced to the whole team. */
    request?(ctx: Ctx): string | undefined;
  };
  /** 'chat' puts Lab's full PUBG skill rules into the instructions (instead of the four-sentence summary). */
  rules?: 'chat' | 'summary';
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
      let arguments_ = input;
      if (options.reply?.request && spec.name === 'pubg_query_stats') {
        // A bare record request names no one, so it is the whole team: drop any person the model carried over.
        const scoped = isBareRecordRequest(options.reply.request(ctx))
          ? forceTeamScope((input ?? {}) as Record<string, unknown>)
          : undefined;
        if (scoped) arguments_ = scoped as typeof input;
      }
      const envelope = await runPubgTool(spec, arguments_, {
        service: access.service,
        host: access.host,
        sessionId: access.sessionId,
        ...(signal ? { signal } : {}),
      });
      if (!options.reply) return envelope;
      const reply = jsonToolResult(
        spec.name,
        envelope,
        access.timezone ?? 'Asia/Shanghai',
        access.share?.(spec.name),
        options.reply.guide,
      );
      await access.afterReply?.();
      return reply;
    },
  }));
  return definePlugin<Ctx>({
    id: 'rine.pubg',
    instructions: options.rules === 'chat' ? pubgChatRules() : INSTRUCTIONS,
    tools,
  });
}
