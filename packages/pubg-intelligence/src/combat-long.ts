import type { NormalizedMatch, NormalizedPlayer } from '@rine-kit/pubg-domain';
import {
  mulberry32,
  percentile,
  STYLE_BOOTSTRAP_RESAMPLES,
  STYLE_BOOTSTRAP_SEED,
  STYLE_LEAN_CONFIDENCE,
  type StyleTier,
} from './style.js';

export const LONG_RUN_SCHEMA_VERSION = 1 as const;
export const LONG_RUN_NOTABLE_RATIO = 1.1;
export const LONG_RUN_MIN_MATCHES = 30;

export type LongRunMetric = 'damage' | 'kills' | 'knocks' | 'assists';

const METRICS: ReadonlyArray<{
  key: LongRunMetric;
  label: string;
  pick: (player: NormalizedPlayer) => number;
}> = [
  { key: 'damage', label: '伤害', pick: (player) => player.damage },
  { key: 'kills', label: '击杀', pick: (player) => player.kills },
  { key: 'knocks', label: '击倒', pick: (player) => player.dbnos },
  { key: 'assists', label: '助攻', pick: (player) => player.assists },
];
const COMPOSITE: readonly LongRunMetric[] = ['damage', 'kills', 'knocks'];

export interface LongRunReading {
  /** Own total divided by the total a fair split of each match would have given the player. */
  ratio: number | null;
  low: number | null;
  high: number | null;
  confidence: number | null;
  tier: StyleTier;
  direction: 'high' | 'low' | null;
}

export interface LongRunEntry {
  accountId: string;
  name: string;
  matches: number;
  rank: number;
  composite: LongRunReading;
  metrics: Array<{ key: LongRunMetric; label: string } & LongRunReading>;
}

export interface LongRunCombat {
  schemaVersion: typeof LONG_RUN_SCHEMA_VERSION;
  matches: number;
  entries: LongRunEntry[];
  verdict: string;
  notes: string[];
}

interface Row {
  players: Array<{ accountId: string; values: Record<LongRunMetric, number> }>;
  totals: Record<LongRunMetric, number>;
}

function gradeReading(ratio: number | null, draws: readonly number[]): LongRunReading {
  if (ratio === null || draws.length < STYLE_BOOTSTRAP_RESAMPLES * 0.8) {
    return {
      ratio,
      low: null,
      high: null,
      confidence: null,
      tier: ratio === null ? 'unknown' : 'even',
      direction: ratio === null ? null : ratio >= 1 ? 'high' : 'low',
    };
  }
  const sorted = [...draws].sort((left, right) => left - right);
  const low = 2 ** percentile(sorted, 0.025);
  const high = 2 ** percentile(sorted, 0.975);
  const confidence =
    sorted.filter((draw) => (ratio >= 1 ? draw > 0 : draw < 0)).length / sorted.length;
  const notable = ratio >= LONG_RUN_NOTABLE_RATIO || ratio <= 1 / LONG_RUN_NOTABLE_RATIO;
  const direction = ratio >= 1 ? 'high' : 'low';
  const tier: StyleTier = !notable
    ? 'even'
    : low > 1 || high < 1
      ? 'stable'
      : confidence >= STYLE_LEAN_CONFIDENCE
        ? 'lean'
        : 'even';
  return { ratio, low, high, confidence, tier, direction };
}

function ratios(
  rows: readonly Row[],
  indexes: readonly number[],
  accountId: string,
): Record<LongRunMetric, number | null> {
  const result = {} as Record<LongRunMetric, number | null>;
  for (const metric of METRICS) {
    let own = 0;
    let expected = 0;
    for (const index of indexes) {
      const row = rows[index]!;
      const entry = row.players.find((player) => player.accountId === accountId);
      if (!entry || row.players.length < 2 || row.totals[metric.key] <= 0) continue;
      own += entry.values[metric.key];
      expected += row.totals[metric.key] / row.players.length;
    }
    result[metric.key] = expected > 0 && own > 0 ? own / expected : null;
  }
  return result;
}

function compositeLog(values: Record<LongRunMetric, number | null>): number | null {
  const logs = COMPOSITE.map((key) => values[key])
    .filter((value): value is number => value !== null && value > 0)
    .map((value) => Math.log2(value));
  return logs.length >= 2 ? logs.reduce((sum, value) => sum + value, 0) / logs.length : null;
}

/**
 * How much more (or less) than a fair share of each match's damage, kills and knocks every member takes, across all
 * matches from the Match Store. Only the squad is compared, so the lobby's strength cancels out; the interval comes
 * from seeded bootstrap resampling of matches.
 */
export function buildLongRunCombat(input: {
  matches: readonly NormalizedMatch[];
  memberIds: readonly string[];
}): LongRunCombat {
  const members = new Set(input.memberIds);
  const names = new Map<string, string>();
  const rows: Row[] = [];
  for (const match of [...input.matches].sort((left, right) => left.timestamp - right.timestamp)) {
    const players = match.players.filter((player) => members.has(player.accountId));
    if (players.length < 2) continue;
    for (const player of players)
      names.set(player.accountId, player.displayName || player.playerName);
    rows.push({
      players: players.map((player) => ({
        accountId: player.accountId,
        values: Object.fromEntries(
          METRICS.map((metric) => [metric.key, metric.pick(player)]),
        ) as Record<LongRunMetric, number>,
      })),
      totals: Object.fromEntries(
        METRICS.map((metric) => [
          metric.key,
          players.reduce((sum, player) => sum + metric.pick(player), 0),
        ]),
      ) as Record<LongRunMetric, number>,
    });
  }
  const accountIds = [...names.keys()];
  const all = rows.map((_, index) => index);
  const rng = mulberry32(STYLE_BOOTSTRAP_SEED + 7);
  const draws = new Map<string, Record<LongRunMetric | 'composite', number[]>>(
    accountIds.map((id) => [id, { damage: [], kills: [], knocks: [], assists: [], composite: [] }]),
  );
  if (rows.length >= LONG_RUN_MIN_MATCHES) {
    for (let round = 0; round < STYLE_BOOTSTRAP_RESAMPLES; round += 1) {
      const draw = Array.from({ length: rows.length }, () => Math.floor(rng() * rows.length));
      for (const id of accountIds) {
        const values = ratios(rows, draw, id);
        for (const metric of METRICS)
          if (values[metric.key] !== null && values[metric.key]! > 0)
            draws.get(id)![metric.key].push(Math.log2(values[metric.key]!));
        const combined = compositeLog(values);
        if (combined !== null) draws.get(id)!.composite.push(combined);
      }
    }
  }
  const entries: LongRunEntry[] = accountIds
    .map((accountId) => {
      const values = ratios(rows, all, accountId);
      const combined = compositeLog(values);
      return {
        accountId,
        name: names.get(accountId) ?? '未知',
        matches: rows.filter((row) => row.players.some((player) => player.accountId === accountId))
          .length,
        rank: 0,
        composite: gradeReading(
          combined === null ? null : 2 ** combined,
          draws.get(accountId)!.composite,
        ),
        metrics: METRICS.map((metric) => ({
          key: metric.key,
          label: metric.label,
          ...gradeReading(values[metric.key], draws.get(accountId)![metric.key]),
        })),
      };
    })
    .sort(
      (left, right) =>
        (right.composite.ratio ?? -Infinity) - (left.composite.ratio ?? -Infinity) ||
        left.name.localeCompare(right.name),
    );
  entries.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  const leader = entries[0];
  const verdict =
    !leader || leader.composite.ratio === null || rows.length < LONG_RUN_MIN_MATCHES
      ? `有效对局不足 ${LONG_RUN_MIN_MATCHES} 场，暂不比较。`
      : (leader.composite.tier === 'stable' || leader.composite.tier === 'lean') &&
          leader.composite.ratio > 1
        ? `按 ${rows.length} 场战绩，${leader.name} 拿到的伤害、击杀、击倒明显多于公平份额（×${leader.composite.ratio.toFixed(2)}，${leader.composite.tier === 'stable' ? '稳定' : `领先把握约 ${((leader.composite.confidence ?? 0) * 100).toFixed(0)}%`}）。`
        : `按 ${rows.length} 场战绩，四人的伤害、击杀、击倒份额都在公平份额附近，没有人稳定地多拿。`;
  return {
    schemaVersion: LONG_RUN_SCHEMA_VERSION,
    matches: rows.length,
    entries,
    verdict,
    notes: [
      '比值 = 个人在每场的伤害（击杀、击倒、助攻）合计 ÷ 该场按在场人数平均分配的份额合计，×1.00 即公平份额；只比队友，所以对局强弱互相抵消。',
      '综合 = 伤害、击杀、击倒三项比值的几何平均；区间由按场次重抽样得到，稳定 = 区间不含 1 且偏离 ≥10%。',
    ],
  };
}
