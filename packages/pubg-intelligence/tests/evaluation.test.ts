import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildEvaluationExperiment,
  ExperimentRunStore,
  replayTacticalBenchmark,
} from '../src/index.js';

test('R4 replay is deterministic, split by whole match, fingerprinted, and compares baseline with candidate', () => {
  const first = replayTacticalBenchmark();
  const second = replayTacticalBenchmark();
  assert.equal(first.evaluationEngineVersion, 'pubg-intelligence-evaluation-v1');
  assert.equal(first.dataset.fingerprint, second.dataset.fingerprint);
  assert.deepEqual(first.caseOutcomes, second.caseOutcomes);
  assert.equal(first.dataset.caseCount, 8);
  assert.equal(first.dataset.holdoutCaseCount, 5);
  assert.equal(first.candidate.holdout.truePositive, 1);
  assert.equal(first.candidate.holdout.falsePositive, 0);
  assert.equal(first.candidate.holdout.falseNegative, 0);
  assert.equal(first.baseline.holdout.falsePositive, 1);
  assert.equal(first.comparison.holdoutFalsePositiveDelta, -1);
  assert.equal(first.comparison.holdoutFalseNegativeDelta, 0);
  assert.equal(first.comparison.baselineNotRegressed, true);
  assert.equal(first.comparison.fixtureLabeledHoldoutCaseCount, 3);
  assert.equal(first.templateEvaluation.templateCount, 3);
  assert.equal(first.templateEvaluation.numericFactParity, true);
  assert.equal(first.templateEvaluation.uniqueWordingCount, 3);
  assert.equal(first.templateEvaluation.humanPreferenceStatus, 'not_collected');
  assert.equal(first.promotionGate.historicalHoldoutAvailable, false);
  assert.equal(first.promotionGate.humanReviewedHoldoutAvailable, false);
  assert.equal(first.promotionGate.ready, false);
  assert.ok(first.promotionGate.reasons.some((reason) => reason.includes('historical holdout')));
  assert.ok(first.promotionGate.reasons.some((reason) => reason.includes('analyst review')));
  assert.ok(
    first.counterexamples.some(
      (row) => row.candidateError === null && row.baselineError === 'false_positive',
    ),
  );
  assert.ok(
    first.caseOutcomes.every((row) =>
      row.candidateEvidence.every(
        (ref) => ref.eventId === null || /^telemetry-\d+$/u.test(ref.eventId),
      ),
    ),
  );
});

test('benchmark evaluator reports unresolved labels, abstentions, and regressions without hiding error counts', () => {
  const report = buildEvaluationExperiment({
    experimentName: 'gate-test',
    datasetId: 'fixture',
    datasetFingerprint: 'fixture-fingerprint',
    ruleId: 'combat.first-knock-share',
    baselineVersion: 'baseline',
    candidateVersion: 'candidate',
    parserVersion: 'parser',
    thresholds: { window: 28 },
    startedAt: '2026-10-17T00:00:00.000Z',
    runtimeMs: 1,
    resourceUsage: {
      heapUsedBytesBefore: 100,
      heapUsedBytesAfter: 110,
      heapUsedDeltaBytes: 10,
      rssBytesAfter: 500,
    },
    templateEvaluation: {
      templateCount: 3,
      numericFactParity: true,
      uniqueWordingCount: 3,
      humanPreferenceLabels: 0,
    },
    predictions: [
      {
        caseId: 'dev',
        split: 'development',
        stratum: 'clear',
        expected: true,
        baseline: true,
        candidate: true,
      },
      {
        caseId: 'holdout-fp',
        split: 'holdout',
        stratum: 'negative',
        expected: false,
        baseline: false,
        candidate: true,
      },
      {
        caseId: 'holdout-abstain',
        split: 'holdout',
        stratum: 'partial',
        expected: true,
        baseline: null,
        candidate: null,
      },
      {
        caseId: 'holdout-unknown',
        split: 'holdout',
        stratum: 'unknown',
        expected: null,
        baseline: false,
        candidate: null,
      },
    ],
  });
  assert.equal(report.candidate.holdout.falsePositive, 1);
  assert.equal(report.candidate.holdout.falseNegative, 1);
  assert.equal(report.candidate.holdout.abstainedPredictions, 1);
  assert.equal(report.candidate.holdout.unresolvedLabels, 1);
  assert.equal(report.comparison.baselineNotRegressed, false);
  assert.equal(report.promotionGate.ready, false);
  assert.ok(
    report.counterexamples.some(
      (row) => row.caseId === 'holdout-fp' && row.candidateError === 'false_positive',
    ),
  );
});

test('evaluation experiments and bounded human review labels persist in the separate experiment store', () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-intelligence-evaluation-store-'));
  const path = join(root, 'experiments.sqlite');
  try {
    const store = new ExperimentRunStore(path);
    const report = replayTacticalBenchmark();
    const runId = store.saveEvaluation(report);
    assert.equal(store.getEvaluation(runId)?.dataset.fingerprint, report.dataset.fingerprint);
    assert.equal(store.listEvaluations(10)[0]?.runId, runId);
    assert.throws(
      () =>
        store.saveEvaluationReview({
          runId,
          caseId: 'outside-case',
          ruleId: report.algorithm.ruleId,
          label: 'confirm',
        }),
      /evaluation_review_outside_run/u,
    );
    const review = store.saveEvaluationReview({
      runId,
      caseId: 'r4-holdout-negative-01',
      ruleId: report.algorithm.ruleId,
      label: 'wrong_evidence',
    });
    assert.equal(review.label, 'wrong_evidence');
    assert.deepEqual(
      store.listEvaluationReviews(runId).map((row) => row.caseId),
      ['r4-holdout-negative-01'],
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
