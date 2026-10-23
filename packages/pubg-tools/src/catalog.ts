import type { z } from 'zod';
import type {
  CompareToolInput,
  GetMatchInput,
  GetPeriodReviewInput,
  GetReviewFactsInput,
  Metric,
  PubgDomainService,
  ResolvePlayersInput,
  SearchMatchesInput,
  StatsToolInput,
  TeamDamageQueryInput,
  ToolEnvelope,
  ToolSelectorInput,
} from '@rine-kit/pubg-domain';
import {
  compareInput,
  matchInput,
  periodReviewInput,
  queryStatsInput,
  resolvePlayersInput,
  reviewFactsInput,
  searchMatchesInput,
  teamDamageInput,
} from './schemas.js';

export interface PubgToolRunContext {
  /** Names the conversation so result sets stay private to it. */
  sessionId: string;
  signal?: AbortSignal;
}

export interface PubgToolSpec<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /**
   * The tool is about people: the host must turn "who" (named players, the team, or the asker) into
   * concrete player ids before the call. Tools about a match or a period of the whole team skip this.
   */
  requiresSubject: boolean;
  run(
    service: PubgDomainService,
    input: z.output<S>,
    context: PubgToolRunContext,
  ): Promise<ToolEnvelope>;
}

const spec = <S extends z.ZodType>(s: PubgToolSpec<S>) => s as unknown as PubgToolSpec;
const selectorInput = (value: unknown) => value as ToolSelectorInput;
const withSignal = (context: PubgToolRunContext) =>
  context.signal ? { signal: context.signal } : {};

// Descriptions and the calls into the Domain are those of Lab's plugins/pubg, unchanged.
export const PUBG_TOOLS: readonly PubgToolSpec[] = [
  spec({
    name: 'pubg_resolve_players',
    description:
      'Resolve configured PUBG players and aliases, or look up one exact official player name.',
    input: resolvePlayersInput,
    requiresSubject: true,
    run: (service, input, context) =>
      service.resolvePlayers({ ...input, sessionId: context.sessionId } as ResolvePlayersInput),
  }),
  spec({
    name: 'pubg_search_matches',
    description:
      'Search bounded PUBG matches and return a fresh resultSetId for follow-up facts or review. Not for 今日/昨日/本周战绩 record requests (use pubg_query_stats).',
    input: searchMatchesInput,
    requiresSubject: true,
    run: (service, input, context) =>
      service.searchMatches({ ...input, sessionId: context.sessionId } as SearchMatchesInput),
  }),
  spec({
    name: 'pubg_query_stats',
    description:
      'Query deterministic PUBG aggregates for a bounded selector and return validated presentation/displayText.',
    input: queryStatsInput,
    requiresSubject: true,
    run: (service, input, context) =>
      service.queryStats({
        ...input,
        sessionId: context.sessionId,
        selector: selectorInput(input.selector),
        metrics: input.metrics as Metric[],
        ...withSignal(context),
      } as StatsToolInput),
  }),
  spec({
    name: 'pubg_compare_stats',
    description:
      'Compare two bounded PUBG segments and return independent source ranges with validated presentation/displayText.',
    input: compareInput,
    requiresSubject: true,
    run: (service, input, context) =>
      service.compareStats({
        ...input,
        sessionId: context.sessionId,
        segments: input.segments.map((segment) => ({
          ...segment,
          selector: selectorInput(segment.selector),
        })),
        metrics: input.metrics as Metric[],
        ...withSignal(context),
      } as CompareToolInput),
  }),
  spec({
    name: 'pubg_get_match',
    description:
      'Get one selected PUBG Match API record and return validated presentation/displayText.',
    input: matchInput,
    requiresSubject: false,
    run: (service, input, context) =>
      service.getMatch({
        ...input,
        sessionId: context.sessionId,
        ...withSignal(context),
      } as GetMatchInput),
  }),
  spec({
    name: 'pubg_get_review_facts',
    description:
      'Get deterministic Telemetry facts for one selected match from a fresh search resultSetId; return validated presentation/displayText.',
    input: reviewFactsInput,
    requiresSubject: true,
    run: (service, input, context) =>
      service.getReviewFacts({
        ...input,
        sessionId: context.sessionId,
        ...withSignal(context),
      } as GetReviewFactsInput),
  }),
  spec({
    name: 'pubg_get_period_review',
    description:
      'Build a bounded multi-match review from a fresh search resultSetId; Domain owns order, freshness, and partial coverage.',
    input: periodReviewInput,
    requiresSubject: true,
    run: (service, input, context) =>
      service.getPeriodReview({
        ...input,
        sessionId: context.sessionId,
        ...withSignal(context),
      } as GetPeriodReviewInput),
  }),
  spec({
    name: 'pubg_query_team_damage',
    description:
      'Query bounded directional team-damage facts; provide actor/victim together or omit both.',
    input: teamDamageInput,
    requiresSubject: false,
    run: (service, input, context) =>
      service.queryTeamDamage({
        ...input,
        sessionId: context.sessionId,
        ...withSignal(context),
      } as TeamDamageQueryInput),
  }),
];
