import type { TeamConfig } from '../config/team.js';
import type { DataLayerResult, StructuredResult } from '../data/model.js';
import { emptyMatchReviewFacts } from './review-facts.js';
import { resolveMatchCandidates } from './match-selector.js';
import type {
  MatchSelectionRecord,
  MatchPickerCandidate,
  MatchReviewResult,
  ReviewExecution,
} from './types.js';
import { analyzeMatchReview } from './review-analyzer.js';
import { TelemetryWorker } from './telemetry.js';
import type { CanonicalQuery } from '../schema/query.js';
import type { SessionContextRecord } from '../data/model.js';

export type { ReviewExecution } from './types.js';

export interface ReviewSubgraphOptions {
  team: TeamConfig;
  telemetryWorker?: TelemetryWorker;
}

export interface ReviewRequest {
  query: CanonicalQuery;
  data: DataLayerResult;
  sessionId: string;
  context: SessionContextRecord | null;
  now: Date;
  sourceMatchResultSetId?: string | null;
  selection?: MatchSelectionRecord | null;
}

function resultEvidence(candidate: MatchPickerCandidate[], query: CanonicalQuery) {
  return {
    matchIds: candidate.map((item) => item.match.matchId),
    playerIds: [
      ...new Set(
        candidate.flatMap((item) => item.row.players?.map((player) => player.accountId) ?? []),
      ),
    ],
    fields: ['matchId', 'createdAt', 'mapName', 'rank', 'kills', 'assists', 'damage'],
    calculation: 'pubg_review_subgraph_v3_3',
    selector: query.matchSelector ?? null,
  };
}

function baseResult(
  request: ReviewRequest,
  status: StructuredResult['status'],
  candidates: MatchPickerCandidate[],
  selected: MatchPickerCandidate | null,
): StructuredResult {
  return {
    queryId: request.query.queryId,
    sessionId: request.sessionId,
    status,
    data: {
      operation: 'review_match',
      groupBy: 'match',
      rows: selected ? [selected.row] : candidates.map((candidate) => candidate.row),
      summary: {
        periodLabel: request.query.selector.label ?? '复盘范围',
        candidateCount: candidates.length,
        ...(selected
          ? { selectedMatchId: selected.match.matchId, selectedOrdinal: selected.ordinal }
          : {}),
      },
    },
    coverage: request.data.coverage,
    source: request.data.source,
    evidence: resultEvidence(candidates, request.query),
    diagnostics: {
      calculation: 'pubg_review_subgraph_v3_3',
      telemetryRequested: Boolean(selected),
      telemetryFetchedOnlyAfterUniqueMatch: true,
    },
  };
}

export class ReviewSubgraph {
  private readonly team: TeamConfig;
  private readonly telemetryWorker: TelemetryWorker;

  constructor(options: ReviewSubgraphOptions) {
    this.team = options.team;
    this.telemetryWorker = options.telemetryWorker ?? new TelemetryWorker({ team: this.team });
  }

  async execute(request: ReviewRequest): Promise<ReviewExecution> {
    const resolution = resolveMatchCandidates(
      request.data.records,
      request.query,
      this.team,
      request.now,
      request.context,
    );
    let candidates = resolution.candidates;
    let selected = resolution.selected;
    if (request.selection) {
      const selectedIndex = candidates.findIndex(
        (candidate) => candidate.match.matchId === request.selection?.matchId,
      );
      const forced = selectedIndex >= 0 ? candidates[selectedIndex] : undefined;
      if (forced) {
        // The callback query narrows the ResultSet to one match. Rebind the
        // candidate's ordinal from the selection record so the source Picker
        // order survives that narrowing.
        const rebound = { ...forced, ordinal: request.selection.ordinal };
        candidates = candidates.map((candidate, index) =>
          index === selectedIndex ? rebound : candidate,
        );
        selected = [rebound];
      }
    }
    const pickerCandidates = resolution.selectionRequired
      ? resolution.selector
        ? resolution.selected
        : resolution.candidates
      : candidates;
    if (selected.length === 0) {
      return {
        result: baseResult(request, 'MATCH_NOT_FOUND', candidates, null),
        candidates: pickerCandidates,
        selected: null,
        matchSelector: resolution.selector,
        sourceMatchResultSetId: request.sourceMatchResultSetId ?? null,
      };
    }
    if (selected.length !== 1 || (resolution.selectionRequired && !request.selection)) {
      return {
        result: baseResult(request, 'MATCH_SELECTION_REQUIRED', pickerCandidates, null),
        candidates: pickerCandidates,
        selected: null,
        matchSelector: resolution.selector,
        sourceMatchResultSetId: request.sourceMatchResultSetId ?? null,
        ...(resolution.selector?.type === 'ranked'
          ? { rankedMetric: resolution.selector.metric }
          : {}),
      };
    }

    const target = selected[0];
    if (!target) {
      return {
        result: baseResult(request, 'MATCH_NOT_FOUND', candidates, null),
        candidates,
        selected: null,
        matchSelector: resolution.selector,
        sourceMatchResultSetId: request.sourceMatchResultSetId ?? null,
      };
    }
    const telemetry = await this.telemetryWorker.ensure(target.match, target.ordinal);
    const facts = telemetry.facts ?? emptyMatchReviewFacts(target.match, this.team, target.ordinal);
    const analysis = analyzeMatchReview(facts);
    const review: MatchReviewResult = {
      schemaVersion: 1,
      match: facts.match,
      facts,
      analysis,
      telemetry: {
        status: telemetry.status,
        cacheStatus: telemetry.cacheStatus,
        cacheLookup: telemetry.cacheLookup,
        availability: telemetry.availability,
        parserVersion: telemetry.parserVersion,
        featureVersion: telemetry.featureVersion,
        ...(telemetry.error ? { error: telemetry.error } : {}),
      },
      sourceMatchResultSetId: request.sourceMatchResultSetId ?? null,
    };
    const status: StructuredResult['status'] =
      telemetry.status === 'UNAVAILABLE'
        ? 'REVIEW_PARTIAL'
        : facts.fightIntegrity.pass
          ? 'OK'
          : 'FIGHT_ANALYTICS_INVALID';
    const result = baseResult(request, status, [target], target);
    result.review = review;
    result.diagnostics = {
      ...result.diagnostics,
      telemetryStatus: telemetry.status,
      parserVersion: telemetry.parserVersion,
      featureVersion: telemetry.featureVersion,
      evidenceOnlyCommentary: true,
      fightIntegrity: facts.fightIntegrity,
      ...facts.fightIntegrity.diagnostics,
    };
    return {
      result,
      candidates,
      selected: target,
      matchSelector: resolution.selector,
      sourceMatchResultSetId: request.sourceMatchResultSetId ?? null,
    };
  }
}
