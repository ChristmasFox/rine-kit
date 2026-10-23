import { wilsonInterval, type RateEstimate } from './analytics.js';
import { mulberry32, percentile, STYLE_BOOTSTRAP_SEED } from './style.js';

export const RHYTHM_SCHEMA_VERSION = 1 as const;
/** A gap this long between two matches starts a new session. */
export const SESSION_GAP_MINUTES = 40;
export const RHYTHM_MIN_SESSIONS = 15;
export const RHYTHM_BOOTSTRAP = 2000;
/** Placements at or beyond this count as an early exit when looking for tilt. */
export const BAD_PLACEMENT = 15;
/** Sessions at least this long are used to compare their first and last games. */
export const LONG_SESSION_GAMES = 8;
export const RHYTHM_MIN_HOUR_MATCHES = 12;
export const RHYTHM_HOUR_TIMEZONE = 'Asia/Shanghai';

/** One match as the rhythm analysis sees it: when, how the squad placed and what a member did on average. */
export interface RhythmMatch {
  timestamp: number;
  rank: number | null;
  /** Mean damage of the squad members present (so a missing member does not look like a bad game). */
  damage: number;
}

export interface Interval {
  mean: number | null;
  low: number | null;
  high: number | null;
}

export interface Contrast {
  /** Group A minus group B, with a 95% interval from resampling whole sessions. */
  diff: number | null;
  low: number | null;
  high: number | null;
  a: number | null;
  b: number | null;
  nA: number;
  nB: number;
  /** True when the interval excludes zero. */
  clear: boolean;
}

export interface GameIndexRow {
  /** 1-based game number within the session; the last row is "this number or later". */
  index: number;
  orMore: boolean;
  matches: number;
  damage: Interval;
  top10: RateEstimate;
  medianPlacement: number | null;
}

export interface HourRow {
  hour: number;
  matches: number;
  top10: RateEstimate;
  meanDamage: number | null;
}

export interface CurrentSession {
  /** Number of the game the squad is about to play (games so far + 1). */
  nextGame: number;
  gamesSoFar: number;
  minutesSinceLast: number;
  startedAt: number;
}

export interface RhythmAnalysis {
  schemaVersion: typeof RHYTHM_SCHEMA_VERSION;
  matches: number;
  sessions: number;
  sessionStats: {
    medianGames: number | null;
    longShare: number | null;
    medianMinutes: number | null;
  };
  byIndex: GameIndexRow[];
  byHour: HourRow[];
  warmup: { damage: Contrast; top10: Contrast } | null;
  /** Late versus early games of long sessions: negative = worse late. */
  fatigue: { damage: Contrast; top10: Contrast; sessions: number } | null;
  /** The game after an early exit versus after any other game of the same session. */
  tilt: { damage: Contrast; top10: Contrast } | null;
  bestHour: { hour: number; top10: number; matches: number } | null;
  current: CurrentSession | null;
  insights: string[];
  notes: string[];
}

interface Game extends RhythmMatch {
  index: number;
  hour: number;
  top10: boolean;
}

function hourOf(timestamp: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone: RHYTHM_HOUR_TIMEZONE,
  }).formatToParts(timestamp);
  return Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
}

const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function splitSessions(matches: readonly RhythmMatch[]): Game[][] {
  const ordered = [...matches]
    .filter((match) => Number.isFinite(match.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  const sessions: Game[][] = [];
  let current: Game[] = [];
  for (const match of ordered) {
    const previous = current.at(-1);
    if (previous && match.timestamp - previous.timestamp > SESSION_GAP_MINUTES * 60_000) {
      sessions.push(current);
      current = [];
    }
    current.push({
      ...match,
      index: current.length + 1,
      hour: hourOf(match.timestamp),
      top10: match.rank !== null && match.rank > 0 && match.rank <= 10,
    });
  }
  if (current.length) sessions.push(current);
  return sessions;
}

/** Interval of a statistic over sessions resampled with replacement, so games of one night are not treated as independent. */
function sessionBootstrap(
  sessions: readonly Game[][],
  statistic: (sample: Game[][]) => number | null,
  seed: number,
): { low: number | null; high: number | null } {
  if (sessions.length < RHYTHM_MIN_SESSIONS) return { low: null, high: null };
  const rng = mulberry32(seed);
  const draws: number[] = [];
  for (let round = 0; round < RHYTHM_BOOTSTRAP; round += 1) {
    const sample = Array.from(
      { length: sessions.length },
      () => sessions[Math.floor(rng() * sessions.length)]!,
    );
    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) draws.push(value);
  }
  if (draws.length < RHYTHM_BOOTSTRAP * 0.8) return { low: null, high: null };
  draws.sort((left, right) => left - right);
  return { low: percentile(draws, 0.025), high: percentile(draws, 0.975) };
}

function contrast(
  sessions: readonly Game[][],
  pick: (session: Game[]) => { a: Game[]; b: Game[] },
  measure: (games: Game[]) => number | null,
  seed: number,
): Contrast {
  const statistic = (sample: readonly Game[][]): number | null => {
    const a: Game[] = [];
    const b: Game[] = [];
    for (const session of sample) {
      const picked = pick(session);
      a.push(...picked.a);
      b.push(...picked.b);
    }
    const left = measure(a);
    const right = measure(b);
    return left !== null && right !== null ? left - right : null;
  };
  const all = { a: [] as Game[], b: [] as Game[] };
  for (const session of sessions) {
    const picked = pick(session);
    all.a.push(...picked.a);
    all.b.push(...picked.b);
  }
  const a = measure(all.a);
  const b = measure(all.b);
  const diff = a !== null && b !== null ? a - b : null;
  const { low, high } = sessionBootstrap(sessions, statistic, seed);
  return {
    diff,
    low,
    high,
    a,
    b,
    nA: all.a.length,
    nB: all.b.length,
    clear: low !== null && high !== null && (low > 0 || high < 0),
  };
}

const damageOf = (games: Game[]): number | null => mean(games.map((game) => game.damage));
const top10Of = (games: Game[]): number | null =>
  games.length ? games.filter((game) => game.top10).length / games.length : null;

export function analyzeRhythm(input: {
  matches: readonly RhythmMatch[];
  now?: number;
}): RhythmAnalysis {
  const sessions = splitSessions(input.matches);
  const games = sessions.flat();
  const result: RhythmAnalysis = {
    schemaVersion: RHYTHM_SCHEMA_VERSION,
    matches: games.length,
    sessions: sessions.length,
    sessionStats: {
      medianGames: median(sessions.map((session) => session.length)),
      longShare: sessions.length
        ? sessions.filter((session) => session.length >= LONG_SESSION_GAMES).length /
          sessions.length
        : null,
      medianMinutes: median(
        sessions
          .filter((session) => session.length >= 2)
          .map((session) => (session.at(-1)!.timestamp - session[0]!.timestamp) / 60_000),
      ),
    },
    byIndex: [],
    byHour: [],
    warmup: null,
    fatigue: null,
    tilt: null,
    bestHour: null,
    current: null,
    insights: [],
    notes: [
      `一个时段 = 相邻两局间隔不超过 ${SESSION_GAP_MINUTES} 分钟的连续对局。`,
      '区间按「整个时段」重抽样得到（同一晚的几局互相有关联，不能当作独立样本）；区间不含 0 才算有把握。',
      '使用全部排位战绩，不受「仅看完整遥测」影响（时段需要连续的对局）；伤害是在场队员的人均伤害。',
    ],
  };
  if (!games.length) return result;

  const maxIndex = 8;
  for (let index = 1; index <= maxIndex; index += 1) {
    const group = games.filter((game) =>
      index === maxIndex ? game.index >= maxIndex : game.index === index,
    );
    if (!group.length) continue;
    const draws = (() => {
      if (group.length < 20) return { low: null, high: null };
      const rng = mulberry32(STYLE_BOOTSTRAP_SEED + index);
      const means: number[] = [];
      for (let round = 0; round < 500; round += 1)
        means.push(
          mean(
            Array.from(
              { length: group.length },
              () => group[Math.floor(rng() * group.length)]!.damage,
            ),
          )!,
        );
      means.sort((left, right) => left - right);
      return { low: percentile(means, 0.025), high: percentile(means, 0.975) };
    })();
    result.byIndex.push({
      index,
      orMore: index === maxIndex,
      matches: group.length,
      damage: { mean: damageOf(group), ...draws },
      top10: wilsonInterval(group.filter((game) => game.top10).length, group.length),
      medianPlacement: median(
        group.map((game) => game.rank).filter((rank): rank is number => rank !== null && rank > 0),
      ),
    });
  }

  const hours = new Map<number, Game[]>();
  for (const game of games) hours.set(game.hour, [...(hours.get(game.hour) ?? []), game]);
  result.byHour = [...hours.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([hour, group]) => ({
      hour,
      matches: group.length,
      top10: wilsonInterval(group.filter((game) => game.top10).length, group.length),
      meanDamage: damageOf(group),
    }));
  const eligibleHours = result.byHour.filter(
    (row) => row.matches >= RHYTHM_MIN_HOUR_MATCHES && row.top10.rate !== null,
  );
  const best = [...eligibleHours].sort((left, right) => right.top10.rate! - left.top10.rate!)[0];
  result.bestHour = best
    ? { hour: best.hour, top10: best.top10.rate!, matches: best.matches }
    : null;

  if (sessions.length >= RHYTHM_MIN_SESSIONS) {
    const warmPick = (session: Game[]) => ({ a: session.slice(0, 1), b: session.slice(1) });
    result.warmup = {
      damage: contrast(sessions, warmPick, damageOf, STYLE_BOOTSTRAP_SEED + 101),
      top10: contrast(sessions, warmPick, top10Of, STYLE_BOOTSTRAP_SEED + 103),
    };
    const long = sessions.filter((session) => session.length >= LONG_SESSION_GAMES);
    if (long.length >= RHYTHM_MIN_SESSIONS) {
      const latePick = (session: Game[]) => ({ a: session.slice(-3), b: session.slice(0, 3) });
      result.fatigue = {
        sessions: long.length,
        damage: contrast(long, latePick, damageOf, STYLE_BOOTSTRAP_SEED + 107),
        top10: contrast(long, latePick, top10Of, STYLE_BOOTSTRAP_SEED + 109),
      };
    }
    const tiltPick = (session: Game[]) => ({
      a: session.slice(1).filter((game, position) => {
        const before = session[position]!;
        return before.rank !== null && before.rank >= BAD_PLACEMENT;
      }),
      b: session.slice(1).filter((game, position) => {
        const before = session[position]!;
        return before.rank !== null && before.rank > 0 && before.rank < BAD_PLACEMENT;
      }),
    });
    const tilt = {
      damage: contrast(sessions, tiltPick, damageOf, STYLE_BOOTSTRAP_SEED + 113),
      top10: contrast(sessions, tiltPick, top10Of, STYLE_BOOTSTRAP_SEED + 127),
    };
    if (tilt.damage.nA >= 20) result.tilt = tilt;
  }

  const last = sessions.at(-1)!;
  const now = input.now ?? Date.now();
  const sinceLast = (now - last.at(-1)!.timestamp) / 60_000;
  if (sinceLast >= 0 && sinceLast <= SESSION_GAP_MINUTES + 20)
    result.current = {
      nextGame: last.length + 1,
      gamesSoFar: last.length,
      minutesSinceLast: Math.round(sinceLast),
      startedAt: last[0]!.timestamp,
    };

  // Findings: only what the intervals support, including the negative ones.
  const pct = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(0)}%`);
  const warm = result.warmup;
  if (warm) {
    if (warm.damage.clear && warm.damage.diff !== null && warm.damage.diff < 0 && warm.damage.b) {
      result.insights.push(
        `每个时段的第一局明显偏弱：人均伤害 ${Math.round(warm.damage.a ?? 0)}，之后各局 ${Math.round(warm.damage.b)}（低 ${Math.round((-warm.damage.diff / warm.damage.b) * 100)}%，区间 ${Math.round(warm.damage.low!)} 到 ${Math.round(warm.damage.high!)}）。建议先打一局低压力的对局热热手。`,
      );
    } else if (warm.damage.low !== null)
      result.insights.push('第一局的伤害和之后各局没有可靠差别，看不出需要热身。');
    if (warm.top10.clear && warm.top10.diff !== null)
      result.insights.push(
        `第一局的前十率 ${pct(warm.top10.a)}，之后各局 ${pct(warm.top10.b)}（差距区间 ${(warm.top10.low! * 100).toFixed(0)} 到 ${(warm.top10.high! * 100).toFixed(0)} 个百分点）。`,
      );
    else if (
      warm.top10.diff !== null &&
      warm.top10.diff <= -0.05 &&
      warm.top10.high !== null &&
      warm.top10.high < 0.05
    )
      result.insights.push(
        `第一局的前十率偏低（${pct(warm.top10.a)} 对 ${pct(warm.top10.b)}），但差距区间 ${(warm.top10.low! * 100).toFixed(0)} 到 ${(warm.top10.high! * 100).toFixed(0)} 个百分点刚好碰到 0，证据还不够，需要更多场次再下结论。`,
      );
  }
  if (result.fatigue) {
    const fatigue = result.fatigue;
    if (fatigue.damage.clear || fatigue.top10.clear)
      result.insights.push(
        `长时段（${LONG_SESSION_GAMES} 局以上）的最后 3 局${(fatigue.damage.diff ?? 0) < 0 ? '比前 3 局弱' : '比前 3 局强'}：人均伤害 ${Math.round(fatigue.damage.a ?? 0)} 对 ${Math.round(fatigue.damage.b ?? 0)}${(fatigue.damage.diff ?? 0) > 0 ? '（打得顺才会一直打下去，所以这不等于越打越强）' : ''}。`,
      );
    else if (fatigue.damage.low !== null)
      result.insights.push(
        `没有发现疲劳效应：长时段（${fatigue.sessions} 个）的最后 3 局和前 3 局人均伤害 ${Math.round(fatigue.damage.a ?? 0)} 对 ${Math.round(fatigue.damage.b ?? 0)}，差距在误差内。`,
      );
  }
  if (result.tilt) {
    const tilt = result.tilt;
    if (tilt.damage.clear || tilt.top10.clear)
      result.insights.push(
        `早死（第 ${BAD_PLACEMENT} 名之后）的下一局${(tilt.damage.diff ?? 0) < 0 ? '更差' : '更好'}：人均伤害 ${Math.round(tilt.damage.a ?? 0)} 对 ${Math.round(tilt.damage.b ?? 0)}。`,
      );
    else if (tilt.damage.low !== null)
      result.insights.push(
        `没有发现「上头」：早死后的下一局人均伤害 ${Math.round(tilt.damage.a ?? 0)}，其他局 ${Math.round(tilt.damage.b ?? 0)}，差距在误差内。`,
      );
  }
  if (result.bestHour && eligibleHours.length >= 3) {
    const overall = games.filter((game) => game.top10).length / games.length;
    const bestRow = eligibleHours.find((row) => row.hour === result.bestHour!.hour)!;
    if (bestRow.top10.low !== null && bestRow.top10.low > overall)
      result.insights.push(
        `${String(result.bestHour.hour).padStart(2, '0')}:00 前后状态最好：前十率 ${pct(result.bestHour.top10)}（${result.bestHour.matches} 场），高于全部时段的 ${pct(overall)}。`,
      );
  }
  return result;
}
