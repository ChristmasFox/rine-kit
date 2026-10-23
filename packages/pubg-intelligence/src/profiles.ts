import { createHash } from 'node:crypto';
import type { MatchReviewFacts, NormalizedMatch } from '@rine-kit/pubg-domain';
import { median, wilsonInterval, type RateEstimate } from './analytics.js';
import type { Insight } from './insights.js';

export const PROFILE_RULE_VERSION = 'player-profile-v1' as const;
export const PROFILE_MIN_MATCHES = 10;
export const PROFILE_MIN_MINUTES = 60;
export const PROFILE_LOW_HEAL_RATIO = 0.5;
export const PROFILE_FRIENDLY_SHARE = 0.4;
export const PROFILE_FRIENDLY_MIN_DAMAGE = 300;

export interface PlayerProfile {
  id: string;
  name: string;
  /** Matches with telemetry features for this player. */
  matches: number;
  /** Minutes the player was alive across those matches. */
  minutesAlive: number;
  healPerMinute: number | null;
  boostPerMinute: number | null;
  armorBreaks: number;
  armorBreakConversion: RateEstimate;
  friendlyDamageDealt: number;
  friendlyDamageTaken: number;
  flashPerMatch: number | null;
  rideKmPerMatch: number | null;
  /** Healing items per minute alive relative to the median of the other members; null when not comparable. */
  healVsSquad: number | null;
}

export interface PlayerProfiles {
  ruleVersion: typeof PROFILE_RULE_VERSION;
  matches: number;
  players: PlayerProfile[];
  squadFriendlyDamage: number;
  notes: string[];
}

export interface BuildPlayerProfilesInput {
  matches: readonly NormalizedMatch[];
  memberIds: readonly string[];
  facts: ReadonlyMap<string, MatchReviewFacts>;
}

interface Accumulator {
  name: string;
  matches: number;
  minutes: number;
  heal: number;
  boost: number;
  breaks: number;
  breakFollowUps: number;
  friendlyDealt: number;
  friendlyTaken: number;
  flash: number;
  rideMeters: number;
}

export function buildPlayerProfiles(input: BuildPlayerProfilesInput): PlayerProfiles {
  const members = new Set(input.memberIds);
  const acc = new Map<string, Accumulator>();
  let analyzed = 0;
  const ordered = [...input.matches].sort((left, right) => left.timestamp - right.timestamp);
  for (const match of ordered) {
    const facts = input.facts.get(match.matchId);
    if (!facts) continue;
    analyzed += 1;
    for (const player of match.players) {
      if (!members.has(player.accountId)) continue;
      const entry = acc.get(player.accountId) ?? {
        name: '',
        matches: 0,
        minutes: 0,
        heal: 0,
        boost: 0,
        breaks: 0,
        breakFollowUps: 0,
        friendlyDealt: 0,
        friendlyTaken: 0,
        flash: 0,
        rideMeters: 0,
      };
      entry.name = player.displayName || player.playerName;
      entry.matches += 1;
      entry.minutes += Math.max(0, player.survivalTime) / 60;
      for (const recovery of facts.recovery ?? []) {
        if (recovery.playerId !== player.accountId) continue;
        entry.heal += recovery.bandages + recovery.firstAids + recovery.medKits;
        entry.boost += recovery.adrenaline + recovery.energyDrinks + recovery.painkillers;
      }
      for (const armor of facts.armorBreaks ?? []) {
        if (armor.actorPlayerId !== player.accountId) continue;
        entry.breaks += 1;
        if (armor.followUp !== null) entry.breakFollowUps += 1;
      }
      for (const damage of facts.teamDamage ?? []) {
        if (
          !members.has(damage.actorPlayerId) ||
          !damage.victimPlayerId ||
          !members.has(damage.victimPlayerId) ||
          damage.actorPlayerId === damage.victimPlayerId
        )
          continue;
        if (damage.actorPlayerId === player.accountId) entry.friendlyDealt += damage.damage;
        if (damage.victimPlayerId === player.accountId) entry.friendlyTaken += damage.damage;
      }
      for (const flash of facts.flash ?? [])
        if (flash.playerId === player.accountId) entry.flash += flash.uses;
      for (const vehicle of facts.vehicles)
        if (vehicle.playerId === player.accountId) entry.rideMeters += vehicle.rideDistance;
      acc.set(player.accountId, entry);
    }
  }

  const healRate = new Map<string, number | null>();
  for (const [id, entry] of acc)
    healRate.set(
      id,
      entry.minutes >= PROFILE_MIN_MINUTES ? (entry.heal + entry.boost) / entry.minutes : null,
    );

  const players: PlayerProfile[] = [...acc.entries()]
    .map(([accountId, entry]) => {
      const others = [...healRate.entries()]
        .filter(([id, rate]) => id !== accountId && rate !== null)
        .map(([, rate]) => rate!);
      const reference = median(others);
      const own = healRate.get(accountId) ?? null;
      return {
        id: createHash('sha256').update(accountId).digest('hex').slice(0, 12),
        name: entry.name,
        matches: entry.matches,
        minutesAlive: entry.minutes,
        healPerMinute: entry.minutes >= PROFILE_MIN_MINUTES ? entry.heal / entry.minutes : null,
        boostPerMinute: entry.minutes >= PROFILE_MIN_MINUTES ? entry.boost / entry.minutes : null,
        armorBreaks: entry.breaks,
        armorBreakConversion: wilsonInterval(entry.breakFollowUps, entry.breaks),
        friendlyDamageDealt: entry.friendlyDealt,
        friendlyDamageTaken: entry.friendlyTaken,
        flashPerMatch: entry.matches ? entry.flash / entry.matches : null,
        rideKmPerMatch: entry.matches ? entry.rideMeters / 1000 / entry.matches : null,
        healVsSquad: own !== null && reference !== null && reference > 0 ? own / reference : null,
      };
    })
    .sort((left, right) => right.matches - left.matches || left.name.localeCompare(right.name));

  return {
    ruleVersion: PROFILE_RULE_VERSION,
    matches: analyzed,
    players,
    squadFriendlyDamage: players.reduce((sum, player) => sum + player.friendlyDamageDealt, 0),
    notes: [
      '用药量按每人存活分钟归一，避免「活得久用得多」的偏差；名次几乎由存活时间决定，因此这里不把补给量与名次做相关。',
      '破甲转化 = 我方打爆对手护甲后，同一次攻击随后产生倒地或击杀的比例。误伤只统计小队成员之间的伤害。',
    ],
  };
}

export function buildProfileInsights(profiles: PlayerProfiles): Insight[] {
  const insights: Insight[] = [];
  for (const player of profiles.players) {
    if (
      player.matches >= PROFILE_MIN_MATCHES &&
      player.healVsSquad !== null &&
      player.healVsSquad < PROFILE_LOW_HEAL_RATIO
    ) {
      insights.push({
        id: `heal-${player.id}`,
        tone: 'warn',
        title: `${player.name} 每分钟用药量只有队友中位数的 ${(player.healVsSquad * 100).toFixed(0)}%`,
        detail: `每存活分钟使用治疗与能量道具 ${((player.healPerMinute ?? 0) + (player.boostPerMinute ?? 0)).toFixed(2)} 个（${player.matches} 场、${Math.round(player.minutesAlive)} 分钟）。偏低可能意味着带药不足或不爱补状态。`,
        evidence: `阈值 < ${PROFILE_LOW_HEAL_RATIO * 100}% 才提示；已按存活时间归一`,
      });
    }
    if (
      profiles.squadFriendlyDamage >= PROFILE_FRIENDLY_MIN_DAMAGE &&
      player.friendlyDamageDealt / profiles.squadFriendlyDamage >= PROFILE_FRIENDLY_SHARE
    ) {
      insights.push({
        id: `friendly-${player.id}`,
        tone: 'info',
        title: `${player.name} 造成了小队 ${((player.friendlyDamageDealt / profiles.squadFriendlyDamage) * 100).toFixed(0)}% 的队内误伤`,
        detail: `累计对队友造成 ${Math.round(player.friendlyDamageDealt)} 伤害，小队总误伤 ${Math.round(profiles.squadFriendlyDamage)}。投掷物与载具撞击是常见来源。`,
        evidence: `小队总误伤 ≥ ${PROFILE_FRIENDLY_MIN_DAMAGE} 且占比 ≥ ${PROFILE_FRIENDLY_SHARE * 100}% 才提示`,
      });
    }
  }
  return insights;
}
