import { createHash } from 'node:crypto';
import type { NormalizedMatch, NormalizedPlayer } from '@rine-kit/pubg-domain';

export const ANALYTICS_SCHEMA_VERSION = 1 as const;
export const ANALYTICS_RULE_VERSION = 'performance-analytics-v1' as const;
export const ANALYTICS_RECENT_WINDOW = 5;
export const ANALYTICS_MIN_SAMPLES = 8;
export const ANALYTICS_FORM_Z = 1.5;
export const ANALYTICS_EWMA_ALPHA = 0.3;
export const ANALYTICS_WEAPON_PRIOR_SHOTS = 30;
export const ANALYTICS_WEAPON_MIN_SHOTS = 20;

export type AnalyticsMetricKey = 'damage' | 'kills' | 'knocks' | 'revives' | 'survivalTime';
export type AnalyticsForm = 'hot' | 'steady' | 'cold' | 'insufficient';
export type AnalyticsTrend = 'up' | 'down' | 'flat' | 'insufficient';

export interface AnalyticsMetricSummary {
  key: AnalyticsMetricKey;
  label: string;
  samples: number;
  mean: number;
  median: number;
  /** Robust scale: 1.4826 * MAD, floored so a flat history cannot inflate z-scores. */
  scale: number;
  latest: number | null;
  ewma: number | null;
  recentMean: number | null;
  baselineMedian: number | null;
  /** Standardised distance of the recent window from the earlier baseline; null when history is short. */
  formZ: number | null;
  form: AnalyticsForm;
  /** Theil-Sen slope in metric units per match. */
  slope: number | null;
  trend: AnalyticsTrend;
  /** Fraction of all samples at or below the latest value, in 0..1. */
  latestPercentile: number | null;
}

export interface RateEstimate {
  successes: number;
  trials: number;
  rate: number | null;
  low: number | null;
  high: number | null;
}

export interface PlayerAnalytics {
  id: string;
  name: string;
  matches: number;
  metrics: AnalyticsMetricSummary[];
  /** Share of the squad's total damage across matches the player appeared in. */
  damageShare: number | null;
  killShare: number | null;
}

export interface SquadAnalytics {
  schemaVersion: typeof ANALYTICS_SCHEMA_VERSION;
  ruleVersion: typeof ANALYTICS_RULE_VERSION;
  matches: number;
  rankedMatches: number;
  win: RateEstimate;
  top10: RateEstimate;
  medianPlacement: number | null;
  placementTrend: AnalyticsTrend;
  placementSlope: number | null;
  players: PlayerAnalytics[];
  notes: string[];
}

export interface WeaponSample {
  playerId: string;
  weapon: string;
  shots: number;
  hits: number;
  damage: number;
  knocks: number;
  kills: number;
}

export interface WeaponEfficiency {
  weapon: string;
  shots: number;
  hits: number;
  damage: number;
  knocks: number;
  kills: number;
  rawHitRate: number | null;
  /** Hit rate shrunk toward the pooled rate; small samples stay near the baseline. */
  shrunkHitRate: number | null;
  damagePerHit: number | null;
  damagePerShot: number | null;
  /** Shrunk hit rate minus the pooled rate. */
  edge: number | null;
  reliable: boolean;
}

const METRICS: ReadonlyArray<{
  key: AnalyticsMetricKey;
  label: string;
  pick: (player: NormalizedPlayer) => number;
  floor: number;
}> = [
  { key: 'damage', label: '伤害', pick: (player) => player.damage, floor: 20 },
  { key: 'kills', label: '击杀', pick: (player) => player.kills, floor: 0.5 },
  { key: 'knocks', label: '倒地', pick: (player) => player.dbnos, floor: 0.5 },
  { key: 'revives', label: '救援', pick: (player) => player.revives, floor: 0.3 },
  { key: 'survivalTime', label: '生存时长', pick: (player) => player.survivalTime, floor: 60 },
];

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Theil-Sen estimator over evenly spaced samples; robust to a single outlier match. */
export function theilSenSlope(values: readonly number[]): number | null {
  if (values.length < 3) return null;
  const slopes: number[] = [];
  for (let left = 0; left < values.length - 1; left += 1) {
    for (let right = left + 1; right < values.length; right += 1)
      slopes.push((values[right]! - values[left]!) / (right - left));
  }
  return median(slopes);
}

/** Wilson score interval; stays inside 0..1 and is usable for the small samples a squad produces. */
export function wilsonInterval(successes: number, trials: number, z = 1.96): RateEstimate {
  if (
    !Number.isFinite(successes) ||
    !Number.isFinite(trials) ||
    trials <= 0 ||
    successes < 0 ||
    successes > trials
  ) {
    return { successes: 0, trials: 0, rate: null, low: null, high: null };
  }
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return {
    successes,
    trials,
    rate: p,
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
  };
}

function robustScale(values: readonly number[], centre: number, floor: number): number {
  const mad = median(values.map((value) => Math.abs(value - centre))) ?? 0;
  return Math.max(1.4826 * mad, floor, Math.abs(centre) * 0.1);
}

export function summarizeSeries(
  key: AnalyticsMetricKey,
  label: string,
  series: readonly number[],
  floor: number,
): AnalyticsMetricSummary {
  const samples = series.length;
  const centre = median(series) ?? 0;
  const scale = robustScale(series, centre, floor);
  const latest = samples ? series[samples - 1]! : null;
  let ewma: number | null = null;
  for (const value of series)
    ewma = ewma === null ? value : ANALYTICS_EWMA_ALPHA * value + (1 - ANALYTICS_EWMA_ALPHA) * ewma;

  let recentMean: number | null = null;
  let baselineMedian: number | null = null;
  let formZ: number | null = null;
  let form: AnalyticsForm = 'insufficient';
  if (samples >= ANALYTICS_MIN_SAMPLES) {
    const recent = series.slice(-ANALYTICS_RECENT_WINDOW);
    const baseline = series.slice(0, -ANALYTICS_RECENT_WINDOW);
    recentMean = mean(recent);
    baselineMedian = median(baseline);
    const baselineScale = robustScale(baseline, baselineMedian ?? 0, floor);
    formZ = (recentMean - (baselineMedian ?? 0)) / (baselineScale / Math.sqrt(recent.length));
    form = formZ >= ANALYTICS_FORM_Z ? 'hot' : formZ <= -ANALYTICS_FORM_Z ? 'cold' : 'steady';
  }

  const slope = samples >= ANALYTICS_MIN_SAMPLES ? theilSenSlope(series) : null;
  const trend = trendOf(slope, samples, scale);
  const latestPercentile =
    latest === null ? null : series.filter((value) => value <= latest).length / samples;
  return {
    key,
    label,
    samples,
    mean: mean(series),
    median: centre,
    scale,
    latest,
    ewma,
    recentMean,
    baselineMedian,
    formZ,
    form,
    slope,
    trend,
    latestPercentile,
  };
}

function trendOf(slope: number | null, samples: number, scale: number): AnalyticsTrend {
  if (slope === null) return 'insufficient';
  const drift = slope * (samples - 1);
  if (Math.abs(drift) < scale * 0.5) return 'flat';
  return drift > 0 ? 'up' : 'down';
}

function placementOf(players: readonly NormalizedPlayer[]): number | null {
  const ranks = new Set(
    players
      .map((player) => player.rank)
      .filter((rank): rank is number => rank !== null && rank > 0),
  );
  return ranks.size === 1 ? [...ranks][0]! : null;
}

export interface BuildSquadAnalyticsInput {
  matches: readonly NormalizedMatch[];
  memberIds: readonly string[];
}

export function buildSquadAnalytics(input: BuildSquadAnalyticsInput): SquadAnalytics {
  const members = new Set(input.memberIds);
  const rows = [...input.matches]
    .filter((match) => Number.isFinite(match.timestamp))
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.matchId.localeCompare(right.matchId),
    )
    .flatMap((match) => {
      const players = match.players.filter((player) => members.has(player.accountId));
      return players.length ? [{ match, players, placement: placementOf(players) }] : [];
    });

  const ranked = rows.filter((row) => row.placement !== null);
  const placements = ranked.map((row) => row.placement!);
  const placementSlope = theilSenSlope(
    placements.length >= ANALYTICS_MIN_SAMPLES ? placements : [],
  );
  const placementScale = robustScale(placements, median(placements) ?? 0, 1);
  // A falling placement number is an improvement, so the trend direction is inverted for display.
  const rawTrend = trendOf(placementSlope, placements.length, placementScale);
  const placementTrend: AnalyticsTrend =
    rawTrend === 'up' ? 'down' : rawTrend === 'down' ? 'up' : rawTrend;

  const squadDamage = rows.reduce(
    (sum, row) => sum + row.players.reduce((value, player) => value + player.damage, 0),
    0,
  );
  const squadKills = rows.reduce(
    (sum, row) => sum + row.players.reduce((value, player) => value + player.kills, 0),
    0,
  );
  const byPlayer = new Map<
    string,
    Array<{ player: NormalizedPlayer; row: (typeof rows)[number] }>
  >();
  for (const row of rows) {
    for (const player of row.players)
      byPlayer.set(player.accountId, [...(byPlayer.get(player.accountId) ?? []), { player, row }]);
  }

  const players: PlayerAnalytics[] = [...byPlayer.entries()]
    .map(([accountId, entries]) => {
      const latest = entries.at(-1)!.player;
      const damage = entries.reduce((sum, entry) => sum + entry.player.damage, 0);
      const kills = entries.reduce((sum, entry) => sum + entry.player.kills, 0);
      return {
        id: createHash('sha256').update(accountId).digest('hex').slice(0, 12),
        name: latest.displayName || latest.playerName,
        matches: entries.length,
        metrics: METRICS.map((metric) =>
          summarizeSeries(
            metric.key,
            metric.label,
            entries.map((entry) => metric.pick(entry.player)),
            metric.floor,
          ),
        ),
        damageShare: squadDamage > 0 ? damage / squadDamage : null,
        killShare: squadKills > 0 ? kills / squadKills : null,
      };
    })
    .sort(
      (left, right) =>
        (right.damageShare ?? 0) - (left.damageShare ?? 0) || left.name.localeCompare(right.name),
    );

  const notes: string[] = [];
  if (rows.length < ANALYTICS_MIN_SAMPLES)
    notes.push(`样本不足 ${ANALYTICS_MIN_SAMPLES} 场，状态与趋势暂不判断。`);
  if (ranked.length < rows.length)
    notes.push(`排名仅 ${ranked.length}/${rows.length} 场可用，胜率与名次统计只覆盖这些场次。`);
  if (players.some((player) => player.matches < rows.length))
    notes.push('部分队员没有出现在所有场次，占比按各自出场场次累计。');

  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    ruleVersion: ANALYTICS_RULE_VERSION,
    matches: rows.length,
    rankedMatches: ranked.length,
    win: wilsonInterval(ranked.filter((row) => row.placement === 1).length, ranked.length),
    top10: wilsonInterval(ranked.filter((row) => row.placement! <= 10).length, ranked.length),
    medianPlacement: median(placements),
    placementTrend,
    placementSlope,
    players,
    notes,
  };
}

const NON_FIREARM =
  /^(pickaxe|grenade|smokebomb|molotov|flashbang|stungun|sticky|decoy|juju|m79|ziplinegun|flaregun)/iu;

/**
 * Telemetry names the same gun differently across event types (`Item_Weapon_AUG_C` on attacks,
 * `WeapAUG_C` on damage, `ZU_Item_Weapon_AUG` for event variants), so shots and hits only meet
 * after the prefixes are stripped. Returns null for melee and throwables.
 */
export function normalizeWeaponName(weapon: string): string | null {
  const name = weapon
    .replace(/^ZU_Item_Weapon_/iu, '')
    .replace(/^Item_Weapon_/iu, '')
    .replace(/^Weap(?=[A-Z0-9]|vz)/u, '')
    .replace(/_(C|Reward)$/iu, '')
    .replace(/_Reward$/iu, '')
    .replace(/_Projectile$/iu, '');
  if (/^PanzerFaust/iu.test(name)) return 'PanzerFaust';
  return !name || NON_FIREARM.test(name) ? null : name;
}

/** Pools samples by weapon and shrinks each hit rate toward the all-weapon rate. */
export function buildWeaponEfficiency(samples: readonly WeaponSample[]): WeaponEfficiency[] {
  const byWeapon = new Map<string, WeaponSample>();
  for (const raw of samples) {
    const weapon = normalizeWeaponName(raw.weapon);
    if (!weapon) continue;
    const sample = { ...raw, weapon };
    if (!(sample.shots >= 0) || !(sample.hits >= 0)) continue;
    const current = byWeapon.get(sample.weapon) ?? {
      playerId: '',
      weapon: sample.weapon,
      shots: 0,
      hits: 0,
      damage: 0,
      knocks: 0,
      kills: 0,
    };
    current.shots += sample.shots;
    current.hits += sample.hits;
    current.damage += sample.damage;
    current.knocks += sample.knocks;
    current.kills += sample.kills;
    byWeapon.set(sample.weapon, current);
  }
  for (const [name, item] of byWeapon) if (item.hits > item.shots) byWeapon.delete(name);
  const totalShots = [...byWeapon.values()].reduce((sum, item) => sum + item.shots, 0);
  const totalHits = [...byWeapon.values()].reduce((sum, item) => sum + item.hits, 0);
  const pooled = totalShots > 0 ? totalHits / totalShots : null;
  return [...byWeapon.values()]
    .map((item) => {
      const shrunk =
        pooled === null
          ? null
          : (item.hits + ANALYTICS_WEAPON_PRIOR_SHOTS * pooled) /
            (item.shots + ANALYTICS_WEAPON_PRIOR_SHOTS);
      return {
        weapon: item.weapon,
        shots: item.shots,
        hits: item.hits,
        damage: item.damage,
        knocks: item.knocks,
        kills: item.kills,
        rawHitRate: item.shots > 0 ? item.hits / item.shots : null,
        shrunkHitRate: shrunk,
        damagePerHit: item.hits > 0 ? item.damage / item.hits : null,
        damagePerShot: item.shots > 0 ? item.damage / item.shots : null,
        edge: shrunk !== null && pooled !== null ? shrunk - pooled : null,
        reliable: item.shots >= ANALYTICS_WEAPON_MIN_SHOTS,
      };
    })
    .sort((left, right) => right.shots - left.shots || left.weapon.localeCompare(right.weapon));
}

/** Display names and playable-area edge (km) for PUBG internal map identifiers; unknown maps keep their raw name. */
const MAP_INFO: Readonly<Record<string, { name: string; sizeKm: number }>> = {
  Baltic_Main: { name: '艾伦格', sizeKm: 8 },
  Desert_Main: { name: '米拉玛', sizeKm: 8 },
  Tiger_Main: { name: '泰戈', sizeKm: 8 },
  Neon_Main: { name: '荣都', sizeKm: 8 },
  Kiki_Main: { name: '帝斯顿', sizeKm: 8 },
  Savage_Main: { name: '萨诺', sizeKm: 4 },
  DihorOtok_Main: { name: '维寒迪', sizeKm: 6 },
  Chimera_Main: { name: '帕拉莫', sizeKm: 3 },
  Summerland_Main: { name: '卡拉金', sizeKm: 2 },
  Heaven_Main: { name: '哈文', sizeKm: 1 },
};

export function mapDisplayName(mapName: string): string {
  return MAP_INFO[mapName]?.name ?? (mapName.replace(/_Main$/u, '') || '未知地图');
}

export function mapSizeKm(mapName: string): number | null {
  return MAP_INFO[mapName]?.sizeKm ?? null;
}

export const MAP_INDEX_MIN_MATCHES = 5;

export interface MapAnalytics {
  mapName: string;
  label: string;
  matches: number;
  rankedMatches: number;
  win: RateEstimate;
  top10: RateEstimate;
  medianPlacement: number | null;
  averageDamage: number;
  averageKills: number;
  averageSurvivalTime: number;
  /** Per-player average damage relative to the same players' average on every map; 1 means no map effect. */
  damageIndex: number | null;
}

export function buildMapAnalytics(input: BuildSquadAnalyticsInput): MapAnalytics[] {
  const members = new Set(input.memberIds);
  const rows = input.matches.flatMap((match) => {
    const players = match.players.filter((player) => members.has(player.accountId));
    return players.length ? [{ match, players, placement: placementOf(players) }] : [];
  });
  const allPlayers = rows.flatMap((row) => row.players);
  const overallDamage = allPlayers.length ? mean(allPlayers.map((player) => player.damage)) : 0;
  const byMap = new Map<string, typeof rows>();
  for (const row of rows)
    byMap.set(row.match.mapName || '未知地图', [
      ...(byMap.get(row.match.mapName || '未知地图') ?? []),
      row,
    ]);
  return [...byMap.entries()]
    .map(([mapName, items]) => {
      const players = items.flatMap((item) => item.players);
      const ranked = items.filter((item) => item.placement !== null);
      const averageDamage = mean(players.map((player) => player.damage));
      return {
        mapName,
        label: mapDisplayName(mapName),
        matches: items.length,
        rankedMatches: ranked.length,
        win: wilsonInterval(ranked.filter((item) => item.placement === 1).length, ranked.length),
        top10: wilsonInterval(ranked.filter((item) => item.placement! <= 10).length, ranked.length),
        medianPlacement: median(ranked.map((item) => item.placement!)),
        averageDamage,
        averageKills: mean(players.map((player) => player.kills)),
        averageSurvivalTime: mean(players.map((player) => player.survivalTime)),
        damageIndex:
          overallDamage > 0 && items.length >= MAP_INDEX_MIN_MATCHES
            ? averageDamage / overallDamage
            : null,
      };
    })
    .sort(
      (left, right) => right.matches - left.matches || left.mapName.localeCompare(right.mapName),
    );
}

/** Groups raw `gameMode` values (`squad`, `squad-fpp`, ...) so rates are only compared within one team size. */
export type ModeGroup = 'squad' | 'duo' | 'solo' | 'other';
export const MODE_GROUPS: readonly ModeGroup[] = ['squad', 'duo', 'solo', 'other'];

export function modeGroupOf(gameMode: string): ModeGroup {
  const mode = gameMode.toLowerCase();
  if (mode === 'squad' || mode === 'squad-fpp') return 'squad';
  if (mode === 'duo' || mode === 'duo-fpp') return 'duo';
  if (mode === 'solo' || mode === 'solo-fpp') return 'solo';
  return 'other';
}

export const SERIES_MAX_POINTS = 150;

export interface MatchSeriesPoint {
  matchId: string;
  timestamp: number;
  mapLabel: string;
  placement: number | null;
  /** Average damage per tracked player in the match. */
  damage: number;
  kills: number;
}

export function buildMatchSeries(input: BuildSquadAnalyticsInput): MatchSeriesPoint[] {
  const members = new Set(input.memberIds);
  return [...input.matches]
    .filter((match) => Number.isFinite(match.timestamp))
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.matchId.localeCompare(right.matchId),
    )
    .flatMap((match) => {
      const players = match.players.filter((player) => members.has(player.accountId));
      if (!players.length) return [];
      return [
        {
          matchId: match.matchId,
          timestamp: match.timestamp,
          mapLabel: mapDisplayName(match.mapName || '未知地图'),
          placement: placementOf(players),
          damage: mean(players.map((player) => player.damage)),
          kills: players.reduce((sum, player) => sum + player.kills, 0),
        },
      ];
    })
    .slice(-SERIES_MAX_POINTS);
}

export interface DifferenceEstimate {
  delta: number | null;
  low: number | null;
  high: number | null;
  /** True when the 95% interval of the difference excludes zero. */
  significant: boolean;
}

/** Newcombe hybrid-score interval for the difference of two proportions (a minus b). */
export function newcombeDifference(a: RateEstimate, b: RateEstimate): DifferenceEstimate {
  if (
    a.rate === null ||
    b.rate === null ||
    a.low === null ||
    a.high === null ||
    b.low === null ||
    b.high === null
  ) {
    return { delta: null, low: null, high: null, significant: false };
  }
  const delta = a.rate - b.rate;
  const low = delta - Math.sqrt((a.rate - a.low) ** 2 + (b.high - b.rate) ** 2);
  const high = delta + Math.sqrt((a.high - a.rate) ** 2 + (b.rate - b.low) ** 2);
  return { delta, low, high, significant: low > 0 || high < 0 };
}

export const LINEUP_MIN_MATCHES = 5;

export interface LineupStats {
  names: string[];
  size: number;
  matches: number;
  rankedMatches: number;
  top10: RateEstimate;
  win: RateEstimate;
  medianPlacement: number | null;
  averageDamage: number;
}

export interface MemberImpact {
  id: string;
  name: string;
  withMatches: number;
  withoutMatches: number;
  withTop10: RateEstimate;
  withoutTop10: RateEstimate;
  difference: DifferenceEstimate;
  withDamage: number | null;
  withoutDamage: number | null;
}

export interface LineupAnalytics {
  lineups: LineupStats[];
  members: MemberImpact[];
  notes: string[];
}

export function buildLineupAnalytics(input: BuildSquadAnalyticsInput): LineupAnalytics {
  const members = new Set(input.memberIds);
  const rows = input.matches.flatMap((match) => {
    const players = match.players.filter((player) => members.has(player.accountId));
    return players.length ? [{ match, players, placement: placementOf(players) }] : [];
  });
  const nameOf = new Map<string, string>();
  for (const row of [...rows].sort((left, right) => left.match.timestamp - right.match.timestamp)) {
    for (const player of row.players)
      nameOf.set(player.accountId, player.displayName || player.playerName);
  }

  const summarize = (items: typeof rows) => {
    const ranked = items.filter((item) => item.placement !== null);
    return {
      matches: items.length,
      rankedMatches: ranked.length,
      top10: wilsonInterval(ranked.filter((item) => item.placement! <= 10).length, ranked.length),
      win: wilsonInterval(ranked.filter((item) => item.placement === 1).length, ranked.length),
      medianPlacement: median(ranked.map((item) => item.placement!)),
      averageDamage: items.length
        ? mean(items.flatMap((item) => item.players.map((player) => player.damage)))
        : 0,
    };
  };

  const byLineup = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.players
      .map((player) => player.accountId)
      .sort()
      .join('\u001f');
    byLineup.set(key, [...(byLineup.get(key) ?? []), row]);
  }
  const lineups: LineupStats[] = [...byLineup.entries()]
    .filter(([, items]) => items.length >= LINEUP_MIN_MATCHES)
    .map(([key, items]) => {
      const ids = key.split('\u001f');
      return {
        names: ids.map((id) => nameOf.get(id) ?? '未知').sort(),
        size: ids.length,
        ...summarize(items),
      };
    })
    .sort(
      (left, right) =>
        right.matches - left.matches ||
        right.size - left.size ||
        left.names.join().localeCompare(right.names.join()),
    );

  const impacts: MemberImpact[] = [...nameOf.entries()]
    .map(([accountId, name]) => {
      const withRows = rows.filter((row) =>
        row.players.some((player) => player.accountId === accountId),
      );
      const withoutRows = rows.filter(
        (row) => !row.players.some((player) => player.accountId === accountId),
      );
      const withStats = summarize(withRows);
      const withoutStats = summarize(withoutRows);
      return {
        id: createHash('sha256').update(accountId).digest('hex').slice(0, 12),
        name,
        withMatches: withRows.length,
        withoutMatches: withoutRows.length,
        withTop10: withStats.top10,
        withoutTop10: withoutStats.top10,
        difference: newcombeDifference(withStats.top10, withoutStats.top10),
        withDamage: withRows.length ? withStats.averageDamage : null,
        withoutDamage: withoutRows.length ? withoutStats.averageDamage : null,
      };
    })
    .sort(
      (left, right) => right.withMatches - left.withMatches || left.name.localeCompare(right.name),
    );

  return {
    lineups,
    members: impacts,
    notes: [
      `阵容只列出至少 ${LINEUP_MIN_MATCHES} 场的组合。「在场 vs 缺席」比较的是前十率差，区间不跨 0 才标为显著。`,
      '在场与缺席的对局由不同时间、地图和队友组成，这是相关性，不能直接说明某人的贡献。',
    ],
  };
}
