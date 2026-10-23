import type { MemoryCandidateDraft, MemoryCandidateKind } from '../contracts.js';

export interface MemoryCandidateSource {
  content: string;
  sourceEventId: string;
}

export interface NormalizedMemoryCandidate {
  key: string;
  content: string;
  kind: MemoryCandidateKind;
  validUntil: string | null;
  evidenceEventIds: string[];
  idempotencyKey: string;
}

export interface NormalizeMemoryCandidatesOptions {
  maxCandidates: number;
  now: () => number;
  canonicalizeKey: (key: string) => string;
  isProhibited: (text: string) => boolean;
  createIdempotencyKey: (input: {
    key: string;
    content: string;
    evidenceEventIds: readonly string[];
  }) => string;
}

/** Normalize bounded Light/REM drafts against their source evidence before persistence. */
export function normalizeMemoryCandidates(
  drafts: readonly MemoryCandidateDraft[],
  sources: readonly MemoryCandidateSource[],
  options: NormalizeMemoryCandidatesOptions,
): NormalizedMemoryCandidate[] {
  const accepted: NormalizedMemoryCandidate[] = [];
  const seenKeys = new Set<string>();

  for (const draft of drafts.slice(0, Math.max(0, options.maxCandidates))) {
    if (draft.subject !== 'self' || draft.confidence !== 'high') continue;
    if (!validCandidateKindAndValidity(draft.kind, draft.validity)) continue;

    const evidence = draft.evidence.trim().normalize('NFKC');
    const content = draft.content.trim().normalize('NFKC');
    if (!content || !evidence.includes(content) || options.isProhibited(`${evidence}\n${content}`))
      continue;

    const evidenceSources = sources.filter((source) =>
      source.content.normalize('NFKC').includes(evidence),
    );
    if (!evidenceSources.length) continue;

    let key: string;
    try {
      key = options.canonicalizeKey(draft.key);
    } catch {
      continue;
    }
    if (seenKeys.has(key)) continue;

    const evidenceEventIds = [
      ...new Set(evidenceSources.map((source) => source.sourceEventId)),
    ].slice(0, 8);
    seenKeys.add(key);
    accepted.push({
      key,
      content,
      kind: draft.kind,
      validUntil: candidateExpiry(draft.kind, draft.validity, options.now()),
      evidenceEventIds,
      idempotencyKey: options.createIdempotencyKey({ key, content, evidenceEventIds }),
    });
  }

  return accepted;
}

function validCandidateKindAndValidity(
  kind: MemoryCandidateKind,
  validity: MemoryCandidateDraft['validity'],
): boolean {
  if (kind === 'stable_preference') return validity === 'stable';
  if (kind === 'verifiable_fact')
    return validity === '7_days' || validity === '30_days' || validity === '90_days';
  return validity === '7_days' || validity === '30_days';
}

function candidateExpiry(
  kind: MemoryCandidateKind,
  validity: MemoryCandidateDraft['validity'],
  now: number,
): string | null {
  if (kind === 'stable_preference' && validity === 'stable') return null;
  const days =
    validity === '7_days' ? 7 : validity === '30_days' ? 30 : validity === '90_days' ? 90 : 0;
  return days === 0 ? null : new Date(now + days * 86_400_000).toISOString();
}
