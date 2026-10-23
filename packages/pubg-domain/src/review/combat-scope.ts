import type { NormalizedTelemetryEvent } from './telemetry-events.js';

const OFFENSIVE_TYPES = new Set<NormalizedTelemetryEvent['type']>(['DAMAGE', 'KNOCK', 'KILL']);

function known(value: string | null): value is string {
  return Boolean(value);
}

function opponent(value: string | null, teamIds: Set<string>): value is string {
  return known(value) && !teamIds.has(value);
}

function effectiveDamage(event: NormalizedTelemetryEvent): boolean {
  return event.damage > 0 || event.hit;
}

/** Lobby/ready-room combat is retained for fun facts, never for a fight. */
export function isInMatchCombatPhase(event: NormalizedTelemetryEvent): boolean {
  return event.phase !== 'pre_match';
}

export function isTrackedOffensiveEvent(
  event: NormalizedTelemetryEvent,
  teamIds: Set<string>,
): boolean {
  return (
    isInMatchCombatPhase(event) &&
    OFFENSIVE_TYPES.has(event.type) &&
    event.actorId !== null &&
    teamIds.has(event.actorId) &&
    opponent(event.victimId, teamIds) &&
    (event.type !== 'DAMAGE' || effectiveDamage(event))
  );
}

export function isOpponentOffensiveEvent(
  event: NormalizedTelemetryEvent,
  teamIds: Set<string>,
): boolean {
  return (
    isInMatchCombatPhase(event) &&
    OFFENSIVE_TYPES.has(event.type) &&
    opponent(event.actorId, teamIds) &&
    event.victimId !== null &&
    teamIds.has(event.victimId) &&
    (event.type !== 'DAMAGE' || effectiveDamage(event))
  );
}

export function isTrackedReviveEvent(
  event: NormalizedTelemetryEvent,
  teamIds: Set<string>,
): boolean {
  return (
    isInMatchCombatPhase(event) &&
    event.type === 'REVIVE' &&
    event.actorId !== null &&
    teamIds.has(event.actorId) &&
    event.victimId !== null &&
    teamIds.has(event.victimId)
  );
}

export function isOpponentReviveEvent(
  event: NormalizedTelemetryEvent,
  teamIds: Set<string>,
): boolean {
  return (
    isInMatchCombatPhase(event) &&
    event.type === 'REVIVE' &&
    opponent(event.actorId, teamIds) &&
    opponent(event.victimId, teamIds) &&
    // An opponent-only revive is useful only when the telemetry proves that
    // both players belong to the same opponent squad. Without team IDs it is
    // indistinguishable from a global event and is ignored.
    Boolean(event.actorTeamId && event.victimTeamId && event.actorTeamId === event.victimTeamId)
  );
}

export function isRelevantCombatEvent(
  event: NormalizedTelemetryEvent,
  teamIds: Set<string>,
): boolean {
  return (
    isTrackedOffensiveEvent(event, teamIds) ||
    isOpponentOffensiveEvent(event, teamIds) ||
    isTrackedReviveEvent(event, teamIds) ||
    isOpponentReviveEvent(event, teamIds)
  );
}

export function isTrackedCombatEvent(
  event: NormalizedTelemetryEvent,
  teamIds: Set<string>,
): boolean {
  return isTrackedOffensiveEvent(event, teamIds) || isTrackedReviveEvent(event, teamIds);
}

export function combatEventKey(event: NormalizedTelemetryEvent): string {
  // Killer/finisher can be represented by separate telemetry records. A final
  // kill belongs to the victim. Never collapse all records with an unknown
  // victim into one event; use the strongest available identity instead.
  if (event.type === 'KILL') {
    if (event.victimId) return `KILL:victim:${event.victimId}`;
    if (event.dbnoId) return `KILL:dbno:${event.dbnoId}`;
    if (event.attackId) return `KILL:attack:${event.actorId ?? ''}:${event.attackId}`;
    return `KILL:event:${event.id}`;
  }
  if (event.type === 'KNOCK') {
    if (event.dbnoId) return `KNOCK:dbno:${event.dbnoId}`;
    if (event.attackId && event.victimId) {
      return `KNOCK:attack:${event.actorId ?? ''}:${event.attackId}:${event.victimId}`;
    }
    // Without dBNOId/attackId, only records for the same actor/victim at the
    // same timestamp are safe duplicates. A later knock after a revive must
    // remain countable.
    if (event.actorId && event.victimId && event.timeSeconds !== null) {
      return `KNOCK:time:${event.actorId}:${event.victimId}:${event.timeSeconds}`;
    }
    return `KNOCK:event:${event.id}`;
  }
  if (event.type === 'REVIVE')
    return `REVIVE:${event.actorId ?? ''}:${event.victimId ?? ''}:${event.timeSeconds ?? event.id}`;
  return event.id;
}

export function dedupeRelevantCombatEvents(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): NormalizedTelemetryEvent[] {
  const seen = new Set<string>();
  return events
    .filter((event) => isRelevantCombatEvent(event, teamIds))
    .filter((event) => {
      const key = combatEventKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
