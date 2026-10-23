import type { MemoryEntry } from '../contracts.js';
import { memorySearchTokens, normalizeMemoryKey } from '../recall/search.js';

export interface MemoryConflictCandidate {
  entry: MemoryEntry;
  overlap: number;
}

export function memoryTokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(memorySearchTokens(left));
  const rightTokens = new Set(memorySearchTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

/** Finds likely same-fact conflicts while excluding revisions of the requested key. */
export function findMemoryConflicts(
  key: string,
  content: string,
  entries: readonly MemoryEntry[],
  minimumOverlap = 0.72,
): MemoryConflictCandidate[] {
  if (!Number.isFinite(minimumOverlap) || minimumOverlap < 0 || minimumOverlap > 1) {
    throw new Error('memory_conflict_threshold_invalid');
  }
  const normalizedKey = normalizeMemoryKey(key);
  const unique = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    if (!entry || !Number.isSafeInteger(entry.revision) || entry.revision < 1) continue;
    const candidateKey = normalizeMemoryKey(entry.key);
    if (!candidateKey || candidateKey === normalizedKey) continue;
    unique.set(`${candidateKey}\0${entry.revision}`, entry);
  }
  return [...unique.values()]
    .map((entry) => ({
      entry,
      overlap: memoryTokenOverlap(`${key} ${content}`, `${entry.key} ${entry.content}`),
    }))
    .filter((candidate) => candidate.overlap >= minimumOverlap)
    .sort(
      (left, right) =>
        right.overlap - left.overlap || left.entry.key.localeCompare(right.entry.key),
    );
}

export function equivalentMemoryContent(
  left: string,
  right: string,
  minimumOverlap = 0.9,
): boolean {
  return memoryTokenOverlap(left, right) >= minimumOverlap;
}
