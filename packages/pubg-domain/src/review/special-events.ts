import type { Fight, HeavyWeaponStats, SpecialEvent, VehicleStats } from './types.js';
import type { NormalizedTelemetryEvent } from './telemetry-events.js';
import { isRocketStats } from './heavy-weapon-intelligence.js';
import {
  dedupeRelevantCombatEvents,
  isTrackedOffensiveEvent,
  isTrackedReviveEvent,
} from './combat-scope.js';

function sameWeapon(event: NormalizedTelemetryEvent, stats: HeavyWeaponStats): boolean {
  const value = event.weaponId ?? event.itemId;
  if (!value) return false;
  const canonical = value
    .replace(/^Item_Weapon_/iu, '')
    .replace(/^Weap/iu, '')
    .replace(/_C$/iu, '');
  return value === stats.weapon || canonical === stats.weapon || /panzer|rocket|rpg/i.test(value);
}

function pushEvent(events: SpecialEvent[], value: Omit<SpecialEvent, 'id'>): void {
  events.push({ ...value, id: `special-${events.length + 1}` });
}

export function detectSpecialEvents(
  events: NormalizedTelemetryEvent[],
  fights: Fight[],
  heavyWeapons: HeavyWeaponStats[],
  vehicles: VehicleStats[],
  teamIds: Set<string>,
  fightIntegrityPass = true,
): SpecialEvent[] {
  const result: SpecialEvent[] = [];
  const dedupedCombatIds = new Set(
    dedupeRelevantCombatEvents(events, teamIds).map((event) => event.id),
  );

  for (const fight of fightIntegrityPass ? fights : []) {
    const fightEvents = events.filter((event) => fight.evidenceIds.includes(event.id));
    for (const playerId of teamIds) {
      const playerCombat = fightEvents.filter(
        (event) => event.actorId === playerId && isTrackedOffensiveEvent(event, teamIds),
      );
      const playerKnocks = playerCombat.filter((event) => event.type === 'KNOCK');
      const playerKills = playerCombat.filter((event) => event.type === 'KILL');
      if (playerKnocks.length >= 2) {
        pushEvent(result, {
          type: 'MULTI_KNOCK',
          playerId,
          time: playerKnocks.at(-1)?.timeSeconds ?? null,
          impact: `一波团战造成${playerKnocks.length}次倒地`,
          impactScore: Math.max(520, fight.importanceScore / 2) + playerKnocks.length * 40,
          facts: { knocks: playerKnocks.length, kills: playerKills.length, fightId: fight.id },
          evidenceIds: playerKnocks.map((event) => event.id),
        });
      }
      if (playerKills.length >= 2) {
        pushEvent(result, {
          type: 'CLUTCH',
          playerId,
          time: playerKills.at(-1)?.timeSeconds ?? null,
          impact: `团战内完成${playerKills.length}次击杀`,
          impactScore: Math.max(580, fight.importanceScore / 2) + playerKills.length * 60,
          facts: {
            kills: playerKills.length,
            knocks: playerKnocks.length,
            result: fight.result,
            fightId: fight.id,
          },
          evidenceIds: playerKills.map((event) => event.id),
        });
      }
    }
  }

  const revivesByPlayer = new Map<string, NormalizedTelemetryEvent[]>();
  for (const event of dedupeRelevantCombatEvents(events, teamIds)) {
    if (!isTrackedReviveEvent(event, teamIds)) continue;
    if (!event.actorId) continue;
    const bucket = revivesByPlayer.get(event.actorId) ?? [];
    bucket.push(event);
    revivesByPlayer.set(event.actorId, bucket);
  }
  for (const [playerId, playerEvents] of revivesByPlayer) {
    if (playerEvents.length < 2) continue;
    pushEvent(result, {
      type: 'REVIVE_CHAIN',
      playerId,
      time: playerEvents.at(-1)?.timeSeconds ?? null,
      impact: `连续完成${playerEvents.length}次救援`,
      impactScore: playerEvents.length * 120,
      facts: { revives: playerEvents.length },
      evidenceIds: playerEvents.map((event) => event.id),
    });
  }

  for (const stats of heavyWeapons) {
    if (!isRocketStats(stats)) continue;
    const directWeaponEvents = events.filter(
      (event) => event.actorId === stats.playerId && sameWeapon(event, stats),
    );
    const attackIds = new Set(
      directWeaponEvents.map((event) => event.attackId).filter((id): id is string => Boolean(id)),
    );
    // A kill/destroy event without a weapon can still be attributed when the
    // telemetry carries the same attackId as an observed rocket event. Time
    // proximity alone is deliberately not used as a causal link.
    const weaponEvents = events.filter(
      (event) =>
        event.actorId === stats.playerId &&
        (sameWeapon(event, stats) || Boolean(event.attackId && attackIds.has(event.attackId))) &&
        (!['DAMAGE', 'KNOCK', 'KILL'].includes(event.type) || dedupedCombatIds.has(event.id)),
    );
    const pickupEvents = weaponEvents.filter((event) => event.type === 'ITEM_ACQUIRE');
    const shotEvents = weaponEvents.filter(
      (event) => event.type === 'ATTACK' || event.type === 'THROWABLE_USE',
    );
    const damageEvents = weaponEvents.filter(
      (event) => event.type === 'DAMAGE' && event.hit && isTrackedOffensiveEvent(event, teamIds),
    );
    const vehicleHitEvents = weaponEvents.filter(
      (event) =>
        event.type === 'VEHICLE_DAMAGE' &&
        (event.vehicleDamage > 0 || event.damage > 0 || event.hit),
    );
    const killEvents = weaponEvents.filter(
      (event) => event.type === 'KILL' && isTrackedOffensiveEvent(event, teamIds),
    );
    const knockEvents = weaponEvents.filter(
      (event) => event.type === 'KNOCK' && isTrackedOffensiveEvent(event, teamIds),
    );
    const destroyEvents = weaponEvents.filter((event) => event.type === 'VEHICLE_DESTROY');

    if (stats.pickupEvents > 0 && stats.shots === 0) {
      pushEvent(result, {
        type: 'ROCKET_UNUSED',
        playerId: stats.playerId,
        time: pickupEvents[0]?.timeSeconds ?? null,
        impact: `拾取${stats.pickupEvents}次但没有发射`,
        impactScore: 20,
        facts: { pickupEvents: stats.pickupEvents, shots: stats.shots },
        evidenceIds: stats.evidenceIds,
      });
    }
    if (stats.hits > 0) {
      // A rocket may expose only a knock/kill record. Those records count as a
      // hit in HeavyWeaponStats when attackId correlation is reliable.
      const hitEvents = [...damageEvents, ...vehicleHitEvents, ...knockEvents, ...killEvents];
      pushEvent(result, {
        type: 'ROCKET_HIT',
        playerId: stats.playerId,
        time: hitEvents[0]?.timeSeconds ?? null,
        impact: `火箭筒产生${stats.hits}次命中记录`,
        impactScore: 180 + stats.playerDamage,
        facts: { shots: stats.shots, hits: stats.hits, playerDamage: stats.playerDamage },
        evidenceIds: [
          ...new Set(
            hitEvents.flatMap((event) => [
              event.id,
              ...shotEvents
                .filter((attack) => attack.attackId !== null && attack.attackId === event.attackId)
                .map((attack) => attack.id),
            ]),
          ),
        ],
      });
    }
    if (
      stats.shots > 0 &&
      stats.hits === 0 &&
      stats.vehicleDamage <= 0 &&
      stats.vehiclesDestroyed === 0 &&
      // A weapon-labelled knock/kill is outcome evidence even when the source
      // omitted attackId. It must not be called an all-miss.
      stats.knocks === 0 &&
      stats.kills === 0
    ) {
      pushEvent(result, {
        type: 'ROCKET_MISS',
        playerId: stats.playerId,
        time: shotEvents[0]?.timeSeconds ?? null,
        impact: `发射${stats.shots}次但没有检测到命中`,
        impactScore: 35,
        facts: { shots: stats.shots, hits: stats.hits },
        evidenceIds: shotEvents.map((event) => event.id),
      });
    }
    if (destroyEvents.length > 0) {
      pushEvent(result, {
        type: 'ROCKET_VEHICLE_DESTROY',
        playerId: stats.playerId,
        time: destroyEvents[0]?.timeSeconds ?? null,
        impact: '火箭筒摧毁载具',
        impactScore: 260,
        facts: { vehiclesDestroyed: destroyEvents.length },
        evidenceIds: destroyEvents.map((event) => event.id),
      });
    }

    const killsByAttack = new Map<string, NormalizedTelemetryEvent[]>();
    for (const event of killEvents) {
      if (!event.attackId || !attackIds.has(event.attackId)) continue;
      const bucket = killsByAttack.get(event.attackId) ?? [];
      bucket.push(event);
      killsByAttack.set(event.attackId, bucket);
    }
    for (const [attackId, groupedKills] of killsByAttack) {
      if (groupedKills.length < 2 || !shotEvents.some((event) => event.attackId === attackId))
        continue;
      pushEvent(result, {
        type: 'ROCKET_MULTI_KILL',
        playerId: stats.playerId,
        time: groupedKills[0]?.timeSeconds ?? null,
        impact: `一发火箭筒关联${groupedKills.length}次击杀`,
        impactScore: 500 + groupedKills.length * 100,
        facts: { attackId, kills: groupedKills.length },
        evidenceIds: [
          ...new Set([
            ...shotEvents.filter((event) => event.attackId === attackId).map((event) => event.id),
            ...groupedKills.map((event) => event.id),
          ]),
        ],
      });
    }

    // A vehicle id plus a weapon-causal destroy event is required. Time
    // proximity alone is intentionally insufficient for a multi-kill claim.
    for (const destroy of destroyEvents) {
      if (!destroy.vehicleId) continue;
      const causalShotEvents = shotEvents.filter(
        (event) =>
          event.attackId !== null &&
          (event.attackId === destroy.attackId || event.vehicleId === destroy.vehicleId),
      );
      if (!causalShotEvents.length) continue;
      const vehicleAttackIds = new Set(
        weaponEvents
          .filter((event) => event.vehicleId === destroy.vehicleId && event.attackId !== null)
          .map((event) => event.attackId as string),
      );
      const vehicleKills = events.filter(
        (event) =>
          event.type === 'KILL' &&
          event.actorId === stats.playerId &&
          isTrackedOffensiveEvent(event, teamIds) &&
          dedupedCombatIds.has(event.id) &&
          event.vehicleId === destroy.vehicleId &&
          (sameWeapon(event, stats) ||
            (event.attackId !== null &&
              (event.attackId === destroy.attackId || vehicleAttackIds.has(event.attackId)))),
      );
      if (vehicleKills.length < 2) continue;
      const causalEvents = weaponEvents.filter(
        (event) =>
          event.id === destroy.id ||
          (event.vehicleId === destroy.vehicleId &&
            (event.type === 'ATTACK' ||
              event.type === 'THROWABLE_USE' ||
              event.type === 'VEHICLE_DAMAGE')) ||
          (destroy.attackId !== null && event.attackId === destroy.attackId),
      );
      pushEvent(result, {
        type: 'ROCKET_VEHICLE_MULTI_KILL',
        playerId: stats.playerId,
        time: destroy.timeSeconds,
        impact: `摧毁载具并关联${vehicleKills.length}次击杀`,
        impactScore: 800 + vehicleKills.length * 150,
        facts: { vehicleId: destroy.vehicleId, kills: vehicleKills.length, vehiclesDestroyed: 1 },
        evidenceIds: [
          ...new Set([
            ...causalEvents.map((event) => event.id),
            ...vehicleKills.map((event) => event.id),
          ]),
        ],
      });
    }
  }

  for (const vehicle of vehicles) {
    if (vehicle.driveDistance >= 2000) {
      pushEvent(result, {
        type: 'VEHICLE_LONG_DRIVE',
        playerId: vehicle.playerId,
        time: null,
        impact: `驾驶${Math.round(vehicle.driveDistance)}米`,
        impactScore: Math.min(300, vehicle.driveDistance / 20),
        facts: {
          driveDistance: Math.round(vehicle.driveDistance),
          maxSpeed: Math.round(vehicle.maxSpeed),
        },
        evidenceIds: vehicle.evidenceIds,
      });
    }
    if (vehicle.vehiclesDestroyed > 0) {
      pushEvent(result, {
        type: 'VEHICLE_DESTROY',
        playerId: vehicle.playerId,
        time: null,
        impact: `摧毁${vehicle.vehiclesDestroyed}辆载具`,
        impactScore: vehicle.vehiclesDestroyed * 180,
        facts: { vehiclesDestroyed: vehicle.vehiclesDestroyed },
        evidenceIds: vehicle.evidenceIds,
      });
    }
  }

  return result.sort(
    (left, right) =>
      right.impactScore - left.impactScore ||
      (left.time ?? Number.POSITIVE_INFINITY) - (right.time ?? Number.POSITIVE_INFINITY) ||
      left.id.localeCompare(right.id),
  );
}
