import {
  BATTLE_RECONSTRUCTION_PARSER_VERSION,
  normalizeBattleTelemetry,
  reconstructBattleEpisodes,
} from './battle.js';
import { analyzeTacticalMatch, TACTICAL_RULE_VERSION } from './tactics.js';
import {
  buildEvaluationExperiment,
  fingerprintBenchmarkDataset,
  type BenchmarkEvidenceRef,
  type EvaluationExperimentReport,
} from './evaluation.js';
import { renderResearchTemplate, type ResearchTemplate } from './assistant.js';
import { createTacticalBenchmarkFixtures } from './evaluation-fixtures.js';

export const R4_BENCHMARK_DATASET_ID = 'pubg-intelligence-r4-first-knock-fixtures-v1' as const;
export const R4_BASELINE_VERSION = 'legacy-any-tracked-knock-v0' as const;
export const R4_CANDIDATE_VERSION = TACTICAL_RULE_VERSION;

function evidenceRefs(
  refs: readonly {
    matchId: string;
    eventId: string | null;
    timeSeconds: number | null;
    kind: string;
  }[],
): BenchmarkEvidenceRef[] {
  return refs.map((ref) => ({
    matchId: ref.matchId,
    eventId: ref.eventId,
    timeSeconds: ref.timeSeconds,
    kind: ref.kind,
  }));
}

export function replayTacticalBenchmark(): EvaluationExperimentReport {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const memoryBefore = process.memoryUsage();
  const fixtures = createTacticalBenchmarkFixtures();
  const predictions = fixtures.map((fixture) => {
    const telemetry = normalizeBattleTelemetry(fixture.telemetryPayload, fixture.match);
    const reconstruction = reconstructBattleEpisodes({
      match: fixture.match,
      telemetry,
      trackedPlayerIds: fixture.trackedPlayerIds,
    });
    const analysis = analyzeTacticalMatch({
      match: fixture.match,
      telemetry,
      reconstruction,
      trackedPlayerIds: fixture.trackedPlayerIds,
    });
    const candidate = analysis.candidates.find((row) => row.ruleId === 'combat.first-knock-share');
    if (!candidate) throw new Error('benchmark_candidate_rule_missing');
    const tracked = new Set(fixture.trackedPlayerIds);
    const trackedKnocks = telemetry.events.filter(
      (event) => event.type === 'KNOCK' && event.actorId !== null && tracked.has(event.actorId),
    );
    const baselineEvidence = trackedKnocks.map((event) => ({
      matchId: fixture.match.matchId,
      eventId: event.sourceEventId,
      timeSeconds: event.timeSeconds,
      kind: 'legacy-any-tracked-knock',
    }));
    return {
      caseId: fixture.caseId,
      split: fixture.split,
      stratum: fixture.stratum,
      expected: fixture.expectedFirstKnockBySquad,
      baseline: trackedKnocks.length > 0,
      candidate: candidate.metric.numerator === null ? null : candidate.metric.numerator > 0,
      baselineEvidence,
      candidateEvidence: evidenceRefs([...candidate.supportEvents, ...candidate.counterexamples]),
    };
  });
  const datasetFingerprint = fingerprintBenchmarkDataset({
    id: R4_BENCHMARK_DATASET_ID,
    cases: fixtures.map(
      ({
        caseId,
        split,
        stratum,
        expectedFirstKnockBySquad,
        match,
        trackedPlayerIds,
        telemetryPayload,
      }) => ({
        caseId,
        split,
        stratum,
        expectedFirstKnockBySquad,
        match,
        trackedPlayerIds,
        telemetryPayload,
      }),
    ),
  });
  const factualTemplateText = '3 matches, 500 average damage, 2 knock conversions.';
  const templates: ResearchTemplate[] = ['tactical_coaching', 'squad_humor', 'chronological_story'];
  const templateOutputs = templates.map((template) =>
    renderResearchTemplate(template, factualTemplateText),
  );
  const numbersIn = (value: string) => value.match(/(?<![\p{L}\p{N}])\d[\d,]*(?:\.\d+)?%?/gu) ?? [];
  const expectedNumbers = numbersIn(factualTemplateText);
  const memoryAfter = process.memoryUsage();
  return buildEvaluationExperiment({
    experimentName: 'R4 first-knock baseline versus episode-aware rule',
    datasetId: R4_BENCHMARK_DATASET_ID,
    datasetFingerprint,
    ruleId: 'combat.first-knock-share',
    baselineVersion: R4_BASELINE_VERSION,
    candidateVersion: R4_CANDIDATE_VERSION,
    parserVersion: BATTLE_RECONSTRUCTION_PARSER_VERSION,
    thresholds: {
      ruleId: 'combat.first-knock-share',
      baseline: 'any tracked KNOCK event in match',
      candidate: 'tracked attacker of the first knock in an R1 episode',
      contactGapSeconds: 28,
      missingTimestamp: 'unresolved',
    },
    startedAt,
    runtimeMs: performance.now() - start,
    resourceUsage: {
      heapUsedBytesBefore: memoryBefore.heapUsed,
      heapUsedBytesAfter: memoryAfter.heapUsed,
      heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssBytesAfter: memoryAfter.rss,
    },
    templateEvaluation: {
      templateCount: templates.length,
      numericFactParity: templateOutputs.every(
        (output) => JSON.stringify(numbersIn(output)) === JSON.stringify(expectedNumbers),
      ),
      uniqueWordingCount: new Set(templateOutputs).size,
      humanPreferenceLabels: 0,
    },
    predictions,
  });
}
