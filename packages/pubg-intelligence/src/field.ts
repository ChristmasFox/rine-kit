import { parseTelemetryPayload } from '@rine-kit/pubg-domain';
import { normalizeWeaponName, wilsonInterval, type RateEstimate } from './analytics.js';

export const FIELD_SCHEMA_VERSION = 1 as const;

/** Engagement distance bands in metres; the last band is open ended. */
export const DISTANCE_BANDS = [
  { id: 'close', label: '近距 <25m', maxMeters: 25 },
  { id: 'mid', label: '中近 25–75m', maxMeters: 75 },
  { id: 'far', label: '中远 75–150m', maxMeters: 150 },
  { id: 'long', label: '远距 ≥150m', maxMeters: Infinity },
] as const;
export const DISTANCE_MIN_DAMAGE = 600;
export const DISTANCE_GAP_POINTS = 0.1;
export const ZONE_MAX_PHASE = 9;
export const ZONE_MIN_SAMPLES = 150;
export const ZONE_BIN_EDGES = [0.5, 0.85, 1] as const;
export const CONTEST_RADIUS_METERS = 500;
export const CONTEST_MIN_MATCHES = 8;

const BAND_COUNT = DISTANCE_BANDS.length;

export function distanceBandOf(meters: number): number {
  const index = DISTANCE_BANDS.findIndex((band) => meters < band.maxMeters);
  return index < 0 ? BAND_COUNT - 1 : index;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface Point {
  x: number;
  y: number;
  z: number;
}

function point(value: unknown): Point | null {
  const location = obj(value);
  const x = num(location.x);
  const y = num(location.y);
  if (x === null || y === null) return null;
  return { x, y, z: num(location.z) ?? 0 };
}

function inMatchPhase(event: Record<string, unknown>): number | null {
  const value = num(obj(event.common).isGame);
  return value !== null && value >= 1 ? value : null;
}

export interface ZonePhaseStats {
  samples: number;
  blueSamples: number;
  /** Position samples by distance from the safe-zone centre divided by its radius: <0.5, 0.5-0.85, 0.85-1, outside. */
  bins: [number, number, number, number];
  blueDamage: number;
}

export interface FieldMatchStats {
  distance: {
    dealt: number[];
    dealtHead: number[];
    taken: number[];
    takenHead: number[];
    weapons: Record<string, number[]>;
  };
  zone: {
    phases: Record<number, ZonePhaseStats>;
    blueDamage: number;
    damageTaken: number;
  };
  landing: {
    /** Other teams whose nearest member landed within the contest radius of the squad centre; null without landings. */
    contestedTeams: number | null;
    nearestEnemyMeters: number | null;
    /** Most common named map area reported after landing. */
    region: string | null;
  };
}

function emptyPhase(): ZonePhaseStats {
  return { samples: 0, blueSamples: 0, bins: [0, 0, 0, 0], blueDamage: 0 };
}

/**
 * One pass over a raw telemetry payload for the tracked squad: damage by engagement distance, time spent
 * outside the safe zone, blue-zone damage and how crowded the landing spot was.
 */
export function analyzeFieldTelemetry(
  payload: unknown,
  trackedIds: ReadonlySet<string>,
): FieldMatchStats {
  const stats: FieldMatchStats = {
    distance: {
      dealt: new Array<number>(BAND_COUNT).fill(0),
      dealtHead: new Array<number>(BAND_COUNT).fill(0),
      taken: new Array<number>(BAND_COUNT).fill(0),
      takenHead: new Array<number>(BAND_COUNT).fill(0),
      weapons: {},
    },
    zone: { phases: {}, blueDamage: 0, damageTaken: 0 },
    landing: { contestedTeams: null, nearestEnemyMeters: null, region: null },
  };
  const phase = (value: number): ZonePhaseStats => {
    const key = Math.min(ZONE_MAX_PHASE, Math.max(1, Math.floor(value)));
    return (stats.zone.phases[key] ??= emptyPhase());
  };

  let safety: { center: Point; radius: number } | null = null;
  const landings: Array<{ accountId: string; teamId: string; x: number; y: number; time: number }> =
    [];
  const landedAt = new Map<string, number>();
  const regions = new Map<string, number>();
  const regionSeen = new Set<string>();

  for (const raw of parseTelemetryPayload(payload)) {
    const event = obj(raw);
    const type = event._T;
    const time = typeof event._D === 'string' ? Date.parse(event._D) : NaN;

    if (type === 'LogGameStatePeriodic') {
      if (inMatchPhase(event) === null) continue;
      const state = obj(event.gameState);
      const center = point(state.safetyZonePosition);
      const radius = num(state.safetyZoneRadius);
      if (center && radius !== null && radius > 0) safety = { center, radius };
      continue;
    }

    if (type === 'LogParachuteLanding') {
      const character = obj(event.character);
      const accountId = typeof character.accountId === 'string' ? character.accountId : null;
      const location = point(character.location);
      if (!accountId || !location) continue;
      landings.push({
        accountId,
        teamId: String(character.teamId ?? ''),
        x: location.x / 100,
        y: location.y / 100,
        time,
      });
      if (trackedIds.has(accountId)) landedAt.set(accountId, time);
      continue;
    }

    if (type === 'LogPlayerPosition') {
      const character = obj(event.character);
      const accountId = typeof character.accountId === 'string' ? character.accountId : null;
      if (!accountId || !trackedIds.has(accountId)) continue;
      const landed = landedAt.get(accountId);
      if (landed !== undefined && !regionSeen.has(accountId) && time >= landed) {
        const zones = Array.isArray(character.zone) ? character.zone : [];
        const name = typeof zones[0] === 'string' ? zones[0] : null;
        if (name) {
          regionSeen.add(accountId);
          regions.set(name, (regions.get(name) ?? 0) + 1);
        }
      }
      const phaseValue = inMatchPhase(event);
      const location = point(character.location);
      if (phaseValue === null || !location) continue;
      const entry = phase(phaseValue);
      entry.samples += 1;
      if (character.isInBlueZone === true) entry.blueSamples += 1;
      if (safety) {
        const ratio =
          Math.hypot(location.x - safety.center.x, location.y - safety.center.y) / safety.radius;
        const bin =
          ratio < ZONE_BIN_EDGES[0]
            ? 0
            : ratio < ZONE_BIN_EDGES[1]
              ? 1
              : ratio <= ZONE_BIN_EDGES[2]
                ? 2
                : 3;
        entry.bins[bin] += 1;
      }
      continue;
    }

    if (type === 'LogPlayerTakeDamage') {
      const phaseValue = inMatchPhase(event);
      if (phaseValue === null) continue;
      const damage = num(event.damage);
      if (damage === null || damage <= 0) continue;
      const attacker = obj(event.attacker);
      const victim = obj(event.victim);
      const victimId = typeof victim.accountId === 'string' ? victim.accountId : null;
      const attackerId = typeof attacker.accountId === 'string' ? attacker.accountId : null;
      const victimTracked = victimId !== null && trackedIds.has(victimId);
      const attackerTracked = attackerId !== null && trackedIds.has(attackerId);
      const category = typeof event.damageTypeCategory === 'string' ? event.damageTypeCategory : '';
      if (victimTracked) {
        stats.zone.damageTaken += damage;
        if (category === 'Damage_BlueZone' || category === 'Damage_BlueZoneGrenade') {
          stats.zone.blueDamage += damage;
          phase(phaseValue).blueDamage += damage;
        }
      }
      if (category !== 'Damage_Gun' || victimTracked === attackerTracked) continue;
      const from = point(attacker.location);
      const to = point(victim.location);
      if (!from || !to) continue;
      if (String(attacker.teamId ?? '') === String(victim.teamId ?? '')) continue;
      const meters = Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z) / 100;
      const band = distanceBandOf(meters);
      const head = event.damageReason === 'HeadShot';
      if (attackerTracked) {
        stats.distance.dealt[band]! += damage;
        if (head) stats.distance.dealtHead[band]! += damage;
        const weapon =
          typeof event.damageCauserName === 'string'
            ? normalizeWeaponName(event.damageCauserName)
            : null;
        if (weapon)
          (stats.distance.weapons[weapon] ??= new Array<number>(BAND_COUNT).fill(0))[band]! +=
            damage;
      } else {
        stats.distance.taken[band]! += damage;
        if (head) stats.distance.takenHead[band]! += damage;
      }
    }
  }

  const mine = landings.filter((landing) => trackedIds.has(landing.accountId));
  if (mine.length) {
    const cx = mine.reduce((sum, landing) => sum + landing.x, 0) / mine.length;
    const cy = mine.reduce((sum, landing) => sum + landing.y, 0) / mine.length;
    const ourTeams = new Set(mine.map((landing) => landing.teamId));
    const nearestByTeam = new Map<string, number>();
    for (const landing of landings) {
      if (ourTeams.has(landing.teamId) || trackedIds.has(landing.accountId)) continue;
      const distance = Math.hypot(landing.x - cx, landing.y - cy);
      nearestByTeam.set(
        landing.teamId,
        Math.min(nearestByTeam.get(landing.teamId) ?? Infinity, distance),
      );
    }
    const nearest = [...nearestByTeam.values()];
    stats.landing.contestedTeams = nearest.filter(
      (distance) => distance <= CONTEST_RADIUS_METERS,
    ).length;
    stats.landing.nearestEnemyMeters = nearest.length ? Math.min(...nearest) : null;
    stats.landing.region =
      [...regions.entries()].sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )[0]?.[0] ?? null;
  }
  return stats;
}

export interface DistanceBandSummary {
  id: string;
  label: string;
  dealt: number;
  taken: number;
  dealtShare: number | null;
  takenShare: number | null;
  /** Share of dealt damage that was headshot damage. */
  headshotShare: number | null;
}

export interface WeaponDistanceSummary {
  weapon: string;
  damage: number;
  shares: number[];
  mainBand: string;
}

export interface DistanceSummary {
  matches: number;
  totalDealt: number;
  totalTaken: number;
  bands: DistanceBandSummary[];
  weapons: WeaponDistanceSummary[];
  /** Taken minus dealt share in the two long bands; positive means the squad absorbs more long-range damage than it deals. */
  longRangeGap: number | null;
}

export function summarizeDistance(items: readonly FieldMatchStats[]): DistanceSummary {
  const sumBand = (pick: (item: FieldMatchStats) => number[]) =>
    Array.from({ length: BAND_COUNT }, (_, band) =>
      items.reduce((total, item) => total + (pick(item)[band] ?? 0), 0),
    );
  const dealt = sumBand((item) => item.distance.dealt);
  const taken = sumBand((item) => item.distance.taken);
  const head = sumBand((item) => item.distance.dealtHead);
  const totalDealt = dealt.reduce((sum, value) => sum + value, 0);
  const totalTaken = taken.reduce((sum, value) => sum + value, 0);
  const weapons = new Map<string, number[]>();
  for (const item of items) {
    for (const [weapon, bands] of Object.entries(item.distance.weapons)) {
      const current = weapons.get(weapon) ?? new Array<number>(BAND_COUNT).fill(0);
      bands.forEach((value, index) => {
        current[index]! += value;
      });
      weapons.set(weapon, current);
    }
  }
  const longShare = (values: number[], total: number) =>
    total > 0 ? (values[2]! + values[3]!) / total : null;
  const dealtLong = longShare(dealt, totalDealt);
  const takenLong = longShare(taken, totalTaken);
  return {
    matches: items.length,
    totalDealt,
    totalTaken,
    bands: DISTANCE_BANDS.map((band, index) => ({
      id: band.id,
      label: band.label,
      dealt: dealt[index]!,
      taken: taken[index]!,
      dealtShare: totalDealt > 0 ? dealt[index]! / totalDealt : null,
      takenShare: totalTaken > 0 ? taken[index]! / totalTaken : null,
      headshotShare: dealt[index]! > 0 ? head[index]! / dealt[index]! : null,
    })),
    weapons: [...weapons.entries()]
      .map(([weapon, bands]) => {
        const total = bands.reduce((sum, value) => sum + value, 0);
        const main = bands.indexOf(Math.max(...bands));
        return {
          weapon,
          damage: total,
          shares: bands.map((value) => (total > 0 ? value / total : 0)),
          mainBand: DISTANCE_BANDS[main]!.label,
        };
      })
      .filter((entry) => entry.damage >= 200)
      .sort((left, right) => right.damage - left.damage || left.weapon.localeCompare(right.weapon))
      .slice(0, 8),
    longRangeGap:
      dealtLong !== null &&
      takenLong !== null &&
      totalDealt >= DISTANCE_MIN_DAMAGE &&
      totalTaken >= DISTANCE_MIN_DAMAGE
        ? takenLong - dealtLong
        : null,
  };
}

export interface ZonePhaseSummary {
  phase: number;
  samples: number;
  /** Share of position samples flagged as inside the blue zone. */
  outsideRate: RateEstimate;
  /** Share of position samples by distance from the safe-zone centre: inner, middle, edge, outside. */
  binShares: [number, number, number, number] | null;
  blueDamage: number;
}

export interface ZoneSummary {
  matches: number;
  blueDamagePerMatch: number | null;
  blueDamageShare: number | null;
  phases: ZonePhaseSummary[];
}

export function summarizeZone(items: readonly FieldMatchStats[]): ZoneSummary {
  const phases = new Map<number, ZonePhaseStats>();
  for (const item of items) {
    for (const [key, value] of Object.entries(item.zone.phases)) {
      const current = phases.get(Number(key)) ?? emptyPhase();
      current.samples += value.samples;
      current.blueSamples += value.blueSamples;
      value.bins.forEach((count, index) => {
        current.bins[index]! += count;
      });
      current.blueDamage += value.blueDamage;
      phases.set(Number(key), current);
    }
  }
  const blue = items.reduce((sum, item) => sum + item.zone.blueDamage, 0);
  const taken = items.reduce((sum, item) => sum + item.zone.damageTaken, 0);
  return {
    matches: items.length,
    blueDamagePerMatch: items.length ? blue / items.length : null,
    blueDamageShare: taken > 0 ? blue / taken : null,
    phases: [...phases.entries()]
      .sort(([left], [right]) => left - right)
      .map(([phaseNumber, value]) => {
        const binTotal = value.bins.reduce((sum, count) => sum + count, 0);
        return {
          phase: phaseNumber,
          samples: value.samples,
          outsideRate: wilsonInterval(value.blueSamples, value.samples),
          binShares:
            binTotal > 0
              ? (value.bins.map((count) => count / binTotal) as [number, number, number, number])
              : null,
          blueDamage: value.blueDamage,
        };
      }),
  };
}
