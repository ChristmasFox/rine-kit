import type {
  SessionReviewFinding,
  SessionReviewMatchNote,
  SessionReviewMember,
  SessionReviewPresentation,
  SessionReviewTimelineItem,
} from '../contracts/session-review.js';
import type { ValidationResult } from './validate.js';

const TONES = ['good', 'bad', 'neutral'] as const;
const CONFIDENCES = ['clear', 'observation'] as const;
const TAGS = ['top_damage', 'early_outs', 'medic'] as const;

function text(value: unknown, path: string, errors: string[], required = true): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (required || value !== undefined) errors.push(`${path} must be a non-empty string`);
  return undefined;
}

function finite(
  value: unknown,
  path: string,
  errors: string[],
  nullable = false,
): number | null | undefined {
  if (nullable && value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  errors.push(`${path} must be a finite number${nullable ? ' or null' : ''}`);
  return undefined;
}

function count(value: unknown, path: string, errors: string[]): number | undefined {
  const parsed = finite(value, path, errors);
  if (typeof parsed === 'number' && (parsed < 0 || !Number.isInteger(parsed)))
    errors.push(`${path} must be a non-negative integer`);
  return parsed ?? undefined;
}

function instant(value: unknown, path: string, errors: string[]): string | undefined {
  const parsed = text(value, path, errors);
  if (parsed && !Number.isFinite(Date.parse(parsed)))
    errors.push(`${path} must be an ISO timestamp`);
  return parsed;
}

function record(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  errors.push(`${path} must be an object`);
  return undefined;
}

function list(value: unknown, path: string, errors: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  errors.push(`${path} must be an array`);
  return [];
}

function matchNote(
  value: unknown,
  path: string,
  errors: string[],
): SessionReviewMatchNote | undefined {
  if (value === undefined) return undefined;
  const row = record(value, path, errors);
  if (!row) return undefined;
  text(row.matchId, `${path}.matchId`, errors);
  finite(row.rank, `${path}.rank`, errors, true);
  text(row.mapName, `${path}.mapName`, errors);
  text(row.text, `${path}.text`, errors);
  return row as unknown as SessionReviewMatchNote;
}

export function validateSessionReviewPresentation(
  value: unknown,
): ValidationResult<SessionReviewPresentation> {
  const errors: string[] = [];
  const row = record(value, 'presentation', errors);
  if (!row) return { valid: false, errors };
  if (row.type !== 'pubg_session_review') errors.push('type must be pubg_session_review');
  if (row.version !== 1) errors.push('version must be 1');
  for (const key of ['sessionKey', 'squadLabel', 'timezone', 'headline'] as const)
    text(row[key], key, errors);
  for (const key of ['startAt', 'endAt', 'generatedAt'] as const) instant(row[key], key, errors);
  const matchCount = count(row.matchCount, 'matchCount', errors);
  if (matchCount === 0) errors.push('matchCount must be at least 1');
  list(row.maps, 'maps', errors).forEach((item, index) => {
    const map = record(item, `maps[${index}]`, errors);
    if (!map) return;
    text(map.mapName, `maps[${index}].mapName`, errors);
    count(map.count, `maps[${index}].count`, errors);
  });
  const placements = list(row.placements, 'placements', errors);
  placements.forEach((item, index) => finite(item, `placements[${index}]`, errors, true));
  if (matchCount !== undefined && placements.length !== matchCount)
    errors.push('placements must have one entry per match');
  const summary = record(row.summary, 'summary', errors);
  if (summary) {
    finite(summary.avgPlacement, 'summary.avgPlacement', errors, true);
    finite(summary.baselineAvgPlacement, 'summary.baselineAvgPlacement', errors, true);
    for (const key of ['wins', 'top10', 'teamKnocks'] as const)
      count(summary[key], `summary.${key}`, errors);
    finite(summary.avgTeamDamage, 'summary.avgTeamDamage', errors);
  }
  list(row.findings, 'findings', errors).forEach((item, index) => {
    const finding = record(item, `findings[${index}]`, errors) as
      Partial<Record<keyof SessionReviewFinding, unknown>> | undefined;
    if (!finding) return;
    text(finding.metric, `findings[${index}].metric`, errors);
    text(finding.text, `findings[${index}].text`, errors);
    if (!TONES.includes(finding.tone as (typeof TONES)[number]))
      errors.push(`findings[${index}].tone is invalid`);
    if (!CONFIDENCES.includes(finding.confidence as (typeof CONFIDENCES)[number]))
      errors.push(`findings[${index}].confidence is invalid`);
  });
  list(row.members, 'members', errors).forEach((item, index) => {
    const member = record(item, `members[${index}]`, errors) as
      Partial<Record<keyof SessionReviewMember, unknown>> | undefined;
    if (!member) return;
    text(member.name, `members[${index}].name`, errors);
    for (const key of ['matches', 'kills', 'knocks', 'earlyOuts', 'revives'] as const)
      count(member[key], `members[${index}].${key}`, errors);
    finite(member.damagePerMatch, `members[${index}].damagePerMatch`, errors);
    const tags = list(member.tags, `members[${index}].tags`, errors);
    if (tags.some((tag) => !TAGS.includes(tag as (typeof TAGS)[number])))
      errors.push(`members[${index}].tags has an unknown tag`);
  });
  matchNote(row.bestMatch, 'bestMatch', errors);
  matchNote(row.worstMatch, 'worstMatch', errors);
  if (row.timeline !== undefined) {
    list(row.timeline, 'timeline', errors).forEach((item, index) => {
      const moment = record(item, `timeline[${index}]`, errors) as
        Partial<Record<keyof SessionReviewTimelineItem, unknown>> | undefined;
      if (!moment) return;
      finite(moment.atSeconds, `timeline[${index}].atSeconds`, errors);
      text(moment.text, `timeline[${index}].text`, errors);
    });
  }
  text(row.suggestion, 'suggestion', errors, false);
  text(row.link, 'link', errors, false);
  const coverage = record(row.coverage, 'coverage', errors);
  if (coverage) {
    const telemetry = count(coverage.telemetry, 'coverage.telemetry', errors);
    const total = count(coverage.total, 'coverage.total', errors);
    if (telemetry !== undefined && total !== undefined && telemetry > total)
      errors.push('coverage.telemetry must not exceed coverage.total');
  }
  return errors.length
    ? { valid: false, errors }
    : { valid: true, value: value as SessionReviewPresentation, errors: [] };
}
