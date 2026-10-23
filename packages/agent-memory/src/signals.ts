import { createHash } from 'node:crypto';
import type { MemoryUsageSignal } from './contracts.js';

export interface MemoryUsageCandidate {
  key: string;
  revision: number;
  sourceEventId: string;
}

const MAX_FINGERPRINT_QUERY_LENGTH = 8_000;

/** Hash a normalized query so recall analytics never retain the query text. */
export function memoryQueryFingerprint(query: string): string {
  if (typeof query !== 'string' || query.length > MAX_FINGERPRINT_QUERY_LENGTH) {
    throw new Error('memory_query_fingerprint_input_invalid');
  }
  const normalized = query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  if (!normalized) throw new Error('memory_query_fingerprint_input_invalid');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function createMemoryUsageSignals(
  query: string,
  candidates: readonly MemoryUsageCandidate[],
): MemoryUsageSignal[] {
  const queryFingerprint = memoryQueryFingerprint(query);
  const unique = new Map<string, MemoryUsageSignal>();
  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate.key !== 'string' ||
      !candidate.key.trim() ||
      candidate.key.length > 96 ||
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision < 1 ||
      typeof candidate.sourceEventId !== 'string' ||
      !candidate.sourceEventId.trim() ||
      candidate.sourceEventId.length > 256
    ) {
      continue;
    }
    const signal = {
      key: candidate.key,
      revision: candidate.revision,
      sourceEventId: candidate.sourceEventId,
      queryFingerprint,
    };
    unique.set(JSON.stringify([signal.key, signal.revision, signal.sourceEventId]), signal);
  }
  return [...unique.values()];
}
