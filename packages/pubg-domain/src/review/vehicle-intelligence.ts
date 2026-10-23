import type { VehicleStats } from './types.js';
import type { NormalizedTelemetryEvent } from './telemetry-events.js';

interface Point {
  x: number;
  y: number;
  z: number;
}

interface VehicleSegment {
  positionDistance: number;
  explicitDistance: number | null;
  driverConfirmed: boolean;
  lastPoint?: Point;
}

function addDistance(previous: Point | undefined, current: NormalizedTelemetryEvent): number {
  const location = current.location;
  if (!previous || !location || location.x === null || location.y === null) return 0;
  const z = location.z ?? previous.z;
  // PUBG position coordinates are centimetres; explicit rideDistance wins.
  return Math.hypot(location.x - previous.x, location.y - previous.y, z - previous.z) / 100;
}

function excludedVehicle(event: NormalizedTelemetryEvent): boolean {
  const value = `${event.vehicleType ?? ''} ${event.vehicleId ?? ''}`.toLowerCase();
  return /aircraft|transportaircraft|parachute|plane/u.test(value);
}

function hasVehicle(event: NormalizedTelemetryEvent): boolean {
  return Boolean(event.vehicleId || event.vehicleType) && !excludedVehicle(event);
}

function vehicleKey(event: NormalizedTelemetryEvent): string | null {
  // A type-only fallback keeps old/synthetic telemetry usable without
  // pretending that a vehicle model is a globally unique vehicle ID.
  return event.vehicleId ?? (event.vehicleType ? `type:${event.vehicleType}` : null);
}

export function extractVehicleStats(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): VehicleStats[] {
  const stats = new Map<string, VehicleStats>();
  const segments = new Map<string, VehicleSegment>();
  const get = (playerId: string): VehicleStats => {
    const existing = stats.get(playerId);
    if (existing) return existing;
    const created: VehicleStats = {
      playerId,
      id: `vehicle-${playerId}`,
      rideDistance: 0,
      driveDistance: 0,
      maxSpeed: 0,
      vehicleDamage: 0,
      vehiclesDestroyed: 0,
      driver: false,
      passenger: false,
      driverConfirmed: false,
      passengerConfirmed: false,
      evidenceIds: [],
    };
    stats.set(playerId, created);
    return created;
  };
  const segmentFor = (event: NormalizedTelemetryEvent): VehicleSegment | null => {
    if (!event.actorId) return null;
    const id = vehicleKey(event);
    if (!id) return null;
    const key = `${event.actorId}:${id}`;
    const segment = segments.get(key) ?? {
      positionDistance: 0,
      explicitDistance: null,
      driverConfirmed: false,
    };
    segments.set(key, segment);
    return segment;
  };
  const finalizeSegment = (
    playerId: string,
    vehicleKeyValue: string,
    event?: NormalizedTelemetryEvent,
  ): void => {
    const key = `${playerId}:${vehicleKeyValue}`;
    const segment = segments.get(key);
    if (!segment) return;
    const current = get(playerId);
    const distance = segment.explicitDistance ?? segment.positionDistance;
    current.rideDistance += distance;
    if (segment.driverConfirmed) current.driveDistance += distance;
    if (event?.speed !== null && event?.speed !== undefined)
      current.maxSpeed = Math.max(current.maxSpeed, event.speed);
    segments.delete(key);
  };

  for (const event of events) {
    const actorId = event.actorId;
    if (!actorId || !teamIds.has(actorId)) continue;
    if (
      !['VEHICLE_RIDE', 'VEHICLE_LEAVE', 'VEHICLE_DAMAGE', 'VEHICLE_DESTROY', 'POSITION'].includes(
        event.type,
      )
    )
      continue;
    if (!hasVehicle(event)) continue;
    const current = get(actorId);
    current.evidenceIds.push(event.id);
    if (event.speed !== null) current.maxSpeed = Math.max(current.maxSpeed, event.speed);
    if (event.driverConfirmed === true) {
      current.driverConfirmed = true;
      current.driver = true;
      // A source may confirm the driver on a collision/destroy record rather
      // than on the ride record. Propagate that fact to the open segment for
      // the same vehicle without inferring anything from seatIndex.
      const roleSegment = segmentFor(event);
      if (roleSegment) roleSegment.driverConfirmed = true;
    }
    if (event.passengerConfirmed === true) {
      current.passengerConfirmed = true;
      current.passenger = true;
    }

    if (event.type === 'VEHICLE_RIDE') {
      const segment = segmentFor(event);
      if (segment && event.distanceMeters !== null && event.distanceMeters > 0)
        segment.explicitDistance = event.distanceMeters;
      continue;
    }
    if (event.type === 'VEHICLE_LEAVE') {
      const segment = segmentFor(event);
      if (segment && event.distanceMeters !== null && event.distanceMeters > 0)
        segment.explicitDistance = event.distanceMeters;
      const id = vehicleKey(event);
      if (id) finalizeSegment(actorId, id, event);
      continue;
    }
    if (event.type === 'VEHICLE_DAMAGE') {
      current.vehicleDamage += event.vehicleDamage || event.damage;
      continue;
    }
    if (event.type === 'VEHICLE_DESTROY') {
      current.vehiclesDestroyed += 1;
      continue;
    }
    const segment = segmentFor(event);
    if (!segment || !event.location || event.location.x === null || event.location.y === null)
      continue;
    const point: Point = { x: event.location.x, y: event.location.y, z: event.location.z ?? 0 };
    segment.positionDistance += addDistance(segment.lastPoint, event);
    segment.lastPoint = point;
  }

  for (const key of segments.keys()) {
    const separator = key.indexOf(':');
    if (separator < 0) continue;
    finalizeSegment(key.slice(0, separator), key.slice(separator + 1));
  }

  return [...stats.values()]
    .map((item) => ({
      ...item,
      // Seat index is retained in normalized events, but is not treated as a
      // driver mapping until the source explicitly confirms the role.
      driver: item.driverConfirmed,
      passenger: item.passengerConfirmed,
      evidenceIds: [...new Set(item.evidenceIds)],
    }))
    .filter((item) => item.evidenceIds.length > 0)
    .sort((left, right) => left.playerId.localeCompare(right.playerId));
}
