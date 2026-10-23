import { z } from 'zod';

// The input schemas of the PUBG tools, translated one to one from the TypeBox schemas of Lab's
// plugins/pubg (same fields, bounds and descriptions) so the model sees the same contract on every host.

export const MAX_SUBJECT_ITEMS = 12;
export const MAX_CATEGORIES = 16;
const HHMM = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;

const sessionId = z.string().max(256).optional();
const playerIds = z.array(z.string().min(1).max(128)).max(MAX_SUBJECT_ITEMS).optional();
const playerNames = z
  .array(
    z
      .string()
      .min(1)
      .max(128)
      .describe(
        'An explicit PUBG in-game name or configured alias only; never a channel sender/profile name, phone number, or JID.',
      ),
  )
  .max(MAX_SUBJECT_ITEMS)
  .optional();
const personIds = z
  .array(
    z
      .string()
      .min(1)
      .max(128)
      .describe(
        'Canonical Person IDs resolved by the host. For a human nickname in a PUBG request, resolve the person first and pass the resolved personId here; never use a channel display name, phone number, or JID.',
      ),
  )
  .max(MAX_SUBJECT_ITEMS)
  .optional();
const team = z
  .boolean()
  .describe(
    'Explicitly request the configured PUBG team. This is never an implicit fallback for an unbound sender.',
  )
  .optional();

/** Who the question is about; the host turns it into concrete player ids (see `PubgSubjectResolver`). */
export const subjectShape = { sessionId, playerIds, playerNames, personIds, team };

const timeRange = z
  .object({
    type: z.literal('time_range'),
    from: z.string().min(1).max(128),
    to: z.string().min(1).max(128),
    timezone: z.string().max(128).optional(),
    businessDayStart: z.string().regex(HHMM).optional(),
  })
  .strict();
const relativePeriod = z
  .object({
    type: z.literal('relative_period'),
    value: z
      .string()
      .min(1)
      .max(128)
      .describe(
        'Semantic period such as today, yesterday, day_before_yesterday, or a user-specified relative period; do not calculate timestamps here.',
      ),
    label: z.string().max(128).optional(),
  })
  .strict();
const lastMatches = z
  .object({
    type: z.literal('last_n_matches'),
    count: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
const resultSet = z
  .object({ type: z.literal('result_set'), resultSetId: z.string().min(1).max(256) })
  .strict();

export const selector = z.union([timeRange, relativePeriod, lastMatches, resultSet]);
export const searchSelector = z.union([timeRange, relativePeriod]);
export const teamDamageSource = z.enum(['MELEE', 'GUN', 'EXPLOSIVE', 'VEHICLE']);
export const teamDamageMeleeKind = z.enum(['KICK', 'PUNCH', 'OTHER']);

export const metrics = z.enum([
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
const groupBy = z.enum(['player', 'match', 'day', 'map', 'mode', 'team']);
const orderBy = z.object({ metric: metrics, direction: z.enum(['asc', 'desc']) }).strict();
const limit = z.number().int().min(1).max(100).optional();

export const queryStatsInput = z
  .object({
    ...subjectShape,
    selector,
    metrics: z.array(metrics).min(1).max(16),
    operation: z
      .enum(['report', 'detail', 'rank', 'strongest', 'weakest', 'trend', 'list'])
      .optional(),
    groupBy: groupBy.optional(),
    orderBy: orderBy.optional(),
    limit,
    refresh: z
      .boolean()
      .describe(
        'Default is true: refresh the upstream match list, then read cached Match/Telemetry facts. Set false only for an explicit cache-only request; never answer from conversation context.',
      )
      .optional(),
  })
  .strict();

export const compareInput = z
  .object({
    ...subjectShape,
    segments: z
      .array(z.object({ label: z.string().min(1).max(128), selector }).strict())
      .min(2)
      .max(2),
    metrics: z.array(metrics).min(1).max(16),
    groupBy: z.enum(['player', 'day', 'map', 'mode', 'team']).optional(),
    orderBy: orderBy.optional(),
    limit,
    refresh: z
      .boolean()
      .describe(
        'Default is true: refresh both compared segments before reading persistent cached facts; never use prior conversation text as data.',
      )
      .optional(),
  })
  .strict();

export const resolvePlayersInput = z
  .object({ ...subjectShape, refresh: z.boolean().optional() })
  .strict();

export const searchMatchesInput = z
  .object({
    ...subjectShape,
    selector: searchSelector.optional(),
    from: z.string().max(128).optional(),
    to: z.string().max(128).optional(),
    timezone: z.string().max(128).optional(),
    gameMode: z.string().max(64).optional(),
    mapName: z.string().max(128).optional(),
    sort: z
      .enum(['asc', 'desc'])
      .describe(
        'Period reviews should use asc for chronological play order; recentN/latest-match lookups use desc.',
      )
      .optional(),
    page: z.number().int().min(0).max(100).optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
    recentN: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe(
        'Use only for latest/recent-match lookups; omit for a full period review so the Domain defaults to chronological order.',
      )
      .optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

export const matchInput = z
  .object({ ...subjectShape, matchId: z.string().min(1).max(256), refresh: z.boolean().optional() })
  .strict();

const categories = z.array(z.string().min(1).max(64)).max(MAX_CATEGORIES).optional();

export const reviewFactsInput = z
  .object({
    ...subjectShape,
    matchId: z.string().min(1).max(256),
    searchResultSetId: z
      .string()
      .min(1)
      .max(256)
      .describe(
        'resultSetId returned by a fresh pubg_search_matches call in the current turn; stale or omitted search context is rejected.',
      ),
    categories,
    refresh: z.boolean().optional(),
  })
  .strict();

export const periodReviewInput = z
  .object({
    ...subjectShape,
    searchResultSetId: z
      .string()
      .min(1)
      .max(256)
      .describe(
        'resultSetId returned by a fresh pubg_search_matches call in the current turn; stale or unrelated search context is rejected.',
      ),
    categories,
  })
  .strict();

export const teamDamageInput = z
  .object({
    sessionId,
    selector: searchSelector,
    actorPlayer: z
      .string()
      .min(1)
      .max(128)
      .describe(
        'Configured PUBG player name, alias, or account ID. Provide together with victimPlayer for one direction; omit both for all directions.',
      )
      .optional(),
    victimPlayer: z
      .string()
      .min(1)
      .max(128)
      .describe(
        'Configured PUBG player name, alias, or account ID. Provide together with actorPlayer for one direction; omit both for all directions.',
      )
      .optional(),
    source: teamDamageSource.optional(),
    meleeKind: teamDamageMeleeKind.optional(),
    refresh: z
      .boolean()
      .describe(
        'Default is true: refresh match discovery and ensure Telemetry for every match in the resolved period.',
      )
      .optional(),
  })
  .strict();
