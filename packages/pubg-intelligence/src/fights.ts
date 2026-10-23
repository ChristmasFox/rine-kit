import {
  newcombeDifference,
  wilsonInterval,
  type DifferenceEstimate,
  type RateEstimate,
} from './analytics.js';
import { battlePlayerRef, type BattleReconstructionResult } from './battle.js';
import { deathStageOf, type DeathStage } from './combat-quality.js';

export const FIGHTS_SCHEMA_VERSION = 1 as const;
export const FIGHT_MIN_GROUP = 12;

export type FightOutcome = 'win' | 'lose' | 'draw';
export type FightInitiator = 'us' | 'them' | 'unknown';

export interface FightRecord {
  outcome: FightOutcome;
  initiator: FightInitiator;
  stage: DeathStage;
  thirdParty: boolean;
  /** Teams observed in the battle group, ours included. */
  teams: number;
  durationSeconds: number;
}

export interface RoleCounts {
  fights: number;
  /** Fights where this member dealt the first effective damage to an opponent. */
  initiations: number;
  firstKnocks: number;
  firstDowned: number;
  knocksDealt: number;
  timesDowned: number;
  kills: number;
  revives: number;
  /** Fights in which this member knocked at least one opponent. */
  fightsWithKnock: number;
  /** Knocks dealt by this member, and how many of those victims were finished off by the squad. */
  chainsDealt: number;
  chainsFinished: number;
}

export interface FightMatchStats {
  fights: FightRecord[];
  roles: Record<string, RoleCounts>;
}

export function emptyRoleCounts(): RoleCounts {
  return emptyRole();
}

function emptyRole(): RoleCounts {
  return {
    fights: 0,
    initiations: 0,
    firstKnocks: 0,
    firstDowned: 0,
    knocksDealt: 0,
    timesDowned: 0,
    kills: 0,
    revives: 0,
    fightsWithKnock: 0,
    chainsDealt: 0,
    chainsFinished: 0,
  };
}

/**
 * Win/lose is decided by unique victims on the observed timeline: a fight is won when more opponents than
 * squad members were knocked or killed. Fights with no knock at all are not scored.
 */
export function analyzeFights(
  result: BattleReconstructionResult,
  matchId: string,
  trackedAccountIds: readonly string[],
): FightMatchStats {
  const stats: FightMatchStats = { fights: [], roles: {} };
  const accountByRef = new Map(
    trackedAccountIds.map((accountId) => [battlePlayerRef(matchId, accountId), accountId]),
  );
  const trackedTeams = new Set<string>();
  for (const episode of result.episodes) {
    for (const team of episode.teams)
      if (team.tracked && team.teamRef) trackedTeams.add(team.teamRef);
  }
  if (!trackedTeams.size) return stats;
  const mine = (ref: string | null) => ref !== null && accountByRef.has(ref);
  const role = (ref: string): RoleCounts => (stats.roles[accountByRef.get(ref)!] ??= emptyRole());

  const samples = result.circleSamples
    .filter(
      (sample) =>
        sample.phase === 'in_match' && sample.timeSeconds !== null && sample.aliveTeams !== null,
    )
    .sort((left, right) => left.timeSeconds! - right.timeSeconds!);
  const aliveTeamsAt = (time: number): number | null => {
    let found: number | null = null;
    for (const sample of samples) {
      if (sample.timeSeconds! > time) break;
      found = sample.aliveTeams;
    }
    return found;
  };

  for (const group of result.battles) {
    if (!group.teamRefs.some((ref) => trackedTeams.has(ref))) continue;
    const events = [...group.timeline].sort((left, right) => left.timeSeconds - right.timeSeconds);
    const won = new Set<string>();
    const lost = new Set<string>();
    const involved = new Set<string>();
    let initiator: FightInitiator = 'unknown';
    let firstKnockSeen = false;
    const knockers = new Set<string>();
    for (const event of events) {
      const actorTracked = event.actorTeamRef !== null && trackedTeams.has(event.actorTeamRef);
      const victimTracked = event.victimTeamRef !== null && trackedTeams.has(event.victimTeamRef);
      if (mine(event.actorRef)) involved.add(event.actorRef!);
      if (mine(event.victimRef)) involved.add(event.victimRef!);
      if (
        initiator === 'unknown' &&
        event.type === 'DAMAGE' &&
        (event.damage ?? 0) > 0 &&
        actorTracked !== victimTracked
      ) {
        initiator = actorTracked ? 'us' : 'them';
        if (actorTracked && mine(event.actorRef)) role(event.actorRef!).initiations += 1;
      }
      if (event.type === 'KNOCK' || event.type === 'KILL') {
        if (event.victimRef && victimTracked && !actorTracked) lost.add(event.victimRef);
        else if (event.victimRef && actorTracked && !victimTracked) won.add(event.victimRef);
      }
      if (event.type === 'KNOCK') {
        if (!firstKnockSeen) {
          firstKnockSeen = true;
          if (mine(event.actorRef) && !victimTracked) role(event.actorRef!).firstKnocks += 1;
          if (mine(event.victimRef) && !actorTracked) role(event.victimRef!).firstDowned += 1;
        }
        if (mine(event.actorRef) && !victimTracked) {
          role(event.actorRef!).knocksDealt += 1;
          knockers.add(event.actorRef!);
        }
        if (mine(event.victimRef) && !actorTracked) role(event.victimRef!).timesDowned += 1;
      } else if (event.type === 'KILL' && mine(event.actorRef) && !victimTracked) {
        role(event.actorRef!).kills += 1;
      } else if (event.type === 'REVIVE' && mine(event.actorRef) && victimTracked) {
        role(event.actorRef!).revives += 1;
      }
    }
    for (const ref of involved) role(ref).fights += 1;
    for (const ref of knockers) role(ref).fightsWithKnock += 1;
    if (won.size + lost.size === 0) continue;
    const alive = aliveTeamsAt(group.startSeconds);
    stats.fights.push({
      outcome: won.size > lost.size ? 'win' : won.size < lost.size ? 'lose' : 'draw',
      initiator,
      stage: deathStageOf(alive),
      thirdParty: group.possibleThirdParty.length > 0,
      teams: group.teamRefs.length,
      durationSeconds: group.durationSeconds,
    });
  }
  const seenChains = new Set<string>();
  for (const episode of result.episodes) {
    for (const chain of episode.knockChains) {
      if (seenChains.has(chain.knockEventId)) continue;
      seenChains.add(chain.knockEventId);
      if (!mine(chain.attackerRef) || mine(chain.knockedPlayerRef)) continue;
      const entry = role(chain.attackerRef!);
      entry.chainsDealt += 1;
      if (chain.outcome === 'KILL') entry.chainsFinished += 1;
    }
  }
  return stats;
}

export interface FightBucket {
  key: string;
  label: string;
  fights: number;
  wins: number;
  losses: number;
  draws: number;
  /** Wins out of decided fights (draws excluded). */
  winRate: RateEstimate;
}

export interface FightSummary {
  schemaVersion: typeof FIGHTS_SCHEMA_VERSION;
  fights: number;
  overall: FightBucket;
  byInitiator: FightBucket[];
  byStage: FightBucket[];
  byThirdParty: FightBucket[];
  byDuration: FightBucket[];
  initiatorEdge: DifferenceEstimate;
  thirdPartyEdge: DifferenceEstimate;
  notes: string[];
}

function bucket(key: string, label: string, records: readonly FightRecord[]): FightBucket {
  const wins = records.filter((record) => record.outcome === 'win').length;
  const losses = records.filter((record) => record.outcome === 'lose').length;
  return {
    key,
    label,
    fights: records.length,
    wins,
    losses,
    draws: records.length - wins - losses,
    winRate: wilsonInterval(wins, wins + losses),
  };
}

export function summarizeFights(items: readonly FightRecord[]): FightSummary {
  const group = (key: string, label: string, predicate: (record: FightRecord) => boolean) =>
    bucket(key, label, items.filter(predicate));
  const us = group('us', '我方先手', (record) => record.initiator === 'us');
  const them = group('them', '对方先手', (record) => record.initiator === 'them');
  const withThird = group('third', '有第三方介入', (record) => record.thirdParty);
  const withoutThird = group('duel', '两队对战', (record) => !record.thirdParty);
  return {
    schemaVersion: FIGHTS_SCHEMA_VERSION,
    fights: items.length,
    overall: bucket('all', '全部交战', items),
    byInitiator: [
      us,
      them,
      group('unknown', '先手不明', (record) => record.initiator === 'unknown'),
    ],
    byStage: (['开局', '中期', '后期', '决赛圈', '未知'] as const).map((stage) =>
      group(stage, stage === '未知' ? '阶段未知' : stage, (record) => record.stage === stage),
    ),
    byThirdParty: [withThird, withoutThird],
    byDuration: [
      group('short', '短（<30 秒）', (record) => record.durationSeconds < 30),
      group(
        'medium',
        '中（30–90 秒）',
        (record) => record.durationSeconds >= 30 && record.durationSeconds < 90,
      ),
      group('long', '长（≥90 秒）', (record) => record.durationSeconds >= 90),
    ],
    initiatorEdge:
      us.wins + us.losses >= FIGHT_MIN_GROUP && them.wins + them.losses >= FIGHT_MIN_GROUP
        ? newcombeDifference(us.winRate, them.winRate)
        : newcombeDifference(wilsonInterval(0, 0), wilsonInterval(0, 0)),
    thirdPartyEdge:
      withThird.wins + withThird.losses >= FIGHT_MIN_GROUP &&
      withoutThird.wins + withoutThird.losses >= FIGHT_MIN_GROUP
        ? newcombeDifference(withThird.winRate, withoutThird.winRate)
        : newcombeDifference(wilsonInterval(0, 0), wilsonInterval(0, 0)),
    notes: [
      '胜负按时间线上唯一的被击倒或击杀人数判定：对手被打倒的人数多于我方即为胜，相等为平；没有任何倒地的交战不计入。',
      '先手 = 交战中第一次有效伤害的发起方（先手往往也意味着先发现、占位置，是相关性不是因果）；阶段 = 交战开始时场上剩余队伍数；第三方介入只是时间重叠候选，且「有第三方」等价于交战涉及 3 队及以上。',
    ],
  };
}

export interface RoleSummary {
  accountId: string;
  fights: number;
  firstKnocks: number;
  firstDowned: number;
  knocksDealt: number;
  timesDowned: number;
  kills: number;
  revives: number;
}

export interface RoleShare {
  accountId: string;
  name: string;
  fights: number;
  firstKnockShare: number | null;
  firstDownedShare: number | null;
  reviveShare: number | null;
  killShare: number | null;
  counts: RoleCounts;
  titles: string[];
}

export const ROLE_MIN_TOTAL = 15;
export const ROLE_TITLE_SHARE = 0.4;

export function summarizeRoles(
  items: readonly FightMatchStats[],
  names: ReadonlyMap<string, string>,
): RoleShare[] {
  const totals = new Map<string, RoleCounts>();
  for (const item of items) {
    for (const [accountId, counts] of Object.entries(item.roles)) {
      const current = totals.get(accountId) ?? emptyRole();
      (Object.keys(current) as Array<keyof RoleCounts>).forEach((key) => {
        current[key] += counts[key];
      });
      totals.set(accountId, current);
    }
  }
  const sum = (key: keyof RoleCounts) =>
    [...totals.values()].reduce((total, counts) => total + counts[key], 0);
  const totalFirst = sum('firstKnocks');
  const totalDowned = sum('firstDowned');
  const totalRevives = sum('revives');
  const totalKills = sum('kills');
  const share = (value: number, total: number) => (total > 0 ? value / total : null);
  return [...totals.entries()]
    .map(([accountId, counts]) => {
      const firstKnockShare = share(counts.firstKnocks, totalFirst);
      const firstDownedShare = share(counts.firstDowned, totalDowned);
      const reviveShare = share(counts.revives, totalRevives);
      const killShare = share(counts.kills, totalKills);
      const titles: string[] = [];
      if (
        totalFirst >= ROLE_MIN_TOTAL &&
        firstKnockShare !== null &&
        firstKnockShare >= ROLE_TITLE_SHARE
      )
        titles.push('开团手');
      if (
        totalDowned >= ROLE_MIN_TOTAL &&
        firstDownedShare !== null &&
        firstDownedShare >= ROLE_TITLE_SHARE
      )
        titles.push('先锋盾（最常被先倒）');
      if (totalRevives >= ROLE_MIN_TOTAL && reviveShare !== null && reviveShare >= ROLE_TITLE_SHARE)
        titles.push('救援担当');
      if (totalKills >= ROLE_MIN_TOTAL && killShare !== null && killShare >= ROLE_TITLE_SHARE)
        titles.push('收割机');
      return {
        accountId,
        name: names.get(accountId) ?? '未知',
        fights: counts.fights,
        firstKnockShare,
        firstDownedShare,
        reviveShare,
        killShare,
        counts,
        titles,
      };
    })
    .sort((left, right) => right.fights - left.fights || left.name.localeCompare(right.name));
}
