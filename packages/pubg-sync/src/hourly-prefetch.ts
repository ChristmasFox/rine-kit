/** Lab's `amadeus-pubg-telemetry-hourly` cron: minute 5 of every hour, Asia/Shanghai. */
export const HOURLY_PREFETCH_MINUTE = 5;
export const HOURLY_PREFETCH_TIMEZONE = 'Asia/Shanghai';
/** How often an idle worker looks for a newly linked team. Those jobs are already due; this does not call PUBG. */
export const HOURLY_PREFETCH_IDLE_POLL_MS = 60_000;
const MIN_SYNC_DELAY_MS = 1_000;
const MAX_SYNC_DELAY_MS = 24 * 60 * 60_000;

export interface HourlyPrefetchClock {
  timeZone?: string;
  minute?: number;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const names = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const value = (type: string) => Number(names.find((part) => part.type === type)?.value);
  const hour = value('hour');
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: hour === 24 ? 0 : hour,
    minute: value('minute'),
    second: value('second'),
  };
}

function offsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant.getTime();
}

function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const corrected = new Date(guess.getTime() - offsetMs(guess, timeZone));
  return new Date(guess.getTime() - offsetMs(corrected, timeZone));
}

/** Milliseconds until the next minute-:MM slot strictly after `now`. */
export function nextHourlyPrefetchDelayMs(now: Date, clock: HourlyPrefetchClock = {}): number {
  const timeZone = clock.timeZone?.trim() || HOURLY_PREFETCH_TIMEZONE;
  const minute = clock.minute ?? HOURLY_PREFETCH_MINUTE;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('public_sync_hourly_minute_invalid');
  let local: ZonedParts;
  try {
    local = zonedParts(now, timeZone);
  } catch {
    throw new Error('public_sync_hourly_timezone_invalid');
  }
  const thisHour = zonedToUtc(local.year, local.month, local.day, local.hour, minute, timeZone);
  const target = thisHour.getTime() > now.getTime()
    ? thisHour
    : zonedToUtc(local.year, local.month, local.day, local.hour + 1, minute, timeZone);
  const delay = target.getTime() - now.getTime();
  if (!Number.isFinite(delay) || delay <= 0) throw new Error('public_sync_hourly_clock_invalid');
  return delay;
}

/** Queue delay accepted by the sync job table: at least one second, at most one day. */
export function clampSyncDelayMs(delayMs: number): number {
  return Math.min(MAX_SYNC_DELAY_MS, Math.max(MIN_SYNC_DELAY_MS, Math.trunc(delayMs)));
}

/**
 * Fixed interval when the operator set one. Otherwise sleep only until the next hourly slot,
 * but wake at least once a minute so a newly linked team (already marked due) is not left waiting.
 */
export function syncCyclePauseMs(options: {
  hourly: boolean;
  intervalMs: number;
  now: Date;
  timeZone?: string;
  minute?: number;
  idlePollMs?: number;
}): number {
  if (!options.hourly) return options.intervalMs;
  return Math.min(
    options.idlePollMs ?? HOURLY_PREFETCH_IDLE_POLL_MS,
    nextHourlyPrefetchDelayMs(options.now, {
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      ...(options.minute !== undefined ? { minute: options.minute } : {}),
    }),
  );
}
