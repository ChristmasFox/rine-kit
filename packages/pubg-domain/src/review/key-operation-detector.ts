import type { KeyOperation, MatchReviewFacts } from './types.js';
import type { NormalizedTelemetryEvent } from './telemetry-events.js';
import { dedupeRelevantCombatEvents, isTrackedCombatEvent } from './combat-scope.js';

export const KEY_OPERATION_MIN_SCORE = 180;

function addOperation(
  target: KeyOperation[],
  playerId: string,
  time: number | null,
  type: KeyOperation['type'],
  impact: string,
  impactScore: number,
  facts: KeyOperation['facts'],
  evidenceIds: string[],
  id: string,
): void {
  if (!evidenceIds.length || impactScore < KEY_OPERATION_MIN_SCORE) return;
  target.push({
    id,
    playerId,
    time,
    type,
    impact,
    impactScore,
    facts,
    evidenceIds: [...new Set(evidenceIds)],
  });
}

function playerEvents(
  events: NormalizedTelemetryEvent[],
  playerId: string,
  teamIds: Set<string>,
): NormalizedTelemetryEvent[] {
  return events.filter(
    (event) =>
      event.actorId === playerId &&
      event.timeSeconds !== null &&
      isTrackedCombatEvent(event, teamIds),
  );
}

function evidenceTime(facts: MatchReviewFacts, evidenceIds: string[]): number | null {
  const ids = new Set(evidenceIds);
  return (
    facts.combat.events.find((event) => ids.has(event.id) && event.timeSeconds !== null)
      ?.timeSeconds ?? null
  );
}

function sameCombatTarget(
  left: NormalizedTelemetryEvent,
  right: NormalizedTelemetryEvent,
): boolean {
  if (left.victimId && right.victimId && left.victimId === right.victimId) return true;
  return Boolean(left.dbnoId && right.dbnoId && left.dbnoId === right.dbnoId);
}

export function detectKeyOperations(facts: MatchReviewFacts): KeyOperation[] {
  const teamIds = new Set(facts.players.map((player) => player.playerId));
  const combatEvents = dedupeRelevantCombatEvents(facts.combat.events, teamIds);
  const operations: KeyOperation[] = [];
  let nextOperationId = 1;
  const add = (
    target: KeyOperation[],
    playerId: string,
    time: number | null,
    type: KeyOperation['type'],
    impact: string,
    impactScore: number,
    operationFacts: KeyOperation['facts'],
    evidenceIds: string[],
  ): void =>
    addOperation(
      target,
      playerId,
      time,
      type,
      impact,
      impactScore,
      operationFacts,
      evidenceIds,
      `operation-${nextOperationId++}`,
    );
  for (const player of facts.players) {
    const playerOps: KeyOperation[] = [];
    const events = playerEvents(combatEvents, player.playerId, teamIds);

    for (const fight of facts.fightIntegrity.pass ? facts.fights : []) {
      const inFight = events.filter(
        (event) =>
          (event.timeSeconds ?? -1) >= fight.start && (event.timeSeconds ?? -1) <= fight.end,
      );
      if (!inFight.length) continue;
      const teamActions = combatEvents
        .filter(
          (event) =>
            (event.timeSeconds ?? -1) >= fight.start &&
            (event.timeSeconds ?? -1) <= fight.end &&
            event.actorId !== null &&
            teamIds.has(event.actorId) &&
            isTrackedCombatEvent(event, teamIds),
        )
        .sort((left, right) => (left.timeSeconds ?? 0) - (right.timeSeconds ?? 0));
      if (
        teamActions[0]?.actorId === player.playerId &&
        ['DAMAGE', 'KNOCK', 'KILL'].includes(teamActions[0].type)
      ) {
        add(
          playerOps,
          player.playerId,
          teamActions[0].timeSeconds,
          'ENTRY',
          '第一个主动造成战斗影响，完成开团',
          260,
          { fightId: fight.id },
          [teamActions[0].id],
        );
      }
      const knocks = inFight.filter((event) => event.type === 'KNOCK');
      const kills = inFight.filter((event) => event.type === 'KILL');
      const damage = inFight
        .filter((event) => event.type === 'DAMAGE')
        .reduce((sum, event) => sum + event.damage, 0);
      if (knocks.length >= 2)
        add(
          playerOps,
          player.playerId,
          knocks[1]?.timeSeconds ?? knocks[0]?.timeSeconds ?? null,
          'MULTI_KNOCK',
          `一波团战完成${knocks.length}次倒地`,
          480 + knocks.length * 80,
          { fightId: fight.id, knocks: knocks.length },
          knocks.map((event) => event.id),
        );
      if (kills.length >= 2)
        add(
          playerOps,
          player.playerId,
          kills[0]?.timeSeconds ?? null,
          'CLUTCH',
          `团战内完成${kills.length}次击杀`,
          560 + kills.length * 100,
          { fightId: fight.id, kills: kills.length },
          kills.map((event) => event.id),
        );
      const teammateKnocks = teamActions.filter(
        (event) =>
          event.actorId !== null &&
          teamIds.has(event.actorId) &&
          event.actorId !== player.playerId &&
          event.type === 'KNOCK',
      );
      const trade = kills
        .map((kill) => ({
          kill,
          teammateKnock: teammateKnocks.find(
            (knock) =>
              sameCombatTarget(knock, kill) &&
              (kill.timeSeconds ?? -1) >= (knock.timeSeconds ?? -1) &&
              (kill.timeSeconds ?? -1) - (knock.timeSeconds ?? -1) <= 15,
          ),
        }))
        .find((item) => item.teammateKnock);
      if (trade?.teammateKnock) {
        add(
          playerOps,
          player.playerId,
          trade.kill.timeSeconds,
          'TRADE',
          '队友创造倒地后及时完成补枪/交换',
          360,
          { fightId: fight.id },
          [trade.teammateKnock.id, trade.kill.id],
        );
      }
      if (damage >= 150)
        add(
          playerOps,
          player.playerId,
          inFight.find((event) => event.type === 'DAMAGE')?.timeSeconds ?? null,
          'DAMAGE',
          `团战造成${Math.round(damage)}伤害`,
          Math.min(420, 160 + damage / 4),
          { fightId: fight.id, damage: Math.round(damage) },
          inFight.filter((event) => event.type === 'DAMAGE').map((event) => event.id),
        );
      if (inFight.some((event) => event.type === 'REVIVE')) {
        const revives = inFight.filter((event) => event.type === 'REVIVE');
        add(
          playerOps,
          player.playerId,
          revives[0]?.timeSeconds ?? null,
          'REVIVE',
          `团战中完成${revives.length}次救援`,
          300 + revives.length * 60,
          { fightId: fight.id, revives: revives.length },
          revives.map((event) => event.id),
        );
      }
      if (damage > 0 && kills.length === 0 && !inFight.some((event) => event.type === 'REVIVE')) {
        add(
          playerOps,
          player.playerId,
          inFight.find((event) => event.type === 'DAMAGE')?.timeSeconds ?? null,
          'SUPPORT',
          '持续施压并为队友制造输出窗口',
          Math.min(260, 100 + damage / 5),
          { fightId: fight.id, damage: Math.round(damage) },
          inFight.filter((event) => event.type === 'DAMAGE').map((event) => event.id),
        );
      }
    }

    const vehicle = facts.vehicles.find((item) => item.playerId === player.playerId);
    if (vehicle) {
      const meaningful = vehicle.vehicleDamage >= 100 || vehicle.vehiclesDestroyed > 0;
      if (meaningful) {
        const impact = [
          vehicle.vehicleDamage > 0 ? `造成${Math.round(vehicle.vehicleDamage)}载具伤害` : '',
          vehicle.vehiclesDestroyed > 0 ? `摧毁${vehicle.vehiclesDestroyed}辆载具` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        add(
          playerOps,
          player.playerId,
          evidenceTime(facts, vehicle.evidenceIds),
          'VEHICLE',
          impact,
          Math.min(420, 180 + vehicle.vehicleDamage / 2 + vehicle.vehiclesDestroyed * 180),
          {
            vehicleDamage: Math.round(vehicle.vehicleDamage),
            vehiclesDestroyed: vehicle.vehiclesDestroyed,
          },
          vehicle.evidenceIds,
        );
      }
    }
    for (const weapon of facts.heavyWeapons.filter((item) => item.playerId === player.playerId)) {
      if (
        weapon.shots <= 0 &&
        weapon.hits <= 0 &&
        weapon.knocks <= 0 &&
        weapon.kills <= 0 &&
        weapon.vehiclesDestroyed <= 0
      )
        continue;
      const impact =
        weapon.shots === 0
          ? `拾取${weapon.weapon}${weapon.pickupEvents}次但未发射`
          : `${weapon.weapon}${weapon.shots}发/${weapon.hits}次命中记录`;
      add(
        playerOps,
        player.playerId,
        evidenceTime(facts, weapon.evidenceIds),
        'HEAVY_WEAPON',
        impact,
        Math.min(500, 80 + weapon.hits * 180 + weapon.kills * 160 + weapon.vehiclesDestroyed * 150),
        { weapon: weapon.weapon, shots: weapon.shots, hits: weapon.hits, kills: weapon.kills },
        weapon.evidenceIds,
      );
    }

    operations.push(
      ...playerOps
        .sort(
          (left, right) =>
            right.impactScore - left.impactScore ||
            (left.time ?? Number.POSITIVE_INFINITY) - (right.time ?? Number.POSITIVE_INFINITY) ||
            left.id.localeCompare(right.id),
        )
        .slice(0, 3),
    );
  }
  return operations;
}
