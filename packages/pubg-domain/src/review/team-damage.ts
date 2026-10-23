import type { FlashStats, TeamDamageFact, TeamDamageSource, TeamVehicleEvent } from './types.js';
import type { NormalizedTelemetryEvent } from './telemetry-events.js';
import {
  isExplosiveWeapon,
  isFlashWeapon,
  isMeleeWeapon,
  isVehicleWeapon,
  meleeKindOf,
} from './telemetry-events.js';

function weaponOf(event: NormalizedTelemetryEvent): string | null {
  return event.weaponId ?? event.itemId;
}

function trackedPair(event: NormalizedTelemetryEvent, teamIds: Set<string>): boolean {
  return Boolean(
    event.actorId &&
    event.victimId &&
    event.actorId !== event.victimId &&
    teamIds.has(event.actorId) &&
    teamIds.has(event.victimId),
  );
}

function damageValue(event: NormalizedTelemetryEvent): number {
  return event.type === 'VEHICLE_DAMAGE' && event.vehicleDamage > 0
    ? event.vehicleDamage
    : event.damage;
}

function hitConfirmed(event: NormalizedTelemetryEvent): boolean {
  return event.type === 'VEHICLE_DAMAGE'
    ? event.vehicleDamage > 0 || event.damage > 0 || event.hit
    : event.type === 'DAMAGE' && (event.damage > 0 || event.hit);
}

export function teamDamageSource(event: NormalizedTelemetryEvent): TeamDamageSource | null {
  if (!['DAMAGE', 'VEHICLE_DAMAGE'].includes(event.type)) return null;
  if (isVehicleWeapon(event)) return 'VEHICLE';
  if (isMeleeWeapon(weaponOf(event), event.damageTypeCategory)) return 'MELEE';
  if (isExplosiveWeapon(weaponOf(event))) return 'EXPLOSIVE';
  return 'GUN';
}

/** Aggregate only real friendly-fire hit records. Attack/miss records are excluded. */
export function extractTeamDamageFacts(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): TeamDamageFact[] {
  const grouped = new Map<string, TeamDamageFact>();
  for (const event of events) {
    if (!trackedPair(event, teamIds) || !hitConfirmed(event)) continue;
    const source = teamDamageSource(event);
    if (!source || !event.actorId || !event.victimId) continue;
    // Keep explicit punches, kicks and other melee weapons separate. A single
    // player can hit a teammate with both feet and fists in the same match;
    // merging the buckets would make the ledger lose the action detail.
    const meleeKind =
      source === 'MELEE' ? meleeKindOf(weaponOf(event), event.damageTypeCategory) : null;
    const key = `${event.actorId}:${event.victimId}:${source}:${meleeKind}:${event.phase ?? 'unknown'}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.hitCount += 1;
      existing.damage += damageValue(event);
      if (event.timeSeconds !== null) existing.timestamps.push(event.timeSeconds);
      if (!existing.weapon && weaponOf(event)) existing.weapon = weaponOf(event)!;
      if (!existing.damageTypeCategory && event.damageTypeCategory)
        existing.damageTypeCategory = event.damageTypeCategory;
      if (!existing.vehicleId && event.vehicleId) existing.vehicleId = event.vehicleId;
      existing.evidenceIds.push(event.id);
      continue;
    }
    const timestamps = event.timeSeconds === null ? [] : [event.timeSeconds];
    grouped.set(key, {
      id: `team-damage-${grouped.size + 1}`,
      actorPlayerId: event.actorId,
      victimPlayerId: event.victimId,
      hitCount: 1,
      damage: damageValue(event),
      source,
      timestamp: event.timeSeconds,
      timestamps,
      ...(weaponOf(event) ? { weapon: weaponOf(event)! } : {}),
      ...(event.damageTypeCategory ? { damageTypeCategory: event.damageTypeCategory } : {}),
      ...(meleeKind ? { meleeKind } : {}),
      ...(event.vehicleId ? { vehicleId: event.vehicleId } : {}),
      ...(event.phase ? { phase: event.phase } : {}),
      evidenceIds: [event.id],
    });
  }
  return [...grouped.values()].map((fact) => ({
    ...fact,
    damage: Math.round(fact.damage * 100) / 100,
    timestamps: [...new Set(fact.timestamps)].sort((left, right) => left - right),
    evidenceIds: [...new Set(fact.evidenceIds)],
  }));
}

function vehicleEventKey(event: NormalizedTelemetryEvent): string {
  if (event.type === 'KILL') {
    return `KILL:${event.victimId ?? event.dbnoId ?? event.attackId ?? event.id}`;
  }
  if (event.type === 'KNOCK') {
    return `KNOCK:${event.dbnoId ?? `${event.victimId ?? ''}:${event.attackId ?? event.timeSeconds ?? event.id}`}`;
  }
  return `HIT:${event.id}`;
}

/** Keep collision hit/knock/kill facts separate from distance and ride facts. */
export function extractTeamVehicleEvents(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): TeamVehicleEvent[] {
  const confirmedDriverVehicles = new Set<string>();
  for (const event of events) {
    if (event.actorId && event.vehicleId && event.driverConfirmed === true) {
      confirmedDriverVehicles.add(`${event.actorId}:${event.vehicleId}`);
    }
  }
  const seen = new Set<string>();
  const result: TeamVehicleEvent[] = [];
  for (const event of events) {
    if (!trackedPair(event, teamIds) || !event.actorId || !event.victimId) continue;
    const type: TeamVehicleEvent['type'] =
      event.type === 'KNOCK' ? 'KNOCK' : event.type === 'KILL' ? 'KILL' : 'HIT';
    if (type === 'HIT' && !['DAMAGE', 'VEHICLE_DAMAGE'].includes(event.type)) continue;
    if (type !== 'HIT' && !['KNOCK', 'KILL'].includes(event.type)) continue;
    if (!isVehicleWeapon(event)) continue;
    if (type === 'HIT' && !hitConfirmed(event)) continue;
    const key = `${type}:${event.actorId}:${event.victimId}:${vehicleEventKey(event)}:${event.phase ?? 'unknown'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: `team-vehicle-${result.length + 1}`,
      type,
      actorPlayerId: event.actorId,
      victimPlayerId: event.victimId,
      damage: damageValue(event),
      timestamp: event.timeSeconds,
      vehicleId: event.vehicleId,
      driverConfirmed:
        event.driverConfirmed === true ||
        Boolean(
          event.vehicleId && confirmedDriverVehicles.has(`${event.actorId}:${event.vehicleId}`),
        ),
      ...(event.phase ? { phase: event.phase } : {}),
      evidenceIds: [event.id],
    });
  }
  return result;
}

export function extractFlashStats(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): FlashStats[] {
  const grouped = new Map<string, FlashStats>();
  const counted = new Set<string>();
  const lastByWeapon = new Map<
    string,
    { type: NormalizedTelemetryEvent['type']; time: number | null; key: string }
  >();
  for (const event of events) {
    // Depending on the game mode, a flash is represented by either the
    // weapon attack record or LogPlayerUseThrowable. Both may be emitted for
    // the same use, so attackId is used only as a de-duplication key.
    if (
      !['ATTACK', 'THROWABLE_USE'].includes(event.type) ||
      !event.actorId ||
      !teamIds.has(event.actorId) ||
      !isFlashWeapon(weaponOf(event))
    )
      continue;
    const signature = `${event.actorId}:${weaponOf(event) ?? 'flash'}`;
    const attackKey = event.attackId ? `${event.actorId}:${event.attackId}` : null;
    const previous = lastByWeapon.get(signature);
    const isDuplicateRecord =
      !attackKey &&
      previous &&
      previous.type !== event.type &&
      previous.time !== null &&
      event.timeSeconds !== null &&
      Math.abs(previous.time - event.timeSeconds) <= 0.5;
    const key = attackKey ?? (isDuplicateRecord ? previous.key : event.id);
    if (counted.has(key)) continue;
    counted.add(key);
    const current = grouped.get(event.actorId) ?? {
      id: `flash-${event.actorId}`,
      playerId: event.actorId,
      uses: 0,
      evidenceIds: [],
    };
    current.uses += 1;
    current.evidenceIds.push(event.id);
    grouped.set(event.actorId, current);
    lastByWeapon.set(signature, { type: event.type, time: event.timeSeconds, key });
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    evidenceIds: [...new Set(item.evidenceIds)],
  }));
}
