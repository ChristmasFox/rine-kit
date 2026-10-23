import {
  newcombeDifference,
  type LineupAnalytics,
  type MapAnalytics,
  type MatchSeriesPoint,
  type RateEstimate,
  type SquadAnalytics,
  wilsonInterval,
  median,
} from './analytics.js';
import type { CombatQualitySummary, DeathSummary } from './combat-quality.js';
import type { LandingPreference } from './landing.js';
import {
  DISTANCE_GAP_POINTS,
  ZONE_MIN_SAMPLES,
  type DistanceSummary,
  type ZoneSummary,
} from './field.js';
import { FIGHT_MIN_GROUP, type FightSummary, type RoleShare } from './fights.js';

export const INSIGHT_RULE_VERSION = 'highlight-rules-v1' as const;
export const INSIGHT_MAX = 6;
export const INSIGHT_MAP_MIN_MATCHES = 15;
export const INSIGHT_REVIVE_MIN_KNOCKS = 15;
export const INSIGHT_DEATH_MIN = 30;
export const INSIGHT_RECENT_MATCHES = 20;

export type InsightTone = 'good' | 'warn' | 'info';

export interface Insight {
  id: string;
  tone: InsightTone;
  title: string;
  detail: string;
  /** Short sample/interval statement so every claim carries its own uncertainty. */
  evidence: string;
}

const pct = (value: number | null, digits = 0): string =>
  value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
const interval = (rate: RateEstimate): string =>
  rate.low === null || rate.high === null
    ? '区间不足'
    : `95% 区间 ${pct(rate.low)}–${pct(rate.high)}`;

/** Orders warnings first, then good news, then context, and keeps the list short enough to read. */
export function rankInsights(insights: Insight[], max: number = INSIGHT_MAX): Insight[] {
  const weight: Record<InsightTone, number> = { warn: 0, good: 1, info: 2 };
  return insights
    .sort(
      (left, right) => weight[left.tone] - weight[right.tone] || left.id.localeCompare(right.id),
    )
    .slice(0, max);
}

export interface PerformanceInsightInput {
  squad: SquadAnalytics;
  maps: readonly MapAnalytics[];
  lineups: LineupAnalytics;
  series: readonly MatchSeriesPoint[];
}

export function buildPerformanceInsights(input: PerformanceInsightInput): Insight[] {
  const insights: Insight[] = [];

  for (const member of input.lineups.members) {
    if (
      member.withMatches < 5 ||
      member.withoutMatches < 5 ||
      !member.difference.significant ||
      member.difference.delta === null
    )
      continue;
    const delta = member.difference.delta;
    insights.push({
      id: `member-${member.id}`,
      tone: delta > 0 ? 'good' : 'warn',
      title: `${member.name} ${delta > 0 ? '在场时前十率明显更高' : '在场时前十率明显更低'}`,
      detail: `在场 ${pct(member.withTop10.rate)}（${member.withMatches} 场）对比缺席 ${pct(member.withoutTop10.rate)}（${member.withoutMatches} 场），差 ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(0)} 个百分点。这是相关性，不等于个人贡献。`,
      evidence: `差值 95% 区间 ${(member.difference.low! * 100).toFixed(0)} 到 ${(member.difference.high! * 100).toFixed(0)}pt`,
    });
  }

  const rankedMaps = input.maps.filter((map) => map.rankedMatches >= INSIGHT_MAP_MIN_MATCHES);
  const totalTrials = input.maps.reduce((sum, map) => sum + map.top10.trials, 0);
  const totalSuccess = input.maps.reduce((sum, map) => sum + map.top10.successes, 0);
  for (const map of rankedMaps) {
    const rest = wilsonInterval(totalSuccess - map.top10.successes, totalTrials - map.top10.trials);
    const difference = newcombeDifference(map.top10, rest);
    if (!difference.significant || difference.delta === null) continue;
    insights.push({
      id: `map-${map.mapName}`,
      tone: difference.delta > 0 ? 'good' : 'warn',
      title: `${map.label}前十率${difference.delta > 0 ? '明显高于' : '明显低于'}其他地图`,
      detail: `${map.label} ${pct(map.top10.rate)}（${map.rankedMatches} 场）对比其他地图 ${pct(rest.rate)}，中位名次 ${map.medianPlacement === null ? '未知' : `#${map.medianPlacement}`}。`,
      evidence: `差值 95% 区间 ${(difference.low! * 100).toFixed(0)} 到 ${(difference.high! * 100).toFixed(0)}pt`,
    });
  }

  for (const player of input.squad.players) {
    const damage = player.metrics.find((metric) => metric.key === 'damage');
    if (
      !damage ||
      damage.form === 'steady' ||
      damage.form === 'insufficient' ||
      damage.formZ === null
    )
      continue;
    insights.push({
      id: `form-${player.id}`,
      tone: damage.form === 'hot' ? 'good' : 'warn',
      title: `${player.name} 近 5 场伤害${damage.form === 'hot' ? '明显高于' : '明显低于'}自己的常态`,
      detail: `此前基线中位 ${Math.round(damage.baselineMedian ?? 0)}，近 5 场均值 ${Math.round(damage.recentMean ?? 0)}。`,
      evidence: `稳健 z = ${damage.formZ.toFixed(1)}（|z| ≥ 1.5 才标记）`,
    });
  }

  const recent = input.series.slice(-INSIGHT_RECENT_MATCHES);
  const before = input.series.slice(0, -INSIGHT_RECENT_MATCHES);
  const rate = (items: readonly MatchSeriesPoint[]) => {
    const ranked = items.filter((point) => point.placement !== null);
    return wilsonInterval(ranked.filter((point) => point.placement! <= 10).length, ranked.length);
  };
  if (recent.length >= INSIGHT_RECENT_MATCHES && before.length >= 30) {
    const recentRate = rate(recent);
    const beforeRate = rate(before);
    const difference = newcombeDifference(recentRate, beforeRate);
    if (difference.significant && difference.delta !== null) {
      insights.push({
        id: 'recent-top10',
        tone: difference.delta > 0 ? 'good' : 'warn',
        title: `近 ${INSIGHT_RECENT_MATCHES} 场前十率${difference.delta > 0 ? '明显回升' : '明显下滑'}`,
        detail: `近 ${INSIGHT_RECENT_MATCHES} 场 ${pct(recentRate.rate)} 对比此前 ${pct(beforeRate.rate)}。`,
        evidence: `差值 95% 区间 ${(difference.low! * 100).toFixed(0)} 到 ${(difference.high! * 100).toFixed(0)}pt`,
      });
    }
    const recentDamage = median(recent.map((point) => point.damage));
    const beforeDamage = median(before.map((point) => point.damage));
    if (
      recentDamage !== null &&
      beforeDamage !== null &&
      beforeDamage > 0 &&
      Math.abs(recentDamage / beforeDamage - 1) >= 0.3
    ) {
      const change = recentDamage / beforeDamage - 1;
      insights.push({
        id: 'recent-damage',
        tone: change > 0 ? 'good' : 'warn',
        title: `近 ${INSIGHT_RECENT_MATCHES} 场人均伤害中位数${change > 0 ? '上升' : '下降'} ${Math.abs(change * 100).toFixed(0)}%`,
        detail: `中位数 ${Math.round(recentDamage)} 对比此前 ${Math.round(beforeDamage)}（用中位数，避免个别爆发场次拉偏）。`,
        evidence: `${recent.length} 场对 ${before.length} 场；变化 ≥ 30% 才提示`,
      });
    }
  }
  return rankInsights(insights);
}

export interface CombatInsightInput {
  combat: CombatQualitySummary;
  deaths: DeathSummary;
  landing: LandingPreference;
}

export function buildCombatInsights(input: CombatInsightInput): Insight[] {
  const { combat, deaths, landing } = input;
  const insights: Insight[] = [];

  const revive = combat.revive;
  if (
    revive.knocked >= INSIGHT_REVIVE_MIN_KNOCKS &&
    revive.reviveRate.high !== null &&
    revive.reviveRate.high < 0.4
  ) {
    const finish = combat.finish.finishRate.rate;
    insights.push({
      id: 'revive-weak',
      tone: 'warn',
      title: `队员倒地后只有 ${pct(revive.reviveRate.rate)} 被救起`,
      detail: `${revive.knocked} 次倒地中救起 ${revive.revived} 次、被补掉 ${revive.killed} 次${finish === null ? '' : `；对比我们补掉对手的 ${pct(finish)}，救援是明显短板`}。`,
      evidence: `${interval(revive.reviveRate)}，样本 ${revive.knocked} 次`,
    });
  }

  if (
    deaths.deaths >= INSIGHT_DEATH_MIN &&
    deaths.afterKnock.rate.low !== null &&
    deaths.afterKnock.rate.low > 0.5
  ) {
    insights.push({
      id: 'death-after-knock',
      tone: 'warn',
      title: `${pct(deaths.afterKnock.rate.rate)} 的淘汰发生在倒地之后`,
      detail: `${deaths.deaths} 次淘汰里有 ${deaths.afterKnock.count} 次是先倒地再被补掉。倒地后的封烟、拉人或爬走有机会改变结果。`,
      evidence: interval(deaths.afterKnock.rate),
    });
  }

  const first = combat.firstKnock;
  if (
    first.forUs + first.againstUs >= 20 &&
    first.ourRate.low !== null &&
    first.ourRate.high !== null
  ) {
    if (first.ourRate.low > 0.5) {
      insights.push({
        id: 'first-knock',
        tone: 'good',
        title: `首倒占比 ${pct(first.ourRate.rate)}，开战更常是我方先手`,
        detail: `${first.forUs + first.againstUs} 次有明确首倒的交战里我方先倒地对手 ${first.forUs} 次。`,
        evidence: interval(first.ourRate),
      });
    } else if (first.ourRate.high < 0.5) {
      insights.push({
        id: 'first-knock',
        tone: 'warn',
        title: `首倒占比只有 ${pct(first.ourRate.rate)}，开战更常被对手先手`,
        detail: `${first.forUs + first.againstUs} 次有明确首倒的交战里对手先倒地我方 ${first.againstUs} 次。`,
        evidence: interval(first.ourRate),
      });
    }
  }

  const lead = combat.leadConversion;
  if (lead.held + lead.lost >= 20 && lead.heldRate.rate !== null && lead.heldRate.rate < 0.8) {
    insights.push({
      id: 'lead-lost',
      tone: 'info',
      title: `先手优势有 ${pct(1 - lead.heldRate.rate)} 被追平或反超`,
      detail: `我方首倒后，${lead.lost} 次被对手把倒地数追平或反超（共 ${lead.held + lead.lost} 次）。`,
      evidence: interval(lead.heldRate),
    });
  }

  if (
    combat.groups >= 30 &&
    combat.thirdParty.againstRate.rate !== null &&
    combat.thirdParty.againstRate.rate >= 0.3
  ) {
    insights.push({
      id: 'third-party',
      tone: 'info',
      title: `${pct(combat.thirdParty.againstRate.rate)} 的交战出现第三方介入候选`,
      detail: `${combat.groups} 次交战里有 ${combat.thirdParty.againstUs} 次时间重叠的第三队接触；这只是候选，不代表对方意图。`,
      evidence: interval(combat.thirdParty.againstRate),
    });
  }

  const topStage = [...deaths.stages].sort((left, right) => right.deaths - left.deaths)[0];
  if (
    deaths.deaths >= INSIGHT_DEATH_MIN &&
    topStage &&
    topStage.stage !== '未知' &&
    topStage.share >= 0.5
  ) {
    insights.push({
      id: 'death-stage',
      tone: 'info',
      title: `${pct(topStage.share)} 的淘汰集中在${topStage.stage}`,
      detail: `${deaths.deaths} 次淘汰里 ${topStage.deaths} 次发生在${topStage.stage}阶段（按淘汰时剩余队伍数划分）。`,
      evidence: `样本 ${deaths.deaths} 次`,
    });
  }

  const map = landing.maps.find((item) => item.matchesWithLanding >= 6);
  if (map && map.topCellRepeatRate !== null && map.topCellRepeatRate >= 0.5) {
    insights.push({
      id: `landing-${map.mapName}`,
      tone: 'info',
      title: `${map.label}落点集中：${pct(map.topCellRepeatRate)} 的场次落在 ${map.cells[0]!.cell} 格`,
      detail: `${map.matchesWithLanding} 场有落点记录，队内成员落点距小队中心中位 ${map.medianSpreadMeters === null ? '未知' : `${Math.round(map.medianSpreadMeters)}m`}。`,
      evidence: `样本 ${map.matchesWithLanding} 场`,
    });
  }
  return rankInsights(insights);
}

export const FIELD_INSIGHT_MAX = 10;

export interface FieldInsightInput {
  fights: FightSummary;
  distance: DistanceSummary;
  zone: ZoneSummary;
  landing: LandingPreference;
  roles: readonly RoleShare[];
}

const points = (value: number): string => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(0)}pt`;

export function buildFieldInsights(input: FieldInsightInput): Insight[] {
  const { fights, distance, zone, landing, roles } = input;
  const insights: Insight[] = [];
  const decided = (bucket: { wins: number; losses: number }) => bucket.wins + bucket.losses;

  const initiative = fights.initiatorEdge;
  if (initiative.significant && initiative.delta !== null) {
    const us = fights.byInitiator[0]!;
    const them = fights.byInitiator[1]!;
    insights.push({
      id: 'fight-initiator',
      tone: initiative.delta > 0 ? 'good' : 'warn',
      title:
        initiative.delta > 0
          ? `先手开火的交战胜率明显更高：${pct(us.winRate.rate)} 对 ${pct(them.winRate.rate)}`
          : `先手开火反而更吃亏：${pct(us.winRate.rate)} 对 ${pct(them.winRate.rate)}`,
      detail: `我方先手 ${decided(us)} 场分出胜负，对方先手 ${decided(them)} 场；先手 = 交战中第一次有效伤害的发起方。`,
      evidence: `差 ${points(initiative.delta)}，区间 ${(initiative.low! * 100).toFixed(0)} 到 ${(initiative.high! * 100).toFixed(0)}pt`,
    });
  }
  const third = fights.thirdPartyEdge;
  if (third.significant && third.delta !== null) {
    const withThird = fights.byThirdParty[0]!;
    const duel = fights.byThirdParty[1]!;
    insights.push({
      id: 'fight-third-party',
      tone: third.delta > 0 ? 'good' : 'warn',
      title:
        third.delta < 0
          ? `有第三方介入时胜率降到 ${pct(withThird.winRate.rate)}（两队对战 ${pct(duel.winRate.rate)}）`
          : `有第三方介入时胜率反而更高 ${pct(withThird.winRate.rate)}`,
      detail: `${decided(withThird)} 场有第三方候选、${decided(duel)} 场两队对战。第三方只是时间重叠的候选。`,
      evidence: `差 ${points(third.delta)}，区间 ${(third.low! * 100).toFixed(0)} 到 ${(third.high! * 100).toFixed(0)}pt`,
    });
  }
  for (const stage of fights.byStage) {
    if (decided(stage) < FIGHT_MIN_GROUP || stage.key === '未知') continue;
    const restWins = fights.overall.wins - stage.wins;
    const restLosses = fights.overall.losses - stage.losses;
    if (restWins + restLosses < FIGHT_MIN_GROUP) continue;
    const difference = newcombeDifference(
      stage.winRate,
      wilsonInterval(restWins, restWins + restLosses),
    );
    if (!difference.significant || difference.delta === null) continue;
    insights.push({
      id: `fight-stage-${stage.key}`,
      tone: difference.delta > 0 ? 'good' : 'warn',
      title: `${stage.label}阶段的交战胜率${difference.delta > 0 ? '明显偏高' : '明显偏低'}：${pct(stage.winRate.rate)}`,
      detail: `该阶段 ${decided(stage)} 场分出胜负，其余阶段合计 ${pct(wilsonInterval(restWins, restWins + restLosses).rate)}。`,
      evidence: `差 ${points(difference.delta)}，区间 ${(difference.low! * 100).toFixed(0)} 到 ${(difference.high! * 100).toFixed(0)}pt`,
    });
  }

  if (distance.longRangeGap !== null && Math.abs(distance.longRangeGap) >= DISTANCE_GAP_POINTS) {
    const dealt = distance.bands.slice(2).reduce((sum, band) => sum + (band.dealtShare ?? 0), 0);
    const taken = distance.bands.slice(2).reduce((sum, band) => sum + (band.takenShare ?? 0), 0);
    insights.push({
      id: 'distance-gap',
      tone: distance.longRangeGap > 0 ? 'warn' : 'good',
      title:
        distance.longRangeGap > 0
          ? `承受的远距离伤害（≥75m）占 ${pct(taken)}，而我们打出的只占 ${pct(dealt)}`
          : `我们的远距离输出（≥75m）占 ${pct(dealt)}，高于承受的 ${pct(taken)}`,
      detail:
        distance.longRangeGap > 0
          ? '对手更常在远处消耗我们，这说明我们的交战距离偏近或缺少远程火力/掩体。'
          : '我们更常占据远距离优势，近距离被动挨打的比例较低。',
      evidence: `按枪械伤害统计，打出 ${Math.round(distance.totalDealt)}、承受 ${Math.round(distance.totalTaken)}；差值需 ≥ ${DISTANCE_GAP_POINTS * 100}pt`,
    });
  }

  const outside = [...zone.phases]
    .filter(
      (phase) =>
        phase.samples >= ZONE_MIN_SAMPLES &&
        phase.outsideRate.low !== null &&
        phase.outsideRate.low > 0.15,
    )
    .sort((left, right) => (right.outsideRate.rate ?? 0) - (left.outsideRate.rate ?? 0))[0];
  if (outside) {
    insights.push({
      id: `zone-outside-${outside.phase}`,
      tone: 'warn',
      title: `第 ${outside.phase} 圈有 ${pct(outside.outsideRate.rate)} 的时间在毒圈里`,
      detail: `该圈共 ${outside.samples} 个位置样本，毒圈伤害合计 ${Math.round(outside.blueDamage)}。转圈偏晚会白白损血并被迫在不利位置交战。`,
      evidence: interval(outside.outsideRate),
    });
  }
  const lateEdge = zone.phases.filter(
    (phase) =>
      phase.phase >= 6 &&
      phase.samples >= ZONE_MIN_SAMPLES &&
      phase.binShares &&
      phase.binShares[2] + phase.binShares[3] >= 0.6,
  )[0];
  if (lateEdge?.binShares) {
    insights.push({
      id: 'zone-late-edge',
      tone: 'info',
      title: `第 ${lateEdge.phase} 圈有 ${pct(lateEdge.binShares[2] + lateEdge.binShares[3])} 的时间贴着圈边或在圈外`,
      detail: '决赛圈靠边更容易被两面夹击、也更容易被压缩空间；靠近圈中心通常有更多回旋余地。',
      evidence: `样本 ${lateEdge.samples} 个位置点；圈边 = 距安全区中心 ≥ 85% 半径`,
    });
  }
  if (zone.blueDamageShare !== null && zone.blueDamageShare >= 0.15 && zone.matches >= 20) {
    insights.push({
      id: 'zone-blue-damage',
      tone: 'info',
      title: `毒圈伤害占全部承伤的 ${pct(zone.blueDamageShare)}`,
      detail: `${zone.matches} 场平均每场吃毒 ${Math.round(zone.blueDamagePerMatch ?? 0)} 点；这部分伤害本可以通过更早转圈或用载具避免。`,
      evidence: `样本 ${zone.matches} 场`,
    });
  }

  if (landing.contest.earlyWipeEdge.significant && (landing.contest.earlyWipeEdge.delta ?? 0) > 0) {
    const [calm, , crowded] = landing.contest.buckets;
    const top10 = landing.contest.top10Edge;
    insights.push({
      id: 'landing-contest',
      tone: 'warn',
      title: `落点附近有队伍争抢时，早崩率高出 ${points(landing.contest.earlyWipeEdge.delta!)}`,
      detail: `无争抢 ${calm!.matches} 场早崩 ${pct(calm!.earlyWipe.rate)}；有争抢的场次更高${crowded!.matches ? `（2 队及以上 ${crowded!.matches} 场 ${pct(crowded!.earlyWipe.rate)}）` : ''}。但前十率${top10.delta === null ? '样本不足' : top10.significant ? `也有差异（${points(top10.delta)}）` : `差异不显著（${points(top10.delta)}）`}：争抢带来的主要是开局的翻车风险，不一定拉低最终名次。早崩 = 全队最长生存不足 7 分钟，争抢 = 500m 内有其他队降落。`,
      evidence: `早崩差区间 ${(landing.contest.earlyWipeEdge.low! * 100).toFixed(0)} 到 ${(landing.contest.earlyWipeEdge.high! * 100).toFixed(0)}pt，共 ${landing.contest.matches} 场`,
    });
  }

  for (const player of roles) {
    for (const title of player.titles) {
      const share =
        title === '开团手'
          ? player.firstKnockShare
          : title.startsWith('先锋盾')
            ? player.firstDownedShare
            : title === '救援担当'
              ? player.reviveShare
              : player.killShare;
      insights.push({
        id: `role-${player.accountId}-${title}`,
        tone: 'info',
        title: `${player.name}：${title}（占 ${pct(share)}）`,
        detail:
          title === '开团手'
            ? '交战里第一个打倒对手的人最常是他。'
            : title.startsWith('先锋盾')
              ? '交战里第一个被打倒的人最常是他，说明他经常顶在最前面或被集火。'
              : title === '救援担当'
                ? '队内最多的救援来自他。'
                : '队内最多的人头由他收割。',
        evidence: `${player.fights} 次参与交战；占比 ≥ ${ROLE_TITLE_SHARE_TEXT} 才授予称号`,
      });
    }
  }
  return rankInsights(insights, FIELD_INSIGHT_MAX);
}

const ROLE_TITLE_SHARE_TEXT = '40%';
