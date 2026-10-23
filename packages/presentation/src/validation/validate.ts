import type { OwnerNotificationPresentation } from '../contracts/owner.js';
import { WORLDLINE_SIGNIFICANCES, WORLDLINE_THEMES } from '../worldline/contracts.js';
import type {
  PubgComparisonPresentation,
  PubgMatchDetailPresentation,
  PubgMatchListPresentation,
  PubgMatchReviewPresentation,
  PubgMetricRow,
  PubgPeriodReviewPresentation,
  PubgPresentation,
  PubgPresentationScalar,
  PubgPresentationStatus,
  PubgSourceRange,
  PubgStatsPresentation,
  PubgStatusPresentation,
  PubgTeamDamageLedger,
  PubgTeamDamagePresentation,
  PubgTeamDamageSlice,
  PubgPresentationCoverage,
  PresentationTextItem,
} from '../contracts/pubg.js';

export interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  errors: string[];
}

function result<T>(value: T, errors: string[]): ValidationResult<T> {
  return errors.length ? { valid: false, errors } : { valid: true, value, errors: [] };
}

function stringValue(
  value: unknown,
  path: string,
  errors: string[],
  required = true,
): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (required) errors.push(`${path} must be a non-empty string`);
  return undefined;
}

function finiteOrNull(value: unknown, path: string, errors: string[]): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  errors.push(`${path} must be a finite number or null`);
  return undefined;
}

function scalar(value: unknown, path: string, errors: string[]): PubgPresentationScalar {
  if (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value as PubgPresentationScalar;
  errors.push(`${path} must be a string, finite number, or null`);
  return null;
}

function iso(value: unknown, path: string, errors: string[], required = true): string | undefined {
  const text = stringValue(value, path, errors, required);
  if (text && !Number.isFinite(Date.parse(text))) errors.push(`${path} must be an ISO timestamp`);
  return text;
}

function refs(
  value: unknown,
  path: string,
  errors: string[],
  known?: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push(`${path} must be an array of non-empty evidence references`);
    return [];
  }
  const normalized = value.map((item) => String(item));
  if (known)
    for (const ref of normalized)
      if (!known.has(ref)) errors.push(`${path} references unknown evidence ${ref}`);
  return normalized;
}

function textItems(
  value: unknown,
  path: string,
  errors: string[],
  known?: ReadonlySet<string>,
): PresentationTextItem[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push(`${path}[${index}] must be an object`);
      return [];
    }
    const row = item as Record<string, unknown>;
    const text = stringValue(row.text, `${path}[${index}].text`, errors);
    const evidenceRefs = refs(row.evidenceRefs, `${path}[${index}].evidenceRefs`, errors, known);
    return text ? [{ text, evidenceRefs }] : [];
  });
}

function sourceRange(value: unknown, path: string, errors: string[]): PubgSourceRange | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const from = row.from === null ? null : (iso(row.from, `${path}.from`, errors, false) ?? null);
  const to = row.to === null ? null : (iso(row.to, `${path}.to`, errors, false) ?? null);
  const segments: PubgSourceRange['segments'] = [];
  if (row.segments !== undefined) {
    if (!Array.isArray(row.segments)) errors.push(`${path}.segments must be an array`);
    else
      row.segments.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
          errors.push(`${path}.segments[${index}] must be an object`);
          return;
        }
        const segment = item as Record<string, unknown>;
        const label = stringValue(segment.label, `${path}.segments[${index}].label`, errors);
        const segmentFrom =
          segment.from === null
            ? null
            : (iso(segment.from, `${path}.segments[${index}].from`, errors, false) ?? null);
        const segmentTo =
          segment.to === null
            ? null
            : (iso(segment.to, `${path}.segments[${index}].to`, errors, false) ?? null);
        if (label) segments.push({ label, from: segmentFrom, to: segmentTo });
      });
  }
  return { from, to, ...(segments.length ? { segments } : {}) };
}

function presentationCoverage(
  value: unknown,
  path: string,
  errors: string[],
): PubgPresentationCoverage | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const status = stringValue(row.status, `${path}.status`, errors);
  const complete =
    typeof row.complete === 'boolean'
      ? row.complete
      : (errors.push(`${path}.complete must be boolean`), false);
  const freshness = ['fresh', 'stale', 'unknown'].includes(String(row.freshness))
    ? (row.freshness as PubgPresentationCoverage['freshness'])
    : (errors.push(`${path}.freshness is invalid`), 'unknown' as const);
  const checkedAt =
    row.checkedAt === null
      ? null
      : (iso(row.checkedAt, `${path}.checkedAt`, errors, false) ?? null);
  const coverageStart =
    row.coverageStart === null
      ? null
      : (iso(row.coverageStart, `${path}.coverageStart`, errors, false) ?? null);
  const coverageEnd =
    row.coverageEnd === null
      ? null
      : (iso(row.coverageEnd, `${path}.coverageEnd`, errors, false) ?? null);
  const sourceUnavailable =
    typeof row.sourceUnavailable === 'boolean'
      ? row.sourceUnavailable
      : (errors.push(`${path}.sourceUnavailable must be boolean`), false);
  return status
    ? { status, complete, freshness, checkedAt, coverageStart, coverageEnd, sourceUnavailable }
    : undefined;
}

function base(
  value: Record<string, unknown>,
  expectedType: string,
  errors: string[],
  path = 'presentation',
): {
  status: PubgPresentationStatus;
  dataUpdatedAt: string;
  sourceRange?: PubgSourceRange;
  coverage?: PubgPresentationCoverage;
} {
  if (value.type !== expectedType) errors.push(`${path}.type must be ${expectedType}`);
  const statusValue = value.status;
  if (!['ok', 'partial', 'no_matches', 'error'].includes(String(statusValue)))
    errors.push(`${path}.status is invalid`);
  const dataUpdatedAt = iso(value.dataUpdatedAt, `${path}.dataUpdatedAt`, errors) ?? '';
  const range = sourceRange(value.sourceRange, `${path}.sourceRange`, errors);
  const coverage = presentationCoverage(value.coverage, `${path}.coverage`, errors);
  return {
    status: statusValue as PubgPresentationStatus,
    dataUpdatedAt,
    ...(range ? { sourceRange: range } : {}),
    ...(coverage ? { coverage } : {}),
  };
}

function scalarRecord(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, PubgPresentationScalar> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scalar(item, `${path}.${key}`, errors)]),
  );
}

function metricRows(
  value: unknown,
  path: string,
  errors: string[],
  known?: ReadonlySet<string>,
): PubgMetricRow[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push(`${path}[${index}] must be an object`);
      return [];
    }
    const row = item as Record<string, unknown>;
    const label = stringValue(row.label, `${path}[${index}].label`, errors);
    const values = scalarRecord(row.values, `${path}[${index}].values`, errors);
    const position =
      row.position === undefined
        ? undefined
        : row.position === null
          ? null
          : finiteOrNull(row.position, `${path}[${index}].position`, errors);
    const evidenceRefs = refs(row.evidenceRefs, `${path}[${index}].evidenceRefs`, errors, known);
    if (!label) return [];
    return [
      {
        label,
        values,
        ...(position === undefined ? {} : { position: position ?? null }),
        evidenceRefs,
      },
    ];
  });
}

export function validatePubgStatusPresentation(
  value: unknown,
  knownEvidence?: ReadonlySet<string>,
): ValidationResult<PubgStatusPresentation> {
  const errors: string[] = [];
  if (!value || typeof value !== 'object')
    return result(value as PubgStatusPresentation, ['presentation must be an object']);
  const row = value as Record<string, unknown>;
  const common = base(row, 'pubg_status', errors);
  const headline = stringValue(row.headline, 'headline', errors);
  const message = stringValue(row.message, 'message', errors);
  const errorCode = stringValue(row.errorCode, 'errorCode', errors, false);
  const evidenceRefs = refs(row.evidenceRefs, 'evidenceRefs', errors, knownEvidence);
  if (!headline || !message) return result(value as PubgStatusPresentation, errors);
  return result(
    {
      ...common,
      type: 'pubg_status',
      headline,
      message,
      ...(errorCode ? { errorCode } : {}),
      evidenceRefs,
    },
    errors,
  );
}

export function validatePubgStatsPresentation(
  value: unknown,
  knownEvidence?: ReadonlySet<string>,
): ValidationResult<PubgStatsPresentation> {
  const errors: string[] = [];
  if (!value || typeof value !== 'object')
    return result(value as PubgStatsPresentation, ['presentation must be an object']);
  const row = value as Record<string, unknown>;
  const common = base(row, 'pubg_stats', errors);
  const headline = stringValue(row.headline, 'headline', errors);
  const operation = stringValue(row.operation, 'operation', errors);
  const groupBy = stringValue(row.groupBy, 'groupBy', errors);
  const summary = stringValue(row.summary, 'summary', errors);
  const rows = metricRows(row.rows, 'rows', errors, knownEvidence);
  const evidenceRefs = refs(row.evidenceRefs, 'evidenceRefs', errors, knownEvidence);
  if (!headline || !operation || !groupBy || !summary)
    return result(value as PubgStatsPresentation, errors);
  return result(
    { ...common, type: 'pubg_stats', headline, operation, groupBy, summary, rows, evidenceRefs },
    errors,
  );
}

export function validatePubgMatchListPresentation(
  value: unknown,
  knownEvidence?: ReadonlySet<string>,
): ValidationResult<PubgMatchListPresentation> {
  const errors: string[] = [];
  if (!value || typeof value !== 'object')
    return result(value as PubgMatchListPresentation, ['presentation must be an object']);
  const row = value as Record<string, unknown>;
  const common = base(row, 'pubg_match_list', errors);
  const headline = stringValue(row.headline, 'headline', errors);
  const summary = stringValue(row.summary, 'summary', errors);
  const evidenceRefs = refs(row.evidenceRefs, 'evidenceRefs', errors, knownEvidence);
  const matches: PubgMatchListPresentation['matches'] = [];
  if (!Array.isArray(row.matches)) errors.push('matches must be an array');
  else
    row.matches.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        errors.push(`matches[${index}] must be an object`);
        return;
      }
      const match = item as Record<string, unknown>;
      const matchId = stringValue(match.matchId, `matches[${index}].matchId`, errors);
      const startedAt =
        match.startedAt === null
          ? null
          : (iso(match.startedAt, `matches[${index}].startedAt`, errors, false) ?? null);
      const mapName = stringValue(match.mapName, `matches[${index}].mapName`, errors);
      const gameMode = stringValue(match.gameMode, `matches[${index}].gameMode`, errors);
      const placement = finiteOrNull(match.placement, `matches[${index}].placement`, errors);
      const matchSummary = stringValue(match.summary, `matches[${index}].summary`, errors);
      const matchRefs = refs(
        match.evidenceRefs,
        `matches[${index}].evidenceRefs`,
        errors,
        knownEvidence,
      );
      if (matchId && mapName && gameMode && matchSummary)
        matches.push({
          matchId,
          startedAt,
          mapName,
          gameMode,
          placement: placement ?? null,
          summary: matchSummary,
          evidenceRefs: matchRefs,
        });
    });
  if (!headline || !summary) return result(value as PubgMatchListPresentation, errors);
  return result(
    { ...common, type: 'pubg_match_list', headline, summary, matches, evidenceRefs },
    errors,
  );
}

export function validatePubgComparisonPresentation(
  value: unknown,
  knownEvidence?: ReadonlySet<string>,
): ValidationResult<PubgComparisonPresentation> {
  const errors: string[] = [];
  if (!value || typeof value !== 'object')
    return result(value as PubgComparisonPresentation, ['presentation must be an object']);
  const row = value as Record<string, unknown>;
  const common = base(row, 'pubg_comparison', errors);
  const headline = stringValue(row.headline, 'headline', errors);
  const summary = stringValue(row.summary, 'summary', errors);
  const rows = metricRows(row.rows, 'rows', errors, knownEvidence);
  const evidenceRefs = refs(row.evidenceRefs, 'evidenceRefs', errors, knownEvidence);
  const segments: PubgComparisonPresentation['segments'] = [];
  if (!Array.isArray(row.segments)) errors.push('segments must be an array');
  else
    row.segments.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        errors.push(`segments[${index}] must be an object`);
        return;
      }
      const segment = item as Record<string, unknown>;
      const label = stringValue(segment.label, `segments[${index}].label`, errors);
      const range = sourceRange(segment.sourceRange, `segments[${index}].sourceRange`, errors);
      const segmentRows = metricRows(
        segment.rows,
        `segments[${index}].rows`,
        errors,
        knownEvidence,
      );
      if (label)
        segments.push({ label, ...(range ? { sourceRange: range } : {}), rows: segmentRows });
    });
  if (!headline || !summary) return result(value as PubgComparisonPresentation, errors);
  return result(
    { ...common, type: 'pubg_comparison', headline, summary, rows, segments, evidenceRefs },
    errors,
  );
}

export function validatePubgMatchDetailPresentation(
  value: unknown,
  knownEvidence?: ReadonlySet<string>,
): ValidationResult<PubgMatchDetailPresentation> {
  const errors: string[] = [];
  if (!value || typeof value !== 'object')
    return result(value as PubgMatchDetailPresentation, ['presentation must be an object']);
  const row = value as Record<string, unknown>;
  const common = base(row, 'pubg_match_detail', errors);
  const headline = stringValue(row.headline, 'headline', errors);
  const matchId = stringValue(row.matchId, 'matchId', errors);
  const startedAt =
    row.startedAt === null ? null : (iso(row.startedAt, 'startedAt', errors, false) ?? null);
  const mapName = stringValue(row.mapName, 'mapName', errors);
  const gameMode = stringValue(row.gameMode, 'gameMode', errors);
  const duration =
    row.duration === null ? null : (finiteOrNull(row.duration, 'duration', errors) ?? null);
  const evidenceRefs = refs(row.evidenceRefs, 'evidenceRefs', errors, knownEvidence);
  const players: PubgMatchDetailPresentation['players'] = [];
  if (!Array.isArray(row.players)) errors.push('players must be an array');
  else
    row.players.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        errors.push(`players[${index}] must be an object`);
        return;
      }
      const player = item as Record<string, unknown>;
      const label = stringValue(player.label, `players[${index}].label`, errors);
      const playerValues = scalarRecord(player.values, `players[${index}].values`, errors);
      const playerRefs = refs(
        player.evidenceRefs,
        `players[${index}].evidenceRefs`,
        errors,
        knownEvidence,
      );
      if (label) players.push({ label, values: playerValues, evidenceRefs: playerRefs });
    });
  if (!headline || !matchId || !mapName || !gameMode)
    return result(value as PubgMatchDetailPresentation, errors);
  return result(
    {
      ...common,
      type: 'pubg_match_detail',
      headline,
      matchId,
      startedAt,
      mapName,
      gameMode,
      duration,
      players,
      evidenceRefs,
    },
    errors,
  );
}

export function validatePubgMatchReviewPresentation(
  value: unknown,
  knownEvidence?: ReadonlySet<string>,
): ValidationResult<PubgMatchReviewPresentation> {
  const errors: string[] = [];
  if (!value || typeof value !== 'object')
    return result(value as PubgMatchReviewPresentation, ['presentation must be an object']);
  const row = value as Record<string, unknown>;
  const common = base(row, 'pubg_match_review', errors);
  const headline = stringValue(row.headline, 'headline', errors);
  const overviewValue = row.overview;
  const overview: Record<string, number | null | undefined> = {};
  if (!overviewValue || typeof overviewValue !== 'object')
    errors.push('overview must be an object');
  else {
    const source = overviewValue as Record<string, unknown>;
    for (const key of ['placement', 'kills', 'assists', 'damage', 'dbnos', 'revives'])
      overview[key] = finiteOrNull(source[key], `overview.${key}`, errors);
  }
  const keyMoments = textItems(row.keyMoments, 'keyMoments', errors, knownEvidence);
  const highlights = textItems(row.highlights, 'highlights', errors, knownEvidence);
  const improvements = textItems(row.improvements, 'improvements', errors, knownEvidence);
  const analysis = stringValue(row.analysis, 'analysis', errors);
  const evidenceRefs = refs(row.evidenceRefs, 'evidenceRefs', errors, knownEvidence);
  if (!headline || !analysis) return result(value as PubgMatchReviewPresentation, errors);
  return result(
    {
      ...common,
      type: 'pubg_match_review',
      headline,
      overview: {
        placement: overview.placement ?? null,
        kills: overview.kills ?? null,
        assists: overview.assists ?? null,
        damage: overview.damage ?? null,
        dbnos: overview.dbnos ?? null,
        revives: overview.revives ?? null,
      },
      keyMoments,
      highlights,
      improvements,
      analysis,
      evidenceRefs,
    },
    errors,
  );
}

export function validatePubgPeriodReviewPresentation(
  value: unknown,
  knownEvidence?: ReadonlySet<string>,
): ValidationResult<PubgPeriodReviewPresentation> {
  const errors: string[] = [];
  if (!value || typeof value !== 'object')
    return result(value as PubgPeriodReviewPresentation, ['presentation must be an object']);
  const row = value as Record<string, unknown>;
  const common = base(row, 'pubg_period_review', errors);
  const periodValue = row.period;
  let label: string | undefined;
  let displayDate: string | undefined;
  if (!periodValue || typeof periodValue !== 'object') errors.push('period must be an object');
  else {
    const period = periodValue as Record<string, unknown>;
    label = stringValue(period.label, 'period.label', errors);
    displayDate = stringValue(period.displayDate, 'period.displayDate', errors, false);
  }
  const summary = stringValue(row.summary, 'summary', errors);
  const analysis = stringValue(row.analysis, 'analysis', errors);
  const highlights = textItems(row.highlights, 'highlights', errors, knownEvidence);
  const patterns = textItems(row.patterns, 'patterns', errors, knownEvidence);
  const evidenceRefs = refs(row.evidenceRefs, 'evidenceRefs', errors, knownEvidence);
  const orderedMatches: PubgPeriodReviewPresentation['orderedMatches'] = [];
  if (!Array.isArray(row.orderedMatches)) errors.push('orderedMatches must be an array');
  else
    row.orderedMatches.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        errors.push(`orderedMatches[${index}] must be an object`);
        return;
      }
      const match = item as Record<string, unknown>;
      const matchId = stringValue(match.matchId, `orderedMatches[${index}].matchId`, errors);
      const matchLabel = stringValue(match.label, `orderedMatches[${index}].label`, errors);
      const startedAt =
        match.startedAt === null
          ? null
          : (iso(match.startedAt, `orderedMatches[${index}].startedAt`, errors, false) ?? null);
      const placement = finiteOrNull(match.placement, `orderedMatches[${index}].placement`, errors);
      if (matchId && matchLabel)
        orderedMatches.push({
          matchId,
          label: matchLabel,
          startedAt,
          placement: placement ?? null,
        });
    });
  if (!label || !summary || !analysis) return result(value as PubgPeriodReviewPresentation, errors);
  return result(
    {
      ...common,
      type: 'pubg_period_review',
      period: { label, ...(displayDate ? { displayDate } : {}) },
      summary,
      orderedMatches,
      highlights,
      patterns,
      analysis,
      evidenceRefs,
    },
    errors,
  );
}

function teamDamageSlices(value: unknown, path: string, errors: string[]): PubgTeamDamageSlice[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  return value.flatMap((item, index) => {
    const slice = (item ?? {}) as Record<string, unknown>;
    const label = stringValue(slice.label, `${path}[${index}].label`, errors);
    const hitCount = finiteOrNull(slice.hitCount, `${path}[${index}].hitCount`, errors);
    const damage = finiteOrNull(slice.damage, `${path}[${index}].damage`, errors);
    return label && typeof hitCount === 'number' && typeof damage === 'number'
      ? [{ label, hitCount, damage }]
      : [];
  });
}

function teamDamageLedger(
  value: unknown,
  directionCount: number,
  errors: string[],
): PubgTeamDamageLedger | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    errors.push('ledger must be an object');
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const directionSources = Array.isArray(row.directionSources)
    ? row.directionSources.map((item, index) =>
        teamDamageSlices(item, `ledger.directionSources[${index}]`, errors),
      )
    : (errors.push('ledger.directionSources must be an array'), []);
  if (directionSources.length !== directionCount)
    errors.push('ledger.directionSources must align with directions');
  const highlights = Array.isArray(row.highlights)
    ? row.highlights.flatMap((item, index) => {
        const highlight = (item ?? {}) as Record<string, unknown>;
        const label = stringValue(highlight.label, `ledger.highlights[${index}].label`, errors);
        const hitCount = finiteOrNull(
          highlight.hitCount,
          `ledger.highlights[${index}].hitCount`,
          errors,
        );
        const damage = finiteOrNull(highlight.damage, `ledger.highlights[${index}].damage`, errors);
        const pairs = Array.isArray(highlight.pairs)
          ? highlight.pairs.flatMap((raw, pairIndex) => {
              const pair = (raw ?? {}) as Record<string, unknown>;
              const actor = stringValue(
                pair.actor,
                `ledger.highlights[${index}].pairs[${pairIndex}].actor`,
                errors,
              );
              const victim = stringValue(
                pair.victim,
                `ledger.highlights[${index}].pairs[${pairIndex}].victim`,
                errors,
              );
              const pairHits = finiteOrNull(
                pair.hitCount,
                `ledger.highlights[${index}].pairs[${pairIndex}].hitCount`,
                errors,
              );
              const pairDamage = finiteOrNull(
                pair.damage,
                `ledger.highlights[${index}].pairs[${pairIndex}].damage`,
                errors,
              );
              return actor &&
                victim &&
                typeof pairHits === 'number' &&
                typeof pairDamage === 'number'
                ? [{ actor, victim, hitCount: pairHits, damage: pairDamage }]
                : [];
            })
          : (errors.push(`ledger.highlights[${index}].pairs must be an array`), []);
        return label && typeof hitCount === 'number' && typeof damage === 'number'
          ? [{ label, hitCount, damage, pairs }]
          : [];
      })
    : (errors.push('ledger.highlights must be an array'), []);
  const quiet =
    Array.isArray(row.quiet) && row.quiet.every((item) => typeof item === 'string')
      ? (row.quiet as string[])
      : (errors.push('ledger.quiet must be a string array'), []);
  return {
    sources: teamDamageSlices(row.sources, 'ledger.sources', errors),
    directionSources,
    highlights,
    quiet,
  };
}

export function validatePubgTeamDamagePresentation(
  value: unknown,
  knownEvidence?: ReadonlySet<string>,
): ValidationResult<PubgTeamDamagePresentation> {
  const errors: string[] = [];
  if (!value || typeof value !== 'object')
    return result(value as PubgTeamDamagePresentation, ['presentation must be an object']);
  const row = value as Record<string, unknown>;
  const common = base(row, 'pubg_team_damage', errors);
  const headline = stringValue(row.headline, 'headline', errors);
  const direction = stringValue(row.direction, 'direction', errors);
  const source =
    row.source === null ? null : (stringValue(row.source, 'source', errors, false) ?? null);
  const meleeKind =
    row.meleeKind === null
      ? null
      : (stringValue(row.meleeKind, 'meleeKind', errors, false) ?? null);
  const totalHitCount = finiteOrNull(row.totalHitCount, 'totalHitCount', errors);
  const totalDamage = finiteOrNull(row.totalDamage, 'totalDamage', errors);
  const summary = stringValue(row.summary, 'summary', errors);
  const evidenceRefs = refs(row.evidenceRefs, 'evidenceRefs', errors, knownEvidence);
  const directions: PubgTeamDamagePresentation['directions'] = [];
  if (!Array.isArray(row.directions)) errors.push('directions must be an array');
  else
    row.directions.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        errors.push(`directions[${index}] must be an object`);
        return;
      }
      const value = item as Record<string, unknown>;
      const actor = stringValue(value.actor, `directions[${index}].actor`, errors);
      const victim = stringValue(value.victim, `directions[${index}].victim`, errors);
      const hitCount = finiteOrNull(value.hitCount, `directions[${index}].hitCount`, errors);
      const damage = finiteOrNull(value.damage, `directions[${index}].damage`, errors);
      const knownHitCount =
        value.knownHitCount === undefined
          ? undefined
          : finiteOrNull(value.knownHitCount, `directions[${index}].knownHitCount`, errors);
      const knownDamage =
        value.knownDamage === undefined
          ? undefined
          : finiteOrNull(value.knownDamage, `directions[${index}].knownDamage`, errors);
      const complete =
        value.complete === true || value.complete === false
          ? value.complete
          : (errors.push(`directions[${index}].complete must be boolean`), false);
      const refsValue = refs(
        value.evidenceRefs,
        `directions[${index}].evidenceRefs`,
        errors,
        knownEvidence,
      );
      if (actor && victim)
        directions.push({
          actor,
          victim,
          hitCount: hitCount ?? null,
          damage: damage ?? null,
          ...(knownHitCount === undefined ? {} : { knownHitCount: knownHitCount ?? 0 }),
          ...(knownDamage === undefined ? {} : { knownDamage: knownDamage ?? 0 }),
          complete,
          evidenceRefs: refsValue,
        });
    });
  let actorTotals: PubgTeamDamagePresentation['actorTotals'];
  if (row.actorTotals !== undefined) {
    if (!Array.isArray(row.actorTotals)) errors.push('actorTotals must be an array');
    else {
      const parsedActorTotals: NonNullable<PubgTeamDamagePresentation['actorTotals']> = [];
      row.actorTotals.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
          errors.push(`actorTotals[${index}] must be an object`);
          return;
        }
        const total = item as Record<string, unknown>;
        const actor = stringValue(total.actor, `actorTotals[${index}].actor`, errors);
        const damage = finiteOrNull(total.damage, `actorTotals[${index}].damage`, errors);
        const hitCount = finiteOrNull(total.hitCount, `actorTotals[${index}].hitCount`, errors);
        const knownDamage = finiteOrNull(
          total.knownDamage,
          `actorTotals[${index}].knownDamage`,
          errors,
        );
        const knownHitCount = finiteOrNull(
          total.knownHitCount,
          `actorTotals[${index}].knownHitCount`,
          errors,
        );
        const complete =
          typeof total.complete === 'boolean'
            ? total.complete
            : (errors.push(`actorTotals[${index}].complete must be boolean`), false);
        const position = finiteOrNull(total.position, `actorTotals[${index}].position`, errors);
        const evidenceRefs = refs(
          total.evidenceRefs,
          `actorTotals[${index}].evidenceRefs`,
          errors,
          knownEvidence,
        );
        if (actor)
          parsedActorTotals.push({
            actor,
            damage: damage ?? null,
            hitCount: hitCount ?? null,
            knownDamage: knownDamage ?? 0,
            knownHitCount: knownHitCount ?? 0,
            complete,
            position: position ?? index + 1,
            evidenceRefs,
          });
      });
      actorTotals = parsedActorTotals;
    }
  }
  const rankingBasis =
    row.rankingBasis === undefined
      ? undefined
      : row.rankingBasis === 'damage' || row.rankingBasis === 'knownDamage'
        ? row.rankingBasis
        : (errors.push('rankingBasis is invalid'), undefined);
  const ledger = teamDamageLedger(row.ledger, directions.length, errors);
  if (!headline || !direction || !summary)
    return result(value as PubgTeamDamagePresentation, errors);
  return result(
    {
      ...common,
      type: 'pubg_team_damage',
      headline,
      direction,
      source,
      meleeKind,
      totalHitCount: totalHitCount ?? null,
      totalDamage: totalDamage ?? null,
      directions,
      ...(ledger ? { ledger } : {}),
      ...(actorTotals ? { actorTotals } : {}),
      ...(rankingBasis ? { rankingBasis } : {}),
      summary,
      evidenceRefs,
    },
    errors,
  );
}

export function validatePubgPresentation(
  value: unknown,
  knownEvidence?: ReadonlySet<string>,
): ValidationResult<PubgPresentation> {
  if (!value || typeof value !== 'object')
    return result(value as PubgPresentation, ['presentation must be an object']);
  const type = (value as Record<string, unknown>).type;
  switch (type) {
    case 'pubg_status':
      return validatePubgStatusPresentation(value, knownEvidence);
    case 'pubg_stats':
      return validatePubgStatsPresentation(value, knownEvidence);
    case 'pubg_match_list':
      return validatePubgMatchListPresentation(value, knownEvidence);
    case 'pubg_comparison':
      return validatePubgComparisonPresentation(value, knownEvidence);
    case 'pubg_match_detail':
      return validatePubgMatchDetailPresentation(value, knownEvidence);
    case 'pubg_match_review':
      return validatePubgMatchReviewPresentation(value, knownEvidence);
    case 'pubg_period_review':
      return validatePubgPeriodReviewPresentation(value, knownEvidence);
    case 'pubg_team_damage':
      return validatePubgTeamDamagePresentation(value, knownEvidence);
    default:
      return result(value as PubgPresentation, [
        `unsupported PUBG presentation type: ${String(type)}`,
      ]);
  }
}

export function validateOwnerNotificationPresentation(
  value: unknown,
  knownEvidence?: ReadonlySet<string>,
): ValidationResult<OwnerNotificationPresentation> {
  const errors: string[] = [];
  if (!value || typeof value !== 'object')
    return result(value as OwnerNotificationPresentation, ['presentation must be an object']);
  const row = value as Record<string, unknown>;
  if (row.type !== 'owner_notification') errors.push('type must be owner_notification');
  const eventType = stringValue(row.eventType, 'eventType', errors);
  const severity = row.severity;
  if (!['info', 'success', 'warning', 'error'].includes(String(severity)))
    errors.push('severity is invalid');
  const significance = row.significance;
  if (!WORLDLINE_SIGNIFICANCES.includes(significance as (typeof WORLDLINE_SIGNIFICANCES)[number]))
    errors.push('significance is invalid');
  const theme = row.theme;
  if (!WORLDLINE_THEMES.includes(theme as (typeof WORLDLINE_THEMES)[number]))
    errors.push('theme is invalid');
  const eventKey = stringValue(row.eventKey, 'eventKey', errors);
  const source = stringValue(row.source, 'source', errors);
  const headline = stringValue(row.headline, 'headline', errors);
  const summary = stringValue(row.summary, 'summary', errors, false);
  const dataUpdatedAt = iso(row.dataUpdatedAt, 'dataUpdatedAt', errors, false);
  const occurredAt = iso(row.occurredAt, 'occurredAt', errors);
  const facts: OwnerNotificationPresentation['facts'] = [];
  if (!Array.isArray(row.facts)) errors.push('facts must be an array');
  else
    row.facts.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        errors.push(`facts[${index}] must be an object`);
        return;
      }
      const fact = item as Record<string, unknown>;
      const label = stringValue(fact.label, `facts[${index}].label`, errors);
      const raw = fact.value;
      if (!(
        raw === null ||
        typeof raw === 'string' ||
        typeof raw === 'number' ||
        typeof raw === 'boolean'
      ))
        errors.push(`facts[${index}].value must be scalar or null`);
      const evidenceRefs = refs(
        fact.evidenceRefs,
        `facts[${index}].evidenceRefs`,
        errors,
        knownEvidence,
      );
      if (label)
        facts.push({ label, value: raw as string | number | boolean | null, evidenceRefs });
    });
  const links: OwnerNotificationPresentation['links'] = [];
  if (row.links !== undefined) {
    if (!Array.isArray(row.links)) errors.push('links must be an array');
    else
      row.links.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
          errors.push(`links[${index}] must be an object`);
          return;
        }
        const link = item as Record<string, unknown>;
        const label = stringValue(link.label, `links[${index}].label`, errors);
        const url = stringValue(link.url, `links[${index}].url`, errors);
        const evidenceRefs =
          link.evidenceRefs === undefined
            ? undefined
            : refs(link.evidenceRefs, `links[${index}].evidenceRefs`, errors, knownEvidence);
        if (label && url)
          links.push({ label, url, ...(evidenceRefs === undefined ? {} : { evidenceRefs }) });
      });
  }
  if (
    !eventType ||
    !eventKey ||
    !source ||
    !headline ||
    !occurredAt ||
    !severity ||
    typeof severity !== 'string' ||
    !significance ||
    !theme
  )
    return result(value as OwnerNotificationPresentation, errors);
  return result(
    {
      type: 'owner_notification',
      eventType,
      severity: severity as OwnerNotificationPresentation['severity'],
      significance: significance as OwnerNotificationPresentation['significance'],
      theme: theme as OwnerNotificationPresentation['theme'],
      eventKey,
      source,
      headline,
      facts,
      ...(links.length ? { links } : {}),
      ...(summary ? { summary } : {}),
      ...(dataUpdatedAt ? { dataUpdatedAt } : {}),
      occurredAt,
      ...(row.worldLineClosing === true ? { worldLineClosing: true } : {}),
    },
    errors,
  );
}

export function assertValid<T>(validation: ValidationResult<T>): T {
  if (!validation.valid || !validation.value)
    throw new Error(`invalid presentation: ${validation.errors.join('; ')}`);
  return validation.value;
}
