export const DEFAULT_DISPLAY_TIMEZONE = 'Asia/Shanghai';

export interface DisplayTimeOptions {
  timezone?: string;
  now?: Date | string;
  includeSeconds?: boolean;
  forceDate?: boolean;
}

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function parts(value: Date, timezone: string): LocalParts {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const values = Object.fromEntries(
    formatted.filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]),
  );
  return {
    year: String(values.year),
    month: String(values.month),
    day: String(values.day),
    hour: String(values.hour),
    minute: String(values.minute),
    second: String(values.second),
  };
}

function date(value: Date, timezone: string): string {
  const local = parts(value, timezone);
  return `${local.year}-${local.month}-${local.day}`;
}

function parse(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function referenceNow(value: Date | string | undefined): Date {
  return parse(value) ?? new Date();
}

/**
 * Format a real instant for a user-facing display. Same-local-date values use
 * HH:mm by default; values on another local date include YYYY-MM-DD HH:mm.
 * The implementation timezone is intentionally never appended to the text.
 */
export function formatDisplayTime(
  value: Date | string | null | undefined,
  options: DisplayTimeOptions = {},
): string | null {
  const parsed = parse(value);
  if (!parsed) return null;
  const timezone = options.timezone ?? DEFAULT_DISPLAY_TIMEZONE;
  const local = parts(parsed, timezone);
  const sameDay = date(parsed, timezone) === date(referenceNow(options.now), timezone);
  const withDate = options.forceDate === true || !sameDay;
  const clock = `${local.hour}:${local.minute}${options.includeSeconds ? `:${local.second}` : ''}`;
  return withDate ? `${local.year}-${local.month}-${local.day} ${clock}` : clock;
}

export function formatDisplayDate(
  value: Date | string | null | undefined,
  timezone = DEFAULT_DISPLAY_TIMEZONE,
): string | null {
  const parsed = parse(value);
  return parsed ? date(parsed, timezone) : null;
}

export function formatDisplayRange(
  from: Date | string | null | undefined,
  to: Date | string | null | undefined,
  options: DisplayTimeOptions = {},
): string {
  return `${formatDisplayTime(from, { ...options, forceDate: true }) ?? '未知'} 至 ${formatDisplayTime(to, { ...options, forceDate: true }) ?? '未知'}`;
}

export function containsInternalTimeTerms(value: string): boolean {
  return /Asia\/Shanghai|UTC\+?08(?::00)?|自然日|业务日/u.test(value);
}
