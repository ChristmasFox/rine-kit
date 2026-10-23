import type {
  FunConfidence,
  FunEvent,
  MatchReviewFacts,
  TeamDamageFact,
  TeamVehicleEvent,
} from './types.js';
import { isPunchWeapon } from './telemetry-events.js';
import { generateBaseFunEvents, resolveFunEvidenceIds } from './fun-event-generator.js';

export interface FunCombinationRule {
  id: string;
  conditions: string[];
  priority: number;
  funScore: number;
  confidenceRequirement: FunConfidence;
  dedupGroup: string;
  evaluate(facts: MatchReviewFacts, baseEvents: FunEvent[]): FunEvent | null;
}

function playerName(facts: MatchReviewFacts, playerId: string): string {
  return facts.players.find((player) => player.playerId === playerId)?.playerName ?? playerId;
}

function playerSummaryFact(facts: MatchReviewFacts, playerId: string): string {
  return `player-summary-${facts.match.matchId}-${playerId}`;
}

function fightLabel(facts: MatchReviewFacts, fight: MatchReviewFacts['fights'][number]): string {
  const ordinal = Math.max(1, facts.fights.findIndex((item) => item.id === fight.id) + 1);
  return `第${ordinal}波团战`;
}

function punchFacts(facts: MatchReviewFacts, playerId: string): TeamDamageFact[] {
  return (facts.teamDamage ?? []).filter(
    (fact) =>
      fact.actorPlayerId === playerId &&
      fact.source === 'MELEE' &&
      isPunchWeapon(fact.weapon ?? null, fact.damageTypeCategory ?? null),
  );
}

function confirmedVehicleFacts(facts: MatchReviewFacts, playerId: string): TeamVehicleEvent[] {
  return (facts.teamVehicleEvents ?? []).filter(
    (item) => item.actorPlayerId === playerId && item.driverConfirmed,
  );
}

function baseEventsFor(
  baseEvents: FunEvent[],
  types: string[],
  actorPlayerId?: string,
): FunEvent[] {
  return baseEvents.filter(
    (event) =>
      types.includes(event.type) &&
      (actorPlayerId === undefined || event.actorPlayerId === actorPlayerId),
  );
}

function makeCombo(
  facts: MatchReviewFacts,
  rule: FunCombinationRule,
  input: {
    id: string;
    actorPlayerId?: string;
    targetPlayerIds: string[];
    factIds: string[];
    evidenceIds: string[];
    title: string;
    text: string;
    facts: Record<string, number | string | boolean | null>;
    tags: string[];
    suppresses: string[];
  },
): FunEvent | null {
  const factIds = [...new Set(input.factIds.filter(Boolean))];
  const evidenceIds = resolveFunEvidenceIds(facts, input.evidenceIds);
  if (!factIds.length || !evidenceIds.length) return null;
  return {
    id: input.id,
    type: `COMBO_${rule.id.toUpperCase()}`,
    ...(input.actorPlayerId ? { actorPlayerId: input.actorPlayerId } : {}),
    targetPlayerIds: [...new Set(input.targetPlayerIds)],
    factIds,
    evidenceIds,
    confidence: rule.confidenceRequirement,
    funScore: Math.max(0, Math.min(100, rule.funScore)),
    category: 'combination',
    title: input.title,
    text: input.text,
    facts: input.facts,
    tags: [...new Set(['combo', ...input.tags])],
    dedupGroup: rule.dedupGroup,
    suppresses: [...new Set(input.suppresses)],
  };
}

function firstThenFight(): FunCombinationRule {
  return {
    id: 'first_punch_then_fight',
    conditions: ['same actor has >= 3 confirmed punch hits', 'player damage <= 100'],
    priority: 100,
    funScore: 85,
    confidenceRequirement: 'DERIVED',
    dedupGroup: 'combo-teammate',
    evaluate(facts) {
      const candidates = facts.players
        .map((player) => ({ player, punches: punchFacts(facts, player.playerId) }))
        .filter(
          (item) =>
            item.punches.reduce((sum, fact) => sum + fact.hitCount, 0) >= 3 &&
            item.player.damage <= 100,
        )
        .sort(
          (left, right) =>
            right.punches.reduce((sum, fact) => sum + fact.hitCount, 0) -
              left.punches.reduce((sum, fact) => sum + fact.hitCount, 0) ||
            left.player.playerId.localeCompare(right.player.playerId),
        );
      const selected = candidates[0];
      if (!selected) return null;
      const punches = selected.punches.reduce((sum, fact) => sum + fact.hitCount, 0);
      const enemyDamage = Math.round(selected.player.damage);
      const preMatchPunches = selected.punches
        .filter((fact) => fact.phase === 'pre_match')
        .reduce((sum, fact) => sum + fact.hitCount, 0);
      const inMatchPunches = selected.punches
        .filter((fact) => fact.phase === 'in_match')
        .reduce((sum, fact) => sum + fact.hitCount, 0);
      const punchText =
        preMatchPunches > 0 && inMatchPunches > 0
          ? `赛前${preMatchPunches}拳、正赛${inMatchPunches}拳`
          : preMatchPunches > 0
            ? `赛前${preMatchPunches}拳`
            : inMatchPunches > 0
              ? `正赛${inMatchPunches}拳`
              : `${punches}拳`;
      const breakdown = selected.punches
        .slice()
        .sort(
          (left, right) =>
            right.hitCount - left.hitCount ||
            left.victimPlayerId.localeCompare(right.victimPlayerId),
        )
        .map((fact) => `${playerName(facts, fact.victimPlayerId)} ${fact.hitCount}拳`)
        .join(' · ');
      return makeCombo(facts, this, {
        id: `fun-event-combo-first-punch-${selected.player.playerId}`,
        actorPlayerId: selected.player.playerId,
        targetPlayerIds: selected.punches.map((fact) => fact.victimPlayerId),
        factIds: [
          ...selected.punches.map((fact) => fact.id),
          playerSummaryFact(facts, selected.player.playerId),
        ],
        evidenceIds: [
          ...selected.punches.flatMap((fact) => [`evidence-${fact.id}`, ...fact.evidenceIds]),
          `player-summary-${facts.match.matchId}-${selected.player.playerId}`,
        ],
        title: '🥊 先礼后兵',
        text: `${selected.player.playerName}\n先给队友${punchText}（${breakdown}），正式比赛只给敌人造成${enemyDamage}伤害。`,
        facts: { punchHits: punches, enemyDamage, breakdown },
        tags: ['punching', 'low_enemy_damage'],
        suppresses: ['TEAMMATE_PUNCHING'],
      });
    },
  };
}

function bidirectionalPunch(): FunCombinationRule {
  return {
    id: 'bidirectional_punch',
    conditions: ['same pair has confirmed punches in both directions'],
    priority: 112,
    funScore: 86,
    confidenceRequirement: 'CONFIRMED',
    dedupGroup: 'combo-teammate',
    evaluate(facts) {
      const pairs = new Map<string, { left: TeamDamageFact; right: TeamDamageFact }>();
      for (const left of facts.teamDamage ?? []) {
        if (
          left.source !== 'MELEE' ||
          !isPunchWeapon(left.weapon ?? null, left.damageTypeCategory ?? null)
        )
          continue;
        const reverse = (facts.teamDamage ?? []).find(
          (right) =>
            right.source === 'MELEE' &&
            isPunchWeapon(right.weapon ?? null, right.damageTypeCategory ?? null) &&
            right.actorPlayerId === left.victimPlayerId &&
            right.victimPlayerId === left.actorPlayerId,
        );
        if (!reverse) continue;
        const ids = [left.actorPlayerId, left.victimPlayerId].sort();
        pairs.set(ids.join(':'), { left, right: reverse });
      }
      const selected = [...pairs.values()].sort((left, right) => {
        const leftHits = left.left.hitCount + left.right.hitCount;
        const rightHits = right.left.hitCount + right.right.hitCount;
        return rightHits - leftHits || left.left.id.localeCompare(right.left.id);
      })[0];
      if (!selected) return null;
      const leftHits = selected.left.hitCount;
      const rightHits = selected.right.hitCount;
      return makeCombo(facts, this, {
        id: `fun-event-combo-bidirectional-punch-${selected.left.actorPlayerId}-${selected.left.victimPlayerId}`,
        actorPlayerId: selected.left.actorPlayerId,
        targetPlayerIds: [selected.left.victimPlayerId],
        factIds: [selected.left.id, selected.right.id],
        evidenceIds: [
          ...selected.left.evidenceIds,
          ...selected.right.evidenceIds,
          `evidence-${selected.left.id}`,
          `evidence-${selected.right.id}`,
        ],
        title: '🥊 双向互殴',
        text: `${playerName(facts, selected.left.actorPlayerId)}→${playerName(facts, selected.left.victimPlayerId)} ${leftHits}拳；${playerName(facts, selected.right.actorPlayerId)}→${playerName(facts, selected.right.victimPlayerId)} ${rightHits}拳。`,
        facts: {
          forwardPunches: leftHits,
          reversePunches: rightHits,
          forwardDamage: Math.round(selected.left.damage),
          reverseDamage: Math.round(selected.right.damage),
        },
        tags: ['punching', 'bidirectional'],
        suppresses: ['TEAMMATE_PUNCHING'],
      });
    },
  };
}

function friendlyDamageTriad(): FunCombinationRule {
  return {
    id: 'friendly_damage_triad',
    conditions: ['bidirectional punches', 'additional friendly explosive/gun/vehicle damage'],
    priority: 118,
    funScore: 94,
    confidenceRequirement: 'CONFIRMED',
    dedupGroup: 'combo-teammate',
    evaluate(facts) {
      const punches = (facts.teamDamage ?? []).filter(
        (fact) =>
          fact.source === 'MELEE' &&
          isPunchWeapon(fact.weapon ?? null, fact.damageTypeCategory ?? null),
      );
      const forward = punches.find((fact) =>
        punches.some(
          (reverse) =>
            reverse.actorPlayerId === fact.victimPlayerId &&
            reverse.victimPlayerId === fact.actorPlayerId,
        ),
      );
      if (!forward) return null;
      const reverse = punches.find(
        (fact) =>
          fact.actorPlayerId === forward.victimPlayerId &&
          fact.victimPlayerId === forward.actorPlayerId,
      );
      const extra = (facts.teamDamage ?? []).find((fact) =>
        ['EXPLOSIVE', 'GUN', 'VEHICLE'].includes(fact.source),
      );
      if (!reverse || !extra) return null;
      return makeCombo(facts, this, {
        id: `fun-event-combo-friendly-damage-triad-${forward.actorPlayerId}-${forward.victimPlayerId}`,
        actorPlayerId: extra.actorPlayerId,
        targetPlayerIds: [forward.victimPlayerId, reverse.victimPlayerId, extra.victimPlayerId],
        factIds: [forward.id, reverse.id, extra.id],
        evidenceIds: [
          ...forward.evidenceIds,
          ...reverse.evidenceIds,
          ...extra.evidenceIds,
          `evidence-${forward.id}`,
          `evidence-${reverse.id}`,
          `evidence-${extra.id}`,
        ],
        title: '🚨 误伤三件套',
        text: `${playerName(facts, forward.actorPlayerId)}→${playerName(facts, forward.victimPlayerId)} ${forward.hitCount}拳；${playerName(facts, reverse.actorPlayerId)}→${playerName(facts, reverse.victimPlayerId)} ${reverse.hitCount}拳；${playerName(facts, extra.actorPlayerId)}再用${extra.source === 'EXPLOSIVE' ? '投掷物' : extra.source === 'GUN' ? '枪械' : '载具'}误伤队友${extra.hitCount}次。`,
        facts: {
          forwardPunches: forward.hitCount,
          reversePunches: reverse.hitCount,
          extraSource: extra.source,
          extraHits: extra.hitCount,
        },
        tags: ['team_damage', 'punching', 'triad'],
        suppresses: [
          'TEAMMATE_PUNCHING',
          'TEAM_EXPLOSIVE_DAMAGE',
          'TEAM_GUN_DAMAGE',
          'TEAM_VEHICLE_DAMAGE',
        ],
      });
    },
  };
}

function entryToClutch(): FunCombinationRule {
  return {
    id: 'entry_to_clutch',
    conditions: ['one teammate opens a fight', 'another teammate converts multiple knocks/kills'],
    priority: 104,
    funScore: 91,
    confidenceRequirement: 'DERIVED',
    dedupGroup: 'combo-combat',
    evaluate(facts) {
      for (const fight of facts.fights) {
        const operations = facts.players.flatMap((player) =>
          player.keyOperations.filter((operation) => operation.facts.fightId === fight.id),
        );
        const entry = operations.find((operation) => operation.type === 'ENTRY');
        const finisher = operations
          .filter((operation) => operation.type === 'CLUTCH' || operation.type === 'MULTI_KNOCK')
          .sort((left, right) => right.impactScore - left.impactScore)[0];
        if (!entry || !finisher || entry.playerId === finisher.playerId) continue;
        return makeCombo(facts, this, {
          id: `fun-event-combo-entry-to-clutch-${fight.id}`,
          actorPlayerId: entry.playerId,
          targetPlayerIds: [finisher.playerId],
          factIds: [entry.id, finisher.id],
          evidenceIds: [
            ...entry.evidenceIds,
            ...finisher.evidenceIds,
            `evidence-${entry.id}`,
            `evidence-${finisher.id}`,
          ],
          title: '🔥 开团到收割',
          text: `${playerName(facts, entry.playerId)}先手开团，${playerName(facts, finisher.playerId)}随后完成${String(finisher.facts.kills ?? finisher.facts.knocks ?? 0)}次${finisher.type === 'CLUTCH' ? '击杀' : '倒地'}。`,
          facts: {
            fightId: fight.id,
            entryPlayerId: entry.playerId,
            finisherPlayerId: finisher.playerId,
            finisherType: finisher.type,
          },
          tags: ['combat', 'teamwork', 'entry', 'finish'],
          suppresses: ['KEY_OPERATION_ENTRY'],
        });
      }
      return null;
    },
  };
}

function highDamageNoConversion(): FunCombinationRule {
  return {
    id: 'high_damage_no_conversion',
    conditions: ['loss fight has damage and knocks', 'zero kills'],
    priority: 101,
    funScore: 89,
    confidenceRequirement: 'DERIVED',
    dedupGroup: 'combo-combat',
    evaluate(facts) {
      const fight = [...facts.fights]
        .filter(
          (item) =>
            item.result === 'LOSS' &&
            item.teamKills === 0 &&
            item.teamKnocks > 0 &&
            item.teamDamage >= 100,
        )
        .sort((left, right) => right.teamDamage - left.teamDamage || right.end - left.end)[0];
      if (!fight) return null;
      return makeCombo(facts, this, {
        id: `fun-event-combo-no-conversion-${fight.id}`,
        targetPlayerIds: fight.keyPlayers,
        factIds: [fight.id],
        evidenceIds: fight.evidenceIds,
        title: '🫠 有伤害没收口',
        text: `${fightLabel(facts, fight)}造成${Math.round(fight.teamDamage)}伤害、${fight.teamKnocks}次倒地，但0击杀，最终以失败收场。`,
        facts: {
          fightId: fight.id,
          damage: Math.round(fight.teamDamage),
          knocks: fight.teamKnocks,
          kills: fight.teamKills,
        },
        tags: ['combat', 'loss', 'conversion'],
        suppresses: [],
      });
    },
  };
}

function friendlyThreat(): FunCombinationRule {
  return {
    id: 'punch_and_vehicle_damage',
    conditions: [
      'same actor has confirmed punch hits',
      'same confirmed driver has vehicle team damage',
    ],
    priority: 95,
    funScore: 88,
    confidenceRequirement: 'CONFIRMED',
    dedupGroup: 'combo-teammate',
    evaluate(facts) {
      const candidates = facts.players
        .map((player) => ({
          player,
          punches: punchFacts(facts, player.playerId),
          vehicle: confirmedVehicleFacts(facts, player.playerId),
        }))
        .filter(
          (item) =>
            item.punches.reduce((sum, fact) => sum + fact.hitCount, 0) > 0 &&
            item.vehicle.length > 0,
        )
        .sort((left, right) => left.player.playerId.localeCompare(right.player.playerId));
      const selected = candidates[0];
      if (!selected) return null;
      const punches = selected.punches.reduce((sum, fact) => sum + fact.hitCount, 0);
      const vehicleDamage = selected.vehicle.reduce((sum, item) => sum + item.damage, 0);
      return makeCombo(facts, this, {
        id: `fun-event-combo-friendly-threat-${selected.player.playerId}`,
        actorPlayerId: selected.player.playerId,
        targetPlayerIds: [
          ...selected.punches.map((fact) => fact.victimPlayerId),
          ...selected.vehicle.map((item) => item.victimPlayerId),
        ],
        factIds: [
          ...selected.punches.map((fact) => fact.id),
          ...selected.vehicle.map((item) => item.id),
        ],
        evidenceIds: [
          ...selected.punches.flatMap((fact) => [`evidence-${fact.id}`, ...fact.evidenceIds]),
          ...selected.vehicle.flatMap((item) => [`evidence-${item.id}`, ...item.evidenceIds]),
        ],
        title: '🚨 友军威胁',
        text: `${selected.player.playerName}\n拳击队友${punches}次，又造成${Math.round(vehicleDamage)}点车辆队伤。`,
        facts: { punchHits: punches, vehicleDamage: Math.round(vehicleDamage) },
        tags: ['punching', 'vehicle_team_damage'],
        suppresses: ['TEAMMATE_PUNCHING', 'VEHICLE_TEAM_HIT', 'TEAM_VEHICLE_DAMAGE'],
      });
    },
  };
}

function pubgTour(): FunCombinationRule {
  return {
    id: 'tourist_bus',
    conditions: ['rideDistance >= 5000m', 'low combat contribution'],
    priority: 90,
    funScore: 84,
    confidenceRequirement: 'DERIVED',
    dedupGroup: 'combo-vehicle',
    evaluate(facts, baseEvents) {
      const candidates = facts.players
        .map((player) => ({
          player,
          vehicle: facts.vehicles.find((item) => item.playerId === player.playerId),
        }))
        .filter(
          (item) =>
            item.vehicle &&
            item.vehicle.rideDistance >= 5_000 &&
            item.player.kills === 0 &&
            item.player.assists === 0 &&
            item.player.dbnos === 0 &&
            item.player.revives === 0 &&
            item.player.damage <= 100,
        )
        .sort(
          (left, right) =>
            (right.vehicle?.rideDistance ?? 0) - (left.vehicle?.rideDistance ?? 0) ||
            left.player.playerId.localeCompare(right.player.playerId),
        );
      const selected = candidates[0];
      if (!selected?.vehicle) return null;
      const travel = baseEventsFor(
        baseEvents,
        ['TOP_DRIVER', 'TOP_PASSENGER', 'LONGEST_RIDE'],
        selected.player.playerId,
      )[0];
      return makeCombo(facts, this, {
        id: `fun-event-combo-tour-${selected.player.playerId}`,
        actorPlayerId: selected.player.playerId,
        targetPlayerIds: [],
        factIds: [
          playerSummaryFact(facts, selected.player.playerId),
          selected.vehicle.id ?? `vehicle-${selected.player.playerId}`,
        ],
        evidenceIds: [
          `player-summary-${facts.match.matchId}-${selected.player.playerId}`,
          ...selected.vehicle.evidenceIds,
          ...(travel?.evidenceIds ?? []),
        ],
        title: '🚌 PUBG旅游团',
        text: `${selected.player.playerName}\n乘车${(selected.vehicle.rideDistance / 1_000).toFixed(1)}km · ${selected.player.kills}杀 · ${Math.round(selected.player.damage)}伤害。`,
        facts: {
          rideDistance: Math.round(selected.vehicle.rideDistance),
          kills: selected.player.kills,
          damage: Math.round(selected.player.damage),
        },
        tags: ['vehicle', 'low_combat'],
        suppresses: ['TOP_DRIVER', 'TOP_PASSENGER', 'LONGEST_RIDE', 'NO_COMBAT_PRESENCE'],
      });
    },
  };
}

function strategicReserve(): FunCombinationRule {
  return {
    id: 'rocket_reserve',
    conditions: ['rocket pickupEvents >= 2', 'rocket shots = 0'],
    priority: 92,
    funScore: 86,
    confidenceRequirement: 'DERIVED',
    dedupGroup: 'combo-heavy-weapon',
    evaluate(facts, baseEvents) {
      const unused = facts.specialEvents.find(
        (event) =>
          event.type === 'ROCKET_UNUSED' &&
          event.playerId &&
          Number(event.facts.pickupEvents ?? 0) >= 2 &&
          Number(event.facts.shots ?? 0) === 0,
      );
      if (!unused?.playerId) return null;
      const base = baseEventsFor(baseEvents, ['ROCKET_UNUSED'], unused.playerId)[0];
      const pickups = Number(unused.facts.pickupEvents ?? 0);
      return makeCombo(facts, this, {
        id: `fun-event-combo-rocket-reserve-${unused.playerId}`,
        actorPlayerId: unused.playerId,
        targetPlayerIds: [],
        factIds: [unused.id],
        evidenceIds: [`evidence-${unused.id}`, ...unused.evidenceIds, ...(base?.evidenceIds ?? [])],
        title: '🎒 战略储备',
        text: `${playerName(facts, unused.playerId)}\n火箭筒拾取${pickups}次，直到比赛结束一炮未发。`,
        facts: { pickupEvents: pickups, shots: 0 },
        tags: ['heavy_weapon', 'unused'],
        suppresses: ['ROCKET_UNUSED'],
      });
    },
  };
}

function reviveFailure(): FunCombinationRule {
  return {
    id: 'revive_failure',
    conditions: ['revives >= 4', 'placement > 1'],
    priority: 88,
    funScore: 84,
    confidenceRequirement: 'DERIVED',
    dedupGroup: 'combo-support',
    evaluate(facts) {
      if (facts.match.placement === null || facts.match.placement <= 1) return null;
      const selected = [...facts.players]
        .filter((player) => player.revives >= 4)
        .sort(
          (left, right) =>
            right.revives - left.revives || left.playerId.localeCompare(right.playerId),
        )[0];
      if (!selected) return null;
      return makeCombo(facts, this, {
        id: `fun-event-combo-revive-failure-${selected.playerId}`,
        actorPlayerId: selected.playerId,
        targetPlayerIds: [],
        factIds: [playerSummaryFact(facts, selected.playerId)],
        evidenceIds: [
          `player-summary-${facts.match.matchId}-${selected.playerId}`,
          `match-summary-${facts.match.matchId}`,
        ],
        title: '🩺 人救麻了',
        text: `${selected.playerName}\n完成${selected.revives}次救援，但队伍最终止步#${facts.match.placement}。`,
        facts: { revives: selected.revives, placement: facts.match.placement },
        tags: ['support', 'loss'],
        suppresses: ['MOST_REVIVES', 'REVIVE_CHAIN'],
      });
    },
  };
}

function attackDirection(): FunCombinationRule {
  return {
    id: 'attack_direction',
    conditions: ['friendly-fire damage >= 20', 'friendly-fire damage >= 25% of enemy damage'],
    priority: 80,
    funScore: 78,
    confidenceRequirement: 'DERIVED',
    dedupGroup: 'combo-teammate',
    evaluate(facts) {
      // Lobby/ready-room friendly fire is useful for punching jokes, but it
      // must not be used to claim that the squad attacked itself in the match.
      const teamDamage = (facts.teamDamage ?? []).filter((fact) => fact.phase !== 'pre_match');
      const friendlyDamage = teamDamage.reduce((sum, fact) => sum + fact.damage, 0);
      const enemyDamage = facts.players.reduce((sum, player) => sum + player.damage, 0);
      if (enemyDamage <= 0 || friendlyDamage < 20 || friendlyDamage < enemyDamage * 0.25)
        return null;
      const actors = [...new Set(teamDamage.map((fact) => fact.actorPlayerId))];
      const targets = [...new Set(teamDamage.map((fact) => fact.victimPlayerId))];
      const hasUnconfirmedVehicle = teamDamage.some(
        (fact) =>
          fact.source === 'VEHICLE' &&
          !(facts.teamVehicleEvents ?? []).some(
            (item) => item.actorPlayerId === fact.actorPlayerId && item.driverConfirmed,
          ),
      );
      return makeCombo(facts, this, {
        ...(!hasUnconfirmedVehicle && actors.length === 1 ? { actorPlayerId: actors[0] } : {}),
        id: 'fun-event-combo-attack-direction',
        targetPlayerIds: targets,
        factIds: teamDamage.map((fact) => fact.id),
        evidenceIds: teamDamage.flatMap((fact) => [`evidence-${fact.id}`, ...fact.evidenceIds]),
        title: '🎯 攻击方向值得研究',
        text: `队友伤害${Math.round(friendlyDamage)}点，占敌人伤害${Math.round(enemyDamage)}点的显著比例。`,
        facts: { friendlyDamage: Math.round(friendlyDamage), enemyDamage: Math.round(enemyDamage) },
        tags: ['team_damage', 'direction'],
        suppresses: [
          'TEAM_GUN_DAMAGE',
          'TEAM_MELEE_DAMAGE',
          'TEAM_VEHICLE_DAMAGE',
          'TEAM_EXPLOSIVE_DAMAGE',
        ],
      });
    },
  };
}

export const DEFAULT_FUN_COMBINATION_RULES: FunCombinationRule[] = [
  friendlyDamageTriad(),
  bidirectionalPunch(),
  entryToClutch(),
  highDamageNoConversion(),
  firstThenFight(),
  friendlyThreat(),
  pubgTour(),
  strategicReserve(),
  reviveFailure(),
  attackDirection(),
];

export class EventCombinationEngine {
  constructor(private readonly rules: FunCombinationRule[] = DEFAULT_FUN_COMBINATION_RULES) {}

  combine(facts: MatchReviewFacts, baseEvents = generateBaseFunEvents(facts)): FunEvent[] {
    return [...this.rules]
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
      .map((rule) => rule.evaluate(facts, baseEvents))
      .filter(
        (event): event is FunEvent =>
          event !== null && event.factIds.length > 0 && event.evidenceIds.length > 0,
      );
  }
}

export function combineFunEvents(facts: MatchReviewFacts, baseEvents?: FunEvent[]): FunEvent[] {
  return new EventCombinationEngine().combine(facts, baseEvents);
}
