import { parseTelemetryPayload } from '@rine-kit/pubg-domain';
import { normalizeWeaponName } from './analytics.js';
import {
  buildDowns,
  buildRotation,
  buildTurningPoints,
  type BlueDamage,
  type MatchRotation,
  type StoryContact,
  type StoryDown,
  type TurningPoint,
} from './match-insight.js';

export const MATCH_STORY_SCHEMA_VERSION = 1 as const;
/**
 * A fight stays open while the squad keeps making contact with one of its opposing teams at most this far apart, and
 * a contact with a team that is not yet in any open fight joins one only when it comes within STORY_FIGHT_JOIN_SECONDS
 * of that fight's latest contact (a third party arriving mid-fight); otherwise it starts a separate fight. Grouping by
 * time alone chained back-to-back fights against different teams into one fight of several minutes.
 */
export const STORY_FIGHT_GAP_SECONDS = 35;
export const STORY_FIGHT_JOIN_SECONDS = 12;
/** Route samples closer together than this are dropped to keep the payload small. */
export const STORY_ROUTE_STEP_SECONDS = 10;
/** Opposing players are sampled less often than the squad to keep the payload small. */
export const STORY_ENEMY_STEP_SECONDS = 20;
const CIRCLE_STEP_SECONDS = 15;
const DAMAGE_BIN_SECONDS = 60;

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export type StoryEventKind = 'knock' | 'kill' | 'downed' | 'death' | 'revive';

export interface StoryEvent {
  t: number;
  kind: StoryEventKind;
  /** Squad member the event is about (the one who knocked, killed, was downed, died or revived). */
  member: string;
  /** The other side's squad member for a revive; null for enemies. */
  other: string | null;
  weapon: string | null;
  meters: number | null;
  /** True when the opponent was a player (false for the blue zone, falls and the like). */
  byPlayer: boolean;
  /** A kill that finished a player who was already knocked, or a death that followed a knock. */
  afterKnock: boolean;
}

export type LifeState = 'alive' | 'down' | 'dead';

export interface LifeSegment {
  from: number;
  to: number;
  state: LifeState;
}

export interface StoryRoutePoint {
  t: number;
  x: number;
  y: number;
  vehicle: boolean;
  down: boolean;
  /** Present (true) only while the player is standing in the circle's gas. */
  blue?: boolean;
}

export interface StoryCirclePoint {
  t: number;
  phase: number | null;
  aliveTeams: number | null;
  alivePlayers: number | null;
  /** Safe zone and warning zone in metres. */
  zone: { x: number; y: number; r: number } | null;
  warn: { x: number; y: number; r: number } | null;
}

/** One opposing player's route, thinned to a sample every STORY_ENEMY_STEP_SECONDS: [t, x, y] in seconds and metres. */
export interface StoryEnemy {
  id: string;
  team: string;
  route: Array<[number, number, number]>;
  /** When the player was knocked out of the match for good, null when they survived. */
  diedAt: number | null;
}

/** An opposing team's part in one fight. */
export interface StoryFightEnemy {
  team: string;
  /** Players of that team seen in the match. */
  size: number;
  /** Players of that team our squad took down in this fight. */
  downed: number;
  damageToUs: number;
  damageFromUs: number;
  /** Weapons they hurt us with, most damage first. */
  weapons: string[];
}

export interface StoryFight {
  index: number;
  start: number;
  end: number;
  phase: number | null;
  aliveTeams: number | null;
  enemyTeams: number;
  outcome: 'win' | 'lose' | 'draw' | 'skirmish';
  initiator: 'us' | 'them' | 'unknown';
  enemyDowns: number;
  ourDowns: number;
  ourKills: number;
  revives: number;
  damageDealt: number;
  damageTaken: number;
  /** Members involved with their share of the damage dealt in the fight. */
  members: Array<{ member: string; damage: number; knocks: number; downed: number }>;
  enemies: StoryFightEnemy[];
}

export interface StoryPlayer {
  member: string;
  landing: { t: number; x: number; y: number } | null;
  lifeline: LifeSegment[];
  route: StoryRoutePoint[];
  /** Squad-member damage dealt to opponents in one-minute bins. */
  damagePerMinute: number[];
  /** Time of the squad member's death, null when alive at the end. */
  diedAt: number | null;
}

export interface MatchStory {
  schemaVersion: typeof MATCH_STORY_SCHEMA_VERSION;
  mapName: string | null;
  durationSeconds: number;
  startTeams: number | null;
  startPlayers: number | null;
  events: StoryEvent[];
  fights: StoryFight[];
  circle: StoryCirclePoint[];
  /** First time each circle phase is seen. */
  phaseStarts: Array<{ phase: number; t: number }>;
  players: StoryPlayer[];
  /** Every other player's thinned route, so the map can show who was where. */
  enemies: StoryEnemy[];
  /** Why each squad knock-down happened, from the fire the squad took and returned just before it. */
  downs: StoryDown[];
  /** The few moments that decided the match. */
  turningPoints: TurningPoint[];
  /** How the squad moved with the circle. */
  rotation: MatchRotation;
  /** When the last squad member went down for good, null when the squad survived to the end. */
  squadOutAt: number | null;
  /** Teams still alive when the squad was out (or at the end), and the squad's final position among them. */
  teamsAtEnd: number | null;
}

interface RawLifeEvent {
  t: number;
  member: string;
  type: 'down' | 'dead' | 'revived';
}

function secondsOf(event: Record<string, unknown>, startMs: number): number | null {
  const iso = typeof event._D === 'string' ? Date.parse(event._D) : NaN;
  return Number.isFinite(iso) ? Math.max(0, (iso - startMs) / 1000) : null;
}

/**
 * Turns one raw telemetry payload into a readable story of the squad's match: who went down and when, every
 * fight in plain terms, the route on the map against the circle, and how fast damage was dealt. Times are seconds
 * from the match start (LogMatchStart).
 */
export function analyzeMatchStory(payload: unknown, trackedIds: ReadonlySet<string>): MatchStory {
  const events = parseTelemetryPayload(payload).map(obj);
  const startEvent = events.find((event) => event._T === 'LogMatchStart');
  const firstTime = events
    .map((event) => (typeof event._D === 'string' ? Date.parse(event._D) : NaN))
    .find((value) => Number.isFinite(value));
  const startMs = typeof startEvent?._D === 'string' ? Date.parse(startEvent._D) : (firstTime ?? 0);
  const trackedTeams = new Set<string>();
  const nameOf = new Map<string, string>();
  const teamOf = new Map<string, string>();
  for (const event of events) {
    for (const key of [
      'character',
      'attacker',
      'victim',
      'killer',
      'finisher',
      'reviver',
      'dBNOMaker',
    ]) {
      const character = obj(event[key]);
      const id = str(character.accountId);
      const team =
        character.teamId === undefined || character.teamId === null
          ? null
          : String(character.teamId);
      if (id && team !== null) teamOf.set(id, team);
      if (id && trackedIds.has(id) && team !== null) trackedTeams.add(team);
      if (id && trackedIds.has(id)) nameOf.set(id, str(character.name) ?? id);
    }
  }
  const isEnemy = (character: unknown): boolean => {
    const team = obj(character).teamId;
    return team !== undefined && team !== null && !trackedTeams.has(String(team));
  };
  const trackedId = (character: unknown): string | null => {
    const id = str(obj(character).accountId);
    return id && trackedIds.has(id) ? id : null;
  };

  const story: MatchStory = {
    schemaVersion: MATCH_STORY_SCHEMA_VERSION,
    mapName: str(startEvent?.mapName),
    durationSeconds: 0,
    startTeams: null,
    startPlayers: null,
    events: [],
    fights: [],
    circle: [],
    phaseStarts: [],
    players: [],
    enemies: [],
    downs: [],
    turningPoints: [],
    rotation: {
      epochs: [],
      blueSeconds: 0,
      blueDamage: 0,
      distance: 0,
      vehicleShare: null,
      landingToFight: null,
      lateEntries: 0,
      circlesChecked: 0,
    },
    squadOutAt: null,
    teamsAtEnd: null,
  };

  const life: RawLifeEvent[] = [];
  const knockedBy = new Map<string, string>();
  const dead = new Set<string>();
  const routes = new Map<string, StoryRoutePoint[]>();
  const lastRouteT = new Map<string, number>();
  const lastEnemyT = new Map<string, number>();
  const enemyRoutes = new Map<string, Array<[number, number, number]>>();
  const enemyDied = new Map<string, number>();
  const enemyLanded = new Map<string, number>();
  const landings = new Map<string, { t: number; x: number; y: number }>();
  const damageBins = new Map<string, number[]>();
  type Contact = StoryContact;
  const contacts: Contact[] = [];
  const blueDamage: BlueDamage[] = [];
  let lastCircleT = -Infinity;
  let maxT = 0;

  for (const event of events) {
    const type = event._T;
    const t = secondsOf(event, startMs);
    if (t === null) continue;
    const elapsed = num(obj(event.gameState).elapsedTime);
    const isGame = num(obj(event.common).isGame);
    const phase = isGame !== null && isGame >= 1 ? Math.floor(isGame) : null;
    maxT = Math.max(maxT, t);

    if (type === 'LogGameStatePeriodic') {
      const state = obj(event.gameState);
      const time = elapsed ?? t;
      if (story.startTeams === null) {
        story.startTeams = num(state.numStartTeams);
        story.startPlayers = num(state.numStartPlayers);
      }
      if (time - lastCircleT < CIRCLE_STEP_SECONDS) continue;
      lastCircleT = time;
      const zone = obj(state.safetyZonePosition);
      const warn = obj(state.poisonGasWarningPosition);
      const zoneRadius = num(state.safetyZoneRadius);
      const warnRadius = num(state.poisonGasWarningRadius);
      story.circle.push({
        t: Math.round(time),
        phase,
        aliveTeams: num(state.numAliveTeams),
        alivePlayers: num(state.numAlivePlayers),
        zone:
          num(zone.x) !== null && num(zone.y) !== null && zoneRadius
            ? {
                x: round1(num(zone.x)! / 100),
                y: round1(num(zone.y)! / 100),
                r: round1(zoneRadius / 100),
              }
            : null,
        warn:
          num(warn.x) !== null && num(warn.y) !== null && warnRadius
            ? {
                x: round1(num(warn.x)! / 100),
                y: round1(num(warn.y)! / 100),
                r: round1(warnRadius / 100),
              }
            : null,
      });
      continue;
    }
    if (type === 'LogParachuteLanding') {
      const enemyLanding = str(obj(event.character).accountId);
      if (enemyLanding && isEnemy(event.character)) enemyLanded.set(enemyLanding, t);
      const id = trackedId(event.character);
      const location = obj(obj(event.character).location);
      if (id && num(location.x) !== null && num(location.y) !== null && !landings.has(id))
        landings.set(id, {
          t,
          x: round1(num(location.x)! / 100),
          y: round1(num(location.y)! / 100),
        });
      continue;
    }
    if (type === 'LogPlayerPosition') {
      const id = trackedId(event.character);
      const elapsedTime = num(event.elapsedTime);
      const location = obj(obj(event.character).location);
      if (
        !id &&
        elapsedTime !== null &&
        elapsedTime > 0 &&
        isEnemy(event.character) &&
        obj(event.character).type !== 'ai' &&
        num(location.x) !== null &&
        num(location.y) !== null
      ) {
        const enemyId = str(obj(event.character).accountId);
        if (
          enemyId &&
          elapsedTime - (lastEnemyT.get(enemyId) ?? -Infinity) >= STORY_ENEMY_STEP_SECONDS
        ) {
          lastEnemyT.set(enemyId, elapsedTime);
          const list = enemyRoutes.get(enemyId) ?? [];
          list.push([
            Math.round(elapsedTime),
            Math.round(num(location.x)! / 100),
            Math.round(num(location.y)! / 100),
          ]);
          enemyRoutes.set(enemyId, list);
        }
        continue;
      }
      if (
        !id ||
        elapsedTime === null ||
        elapsedTime <= 0 ||
        num(location.x) === null ||
        num(location.y) === null
      )
        continue;
      if (elapsedTime - (lastRouteT.get(id) ?? -Infinity) < STORY_ROUTE_STEP_SECONDS) continue;
      lastRouteT.set(id, elapsedTime);
      const list = routes.get(id) ?? [];
      list.push({
        t: Math.round(elapsedTime),
        x: round1(num(location.x)! / 100),
        y: round1(num(location.y)! / 100),
        vehicle: obj(event.character).isInVehicle === true,
        down: obj(event.character).isDBNO === true,
        ...(obj(event.character).isInBlueZone === true ? { blue: true } : {}),
      });
      routes.set(id, list);
      continue;
    }
    if (type === 'LogPlayerTakeDamage') {
      const category = str(event.damageTypeCategory) ?? '';
      const damage = num(event.damage);
      if (category === 'Damage_BlueZone' && damage !== null && damage > 0) {
        const sufferer = trackedId(event.victim);
        if (sufferer) blueDamage.push({ t, member: sufferer, amount: damage });
        continue;
      }
      if (
        damage === null ||
        damage <= 0 ||
        !(
          category === 'Damage_Gun' ||
          category === 'Damage_DBNO' ||
          category.startsWith('Damage_Explosion') ||
          category === 'Damage_Molotov'
        )
      )
        continue;
      const attackerId = trackedId(event.attacker);
      const victimId = trackedId(event.victim);
      if (attackerId && isEnemy(event.victim)) {
        contacts.push({
          t,
          kind: 'dealt',
          member: attackerId,
          enemyTeam: String(obj(event.victim).teamId),
          amount: damage,
          victim: str(obj(event.victim).accountId),
        });
        const bins = damageBins.get(attackerId) ?? [];
        const bin = Math.floor(t / DAMAGE_BIN_SECONDS);
        while (bins.length <= bin) bins.push(0);
        bins[bin]! += damage;
        damageBins.set(attackerId, bins);
      } else if (victimId && isEnemy(event.attacker)) {
        contacts.push({
          t,
          kind: 'taken',
          member: victimId,
          enemyTeam: String(obj(event.attacker).teamId),
          amount: damage,
          victim: victimId,
          weapon: str(event.damageCauserName)
            ? normalizeWeaponName(String(event.damageCauserName))
            : null,
        });
      }
      continue;
    }
    if (type === 'LogPlayerMakeGroggy') {
      const attackerId = trackedId(event.attacker);
      const victimId = trackedId(event.victim);
      const weapon = str(event.damageCauserName)
        ? normalizeWeaponName(String(event.damageCauserName))
        : null;
      const meters = num(event.distance) !== null ? Math.round(num(event.distance)! / 100) : null;
      const victimAccount = str(obj(event.victim).accountId);
      if (attackerId && isEnemy(event.victim)) {
        story.events.push({
          t,
          kind: 'knock',
          member: attackerId,
          other: null,
          weapon,
          meters,
          byPlayer: true,
          afterKnock: false,
        });
        contacts.push({
          t,
          kind: 'knock',
          member: attackerId,
          enemyTeam: String(obj(event.victim).teamId),
          amount: 0,
          victim: victimAccount,
        });
        if (victimAccount) knockedBy.set(victimAccount, attackerId);
      } else if (victimId) {
        const byPlayer = isEnemy(event.attacker);
        story.events.push({
          t,
          kind: 'downed',
          member: victimId,
          other: null,
          weapon,
          meters,
          byPlayer,
          afterKnock: false,
        });
        life.push({ t, member: victimId, type: 'down' });
        if (byPlayer)
          contacts.push({
            t,
            kind: 'downed',
            member: victimId,
            enemyTeam: String(obj(event.attacker).teamId),
            amount: 0,
            victim: victimId,
          });
      }
      continue;
    }
    if (type === 'LogPlayerRevive') {
      const reviver = trackedId(event.reviver);
      const victim = trackedId(event.victim);
      if (reviver && victim) {
        story.events.push({
          t,
          kind: 'revive',
          member: reviver,
          other: victim,
          weapon: null,
          meters: null,
          byPlayer: false,
          afterKnock: false,
        });
        life.push({ t, member: victim, type: 'revived' });
        contacts.push({ t, kind: 'revive', member: reviver, enemyTeam: null, amount: 0, victim });
      }
      continue;
    }
    if (type === 'LogPlayerKillV2' || type === 'LogPlayerKill') {
      const victimAccount = str(obj(event.victim).accountId);
      const victimId = trackedId(event.victim);
      const killerRef = trackedId(event.finisher)
        ? event.finisher
        : trackedId(event.killer)
          ? event.killer
          : (event.finisher ?? event.killer);
      const killerId = trackedId(killerRef);
      const info = obj(event.finishDamageInfo);
      const weapon = str(info.damageCauserName)
        ? normalizeWeaponName(String(info.damageCauserName))
        : null;
      const meters =
        num(info.distance) !== null && num(info.distance)! >= 0
          ? Math.round(num(info.distance)! / 100)
          : null;
      const afterKnock = obj(event.dBNOMaker).accountId !== undefined && event.dBNOMaker !== null;
      if (victimAccount && isEnemy(event.victim) && !enemyDied.has(victimAccount))
        enemyDied.set(victimAccount, t);
      if (killerId && isEnemy(event.victim)) {
        story.events.push({
          t,
          kind: 'kill',
          member: killerId,
          other: null,
          weapon,
          meters,
          byPlayer: true,
          afterKnock,
        });
        contacts.push({
          t,
          kind: 'kill',
          member: killerId,
          enemyTeam: String(obj(event.victim).teamId),
          amount: 0,
          victim: victimAccount,
        });
      } else if (victimId && !dead.has(victimId)) {
        dead.add(victimId);
        const byPlayer = isEnemy(killerRef);
        story.events.push({
          t,
          kind: 'death',
          member: victimId,
          other: null,
          weapon: byPlayer ? weapon : null,
          meters: byPlayer ? meters : null,
          byPlayer,
          afterKnock,
        });
        life.push({ t, member: victimId, type: 'dead' });
      }
      continue;
    }
  }

  story.durationSeconds = Math.round(Math.max(maxT, story.circle.at(-1)?.t ?? 0));
  story.events.sort((left, right) => left.t - right.t);
  story.circle.sort((left, right) => left.t - right.t);
  const seenPhase = new Set<number>();
  for (const point of story.circle) {
    if (point.phase !== null && !seenPhase.has(point.phase)) {
      seenPhase.add(point.phase);
      story.phaseStarts.push({ phase: point.phase, t: point.t });
    }
  }
  const stateAt = (t: number) => {
    let found: StoryCirclePoint | null = null;
    for (const point of story.circle) {
      if (point.t > t) break;
      found = point;
    }
    return found;
  };

  // Lifelines: alive from landing, down on a knock, back alive on a revive, dead on the kill.
  const ids = [...trackedIds].filter(
    (id) => landings.has(id) || routes.has(id) || life.some((item) => item.member === id),
  );
  for (const id of ids) {
    const landing = landings.get(id) ?? null;
    // Positions before the landing are the plane's flight path, not the squad's route.
    const route = (routes.get(id) ?? []).filter((point) => !landing || point.t >= landing.t);
    const begin = landing?.t ?? route[0]?.t ?? 0;
    const own = life.filter((item) => item.member === id).sort((left, right) => left.t - right.t);
    const segments: LifeSegment[] = [];
    let state: LifeState = 'alive';
    let from = begin;
    let diedAt: number | null = null;
    for (const item of own) {
      const next: LifeState =
        item.type === 'down' ? 'down' : item.type === 'revived' ? 'alive' : 'dead';
      if (item.type === 'dead' && state === 'dead') continue;
      if (item.t > from) segments.push({ from, to: item.t, state });
      from = Math.max(from, item.t);
      state = next;
      if (next === 'dead') {
        diedAt = item.t;
        break;
      }
    }
    if (state !== 'dead') segments.push({ from, to: Math.max(from, story.durationSeconds), state });
    story.players.push({
      member: id,
      landing,
      lifeline: segments,
      route,
      diedAt,
      damagePerMinute: damageBins.get(id) ?? [],
    });
  }
  const deaths = story.players.map((player) => player.diedAt);
  story.squadOutAt =
    ids.length > 0 && deaths.every((value) => value !== null)
      ? Math.max(...(deaths as number[]))
      : null;
  story.teamsAtEnd = stateAt(story.squadOutAt ?? story.durationSeconds)?.aliveTeams ?? null;

  // Fights: contacts with the squad grouped by opposing team and time; an enemy takedown is a knock, or a kill that had no knock.
  contacts.sort((left, right) => left.t - right.t);
  const buildFight = (group: Contact[]) => {
    if (!group.length) return;
    const start = group[0]!.t;
    const end = group.at(-1)!.t;
    const enemyDown = new Set<string>();
    const ourDown = new Set<string>();
    const kills = new Set<string>();
    let revives = 0;
    let dealt = 0;
    let taken = 0;
    const perMember = new Map<string, { damage: number; knocks: number; downed: number }>();
    const slot = (member: string) =>
      perMember.get(member) ??
      (perMember.set(member, { damage: 0, knocks: 0, downed: 0 }), perMember.get(member)!);
    for (const item of group) {
      if (item.kind === 'dealt') {
        dealt += item.amount;
        slot(item.member).damage += item.amount;
      } else if (item.kind === 'taken') {
        taken += item.amount;
        slot(item.member);
      } else if (item.kind === 'knock' && item.victim) {
        enemyDown.add(item.victim);
        slot(item.member).knocks += 1;
      } else if (item.kind === 'kill' && item.victim) {
        enemyDown.add(item.victim);
        kills.add(item.victim);
      } else if (item.kind === 'downed') {
        ourDown.add(item.member);
        slot(item.member).downed += 1;
      } else if (item.kind === 'revive') revives += 1;
    }
    const teamsInFight = [
      ...new Set(
        group.map((item) => item.enemyTeam).filter((team): team is string => team !== null),
      ),
    ];
    const enemies: StoryFightEnemy[] = teamsInFight
      .map((team) => {
        const weapons = new Map<string, number>();
        let damageToUs = 0;
        let damageFromUs = 0;
        const downed = new Set<string>();
        for (const item of group) {
          if (item.enemyTeam !== team) continue;
          if (item.kind === 'taken') {
            damageToUs += item.amount;
            if (item.weapon)
              weapons.set(item.weapon, (weapons.get(item.weapon) ?? 0) + item.amount);
          } else if (item.kind === 'dealt') damageFromUs += item.amount;
          else if ((item.kind === 'knock' || item.kind === 'kill') && item.victim)
            downed.add(item.victim);
        }
        return {
          team,
          size: new Set(
            [...teamOf.entries()].filter(([, value]) => value === team).map(([id]) => id),
          ).size,
          downed: downed.size,
          damageToUs: Math.round(damageToUs),
          damageFromUs: Math.round(damageFromUs),
          weapons: [...weapons.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, 3)
            .map(([weapon]) => weapon),
        };
      })
      .sort(
        (left, right) =>
          right.damageToUs + right.damageFromUs - left.damageToUs - left.damageFromUs,
      );
    const first = group.find((item) => item.kind === 'dealt' || item.kind === 'taken');
    const state = stateAt(start);
    const enemyDowns = enemyDown.size;
    const ourDowns = ourDown.size;
    story.fights.push({
      index: story.fights.length + 1,
      start: Math.round(start),
      end: Math.round(end),
      phase: state?.phase ?? null,
      aliveTeams: state?.aliveTeams ?? null,
      enemyTeams: new Set(
        group.map((item) => item.enemyTeam).filter((team): team is string => team !== null),
      ).size,
      outcome:
        enemyDowns === 0 && ourDowns === 0
          ? 'skirmish'
          : enemyDowns > ourDowns
            ? 'win'
            : enemyDowns < ourDowns
              ? 'lose'
              : 'draw',
      initiator: !first ? 'unknown' : first.kind === 'dealt' ? 'us' : 'them',
      enemyDowns,
      ourDowns,
      ourKills: kills.size,
      revives,
      damageDealt: Math.round(dealt),
      damageTaken: Math.round(taken),
      members: [...perMember.entries()]
        .map(([member, value]) => ({
          member,
          damage: Math.round(value.damage),
          knocks: value.knocks,
          downed: value.downed,
        }))
        .sort((left, right) => right.damage - left.damage),
      enemies,
    });
  };
  interface OpenFight {
    contacts: Contact[];
    teams: Set<string>;
    last: number;
  }
  const open: OpenFight[] = [];
  const finished: Contact[][] = [];
  for (const item of contacts) {
    for (let index = open.length - 1; index >= 0; index -= 1) {
      if (item.t - open[index]!.last > STORY_FIGHT_GAP_SECONDS)
        finished.push(open.splice(index, 1)[0]!.contacts);
    }
    let target: OpenFight | undefined;
    if (item.enemyTeam !== null)
      target =
        open.find((fight) => fight.teams.has(item.enemyTeam!)) ??
        open.find((fight) => item.t - fight.last <= STORY_FIGHT_JOIN_SECONDS);
    else target = [...open].sort((left, right) => right.last - left.last)[0]; // a revive belongs to the latest fight
    if (!target) {
      if (item.enemyTeam === null) continue; // a revive with no fight around it
      target = { contacts: [], teams: new Set(), last: item.t };
      open.push(target);
    }
    target.contacts.push(item);
    if (item.enemyTeam !== null) target.teams.add(item.enemyTeam);
    target.last = item.t;
  }
  for (const fight of open) finished.push(fight.contacts);
  finished.sort((left, right) => left[0]!.t - right[0]!.t);
  for (const group of finished) buildFight(group);

  // Opposing players: like the squad, positions before the landing are the plane's flight path and are dropped.
  for (const [id, allPoints] of enemyRoutes) {
    const team = teamOf.get(id);
    const landed = enemyLanded.get(id);
    const route = allPoints.filter((point) => landed === undefined || point[0] >= landed);
    if (team === undefined || route.length < 2) continue;
    story.enemies.push({ id, team, route, diedAt: enemyDied.get(id) ?? null });
  }
  story.enemies.sort(
    (left, right) =>
      left.team.localeCompare(right.team, 'en', { numeric: true }) ||
      left.id.localeCompare(right.id),
  );
  story.downs = buildDowns(story, contacts, blueDamage);
  story.turningPoints = buildTurningPoints(story);
  story.rotation = buildRotation(story, blueDamage);
  return story;
}

/** Display label for a fight result. */
export function fightOutcomeText(outcome: StoryFight['outcome']): string {
  return outcome === 'win'
    ? '胜'
    : outcome === 'lose'
      ? '负'
      : outcome === 'draw'
        ? '均势'
        : '试探';
}
