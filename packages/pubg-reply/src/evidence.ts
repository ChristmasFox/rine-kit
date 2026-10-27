import { missingReplyFacts, type PubgPresentation } from '@rine-kit/presentation';

// This is an outbound evidence policy, not an intent router: it neither chooses
// a tool nor answers a PUBG question. It only prevents unsupported match facts
// from being delivered when the agent ignored the native tool contract.
export type Message = { role?: string; content?: unknown; toolName?: string };
export type Part = { type?: string; text?: string; name?: string; arguments?: unknown };
export const FACT_TOOLS = new Set([
  'pubg_search_matches', 'pubg_query_stats', 'pubg_compare_stats', 'pubg_get_match',
  'pubg_get_review_facts', 'pubg_get_period_review', 'pubg_query_team_damage',
]);
const REQUEST = /PUBG|绝地求生|吃鸡|战绩|对局|几局|击杀|KD|K\/D/u;
const FACT = /PUBG|绝地求生|吃鸡|战绩|对局|击杀|伤害|KD|K\/D|no_matches|\d+\s*(?:局|杀|场|次)|一局都没有|没有.{0,8}战绩/u;
const TEAM = /全队|整队|队伍|小队|我们|咱们|大家|所有人|全员|team|squad/iu;
// A bare record request names no one ("昨日战绩", "@Kurisu 今天战绩"); in the squad it means the whole team.
const BARE_RECORD = /^(?:\s|@\S+\s*)*(?:今天|今日|昨天|昨日|前天|本周|这周|上周|最近)?\s*(?:的)?\s*(?:PUBG|吃鸡)?\s*(?:战绩|战况)\s*[?？!！。.~]*\s*$/iu;
export const BARE_RECORD_TTL_MS = 120_000;
// Session key -> when the latest inbound message was a bare record request. Module-level on purpose: the plugin is
// registered several times per process and the dispatch and tool-call hooks may run in different registrations.
const bareRecordTurns = new Map<string, number>();
const FOLLOW_UP = /^(?:\s|@\S+\s*)*(?:刷新|更新|再查|查最新|最新|重新查)/u;
const INTERNAL_EVENT = /^\s*<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>/u;
const CREATIVE_TOOLS = new Set(['image_generate', 'amadeus_image_upscale']);
export const SAFE_REPLY = '这次 PUBG 战绩没有完成本轮数据核验，我不能确认结果。请再试一次。';

function parts(message: Message): Part[] {
  return Array.isArray(message.content) ? message.content.filter((part): part is Part => Boolean(part && typeof part === 'object')) : [];
}
function text(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return parts(message).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}
function resultStatus(message: Message): string | undefined {
  try {
    const value = JSON.parse(text(message)) as { status?: unknown };
    return typeof value.status === 'string' ? value.status : undefined;
  } catch { return undefined; }
}

export function isBareRecordRequest(request: unknown): boolean {
  return typeof request === 'string' && BARE_RECORD.test(request.trim());
}

/**
 * A bare record request ("今日战绩") names no one, so it is a whole-team request. The model sometimes carries a
 * player from earlier chat into the call instead (10-21 00:08: only SG_LabmemNo008 came back), so for such a turn
 * the subject is forced to the team and any person/player the model added is dropped.
 */
export function forceTeamScope(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const named = ['playerIds', 'playerNames', 'personIds'].some((key) => params[key] !== undefined);
  if (params.team === true && !named) return undefined;
  const { playerIds: _playerIds, playerNames: _playerNames, personIds: _personIds, ...rest } = params;
  return { ...rest, team: true };
}

export type EvidenceVerdict = 'not_applicable' | 'verified' | 'missing_data' | 'wrong_scope';
export function assessPubgEvidence(messages: unknown, finalText: string): EvidenceVerdict {
  if (!Array.isArray(messages) || !finalText || !FACT.test(finalText)) return 'not_applicable';
  const entries = messages.filter((value): value is Message => Boolean(value && typeof value === 'object'));
  let lastUser = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.role === 'user') { lastUser = i; break; }
  }
  if (lastUser < 0) return 'not_applicable';
  let request = text(entries[lastUser]!);
  // A runtime event (an image finishing, a background task) is not a user asking for PUBG facts, and a turn that
  // makes a picture talks about 吃鸡 as art, not as a record.
  if (INTERNAL_EVENT.test(request)) return 'not_applicable';
  if (entries.slice(lastUser + 1).some((message) => message.role === 'assistant' && parts(message).some((part) => part.type === 'toolCall' && CREATIVE_TOOLS.has(part.name ?? '')))) return 'not_applicable';
  if (!REQUEST.test(request) && FOLLOW_UP.test(request)) {
    for (let i = lastUser - 1; i >= Math.max(0, lastUser - 8); i--) {
      if (entries[i]?.role === 'user' && REQUEST.test(text(entries[i]!))) {
        request = text(entries[i]!);
        break;
      }
    }
  }
  if (!REQUEST.test(request)) return 'not_applicable';
  const calls = entries.slice(lastUser + 1).flatMap((message) => message.role === 'assistant'
    ? parts(message).filter((part) => part.type === 'toolCall' && FACT_TOOLS.has(part.name ?? ''))
    : []);
  const success = entries.slice(lastUser + 1).some((message) => message.role === 'toolResult'
    && FACT_TOOLS.has(message.toolName ?? '') && ['ok', 'partial', 'no_matches'].includes(resultStatus(message) ?? ''));
  if (!calls.length || !success) return 'missing_data';
  // A squad query cannot substantiate a person-specific request. The user must
  // ask for the team explicitly or name no one at all (a bare 战绩 request);
  // nickname resolution remains owned by the Skills.
  if (!TEAM.test(request) && !BARE_RECORD.test(request) && calls.some((call) => {
    const args = call.arguments;
    return Boolean(args && typeof args === 'object' && (args as { team?: unknown }).team === true);
  })) return 'wrong_scope';
  return 'verified';
}

/** Facts the final reply dropped from this turn's last PUBG result block (战绩 cards, 误伤账本); empty otherwise. */
export function droppedReplyFacts(messages: unknown, finalText: string): string[] {
  if (!Array.isArray(messages) || !finalText) return [];
  const entries = messages.filter((value): value is Message => Boolean(value && typeof value === 'object'));
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]!;
    if (message.role === 'user') return [];
    if (message.role !== 'toolResult' || !FACT_TOOLS.has(message.toolName ?? '')) continue;
    try {
      const presentation = (JSON.parse(text(message)) as { presentation?: unknown }).presentation;
      return presentation && typeof presentation === 'object' ? missingReplyFacts(presentation as PubgPresentation, finalText) : [];
    } catch { return []; }
  }
  return [];
}
