import { createHash } from 'node:crypto';
import { estimateContextTokens } from './budget.js';

// Extracted from Gate's gate-conversation-checkpoints.ts: the extractive, rebuildable checkpoint of
// what is older than the live conversation window. Reading those rows from a transcript and storing
// the result are host / storage concerns; this part is pure.

export interface CheckpointSourceRow {
  sourceEventId: string;
  speakerKind: 'human' | 'assistant' | string;
  /** ISO time. */
  createdAt: string;
  content: string;
}

export interface ExtractiveCheckpoint {
  text: string;
  coverageFrom: string;
  coverageThrough: string;
  coveredMessageCount: number;
  sourceEventIds: string[];
  /** Hash of the covered rows; changes exactly when the checkpoint needs a new generation. */
  sourceDigest: string;
}

export const MAX_CHECKPOINT_SOURCE_ROWS = 100;
export const MAX_CHECKPOINT_TOKENS = 1_000;
const CHECKPOINT_SOURCE_LIMIT = 48;

function contentWithBudget(value: string, budget: number): string {
  if (estimateContextTokens(value) <= budget) return value;
  const marker = ' …[对话摘录截断]';
  const markerTokens = estimateContextTokens(marker);
  const textBudget = Math.max(0, budget - markerTokens);
  let text = '';
  let tokens = 0;
  for (const character of value) {
    const cost = estimateContextTokens(character);
    if (tokens + cost > textBudget) break;
    text += character;
    tokens += cost;
  }
  return `${text.trimEnd()}${budget >= markerTokens ? marker : ''}`;
}

/**
 * Builds a small extractive checkpoint (no model involved) from the rows older than the live window,
 * newest first as the host reads them. The 100-row page and the token cap keep the work bounded; the
 * result is safe to rebuild at any time.
 */
export function buildExtractiveCheckpoint(
  rowsNewestFirst: readonly CheckpointSourceRow[],
): ExtractiveCheckpoint | null {
  const rows = rowsNewestFirst.slice(0, MAX_CHECKPOINT_SOURCE_ROWS);
  if (!rows.length) return null;
  const chronologicalRows = [...rows].reverse();
  const digestMaterial = chronologicalRows.map((row) => [
    row.sourceEventId,
    row.speakerKind,
    row.createdAt,
    row.content,
  ]);
  const sourceDigest = createHash('sha256').update(JSON.stringify(digestMaterial)).digest('hex');
  const selected: Array<{ sourceEventId: string; line: string }> = [];
  let usedTokens = 0;
  for (const row of rows) {
    if (!row.sourceEventId || (row.speakerKind !== 'human' && row.speakerKind !== 'assistant'))
      continue;
    if (selected.length >= CHECKPOINT_SOURCE_LIMIT || usedTokens >= MAX_CHECKPOINT_TOKENS) break;
    const prefix = row.speakerKind === 'assistant' ? '助手说：' : '成员说：';
    const remaining = MAX_CHECKPOINT_TOKENS - usedTokens - estimateContextTokens(prefix);
    if (remaining <= 0) break;
    const line = `${prefix}${contentWithBudget(row.content, remaining)}`;
    const cost = estimateContextTokens(line);
    if (cost <= 0 || cost > remaining) continue;
    selected.push({ sourceEventId: row.sourceEventId, line });
    usedTokens += cost;
  }
  selected.reverse();
  return {
    text: selected.map((item) => item.line).join('\n'),
    coverageFrom: chronologicalRows[0]!.createdAt,
    coverageThrough: chronologicalRows.at(-1)!.createdAt,
    coveredMessageCount: chronologicalRows.length,
    sourceEventIds: [...new Set(selected.map((item) => item.sourceEventId))],
    sourceDigest,
  };
}
