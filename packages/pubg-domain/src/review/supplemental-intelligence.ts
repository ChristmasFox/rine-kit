import type {
  ArmorBreakFact,
  EnvironmentStats,
  LootActivityStats,
  LootStats,
  RecoveryStats,
  StunGunStats,
  VehicleImpactFact,
  VehicleTrunkTransfer,
} from './types.js';
import type { NormalizedTelemetryEvent } from './telemetry-events.js';
import { isVehicleWeapon } from './telemetry-events.js';

function inMatch(event: NormalizedTelemetryEvent): boolean {
  return event.phase !== 'pre_match';
}

function item(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/^Item_/iu, '')
    .replace(/^Weapon_/iu, '')
    .replace(/_C$/iu, '');
}

function weapon(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/^Item_Weapon_/iu, '')
    .replace(/^Weap/iu, '')
    .replace(/_C$/iu, '');
}

function playerEvents(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
  playerId: string,
): NormalizedTelemetryEvent[] {
  return events.filter(
    (event) => event.actorId === playerId && teamIds.has(playerId) && inMatch(event),
  );
}

function evidence(events: NormalizedTelemetryEvent[]): string[] {
  return [...new Set(events.map((event) => event.id))];
}

function timeOf(event: NormalizedTelemetryEvent): number {
  return event.timeSeconds ?? Number.POSITIVE_INFINITY;
}

function sortedEvidence(events: NormalizedTelemetryEvent[]): string[] {
  return evidence(
    [...events].sort(
      (left, right) => timeOf(left) - timeOf(right) || left.id.localeCompare(right.id),
    ),
  );
}

export function extractStunGunStats(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): StunGunStats[] {
  const result: StunGunStats[] = [];
  for (const playerId of teamIds) {
    const owned = playerEvents(events, teamIds, playerId).filter((event) =>
      /stungun/iu.test(`${event.itemId ?? ''} ${event.weaponId ?? ''}`),
    );
    const pickups = owned.filter((event) => event.type === 'ITEM_ACQUIRE');
    const shots = owned.filter((event) => event.type === 'ATTACK');
    const hits = owned.filter((event) => event.type === 'DAMAGE' && event.hit);
    const teammateHits = hits.filter((event) =>
      Boolean(event.victimId && teamIds.has(event.victimId)),
    ).length;
    const enemyHits = hits.filter((event) =>
      Boolean(event.victimId && !teamIds.has(event.victimId)),
    ).length;
    if (!owned.length) continue;
    result.push({
      id: `stun-gun-${playerId}`,
      playerId,
      pickups: pickups.length,
      shots: shots.length,
      confirmedHits: hits.length,
      teammateHits,
      enemyHits,
      unknownOutcomes: Math.max(0, shots.length - hits.length),
      evidenceIds: sortedEvidence(owned),
    });
  }
  return result.sort((left, right) => left.playerId.localeCompare(right.playerId));
}

function recoveryKind(
  itemId: string,
):
  | keyof Pick<
      RecoveryStats,
      'bandages' | 'firstAids' | 'medKits' | 'adrenaline' | 'energyDrinks' | 'painkillers'
    >
  | 'otherUses'
  | null {
  const value = itemId.toLowerCase();
  if (value.includes('bandage')) return 'bandages';
  if (value.includes('firstaid')) return 'firstAids';
  if (value.includes('medkit')) return 'medKits';
  if (value.includes('adrenaline')) return 'adrenaline';
  if (value.includes('energydrink')) return 'energyDrinks';
  if (value.includes('painkiller')) return 'painkillers';
  if (/item_(?:heal|boost)_/iu.test(value)) return 'otherUses';
  return null;
}

export function extractRecoveryStats(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): RecoveryStats[] {
  const result: RecoveryStats[] = [];
  for (const playerId of teamIds) {
    const owned = playerEvents(events, teamIds, playerId);
    const uses = owned.filter(
      (event) => event.type === 'ITEM_USE' && recoveryKind(event.itemId ?? '') !== null,
    );
    const stats: RecoveryStats = {
      id: `recovery-${playerId}`,
      playerId,
      bandages: 0,
      firstAids: 0,
      medKits: 0,
      adrenaline: 0,
      energyDrinks: 0,
      painkillers: 0,
      otherUses: 0,
      healingAmount: owned
        .filter((event) => event.type === 'HEAL')
        .reduce((sum, event) => sum + Math.max(0, event.healAmount ?? 0), 0),
      evidenceIds: sortedEvidence([...uses, ...owned.filter((event) => event.type === 'HEAL')]),
    };
    for (const event of uses) {
      const kind = recoveryKind(event.itemId ?? '');
      if (kind && kind in stats) stats[kind] += 1;
    }
    if (uses.length || stats.healingAmount > 0) result.push(stats);
  }
  return result.sort((left, right) => left.playerId.localeCompare(right.playerId));
}

function itemCategory(
  event: NormalizedTelemetryEvent,
):
  | keyof Pick<
      LootStats,
      'weapons' | 'throwables' | 'ammunition' | 'healing' | 'boosts' | 'armor' | 'attachments'
    >
  | null {
  const category = `${event.itemCategory ?? ''}/${event.itemSubCategory ?? ''}`.toLowerCase();
  if (category.includes('weapon')) return 'weapons';
  if (category.includes('throwable')) return 'throwables';
  if (category.includes('ammunition') || category.includes('ammo')) return 'ammunition';
  if (category.includes('heal')) return 'healing';
  if (category.includes('boost')) return 'boosts';
  if (category.includes('armor') || category.includes('headgear') || category.includes('vest'))
    return 'armor';
  if (category.includes('attachment')) return 'attachments';
  return null;
}

function notableItem(itemId: string): string | null {
  const value = item(itemId);
  if (/panzer|rocket/iu.test(value)) return 'Panzerfaust';
  if (/m24/iu.test(value)) return 'M24';
  if (/beryl/iu.test(value)) return 'Beryl M762';
  if (/bluezonegrenade/iu.test(value)) return '蓝区手雷';
  if (/flashbang/iu.test(value)) return '闪光弹';
  if (/firstaid/iu.test(value)) return '急救包';
  if (/bandage/iu.test(value)) return '绷带';
  return null;
}

export function extractLootStats(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): LootStats[] {
  const result: LootStats[] = [];
  for (const playerId of teamIds) {
    const loot = playerEvents(events, teamIds, playerId).filter(
      (event) => event.type === 'ITEM_LOOT',
    );
    if (!loot.length) continue;
    const stats: LootStats = {
      id: `loot-${playerId}`,
      playerId,
      lootBoxPickups: loot.length,
      weapons: 0,
      throwables: 0,
      ammunition: 0,
      healing: 0,
      boosts: 0,
      armor: 0,
      attachments: 0,
      notableItems: [],
      evidenceIds: sortedEvidence(loot),
    };
    for (const event of loot) {
      const category = itemCategory(event);
      if (category) stats[category] += 1;
      const notable = notableItem(event.itemId ?? '');
      if (notable && !stats.notableItems.includes(notable)) stats.notableItems.push(notable);
    }
    result.push(stats);
  }
  return result.sort((left, right) => left.playerId.localeCompare(right.playerId));
}

type LootCategory =
  'weapons' | 'throwables' | 'ammunition' | 'healing' | 'boosts' | 'armor' | 'attachments';

const ACTIVITY_FIELDS: Record<'pickup' | 'drop', Record<LootCategory, keyof LootActivityStats>> = {
  pickup: {
    weapons: 'pickupWeapons',
    throwables: 'pickupThrowables',
    ammunition: 'pickupAmmunition',
    healing: 'pickupHealing',
    boosts: 'pickupBoosts',
    armor: 'pickupArmor',
    attachments: 'pickupAttachments',
  },
  drop: {
    weapons: 'dropWeapons',
    throwables: 'dropThrowables',
    ammunition: 'dropAmmunition',
    healing: 'dropHealing',
    boosts: 'dropBoosts',
    armor: 'dropArmor',
    attachments: 'dropAttachments',
  },
};

function incrementLootCategory(
  stats: LootActivityStats,
  direction: 'pickup' | 'drop',
  category: LootCategory | null,
): void {
  if (!category) return;
  const field = ACTIVITY_FIELDS[direction][category];
  const numericStats = stats as unknown as Record<string, number>;
  numericStats[field] = (numericStats[field] ?? 0) + 1;
}

function cosmeticKind(event: NormalizedTelemetryEvent): 'skin' | 'clothing' | null {
  const value =
    `${event.itemId ?? ''} ${event.itemCategory ?? ''} ${event.itemSubCategory ?? ''}`.toLowerCase();
  if (!/skin|cosmetic|costume|outfit|clothing|apparel|fashion/u.test(value)) return null;
  return /costume|outfit|clothing|apparel|fashion/u.test(value) ? 'clothing' : 'skin';
}

/**
 * Count item movement without pretending that every pickup is rare loot.
 * Cosmetic fields use only explicit item-event metadata; kill/settlement
 * payloads are deliberately not interpreted as pickup records.
 */
export function extractLootActivityStats(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): LootActivityStats[] {
  const result: LootActivityStats[] = [];
  for (const playerId of teamIds) {
    const owned = playerEvents(events, teamIds, playerId);
    const pickups = owned.filter((event) => event.type === 'ITEM_ACQUIRE');
    const drops = owned.filter((event) => event.type === 'ITEM_DROP');
    const lootBoxes = owned.filter((event) => event.type === 'ITEM_LOOT');
    if (!pickups.length && !drops.length && !lootBoxes.length) continue;
    const stats: LootActivityStats = {
      id: `loot-activity-${playerId}`,
      playerId,
      pickupEvents: pickups.length,
      dropEvents: drops.length,
      lootBoxPickups: lootBoxes.length,
      pickupWeapons: 0,
      pickupThrowables: 0,
      pickupAmmunition: 0,
      pickupHealing: 0,
      pickupBoosts: 0,
      pickupArmor: 0,
      pickupAttachments: 0,
      dropWeapons: 0,
      dropThrowables: 0,
      dropAmmunition: 0,
      dropHealing: 0,
      dropBoosts: 0,
      dropArmor: 0,
      dropAttachments: 0,
      cosmeticPickups: 0,
      clothingPickups: 0,
      notableItems: [],
      evidenceIds: sortedEvidence([...pickups, ...drops, ...lootBoxes]),
    };
    for (const event of pickups) {
      incrementLootCategory(stats, 'pickup', itemCategory(event));
      const cosmetic = cosmeticKind(event);
      if (cosmetic) {
        stats.cosmeticPickups += 1;
        if (cosmetic === 'clothing') stats.clothingPickups += 1;
      }
      const notable = notableItem(event.itemId ?? '');
      if (notable && !stats.notableItems.includes(notable)) stats.notableItems.push(notable);
    }
    for (const event of drops) incrementLootCategory(stats, 'drop', itemCategory(event));
    for (const event of lootBoxes) {
      const notable = notableItem(event.itemId ?? '');
      if (notable && !stats.notableItems.includes(notable)) stats.notableItems.push(notable);
    }
    result.push(stats);
  }
  return result.sort((left, right) => left.playerId.localeCompare(right.playerId));
}

export function extractVehicleTrunkTransfers(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): VehicleTrunkTransfer[] {
  return events
    .filter(
      (event) =>
        inMatch(event) &&
        (event.type === 'ITEM_TRUNK_PUT' || event.type === 'ITEM_TRUNK_PICKUP') &&
        event.actorId !== null &&
        teamIds.has(event.actorId) &&
        Boolean(event.itemId),
    )
    .sort((left, right) => timeOf(left) - timeOf(right) || left.id.localeCompare(right.id))
    .map((event, index) => ({
      id: `trunk-transfer-${index + 1}`,
      direction: event.type === 'ITEM_TRUNK_PUT' ? 'PUT' : 'PICKUP',
      playerId: event.actorId as string,
      item: item(event.itemId),
      ...(event.itemCategory ? { itemCategory: event.itemCategory } : {}),
      ...(event.itemSubCategory ? { itemSubCategory: event.itemSubCategory } : {}),
      vehicleId: event.vehicleId,
      vehicleType: event.vehicleType,
      stackCount: event.stackCount ?? null,
      time: event.timeSeconds,
      evidenceIds: [event.id],
    }));
}

export function extractEnvironmentStats(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): EnvironmentStats[] {
  const result: EnvironmentStats[] = [];
  for (const playerId of teamIds) {
    const owned = playerEvents(events, teamIds, playerId);
    const interaction = owned.filter((event) => event.type === 'OBJECT_INTERACTION');
    const destroyed = owned.filter((event) => event.type === 'OBJECT_DESTROY');
    const vaults = owned.filter((event) => event.type === 'VAULT');
    if (!interaction.length && !destroyed.length && !vaults.length) continue;
    const destroyedObjects = new Map<string, number>();
    for (const event of destroyed) {
      const objectType = event.objectType?.trim() || '未命名物体';
      destroyedObjects.set(objectType, (destroyedObjects.get(objectType) ?? 0) + 1);
    }
    const terrainActions = destroyed.filter((event) =>
      /dig|terrain|ground|hole|crater|deform/u.test(`${event.objectType ?? ''} ${event.rawType}`),
    ).length;
    result.push({
      id: `environment-${playerId}`,
      playerId,
      doorOpens: interaction.filter((event) => /opening/iu.test(event.objectStatus ?? '')).length,
      doorCloses: interaction.filter((event) => /closing/iu.test(event.objectStatus ?? '')).length,
      windowsDestroyed: destroyed.filter((event) => /window/iu.test(event.objectType ?? '')).length,
      fencesDestroyed: destroyed.filter((event) => /fence/iu.test(event.objectType ?? '')).length,
      vaults: vaults.length,
      ledgeGrabs: vaults.filter((event) => event.isLedgeGrab === true).length,
      vaultsOnVehicle: vaults.filter((event) => event.isVaultOnVehicle === true).length,
      destroyedObjects: [...destroyedObjects.entries()]
        .map(([objectType, count]) => ({ objectType, count }))
        .sort(
          (left, right) =>
            right.count - left.count || left.objectType.localeCompare(right.objectType),
        ),
      terrainActions,
      eventTimes: [
        ...new Set(
          [...interaction, ...destroyed, ...vaults]
            .map((event) => event.timeSeconds)
            .filter((time): time is number => time !== null),
        ),
      ].sort((left, right) => left - right),
      evidenceIds: sortedEvidence([...interaction, ...destroyed, ...vaults]),
    });
  }
  return result.sort((left, right) => left.playerId.localeCompare(right.playerId));
}

export function extractArmorBreakFacts(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): ArmorBreakFact[] {
  const armorEvents = events.filter(
    (event) =>
      event.type === 'ARMOR_DESTROY' &&
      inMatch(event) &&
      event.actorId &&
      teamIds.has(event.actorId),
  );
  return armorEvents
    .sort((left, right) => timeOf(left) - timeOf(right) || left.id.localeCompare(right.id))
    .map((event) => {
      const followUp = event.attackId
        ? events.find(
            (candidate) =>
              candidate.attackId === event.attackId &&
              (candidate.type === 'KNOCK' || candidate.type === 'KILL'),
          )
        : undefined;
      return {
        id: `armor-break-${event.id}`,
        actorPlayerId: event.actorId as string,
        victimPlayerId: event.victimId,
        armorItem: event.itemId,
        armorSlot: event.itemSubCategory ?? null,
        weapon: weapon(event.weaponId),
        damageReason: event.damageReason ?? null,
        distanceMeters: event.distanceMeters,
        attackId: event.attackId,
        time: event.timeSeconds,
        followUp: followUp?.type === 'KNOCK' ? 'KNOCK' : followUp?.type === 'KILL' ? 'KILL' : null,
        evidenceIds: [...new Set([event.id, ...(followUp ? [followUp.id] : [])])],
      } satisfies ArmorBreakFact;
    });
}

function vehicleEvent(event: NormalizedTelemetryEvent): boolean {
  return (
    event.type === 'WHEEL_DESTROY' ||
    event.type === 'VEHICLE_DAMAGE' ||
    event.type === 'VEHICLE_DESTROY' ||
    isVehicleWeapon(event)
  );
}

export function extractVehicleImpactFacts(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): VehicleImpactFact[] {
  const grouped = new Map<string, NormalizedTelemetryEvent[]>();
  for (const event of events) {
    if (!event.actorId || !teamIds.has(event.actorId) || !inMatch(event) || !event.attackId)
      continue;
    const key = `${event.actorId}:${event.attackId}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(event);
    grouped.set(key, bucket);
  }
  const result: VehicleImpactFact[] = [];
  for (const [key, groupedEvents] of grouped) {
    if (!groupedEvents.some(vehicleEvent)) continue;
    const wheels = groupedEvents.filter((event) => event.type === 'WHEEL_DESTROY');
    const vehicleDamage = groupedEvents
      .filter((event) => event.type === 'VEHICLE_DAMAGE')
      .reduce((sum, event) => sum + event.vehicleDamage, 0);
    const playerDamage = groupedEvents
      .filter((event) => event.type === 'DAMAGE' && event.victimId)
      .reduce((sum, event) => sum + event.damage, 0);
    const knocks = groupedEvents.filter((event) => event.type === 'KNOCK').length;
    const kills = groupedEvents.filter((event) => event.type === 'KILL').length;
    const vehicleId = groupedEvents.find((event) => event.vehicleId)?.vehicleId ?? null;
    const vehicleType = groupedEvents.find((event) => event.vehicleType)?.vehicleType ?? null;
    const destroyedDirectly = groupedEvents.filter(
      (event) => event.type === 'VEHICLE_DESTROY',
    ).length;
    const lastTime = Math.max(...groupedEvents.map((event) => event.timeSeconds ?? 0));
    const linkedDestroy =
      destroyedDirectly > 0
        ? 0
        : events.filter(
            (event) =>
              event.type === 'VEHICLE_DESTROY' &&
              event.actorId === groupedEvents[0]?.actorId &&
              vehicleId !== null &&
              event.vehicleId === vehicleId &&
              event.timeSeconds !== null &&
              event.timeSeconds >= (groupedEvents[0]?.timeSeconds ?? 0) &&
              event.timeSeconds <= lastTime + 10,
          ).length;
    // Vehicle damage is already aggregated by VehicleStats. Keep attack-level
    // facts only when they form a useful chain (wheel destruction, a vehicle
    // destruction, or a player knock/kill), rather than persisting hundreds of
    // ordinary bullet-to-vehicle ticks.
    if (!wheels.length && knocks <= 0 && kills <= 0 && destroyedDirectly <= 0 && linkedDestroy <= 0)
      continue;
    const [playerId, attackId] = key.split(':');
    if (!playerId || !attackId) continue;
    result.push({
      id: `vehicle-impact-${playerId}-${attackId}`,
      playerId,
      attackId,
      vehicleId,
      vehicleType,
      wheelsDestroyed: wheels.length,
      vehicleDamage: Math.round(vehicleDamage * 100) / 100,
      playerDamage: Math.round(playerDamage * 100) / 100,
      knocks,
      kills,
      vehicleDestroyed: destroyedDirectly + linkedDestroy,
      time: groupedEvents.reduce<number | null>(
        (earliest, event) =>
          earliest === null || (event.timeSeconds !== null && event.timeSeconds < earliest)
            ? event.timeSeconds
            : earliest,
        null,
      ),
      evidenceIds: sortedEvidence([
        ...groupedEvents,
        ...events.filter(
          (event) =>
            event.type === 'VEHICLE_DESTROY' && linkedDestroy > 0 && event.vehicleId === vehicleId,
        ),
      ]),
    });
  }
  return result.sort(
    (left, right) =>
      (left.time ?? Number.POSITIVE_INFINITY) - (right.time ?? Number.POSITIVE_INFINITY) ||
      left.id.localeCompare(right.id),
  );
}
