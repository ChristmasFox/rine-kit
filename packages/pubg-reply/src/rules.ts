/*
 * The PUBG skill's rules, moved unchanged from Lab's plugins/pubg/skills/pubg/SKILL.md (frontmatter removed). They are
 * written for a host that has an `identity_resolve` tool (a person = a squad member with a canonical id): Lab's
 * identity store, or RINE's room roster. Hosts without scheduled Telemetry operations use {@link pubgChatRules}.
 */
export const PUBG_SKILL_RULES = `# PUBG

Use the PUBG tools for match statistics and review. OpenClaw resolves the
user's natural-language request, but the identity-first dispatch contract below
is mandatory. Do not answer a person-specific PUBG request before completing
that tool sequence. These rules are scoped to PUBG requests and must not limit
Kurisu's other native capabilities.

## Mandatory identity-first dispatch

Any PUBG request that names a person by a human nickname, alias, or mention is
person-specific, including short messages such as “胶昨天战绩”, “猴昨天战绩”,
“帮我看八戒最后一把”, or “胶呢” when the surrounding context makes PUBG the
subject. For each such request:

1. Call \`identity_resolve\` with \`reference=alias\` and the exact nickname text
   (or use \`reference=mention\` / \`reference=reply_sender\` for a trusted native
   mention or reply).
2. If the result is \`status=resolved\`, immediately call the relevant PUBG tool
   with \`personIds=[result.person.personId]\`.
3. Only report an identity/account problem when the tools return
   \`unbound\`, \`ambiguous\`, \`candidate\`, \`not_found\`, or
   \`identity_pubg_account_unbound\`. A previous assistant reply claiming that a
   nickname is unconfirmed is not evidence; resolve it again with the current
   tools.

First-person PUBG requests such as “我昨天战绩”“我的战绩” or “本人最后一把”
must call \`identity_resolve\` with \`reference=self\` first and then pass the
returned canonical \`personId\` as \`personIds\`. They must never be converted to
\`team=true\`; \`team=true\` is reserved for an explicit whole-team/squad request.

A bare record request that names no one and has no “我”, such as “今日战绩”
“昨日战绩”“今天战绩” or “@Kurisu 昨天战绩”, is a whole-team request: call the
PUBG tool directly with \`team=true\` and the period selector. Do not call
\`identity_resolve\` first for it. Never carry a player from earlier chat into
such a request; the plugin also forces \`team=true\` on a bare record turn.

Record requests (“今日战绩”“今天战绩”“昨日战绩”“昨天战绩”“本周战绩”“查询今日战绩”
and person-specific variants) always use \`pubg_query_stats\` (operation
\`report\`, \`groupBy: "player"\`) — that result carries the full card
\`displayText\` with per-member stats, titles and team totals. Never answer a
record request with \`pubg_search_matches\`: a per-match list
(“对局列表 共 N 场”) is only for explicit list asks such as “今天打了哪几把”
“对局列表”, or as the first step of a review.

Never ask the user for a PUBG ID or say that the account is unconfirmed before
the identity lookup. Preloaded nickname/account mappings are already confirmed
for this deployment; use the resolved \`personId\` directly. \`pubg_resolve_players\` is not a substitute for
\`identity_resolve\`: \`playerNames\` is for an explicit PUBG in-game name, while a
chat nickname must first become a canonical \`personId\`.

Tool rules:

- Never invent match IDs, players, metrics, telemetry facts, coverage, or
  timestamps. Use the native tools as the only source of PUBG facts.
- Every new PUBG factual request must call the relevant native tool, even when
  the current OpenClaw session already contains a previous answer or tool
  result. This includes short requests such as “昨天 SG007 踢 kim_kkl 多少脚”,
  “昨天战绩”, “总伤害”, “今天几局”, or a follow-up that asks for a number.
  Context may resolve identity, period, and scope only; it must never supply
  the numeric/event facts. The native tool reads the persistent SQLite cache
  and applies its default refresh policy, so do not answer directly from
  conversation context.
  A repeated or teasing re-ask (“第四遍了”) still calls the tool and still gets the full
  card block; earlier shorter replies in this session are not a format to copy.
- Resolve a person before a person-specific PUBG query. For “我”, call
  \`identity_resolve\` with \`reference=self\`; for a nickname or mention, resolve
  the group-scoped/global alias or trusted mention first. Pass the returned
  canonical \`personId\` as \`personIds\` to the PUBG tool, or pass an explicit
  PUBG account returned by the identity/PUBG tools.
- Never treat the configured team as an implicit subject for a sender. If
  \`identity_resolve\` returns \`unbound\`, \`ambiguous\`, or \`candidate\`, stop and
  explain that identity must be bound or confirmed. \`team=true\` is the only
  explicit request for the configured team (an explicit whole-team request, or
  a bare record request that names no one).
- A transport sender name is never a PUBG name. Never use WhatsApp/Telegram
  display names, profile names, push names, phone numbers, JIDs, or quoted
  sender labels as \`playerNames\`. If the user explicitly gives an in-game name
  or alias, use \`pubg_resolve_players\` before the player-specific query.
- In a group or DM, “我” always means the current trusted channel sender. Do
  not derive a Person or PUBG account from a display name, phone number, JID,
  quoted label, or nickname alone.
- Use \`pubg_search_matches\` to find a concrete match before requesting a
  Telemetry review. Pass the returned \`matchId\` to \`pubg_get_review_facts\`.
- “最近一局”“最后一局”“最新比赛”以及“复盘最近一局”每次都必须重新调用
  \`pubg_search_matches\`，固定使用 \`sort: "desc"\`、\`recentN: 1\`、\`refresh: true\`。
  即使当前会话里已经有旧的 \`matchId\` 或旧结果，也不能跳过这次搜索；先用搜索返回的
  最新 \`matchId\`，再调用 \`pubg_get_review_facts\`。底层会刷新比赛列表，只请求新比赛的
  详情，并在没有新增比赛时复用缓存。只有用户明确说“这把/刚才查到的那一把”时，才可
  沿用当前会话的具体 \`matchId\`。
- Any period review request such as “复盘今天/昨天”“回顾这段时间” or “总结今天对局”
  is also a fresh-data intent. Let the LLM emit a structured semantic selector rather than
  calculating timestamps: use \`pubg_search_matches\` with
  \`selector: { type: "relative_period", value: "today" | "yesterday" }\`, \`refresh: true\`,
  \`sort: "asc"\`, and \`pageSize: 50\`; omit \`recentN\` for the full period so the returned
  matches follow chronological play order. The Domain resolves this selector with the configured
  \`Asia/Shanghai\` \`06:00\` business-day boundary. Pass the returned \`resultSetId\` to
  \`pubg_get_period_review\`; Domain order and partial coverage are authoritative. Do not
  manually loop over stale facts or a result set from an earlier turn.
- Any period teammate-action or friendly-fire request must use
  \`pubg_query_team_damage\` directly; this is the batch Telemetry owner and it refreshes
  Match discovery and ensures Telemetry for every selected match itself. For all-team
  requests such as “昨天队内误伤详情”, omit \`actorPlayer\` and \`victimPlayer\` so every
  \`actor → victim\` direction is returned. For a directional request, pass both configured
  PUBG names/aliases, such as \`actorPlayer: "007"\` and \`victimPlayer: "004"\`. For “踢/脚”
  pass \`source: "MELEE", meleeKind: "KICK"\`; for “拳” use \`meleeKind: "PUNCH"\`.
  Use a semantic \`relative_period\` or explicit \`time_range\` selector and omit \`recentN\`
  and \`resultSetId\`; do not call \`pubg_search_matches\` and then stop, and never infer
  zero from a \`partial\` Telemetry result. \`pubg_get_review_facts\` remains the tool for
  a selected single-match deep review, not the period batch aggregation.
- Use \`pubg_query_stats\` for bounded aggregates. Prefer an explicit selector:
  \`time_range\` uses the half-open interval \`[from,to)\` and IANA timezone
  \`Asia/Shanghai\` unless the user specifies another timezone. PUBG's canonical
  business day runs from \`06:00\` through the next \`06:00\`; preserve that
  boundary when resolving date-based selectors. \`last_n_matches\` is bounded to
  at most 100 matches per call. Omit \`refresh\` or set \`refresh: true\` for a
  new query; the default refreshes the upstream match list before reading the
  persistent cache. Use \`refresh: false\` only when the user explicitly asks
  for cache-only data.
- For a clock split repeated across multiple calendar days, make each day's
  before/after windows explicit half-open intervals and keep them separate;
  never use \`groupBy: day\` over a widened range that contains both sides of the
  clock boundary, because that double-counts full days and cannot prove a
  before/after comparison.
- Use \`pubg_compare_stats\` only with two explicit segments. A comparison ratio
  is \`null\` when its denominator is zero or unknown; never turn it into zero or
  infinity.
- Treat \`null\` as unknown. Never convert unknown deaths, assists, ratios, or
  coverage gaps into zero or a confident conclusion. Preserve the requested
  business-day boundary when resolving a date or clock-based selector.
- Use \`pubg_get_match\` for the selected match's Match API facts, then
  \`pubg_get_review_facts\` for Telemetry-derived facts. Never present a missing
  Telemetry fact as zero.
- Friendly-fire and teammate-action questions are directional facts. Always
  normalize and state the direction as \`actor → victim\` (for example,
  \`kim_kkl → SG007\`). “反过来呢” swaps the actor and victim and starts a new
  independent query; it does not invalidate or correct the previous direction.
  Never append a sentence saying that the previous number was wrong unless the
  current native-tool result covers the exact same actor, victim, period, and
  calculation and directly contradicts it. Do not mix the two directions into
  one total.
- Pass \`categories\` only when a bounded review is requested. The match and
  player summary remains available; detail groups such as \`combat\`, \`fights\`,
  \`weapons\`, \`vehicles\`, \`heavy_weapons\`, \`special_events\`, \`team_damage\`,
  \`recovery\`, \`loot\`, \`environment\`, and \`evidence\` are returned when their
  category is requested (or when \`categories\` is omitted). An empty group is
  not proof that the event did not happen.
- Preserve the returned \`status\`, \`coverage\`, \`asOf\`, \`metricVersion\`,
  \`queryResolved\`, and \`evidenceRefs\` while explaining results. \`partial\`,
  \`no_matches\`, and \`error\` are meaningful outcomes, not successful data.
- Every native PUBG result also contains a validated \`presentation\` contract
  and canonical \`displayText\`. Use \`displayText\` as the factual response block
  and preserve the raw envelope/evidence alongside it; do not reconstruct a
  second user-facing summary from raw JSON.
- Every PUBG result for a user-facing answer carries \`replyGuide\`: the reply shape
  for that kind of answer (战绩 cards, 队内误伤账本, match lists, comparisons,
  reviews) and how to report no_matches, partial or failed results. Follow it:
  keep the whole \`displayText\` block with its numbers, titles and bold markers,
  swap account names for the roster's 称呼, and add Kurisu's voice around it.
  Collapsing the block into short bullets is a wrong answer even when every
  remaining number is correct; a repeated question still gets the full block.
- When \`displayText\` ends with a \`🔗 https://…/s/…\` line, that is the no-login
  share page for exactly the matches in this answer. Keep that line verbatim as
  the last line of the reply; never edit, shorten, re-host or invent such a link,
  and never add one when the tool result has none. The result's \`replyLink\`
  carries the same link: the delivery runtime appends it if the reply lacks it
  and drops any other share link, so a retold answer still ends with it.
- For a review, use the tool's validated \`presentation\` contract as the factual
  response boundary. Render its \`dataUpdatedAt\`/\`dataUpdatedAtLocal\` and
  \`dataSourceRange\`/\`fromLocal\` with the presentation formatter: same-local-day
  times use \`HH:mm\`, cross-day values use \`YYYY-MM-DD HH:mm\`, and unknown values
  stay unknown. Never print raw UTC clock components as if they were local time.
- Every native PUBG result carries a validated presentation and canonical
  \`displayText\`. For final factual replies, use \`displayText\` instead of
  reconstructing facts from raw fields; preserve evidence and any returned
  local source range as 数据来源时间范围, and render \`dataUpdatedAt\` as 数据更新时间
  through the presentation formatter.
- For a comparison, render each returned segment's local range separately. Use
  \`*Local\` fields such as \`startedAtLocal\` for every other user-visible time. Do
  not substitute the current reply time for the source range; if the tool
  returns null, say that the source range is unknown.
- Telemetry status is explicit: \`HIT\` means the feature cache was read,
  \`FETCHED\` + \`cacheStatus=FETCHED\` + \`cacheLookup=MISS\` + \`availability=AVAILABLE\`
  means the cache was empty but the official Telemetry was fetched successfully and
  written to cache, and \`UNAVAILABLE\` means the data could not be obtained. Never
  describe a successful \`FETCHED\` result or \`cacheLookup=MISS\` as missing Telemetry.
- \`pubg_prefetch_telemetry\` is a bounded team-wide scheduled operation. It refreshes
  player match lists hourly, fetches only new Match API records, and prefetches only
  missing Telemetry; its retry state is persistent. \`pubg_telemetry_sync_report\`
  summarizes the previous natural calendar day and returns the exact notification
  payload for \`amadeus_notify_owner\`; preserve its counts and timestamp.
- Keep the same OpenClaw session for identity and query continuity, but do not
  reuse prior PUBG facts or prose. Tool results are session-scoped; do not reuse
  a \`resultSetId\` from another conversation, and use a new native tool result
  for every new factual answer.

The plugin returns structured JSON. OpenClaw owns interpretation, clarification,
and the final natural-language response; the plugin does not contain an LLM,
keyword router, fixed prose workflow, or platform adapter.
`;

/** The rules without the bullet about the scheduled prefetch / sync-report tools, which a chat host does not expose. */
export function pubgChatRules(): string {
  const lines = PUBG_SKILL_RULES.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('- ') && lines[i]!.includes('`pubg_prefetch_telemetry`')) {
      while (i + 1 < lines.length && lines[i + 1]!.startsWith('  ')) i++;
      continue;
    }
    out.push(lines[i]!);
  }
  return out.join('\n');
}
