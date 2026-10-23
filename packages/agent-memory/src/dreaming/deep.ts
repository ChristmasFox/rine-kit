import type { MemoryCandidateKind } from '../contracts.js';

/** Evidence collected by the host adapter for one normalized candidate value. */
export interface DeepPromotionEvidence {
  candidateKind: MemoryCandidateKind;
  sourceReliability: number;
  supportingObservations: number;
  distinctObservationDays: number;
  recallCount: number;
  distinctQueries: number;
  usedCount: number;
  ageDays: number;
  conflictsWithCurrent: boolean;
  competingValues: number;
  prohibited: boolean;
}

export type DeepPromotionReason =
  | 'promotion_evidence_sufficient'
  | 'invalid_evidence'
  | 'sensitive_or_prohibited'
  | 'source_unreliable'
  | 'single_observation'
  | 'insufficient_repetition_or_usage'
  | 'ambiguous_conflict'
  | 'stale_evidence'
  | 'score_below_threshold';

export interface DeepPromotionDecision {
  promote: boolean;
  score: number;
  threshold: number;
  reason: DeepPromotionReason;
}

const SCORE_THRESHOLDS: Record<MemoryCandidateKind, number> = {
  stable_preference: 70,
  verifiable_fact: 75,
  episodic_checkpoint: 78,
};

/**
 * Deterministic Deep policy. High model confidence is intentionally absent:
 * repeated, attributable evidence and useful recall are what can promote.
 */
export function evaluateDeepPromotion(evidence: DeepPromotionEvidence): DeepPromotionDecision {
  const threshold = SCORE_THRESHOLDS[evidence.candidateKind];
  const integerFields = [
    evidence.sourceReliability,
    evidence.supportingObservations,
    evidence.distinctObservationDays,
    evidence.recallCount,
    evidence.distinctQueries,
    evidence.usedCount,
    evidence.competingValues,
  ];
  if (
    !threshold ||
    integerFields.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    evidence.sourceReliability > 100 ||
    !Number.isFinite(evidence.ageDays) ||
    evidence.ageDays < 0 ||
    typeof evidence.conflictsWithCurrent !== 'boolean' ||
    typeof evidence.prohibited !== 'boolean'
  ) {
    return { promote: false, score: 0, threshold: threshold ?? 0, reason: 'invalid_evidence' };
  }

  const rawScore =
    evidence.sourceReliability * 0.55 +
    Math.min(evidence.supportingObservations, 4) * 8 +
    Math.min(evidence.distinctObservationDays, 4) * 6 +
    Math.min(evidence.recallCount, 5) +
    Math.min(evidence.distinctQueries, 5) * 2 +
    Math.min(evidence.usedCount, 3) * 4 -
    Math.max(0, evidence.ageDays - 2) * 2 -
    (evidence.conflictsWithCurrent ? 5 : 0) -
    Math.min(evidence.competingValues, 3) * 25;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  const decision = (reason: DeepPromotionReason): DeepPromotionDecision => ({
    promote: false,
    score,
    threshold,
    reason,
  });
  if (evidence.prohibited) return decision('sensitive_or_prohibited');
  if (evidence.sourceReliability < 80) return decision('source_unreliable');
  if (evidence.supportingObservations < 2) return decision('single_observation');
  if (evidence.ageDays > 30) return decision('stale_evidence');
  if (evidence.competingValues > 0) return decision('ambiguous_conflict');

  const repeatedAcrossDays = evidence.distinctObservationDays >= 2;
  const recalledAndUseful =
    evidence.recallCount >= 2 && evidence.distinctQueries >= 2 && evidence.usedCount >= 1;
  if (!repeatedAcrossDays && !recalledAndUseful)
    return decision('insufficient_repetition_or_usage');
  if (score < threshold) return decision('score_below_threshold');
  return { promote: true, score, threshold, reason: 'promotion_evidence_sufficient' };
}
