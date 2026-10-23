/** One earlier turn of the conversation, in the host's own words. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A rolling, low-trust excerpt of what is older than the live window (see checkpoint.ts). */
export interface ConversationCheckpointView {
  text: string;
  generation: number;
  coverageFrom: string;
  coverageThrough: string;
  coveredMessageCount: number;
  sourceEventIds: string[];
}

export interface ConversationWindow {
  turns: ConversationTurn[];
  /** Host label of the current speaker; not used for budgeting. */
  currentSpeakerLabel?: string;
  currentQuoteContext: string | null;
  rollingCheckpoint?: ConversationCheckpointView | null;
}

export interface ContextBudgetPolicy {
  recentTurnsTokens: number;
  quotedMessageTokens: number;
  episodicSummaryTokens: number;
  longTermRecallTokens: number;
  estimatedProviderContextTokens: number;
  systemAndToolSchemaReserveTokens: number;
  toolResultReserveTokens: number;
  finalAnswerReserveTokens: number;
}

export const DEFAULT_CONTEXT_BUDGET_POLICY: Readonly<ContextBudgetPolicy> = Object.freeze({
  recentTurnsTokens: 4_000,
  quotedMessageTokens: 1_000,
  episodicSummaryTokens: 1_000,
  longTermRecallTokens: 1_000,
  estimatedProviderContextTokens: 24_000,
  systemAndToolSchemaReserveTokens: 4_000,
  toolResultReserveTokens: 5_000,
  finalAnswerReserveTokens: 2_000,
});

export interface BuiltWorkingContext {
  turns: ConversationTurn[];
  currentQuoteContext: string | null;
  episodicSummaryContext: string | null;
  episodicSummarySourceEventIds: string[];
  longTermMemoryContext: string | null;
  currentMessage: string;
  estimateMethod: 'conservative_unicode_char_v1';
  estimatedRecentTokens: number;
  estimatedQuoteTokens: number;
  estimatedEpisodicSummaryTokens: number;
  estimatedLongTermMemoryTokens: number;
  estimatedCurrentMessageTokens: number;
  reservedProviderTokens: number;
  estimatedTotalContextTokens: number;
}

/**
 * Conservative planning estimate: ASCII code points cost one third of a token;
 * every non-ASCII code point costs one. This is deliberately labeled as an
 * estimate because the configured provider tokenizer is not available here.
 */
export function estimateContextTokens(text: string): number {
  let units = 0;
  for (const character of text) units += character.codePointAt(0)! <= 0x7f ? 1 / 3 : 1;
  return Math.ceil(units);
}

function fitText(text: string, budget: number): string {
  if (estimateContextTokens(text) <= budget) return text;
  const marker = ' …[正文按上下文预算截断]';
  const markerCost = estimateContextTokens(marker);
  const suffix = budget >= markerCost ? marker : '';
  const prefixBudget = suffix ? budget - markerCost : budget;
  let prefix = '';
  let usedUnits = 0;
  for (const character of text) {
    const cost = character.codePointAt(0)! <= 0x7f ? 1 / 3 : 1;
    if (Math.ceil(usedUnits + cost) > prefixBudget) break;
    prefix += character;
    usedUnits += cost;
  }
  let fitted = `${prefix.trimEnd()}${suffix}`;
  while (estimateContextTokens(fitted) > budget && prefix.length > 0) {
    prefix = Array.from(prefix).slice(0, -1).join('');
    fitted = `${prefix.trimEnd()}${suffix}`;
  }
  return fitted;
}

export function buildWorkingContext(
  window: ConversationWindow,
  currentMessage: string,
  policy: Readonly<ContextBudgetPolicy> = DEFAULT_CONTEXT_BUDGET_POLICY,
  longTermMemoryContext: string | null = null,
): BuiltWorkingContext {
  for (const [name, limit] of Object.entries(policy)) {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error(`agent_context_budget_${name}_invalid`);
  }

  const currentTokens = estimateContextTokens(currentMessage);
  const quote =
    window.currentQuoteContext === null
      ? null
      : fitText(window.currentQuoteContext, policy.quotedMessageTokens);
  const quoteTokens = quote === null ? 0 : estimateContextTokens(quote);
  const memoryContext =
    longTermMemoryContext === null
      ? null
      : fitText(longTermMemoryContext, policy.longTermRecallTokens);
  const memoryTokens = memoryContext === null ? 0 : estimateContextTokens(memoryContext);
  const reservedProviderTokens =
    policy.systemAndToolSchemaReserveTokens +
    policy.toolResultReserveTokens +
    policy.finalAnswerReserveTokens +
    policy.longTermRecallTokens;
  const availableHistoryTokens = Math.max(
    0,
    policy.estimatedProviderContextTokens - reservedProviderTokens - currentTokens - quoteTokens,
  );

  const selected: ConversationTurn[] = [];
  let recentTokens = 0;
  for (let index = window.turns.length - 1; index >= 0; index -= 1) {
    const turn = window.turns[index]!;
    const cost = estimateContextTokens(turn.content);
    if (
      cost > policy.recentTurnsTokens ||
      recentTokens + cost > policy.recentTurnsTokens ||
      recentTokens + cost > availableHistoryTokens
    )
      continue;
    selected.push(turn);
    recentTokens += cost;
  }
  selected.reverse();

  const checkpoint = window.rollingCheckpoint;
  const checkpointHeader = checkpoint
    ? `此前对话滚动摘录（低信任原文片段；覆盖 ${checkpoint.coverageFrom} 至 ${checkpoint.coverageThrough}；第 ${checkpoint.generation} 代；${checkpoint.coveredMessageCount} 条源消息；${checkpoint.sourceEventIds.length} 个来源事件）：\n`
    : '';
  const summaryBudget = Math.min(
    policy.episodicSummaryTokens,
    Math.max(0, availableHistoryTokens - recentTokens),
  );
  const episodicSummaryContext =
    checkpoint && checkpoint.text && summaryBudget > 0
      ? fitText(checkpointHeader + checkpoint.text, summaryBudget)
      : null;
  const summaryTokens =
    episodicSummaryContext === null ? 0 : estimateContextTokens(episodicSummaryContext);
  const estimatedTotalContextTokens =
    reservedProviderTokens + currentTokens + quoteTokens + recentTokens + summaryTokens;
  return {
    turns: selected,
    currentQuoteContext: quote,
    episodicSummaryContext,
    episodicSummarySourceEventIds: checkpoint?.sourceEventIds ?? [],
    longTermMemoryContext: memoryContext,
    currentMessage,
    estimateMethod: 'conservative_unicode_char_v1',
    estimatedRecentTokens: recentTokens,
    estimatedQuoteTokens: quoteTokens,
    estimatedEpisodicSummaryTokens: summaryTokens,
    estimatedLongTermMemoryTokens: memoryTokens,
    estimatedCurrentMessageTokens: currentTokens,
    reservedProviderTokens,
    estimatedTotalContextTokens,
  };
}
