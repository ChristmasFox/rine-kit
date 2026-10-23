import { z } from 'zod';
import { DataStatusSchema } from './status.js';
import { BUSINESS_DAY_START, DEFAULT_TIMEZONE } from '../time/selector-resolver.js';

export const QUERY_SCHEMA_VERSION = 3;

export const SubjectSchema = z.object({
  type: z.enum(['team', 'player', 'players']),
  ids: z.array(z.string().min(1)),
  label: z.string().optional(),
});

export type Subject = z.infer<typeof SubjectSchema>;

const TimeRangeSelectorSchema = z.object({
  type: z.literal('time_range'),
  start: z.string().min(1),
  end: z.string().min(1),
  label: z.string().optional(),
  timezone: z.string().default(DEFAULT_TIMEZONE),
  businessDayStart: z.string().default(BUSINESS_DAY_START),
});

const RelativePeriodSelectorSchema = z.object({
  type: z.literal('relative_period'),
  value: z.string().min(1),
  label: z.string().optional(),
});

const RecentDaysSelectorSchema = z.object({
  type: z.literal('recent_days'),
  count: z.number().int().min(1).max(366),
  label: z.string().optional(),
});

const LastNMatchesSelectorSchema = z.object({
  type: z.literal('last_n_matches'),
  count: z.number().int().min(1).max(1000),
  offset: z.number().int().min(0).default(0),
  label: z.string().optional(),
});

const ResultSetSelectorSchema = z.object({
  type: z.literal('result_set'),
  resultSetId: z.string().min(1),
  label: z.string().optional(),
});

const MatchOrdinalSchema = z.number().int().min(1).max(1000);

export const MatchRankMetricSchema = z.enum([
  'teamDamage',
  'teamKills',
  'teamAssists',
  'placement',
  'duration',
  'damage',
  'kills',
  'assists',
]);

export type MatchRankMetric = z.infer<typeof MatchRankMetricSchema>;

// Match selection is deliberately separate from the time selector. The former
// chooses one item from a resolved ResultSet; it never changes Query semantics.
export const MatchSelectorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('match_id'),
    matchId: z.string().min(1),
    label: z.string().optional(),
  }),
  z.object({ type: z.literal('latest'), recent: z.boolean().optional() }),
  z.object({ type: z.literal('earliest') }),
  z.object({ type: z.literal('ordinal'), ordinal: MatchOrdinalSchema }),
  z.object({ type: z.literal('ordinal_from_end'), ordinal: MatchOrdinalSchema }),
  z.object({ type: z.literal('filtered'), filters: z.record(z.string(), z.unknown()).default({}) }),
  z.object({
    type: z.literal('ranked'),
    metric: MatchRankMetricSchema,
    direction: z.enum(['asc', 'desc']),
  }),
  z.object({ type: z.literal('active_match') }),
  z.object({ type: z.literal('previous') }),
  z.object({ type: z.literal('next') }),
]);

export type MatchSelector = z.infer<typeof MatchSelectorSchema>;

export const SelectorSchema = z.discriminatedUnion('type', [
  TimeRangeSelectorSchema,
  RelativePeriodSelectorSchema,
  RecentDaysSelectorSchema,
  LastNMatchesSelectorSchema,
  ResultSetSelectorSchema,
]);

export type Selector = z.infer<typeof SelectorSchema>;

export const SegmentSchema = z.object({
  label: z.string().min(1),
  selector: SelectorSchema,
});

export type Segment = z.infer<typeof SegmentSchema>;

export const OperationSchema = z.enum([
  'report',
  'detail',
  'rank',
  'strongest',
  'weakest',
  'compare',
  'trend',
  'list',
  'review_match',
]);

export type Operation = z.infer<typeof OperationSchema>;

export const GroupBySchema = z.enum(['player', 'match', 'day', 'map', 'mode', 'team']);
export type GroupBy = z.infer<typeof GroupBySchema>;

export const MetricSchema = z.enum([
  'matches',
  'kills',
  'assists',
  'damage',
  'avg_damage',
  'kd',
  'deaths',
  'wins',
  'top10',
  'rank',
  'dbnos',
  'revives',
  'headshot_kills',
  'survival_time',
  'longest_kill',
  'performance_score',
  'chicken_index',
]);

export type Metric = z.infer<typeof MetricSchema>;

export const OrderBySchema = z.object({
  metric: MetricSchema,
  direction: z.enum(['asc', 'desc']),
});

export const QueryReferenceSchema = z
  .object({
    sessionId: z.string().optional(),
    selectorExplicit: z.boolean().default(false),
    subjectExplicit: z.boolean().default(false),
    useResultSet: z.boolean().default(false),
    resultSetId: z.string().optional(),
    inheritedFromContext: z.boolean().default(false),
    inheritedFromResultSet: z.string().optional(),
    unsupportedCapability: z.string().optional(),
    planner: z.enum(['openclaw', 'provided']).default('openclaw'),
  })
  .catchall(z.unknown());

export type QueryReference = z.infer<typeof QueryReferenceSchema>;

export const PresentationSchema = z
  .object({
    periodLabel: z.string().optional(),
    renderer: z.string().optional(),
    profile: z
      .enum(['default', 'combat', 'weapon', 'vehicle', 'personal', 'fun', 'detailed'])
      .optional(),
    compact: z.boolean().default(false),
  })
  .catchall(z.unknown());

export const CanonicalQuerySchema = z.object({
  version: z.literal(QUERY_SCHEMA_VERSION),
  queryId: z.string().min(1),
  domain: z.literal('pubg'),
  subject: SubjectSchema,
  operation: OperationSchema,
  selector: SelectorSchema,
  matchSelector: MatchSelectorSchema.nullable().optional(),
  segments: z.array(SegmentSchema).default([]),
  groupBy: GroupBySchema,
  metrics: z.array(MetricSchema).min(1),
  filters: z.record(z.string(), z.unknown()).default({}),
  orderBy: OrderBySchema,
  limit: z.number().int().min(1).max(1000).nullable(),
  reference: QueryReferenceSchema.default({
    selectorExplicit: false,
    subjectExplicit: false,
    useResultSet: false,
    inheritedFromContext: false,
    planner: 'openclaw',
  }),
  presentation: PresentationSchema.default({ compact: false }),
});

export type CanonicalQuery = z.infer<typeof CanonicalQuerySchema>;

export const PlannerOutputSchema = CanonicalQuerySchema;
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export const ResultSetSchema = z.object({
  id: z.string().min(1),
  queryId: z.string().min(1),
  sessionId: z.string().min(1),
  resolvedQuery: CanonicalQuerySchema,
  resolvedSelector: SelectorSchema,
  playerIds: z.array(z.string()),
  matchIds: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  aggregates: z.record(z.string(), z.unknown()).default({}),
  rankings: z.array(z.record(z.string(), z.unknown())).default([]),
  coverage: z.record(z.string(), z.unknown()),
  status: DataStatusSchema,
  source: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export type ResultSet = z.infer<typeof ResultSetSchema>;

export function parseCanonicalQuery(value: unknown): CanonicalQuery {
  return CanonicalQuerySchema.parse(value);
}
