import { z } from 'zod';

export const DataStatusSchema = z.enum([
  'OK',
  'NO_MATCHES',
  'PARTIAL',
  'COVERAGE_GAP',
  'SOURCE_UNAVAILABLE',
  'INVALID_QUERY',
  'UNKNOWN_PLAYER',
  'UNSUPPORTED_CAPABILITY',
  'STALE',
  'MATCH_NOT_FOUND',
  'MATCH_SELECTION_REQUIRED',
  'REVIEW_PARTIAL',
  'FIGHT_ANALYTICS_INVALID',
]);

export type DataStatus = z.infer<typeof DataStatusSchema>;

export const CoverageSchema = z.object({
  status: DataStatusSchema,
  complete: z.boolean(),
  coverageStart: z.string().nullable().optional(),
  coverageEnd: z.string().nullable().optional(),
  checkedAt: z.string().nullable().optional(),
  failedMatchIds: z.array(z.string()).default([]),
  sourceUnavailable: z.boolean().default(false),
  freshness: z.enum(['fresh', 'stale', 'unknown']).default('unknown'),
  localComplete: z.boolean().optional(),
  queryCovered: z.boolean().optional(),
  requiredMatchCount: z.number().int().nonnegative().optional(),
  availableMatchCount: z.number().int().nonnegative().optional(),
});

export type Coverage = z.infer<typeof CoverageSchema>;

export const SourceSchema = z
  .object({
    store: z.string().optional(),
    syncInvoked: z.boolean().default(false),
    playerApiCalls: z.number().int().nonnegative().default(0),
    matchApiCalls: z.number().int().nonnegative().default(0),
    localMatchCount: z.number().int().nonnegative().default(0),
    error: z.string().optional(),
  })
  .catchall(z.unknown());

export type SourceInfo = z.infer<typeof SourceSchema>;

export const EvidenceSchema = z
  .object({
    matchIds: z.array(z.string()).default([]),
    playerIds: z.array(z.string()).default([]),
    fields: z.array(z.string()).default([]),
    calculation: z.string().default('deterministic_query_engine'),
  })
  .catchall(z.unknown());

export type Evidence = z.infer<typeof EvidenceSchema>;
