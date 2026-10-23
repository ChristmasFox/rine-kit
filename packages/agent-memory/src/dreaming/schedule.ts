type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function localParts(timestamp: number, timezone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const values = new Map(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  const result = {
    year: values.get('year'),
    month: values.get('month'),
    day: values.get('day'),
    hour: values.get('hour'),
    minute: values.get('minute'),
    second: values.get('second'),
  };
  if (Object.values(result).some((value) => value === undefined || !Number.isSafeInteger(value))) {
    throw new Error('memory_dreaming_timezone_invalid');
  }
  return result as LocalDateTime;
}

function wallClockToTimestamp(value: LocalDateTime, timezone: string): number {
  const target = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
  let timestamp = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localParts(timestamp, timezone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const delta = target - represented;
    if (delta === 0) return timestamp;
    timestamp += delta;
  }
  throw new Error('memory_dreaming_local_time_unresolvable');
}

function addLocalDays(value: LocalDateTime, days: number): LocalDateTime {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: value.hour,
    minute: value.minute,
    second: value.second,
  };
}

function dateKey(value: LocalDateTime): string {
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

/** Returns the next strictly future 03:00 wall-clock instant; startup never catches up a missed run. */
export function nextMemoryDreamingAt(now: number, timezone: string): number {
  if (!Number.isFinite(now)) throw new Error('memory_dreaming_clock_invalid');
  const localNow = localParts(now, timezone);
  const todayAtThree = wallClockToTimestamp(
    { ...localNow, hour: 3, minute: 0, second: 0 },
    timezone,
  );
  if (todayAtThree > now) return todayAtThree;
  return wallClockToTimestamp(
    { ...addLocalDays(localNow, 1), hour: 3, minute: 0, second: 0 },
    timezone,
  );
}

export function memoryDreamingLocalDateAt(timestamp: number, timezone: string): string {
  if (!Number.isFinite(timestamp)) throw new Error('memory_dreaming_clock_invalid');
  return dateKey(localParts(timestamp, timezone));
}
