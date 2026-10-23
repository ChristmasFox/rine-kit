import type { CanonicalQuery, Selector } from '../schema/query.js';

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
export const BUSINESS_DAY_START = '06:00';

export interface ResolverOptions {
  timezone?: string;
  businessDayStart?: string;
  now?: Date;
}

export interface ResolvedTimeRange {
  type: 'time_range';
  start: string;
  end: string;
  label: string;
  timezone: string;
  businessDayStart: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdays[String(values.weekday)] ?? 0,
  };
}

function utcDateForLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localParts(new Date(guess), timezone);
    const targetMinutes = Date.UTC(year, month - 1, day, hour, minute) / 60000;
    const actualMinutes =
      Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute) / 60000;
    guess += (targetMinutes - actualMinutes) * 60000;
  }
  return new Date(guess);
}

function localDateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function shiftLocalDate(
  year: number,
  month: number,
  day: number,
  days: number,
  timezone: string,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0));
  const parts = localParts(shifted, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function range(
  start: Date,
  end: Date,
  label: string,
  timezone: string,
  businessDayStart: string,
): ResolvedTimeRange {
  return {
    type: 'time_range',
    start: start.toISOString(),
    end: end.toISOString(),
    label,
    timezone,
    businessDayStart,
  };
}

function businessDayStartFor(date: Date, options: Required<ResolverOptions>): Date {
  const parts = localParts(date, options.timezone);
  const [hour = 6, minute = 0] = options.businessDayStart.split(':').map(Number);
  const businessDate =
    parts.hour < hour || (parts.hour === hour && parts.minute < minute)
      ? shiftLocalDate(parts.year, parts.month, parts.day, -1, options.timezone)
      : { year: parts.year, month: parts.month, day: parts.day };
  return utcDateForLocal(
    businessDate.year,
    businessDate.month,
    businessDate.day,
    hour,
    minute,
    options.timezone,
  );
}

function parseWeekday(text: string): number | null {
  const match = text.match(/上周([一二三四五六日天]|[0-6])|本周([一二三四五六日天]|[0-6])/u);
  if (!match) return null;
  const token = match[1] ?? match[2];
  if (token === '日' || token === '天') return 0;
  if (token && /\d/.test(token)) return Number(token);
  return { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }[token ?? ''] ?? null;
}

function parseDate(
  text: string,
  now: Date,
  timezone: string,
): { year: number; month: number; day: number } | null {
  const match = text.match(/(?:(\d{4})\s*[年/-]\s*)?(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*(?:日|号)?/u);
  if (!match) return null;
  const current = localParts(now, timezone);
  const year = Number(match[1] ?? current.year);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function parseClock(text: string): { hour: number; minute: number } | null {
  const match =
    text.match(
      /(?:昨天晚上|昨日晚上|昨晚|晚上|晚间|凌晨|早上|下午|上午)\s*(\d{1,2})(?::(\d{1,2}))?\s*(?:点|时)?/u,
    ) ?? text.match(/(?:^|[^\d年月日号/-])(\d{1,2})(?::(\d{1,2}))?\s*(?:点|时|:)/u);
  if (!match) return null;
  const hourToken = match[1] ?? match[2];
  const minuteToken = match[1] ? match[2] : match[3];
  let hour = Number(hourToken ?? 0);
  const minute = Number(minuteToken ?? 0);
  if (/(下午|晚上|晚间|昨晚|昨天晚上|昨日晚上)/u.test(text) && hour < 12) hour += 12;
  if (/(凌晨)/u.test(text) && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function dateDayRange(
  date: { year: number; month: number; day: number },
  label: string,
  options: Required<ResolverOptions>,
): ResolvedTimeRange {
  const [hour = 6, minute = 0] = options.businessDayStart.split(':').map(Number);
  const start = utcDateForLocal(date.year, date.month, date.day, hour, minute, options.timezone);
  const next = shiftLocalDate(date.year, date.month, date.day, 1, options.timezone);
  const end = utcDateForLocal(next.year, next.month, next.day, hour, minute, options.timezone);
  return range(start, end, label, options.timezone, options.businessDayStart);
}

export function resolveSelector(
  selector: Selector,
  resolverOptions: ResolverOptions = {},
): ResolvedTimeRange {
  const options: Required<ResolverOptions> = {
    timezone: resolverOptions.timezone ?? DEFAULT_TIMEZONE,
    businessDayStart: resolverOptions.businessDayStart ?? BUSINESS_DAY_START,
    now: resolverOptions.now ?? new Date(),
  };
  const now = options.now;
  const currentBusinessStart = businessDayStartFor(now, options);

  if (selector.type === 'time_range') {
    return {
      type: 'time_range',
      start: new Date(selector.start).toISOString(),
      end: new Date(selector.end).toISOString(),
      label: selector.label ?? '指定时间',
      timezone: selector.timezone ?? options.timezone,
      businessDayStart: selector.businessDayStart ?? options.businessDayStart,
    };
  }

  if (selector.type === 'last_n_matches') {
    return {
      type: 'time_range',
      start: new Date(0).toISOString(),
      end: now.toISOString(),
      label: selector.label ?? `最近${selector.count}场`,
      timezone: options.timezone,
      businessDayStart: options.businessDayStart,
    };
  }

  if (selector.type === 'result_set') {
    return {
      type: 'time_range',
      start: new Date(0).toISOString(),
      end: now.toISOString(),
      label: selector.label ?? '上一组比赛',
      timezone: options.timezone,
      businessDayStart: options.businessDayStart,
    };
  }

  if (selector.type === 'recent_days') {
    const start = new Date(currentBusinessStart.getTime() - (selector.count - 1) * 86400000);
    return range(
      start,
      now,
      selector.label ?? `最近${selector.count}天`,
      options.timezone,
      options.businessDayStart,
    );
  }

  const value = selector.value.trim();
  // Rolling windows are named selectors so every runtime uses the same clock
  // and half-open interval semantics. The public SaaS adapter must not perform
  // this arithmetic before invoking the Domain.
  if (value === 'last_7_days') {
    return range(
      new Date(now.getTime() - 7 * 86400000),
      now,
      selector.label ?? '最近七天',
      options.timezone,
      options.businessDayStart,
    );
  }
  if (value === 'previous_7_days') {
    return range(
      new Date(now.getTime() - 14 * 86400000),
      new Date(now.getTime() - 7 * 86400000),
      selector.label ?? '此前七天',
      options.timezone,
      options.businessDayStart,
    );
  }
  if (value === 'days_14_to_21_ago') {
    return range(
      new Date(now.getTime() - 21 * 86400000),
      new Date(now.getTime() - 14 * 86400000),
      selector.label ?? '更早七天',
      options.timezone,
      options.businessDayStart,
    );
  }
  const currentParts = localParts(now, options.timezone);
  const currentDate = { year: currentParts.year, month: currentParts.month, day: currentParts.day };
  const [businessHour = 6, businessMinute = 0] = options.businessDayStart.split(':').map(Number);
  const clock = parseClock(value);
  const afterClock = Boolean(clock && /(以后|之后|开始|起)/u.test(value));
  const currentDayStart = utcDateForLocal(
    currentDate.year,
    currentDate.month,
    currentDate.day,
    businessHour,
    businessMinute,
    options.timezone,
  );

  if (afterClock && clock && /昨晚|昨天晚上|昨日晚上/u.test(value)) {
    const previous = shiftLocalDate(
      currentDate.year,
      currentDate.month,
      currentDate.day,
      -1,
      options.timezone,
    );
    const start = utcDateForLocal(
      previous.year,
      previous.month,
      previous.day,
      clock.hour,
      clock.minute,
      options.timezone,
    );
    const end = now < currentDayStart ? now : currentDayStart;
    return range(start, end, selector.label ?? value, options.timezone, options.businessDayStart);
  }
  if (value === 'last_night' || /昨晚|昨天晚上/u.test(value)) {
    const previous = shiftLocalDate(
      currentDate.year,
      currentDate.month,
      currentDate.day,
      -1,
      options.timezone,
    );
    const start = utcDateForLocal(
      previous.year,
      previous.month,
      previous.day,
      18,
      0,
      options.timezone,
    );
    const end = now < currentDayStart ? now : currentDayStart;
    return range(start, end, selector.label ?? '昨晚', options.timezone, options.businessDayStart);
  }
  if (value === 'today' || /今天|今日/u.test(value)) {
    return range(
      currentBusinessStart,
      now,
      selector.label ?? '今天',
      options.timezone,
      options.businessDayStart,
    );
  }
  if (value === 'yesterday' || /昨天|昨日/u.test(value)) {
    const start = new Date(currentBusinessStart.getTime() - 86400000);
    return range(
      start,
      currentBusinessStart,
      selector.label ?? '昨天',
      options.timezone,
      options.businessDayStart,
    );
  }
  if (value === 'day_before_yesterday' || /前天|前日/u.test(value)) {
    const start = new Date(currentBusinessStart.getTime() - 2 * 86400000);
    const end = new Date(currentBusinessStart.getTime() - 86400000);
    return range(start, end, selector.label ?? '前天', options.timezone, options.businessDayStart);
  }
  const daysAgo = value.match(/(?:大前天|大前日)/u)
    ? 3
    : value.match(/(\d+)天前/u)?.[1]
      ? Number(value.match(/(\d+)天前/u)?.[1])
      : null;
  if (daysAgo !== null) {
    const start = new Date(currentBusinessStart.getTime() - daysAgo * 86400000);
    return range(
      start,
      new Date(start.getTime() + 86400000),
      selector.label ?? `${daysAgo}天前`,
      options.timezone,
      options.businessDayStart,
    );
  }

  const weekday = parseWeekday(value);
  if (weekday !== null) {
    const isPreviousWeek = value.includes('上周');
    const mondayOffset = currentParts.weekday === 0 ? -6 : 1 - currentParts.weekday;
    const weekStart = shiftLocalDate(
      currentDate.year,
      currentDate.month,
      currentDate.day,
      mondayOffset + (isPreviousWeek ? -7 : 0),
      options.timezone,
    );
    const date = shiftLocalDate(
      weekStart.year,
      weekStart.month,
      weekStart.day,
      weekday === 0 ? 6 : weekday - 1,
      options.timezone,
    );
    if (afterClock && clock) {
      const start = utcDateForLocal(
        date.year,
        date.month,
        date.day,
        clock.hour,
        clock.minute,
        options.timezone,
      );
      const next = shiftLocalDate(date.year, date.month, date.day, 1, options.timezone);
      const end = utcDateForLocal(
        next.year,
        next.month,
        next.day,
        businessHour,
        businessMinute,
        options.timezone,
      );
      return range(start, end, selector.label ?? value, options.timezone, options.businessDayStart);
    }
    return dateDayRange(date, selector.label ?? value, options);
  }
  if (value === 'last_week' || /上周(?![一二三四五六日天0-6])/u.test(value)) {
    const mondayOffset = currentParts.weekday === 0 ? -6 : 1 - currentParts.weekday;
    const thisMonday = shiftLocalDate(
      currentDate.year,
      currentDate.month,
      currentDate.day,
      mondayOffset,
      options.timezone,
    );
    const previousMonday = shiftLocalDate(
      thisMonday.year,
      thisMonday.month,
      thisMonday.day,
      -7,
      options.timezone,
    );
    const nextMonday = thisMonday;
    const start = utcDateForLocal(
      previousMonday.year,
      previousMonday.month,
      previousMonday.day,
      businessHour,
      businessMinute,
      options.timezone,
    );
    const end = utcDateForLocal(
      nextMonday.year,
      nextMonday.month,
      nextMonday.day,
      businessHour,
      businessMinute,
      options.timezone,
    );
    return range(start, end, selector.label ?? '上周', options.timezone, options.businessDayStart);
  }
  if (value === 'this_week' || /本周/u.test(value)) {
    const mondayOffset = currentParts.weekday === 0 ? -6 : 1 - currentParts.weekday;
    const monday = shiftLocalDate(
      currentDate.year,
      currentDate.month,
      currentDate.day,
      mondayOffset,
      options.timezone,
    );
    const start = utcDateForLocal(
      monday.year,
      monday.month,
      monday.day,
      businessHour,
      businessMinute,
      options.timezone,
    );
    return range(start, now, selector.label ?? '本周', options.timezone, options.businessDayStart);
  }

  const parsedDate = parseDate(value, now, options.timezone);
  if (parsedDate) {
    if (afterClock && clock) {
      const start = utcDateForLocal(
        parsedDate.year,
        parsedDate.month,
        parsedDate.day,
        clock.hour,
        clock.minute,
        options.timezone,
      );
      const next = shiftLocalDate(
        parsedDate.year,
        parsedDate.month,
        parsedDate.day,
        1,
        options.timezone,
      );
      const end = utcDateForLocal(
        next.year,
        next.month,
        next.day,
        businessHour,
        businessMinute,
        options.timezone,
      );
      return range(start, end, selector.label ?? value, options.timezone, options.businessDayStart);
    }
    return dateDayRange(parsedDate, selector.label ?? value, options);
  }
  if (afterClock && clock) {
    const start = utcDateForLocal(
      currentDate.year,
      currentDate.month,
      currentDate.day,
      clock.hour,
      clock.minute,
      options.timezone,
    );
    return range(start, now, selector.label ?? value, options.timezone, options.businessDayStart);
  }
  return range(
    currentBusinessStart,
    now,
    selector.label ?? '今天',
    options.timezone,
    options.businessDayStart,
  );
}

/** Resolve the preceding comparable interval for a canonical selector. */
export function resolvePreviousPeriodSelector(
  selector: Selector,
  resolverOptions: ResolverOptions = {},
): Selector | null {
  if (selector.type === 'last_n_matches') {
    return { ...selector, offset: (selector.offset ?? 0) + selector.count };
  }

  if (selector.type === 'recent_days') {
    const resolved = resolveSelector(selector, resolverOptions);
    const start = Date.parse(resolved.start);
    if (!Number.isFinite(start)) return null;
    return {
      type: 'time_range',
      start: new Date(start - selector.count * 86400000).toISOString(),
      end: new Date(start).toISOString(),
      timezone: resolved.timezone,
      businessDayStart: resolved.businessDayStart,
    };
  }

  if (selector.type === 'relative_period') {
    const previousValue: Record<string, string> = {
      today: 'yesterday',
      yesterday: 'day_before_yesterday',
      this_week: 'last_week',
      last_7_days: 'previous_7_days',
      previous_7_days: 'days_14_to_21_ago',
    };
    const value = previousValue[selector.value.trim()];
    return value ? { type: 'relative_period', value } : null;
  }

  if (selector.type === 'result_set') return null;

  const resolved = resolveSelector(selector, resolverOptions);
  const start = Date.parse(resolved.start);
  const end = Date.parse(resolved.end);
  const duration = end - start;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return {
    type: 'time_range',
    start: new Date(start - duration).toISOString(),
    end: new Date(start).toISOString(),
    timezone: resolved.timezone,
    businessDayStart: resolved.businessDayStart,
  };
}

export function canonicalizeSelector(selector: Selector, options: ResolverOptions = {}): Selector {
  if (selector.type === 'last_n_matches' || selector.type === 'result_set') return selector;
  return resolveSelector(selector, options) as Selector;
}

export function resolveQuerySelectors(
  query: CanonicalQuery,
  options: ResolverOptions = {},
): CanonicalQuery {
  const resolvedSelector = canonicalizeSelector(query.selector, options);
  const segments = query.segments.map((segment) => ({
    ...segment,
    selector: canonicalizeSelector(segment.selector, options),
  }));
  return { ...query, selector: resolvedSelector, segments };
}

export function describeRange(selector: Selector): string {
  if (selector.type === 'last_n_matches') return selector.label ?? `最近${selector.count}场`;
  if (selector.type === 'result_set') return selector.label ?? '上一组比赛';
  if (selector.type === 'recent_days') return selector.label ?? `最近${selector.count}天`;
  if (selector.type === 'relative_period') return selector.label ?? selector.value;
  if (selector.label) return selector.label;
  return `${selector.start} ~ ${selector.end}`;
}

export function localDateLabel(timestamp: number, timezone = DEFAULT_TIMEZONE): string {
  const parts = localParts(new Date(timestamp), timezone);
  return localDateKey(parts.year, parts.month, parts.day);
}

export function businessDayLabel(
  timestamp: number,
  timezone = DEFAULT_TIMEZONE,
  businessDayStart = BUSINESS_DAY_START,
): string {
  const parts = localParts(new Date(timestamp), timezone);
  const [hour = 6, minute = 0] = businessDayStart.split(':').map(Number);
  const date =
    parts.hour < hour || (parts.hour === hour && parts.minute < minute)
      ? shiftLocalDate(parts.year, parts.month, parts.day, -1, timezone)
      : { year: parts.year, month: parts.month, day: parts.day };
  return localDateKey(date.year, date.month, date.day);
}

function parseDay(day: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) throw new Error(`invalid business day: ${day}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** The business day YYYY-MM-DD as an instant range: its businessDayStart (inclusive) to the next day's (exclusive). */
export function businessDayWindow(
  day: string,
  timezone = DEFAULT_TIMEZONE,
  businessDayStart = BUSINESS_DAY_START,
): { businessDay: string; startMs: number; endMs: number } {
  const range = dateDayRange(parseDay(day), day, { timezone, businessDayStart, now: new Date() });
  return { businessDay: day, startMs: Date.parse(range.start), endMs: Date.parse(range.end) };
}

/** The last business day that has fully ended at `now` (at 09:30 on the 20th: the 19th, 06:00 to 06:00). */
export function latestCompleteBusinessDay(
  now: Date,
  timezone = DEFAULT_TIMEZONE,
  businessDayStart = BUSINESS_DAY_START,
): string {
  const current = parseDay(businessDayLabel(now.getTime(), timezone, businessDayStart));
  const previous = shiftLocalDate(current.year, current.month, current.day, -1, timezone);
  return localDateKey(previous.year, previous.month, previous.day);
}

/** The instant of HH:MM local time on the calendar date `days` after YYYY-MM-DD. */
export function localTimeOn(
  day: string,
  clock: string,
  timezone = DEFAULT_TIMEZONE,
  days = 0,
): Date {
  const date = parseDay(day);
  const shifted = shiftLocalDate(date.year, date.month, date.day, days, timezone);
  const [hour = 0, minute = 0] = clock.split(':').map(Number);
  return utcDateForLocal(shifted.year, shifted.month, shifted.day, hour, minute, timezone);
}
