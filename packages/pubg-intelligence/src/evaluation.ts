import { createHash } from 'node:crypto';

export const EVALUATION_MANIFEST_VERSION = 1 as const;
export const EVALUATION_ENGINE_VERSION = 'pubg-intelligence-evaluation-v1' as const;

export type BenchmarkSplit = 'development' | 'holdout';
export type BenchmarkPrediction = boolean | null;
export type BenchmarkErrorKind = 'false_positive' | 'false_negative';

export interface BenchmarkEvidenceRef {
  matchId: string;
  eventId: string | null;
  timeSeconds: number | null;
  kind: string;
}

export interface BenchmarkCaseResult {
  caseId: string;
  split: BenchmarkSplit;
  stratum: string;
  expected: boolean | null;
  baseline: BenchmarkPrediction;
  candidate: BenchmarkPrediction;
  baselineEvidence: BenchmarkEvidenceRef[];
  candidateEvidence: BenchmarkEvidenceRef[];
  baselineError: BenchmarkErrorKind | null;
  candidateError: BenchmarkErrorKind | null;
  comparison: 'improved' | 'regressed' | 'unchanged' | 'unresolved';
}

export interface BinaryBenchmarkMetrics {
  labeledCases: number;
  unresolvedLabels: number;
  abstainedPredictions: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface EvaluationExperimentReport {
  manifestVersion: typeof EVALUATION_MANIFEST_VERSION;
  evaluationEngineVersion: typeof EVALUATION_ENGINE_VERSION;
  experimentName: string;
  dataset: {
    id: string;
    fingerprint: string;
    caseCount: number;
    holdoutCaseCount: number;
    strata: Array<{ name: string; count: number }>;
  };
  algorithm: {
    ruleId: string;
    baselineVersion: string;
    candidateVersion: string;
    parserVersion: string;
    thresholds: Record<string, number | string | boolean | null>;
  };
  provenance: {
    source: 'sanitized-fixture';
    annotation: 'fixture-ground-truth';
    runtimeMs: number;
    startedAt: string;
    resourceUsage: {
      heapUsedBytesBefore: number;
      heapUsedBytesAfter: number;
      heapUsedDeltaBytes: number;
      rssBytesAfter: number;
    };
  };
  baseline: {
    all: BinaryBenchmarkMetrics;
    development: BinaryBenchmarkMetrics;
    holdout: BinaryBenchmarkMetrics;
  };
  candidate: {
    all: BinaryBenchmarkMetrics;
    development: BinaryBenchmarkMetrics;
    holdout: BinaryBenchmarkMetrics;
  };
  templateEvaluation: {
    templateCount: number;
    numericFactParity: boolean;
    uniqueWordingCount: number;
    humanPreferenceLabels: number;
    humanPreferenceStatus: 'not_collected';
  };
  comparison: {
    holdoutFalsePositiveDelta: number;
    holdoutFalseNegativeDelta: number;
    baselineNotRegressed: boolean;
    fixtureLabeledHoldoutCaseCount: number;
  };
  promotionGate: {
    baselineNotRegressed: boolean;
    fixtureLabeledHoldoutAvailable: boolean;
    humanReviewedHoldoutAvailable: false;
    historicalHoldoutAvailable: false;
    ready: boolean;
    reasons: string[];
  };
  caseOutcomes: BenchmarkCaseResult[];
  counterexamples: BenchmarkCaseResult[];
}

export interface BenchmarkPredictionInput {
  caseId: string;
  split: BenchmarkSplit;
  stratum: string;
  expected: boolean | null;
  baseline: BenchmarkPrediction;
  candidate: BenchmarkPrediction;
  baselineEvidence?: readonly BenchmarkEvidenceRef[];
  candidateEvidence?: readonly BenchmarkEvidenceRef[];
}

export interface EvaluationExperimentInput {
  experimentName: string;
  datasetId: string;
  datasetFingerprint: string;
  ruleId: string;
  baselineVersion: string;
  candidateVersion: string;
  parserVersion: string;
  thresholds: Record<string, number | string | boolean | null>;
  startedAt: string;
  runtimeMs: number;
  resourceUsage: {
    heapUsedBytesBefore: number;
    heapUsedBytesAfter: number;
    heapUsedDeltaBytes: number;
    rssBytesAfter: number;
  };
  predictions: readonly BenchmarkPredictionInput[];
  templateEvaluation: {
    templateCount: number;
    numericFactParity: boolean;
    uniqueWordingCount: number;
    humanPreferenceLabels: number;
  };
}

function errorFor(
  expected: boolean | null,
  prediction: BenchmarkPrediction,
): BenchmarkErrorKind | null {
  if (expected === null) return null;
  if (expected && prediction !== true) return 'false_negative';
  if (!expected && prediction === true) return 'false_positive';
  return null;
}

function metricsFor(
  rows: readonly BenchmarkCaseResult[],
  which: 'baseline' | 'candidate',
): BinaryBenchmarkMetrics {
  let labeledCases = 0;
  let unresolvedLabels = 0;
  let abstainedPredictions = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const row of rows) {
    if (row.expected === null) {
      unresolvedLabels += 1;
      continue;
    }
    labeledCases += 1;
    const prediction = row[which];
    if (prediction === null) abstainedPredictions += 1;
    if (row.expected && prediction === true) truePositive += 1;
    else if (row.expected) falseNegative += 1;
    else if (prediction === true) falsePositive += 1;
    else if (prediction === false) trueNegative += 1;
  }
  const precision =
    truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null;
  const recall =
    truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return {
    labeledCases,
    unresolvedLabels,
    abstainedPredictions,
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision,
    recall,
    f1,
  };
}

export function fingerprintBenchmarkDataset(dataset: unknown): string {
  return createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
}

export function buildEvaluationExperiment(
  input: EvaluationExperimentInput,
): EvaluationExperimentReport {
  if (!input.predictions.length) throw new Error('benchmark_corpus_empty');
  const caseIds = new Set<string>();
  for (const row of input.predictions) {
    if (caseIds.has(row.caseId)) throw new Error('benchmark_case_id_duplicate');
    caseIds.add(row.caseId);
  }
  const caseOutcomes: BenchmarkCaseResult[] = input.predictions
    .map((row) => {
      const baselineError = errorFor(row.expected, row.baseline);
      const candidateError = errorFor(row.expected, row.candidate);
      const comparison: BenchmarkCaseResult['comparison'] =
        row.expected === null
          ? 'unresolved'
          : candidateError === null && baselineError !== null
            ? 'improved'
            : candidateError !== null && baselineError === null
              ? 'regressed'
              : 'unchanged';
      return {
        caseId: row.caseId,
        split: row.split,
        stratum: row.stratum,
        expected: row.expected,
        baseline: row.baseline,
        candidate: row.candidate,
        baselineEvidence: [...(row.baselineEvidence ?? [])],
        candidateEvidence: [...(row.candidateEvidence ?? [])],
        baselineError,
        candidateError,
        comparison,
      };
    })
    .sort(
      (left, right) =>
        left.split.localeCompare(right.split) || left.caseId.localeCompare(right.caseId),
    );
  const all = caseOutcomes;
  const development = all.filter((row) => row.split === 'development');
  const holdout = all.filter((row) => row.split === 'holdout');
  if (!development.length || !holdout.length)
    throw new Error('benchmark_requires_development_and_holdout');
  const baselineHoldout = metricsFor(holdout, 'baseline');
  const candidateHoldout = metricsFor(holdout, 'candidate');
  const baselineNotRegressed =
    candidateHoldout.falsePositive <= baselineHoldout.falsePositive &&
    candidateHoldout.falseNegative <= baselineHoldout.falseNegative;
  const fixtureLabeledHoldoutCaseCount = holdout.filter((row) => row.expected !== null).length;
  const reasons = [
    ...(!baselineNotRegressed
      ? ['Candidate increases a labeled holdout false positive or false negative.']
      : []),
    ...(fixtureLabeledHoldoutCaseCount === 0
      ? ['Holdout has no fixture ground-truth labels.']
      : []),
    'No analyst review labels have been collected for this benchmark run.',
    'This replay uses sanitized fixtures only; a historical holdout has not been independently labeled.',
  ];
  const strata = new Map<string, number>();
  for (const row of caseOutcomes) strata.set(row.stratum, (strata.get(row.stratum) ?? 0) + 1);
  return {
    manifestVersion: EVALUATION_MANIFEST_VERSION,
    evaluationEngineVersion: EVALUATION_ENGINE_VERSION,
    experimentName: input.experimentName,
    dataset: {
      id: input.datasetId,
      fingerprint:
        input.datasetFingerprint ||
        fingerprintBenchmarkDataset({
          datasetId: input.datasetId,
          cases: input.predictions
            .map(({ caseId, split, stratum, expected }) => ({ caseId, split, stratum, expected }))
            .sort((left, right) => left.caseId.localeCompare(right.caseId)),
        }),
      caseCount: caseOutcomes.length,
      holdoutCaseCount: holdout.length,
      strata: [...strata.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, count]) => ({ name, count })),
    },
    algorithm: {
      ruleId: input.ruleId,
      baselineVersion: input.baselineVersion,
      candidateVersion: input.candidateVersion,
      parserVersion: input.parserVersion,
      thresholds: { ...input.thresholds },
    },
    provenance: {
      source: 'sanitized-fixture',
      annotation: 'fixture-ground-truth',
      runtimeMs: Math.max(0, input.runtimeMs),
      startedAt: input.startedAt,
      resourceUsage: { ...input.resourceUsage },
    },
    baseline: {
      all: metricsFor(all, 'baseline'),
      development: metricsFor(development, 'baseline'),
      holdout: baselineHoldout,
    },
    candidate: {
      all: metricsFor(all, 'candidate'),
      development: metricsFor(development, 'candidate'),
      holdout: candidateHoldout,
    },
    templateEvaluation: { ...input.templateEvaluation, humanPreferenceStatus: 'not_collected' },
    comparison: {
      holdoutFalsePositiveDelta: candidateHoldout.falsePositive - baselineHoldout.falsePositive,
      holdoutFalseNegativeDelta: candidateHoldout.falseNegative - baselineHoldout.falseNegative,
      baselineNotRegressed,
      fixtureLabeledHoldoutCaseCount,
    },
    promotionGate: {
      baselineNotRegressed,
      fixtureLabeledHoldoutAvailable: fixtureLabeledHoldoutCaseCount > 0,
      humanReviewedHoldoutAvailable: false,
      historicalHoldoutAvailable: false,
      ready: false,
      reasons,
    },
    caseOutcomes,
    counterexamples: caseOutcomes.filter(
      (row) => row.candidateError !== null || row.baselineError !== null || row.expected === null,
    ),
  };
}
