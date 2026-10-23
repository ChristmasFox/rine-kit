import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExperimentRunStore } from '../src/experiment-store.js';
import { replayTacticalBenchmark } from '../src/evaluation-replay.js';

const filename =
  process.env.PUBG_INTELLIGENCE_EXPERIMENT_DB?.trim() ||
  join(homedir(), '.local', 'share', 'amadeus', 'pubg-intelligence-lab', 'experiments.sqlite');
const store = new ExperimentRunStore(filename);
try {
  const report = replayTacticalBenchmark();
  const runId = store.saveEvaluation(report);
  process.stdout.write(
    `${JSON.stringify(
      {
        runId,
        experimentName: report.experimentName,
        dataset: report.dataset,
        algorithm: report.algorithm,
        provenance: report.provenance,
        baselineHoldout: report.baseline.holdout,
        candidateHoldout: report.candidate.holdout,
        templateEvaluation: report.templateEvaluation,
        comparison: report.comparison,
        promotionGate: report.promotionGate,
        counterexamples: report.counterexamples.map((row) => ({
          caseId: row.caseId,
          stratum: row.stratum,
          expected: row.expected,
          baselineError: row.baselineError,
          candidateError: row.candidateError,
          candidateEvidence: row.candidateEvidence,
        })),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  store.close();
}
