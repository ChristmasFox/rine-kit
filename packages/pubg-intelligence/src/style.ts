import { parseTelemetryPayload } from '@rine-kit/pubg-domain';
import { normalizeWeaponName } from './analytics.js';
import { emptyRoleCounts, type RoleCounts } from './fights.js';

export const STYLE_SCHEMA_VERSION = 2 as const;
export const STYLE_RULE_VERSION = 'play-style-v2' as const;
export const STYLE_BOOTSTRAP_RESAMPLES = 300;
export const STYLE_BOOTSTRAP_SEED = 20261018;
/** Ratio to teammates beyond which a difference is worth naming; its inverse applies on the low side. */
export const STYLE_NOTABLE_RATIO = 1.15;
/** Share of bootstrap resamples that must agree on the direction for a "lean". */
export const STYLE_LEAN_CONFIDENCE = 0.85;
export const STYLE_MIN_FIGHTS = 40;
export const STYLE_MIN_DAMAGE = 1500;
export const STYLE_MIN_MINUTES = 60;
export const STYLE_MIN_SHOTS = 800;
/** A shot counts as part of a fight when someone on either side was hurt within this long before or after it. */
export const STYLE_ENGAGE_WINDOW_MS = 8000;
/** Fewest shots in a first-shot or follow-up group before its hit rate is measured. */
export const STYLE_MIN_SPLIT_SHOTS = 300;
/** A shot fired this soon after the previous one from the same weapon is a follow-up bullet of a burst or spray. */
export const STYLE_BURST_GAP_MS = 120;
/** Prior shots pulling a teammate class hit rate toward the teammates' overall rate in the weapon-mix adjustment. */
export const STYLE_CLASS_PRIOR_SHOTS = 200;
export const STYLE_MIN_KNOCKS = 25;
export const STYLE_MIN_SPACING_SAMPLES = 100;
export const STYLE_MIN_ZONE_SAMPLES = 150;
export const STYLE_MIN_PICKUP_MATCHES = 8;
export const STYLE_ARCHETYPE_STRONG = 0.45;
export const STYLE_ARCHETYPE_LEAN = 0.3;
export const STYLE_ARCHETYPE_SLIGHT = 0.1;
/** Weight of an axis that is close to teammates when scoring archetypes; lets a faint lean still point somewhere. */
export const STYLE_EVEN_FACTOR = 0.25;
export const STYLE_ISOLATED_METERS = 150;
export const STYLE_SPACING_BUCKET_SECONDS = 15;
export const STYLE_EARLY_LOOT_SECONDS = 240;
export const STYLE_LATE_PHASE = 5;
export const STYLE_EDGE_RATIO = 0.85;
export const STYLE_MAX_FOOT_STEP_METERS = 400;
export const STYLE_MAX_FOOT_GAP_SECONDS = 30;

/** Upper edges (metres) of the distance bins used for a damage-weighted median engagement distance. */
export const STYLE_DISTANCE_EDGES = [10, 25, 50, 75, 100, 150, 200, 300] as const;
/** Upper edges (metres) of the nearest-teammate distance bins. */
export const STYLE_SPACING_EDGES = [20, 50, 100, 150, 250] as const;

const DISTANCE_BIN_COUNT = STYLE_DISTANCE_EDGES.length + 1;
const SPACING_BIN_COUNT = STYLE_SPACING_EDGES.length + 1;
const FAR_FROM_BIN = STYLE_DISTANCE_EDGES.findIndex((edge) => edge === 150) + 1;
const CLOSE_BINS = 2;

export type WeaponClass = 'AR' | 'SMG' | 'DMR' | 'SR' | 'LMG' | 'SG' | 'Pistol' | 'other';
const CLASS_ORDER: readonly WeaponClass[] = [
  'AR',
  'SMG',
  'DMR',
  'SR',
  'LMG',
  'SG',
  'Pistol',
  'other',
];

const WEAPON_CLASSES: Record<WeaponClass, readonly string[]> = {
  AR: [
    'M416',
    'BerylM762',
    'AK47',
    'AKM',
    'SCAR-L',
    'SCARL',
    'G36C',
    'QBZ',
    'AUG',
    'Groza',
    'M16A4',
    'ACE32',
    'K2',
    'FAMASG2',
    'HK416',
    'Mk47Mutant',
    'Mutant',
    'QBZ95',
  ],
  SMG: ['UMP', 'Vector', 'UZI', 'Thompson', 'MP5K', 'P90', 'Bizon', 'MP9', 'JS9'],
  DMR: ['SKS', 'Mini14', 'Mk12', 'FNFal', 'SLR', 'VSS', 'QBU', 'Mk14', 'Dragunov'],
  SR: ['Kar98k', 'M24', 'AWM', 'Win94', 'Mosin', 'Lynx', 'L6'],
  LMG: ['M249', 'MG3', 'DP28', 'RPD', 'DP-28'],
  SG: [
    'S12K',
    'S686',
    'S1897',
    'DBS',
    'OriginS12',
    'O12',
    'Saiga12',
    'Winchester',
    'Berreta686',
    'DP12',
  ],
  Pistol: [
    'P92',
    'P1911',
    'R1895',
    'R45',
    'P18C',
    'DesertEagle',
    'M9',
    'Skorpion',
    'Sawnoff',
    'G18',
    'NagantM1895',
    'vz61Skorpion',
  ],
  other: [],
};

export function weaponClassOf(weapon: string): WeaponClass {
  const lower = weapon.toLowerCase();
  for (const [name, members] of Object.entries(WEAPON_CLASSES) as Array<
    [WeaponClass, readonly string[]]
  >) {
    if (members.some((member) => member.toLowerCase() === lower)) return name;
  }
  return 'other';
}

/** Damage categories of player-thrown or player-fired explosives and fire. */
export const EXPLOSIVE_DAMAGE: ReadonlySet<string> = new Set([
  'Damage_Explosion_PanzerFaustWarhead',
  'Damage_Explosion_PanzerFaustWarheadVehicleArmorPenetration',
  'Damage_Explosion_Grenade',
  'Damage_Explosion_StickyBomb',
  'Damage_Explosion_Mortar',
  'Damage_Molotov',
]);

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function gamePhase(event: Record<string, unknown>): number | null {
  const value = num(obj(event.common).isGame);
  return value !== null && value >= 1 ? value : null;
}

function binIndex(value: number, edges: readonly number[]): number {
  const index = edges.findIndex((edge) => value < edge);
  return index < 0 ? edges.length : index;
}

export interface ThrowableCounts {
  frag: number;
  smoke: number;
  flash: number;
  fire: number;
}

/** Raw-telemetry counters for one member of the squad in one match. */
export interface PlayerRawStyle {
  gunDamage: number;
  /** Rocket, grenade and fire damage to opponents; counts toward damage per minute but not the shooting statistics. */
  explosiveDamage: number;
  headDamage: number;
  /**
   * Aimed shots: gun shots fired inside a fight, leaving out the shots that went into a downed player, with the shots
   * that hurt a standing opponent and their damage. Each shot is paired with its damage by attackId, so one shotgun
   * blast with several pellets is one hit. Fired outside any fight (walls, vehicles, testing, empty air) and finishing
   * shots into a downed player are counted separately instead of as misses.
   */
  shots: number;
  hits: number;
  hitDamage: number;
  /** Shots, hits and hit damage per weapon class (CLASS_ORDER), so hit rates can be compared on the same weapon mix. */
  classShots: number[];
  classHits: number[];
  classHitDamage: number[];
  /** The first shot of a burst (or a single shot) versus the follow-up bullets of an automatic burst, among the aimed shots. */
  firstShots: number;
  firstHits: number;
  followShots: number;
  followHits: number;
  /** Shots fired with nobody on either side hurt within the engage window. */
  idleShots: number;
  /** Shots that went into a downed opponent. */
  finishingShots: number;
  dealtBins: number[];
  /** Gun damage dealt in the early (circles 1-2), middle (3-4) and late (5+) game. */
  phaseDamage: number[];
  weaponDamage: Record<string, number>;
  spacingBins: number[];
  throwables: ThrowableCounts;
  rides: number;
  healUses: number;
  boostUses: number;
  /** Items picked up in the first minutes after landing. */
  earlyPickups: number;
  /** Distance covered on foot in metres. */
  footMeters: number;
  zoneSamples: number;
  zoneEdgeSamples: number;
  /** Distance in metres from the squad's landing centre; null when the landing is unknown. */
  landingSpread: number | null;
}

function emptyRaw(): PlayerRawStyle {
  return {
    gunDamage: 0,
    explosiveDamage: 0,
    headDamage: 0,
    shots: 0,
    hits: 0,
    hitDamage: 0,
    classShots: new Array<number>(CLASS_ORDER.length).fill(0),
    classHits: new Array<number>(CLASS_ORDER.length).fill(0),
    classHitDamage: new Array<number>(CLASS_ORDER.length).fill(0),
    firstShots: 0,
    firstHits: 0,
    followShots: 0,
    followHits: 0,
    idleShots: 0,
    finishingShots: 0,
    dealtBins: new Array<number>(DISTANCE_BIN_COUNT).fill(0),
    phaseDamage: [0, 0, 0],
    weaponDamage: {},
    spacingBins: new Array<number>(SPACING_BIN_COUNT).fill(0),
    throwables: { frag: 0, smoke: 0, flash: 0, fire: 0 },
    rides: 0,
    healUses: 0,
    boostUses: 0,
    earlyPickups: 0,
    footMeters: 0,
    zoneSamples: 0,
    zoneEdgeSamples: 0,
    landingSpread: null,
  };
}

function throwableKind(itemId: string): keyof ThrowableCounts | null {
  if (/SmokeBomb/iu.test(itemId)) return 'smoke';
  if (/FlashBang/iu.test(itemId)) return 'flash';
  if (/Molotov/iu.test(itemId)) return 'fire';
  if (/Grenade/iu.test(itemId) && !/Bluezone/iu.test(itemId)) return 'frag';
  return null;
}

/**
 * One pass over a raw payload: engagement distance, weapons and game stage of the damage, spacing from teammates,
 * utility, healing, early looting, movement, circle position, rides and landing spread.
 */
export function analyzeStyleTelemetry(
  payload: unknown,
  trackedIds: ReadonlySet<string>,
): Record<string, PlayerRawStyle> {
  const players: Record<string, PlayerRawStyle> = {};
  for (const id of trackedIds) players[id] = emptyRaw();
  const positions = new Map<number, Map<string, { x: number; y: number }>>();
  const landings = new Map<string, { x: number; y: number }>();
  const landedAt = new Map<string, number>();
  const lastStep = new Map<string, { x: number; y: number; time: number; vehicle: boolean }>();
  let safety: { x: number; y: number; radius: number } | null = null;
  // Shots are judged after the pass: whether each hit (by attackId) and whether anyone was hurt around it.
  const shotLog = new Map<
    string,
    Array<{ t: number; item: string; attackId: string | null; classIndex: number }>
  >();
  const outcomes = new Map<string, { standing: boolean; downed: boolean; damage: number }>();
  const contactTimes: number[] = [];

  for (const raw of parseTelemetryPayload(payload)) {
    const event = obj(raw);
    const type = event._T;
    const time = typeof event._D === 'string' ? Date.parse(event._D) : NaN;

    if (type === 'LogParachuteLanding') {
      const character = obj(event.character);
      const id = typeof character.accountId === 'string' ? character.accountId : null;
      const x = num(obj(character.location).x);
      const y = num(obj(character.location).y);
      if (id && trackedIds.has(id) && x !== null && y !== null) {
        landings.set(id, { x: x / 100, y: y / 100 });
        if (Number.isFinite(time)) landedAt.set(id, time);
      }
      continue;
    }
    const phase = gamePhase(event);
    if (phase === null) continue;

    if (type === 'LogGameStatePeriodic') {
      const state = obj(event.gameState);
      const x = num(obj(state.safetyZonePosition).x);
      const y = num(obj(state.safetyZonePosition).y);
      const radius = num(state.safetyZoneRadius);
      if (x !== null && y !== null && radius !== null && radius > 0) safety = { x, y, radius };
    } else if (type === 'LogPlayerPosition') {
      const character = obj(event.character);
      const id = typeof character.accountId === 'string' ? character.accountId : null;
      const elapsed = num(event.elapsedTime);
      const x = num(obj(character.location).x);
      const y = num(obj(character.location).y);
      if (!id || !trackedIds.has(id) || x === null || y === null) continue;
      const entry = players[id]!;
      const vehicle = character.isInVehicle === true;
      const previous = lastStep.get(id);
      if (previous && !vehicle && !previous.vehicle && Number.isFinite(time)) {
        const seconds = (time - previous.time) / 1000;
        const step = Math.hypot(x - previous.x, y - previous.y) / 100;
        if (
          seconds > 0 &&
          seconds <= STYLE_MAX_FOOT_GAP_SECONDS &&
          step <= STYLE_MAX_FOOT_STEP_METERS
        )
          entry.footMeters += step;
      }
      lastStep.set(id, { x, y, time, vehicle });
      if (safety) {
        entry.zoneSamples += 1;
        if (Math.hypot(x - safety.x, y - safety.y) / safety.radius >= STYLE_EDGE_RATIO)
          entry.zoneEdgeSamples += 1;
      }
      if (elapsed !== null && character.isDBNO !== true) {
        const bucket = Math.floor(elapsed / STYLE_SPACING_BUCKET_SECONDS);
        const slot = positions.get(bucket) ?? new Map<string, { x: number; y: number }>();
        slot.set(id, { x: x / 100, y: y / 100 });
        positions.set(bucket, slot);
      }
    } else if (type === 'LogPlayerAttack') {
      const attacker = obj(event.attacker);
      const id = typeof attacker.accountId === 'string' ? attacker.accountId : null;
      const weapon = obj(event.weapon);
      if (
        id &&
        trackedIds.has(id) &&
        event.attackType === 'Weapon' &&
        weapon.category === 'Weapon' &&
        (weapon.subCategory === 'Main' || weapon.subCategory === 'Handgun')
      ) {
        const fired = typeof weapon.itemId === 'string' ? normalizeWeaponName(weapon.itemId) : null;
        // Launchers never register gun hits, so their shots would only drag the hit rate down.
        if (fired && fired !== 'PanzerFaust' && Number.isFinite(time)) {
          const log = shotLog.get(id) ?? [];
          log.push({
            t: time,
            item: fired,
            attackId:
              event.attackId === undefined || event.attackId === null
                ? null
                : String(event.attackId),
            classIndex: CLASS_ORDER.indexOf(weaponClassOf(fired)),
          });
          shotLog.set(id, log);
        }
      }
    } else if (type === 'LogPlayerTakeDamage') {
      const category = event.damageTypeCategory;
      {
        const from = obj(event.attacker);
        const to = obj(event.victim);
        const fromId = typeof from.accountId === 'string' ? from.accountId : null;
        const toId = typeof to.accountId === 'string' ? to.accountId : null;
        const amount = num(event.damage) ?? 0;
        const rival = String(from.teamId ?? '') !== String(to.teamId ?? '');
        const squadAttacks =
          fromId !== null &&
          trackedIds.has(fromId) &&
          !(toId !== null && trackedIds.has(toId)) &&
          rival;
        const squadHurt =
          toId !== null &&
          trackedIds.has(toId) &&
          fromId !== null &&
          !trackedIds.has(fromId) &&
          rival;
        // Hits on a downed player do no damage, so a fight is also "on" while one is being finished.
        if (
          (squadAttacks || squadHurt) &&
          Number.isFinite(time) &&
          (amount > 0 || to.isDBNO === true)
        )
          contactTimes.push(time);
        if (
          squadAttacks &&
          typeof category === 'string' &&
          category.startsWith('Damage_Gun') &&
          event.attackId !== undefined &&
          event.attackId !== null
        ) {
          const key = String(event.attackId);
          const outcome = outcomes.get(key) ?? { standing: false, downed: false, damage: 0 };
          if (amount > 0 && to.isDBNO !== true) {
            outcome.standing = true;
            outcome.damage += amount;
          } else if (to.isDBNO === true) outcome.downed = true;
          outcomes.set(key, outcome);
        }
      }
      if (typeof category === 'string' && EXPLOSIVE_DAMAGE.has(category)) {
        // Explosive and fire damage counts toward damage per minute (and the rocket toward habitual weapons);
        // it stays out of the hit-rate and range statistics, which only describe gunfire.
        const rocketAttacker = obj(event.attacker);
        const rocketVictim = obj(event.victim);
        const rocketId =
          typeof rocketAttacker.accountId === 'string' ? rocketAttacker.accountId : null;
        const rocketVictimId =
          typeof rocketVictim.accountId === 'string' ? rocketVictim.accountId : null;
        const rocketDamage = num(event.damage);
        if (
          rocketId &&
          trackedIds.has(rocketId) &&
          (rocketVictimId === null || !trackedIds.has(rocketVictimId)) &&
          String(rocketAttacker.teamId ?? '') !== String(rocketVictim.teamId ?? '') &&
          rocketDamage !== null &&
          rocketDamage > 0
        ) {
          const rocketEntry = players[rocketId]!;
          rocketEntry.explosiveDamage += rocketDamage;
          if (category.startsWith('Damage_Explosion_PanzerFaustWarhead'))
            rocketEntry.weaponDamage.PanzerFaust =
              (rocketEntry.weaponDamage.PanzerFaust ?? 0) + rocketDamage;
        }
        continue;
      }
      if (category !== 'Damage_Gun' && category !== 'Damage_DBNO') continue;
      const attacker = obj(event.attacker);
      const victim = obj(event.victim);
      const attackerId = typeof attacker.accountId === 'string' ? attacker.accountId : null;
      const victimId = typeof victim.accountId === 'string' ? victim.accountId : null;
      if (
        !attackerId ||
        !trackedIds.has(attackerId) ||
        (victimId !== null && trackedIds.has(victimId))
      )
        continue;
      const damage = num(event.damage);
      if (damage === null || damage <= 0) continue;
      if (String(attacker.teamId ?? '') === String(victim.teamId ?? '')) continue;
      const weapon =
        typeof event.damageCauserName === 'string'
          ? normalizeWeaponName(event.damageCauserName)
          : null;
      const entry = players[attackerId]!;
      if (category !== 'Damage_Gun') continue;
      const from = obj(attacker.location);
      const to = obj(victim.location);
      const dx = (num(from.x) ?? NaN) - (num(to.x) ?? NaN);
      const dy = (num(from.y) ?? NaN) - (num(to.y) ?? NaN);
      const dz = (num(from.z) ?? 0) - (num(to.z) ?? 0);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
      entry.gunDamage += damage;
      if (event.damageReason === 'HeadShot') entry.headDamage += damage;
      entry.dealtBins[binIndex(Math.hypot(dx, dy, dz) / 100, STYLE_DISTANCE_EDGES)]! += damage;
      entry.phaseDamage[phase < 3 ? 0 : phase < STYLE_LATE_PHASE ? 1 : 2]! += damage;
      if (weapon) entry.weaponDamage[weapon] = (entry.weaponDamage[weapon] ?? 0) + damage;
    } else if (type === 'LogPlayerUseThrowable') {
      const id =
        typeof obj(event.attacker).accountId === 'string'
          ? (obj(event.attacker).accountId as string)
          : null;
      const itemId =
        typeof obj(event.weapon).itemId === 'string' ? (obj(event.weapon).itemId as string) : '';
      const kind = throwableKind(itemId);
      if (id && trackedIds.has(id) && kind) players[id]!.throwables[kind] += 1;
    } else if (type === 'LogItemUse') {
      const id =
        typeof obj(event.character).accountId === 'string'
          ? (obj(event.character).accountId as string)
          : null;
      const sub = obj(event.item).subCategory;
      if (id && trackedIds.has(id)) {
        if (sub === 'Heal') players[id]!.healUses += 1;
        else if (sub === 'Boost') players[id]!.boostUses += 1;
      }
    } else if (type === 'LogItemPickup' || type === 'LogItemPickupFromLootBox') {
      const id =
        typeof obj(event.character).accountId === 'string'
          ? (obj(event.character).accountId as string)
          : null;
      const landed = id ? landedAt.get(id) : undefined;
      if (
        id &&
        landed !== undefined &&
        Number.isFinite(time) &&
        time >= landed &&
        time - landed <= STYLE_EARLY_LOOT_SECONDS * 1000
      )
        players[id]!.earlyPickups += 1;
    } else if (type === 'LogVehicleRide') {
      const character = obj(event.character);
      const id = typeof character.accountId === 'string' ? character.accountId : null;
      const vehicleType =
        typeof obj(event.vehicle).vehicleType === 'string'
          ? (obj(event.vehicle).vehicleType as string)
          : '';
      if (id && trackedIds.has(id) && !/Aircraft/iu.test(vehicleType)) players[id]!.rides += 1;
    }
  }

  contactTimes.sort((left, right) => left - right);
  const fightAround = (t: number): boolean => {
    let low = 0;
    let high = contactTimes.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (contactTimes[mid]! < t - STYLE_ENGAGE_WINDOW_MS) low = mid + 1;
      else high = mid;
    }
    return low < contactTimes.length && contactTimes[low]! <= t + STYLE_ENGAGE_WINDOW_MS;
  };
  for (const [id, log] of shotLog) {
    const entry = players[id]!;
    log.sort((left, right) => left.t - right.t);
    const lastShot = new Map<string, number>();
    for (const shot of log) {
      const outcome = shot.attackId === null ? undefined : outcomes.get(shot.attackId);
      const previous = lastShot.get(shot.item);
      lastShot.set(shot.item, shot.t);
      if (outcome?.downed && !outcome.standing) {
        entry.finishingShots += 1;
        continue;
      }
      if (!fightAround(shot.t)) {
        entry.idleShots += 1;
        continue;
      }
      const hit = outcome?.standing === true;
      const follow = previous !== undefined && shot.t - previous <= STYLE_BURST_GAP_MS;
      entry.shots += 1;
      entry.classShots[shot.classIndex]! += 1;
      if (hit) {
        entry.hits += 1;
        entry.hitDamage += outcome!.damage;
        entry.classHits[shot.classIndex]! += 1;
        entry.classHitDamage[shot.classIndex]! += outcome!.damage;
      }
      if (follow) {
        entry.followShots += 1;
        if (hit) entry.followHits += 1;
      } else {
        entry.firstShots += 1;
        if (hit) entry.firstHits += 1;
      }
    }
  }

  for (const slot of positions.values()) {
    if (slot.size < 2) continue;
    for (const [id, here] of slot) {
      let nearest = Infinity;
      for (const [other, there] of slot)
        if (other !== id)
          nearest = Math.min(nearest, Math.hypot(here.x - there.x, here.y - there.y));
      players[id]!.spacingBins[binIndex(nearest, STYLE_SPACING_EDGES)]! += 1;
    }
  }
  if (landings.size) {
    const cx = [...landings.values()].reduce((sum, point) => sum + point.x, 0) / landings.size;
    const cy = [...landings.values()].reduce((sum, point) => sum + point.y, 0) / landings.size;
    for (const [id, point] of landings)
      players[id]!.landingSpread = Math.hypot(point.x - cx, point.y - cy);
  }
  return players;
}

/** Everything the style model needs to know about one member in one match. */
export interface PlayerStyleMatch extends PlayerRawStyle {
  minutes: number;
  fights: RoleCounts;
}

export function emptyFights(): RoleCounts {
  return emptyRoleCounts();
}

// ---------------------------------------------------------------------------------------------------------------
// Flat vector layout: sums, subtraction (for "teammates only" baselines) and bootstrap resampling are just array maths.
const FIGHT_KEYS = Object.keys(emptyFights()) as Array<keyof RoleCounts>;
const SCALARS = [
  'minutes',
  'gunDamage',
  'explosiveDamage',
  'headDamage',
  'shots',
  'hits',
  'hitDamage',
  'firstShots',
  'firstHits',
  'followShots',
  'followHits',
  'idleShots',
  'finishingShots',
  'throwables',
  'rides',
  'healUses',
  'boostUses',
  'earlyPickups',
  'footMeters',
  'zoneSamples',
  'zoneEdgeSamples',
  'pickupMatches',
] as const;
type Scalar = (typeof SCALARS)[number];

const OFFSET: Record<string, number> = {};
let cursor = 0;
for (const key of SCALARS) {
  OFFSET[key] = cursor;
  cursor += 1;
}
for (const key of FIGHT_KEYS) {
  OFFSET[`f:${key}`] = cursor;
  cursor += 1;
}
OFFSET.dealtBins = cursor;
cursor += DISTANCE_BIN_COUNT;
OFFSET.spacingBins = cursor;
cursor += SPACING_BIN_COUNT;
OFFSET.phaseDamage = cursor;
cursor += 3;
OFFSET.classDamage = cursor;
cursor += CLASS_ORDER.length;
OFFSET.classShots = cursor;
cursor += CLASS_ORDER.length;
OFFSET.classHits = cursor;
cursor += CLASS_ORDER.length;
OFFSET.classHitDamage = cursor;
cursor += CLASS_ORDER.length;
const VECTOR_LENGTH = cursor;

type Vec = Float64Array;

function toVector(stats: PlayerStyleMatch): Vec {
  const vector = new Float64Array(VECTOR_LENGTH);
  vector[OFFSET.minutes!] = stats.minutes;
  vector[OFFSET.gunDamage!] = stats.gunDamage;
  vector[OFFSET.explosiveDamage!] = stats.explosiveDamage;
  vector[OFFSET.headDamage!] = stats.headDamage;
  vector[OFFSET.shots!] = stats.shots;
  vector[OFFSET.hits!] = stats.hits;
  vector[OFFSET.hitDamage!] = stats.hitDamage;
  vector[OFFSET.firstShots!] = stats.firstShots;
  vector[OFFSET.firstHits!] = stats.firstHits;
  vector[OFFSET.followShots!] = stats.followShots;
  vector[OFFSET.followHits!] = stats.followHits;
  vector[OFFSET.idleShots!] = stats.idleShots;
  vector[OFFSET.finishingShots!] = stats.finishingShots;
  vector[OFFSET.throwables!] =
    stats.throwables.frag + stats.throwables.smoke + stats.throwables.flash + stats.throwables.fire;
  vector[OFFSET.rides!] = stats.rides;
  vector[OFFSET.healUses!] = stats.healUses;
  vector[OFFSET.boostUses!] = stats.boostUses;
  vector[OFFSET.earlyPickups!] = stats.earlyPickups;
  vector[OFFSET.footMeters!] = stats.footMeters;
  vector[OFFSET.zoneSamples!] = stats.zoneSamples;
  vector[OFFSET.zoneEdgeSamples!] = stats.zoneEdgeSamples;
  vector[OFFSET.pickupMatches!] = stats.landingSpread !== null || stats.earlyPickups > 0 ? 1 : 0;
  for (const key of FIGHT_KEYS) vector[OFFSET[`f:${key}`]!] = stats.fights[key];
  stats.dealtBins.forEach((value, index) => {
    vector[OFFSET.dealtBins! + index] = value;
  });
  stats.spacingBins.forEach((value, index) => {
    vector[OFFSET.spacingBins! + index] = value;
  });
  stats.phaseDamage.forEach((value, index) => {
    vector[OFFSET.phaseDamage! + index] = value;
  });
  stats.classShots.forEach((value, index) => {
    vector[OFFSET.classShots! + index] = value;
  });
  stats.classHits.forEach((value, index) => {
    vector[OFFSET.classHits! + index] = value;
  });
  stats.classHitDamage.forEach((value, index) => {
    vector[OFFSET.classHitDamage! + index] = value;
  });
  for (const [weapon, damage] of Object.entries(stats.weaponDamage)) {
    vector[OFFSET.classDamage! + CLASS_ORDER.indexOf(weaponClassOf(weapon))]! += damage;
  }
  return vector;
}

function addVec(target: Vec, source: Vec): void {
  for (let index = 0; index < target.length; index += 1) target[index]! += source[index]!;
}

function subtractVec(whole: Vec, part: Vec): Vec {
  const result = new Float64Array(whole.length);
  for (let index = 0; index < whole.length; index += 1)
    result[index] = Math.max(0, whole[index]! - part[index]!);
  return result;
}

function slice(vector: Vec, key: string, length: number): number[] {
  return Array.from(vector.subarray(OFFSET[key]!, OFFSET[key]! + length));
}

function scalar(vector: Vec, key: Scalar): number {
  return vector[OFFSET[key]!]!;
}

function fight(vector: Vec, key: keyof RoleCounts): number {
  return vector[OFFSET[`f:${key}`]!]!;
}

/** Damage-weighted median engagement distance in metres, interpolated inside the winning bin. */
export function weightedMedianDistance(bins: readonly number[]): number | null {
  const total = bins.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  let running = 0;
  for (let index = 0; index < bins.length; index += 1) {
    const next = running + bins[index]!;
    if (next >= total / 2) {
      const low = index === 0 ? 0 : STYLE_DISTANCE_EDGES[index - 1]!;
      const high = index < STYLE_DISTANCE_EDGES.length ? STYLE_DISTANCE_EDGES[index]! : low * 1.5;
      const within = bins[index]! > 0 ? (total / 2 - running) / bins[index]! : 0;
      return low + (high - low) * within;
    }
    running = next;
  }
  return null;
}

function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export type StyleAxisKey =
  | 'range'
  | 'farShare'
  | 'closeShare'
  | 'marksman'
  | 'closeGun'
  | 'precision'
  | 'firstShot'
  | 'followShot'
  | 'burst'
  | 'tempo'
  | 'initiative'
  | 'fragging'
  | 'lateGame'
  | 'earlyLoot'
  | 'revive'
  | 'utility'
  | 'supplies'
  | 'isolation'
  | 'risk'
  | 'zoneEdge'
  | 'foot'
  | 'mobility'
  | 'dpm'
  | 'hitRate'
  | 'dmgPerShot'
  | 'knockRate'
  | 'conversion'
  | 'combat';

export type StyleGroup = '战斗效率' | '射击' | '节奏' | '协作与补给' | '位置与风险';

export interface StyleAxisDefinition {
  key: StyleAxisKey;
  group: StyleGroup;
  label: string;
  high: string;
  low: string;
  /** Derived from other axes (geometric mean of their ratios) instead of measured directly. */
  composite?: readonly StyleAxisKey[];
}

/**
 * Axes that make up the fighting-power index and their weights. Chosen on 112 ranked squad matches: damage per
 * minute tracked fight wins and placement best; headshot share was unreliable (split-half 0.45) and unrelated to
 * winning, and knock conversion depends on teammates finishing, so both stay as separate axes only.
 */
export const COMBAT_WEIGHTS: Readonly<Partial<Record<StyleAxisKey, number>>> = {
  dpm: 0.5,
  knockRate: 0.25,
  hitRate: 0.25,
};
export const COMBAT_COMPONENTS: readonly StyleAxisKey[] = Object.keys(
  COMBAT_WEIGHTS,
) as StyleAxisKey[];

export const STYLE_AXES: readonly StyleAxisDefinition[] = [
  {
    key: 'combat',
    group: '战斗效率',
    label: '战斗力指数',
    high: '综合输出明显强于队友',
    low: '综合输出弱于队友',
    composite: COMBAT_COMPONENTS,
  },
  {
    key: 'dpm',
    group: '战斗效率',
    label: '每分钟伤害（含爆炸）',
    high: '每存活分钟打出更多伤害',
    low: '每存活分钟伤害更少',
  },
  {
    key: 'hitRate',
    group: '战斗效率',
    label: '命中率（同枪型）',
    high: '同样的枪，命中率更高',
    low: '同样的枪，命中率更低',
  },
  {
    key: 'dmgPerShot',
    group: '战斗效率',
    label: '每发伤害（同枪型）',
    high: '同样的枪，每发打出更多伤害',
    low: '同样的枪，每发伤害更少',
  },
  {
    key: 'knockRate',
    group: '战斗效率',
    label: '交战击倒率',
    high: '更多交战里打倒了人',
    low: '更少在交战里打倒人',
  },
  {
    key: 'conversion',
    group: '战斗效率',
    label: '击倒转化率',
    high: '打倒的人更常被终结',
    low: '打倒的人更常被救起',
  },
  { key: 'range', group: '射击', label: '交战距离', high: '比队友打得更远', low: '比队友打得更近' },
  {
    key: 'farShare',
    group: '射击',
    label: '远距输出占比',
    high: '更多输出来自 150m 外',
    low: '很少在 150m 外输出',
  },
  {
    key: 'closeShare',
    group: '射击',
    label: '近距输出占比',
    high: '更多输出发生在 25m 内',
    low: '很少贴脸输出',
  },
  {
    key: 'marksman',
    group: '射击',
    label: '狙击/射手枪占比',
    high: '偏爱狙击和射手步枪',
    low: '很少用狙击和射手步枪',
  },
  {
    key: 'closeGun',
    group: '射击',
    label: '冲锋/霰弹/手枪占比',
    high: '偏爱近战武器',
    low: '很少用近战武器',
  },
  { key: 'precision', group: '射击', label: '爆头率', high: '爆头占比更高', low: '爆头占比更低' },
  {
    key: 'firstShot',
    group: '射击',
    label: '首发命中率',
    high: '首发和单点射击更准',
    low: '首发和单点射击命中偏低',
  },
  {
    key: 'followShot',
    group: '射击',
    label: '连射命中率',
    high: '连射时后续子弹更准',
    low: '连射时后续子弹偏飘',
  },
  { key: 'burst', group: '射击', label: '连射占比', high: '更爱连射扫射', low: '更爱点射' },
  { key: 'tempo', group: '节奏', label: '参战频率', high: '更爱找交战', low: '参战更少，更低调' },
  {
    key: 'initiative',
    group: '节奏',
    label: '先手比例',
    high: '更常第一个开火',
    low: '更多是被动接战',
  },
  {
    key: 'fragging',
    group: '节奏',
    label: '收割效率',
    high: '每次交战击倒/击杀更多',
    low: '更多承担牵制和辅助',
  },
  {
    key: 'lateGame',
    group: '节奏',
    label: '后期输出占比',
    high: '输出集中在后期（第 5 圈起）',
    low: '输出集中在前中期',
  },
  {
    key: 'earlyLoot',
    group: '节奏',
    label: '开局搜刮速度',
    high: '落地后搜刮更快',
    low: '落地后搜刮更慢',
  },
  { key: 'revive', group: '协作与补给', label: '救援', high: '救援更积极', low: '较少救人' },
  {
    key: 'utility',
    group: '协作与补给',
    label: '投掷物运用',
    high: '更爱用雷和烟',
    low: '很少用投掷物',
  },
  {
    key: 'supplies',
    group: '协作与补给',
    label: '补给使用频率',
    high: '更勤于打药补状态',
    low: '很少打药',
  },
  {
    key: 'isolation',
    group: '协作与补给',
    label: '脱队程度',
    high: '更常脱离队友',
    low: '更紧贴队友',
  },
  { key: 'risk', group: '位置与风险', label: '受伤风险', high: '更常被打倒', low: '很少被打倒' },
  {
    key: 'zoneEdge',
    group: '位置与风险',
    label: '圈边位置占比',
    high: '更常待在圈边或圈外',
    low: '更靠近圈中心',
  },
  { key: 'foot', group: '位置与风险', label: '跑动量', high: '步行转移更多', low: '步行转移更少' },
  { key: 'mobility', group: '位置与风险', label: '载具使用', high: '更爱开车', low: '很少用载具' },
];

/** Aimed shots, hits and standing-target damage. Shotguns need no special case: shots are paired with hits by attack. */
function mixTotals(vector: Vec): { shots: number; hits: number; hitDamage: number } {
  return {
    shots: scalar(vector, 'shots'),
    hits: scalar(vector, 'hits'),
    hitDamage: scalar(vector, 'hitDamage'),
  };
}

/** Raw metric for one axis from a summed vector; null when there is too little data to measure it. */
export function axisValue(key: StyleAxisKey, vector: Vec): number | null {
  const fights = fight(vector, 'fights');
  const gun = scalar(vector, 'gunDamage');
  const minutes = scalar(vector, 'minutes');
  const dealt = slice(vector, 'dealtBins', DISTANCE_BIN_COUNT);
  const classes = slice(vector, 'classDamage', CLASS_ORDER.length);
  const classTotal = classes.reduce((sum, value) => sum + value, 0);
  const cls = (...names: WeaponClass[]) =>
    names.reduce((sum, name) => sum + classes[CLASS_ORDER.indexOf(name)]!, 0);
  const enoughFights = fights >= STYLE_MIN_FIGHTS;
  const enoughDamage = gun >= STYLE_MIN_DAMAGE;
  const enoughTime = minutes >= STYLE_MIN_MINUTES;
  switch (key) {
    case 'range':
      return enoughDamage ? weightedMedianDistance(dealt) : null;
    case 'farShare':
      return enoughDamage
        ? share(
            dealt.slice(FAR_FROM_BIN).reduce((sum, value) => sum + value, 0),
            gun,
          )
        : null;
    case 'closeShare':
      return enoughDamage
        ? share(
            dealt.slice(0, CLOSE_BINS).reduce((sum, value) => sum + value, 0),
            gun,
          )
        : null;
    case 'marksman':
      return classTotal >= STYLE_MIN_DAMAGE ? share(cls('SR', 'DMR'), classTotal) : null;
    case 'closeGun':
      return classTotal >= STYLE_MIN_DAMAGE ? share(cls('SMG', 'SG', 'Pistol'), classTotal) : null;
    case 'precision':
      return enoughDamage ? share(scalar(vector, 'headDamage'), gun) : null;
    case 'tempo':
      return enoughTime ? fights / minutes : null;
    case 'initiative':
      return enoughFights ? fight(vector, 'initiations') / fights : null;
    case 'fragging':
      return enoughFights ? (fight(vector, 'kills') + fight(vector, 'knocksDealt')) / fights : null;
    case 'lateGame': {
      const phases = slice(vector, 'phaseDamage', 3);
      return enoughDamage
        ? share(
            phases[2]!,
            phases.reduce((sum, value) => sum + value, 0),
          )
        : null;
    }
    case 'earlyLoot':
      return scalar(vector, 'pickupMatches') >= STYLE_MIN_PICKUP_MATCHES
        ? scalar(vector, 'earlyPickups') / scalar(vector, 'pickupMatches')
        : null;
    case 'revive':
      return enoughFights ? fight(vector, 'revives') / fights : null;
    case 'utility':
      return enoughFights ? scalar(vector, 'throwables') / fights : null;
    case 'supplies':
      return enoughTime
        ? (scalar(vector, 'healUses') + scalar(vector, 'boostUses')) / minutes
        : null;
    case 'isolation': {
      const bins = slice(vector, 'spacingBins', SPACING_BIN_COUNT);
      const total = bins.reduce((sum, value) => sum + value, 0);
      const firstIsolated = STYLE_SPACING_EDGES.findIndex((edge) => edge >= STYLE_ISOLATED_METERS);
      return total >= STYLE_MIN_SPACING_SAMPLES
        ? bins
            .slice(firstIsolated < 0 ? STYLE_SPACING_EDGES.length : firstIsolated + 1)
            .reduce((sum, value) => sum + value, 0) / total
        : null;
    }
    case 'risk':
      return enoughFights ? fight(vector, 'timesDowned') / fights : null;
    case 'zoneEdge':
      return scalar(vector, 'zoneSamples') >= STYLE_MIN_ZONE_SAMPLES
        ? scalar(vector, 'zoneEdgeSamples') / scalar(vector, 'zoneSamples')
        : null;
    case 'foot':
      return enoughTime ? scalar(vector, 'footMeters') / minutes : null;
    case 'mobility':
      return enoughTime ? scalar(vector, 'rides') / minutes : null;
    case 'dpm':
      return enoughTime ? (gun + scalar(vector, 'explosiveDamage')) / minutes : null;
    case 'hitRate': {
      const shot = mixTotals(vector);
      return shot.shots >= STYLE_MIN_SHOTS ? shot.hits / shot.shots : null;
    }
    case 'firstShot':
      return scalar(vector, 'firstShots') >= STYLE_MIN_SPLIT_SHOTS
        ? scalar(vector, 'firstHits') / scalar(vector, 'firstShots')
        : null;
    case 'followShot':
      return scalar(vector, 'followShots') >= STYLE_MIN_SPLIT_SHOTS
        ? scalar(vector, 'followHits') / scalar(vector, 'followShots')
        : null;
    case 'burst':
      return scalar(vector, 'shots') >= STYLE_MIN_SHOTS
        ? scalar(vector, 'followShots') / scalar(vector, 'shots')
        : null;
    case 'dmgPerShot': {
      const shot = mixTotals(vector);
      return shot.shots >= STYLE_MIN_SHOTS ? shot.hitDamage / shot.shots : null;
    }
    case 'knockRate':
      return enoughFights ? fight(vector, 'fightsWithKnock') / fights : null;
    case 'conversion':
      return fight(vector, 'chainsDealt') >= STYLE_MIN_KNOCKS
        ? fight(vector, 'chainsFinished') / fight(vector, 'chainsDealt')
        : null;
    case 'combat':
      return null;
  }
}

export interface StyleInputMatch {
  matchId: string;
  players: Record<string, PlayerStyleMatch>;
}

/** stable: the 95% interval excludes parity; lean: the direction holds in most resamples; even: close to teammates. */
export type StyleTier = 'stable' | 'lean' | 'even' | 'unknown';

export interface AxisReading {
  key: StyleAxisKey;
  group: StyleGroup;
  label: string;
  value: number | null;
  /** The same metric pooled over the player's teammates. */
  matesValue: number | null;
  /** Player value divided by the teammates' pooled value. */
  ratio: number | null;
  /** 95% bootstrap interval of the ratio across matches. */
  low: number | null;
  high: number | null;
  /** Share of resamples that agree with the direction of the point estimate. */
  confidence: number | null;
  tier: StyleTier;
  direction: 'high' | 'low' | null;
  /** True when the interval excludes 1 (kept for callers that only need a flag). */
  stable: boolean;
}

export interface StyleTrait {
  key: StyleAxisKey;
  text: string;
  ratio: number;
  tier: 'stable' | 'lean';
  confidence: number | null;
}

/** stable and lean name a type; slight is a faint lean ("偏…"); balanced means close to teammates on everything. */
export type ArchetypeTier = 'stable' | 'lean' | 'slight' | 'balanced';

export interface PlayerStyle {
  accountId: string;
  name: string;
  matches: number;
  minutes: number;
  axes: AxisReading[];
  traits: StyleTrait[];
  archetypes: Array<{ id: string; label: string; score: number; tier: ArchetypeTier }>;
  classShares: Array<{ weaponClass: WeaponClass; share: number }>;
  weapons: Array<{ weapon: string; share: number }>;
  landingSpread: number | null;
  summary: string;
}

export interface StyleOverlap {
  accountIds: [string, string];
  names: [string, string];
  similarity: number;
  sharedTraits: string[];
}

export interface AxisSpread {
  key: StyleAxisKey;
  group: StyleGroup;
  label: string;
  highest: { name: string; value: number; ratio: number | null; tier: StyleTier };
  lowest: { name: string; value: number; ratio: number | null; tier: StyleTier };
  /** Highest value divided by lowest value; how differently the squad plays on this axis. */
  spread: number;
  /** True when at least one of the two extremes is a stable or lean difference from teammates. */
  supported: boolean;
}

export interface CombatEntry {
  accountId: string;
  name: string;
  rank: number;
  ratio: number | null;
  low: number | null;
  high: number | null;
  confidence: number | null;
  tier: StyleTier;
  components: Array<{ key: StyleAxisKey; label: string; ratio: number | null; tier: StyleTier }>;
}

/** Shots to hits to knocks to kills for one member, summed over matches. */
export interface FunnelEntry {
  accountId: string;
  name: string;
  fights: number;
  minutes: number;
  /** Aimed shots (inside fights, not into downed players) and the ones that hurt a standing opponent. */
  shots: number;
  hits: number;
  hitRate: number | null;
  /** Hit rate of the first shot of a burst (or a single shot) and of the follow-up bullets of an automatic burst. */
  firstShotRate: number | null;
  followShotRate: number | null;
  /** Share of aimed shots that were follow-up bullets of a burst. */
  burstShare: number | null;
  /** Shots fired with nobody hurt around them, as a share of all shots that were not finishing shots. */
  idleShare: number | null;
  /** Shots into downed opponents, as a share of all shots. */
  finishingShare: number | null;
  hitDamage: number;
  damagePerShot: number | null;
  damagePerMinute: number | null;
  knocks: number;
  hitsPerKnock: number | null;
  kills: number;
  knockFights: number;
  knockRate: number | null;
  chainsDealt: number;
  chainsFinished: number;
  conversion: number | null;
}

export interface CombatHighlight {
  name: string;
  label: string;
  ratio: number;
  tier: 'stable' | 'lean';
  confidence: number | null;
}

export interface SquadStyle {
  schemaVersion: typeof STYLE_SCHEMA_VERSION;
  ruleVersion: typeof STYLE_RULE_VERSION;
  matches: number;
  players: PlayerStyle[];
  /** One sentence on who fights best, or that the squad cannot be separated on the overall index. */
  combatVerdict: string;
  /** Component-level strengths and weaknesses that are stable or lean, strongest first. */
  combatHighlights: CombatHighlight[];
  combat: CombatEntry[];
  funnel: FunnelEntry[];
  spreads: AxisSpread[];
  overlaps: StyleOverlap[];
  gaps: string[];
  notes: string[];
}

const ARCHETYPES: ReadonlyArray<{
  id: string;
  label: string;
  weights: Partial<Record<StyleAxisKey, number>>;
  blurb: string;
}> = [
  {
    id: 'rusher',
    label: '近战突击手',
    weights: { range: -1, closeShare: 0.8, closeGun: 0.4, initiative: 0.5, tempo: 0.3 },
    blurb: '喜欢贴脸开团、抢先手',
  },
  {
    id: 'marksman',
    label: '远程火力手',
    weights: { range: 1, farShare: 0.8, marksman: 0.6, precision: 0.3 },
    blurb: '在中远距离提供火力',
  },
  {
    id: 'fragger',
    label: '火力收割手',
    weights: { fragging: 1, tempo: 0.3, precision: 0.3 },
    blurb: '交战里击倒和收人头更多',
  },
  {
    id: 'roamer',
    label: '游击单兵',
    weights: { isolation: 1, foot: 0.5, mobility: 0.3 },
    blurb: '常脱离队友单独行动',
  },
  {
    id: 'support',
    label: '后勤支援',
    weights: { revive: 1, utility: 0.5, supplies: 0.3, fragging: -0.3 },
    blurb: '救援和补位见长',
  },
  {
    id: 'anchor',
    label: '贴队稳健型',
    weights: { isolation: -1, risk: -0.4, zoneEdge: -0.2 },
    blurb: '紧跟队友、很少冒险',
  },
  {
    id: 'vanguard',
    label: '前排先锋',
    weights: { risk: 1, tempo: 0.4, initiative: 0.3 },
    blurb: '站在最前面承受火力',
  },
  {
    id: 'late',
    label: '后期输出型',
    weights: { lateGame: 1, earlyLoot: -0.2, tempo: -0.2 },
    blurb: '前期低调、后期才发力',
  },
  {
    id: 'carry',
    label: '输出核心',
    weights: { combat: 1, dpm: 0.4, hitRate: 0.3 },
    blurb: '综合输出明显强于队友',
  },
  {
    id: 'scavenger',
    label: '发育搜刮型',
    weights: { earlyLoot: 1, supplies: 0.3, lateGame: 0.2 },
    blurb: '落地后搜刮快、补给足',
  },
];

function clip(value: number, limit = 1.2): number {
  return Math.max(-limit, Math.min(limit, value));
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))))
  ]!;
}

interface Sums {
  perPlayer: Map<string, Vec>;
  pooled: Vec;
}

function sumMatches(matches: readonly StyleInputMatch[], indexes: readonly number[]): Sums {
  const perPlayer = new Map<string, Vec>();
  const pooled = new Float64Array(VECTOR_LENGTH);
  for (const index of indexes) {
    for (const [accountId, stats] of Object.entries(matches[index]!.players)) {
      const vector = toVector(stats);
      const target = perPlayer.get(accountId) ?? new Float64Array(VECTOR_LENGTH);
      addVec(target, vector);
      perPlayer.set(accountId, target);
      addVec(pooled, vector);
    }
  }
  return { perPlayer, pooled };
}

function ratioOf(own: number | null, base: number | null): number | null {
  return own !== null && base !== null && base > 0 ? own / base : null;
}

/** Axes whose raw value depends on which weapons were fired; compared on the player's own weapon mix. */
const MIX_ADJUSTED: ReadonlySet<StyleAxisKey> = new Set(['hitRate', 'dmgPerShot']);

/**
 * The player's value and what the teammates would score firing the player's own weapon mix (indirect
 * standardisation by weapon class). Without it a sniper out-"aims" a sprayer simply by using a bolt-action.
 * Each teammate class rate is shrunk toward the teammates' overall rate with a STYLE_CLASS_PRIOR_SHOTS prior.
 */
function axisPair(
  key: StyleAxisKey,
  own: Vec,
  mates: Vec,
): { value: number | null; matesValue: number | null } {
  const value = axisValue(key, own);
  if (!MIX_ADJUSTED.has(key)) return { value, matesValue: axisValue(key, mates) };
  const matesMix = mixTotals(mates);
  if (value === null || matesMix.shots < STYLE_MIN_SHOTS) return { value, matesValue: null };
  const useDamage = key === 'dmgPerShot';
  const matesOverall = (useDamage ? matesMix.hitDamage : matesMix.hits) / matesMix.shots;
  const ownShots = slice(own, 'classShots', CLASS_ORDER.length);
  const mateShots = slice(mates, 'classShots', CLASS_ORDER.length);
  const mateYield = slice(mates, useDamage ? 'classHitDamage' : 'classHits', CLASS_ORDER.length);
  let expected = 0;
  let shots = 0;
  CLASS_ORDER.forEach((weaponClass, index) => {
    const rate =
      (mateYield[index]! + STYLE_CLASS_PRIOR_SHOTS * matesOverall) /
      (mateShots[index]! + STYLE_CLASS_PRIOR_SHOTS);
    expected += ownShots[index]! * rate;
    shots += ownShots[index]!;
  });
  return { value, matesValue: shots > 0 ? expected / shots : null };
}

function pairRatio(key: StyleAxisKey, own: Vec, mates: Vec): number | null {
  const { value, matesValue } = axisPair(key, own, mates);
  return ratioOf(value, matesValue);
}

export function tierFor(
  ratio: number | null,
  low: number | null,
  high: number | null,
  confidence: number | null,
): { tier: StyleTier; direction: 'high' | 'low' | null } {
  if (ratio === null) return { tier: 'unknown', direction: null };
  const direction = ratio >= 1 ? 'high' : 'low';
  const notable = ratio >= STYLE_NOTABLE_RATIO || ratio <= 1 / STYLE_NOTABLE_RATIO;
  if (!notable) return { tier: 'even', direction };
  if (low !== null && high !== null && (low > 1 || high < 1)) return { tier: 'stable', direction };
  if (confidence !== null && confidence >= STYLE_LEAN_CONFIDENCE)
    return { tier: 'lean', direction };
  return { tier: 'even', direction };
}

export interface BuildSquadStyleInput {
  matches: readonly StyleInputMatch[];
  names: ReadonlyMap<string, string>;
}

/**
 * One style profile per member: nineteen measurable axes, each expressed as a ratio to the player's teammates
 * (excluding the player) with a bootstrap interval over matches. Differences are graded stable, lean or even,
 * so a squad that plays alike still gets honest, ranked tendencies instead of an empty card.
 */
export function buildSquadStyle(input: BuildSquadStyleInput): SquadStyle {
  const { matches } = input;
  const all = matches.map((_, index) => index);
  const base = sumMatches(matches, all);
  const accountIds = [...base.perPlayer.keys()];
  const rng = mulberry32(STYLE_BOOTSTRAP_SEED);
  const composite = STYLE_AXES.find((axis) => axis.composite)!;
  const draws = new Map<string, Map<StyleAxisKey, number[]>>(
    accountIds.map((id) => [id, new Map(STYLE_AXES.map((axis) => [axis.key, [] as number[]]))]),
  );
  /** Weighted mean log2 ratio of the composite's components; needs damage per minute plus one other. */
  const compositeLog = (logs: Map<StyleAxisKey, number>): number | null => {
    const present = (composite.composite ?? []).filter((key) => logs.has(key));
    if (!logs.has('dpm') || present.length < 2) return null;
    const weight = present.reduce((sum, key) => sum + (COMBAT_WEIGHTS[key] ?? 0), 0);
    return (
      present.reduce((sum, key) => sum + logs.get(key)! * (COMBAT_WEIGHTS[key] ?? 0), 0) / weight
    );
  };
  if (matches.length >= 8) {
    for (let round = 0; round < STYLE_BOOTSTRAP_RESAMPLES; round += 1) {
      const draw = Array.from({ length: matches.length }, () => Math.floor(rng() * matches.length));
      const resampled = sumMatches(matches, draw);
      for (const id of accountIds) {
        const own = resampled.perPlayer.get(id);
        if (!own) continue;
        const mates = subtractVec(resampled.pooled, own);
        const logs = new Map<StyleAxisKey, number>();
        for (const axis of STYLE_AXES) {
          if (axis.composite) continue;
          const value = pairRatio(axis.key, own, mates);
          if (value !== null && value > 0) {
            logs.set(axis.key, Math.log2(value));
            draws.get(id)!.get(axis.key)!.push(Math.log2(value));
          }
        }
        const combined = compositeLog(logs);
        if (combined !== null) draws.get(id)!.get(composite.key)!.push(combined);
      }
    }
  }

  const readingsByPlayer = new Map<string, AxisReading[]>();
  for (const accountId of accountIds) {
    const own = base.perPlayer.get(accountId)!;
    const mates = subtractVec(base.pooled, own);
    const baseLogs = new Map<StyleAxisKey, number>();
    for (const axis of STYLE_AXES) {
      if (axis.composite) continue;
      const value = pairRatio(axis.key, own, mates);
      if (value !== null && value > 0) baseLogs.set(axis.key, Math.log2(value));
    }
    readingsByPlayer.set(
      accountId,
      STYLE_AXES.map((axis): AxisReading => {
        let value: number | null;
        let matesValue: number | null;
        let ratio: number | null;
        if (axis.composite) {
          const combined = compositeLog(baseLogs);
          ratio = combined === null ? null : 2 ** combined;
          value = ratio;
          matesValue = ratio === null ? null : 1;
        } else {
          ({ value, matesValue } = axisPair(axis.key, own, mates));
          ratio = ratioOf(value, matesValue);
        }
        const sorted = [...(draws.get(accountId)!.get(axis.key) ?? [])].sort(
          (left, right) => left - right,
        );
        const enough = sorted.length >= STYLE_BOOTSTRAP_RESAMPLES * 0.8;
        const low = enough ? 2 ** percentile(sorted, 0.025) : null;
        const high = enough ? 2 ** percentile(sorted, 0.975) : null;
        const confidence =
          enough && ratio !== null
            ? sorted.filter((draw) => (ratio >= 1 ? draw > 0 : draw < 0)).length / sorted.length
            : null;
        const { tier, direction } = tierFor(ratio, low, high, confidence);
        return {
          key: axis.key,
          group: axis.group,
          label: axis.label,
          value,
          matesValue,
          ratio,
          low,
          high,
          confidence,
          tier,
          direction,
          stable: tier === 'stable',
        };
      }),
    );
  }

  const players: PlayerStyle[] = accountIds
    .map((accountId) => {
      const axes = readingsByPlayer.get(accountId)!;
      const traits: StyleTrait[] = axes
        .filter(
          (axis) =>
            (axis.tier === 'stable' || axis.tier === 'lean') &&
            axis.ratio !== null &&
            !STYLE_AXES.find((item) => item.key === axis.key)?.composite,
        )
        .map((axis) => {
          const definition = STYLE_AXES.find((item) => item.key === axis.key)!;
          return {
            key: axis.key,
            text: axis.direction === 'high' ? definition.high : definition.low,
            ratio: axis.ratio!,
            tier: axis.tier as 'stable' | 'lean',
            confidence: axis.confidence,
          };
        })
        .sort(
          (left, right) =>
            (left.tier === right.tier ? 0 : left.tier === 'stable' ? -1 : 1) ||
            Math.abs(Math.log2(right.ratio)) - Math.abs(Math.log2(left.ratio)),
        )
        .slice(0, 5);

      const scoreOf = (
        weights: Partial<Record<StyleAxisKey, number>>,
      ): { score: number; stable: boolean } => {
        let total = 0;
        let stable = false;
        for (const [key, weight] of Object.entries(weights) as Array<[StyleAxisKey, number]>) {
          const reading = axes.find((axis) => axis.key === key);
          if (!reading?.ratio || reading.tier === 'unknown') continue;
          const factor =
            reading.tier === 'stable' ? 1 : reading.tier === 'lean' ? 0.6 : STYLE_EVEN_FACTOR;
          const contribution = weight * clip(Math.log2(reading.ratio)) * factor;
          total += contribution;
          if (reading.tier === 'stable' && contribution > 0) stable = true;
        }
        return { score: total, stable };
      };
      const ranked = ARCHETYPES.map((archetype) => ({
        archetype,
        ...scoreOf(archetype.weights),
      })).sort((left, right) => right.score - left.score);
      const tierOf = (entry: { score: number; stable: boolean }): ArchetypeTier | null =>
        entry.score >= STYLE_ARCHETYPE_STRONG && entry.stable
          ? 'stable'
          : entry.score >= STYLE_ARCHETYPE_LEAN
            ? 'lean'
            : entry.score >= STYLE_ARCHETYPE_SLIGHT
              ? 'slight'
              : null;
      const archetypes: PlayerStyle['archetypes'] = [];
      const first = ranked[0]!;
      const firstTier = tierOf(first);
      if (firstTier) {
        archetypes.push({
          id: first.archetype.id,
          label: first.archetype.label,
          score: first.score,
          tier: firstTier,
        });
        const second = ranked[1]!;
        const secondTier = tierOf(second);
        if (secondTier && secondTier !== 'slight')
          archetypes.push({
            id: second.archetype.id,
            label: second.archetype.label,
            score: second.score,
            tier: secondTier,
          });
      } else {
        archetypes.push({
          id: 'balanced',
          label: '均衡全能型',
          score: first.score,
          tier: 'balanced',
        });
      }

      const weaponTotals = new Map<string, number>();
      const classTotals = new Map<WeaponClass, number>();
      let landing = 0;
      let landingCount = 0;
      let matchCount = 0;
      for (const match of matches) {
        const stats = match.players[accountId];
        if (!stats) continue;
        matchCount += 1;
        for (const [weapon, damage] of Object.entries(stats.weaponDamage)) {
          weaponTotals.set(weapon, (weaponTotals.get(weapon) ?? 0) + damage);
          const weaponClass = weaponClassOf(weapon);
          classTotals.set(weaponClass, (classTotals.get(weaponClass) ?? 0) + damage);
        }
        if (stats.landingSpread !== null) {
          landing += stats.landingSpread;
          landingCount += 1;
        }
      }
      const weaponSum = [...weaponTotals.values()].reduce((sum, value) => sum + value, 0);
      const lead = traits
        .slice(0, 3)
        .map((trait) => `${trait.tier === 'lean' ? '倾向于' : ''}${trait.text}`)
        .join('；');
      const nameOfArchetype = (entry: PlayerStyle['archetypes'][number]) =>
        entry.tier === 'slight'
          ? `偏${entry.label}`
          : entry.tier === 'lean'
            ? `${entry.label}（倾向）`
            : entry.label;
      const archetypeText = archetypes.map(nameOfArchetype).join(' + ');
      const blurb =
        archetypes[0]!.id === 'balanced'
          ? '各项都接近队友，没有明显的短板或特长'
          : ARCHETYPES.find((item) => item.id === archetypes[0]!.id)!.blurb;
      return {
        accountId,
        name: input.names.get(accountId) ?? '未知',
        matches: matchCount,
        minutes: scalar(base.perPlayer.get(accountId)!, 'minutes'),
        axes,
        traits,
        archetypes,
        classShares: [...classTotals.entries()]
          .map(([weaponClass, damage]) => ({
            weaponClass,
            share: weaponSum > 0 ? damage / weaponSum : 0,
          }))
          .sort((left, right) => right.share - left.share)
          .slice(0, 4),
        weapons: [...weaponTotals.entries()]
          .map(([weapon, damage]) => ({ weapon, share: weaponSum > 0 ? damage / weaponSum : 0 }))
          .sort(
            (left, right) => right.share - left.share || left.weapon.localeCompare(right.weapon),
          )
          .slice(0, 3),
        landingSpread: landingCount ? landing / landingCount : null,
        summary: `${archetypeText}：${blurb}${lead ? `；${lead}` : ''}。`,
      };
    })
    .sort((left, right) => right.minutes - left.minutes || left.name.localeCompare(right.name));

  const combat: CombatEntry[] = players
    .map((player) => ({ player, reading: player.axes.find((axis) => axis.key === composite.key)! }))
    .sort((left, right) => (right.reading.ratio ?? -Infinity) - (left.reading.ratio ?? -Infinity))
    .map(({ player, reading }, index) => ({
      accountId: player.accountId,
      name: player.name,
      rank: index + 1,
      ratio: reading.ratio,
      low: reading.low,
      high: reading.high,
      confidence: reading.confidence,
      tier: reading.tier,
      components: (composite.composite ?? []).map((key) => {
        const component = player.axes.find((axis) => axis.key === key)!;
        return { key, label: component.label, ratio: component.ratio, tier: component.tier };
      }),
    }));

  const leader = combat[0];
  const trailer = combat.at(-1);
  const combatVerdict =
    !leader || leader.ratio === null
      ? '样本不足，暂时无法比较战斗力。'
      : (leader.tier === 'stable' || leader.tier === 'lean') && leader.ratio > 1
        ? `综合战斗力最强：${leader.name}（×${leader.ratio.toFixed(2)}，${leader.tier === 'stable' ? '稳定领先' : `领先的把握约 ${leader.confidence === null ? '—' : (leader.confidence * 100).toFixed(0)}%`}）。`
        : `综合战斗力没有显著差距：最高 ${leader.name} ×${leader.ratio.toFixed(2)}，最低 ${trailer?.name ?? ''} ×${(trailer?.ratio ?? 1).toFixed(2)}，差异都在抽样误差内；差别主要体现在下面的单项上。`;
  const combatHighlights: CombatHighlight[] = combat
    .flatMap((entry) =>
      entry.components
        .filter(
          (component) =>
            (component.tier === 'stable' || component.tier === 'lean') && component.ratio !== null,
        )
        .map((component) => ({
          name: entry.name,
          label: component.label,
          ratio: component.ratio!,
          tier: component.tier as 'stable' | 'lean',
          confidence:
            players
              .find((player) => player.accountId === entry.accountId)
              ?.axes.find((axis) => axis.key === component.key)?.confidence ?? null,
        })),
    )
    .sort(
      (left, right) =>
        (left.tier === right.tier ? 0 : left.tier === 'stable' ? -1 : 1) ||
        Math.abs(Math.log2(right.ratio)) - Math.abs(Math.log2(left.ratio)),
    )
    .slice(0, 8);

  const funnel: FunnelEntry[] = players.map((player) => {
    const vector = base.perPlayer.get(player.accountId)!;
    const { shots, hits, hitDamage } = mixTotals(vector);
    const idle = scalar(vector, 'idleShots');
    const finishing = scalar(vector, 'finishingShots');
    const minutes = scalar(vector, 'minutes');
    const knocks = fight(vector, 'knocksDealt');
    const dealt = fight(vector, 'chainsDealt');
    const fights = fight(vector, 'fights');
    return {
      accountId: player.accountId,
      name: player.name,
      fights,
      minutes,
      shots,
      hits,
      hitRate: shots > 0 ? hits / shots : null,
      firstShotRate:
        scalar(vector, 'firstShots') > 0
          ? scalar(vector, 'firstHits') / scalar(vector, 'firstShots')
          : null,
      followShotRate:
        scalar(vector, 'followShots') > 0
          ? scalar(vector, 'followHits') / scalar(vector, 'followShots')
          : null,
      burstShare: shots > 0 ? scalar(vector, 'followShots') / shots : null,
      idleShare: shots + idle > 0 ? idle / (shots + idle) : null,
      finishingShare: shots + idle + finishing > 0 ? finishing / (shots + idle + finishing) : null,
      hitDamage,
      damagePerShot: shots > 0 ? hitDamage / shots : null,
      damagePerMinute:
        minutes > 0
          ? (scalar(vector, 'gunDamage') + scalar(vector, 'explosiveDamage')) / minutes
          : null,
      knocks,
      hitsPerKnock: knocks > 0 ? hits / knocks : null,
      kills: fight(vector, 'kills'),
      knockFights: fight(vector, 'fightsWithKnock'),
      knockRate: fights > 0 ? fight(vector, 'fightsWithKnock') / fights : null,
      chainsDealt: dealt,
      chainsFinished: fight(vector, 'chainsFinished'),
      conversion: dealt > 0 ? fight(vector, 'chainsFinished') / dealt : null,
    };
  });

  const spreads: AxisSpread[] = [];
  for (const axis of STYLE_AXES) {
    if (axis.composite) continue;
    const entries = players
      .map((player) => ({ player, reading: player.axes.find((item) => item.key === axis.key)! }))
      .filter((item) => item.reading.value !== null);
    if (entries.length < 3) continue;
    const ordered = [...entries].sort((left, right) => left.reading.value! - right.reading.value!);
    const lowest = ordered[0]!;
    const highest = ordered.at(-1)!;
    if (!(lowest.reading.value! > 0)) continue;
    const supported = [lowest, highest].some(
      (item) => item.reading.tier === 'stable' || item.reading.tier === 'lean',
    );
    spreads.push({
      key: axis.key,
      group: axis.group,
      label: axis.label,
      highest: {
        name: highest.player.name,
        value: highest.reading.value!,
        ratio: highest.reading.ratio,
        tier: highest.reading.tier,
      },
      lowest: {
        name: lowest.player.name,
        value: lowest.reading.value!,
        ratio: lowest.reading.ratio,
        tier: lowest.reading.tier,
      },
      spread: highest.reading.value! / lowest.reading.value!,
      supported,
    });
  }
  spreads.sort(
    (left, right) => Number(right.supported) - Number(left.supported) || right.spread - left.spread,
  );

  const vector = (player: PlayerStyle): number[] =>
    player.axes.map((axis) =>
      axis.ratio !== null && (axis.tier === 'stable' || axis.tier === 'lean')
        ? clip(Math.log2(axis.ratio))
        : 0,
    );
  const overlaps: StyleOverlap[] = [];
  for (let left = 0; left < players.length; left += 1) {
    for (let right = left + 1; right < players.length; right += 1) {
      const a = vector(players[left]!);
      const b = vector(players[right]!);
      const norm = Math.hypot(...a) * Math.hypot(...b);
      if (norm === 0) continue;
      const similarity = a.reduce((sum, value, index) => sum + value * b[index]!, 0) / norm;
      const shared = players[left]!.traits.filter((trait) =>
        players[right]!.traits.some(
          (other) => other.key === trait.key && other.ratio >= 1 === trait.ratio >= 1,
        ),
      ).map((trait) => trait.text);
      if (similarity >= 0.6 && shared.length)
        overlaps.push({
          accountIds: [players[left]!.accountId, players[right]!.accountId],
          names: [players[left]!.name, players[right]!.name],
          similarity,
          sharedTraits: shared,
        });
    }
  }
  overlaps.sort((left, right) => right.similarity - left.similarity);

  const gaps: string[] = [];
  const anyHigh = (key: StyleAxisKey) =>
    players.some((player) => {
      const reading = player.axes.find((axis) => axis.key === key);
      return (
        reading?.direction === 'high' && (reading.tier === 'stable' || reading.tier === 'lean')
      );
    });
  if (players.length >= 3 && matches.length >= 20) {
    const withoutTraits = players.filter((player) => player.traits.length === 0).length;
    if (withoutTraits >= players.length - 1) {
      gaps.push(
        `小队打法高度同质：${players.length} 人中有 ${withoutTraits} 人与队友相比没有任何稳定或倾向性的差异，还没有形成明确的分工。`,
      );
    }
    if (!anyHigh('range') && !anyHigh('farShare'))
      gaps.push('没有人偏向远距离输出，小队缺少固定的远程火力点。');
    if (!anyHigh('revive'))
      gaps.push('没有人在救援上明显突出，倒地后的补位可能依赖随机的最近队友。');
    if (!anyHigh('utility'))
      gaps.push('没有人明显偏爱投掷物，烟雾和手雷的战术价值没有被系统利用。');
  }
  return {
    schemaVersion: STYLE_SCHEMA_VERSION,
    ruleVersion: STYLE_RULE_VERSION,
    matches: matches.length,
    players,
    combatVerdict,
    combatHighlights,
    combat,
    funnel,
    spreads,
    overlaps: overlaps.slice(0, 3),
    gaps,
    notes: [
      `每个维度是「个人值 ÷ 队友合计值」（不含自己），×1.00 即与队友持平。分三档：稳定 = 95% 重抽样区间不含 1 且比值 ≥${STYLE_NOTABLE_RATIO} 或 ≤${(1 / STYLE_NOTABLE_RATIO).toFixed(2)}；倾向 = 方向在 ≥${STYLE_LEAN_CONFIDENCE * 100}% 的重抽样中一致但区间跨过 1，只能说「更可能」；其余视为持平。`,
      `战斗力指数 = 每分钟伤害、命中率、交战击倒率、击倒转化率、爆头率五项比值的几何平均，区间由同一批重抽样得到。类型标签由固定加权规则给出：稳定且得分高才直接命名，较弱时写「偏…」，全部接近队友时记为「均衡全能型」。`,
    ],
  };
}
