import {
  buildPubgStatusPresentation,
  buildPubgToolPresentation,
  formatDisplayTime,
  renderPubgMatchList,
  renderPubgStats,
  renderPubgStatus,
  renderPubgTeamDamage,
  type PubgMatchListPresentation,
  type PubgRenderOptions,
  type PubgSourceRange,
  type PubgStatsPresentation,
  type PubgTeamDamagePresentation,
  type PubgPresentation,
} from '@rine-kit/presentation';
import type { ToolEnvelope } from '@rine-kit/pubg-domain';
import { replyGuideFor } from './reply-guides.js';

/*
 * Moved unchanged from Lab's plugins/pubg/src/index.ts (jsonToolResult and the helpers it uses): the one place a PUBG
 * tool result becomes what the model retells - the validated presentation, the chat-layout displayText, the
 * replyGuide and the share link. Only the OpenClaw `jsonResult` wrapper is gone (the result is a plain object) and
 * the reply guide is injectable (a host's own worked examples).
 */

/** What a PUBG tool returns to the model. */
export type PubgToolReply = Record<string, unknown>;

/** The reply guide for a presentation; the default is the shared guide with Lab's worked examples. */
export type ReplyGuideProvider = (presentation: PubgPresentation) => string | undefined;

export type DataSourceRange = {
  from: string | null;
  to: string | null;
  fromLocal: string | null;
  toLocal: string | null;
  timezone: string | null;
  businessDayStart: string | null;
  segments: Array<{
    label: string;
    from: string | null;
    to: string | null;
    fromLocal: string | null;
    toLocal: string | null;
    timezone: string | null;
    businessDayStart: string | null;
  }>;
};

type DataSourceRangeCore = Pick<DataSourceRange, 'from' | 'to' | 'timezone' | 'businessDayStart'>;
type DataSourceRangeSegmentValue = { label: string } & DataSourceRangeCore;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function formatLocalTime(value: unknown, timezone: string, now?: string, forceDate = false): string | null {
  const instant = typeof value === 'number' ? new Date(value) : typeof value === 'string' ? value : null;
  return formatDisplayTime(instant, { timezone, ...(now ? { now } : {}), forceDate });
}

const DISPLAY_TIME_KEYS = new Set([
  'asOf', 'checkedAt', 'coverageStart', 'coverageEnd', 'createdAt', 'startedAt',
  'finishedAt', 'lastRunAt', 'occurredAt', 'updatedAt', 'expiresAt', 'from', 'to',
]);

export function decorateDisplayTimes(value: unknown, timezone: string, now: string): unknown {
  if (Array.isArray(value)) return value.map((item) => decorateDisplayTimes(item, timezone, now));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = decorateDisplayTimes(item, timezone, now);
    if (DISPLAY_TIME_KEYS.has(key) && typeof item === 'string') {
      const local = formatLocalTime(item, timezone, now, key === 'from' || key === 'to');
      if (local) result[`${key}Local`] = local;
    }
  }
  return result;
}

function rangeFromValue(value: unknown): DataSourceRangeCore | null {
  if (!isRecord(value)) return null;
  const from = stringOrNull(value.from) ?? stringOrNull(value.start);
  const to = stringOrNull(value.to) ?? stringOrNull(value.end);
  if (from === null && to === null) return null;
  return {
    from,
    to,
    timezone: stringOrNull(value.timezone),
    businessDayStart: stringOrNull(value.businessDayStart),
  };
}

function earliestRangeValue(ranges: DataSourceRangeCore[], key: 'from' | 'to'): string | null {
  const values = ranges.map((range) => range[key]).filter((value): value is string => value !== null);
  if (!values.length) return null;
  const ordered = values
    .map((value) => ({ value, timestamp: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  if (!ordered.length) return values[0] ?? null;
  return (key === 'from' ? ordered[0] : ordered[ordered.length - 1])?.value ?? null;
}

export function dataSourceRangeFor(envelope: ToolEnvelope, fallbackTimezone = 'Asia/Shanghai'): DataSourceRange {
  const query = isRecord(envelope.queryResolved) ? envelope.queryResolved : {};
  const direct = rangeFromValue(query.sourceRange);
  const resolvedSelector = rangeFromValue(query.resolvedSelector);
  const selector = resolvedSelector ?? rangeFromValue(query.selector);
  const selectorRanges = [direct, selector].filter((range): range is DataSourceRangeCore => range !== null);
  const rawSegments = Array.isArray(query.resolvedSegments) ? query.resolvedSegments : query.segments;
  const segments: DataSourceRangeSegmentValue[] = Array.isArray(rawSegments)
    ? rawSegments.flatMap((segment): DataSourceRangeSegmentValue[] => {
      if (!isRecord(segment)) return [];
      const range = rangeFromValue(segment.selector);
      if (!range) return [];
      return [{ label: stringOrNull(segment.label) ?? 'segment', ...range }];
    })
    : [];
  const segmentRanges = segments.map(({ label: _label, ...range }) => range);
  const ranges = [...selectorRanges, ...segmentRanges];
  const fallback = {
    from: stringOrNull(envelope.coverage.coverageStart),
    to: stringOrNull(envelope.coverage.coverageEnd),
    timezone: null,
    businessDayStart: null,
  };
  const primary = direct ?? selector ?? (ranges[0] ?? fallback);
  const timezone = primary.timezone ?? fallbackTimezone;
  const localize = (range: DataSourceRangeCore) => ({
    ...range,
    fromLocal: formatLocalTime(range.from, range.timezone ?? timezone, undefined, true),
    toLocal: formatLocalTime(range.to, range.timezone ?? timezone, undefined, true),
  });
  const localizedSegments = segments.map((segment) => ({
    ...segment,
    fromLocal: formatLocalTime(segment.from, segment.timezone ?? timezone, undefined, true),
    toLocal: formatLocalTime(segment.to, segment.timezone ?? timezone, undefined, true),
  }));
  const localizedPrimary = localize({
    from: earliestRangeValue(ranges.length ? ranges : [fallback], 'from'),
    to: earliestRangeValue(ranges.length ? ranges : [fallback], 'to'),
    timezone,
    businessDayStart: primary.businessDayStart,
  });
  return {
    ...localizedPrimary,
    segments: localizedSegments,
  };
}

export function presentationRangeFor(dataSourceRange: DataSourceRange): PubgSourceRange | undefined {
  const segments = dataSourceRange.segments.map((segment) => ({ label: segment.label, from: segment.from, to: segment.to }));
  if (dataSourceRange.from === null && dataSourceRange.to === null && !segments.length) return undefined;
  return { from: dataSourceRange.from, to: dataSourceRange.to, ...(segments.length ? { segments } : {}) };
}

export type ShareAppender = (
  envelope: ToolEnvelope,
  displayText: string,
  timezone: string,
  presentation: ReturnType<typeof buildPubgToolPresentation>['presentation'],
) => { text: string; url?: string };

export function jsonToolResult(name: string, envelope: ToolEnvelope, fallbackTimezone = 'Asia/Shanghai', share?: ShareAppender, replyGuide?: ReplyGuideProvider): PubgToolReply {
  const dataSourceRange = dataSourceRangeFor(envelope, fallbackTimezone);
  const displayTimezone = dataSourceRange.timezone ?? fallbackTimezone;
  const displayEnvelope = decorateDisplayTimes(envelope, displayTimezone, envelope.asOf) as Record<string, unknown>;
  const range = presentationRangeFor(dataSourceRange);
  let presentation: ReturnType<typeof buildPubgToolPresentation>;
  try {
    presentation = buildPubgToolPresentation(name, {
      status: envelope.status,
      data: envelope.data,
      dataUpdatedAt: envelope.asOf,
      ...(range ? { sourceRange: range } : {}),
      queryResolved: envelope.queryResolved,
      evidenceRefs: envelope.evidenceRefs,
      ...(envelope.error ? { error: envelope.error } : {}),
    }, { timezone: displayTimezone, now: envelope.asOf, localizedMetrics: true });
  } catch (error) {
    const status = buildPubgStatusPresentation({
      toolName: name,
      status: 'error',
      data: {},
      dataUpdatedAt: envelope.asOf,
      ...(range ? { sourceRange: range } : {}),
      evidenceRefs: envelope.evidenceRefs,
      error: { code: 'presentation_invalid', reason: error instanceof Error ? error.message : String(error) },
    });
    presentation = { presentation: status, displayText: renderPubgStatus(status, { timezone: displayTimezone, now: envelope.asOf }) };
  }
  const shared = share ? share(envelope, presentation.displayText, displayTimezone, presentation.presentation) : { text: presentation.displayText };
  // The share page keeps the plain block; the chat reply the agent retells gets the chat layout (bold, medals, ledger).
  const chatText = chatDisplayText(presentation.presentation, { timezone: displayTimezone, now: envelope.asOf, chatEmphasis: true });
  if (chatText !== undefined && shared.text.startsWith(presentation.displayText)) {
    shared.text = chatText + shared.text.slice(presentation.displayText.length);
  }
  const guide = (replyGuide ?? replyGuideFor)(presentation.presentation);
  return {
    ...displayEnvelope,
    asOfLocal: formatLocalTime(envelope.asOf, displayTimezone) ?? envelope.asOf,
    dataUpdatedAt: envelope.asOf,
    dataUpdatedAtLocal: formatLocalTime(envelope.asOf, displayTimezone) ?? envelope.asOf,
    displayTimezone,
    dataSourceRange,
    presentation: presentation.presentation,
    displayText: shared.text,
    ...(guide ? { replyGuide: guide } : {}),
    // The amadeus delivery boundary ends the reply with this exact link even when the agent retells the answer.
    ...(shared.url ? { replyLink: { kind: 'share', url: shared.url } } : {}),
  };
}

export function chatDisplayText(presentation: ReturnType<typeof buildPubgToolPresentation>['presentation'], options: PubgRenderOptions): string | undefined {
  if (presentation.type === 'pubg_stats') return renderPubgStats(presentation as PubgStatsPresentation, options);
  if (presentation.type === 'pubg_team_damage') return renderPubgTeamDamage(presentation as PubgTeamDamagePresentation, options);
  if (presentation.type === 'pubg_match_list') return renderPubgMatchList(presentation as PubgMatchListPresentation, options);
  return undefined;
}

