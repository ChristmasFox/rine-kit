import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDeepPromotion, type DeepPromotionEvidence } from '../src/index.js';

function evidence(overrides: Partial<DeepPromotionEvidence> = {}): DeepPromotionEvidence {
  return {
    candidateKind: 'stable_preference',
    sourceReliability: 85,
    supportingObservations: 2,
    distinctObservationDays: 2,
    recallCount: 0,
    distinctQueries: 0,
    usedCount: 0,
    ageDays: 0,
    conflictsWithCurrent: false,
    competingValues: 0,
    prohibited: false,
    ...overrides,
  };
}

test('one casual mention cannot promote even when model confidence was high', () => {
  const decision = evaluateDeepPromotion(
    evidence({ supportingObservations: 1, distinctObservationDays: 1 }),
  );
  assert.equal(decision.promote, false);
  assert.equal(decision.reason, 'single_observation');
});

test('the same stable preference repeated across days can promote', () => {
  const decision = evaluateDeepPromotion(evidence());
  assert.equal(decision.promote, true);
  assert.equal(decision.reason, 'promotion_evidence_sufficient');
  assert.ok(decision.score >= decision.threshold);
});

test('a corrected value must clear the current-memory conflict while retaining enough evidence', () => {
  const clear = evaluateDeepPromotion(evidence());
  const correction = evaluateDeepPromotion(evidence({ conflictsWithCurrent: true }));
  assert.equal(correction.promote, true);
  assert.ok(correction.score < clear.score);
});

test('distinct recalled queries and actual use strengthen repeated same-day evidence', () => {
  const withoutUse = evaluateDeepPromotion(evidence({ distinctObservationDays: 1 }));
  const withUse = evaluateDeepPromotion(
    evidence({ distinctObservationDays: 1, recallCount: 3, distinctQueries: 2, usedCount: 1 }),
  );
  assert.equal(withoutUse.promote, false);
  assert.equal(withoutUse.reason, 'insufficient_repetition_or_usage');
  assert.equal(withUse.promote, true);
  assert.ok(withUse.score > withoutUse.score);
});

test('weak sources, unresolved competing values, stale, sensitive, and prohibited evidence fail closed', () => {
  assert.equal(
    evaluateDeepPromotion(evidence({ sourceReliability: 79 })).reason,
    'source_unreliable',
  );
  assert.equal(
    evaluateDeepPromotion(evidence({ competingValues: 1 })).reason,
    'ambiguous_conflict',
  );
  assert.equal(evaluateDeepPromotion(evidence({ ageDays: 31 })).reason, 'stale_evidence');
  assert.equal(
    evaluateDeepPromotion(evidence({ prohibited: true })).reason,
    'sensitive_or_prohibited',
  );
});
