import { randomUUID } from 'node:crypto';
import { assignStatTitles, type PubgStatsPresentation } from '@rine-kit/presentation';
import { issueReviewShare, type ReviewShareStore } from '@rine-kit/pubg-domain';

/**
 * Record (战绩) queries whose answers are about concrete matches. Operational tools (prefetch, sync report, player
 * lookup) and the 误伤 query (pubg_query_team_damage: a fact about teammates, not a record) get no link.
 */
export const QUERY_SHARE_TOOLS: ReadonlySet<string> = new Set([
  'pubg_query_stats',
  'pubg_compare_stats',
  'pubg_search_matches',
  'pubg_get_match',
  'pubg_get_review_facts',
  'pubg_get_period_review',
]);
/** A share page lists its matches; very wide queries share the first ones the result names. */
export const QUERY_SHARE_MAX_MATCHES = 60;

export interface QuerySharePlayerRow {
  label: string;
  position?: number | null;
  values: Record<string, string | number | null>;
  titles: string[];
}

export interface QuerySharePresentation {
  type: 'pubg_query_share';
  version: 1;
  toolName: string;
  title: string;
  displayText: string;
  dataUpdatedAt: string | null;
  timezone: string;
  matchCount: number;
  /** Structured rows for the share page UI (optional for older shares). */
  players?: QuerySharePlayerRow[];
  teamTotals?: string | null;
}

/**
 * Appends a no-login share link for the matches a query answer is built from (今日战绩 and the other query results).
 * The answer's text stays exactly as rendered; the link is one extra line at the end, and is also returned on its own
 * so the result can declare it (`replyLink`) for the delivery boundary. Sharing never breaks an answer: any problem
 * simply leaves the text without a link.
 */
/**
 * Issues the share page for a query answer and returns its URL; null when the answer names no matches. `sessionKey`
 * groups the shares of one answer (issuing again revokes the earlier link); by default every answer is its own group.
 */
export function issueQueryShare(input: {
  toolName: string;
  matchIds: unknown;
  displayText: string;
  dataUpdatedAt: string | null;
  timezone: string;
  squadId: string;
  shareBaseUrl: string;
  store: ReviewShareStore;
  now: Date;
  sessionKey?: string;
  players?: QuerySharePlayerRow[];
  teamTotals?: string | null;
}): string | null {
  const ids = Array.isArray(input.matchIds)
    ? [...new Set(input.matchIds.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, QUERY_SHARE_MAX_MATCHES)
    : [];
  if (!ids.length) return null;
  const presentation: QuerySharePresentation = {
    type: 'pubg_query_share',
    version: 1,
    toolName: input.toolName,
    title: input.displayText.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 80) ?? 'PUBG 战绩',
    displayText: input.displayText,
    dataUpdatedAt: input.dataUpdatedAt,
    timezone: input.timezone,
    matchCount: ids.length,
    ...(input.players?.length ? { players: input.players } : {}),
    ...(input.teamTotals ? { teamTotals: input.teamTotals } : {}),
  };
  const { token } = issueReviewShare(input.store, {
    squadId: input.squadId, sessionKey: input.sessionKey ?? `pubg-query:${randomUUID()}`, matchIds: ids, presentationJson: JSON.stringify(presentation), now: input.now, kind: 'query',
  });
  return `${input.shareBaseUrl.replace(/\/$/u, '')}/s/${token}`;
}

/** The structured player rows the share page shows for a 战绩 answer, with the same titles the chat card gives. */
export function querySharePlayers(presentation: { type: string }): QuerySharePlayerRow[] {
  if (presentation.type !== 'pubg_stats') return [];
  const stats = presentation as PubgStatsPresentation;
  const titles = assignStatTitles(stats.rows);
  return stats.rows.map((row, index) => ({
    label: row.label,
    ...(row.position !== undefined ? { position: row.position } : {}),
    values: row.values,
    titles: titles.get(index) ?? [],
  }));
}

export function queryShareTeamTotals(displayText: string): string | null {
  return displayText.split('\n').map((item) => item.trim()).find((item) => item.startsWith('团队合计：')) ?? null;
}

export function appendQueryShareLink(input: {
  toolName: string;
  status: string;
  matchIds: unknown;
  displayText: string;
  dataUpdatedAt: string | null;
  timezone: string;
  squadId: string;
  shareBaseUrl?: string;
  store: () => ReviewShareStore;
  now: Date;
  players?: QuerySharePlayerRow[];
  teamTotals?: string | null;
}): { text: string; url?: string } {
  const plain = { text: input.displayText };
  if (!input.shareBaseUrl || !QUERY_SHARE_TOOLS.has(input.toolName) || input.status === 'error') return plain;
  try {
    const url = issueQueryShare({ ...input, shareBaseUrl: input.shareBaseUrl, store: input.store() });
    if (!url) return plain;
    return { text: `${input.displayText}\n\n🔗 ${url}`, url };
  } catch {
    return plain;
  }
}
