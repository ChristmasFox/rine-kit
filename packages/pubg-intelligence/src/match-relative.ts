export const MATCH_RELATIVE_SCHEMA_VERSION = 1 as const;
/** A player needs at least this many other matches before a match is compared with their usual level. */
export const MATCH_RELATIVE_MIN_HISTORY = 8;
/** Percentiles at or beyond these bounds are called out as unusually good or bad. */
export const MATCH_RELATIVE_NOTABLE = 0.85;

export type RelativeMetricKey =
  | 'damage'
  | 'kills'
  | 'knocks'
  | 'assists'
  | 'survival'
  | 'dpm'
  | 'hitRate'
  | 'takedowns'
  | 'longestStreak'
  | 'wipeTakedowns'
  | 'timesDowned';

export interface RelativeMetricDefinition {
  key: RelativeMetricKey;
  label: string;
  /** How values are shown: whole numbers, minutes, a share, or one decimal. */
  format: 'int' | 'minutes' | 'percent' | 'decimal';
  higherIsBetter: boolean;
  /** Counts toward the player's overall form score for the match. */
  core: boolean;
}

export const RELATIVE_METRICS: readonly RelativeMetricDefinition[] = [
  { key: 'damage', label: '伤害', format: 'int', higherIsBetter: true, core: true },
  { key: 'kills', label: '击杀', format: 'int', higherIsBetter: true, core: true },
  { key: 'knocks', label: '击倒', format: 'int', higherIsBetter: true, core: true },
  { key: 'assists', label: '助攻', format: 'int', higherIsBetter: true, core: false },
  { key: 'survival', label: '存活', format: 'minutes', higherIsBetter: true, core: true },
  { key: 'dpm', label: '每分钟伤害', format: 'decimal', higherIsBetter: true, core: true },
  { key: 'hitRate', label: '命中率', format: 'percent', higherIsBetter: true, core: false },
  { key: 'takedowns', label: '放倒', format: 'int', higherIsBetter: true, core: false },
  { key: 'longestStreak', label: '最长连杀', format: 'int', higherIsBetter: true, core: false },
  { key: 'wipeTakedowns', label: '灭队中放倒', format: 'int', higherIsBetter: true, core: false },
  { key: 'timesDowned', label: '被击倒', format: 'int', higherIsBetter: false, core: false },
];

export type RelativeValues = Partial<Record<RelativeMetricKey, number | null>>;

export interface RelativePlayerInput {
  accountId: string;
  name: string;
  current: RelativeValues;
  /** The same metrics from the player's other matches in scope (the current match excluded). */
  history: readonly RelativeValues[];
}

export interface RelativeReading {
  key: RelativeMetricKey;
  label: string;
  format: RelativeMetricDefinition['format'];
  higherIsBetter: boolean;
  value: number | null;
  median: number | null;
  /** Midrank position of this match among the player's history, 0 (lowest) to 1 (highest). */
  percentile: number | null;
  /** Percentile oriented so 1 is always good (flipped for metrics where lower is better). */
  goodness: number | null;
  historyCount: number;
}

export interface RelativePlayer {
  accountId: string;
  name: string;
  historyMatches: number;
  metrics: RelativeReading[];
  /** Mean goodness over the core metrics; 0.5 is an ordinary match for this player. */
  form: number | null;
}

export interface MatchRelative {
  schemaVersion: typeof MATCH_RELATIVE_SCHEMA_VERSION;
  players: RelativePlayer[];
  /** Placement percentile among the squad's matches in scope (1 = best placement seen). */
  placement: { value: number | null; goodness: number | null; historyCount: number };
  highlights: Array<{ tone: 'good' | 'bad' | 'info'; text: string }>;
  notes: string[];
}

function midrank(values: readonly number[], value: number): number {
  const less = values.filter((other) => other < value).length;
  const equal = values.filter((other) => other === value).length;
  return (less + 0.5 * equal) / values.length;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function formatRelativeValue(
  format: RelativeMetricDefinition['format'],
  value: number,
): string {
  if (format === 'percent') return `${(value * 100).toFixed(1)}%`;
  if (format === 'minutes') return `${value.toFixed(1)} 分钟`;
  if (format === 'decimal') return value.toFixed(1);
  return String(Math.round(value));
}

/**
 * Places one match against each member's own history: every metric becomes a percentile among that member's
 * other matches, so "612 damage" reads as "better than 93% of your matches". Members with too short a history
 * get no percentiles; nothing is compared across members, so a support player is not judged by a fragger's bar.
 */
export function buildMatchRelative(input: {
  players: readonly RelativePlayerInput[];
  placement: { current: number | null; history: readonly number[] };
}): MatchRelative {
  const players: RelativePlayer[] = input.players.map((player) => {
    const metrics = RELATIVE_METRICS.map((definition): RelativeReading => {
      const value = player.current[definition.key] ?? null;
      const history = player.history
        .map((values) => values[definition.key])
        .filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
      const enough = history.length >= MATCH_RELATIVE_MIN_HISTORY;
      const percentile = value !== null && enough ? midrank(history, value) : null;
      return {
        key: definition.key,
        label: definition.label,
        format: definition.format,
        higherIsBetter: definition.higherIsBetter,
        value,
        median: enough ? median(history) : null,
        percentile,
        goodness:
          percentile === null ? null : definition.higherIsBetter ? percentile : 1 - percentile,
        historyCount: history.length,
      };
    });
    const core = metrics.filter(
      (reading) =>
        RELATIVE_METRICS.find((definition) => definition.key === reading.key)!.core &&
        reading.goodness !== null,
    );
    return {
      accountId: player.accountId,
      name: player.name,
      historyMatches: player.history.length,
      metrics,
      form:
        core.length >= 3
          ? core.reduce((sum, reading) => sum + reading.goodness!, 0) / core.length
          : null,
    };
  });

  const placementHistory = input.placement.history.filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  const placementEnough =
    input.placement.current !== null && placementHistory.length >= MATCH_RELATIVE_MIN_HISTORY;
  // Lower placement numbers are better, so goodness is the share of past matches that placed worse.
  const placementGoodness = placementEnough
    ? 1 - midrank(placementHistory, input.placement.current!)
    : null;

  const highlights: MatchRelative['highlights'] = [];
  if (placementGoodness !== null) {
    if (placementGoodness >= MATCH_RELATIVE_NOTABLE)
      highlights.push({
        tone: 'good',
        text: `第 ${input.placement.current} 名，好于小队 ${(placementGoodness * 100).toFixed(0)}% 的比赛。`,
      });
    else if (placementGoodness <= 1 - MATCH_RELATIVE_NOTABLE)
      highlights.push({
        tone: 'bad',
        text: `第 ${input.placement.current} 名，差于小队 ${((1 - placementGoodness) * 100).toFixed(0)}% 的比赛。`,
      });
  }
  const ranked = players
    .filter((player) => player.form !== null)
    .sort((left, right) => right.form! - left.form!);
  if (ranked.length >= 2 && ranked[0]!.form! >= 0.65)
    highlights.push({
      tone: 'good',
      text: `本局状态最好：${ranked[0]!.name}（综合分位 ${(ranked[0]!.form! * 100).toFixed(0)}，0.5 为他的平常水平）。`,
    });
  const notable = players
    .flatMap((player) =>
      player.metrics
        .filter(
          (reading) =>
            reading.goodness !== null &&
            reading.value !== null &&
            reading.median !== null &&
            (reading.goodness >= MATCH_RELATIVE_NOTABLE ||
              reading.goodness <= 1 - MATCH_RELATIVE_NOTABLE) &&
            // A zero against a zero median is not news.
            !(reading.value === 0 && reading.median === 0),
        )
        .map((reading) => ({ player, reading, strength: Math.abs(reading.goodness! - 0.5) })),
    )
    .sort(
      (left, right) =>
        right.strength - left.strength || left.player.name.localeCompare(right.player.name),
    );
  const perPlayer = new Map<string, number>();
  for (const { player, reading } of notable) {
    if ((perPlayer.get(player.accountId) ?? 0) >= 2 || highlights.length >= 7) continue;
    perPlayer.set(player.accountId, (perPlayer.get(player.accountId) ?? 0) + 1);
    const good = reading.goodness! >= 0.5;
    const share = Math.round((good ? reading.goodness! : 1 - reading.goodness!) * 100);
    highlights.push({
      tone: good ? 'good' : 'bad',
      text: `${player.name} ${reading.label} ${formatRelativeValue(reading.format, reading.value!)}，${good ? '好于' : '差于'}他 ${share}% 的比赛（平时中位 ${formatRelativeValue(reading.format, reading.median!)}）。`,
    });
  }
  if (!highlights.length && players.some((player) => player.form !== null))
    highlights.push({ tone: 'info', text: '这一局各项数据都在每个人的平常范围内。' });

  return {
    schemaVersion: MATCH_RELATIVE_SCHEMA_VERSION,
    players,
    placement: {
      value: input.placement.current,
      goodness: placementGoodness,
      historyCount: placementHistory.length,
    },
    highlights,
    notes: [
      `分位 = 本局数值在该队员其他比赛里的位置（只和自己比），0.5 为平常水平；至少 ${MATCH_RELATIVE_MIN_HISTORY} 场历史才计算。`,
      '综合分位 = 伤害、击杀、击倒、存活、每分钟伤害五项分位的平均。命中率、放倒、连杀、灭队只在有归档遥测的比赛里可用。',
    ],
  };
}
