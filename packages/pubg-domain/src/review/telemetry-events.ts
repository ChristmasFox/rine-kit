import { gunzipSync } from 'node:zlib';
import type { NormalizedMatch } from '../data/model.js';

export type NormalizedTelemetryEventType =
  | 'ATTACK'
  | 'DAMAGE'
  | 'KNOCK'
  | 'KILL'
  | 'REVIVE'
  | 'ITEM_ACQUIRE'
  | 'ITEM_DROP'
  | 'ITEM_USE'
  | 'ITEM_LOOT'
  | 'ITEM_TRUNK_PUT'
  | 'ITEM_TRUNK_PICKUP'
  | 'ITEM_ATTACH'
  | 'ITEM_DETACH'
  | 'THROWABLE_USE'
  | 'HEAL'
  | 'ARMOR_DESTROY'
  | 'WHEEL_DESTROY'
  | 'OBJECT_INTERACTION'
  | 'OBJECT_DESTROY'
  | 'VAULT'
  | 'VEHICLE_RIDE'
  | 'VEHICLE_LEAVE'
  | 'VEHICLE_DAMAGE'
  | 'VEHICLE_DESTROY'
  | 'POSITION';

export type TelemetryEventPhase = 'pre_match' | 'in_match' | 'unknown';

export type MeleeKind = 'PUNCH' | 'KICK' | 'OTHER';

export interface TelemetryLocation {
  label: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  reliable: boolean;
}

export interface NormalizedTelemetryEvent {
  id: string;
  type: NormalizedTelemetryEventType;
  rawType: string;
  timeSeconds: number | null;
  /** Set only from a reliable absolute/relative timestamp signal. */
  phase?: TelemetryEventPhase;
  actorId: string | null;
  victimId: string | null;
  actorTeamId: string | null;
  victimTeamId: string | null;
  weaponId: string | null;
  damageTypeCategory?: string | null;
  itemId: string | null;
  vehicleId: string | null;
  vehicleType: string | null;
  attackId: string | null;
  dbnoId: string | null;
  damage: number;
  vehicleDamage: number;
  kills: number;
  knocks: number;
  hit: boolean;
  seatIndex: number | null;
  driverConfirmed: boolean | null;
  passengerConfirmed: boolean | null;
  speed: number | null;
  distanceMeters: number | null;
  location: TelemetryLocation | null;
  /** Supplemental telemetry fields; omitted by old cached facts. */
  healAmount?: number;
  health?: number | null;
  blueZone?: boolean | null;
  redZone?: boolean | null;
  specialZone?: string | null;
  itemCategory?: string | null;
  itemSubCategory?: string | null;
  stackCount?: number | null;
  ownerTeamId?: string | null;
  creatorId?: string | null;
  parentItemId?: string | null;
  childItemId?: string | null;
  damageReason?: string | null;
  wheelIndex?: number | null;
  objectType?: string | null;
  objectStatus?: string | null;
  isLedgeGrab?: boolean | null;
  isVaultOnVehicle?: boolean | null;
}

type RawObject = Record<string, unknown>;

function objectValue(value: unknown): RawObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RawObject) : {};
}

function stringValue(value: unknown): string | null {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    (typeof value === 'object' && value !== null)
  )
    return null;
  const text = String(value).trim();
  return text || null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = stringValue(value);
    if (result) return result;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(?:true|false)$/iu.test(value.trim()))
    return value.trim().toLowerCase() === 'true';
  return null;
}

function correlationId(value: unknown): string | null {
  const id = stringValue(value);
  // PUBG uses -1 for an event without a usable attack/DBNO correlation.
  return id && id !== '-1' ? id : null;
}

function entityId(value: unknown): string | null {
  const entity = objectValue(value);
  return firstString(
    entity.accountId,
    entity.account_id,
    entity.playerId,
    entity.name,
    entity.playerName,
    value,
  );
}

function firstEntity(event: RawObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = entityId(event[key]);
    if (value) return value;
  }
  return null;
}

function firstEntityObject(event: RawObject, keys: string[]): RawObject | null {
  for (const key of keys) {
    const value = event[key];
    if (entityId(value)) return objectValue(value);
  }
  return null;
}

function entityTeamId(value: RawObject | null): string | null {
  return firstString(value?.teamId, value?.team_id);
}

function rawType(event: RawObject): string {
  return stringValue(event._T ?? event.type ?? event.eventType ?? event.name) ?? '';
}

function eventType(type: string): NormalizedTelemetryEventType | null {
  const normalized = type.replace(/^Log/u, '').toLowerCase();
  if (normalized.includes('itempickupfromlootbox')) return 'ITEM_LOOT';
  if (normalized.includes('itempickupfromvehicletrunk')) return 'ITEM_TRUNK_PICKUP';
  if (normalized.includes('itemputtovehicletrunk')) return 'ITEM_TRUNK_PUT';
  if (normalized.includes('itemuse')) return 'ITEM_USE';
  if (normalized.includes('itemattach')) return 'ITEM_ATTACH';
  if (normalized.includes('itemdetach')) return 'ITEM_DETACH';
  if (normalized === 'heal' || normalized.includes('playerheal')) return 'HEAL';
  if (normalized.includes('armordestroy')) return 'ARMOR_DESTROY';
  if (normalized.includes('wheeldestroy')) return 'WHEEL_DESTROY';
  if (normalized.includes('objectinteraction')) return 'OBJECT_INTERACTION';
  if (normalized.includes('objectdestroy') || normalized.includes('destroyprop'))
    return 'OBJECT_DESTROY';
  if (normalized.includes('vaultstart')) return 'VAULT';
  if (normalized.includes('playerattack') || normalized === 'weaponfire') return 'ATTACK';
  if (normalized.includes('playerdamage') || normalized.includes('takedamage')) return 'DAMAGE';
  if (normalized.includes('makegroggy') || normalized.includes('knock')) return 'KNOCK';
  if (normalized.includes('playerkill') || normalized === 'kill') return 'KILL';
  if (normalized.includes('playerrevive') || normalized.includes('revive')) return 'REVIVE';
  if (normalized.includes('itempickup') || normalized.includes('itemacquire'))
    return 'ITEM_ACQUIRE';
  if (normalized.includes('itemdrop')) return 'ITEM_DROP';
  if (normalized.includes('playerusethrowable') || normalized.includes('throwableuse'))
    return 'THROWABLE_USE';
  if (normalized.includes('vehicleride') || normalized.includes('vehicleenter'))
    return 'VEHICLE_RIDE';
  if (normalized.includes('vehicleleave') || normalized.includes('vehicleexit'))
    return 'VEHICLE_LEAVE';
  if (normalized.includes('vehicledamage')) return 'VEHICLE_DAMAGE';
  if (normalized.includes('vehicledestroy')) return 'VEHICLE_DESTROY';
  if (normalized.includes('playerposition') || normalized.includes('position')) return 'POSITION';
  return null;
}

function parseClock(value: string): number | null {
  const parts = value.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3)
    return null;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return parts[0]! * 60 + parts[1]!;
}

function epochMilliseconds(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric === null) return null;
  if (numeric > 100_000_000_000) return numeric;
  if (numeric > 1_000_000_000) return numeric * 1000;
  return null;
}

function matchStartMilliseconds(match: NormalizedMatch): number | null {
  const fromCreatedAt = Date.parse(String(match.createdAt ?? ''));
  if (Number.isFinite(fromCreatedAt)) return fromCreatedAt;
  return epochMilliseconds(match.timestamp);
}

function absoluteEventSeconds(event: RawObject, match: NormalizedMatch): number | null {
  const matchMs = matchStartMilliseconds(match);
  if (matchMs === null) return null;
  for (const value of [event._D, event.timestamp, event.createdAt, event.time]) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(text)) continue;
    const eventMs =
      epochMilliseconds(value) ?? (typeof value === 'string' ? Date.parse(value) : Number.NaN);
    if (!Number.isFinite(eventMs)) continue;
    const delta = (eventMs - matchMs) / 1000;
    // Do not turn a pre-match/invalid absolute value into a synthetic 00:00.
    if (delta >= 0 && delta < 24 * 60 * 60) return delta;
  }
  return null;
}

function eventPhase(event: RawObject, match: NormalizedMatch): TelemetryEventPhase {
  const gamePhase = commonGamePhase(event);
  if (gamePhase) return gamePhase;
  const matchMs = matchStartMilliseconds(match);
  if (matchMs !== null) {
    for (const value of [event._D, event.timestamp, event.createdAt, event.time]) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text || /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(text)) continue;
      const eventMs =
        epochMilliseconds(value) ?? (typeof value === 'string' ? Date.parse(value) : Number.NaN);
      if (!Number.isFinite(eventMs)) continue;
      const delta = (eventMs - matchMs) / 1000;
      if (delta >= 0 && delta < 24 * 60 * 60) return 'in_match';
      if (delta < 0 && delta >= -24 * 60 * 60) return 'pre_match';
    }
  }
  const rawValues = [event._D, event.timestamp, event.createdAt, event.time];
  for (const raw of rawValues) {
    const rawText = typeof raw === 'string' ? raw.trim() : '';
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/u.test(rawText) && (parseClock(rawText) ?? 0) > 0)
      return 'in_match';
  }
  const common = objectValue(event.common);
  const relative = [
    event.timeSeconds,
    event.elapsedSeconds,
    event.gameTime,
    event.game_time,
    event.elapsedTime,
    common.elapsedTime,
  ]
    .map(numberValue)
    .find((value): value is number => value !== null && value > 0 && value < 24 * 60 * 60);
  return relative === undefined ? 'unknown' : 'in_match';
}

/** PUBG's common.isGame is the blue-zone/safe-zone phase, not a clock. */
function commonGamePhase(event: RawObject): TelemetryEventPhase | null {
  const raw = objectValue(event.common).isGame;
  if (typeof raw === 'boolean') return raw ? 'in_match' : 'pre_match';
  const value = numberValue(raw);
  if (value === null) return null;
  if (value >= 0 && value < 1) return 'pre_match';
  // PUBG documents 1.0 as the first safe zone and each 0.5 step thereafter
  // as a blue-zone transition. All values >=1 are in-match phases.
  if (value >= 1) return 'in_match';
  return null;
}

function timeSeconds(event: RawObject, match: NormalizedMatch): number | null {
  const common = objectValue(event.common);
  const absolute = absoluteEventSeconds(event, match);
  if (absolute !== null) return absolute;

  const rawValues = [event._D, event.timestamp, event.createdAt, event.time];
  for (const raw of rawValues) {
    const rawText = typeof raw === 'string' ? raw.trim() : '';
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/u.test(rawText)) {
      const clock = parseClock(rawText);
      if (clock !== null && clock > 0) return clock;
    }
  }

  // Explicit game-clock fields are usable only when they carry a positive
  // value. A zero from a position record is commonly a missing timestamp.
  const explicitRelative = [
    event.timeSeconds,
    event.elapsedSeconds,
    event.gameTime,
    event.game_time,
  ]
    .map(numberValue)
    .find((value): value is number => value !== null && value > 0 && value < 24 * 60 * 60);
  if (explicitRelative !== undefined) return explicitRelative;

  const elapsed = numberValue(event.elapsedTime ?? common.elapsedTime);
  if (elapsed !== null && elapsed > 0 && elapsed < 24 * 60 * 60) return elapsed;
  // A small numeric `_D` is not a documented absolute timestamp and is not
  // safe to reinterpret as a game clock.
  return null;
}

function locationOf(event: RawObject): TelemetryLocation | null {
  const candidate =
    event.location ??
    event.position ??
    objectValue(event.character).location ??
    objectValue(event.attacker).location ??
    objectValue(event.victim).location ??
    objectValue(event.vehicle).location;
  const location = objectValue(candidate);
  const nested = objectValue(location.location ?? location.position);
  const source = Object.keys(nested).length ? nested : location;
  const x = numberValue(source.x ?? source.X);
  const y = numberValue(source.y ?? source.Y);
  const z = numberValue(source.z ?? source.Z);
  const label = stringValue(source.name ?? source.label ?? source.locationName);
  if (x === null && y === null && z === null && !label) return null;
  return { label, x, y, z, reliable: Boolean(label) };
}

function damageInfoObjects(event: RawObject): RawObject[] {
  return [
    event.damageInfo,
    event.killerDamageInfo,
    event.finishDamageInfo,
    event.dBNODamageInfo,
    event.dbnoDamageInfo,
  ].map(objectValue);
}

function weaponId(event: RawObject): string | null {
  const weapon = objectValue(event.weapon);
  const damageCauser = objectValue(event.damageCauser);
  const damageInfos = damageInfoObjects(event);
  return stringValue(
    firstString(
      event.weaponId,
      event.weapon_id,
      weapon.itemId,
      weapon.item_id,
      weapon.name,
      event.damageCauserName,
      event.damageCauser,
      damageCauser.itemId,
      damageCauser.name,
      ...damageInfos.flatMap((info) => [
        info.damageCauserName,
        info.damageCauser,
        info.itemId,
        info.item_id,
        info.name,
      ]),
      typeof event.weapon === 'string' ? event.weapon : null,
    ),
  );
}

function damageTypeCategory(event: RawObject): string | null {
  return firstString(
    event.damageTypeCategory,
    ...damageInfoObjects(event).map((info) => info.damageTypeCategory),
  );
}

function itemId(event: RawObject): string | null {
  const item = objectValue(event.item);
  return stringValue(event.itemId ?? event.item_id ?? item.itemId ?? item.item_id ?? item.name);
}

function vehicleId(event: RawObject): string | null {
  const vehicles = [
    event.vehicle,
    event.killerVehicle,
    event.attackerVehicle,
    event.victimVehicle,
    event.vehicleInfo,
  ].map(objectValue);
  return firstString(
    event.vehicleId,
    event.vehicle_id,
    ...vehicles.flatMap((vehicle) => [vehicle.id, vehicle.vehicleId, vehicle.vehicle_id]),
    typeof event.vehicle === 'string' ? event.vehicle : null,
  );
}

function vehicleType(event: RawObject): string | null {
  const vehicles = [
    event.vehicle,
    event.killerVehicle,
    event.attackerVehicle,
    event.victimVehicle,
    event.vehicleInfo,
  ].map(objectValue);
  return firstString(
    event.vehicleType,
    ...vehicles.flatMap((vehicle) => [vehicle.vehicleType, vehicle.type]),
  );
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

export function parseTelemetryPayload(value: unknown): unknown[] {
  const buffer = toBuffer(value);
  if (buffer) {
    const decoded =
      buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
    return parseTelemetryPayload(decoded.toString('utf8'));
  }
  if (typeof value === 'string') {
    try {
      return parseTelemetryPayload(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  const object = objectValue(value);
  if (Array.isArray(object.events)) return object.events;
  if (Array.isArray(object.data)) return object.data;
  if (Array.isArray(object.telemetry)) return object.telemetry;
  return [];
}

export function isHeavyWeapon(weapon: string | null): boolean {
  return Boolean(weapon && /panzer|rocket|rpg|m79|m203|grenade_launcher/i.test(weapon));
}

function normalizedWeapon(value: string | null): string {
  return (value ?? '')
    .replace(/^Item_Weapon_/iu, '')
    .replace(/^Weap/iu, '')
    .replace(/_C$/iu, '')
    .toLowerCase();
}

export function meleeKindOf(
  weapon: string | null,
  damageCategory: string | null = null,
): MeleeKind {
  const value = normalizedWeapon(weapon);
  const category = normalizedWeapon(damageCategory);
  // Damage_Kick and Damage_Punch are authoritative. PUBG commonly reports
  // both with PlayerMale/PlayerFemale as the causer, so causer-name fallback
  // must never turn an explicit kick into a punch.
  if (/damage[_-]?kick/u.test(category)) return 'KICK';
  if (/damage[_-]?punch/u.test(category)) return 'PUNCH';
  if (
    /player(?:male|female)[_-]?a/u.test(value) ||
    /fist|punch|barehand|unarmed|meleehand/u.test(value)
  )
    return 'PUNCH';
  return 'OTHER';
}

export function isPunchWeapon(
  weapon: string | null,
  damageCategory: string | null = null,
): boolean {
  return meleeKindOf(weapon, damageCategory) === 'PUNCH';
}

export function isKickWeapon(weapon: string | null, damageCategory: string | null = null): boolean {
  return meleeKindOf(weapon, damageCategory) === 'KICK';
}

export function isMeleeWeapon(
  weapon: string | null,
  damageCategory: string | null = null,
): boolean {
  const value = normalizedWeapon(weapon);
  const category = normalizedWeapon(damageCategory);
  return (
    meleeKindOf(weapon, damageCategory) !== 'OTHER' ||
    /damage[_-]?(?:melee|meleethrow)/u.test(category) ||
    /pickaxe|pan(?:projectile)?|machete|sickle|crowbar|sword|melee/u.test(value)
  );
}

export function isFlashWeapon(weapon: string | null): boolean {
  const value = normalizedWeapon(weapon);
  return /flashbang|flash_grenade|flashgrenade|stungrenade|stun_grenade/u.test(value);
}

export function isExplosiveWeapon(weapon: string | null): boolean {
  const value = normalizedWeapon(weapon);
  return (
    isHeavyWeapon(weapon) ||
    /frag|grenade|molotov|incendiary|c4|stickybomb|explosive|smoke/u.test(value)
  );
}

export function isVehicleWeapon(
  event: Pick<
    NormalizedTelemetryEvent,
    'type' | 'vehicleId' | 'vehicleType' | 'weaponId' | 'rawType'
  > & { damageTypeCategory?: string | null },
): boolean {
  if (event.type === 'VEHICLE_DAMAGE') return true;
  // LogPlayerTakeDamage/MakeGroggy often omit vehicleId and expose the
  // collision actor only through damageCauserName (normalized as weaponId).
  // Vehicle metadata alone is not enough: a passenger can have a vehicle
  // object while firing a gun. Prefer an explicit collision category/causer,
  // and use an ID-only fallback only when no weapon/category contradicts it.
  const weapon = (event.weaponId ?? '').toLowerCase();
  const category = (event.damageTypeCategory ?? '').toLowerCase();
  const causer = `${weapon} ${category}`;
  if (/damage[_-]?(?:vehicle|vehiclehit|vehiclecrashhit)|collision|runover/u.test(causer))
    return true;
  if (
    /dacia|buggy|uaz|boat|motorcycle|motorbike|coupe|vantage|roadglide|snowmobile|tuk|truck|van|jeep|quad|scooter|bp_.*_c/u.test(
      weapon,
    )
  )
    return true;
  if (
    (event.type === 'KNOCK' || event.type === 'KILL') &&
    Boolean(event.vehicleId || event.vehicleType) &&
    !weapon &&
    !category
  )
    return true;
  return (
    (event.type === 'DAMAGE' || event.type === 'KNOCK' || event.type === 'KILL') &&
    Boolean(event.vehicleId) &&
    !weapon &&
    !category
  );
}

function normalizeEvent(
  event: RawObject,
  index: number,
  match: NormalizedMatch,
): NormalizedTelemetryEvent | null {
  const raw = rawType(event);
  const type = eventType(raw);
  if (!type) return null;
  const actorKeys: Record<NormalizedTelemetryEventType, string[]> = {
    ATTACK: ['attacker', 'character', 'player'],
    DAMAGE: ['attacker', 'character', 'player'],
    KNOCK: ['attacker', 'dBNOMaker', 'character', 'player'],
    KILL: ['killer', 'finisher', 'attacker', 'dBNOMaker', 'character', 'player'],
    REVIVE: ['reviver', 'character', 'player'],
    ITEM_ACQUIRE: ['character', 'player'],
    ITEM_DROP: ['character', 'player'],
    ITEM_USE: ['character', 'player'],
    ITEM_LOOT: ['character', 'player'],
    ITEM_TRUNK_PUT: ['character', 'player'],
    ITEM_TRUNK_PICKUP: ['character', 'player'],
    ITEM_ATTACH: ['character', 'player'],
    ITEM_DETACH: ['character', 'player'],
    THROWABLE_USE: ['attacker', 'character', 'player'],
    HEAL: ['character', 'player'],
    ARMOR_DESTROY: ['attacker', 'character', 'player'],
    WHEEL_DESTROY: ['attacker', 'character', 'player'],
    OBJECT_INTERACTION: ['character', 'player'],
    OBJECT_DESTROY: ['attacker', 'character', 'player'],
    VAULT: ['character', 'player'],
    VEHICLE_RIDE: ['character', 'player'],
    VEHICLE_LEAVE: ['character', 'player'],
    VEHICLE_DAMAGE: ['attacker', 'character', 'player'],
    VEHICLE_DESTROY: ['attacker', 'destroyer', 'character', 'player'],
    POSITION: ['character', 'player'],
  };
  // PUBG damage/kill events identify the actor and victim separately. Never
  // fall back to `player` here: on LogPlayerTakeDamage that field can be the
  // attacker, which would fabricate self-damage and false fight participants.
  const victim = firstEntity(event, [
    'victim',
    'target',
    'damagedPlayer',
    'victimCharacter',
    'attackedCharacter',
  ]);
  const actorEntity = firstEntityObject(event, actorKeys[type]);
  const victimEntity = firstEntityObject(event, [
    'victim',
    'target',
    'damagedPlayer',
    'victimCharacter',
    'attackedCharacter',
  ]);
  const vehicles = [
    event.vehicle,
    event.killerVehicle,
    event.attackerVehicle,
    event.vehicleInfo,
  ].map(objectValue);
  const speed = numberValue(
    event.speed ??
      event.maxSpeed ??
      vehicles.map((vehicle) => vehicle.maxSpeed).find((value) => value !== undefined),
  );
  const distanceCandidate = numberValue(
    event.distanceMeters ?? event.rideDistance ?? event.distance,
  );
  const distanceMeters =
    distanceCandidate !== null && distanceCandidate >= 0 ? distanceCandidate : null;
  const category = damageTypeCategory(event);
  const normalizedVehicleId = vehicleId(event);
  const normalizedVehicleType = vehicleType(event);
  const normalizedType = type;
  const normalizedDamage =
    numberValue(event.damage ?? event.damageAmount ?? event.totalDamage) ?? 0;
  const normalizedVehicleDamage =
    numberValue(event.vehicleDamage ?? event.damageToVehicle) ??
    (normalizedType === 'VEHICLE_DAMAGE' ? normalizedDamage : 0);
  const character = objectValue(event.character);
  const item = objectValue(event.item);
  const parentItem = objectValue(event.parentItem);
  const childItem = objectValue(event.childItem);
  const object = objectValue(event.object ?? event.destroyedObject ?? event.prop);
  const objectType = firstString(
    event.objectType,
    event.object_type,
    event.propType,
    event.prop_type,
    event.objectName,
    event.propName,
    object.type,
    object.objectType,
    object.name,
  );
  const objectStatus = firstString(event.objectTypeStatus, event.objectStatus, event.status);
  return {
    id: `telemetry-${index + 1}`,
    type,
    rawType: raw,
    timeSeconds: timeSeconds(event, match),
    phase: eventPhase(event, match),
    actorId: firstEntity(event, actorKeys[type]),
    victimId: victim,
    actorTeamId: entityTeamId(actorEntity),
    victimTeamId: entityTeamId(victimEntity),
    weaponId: weaponId(event),
    damageTypeCategory: category,
    itemId: itemId(event),
    vehicleId: normalizedVehicleId,
    vehicleType: normalizedVehicleType,
    attackId: correlationId(event.attackId ?? event.attack_id ?? event.shotId),
    dbnoId: correlationId(event.dBNOId ?? event.dbnoId ?? event.dbno_id ?? event.dBNOID),
    damage: normalizedDamage,
    vehicleDamage: normalizedVehicleDamage,
    kills: type === 'KILL' ? 1 : 0,
    knocks: type === 'KNOCK' ? 1 : 0,
    hit:
      type === 'DAMAGE'
        ? normalizedDamage > 0 || event.hit === true
        : type === 'VEHICLE_DAMAGE'
          ? normalizedVehicleDamage > 0 || normalizedDamage > 0 || event.hit === true
          : Boolean(event.hit),
    seatIndex: numberValue(
      event.seatIndex ??
        event.seat ??
        character.seatIndex ??
        character.seat ??
        vehicles
          .map((vehicle) => vehicle.seatIndex ?? vehicle.seat)
          .find((value) => value !== undefined),
    ),
    driverConfirmed: booleanValue(
      event.driverConfirmed ??
        event.isDriver ??
        event.is_driver ??
        event.driver ??
        vehicles
          .map((vehicle) => vehicle.isDriver ?? vehicle.is_driver ?? vehicle.driver)
          .find((value) => value !== undefined),
    ),
    passengerConfirmed: booleanValue(
      event.passengerConfirmed ??
        event.isPassenger ??
        event.is_passenger ??
        event.passenger ??
        vehicles
          .map((vehicle) => vehicle.isPassenger ?? vehicle.is_passenger ?? vehicle.passenger)
          .find((value) => value !== undefined),
    ),
    speed,
    distanceMeters,
    location: locationOf(event),
    healAmount: numberValue(event.healAmount) ?? 0,
    health: numberValue(character.health),
    blueZone: booleanValue(character.isInBlueZone),
    redZone: booleanValue(character.isInRedZone),
    specialZone: stringValue(character.inSpecialZone),
    itemCategory: stringValue(item.category),
    itemSubCategory: stringValue(item.subCategory),
    stackCount: numberValue(item.stackCount),
    ownerTeamId: firstString(event.ownerTeamId, event.owner_team_id),
    creatorId: firstString(event.creatorAccountId, event.creator_account_id),
    parentItemId: firstString(parentItem.itemId, parentItem.item_id),
    childItemId: firstString(childItem.itemId, childItem.item_id),
    damageReason: firstString(event.damageReason, event.damage_reason),
    wheelIndex: numberValue(event.wheelIndex),
    objectType,
    objectStatus,
    isLedgeGrab: booleanValue(event.isLedgeGrab),
    isVaultOnVehicle: booleanValue(event.isVaultOnVehicle),
  };
}

export function normalizeTelemetryEvents(
  value: unknown,
  match: NormalizedMatch,
): NormalizedTelemetryEvent[] {
  return parseTelemetryPayload(value)
    .filter((item): item is RawObject =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item)),
    )
    .map((item, index) => normalizeEvent(item, index, match))
    .filter((item): item is NormalizedTelemetryEvent => item !== null)
    .sort(
      (left, right) =>
        (left.timeSeconds ?? Number.POSITIVE_INFINITY) -
          (right.timeSeconds ?? Number.POSITIVE_INFINITY) || left.id.localeCompare(right.id),
    );
}
