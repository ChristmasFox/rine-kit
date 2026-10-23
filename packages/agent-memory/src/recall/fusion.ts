import type {
  MemoryEntry,
  MemoryRecallPolicyOptions,
  MemoryRetrievedCandidate,
} from '../contracts.js';
import { memorySearchTokens, normalizeMemoryKey } from './search.js';

interface RankedCandidate {
  entry: MemoryEntry;
  score: number;
  sources: Set<'exact' | 'lexical' | 'semantic'>;
  reasons: Set<string>;
}

const RRF_K = 60;

function lexicalOverlap(entry: MemoryEntry, query: string): number {
  const normalized = query.normalize('NFC').trim().toLocaleLowerCase('en-US');
  const haystack = `${entry.key} ${entry.content}`.normalize('NFC').toLocaleLowerCase('en-US');
  if (haystack.includes(normalized)) return 1;
  const tokens = memorySearchTokens(normalized);
  if (!tokens.length) return 0;
  return tokens.filter((token) => haystack.includes(token)).length / tokens.length;
}

function sourceReliability(entry: MemoryEntry): number {
  const declared = Number.isFinite(entry.sourceReliability)
    ? Math.min(1, Math.max(0, entry.sourceReliability / 100))
    : 0;
  const sourceCap: Record<MemoryEntry['sourceKind'], number> = {
    trusted_ingress: 0.85,
    user_confirmed: 0.98,
    system_verified: 1,
    unknown: 0,
  };
  return Math.min(declared, sourceCap[entry.sourceKind]);
}

function freshness(entry: MemoryEntry, nowMs: number): number {
  const updatedAt = Date.parse(entry.updatedAt);
  if (!Number.isFinite(updatedAt)) return 0.7;
  const ageDays = Math.max(0, (nowMs - updatedAt) / 86_400_000);
  return 0.7 + 0.3 * Math.exp(-ageDays / 1_825);
}

function addRanked(
  candidates: Map<string, RankedCandidate>,
  entry: MemoryEntry,
  source: 'exact' | 'lexical' | 'semantic',
  rank: number,
  weight: number,
  reason: string,
  nowMs: number,
  quality = 1,
): void {
  if (
    entry.sourceKind === 'unknown' ||
    (entry.validUntil && Date.parse(entry.validUntil) <= nowMs) ||
    !entry.content ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision < 1
  )
    return;
  const normalizedKey = normalizeMemoryKey(entry.key);
  if (!normalizedKey) return;
  const candidateKey = `${normalizedKey}\0${entry.revision}`;
  let candidate = candidates.get(candidateKey);
  if (!candidate) {
    candidate = { entry, score: 0, sources: new Set(), reasons: new Set() };
    candidates.set(candidateKey, candidate);
  }
  candidate.score +=
    ((weight * quality) / (RRF_K + rank)) * sourceReliability(entry) * freshness(entry, nowMs);
  candidate.sources.add(source);
  candidate.reasons.add(reason);
}

export function fuseMemoryCandidates(
  query: string,
  exact: readonly MemoryEntry[],
  lexical: readonly MemoryEntry[],
  semantic: readonly MemoryEntry[],
  options: MemoryRecallPolicyOptions,
  now = new Date(),
): MemoryRetrievedCandidate[] {
  const nowMs = now.getTime();
  const ranked = new Map<string, RankedCandidate>();
  exact.forEach((entry, index) =>
    addRanked(ranked, entry, 'exact', index + 1, 4, 'exact_key_or_content_match', nowMs),
  );
  lexical.forEach((entry, index) => {
    const overlap = lexicalOverlap(entry, query);
    if (overlap >= 0.2)
      addRanked(
        ranked,
        entry,
        'lexical',
        index + 1,
        1,
        `lexical_overlap_${overlap.toFixed(2)}`,
        nowMs,
        overlap,
      );
  });
  semantic.forEach((entry, index) => {
    const similarity = entry.semanticSimilarity;
    if (similarity !== undefined && similarity >= options.semanticSimilarityThreshold) {
      addRanked(
        ranked,
        entry,
        'semantic',
        index + 1,
        1.5,
        `cosine_similarity_${similarity.toFixed(3)}`,
        nowMs,
        similarity,
      );
    }
  });

  const newestByKey = new Map<string, RankedCandidate>();
  for (const candidate of ranked.values()) {
    const key = normalizeMemoryKey(candidate.entry.key);
    const previous = newestByKey.get(key);
    if (
      !previous ||
      candidate.entry.revision > previous.entry.revision ||
      (candidate.entry.revision === previous.entry.revision && candidate.score > previous.score)
    ) {
      newestByKey.set(key, candidate);
    }
  }
  return [...newestByKey.values()]
    .filter(
      (candidate) => candidate.sources.has('exact') || candidate.score >= options.minimumScore,
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.entry.revision - left.entry.revision ||
        left.entry.key.localeCompare(right.entry.key),
    )
    .slice(0, options.topK)
    .map((candidate) => ({
      canonicalKey: normalizeMemoryKey(candidate.entry.key),
      key: candidate.entry.key,
      content: candidate.entry.content,
      revision: candidate.entry.revision,
      updatedAt: candidate.entry.updatedAt,
      sourceEventId: candidate.entry.sourceEventId,
      sourceKind: candidate.entry.sourceKind,
      score: candidate.score,
      sources: [...candidate.sources].sort(),
      reasons: [...candidate.reasons].sort(),
    }));
}
