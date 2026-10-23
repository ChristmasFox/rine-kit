import type { HeavyWeaponStats, WeaponStats } from './types.js';
import type { NormalizedTelemetryEvent } from './telemetry-events.js';
import { isHeavyWeapon } from './telemetry-events.js';
import { dedupeRelevantCombatEvents, isTrackedOffensiveEvent } from './combat-scope.js';

function canonicalWeapon(value: string | null): string | null {
  if (!value) return null;
  if (/panzer|rocket/i.test(value)) return 'Panzerfaust';
  return value.replace(/^Item_Weapon_/iu, '').replace(/_C$/iu, '');
}

function eventWeapon(event: NormalizedTelemetryEvent): string | null {
  return canonicalWeapon(event.weaponId ?? event.itemId);
}

function heavyWeaponForEvent(
  event: NormalizedTelemetryEvent,
  heavyByAttack: Map<string, string>,
): string | null {
  const explicit = eventWeapon(event);
  if (explicit && isHeavyWeapon(explicit)) return explicit;
  if (!event.attackId || !event.actorId) return null;
  return heavyByAttack.get(`${event.actorId}:${event.attackId}`) ?? null;
}

/**
 * Return a stable impact key for one weapon hit. A damage, knock and final
 * kill record can describe the same impact, while one splash attack may hit
 * several victims and must retain one hit per victim.
 */
function heavyHitKey(event: NormalizedTelemetryEvent): string | null {
  if (event.type === 'DAMAGE' && !event.hit) return null;
  if (
    event.type === 'VEHICLE_DAMAGE' &&
    !(event.vehicleDamage > 0 || event.damage > 0 || event.hit)
  )
    return null;
  if ((event.type === 'KNOCK' || event.type === 'KILL') && !event.attackId) return null;
  if (!['DAMAGE', 'VEHICLE_DAMAGE', 'KNOCK', 'KILL'].includes(event.type)) return null;
  const target = event.victimId ?? event.vehicleId ?? event.dbnoId ?? 'outcome';
  return event.attackId ? `attack:${event.attackId}:target:${target}` : `event:${event.id}`;
}

export function extractHeavyWeaponStats(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): HeavyWeaponStats[] {
  const stats = new Map<string, HeavyWeaponStats>();
  const heavyByAttack = new Map<string, string>();
  const dedupedCombatIds = new Set(
    dedupeRelevantCombatEvents(events, teamIds).map((event) => event.id),
  );
  const countedAttacks = new Set<string>();
  const countedHits = new Set<string>();
  const countedVehicleDestroys = new Set<string>();
  for (const event of events) {
    const weapon = eventWeapon(event);
    if (!weapon || !isHeavyWeapon(weapon) || !event.actorId || !event.attackId) continue;
    heavyByAttack.set(`${event.actorId}:${event.attackId}`, weapon);
  }
  const get = (playerId: string, weapon: string): HeavyWeaponStats => {
    const key = `${playerId}:${weapon}`;
    const existing = stats.get(key);
    if (existing) return existing;
    const created: HeavyWeaponStats = {
      playerId,
      weapon,
      pickupEvents: 0,
      dropEvents: 0,
      shots: 0,
      hits: 0,
      playerDamage: 0,
      vehicleDamage: 0,
      knocks: 0,
      kills: 0,
      vehiclesDestroyed: 0,
      evidenceIds: [],
    };
    stats.set(key, created);
    return created;
  };
  for (const event of events) {
    const playerId = event.actorId;
    if (!playerId || !teamIds.has(playerId)) continue;
    const rawWeapon = heavyWeaponForEvent(event, heavyByAttack);
    if (!rawWeapon) continue;
    const validCombatEvent =
      event.type === 'DAMAGE' || event.type === 'KNOCK' || event.type === 'KILL'
        ? isTrackedOffensiveEvent(event, teamIds) && dedupedCombatIds.has(event.id)
        : true;
    if (!validCombatEvent) continue;
    const current = get(playerId, rawWeapon);
    current.evidenceIds.push(event.id);
    if (event.type === 'ITEM_ACQUIRE') current.pickupEvents += 1;
    if (event.type === 'ITEM_DROP') current.dropEvents += 1;
    if (event.type === 'ATTACK' || event.type === 'THROWABLE_USE') {
      // LogWeaponFireCount is an aggregate counter and is intentionally not
      // normalized as a shot. LogPlayerAttack plus attackId is the preferred
      // per-shot signal. Some telemetry versions omit that attack record for
      // throwable weapons, so a standalone LogPlayerUseThrowable is a
      // deterministic fallback; the shared attackId prevents double-counting
      // when both records are present.
      const attackKey = event.attackId ? `${playerId}:${rawWeapon}:${event.attackId}` : event.id;
      if (!countedAttacks.has(attackKey)) {
        countedAttacks.add(attackKey);
        current.shots += 1;
      }
    }
    if (event.type === 'DAMAGE') {
      const hitKey = heavyHitKey(event);
      const countedHitKey = hitKey ? `${playerId}:${rawWeapon}:${hitKey}` : null;
      if (countedHitKey && !countedHits.has(countedHitKey)) {
        countedHits.add(countedHitKey);
        current.hits += 1;
      }
      if (event.victimId) current.playerDamage += event.damage;
      current.vehicleDamage += event.vehicleDamage;
    }
    if (event.type === 'KNOCK') {
      current.knocks += 1;
      const hitKey = heavyHitKey(event);
      const countedHitKey = hitKey ? `${playerId}:${rawWeapon}:${hitKey}` : null;
      if (countedHitKey && !countedHits.has(countedHitKey)) {
        countedHits.add(countedHitKey);
        current.hits += 1;
      }
    }
    if (event.type === 'KILL') {
      current.kills += 1;
      const hitKey = heavyHitKey(event);
      const countedHitKey = hitKey ? `${playerId}:${rawWeapon}:${hitKey}` : null;
      if (countedHitKey && !countedHits.has(countedHitKey)) {
        countedHits.add(countedHitKey);
        current.hits += 1;
      }
    }
    if (event.type === 'VEHICLE_DAMAGE') {
      const vehicleDamage = event.vehicleDamage || event.damage;
      const hitKey = heavyHitKey(event);
      const countedHitKey = hitKey ? `${playerId}:${rawWeapon}:${hitKey}` : null;
      if (countedHitKey && !countedHits.has(countedHitKey)) {
        countedHits.add(countedHitKey);
        current.hits += 1;
      }
      current.vehicleDamage += vehicleDamage;
    }
    if (event.type === 'VEHICLE_DESTROY') {
      const destroyKey = event.vehicleId
        ? `${playerId}:${rawWeapon}:${event.vehicleId}`
        : event.attackId
          ? `${playerId}:${rawWeapon}:attack:${event.attackId}`
          : event.id;
      if (!countedVehicleDestroys.has(destroyKey)) {
        countedVehicleDestroys.add(destroyKey);
        current.vehiclesDestroyed += 1;
      }
    }
  }
  return [...stats.values()]
    .map((item) => ({ ...item, evidenceIds: [...new Set(item.evidenceIds)] }))
    .filter((item) => item.evidenceIds.length > 0)
    .sort(
      (left, right) =>
        left.playerId.localeCompare(right.playerId) || left.weapon.localeCompare(right.weapon),
    );
}

export function extractWeaponStats(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): WeaponStats[] {
  const stats = new Map<string, WeaponStats>();
  const dedupedCombatIds = new Set(
    dedupeRelevantCombatEvents(events, teamIds).map((event) => event.id),
  );
  const get = (playerId: string, weapon: string): WeaponStats => {
    const key = `${playerId}:${weapon}`;
    const existing = stats.get(key);
    if (existing) return existing;
    const created: WeaponStats = {
      playerId,
      weapon,
      shots: 0,
      hits: 0,
      damage: 0,
      knocks: 0,
      kills: 0,
      evidenceIds: [],
    };
    stats.set(key, created);
    return created;
  };
  for (const event of events) {
    if (!event.actorId || !teamIds.has(event.actorId)) continue;
    const weapon = canonicalWeapon(event.weaponId);
    if (!weapon || isHeavyWeapon(weapon)) continue;
    if (!['ATTACK', 'DAMAGE', 'KNOCK', 'KILL'].includes(event.type)) continue;
    if (
      ['DAMAGE', 'KNOCK', 'KILL'].includes(event.type) &&
      (!isTrackedOffensiveEvent(event, teamIds) || !dedupedCombatIds.has(event.id))
    )
      continue;
    const current = get(event.actorId, weapon);
    current.evidenceIds.push(event.id);
    if (event.type === 'ATTACK') current.shots += 1;
    if (event.type === 'DAMAGE') {
      if (event.hit) current.hits += 1;
      current.damage += event.damage;
    }
    if (event.type === 'KNOCK') current.knocks += 1;
    if (event.type === 'KILL') current.kills += 1;
  }
  return [...stats.values()]
    .map((item) => ({ ...item, evidenceIds: [...new Set(item.evidenceIds)] }))
    .filter((item) => item.evidenceIds.length > 0)
    .sort(
      (left, right) =>
        left.playerId.localeCompare(right.playerId) || left.weapon.localeCompare(right.weapon),
    );
}

export function isRocketStats(stats: HeavyWeaponStats): boolean {
  return /panzer|rocket|rpg/i.test(stats.weapon);
}
