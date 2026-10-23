import { createHash } from 'node:crypto';
import {
  normalizeTelemetryEvents,
  parseTelemetryPayload,
  combatEventKey,
  type NormalizedMatch,
  type NormalizedTelemetryEvent,
  type TelemetryEventPhase,
  type TelemetryLocation,
} from '@rine-kit/pubg-domain';

export const BATTLE_RECONSTRUCTION_SCHEMA_VERSION = 2 as const;
export const BATTLE_RECONSTRUCTION_PARSER_VERSION = 'battle-reconstruction-v2' as const;
export const BATTLE_CONTACT_GAP_SECONDS = 28;
export const BATTLE_KNOCK_OUTCOME_WINDOW_SECONDS = 120;
export const BATTLE_POST_KNOCK_RESPONSE_WINDOW_SECONDS = 30;
export const BATTLE_CONTEXT_BEFORE_SECONDS = 5;
export const BATTLE_CONTEXT_AFTER_SECONDS = 28;
export const BATTLE_POSITION_SAMPLE_INTERVAL_SECONDS = 15;

export type BattleEventType = 'ATTACK' | 'DAMAGE' | 'KNOCK' | 'KILL' | 'REVIVE' | 'POSITION';
export type BattleTimestampSource = 'absolute' | 'clock' | 'elapsed' | 'unknown';
export type ObservedPlayerState = 'ACTIVE_OBSERVED' | 'KNOCKED' | 'DEAD' | 'UNKNOWN';
export type KnockOutcome = 'KILL' | 'REVIVE' | null;

export interface BattleVector {
  x: number | null;
  y: number | null;
  z: number | null;
}

export interface BattleZoneState {
  center: BattleVector | null;
  radius: number | null;
}

export interface BattleCircleSample {
  id: string;
  sourceEventId: string;
  timeSeconds: number | null;
  timestampSource: BattleTimestampSource;
  phase: TelemetryEventPhase;
  elapsedSeconds: number | null;
  alivePlayers: number | null;
  aliveTeams: number | null;
  safetyZone: BattleZoneState;
  poisonGasWarningZone: BattleZoneState;
  redZone: BattleZoneState;
  blackZone: BattleZoneState;
}

export interface BattleCircleTransition {
  id: string;
  fromSampleId: string;
  toSampleId: string;
  fromSourceEventId: string;
  toSourceEventId: string;
  timeSeconds: number;
  changedZones: Array<'safetyZone' | 'poisonGasWarningZone' | 'redZone' | 'blackZone'>;
}

export interface BattleSourceEvent {
  id: string;
  sourceEventId: string;
  type: BattleEventType;
  rawType: string;
  timeSeconds: number | null;
  timestampSource: BattleTimestampSource;
  phase: TelemetryEventPhase;
  actorId: string | null;
  victimId: string | null;
  actorTeamId: string | null;
  victimTeamId: string | null;
  attackId: string | null;
  dbnoId: string | null;
  semanticKey: string;
  damage: number;
  hit: boolean;
  weaponId: string | null;
  /** Optional supplemental telemetry facts used by versioned R2 rules. */
  blueZone?: boolean | null;
  damageReason?: string | null;
  location: TelemetryLocation | null;
}

export interface BattleTelemetryDocument {
  schemaVersion: typeof BATTLE_RECONSTRUCTION_SCHEMA_VERSION;
  parserVersion: typeof BATTLE_RECONSTRUCTION_PARSER_VERSION;
  rawEventCount: number;
  domainNormalizedEventCount: number;
  events: BattleSourceEvent[];
  circleSamples: BattleCircleSample[];
  diagnostics: {
    unrecognizedDomainEventCount: number;
    excludedPreMatchEventCount: number;
    excludedPreMatchContactEventCount: number;
    untimedBattleEventCount: number;
  };
}

export interface BattleTimelineEvent {
  id: string;
  sourceEventId: string;
  type: BattleEventType;
  rawType: string;
  timeSeconds: number;
  timestampSource: BattleTimestampSource;
  actorRef: string | null;
  victimRef: string | null;
  actorTeamRef: string | null;
  victimTeamRef: string | null;
  damage: number | null;
  weapon: string | null;
  location: BattleVector | null;
}

export interface BattlePlayerState {
  playerRef: string;
  state: ObservedPlayerState;
  lastObservedAtSeconds: number | null;
}

export interface BattleTeamSummary {
  teamRef: string | null;
  memberRefs: string[];
  tracked: boolean;
  lastObserved: {
    active: number;
    knocked: number;
    dead: number;
    unknown: number;
    completeness: 'observed-members-only';
    states: BattlePlayerState[];
  };
}

export interface KnockChain {
  knockEventId: string;
  knockedPlayerRef: string | null;
  attackerRef: string | null;
  knockAtSeconds: number;
  outcome: KnockOutcome;
  outcomeEventId: string | null;
  outcomeAtSeconds: number | null;
  elapsedSeconds: number | null;
  windowSeconds: typeof BATTLE_KNOCK_OUTCOME_WINDOW_SECONDS;
}

export interface BattlePositionSample {
  sourceEventId: string;
  playerRef: string;
  teamRef: string | null;
  timeSeconds: number;
  location: BattleVector;
}

export interface BattleEpisode {
  id: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  contactGapSeconds: typeof BATTLE_CONTACT_GAP_SECONDS;
  participantRefs: string[];
  teams: BattleTeamSummary[];
  firstKnock: {
    sourceEventId: string;
    attackerRef: string | null;
    victimRef: string | null;
    timeSeconds: number;
  } | null;
  knockChains: KnockChain[];
  timeline: BattleTimelineEvent[];
  positions: BattlePositionSample[];
  circleSampleRefs: string[];
  circleTransitionRefs: string[];
  evidenceEventIds: string[];
  diagnostics: {
    conflictingStateTransitions: number;
    unknownTeamContacts: number;
    ambiguousContextEvents: number;
    positionsSuppressedBySampling: number;
  };
}

export interface BattleObservedTeamState {
  teamRef: string;
  memberCountObserved: number;
  activeObserved: number;
  knockedObserved: number;
  deadObserved: number;
  unknownObserved: number;
  completeness: 'observed-members-only';
}

export interface BattleStateTimelineEntry {
  sourceEventId: string;
  timeSeconds: number;
  type: 'KNOCK' | 'REVIVE' | 'KILL';
  actorRef: string | null;
  victimRef: string | null;
  actorTeamRef: string | null;
  victimTeamRef: string | null;
  states: BattleObservedTeamState[];
}

export interface BattleAdvantageWindow {
  teamRefs: [string, string];
  observedLeadTeamRef: string;
  startedAtSeconds: number;
  endedAtSeconds: number;
  durationSeconds: number;
  resolution: 'equalized' | 'reversed' | 'ongoing';
  startEventId: string;
  endEventId: string | null;
  evidenceEventIds: string[];
  assessment: 'observed-knock-balance-only';
  rosterCompleteness: 'observed-members-only';
}

export interface BattleAdvantageChange {
  teamRefs: [string, string];
  timeSeconds: number;
  previousLeadTeamRef: string | null;
  nextLeadTeamRef: string | null;
  classification: 'lead' | 'equalized' | 'reversed';
  sourceEventId: string;
}

export interface BattleGroup {
  id: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  episodeIds: string[];
  teamRefs: string[];
  bridgeEvidenceEventIds: string[];
  timeline: BattleTimelineEvent[];
  stateTimeline: BattleStateTimelineEntry[];
  advantageWindows: BattleAdvantageWindow[];
  advantageChanges: BattleAdvantageChange[];
  firstKnockAdvantage: BattleAdvantageWindow | null;
  postKnockResponse: {
    status: 'observed' | 'not_observed_in_window' | 'incomplete';
    firstKnockEventId: string | null;
    responseEventId: string | null;
    elapsedSeconds: number | null;
    windowSeconds: 30;
  };
  possibleThirdParty: Array<{
    teamRef: string;
    episodeId: string;
    evidenceEventIds: string[];
    status: 'possible_third_party_contact';
  }>;
  rosterCompleteness: 'observed-members-only';
}

export interface BattleReconstructionResult {
  schemaVersion: typeof BATTLE_RECONSTRUCTION_SCHEMA_VERSION;
  parserVersion: typeof BATTLE_RECONSTRUCTION_PARSER_VERSION;
  status: 'available' | 'no_contact_events';
  episodes: BattleEpisode[];
  battles: BattleGroup[];
  circleSamples: BattleCircleSample[];
  circleTransitions: BattleCircleTransition[];
  diagnostics: {
    rawEventCount: number;
    domainNormalizedEventCount: number;
    battleEventCount: number;
    contactEventCount: number;
    episodeCount: number;
    battleGroupCount: number;
    multiTeamBattleCount: number;
    groupedEpisodeCount: number;
    duplicateSourceEventCount: number;
    duplicateTimelineAssignmentCount: number;
    unassignedContactEventCount: number;
    untimedContactEventCount: number;
    preMatchContactEventCount: number;
    noParticipantContactEventCount: number;
    sameTeamContactEventCount: number;
    ineffectiveContactEventCount: number;
    unknownPhaseContactEventCount: number;
    unknownTeamContactEventCount: number;
    unknownPhaseCircleSampleCount: number;
    unresolvedKnockChainCount: number;
    reviveWithoutUniqueKnockCount: number;
    conflictingTeamReferenceCount: number;
    conflictingStateTransitionCount: number;
    ambiguousContextEventCount: number;
    positionsSuppressedBySampling: number;
    overlappingEpisodePairCount: number;
    sharedCircleSampleContextCount: number;
  };
}

interface TeamSide {
  key: string;
  teamId: string | null;
  seedPlayerId: string | null;
}

interface ContactSession {
  pairKey: string;
  sides: [TeamSide, TeamSide];
  seedEvents: BattleSourceEvent[];
  startSeconds: number;
  endSeconds: number;
  pendingKnocks: BattleSourceEvent[];
  assigned: BattleSourceEvent[];
  positions: BattlePositionSample[];
  circleSampleRefs: string[];
  id: string;
  diagnostics: {
    unknownTeamContacts: number;
    ambiguousContextEvents: number;
    positionsSuppressedBySampling: number;
    conflictingStateTransitions: number;
  };
}

const COMBAT_CONTACT_TYPES = new Set<BattleEventType>(['DAMAGE', 'KNOCK', 'KILL']);
const TIMELINE_CONTEXT_TYPES = new Set<BattleEventType>(['ATTACK', 'POSITION']);
const BATTLE_DOMAIN_TYPES = new Set<NormalizedTelemetryEvent['type']>([
  'ATTACK',
  'DAMAGE',
  'KNOCK',
  'KILL',
  'REVIVE',
  'POSITION',
]);

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function idDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function battlePlayerRef(matchId: string, playerId: string): string {
  return `player-${idDigest(`${matchId}\u001f${playerId}`)}`;
}

export function battleTeamRef(matchId: string, teamId: string): string {
  return `team-${idDigest(`${matchId}\u001f${teamId}`)}`;
}

function vectorOf(value: unknown): BattleVector | null {
  const location = objectValue(value);
  const nested = objectValue(location.location ?? location.position);
  const source = Object.keys(nested).length ? nested : location;
  const x = numberValue(source.x ?? source.X);
  const y = numberValue(source.y ?? source.Y);
  const z = numberValue(source.z ?? source.Z);
  return x === null && y === null && z === null ? null : { x, y, z };
}

function zoneOf(
  state: Record<string, unknown>,
  positionKey: string,
  radiusKey: string,
): BattleZoneState {
  const radius = numberValue(state[radiusKey]);
  return {
    center: vectorOf(state[positionKey]),
    radius: radius !== null && radius >= 0 ? radius : null,
  };
}

function absoluteElapsed(raw: Record<string, unknown>, match: NormalizedMatch): number | null {
  const createdAt = Date.parse(String(match.createdAt ?? ''));
  const timestamp = numberValue(match.timestamp);
  const start = Number.isFinite(createdAt)
    ? createdAt
    : timestamp !== null && timestamp > 100_000_000_000
      ? timestamp
      : timestamp !== null && timestamp > 1_000_000_000
        ? timestamp * 1000
        : Number.NaN;
  if (!Number.isFinite(start)) return null;
  for (const candidate of [raw._D, raw.timestamp, raw.createdAt, raw.time]) {
    if (typeof candidate !== 'string' || /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(candidate.trim()))
      continue;
    const timestamp = Date.parse(candidate);
    if (!Number.isFinite(timestamp)) continue;
    const delta = (timestamp - start) / 1000;
    if (delta >= 0 && delta < 24 * 60 * 60) return delta;
  }
  return null;
}

function normalizeCircle(
  rawValue: unknown,
  rawIndex: number,
  match: NormalizedMatch,
): BattleCircleSample | null {
  const raw = objectValue(rawValue);
  const rawType = String(raw._T ?? raw.type ?? raw.eventType ?? '');
  if (!rawType.toLowerCase().includes('gamestateperiodic')) return null;
  const state = objectValue(raw.gameState ?? raw.game_state);
  const common = objectValue(raw.common);
  const absolute = absoluteElapsed(raw, match);
  const clockValue = [raw._D, raw.timestamp, raw.createdAt, raw.time].find(
    (value) => typeof value === 'string' && /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(value.trim()),
  );
  const clockParts = typeof clockValue === 'string' ? clockValue.split(':').map(Number) : [];
  const clockSeconds =
    clockParts.length === 3
      ? clockParts[0]! * 3600 + clockParts[1]! * 60 + clockParts[2]!
      : clockParts.length === 2
        ? clockParts[0]! * 60 + clockParts[1]!
        : null;
  const elapsed = [state.elapsedTime, raw.elapsedTime, common.elapsedTime]
    .map(numberValue)
    .find((value): value is number => value !== null && value >= 0 && value < 24 * 60 * 60);
  const timeSeconds =
    absolute ?? (clockSeconds !== null && clockSeconds > 0 ? clockSeconds : (elapsed ?? null));
  const timestampSource: BattleTimestampSource =
    absolute !== null
      ? 'absolute'
      : clockSeconds !== null && clockSeconds > 0
        ? 'clock'
        : elapsed !== undefined
          ? 'elapsed'
          : 'unknown';
  const integer = (value: unknown): number | null => {
    const parsed = numberValue(value);
    return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  const phaseValue = numberValue(common.isGame);
  const phase: TelemetryEventPhase =
    typeof common.isGame === 'boolean'
      ? common.isGame
        ? 'in_match'
        : 'pre_match'
      : phaseValue !== null && phaseValue >= 0 && phaseValue < 1
        ? 'pre_match'
        : phaseValue !== null && phaseValue >= 1
          ? 'in_match'
          : 'unknown';
  const sourceEventId = `telemetry-${rawIndex + 1}`;
  return {
    id: `circle-${idDigest(`${match.matchId}\u001f${sourceEventId}`)}`,
    sourceEventId,
    timeSeconds,
    timestampSource,
    phase,
    elapsedSeconds: elapsed ?? null,
    alivePlayers: integer(state.numAlivePlayers),
    aliveTeams: integer(state.numAliveTeams),
    safetyZone: zoneOf(state, 'safetyZonePosition', 'safetyZoneRadius'),
    poisonGasWarningZone: zoneOf(state, 'poisonGasWarningPosition', 'poisonGasWarningRadius'),
    redZone: zoneOf(state, 'redZonePosition', 'redZoneRadius'),
    blackZone: zoneOf(state, 'blackZonePosition', 'blackZoneRadius'),
  };
}

function rawTimestampSource(
  raw: Record<string, unknown>,
  match: NormalizedMatch,
): BattleTimestampSource {
  if (absoluteElapsed(raw, match) !== null) return 'absolute';
  const timestamp = [raw._D, raw.timestamp, raw.createdAt, raw.time].find(
    (value) => typeof value === 'string' && /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(value.trim()),
  );
  if (typeof timestamp === 'string') return 'clock';
  const common = objectValue(raw.common);
  const explicitRelative = [
    raw.timeSeconds,
    raw.elapsedSeconds,
    raw.gameTime,
    raw.game_time,
    raw.elapsedTime,
    common.elapsedTime,
  ]
    .map(numberValue)
    .some((value) => value !== null && value > 0 && value < 24 * 60 * 60);
  return explicitRelative ? 'elapsed' : 'unknown';
}

function sourceEvent(
  event: NormalizedTelemetryEvent,
  raw: Record<string, unknown>,
  match: NormalizedMatch,
): BattleSourceEvent | null {
  if (!BATTLE_DOMAIN_TYPES.has(event.type)) return null;
  const timeSeconds = event.timeSeconds;
  return {
    id: event.id,
    sourceEventId: event.id,
    type: event.type as BattleEventType,
    rawType: event.rawType,
    timeSeconds,
    timestampSource: timeSeconds === null ? 'unknown' : rawTimestampSource(raw, match),
    phase: explicitPhase(raw) ?? event.phase ?? 'unknown',
    actorId: event.actorId,
    victimId: event.victimId,
    actorTeamId: event.actorTeamId,
    victimTeamId: event.victimTeamId,
    attackId: event.attackId,
    dbnoId: event.dbnoId,
    semanticKey: combatEventKey(event),
    damage: event.damage,
    hit: event.hit,
    weaponId: event.weaponId,
    blueZone: event.blueZone ?? null,
    damageReason: event.damageReason ?? null,
    location: event.location,
  };
}

function explicitPhase(raw: Record<string, unknown>): TelemetryEventPhase | null {
  const value = objectValue(raw.common).isGame;
  if (typeof value === 'boolean') return value ? 'in_match' : 'pre_match';
  const phase = numberValue(value);
  if (phase === null) return null;
  if (phase >= 0 && phase < 1) return 'pre_match';
  if (phase >= 1) return 'in_match';
  return 'unknown';
}

export function normalizeBattleTelemetry(
  payload: unknown,
  match: NormalizedMatch,
): BattleTelemetryDocument {
  const rawEvents = parseTelemetryPayload(payload);
  const normalized = normalizeTelemetryEvents(payload, match);
  const rawById = new Map(
    rawEvents.map((value, index) => [`telemetry-${index + 1}`, objectValue(value)]),
  );
  const events: BattleSourceEvent[] = [];
  const circleSamples: BattleCircleSample[] = [];
  let excludedPreMatchEventCount = 0;
  let excludedPreMatchContactEventCount = 0;
  let untimedBattleEventCount = 0;

  for (const event of normalized) {
    const converted = sourceEvent(event, rawById.get(event.id) ?? {}, match);
    if (!converted) continue;
    if (converted.phase === 'pre_match') {
      excludedPreMatchEventCount += 1;
      if (COMBAT_CONTACT_TYPES.has(converted.type)) excludedPreMatchContactEventCount += 1;
      continue;
    }
    if (converted.timeSeconds === null) untimedBattleEventCount += 1;
    events.push(converted);
  }
  rawEvents.forEach((rawEvent, index) => {
    const circle = normalizeCircle(rawEvent, index, match);
    if (circle && circle.phase !== 'pre_match') circleSamples.push(circle);
  });

  const recognized = new Set(normalized.map((event) => event.id));
  for (const sample of circleSamples) recognized.add(sample.sourceEventId);
  return {
    schemaVersion: BATTLE_RECONSTRUCTION_SCHEMA_VERSION,
    parserVersion: BATTLE_RECONSTRUCTION_PARSER_VERSION,
    rawEventCount: rawEvents.length,
    domainNormalizedEventCount: normalized.length,
    events: events.sort(eventOrder),
    circleSamples: circleSamples.sort(circleOrder),
    diagnostics: {
      unrecognizedDomainEventCount: Math.max(0, rawEvents.length - recognized.size),
      excludedPreMatchEventCount,
      excludedPreMatchContactEventCount,
      untimedBattleEventCount,
    },
  };
}

function eventOrder(left: BattleSourceEvent, right: BattleSourceEvent): number {
  const ordinal = (event: BattleSourceEvent): number =>
    Number(event.sourceEventId.match(/^(?:telemetry-)?(\d+)$/u)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return (
    (left.timeSeconds ?? Number.POSITIVE_INFINITY) -
      (right.timeSeconds ?? Number.POSITIVE_INFINITY) ||
    ordinal(left) - ordinal(right) ||
    left.sourceEventId.localeCompare(right.sourceEventId)
  );
}

function circleOrder(left: BattleCircleSample, right: BattleCircleSample): number {
  const ordinal = (sample: BattleCircleSample): number =>
    Number(sample.sourceEventId.match(/^(?:telemetry-)?(\d+)$/u)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return (
    (left.timeSeconds ?? Number.POSITIVE_INFINITY) -
      (right.timeSeconds ?? Number.POSITIVE_INFINITY) ||
    ordinal(left) - ordinal(right) ||
    left.sourceEventId.localeCompare(right.sourceEventId)
  );
}

function teamMembership(events: BattleSourceEvent[]): {
  playerTeam: Map<string, string | null>;
  teamMembers: Map<string, Set<string>>;
  conflictCount: number;
} {
  const memberships = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.actorId && event.actorTeamId) {
      const values = memberships.get(event.actorId) ?? new Set<string>();
      values.add(event.actorTeamId);
      memberships.set(event.actorId, values);
    }
    if (event.victimId && event.victimTeamId) {
      const values = memberships.get(event.victimId) ?? new Set<string>();
      values.add(event.victimTeamId);
      memberships.set(event.victimId, values);
    }
  }
  const playerTeam = new Map<string, string | null>();
  const teamMembers = new Map<string, Set<string>>();
  let conflictCount = 0;
  for (const [playerId, values] of memberships) {
    if (values.size !== 1) {
      playerTeam.set(playerId, null);
      conflictCount += 1;
      continue;
    }
    const teamId = [...values][0]!;
    playerTeam.set(playerId, teamId);
    const members = teamMembers.get(teamId) ?? new Set<string>();
    members.add(playerId);
    teamMembers.set(teamId, members);
  }
  return { playerTeam, teamMembers, conflictCount };
}

function resolveTeamId(
  explicit: string | null,
  playerId: string | null,
  playerTeam: Map<string, string | null>,
): string | null {
  if (explicit) return explicit;
  return playerId ? (playerTeam.get(playerId) ?? null) : null;
}

function contactSides(
  event: BattleSourceEvent,
  playerTeam: Map<string, string | null>,
): [TeamSide, TeamSide] | null {
  if (!event.actorId || !event.victimId || event.actorId === event.victimId) return null;
  const actorTeamId = resolveTeamId(event.actorTeamId, event.actorId, playerTeam);
  const victimTeamId = resolveTeamId(event.victimTeamId, event.victimId, playerTeam);
  if (actorTeamId && victimTeamId && actorTeamId === victimTeamId) return null;
  const actor: TeamSide = actorTeamId
    ? { key: `team:${actorTeamId}`, teamId: actorTeamId, seedPlayerId: null }
    : { key: `player:${event.actorId}`, teamId: null, seedPlayerId: event.actorId };
  const victim: TeamSide = victimTeamId
    ? { key: `team:${victimTeamId}`, teamId: victimTeamId, seedPlayerId: null }
    : { key: `player:${event.victimId}`, teamId: null, seedPlayerId: event.victimId };
  return actor.key.localeCompare(victim.key) <= 0 ? [actor, victim] : [victim, actor];
}

function pairKey(sides: [TeamSide, TeamSide]): string {
  return `${sides[0].key}\u001f${sides[1].key}`;
}

function contactIsEffective(event: BattleSourceEvent): boolean {
  return event.type !== 'DAMAGE' || event.damage > 0 || event.hit;
}

function matchesKnockOutcome(knock: BattleSourceEvent, outcome: BattleSourceEvent): boolean {
  if (outcome.type !== 'KILL' && outcome.type !== 'REVIVE') return false;
  if (knock.victimId && outcome.victimId) return knock.victimId === outcome.victimId;
  return Boolean(knock.dbnoId && outcome.dbnoId && knock.dbnoId === outcome.dbnoId);
}

function knockOutcome(
  knock: BattleSourceEvent,
  events: BattleSourceEvent[],
): BattleSourceEvent | null {
  if (knock.timeSeconds === null) return null;
  const candidates = events.filter(
    (event) =>
      event.timeSeconds !== null &&
      event.timeSeconds >= knock.timeSeconds! &&
      event.timeSeconds - knock.timeSeconds! <= BATTLE_KNOCK_OUTCOME_WINDOW_SECONDS &&
      matchesKnockOutcome(knock, event),
  );
  candidates.sort(eventOrder);
  const firstKnockIndex = events.findIndex((event) => event.id === knock.id);
  const nextKnock = events
    .slice(firstKnockIndex + 1)
    .find(
      (event) =>
        event.type === 'KNOCK' &&
        event.victimId === knock.victimId &&
        event.timeSeconds !== null &&
        event.timeSeconds > knock.timeSeconds!,
    );
  const nextKnockTime = nextKnock?.timeSeconds ?? Number.POSITIVE_INFINITY;
  return candidates.find((candidate) => candidate.timeSeconds! < nextKnockTime) ?? null;
}

function directKillFollows(session: ContactSession, event: BattleSourceEvent): boolean {
  if (event.type !== 'KILL' || event.timeSeconds === null) return false;
  return session.pendingKnocks.some(
    (knock) =>
      knock.timeSeconds !== null &&
      event.timeSeconds! >= knock.timeSeconds &&
      event.timeSeconds! - knock.timeSeconds <= BATTLE_KNOCK_OUTCOME_WINDOW_SECONDS &&
      matchesKnockOutcome(knock, event),
  );
}

function sessionId(matchId: string, session: ContactSession): string {
  const contactIds = session.seedEvents.map((event) => event.sourceEventId).join(',');
  return `episode-${idDigest(`${BATTLE_RECONSTRUCTION_SCHEMA_VERSION}\u001f${BATTLE_RECONSTRUCTION_PARSER_VERSION}\u001f${matchId}\u001f${session.pairKey}\u001f${contactIds}`)}`;
}

function segmentContacts(
  events: BattleSourceEvent[],
  playerTeam: Map<string, string | null>,
  matchId: string,
): {
  sessions: ContactSession[];
  counters: {
    duplicateSourceEventCount: number;
    untimedContactEventCount: number;
    preMatchContactEventCount: number;
    noParticipantContactEventCount: number;
    sameTeamContactEventCount: number;
    ineffectiveContactEventCount: number;
    unknownPhaseContactEventCount: number;
    unknownTeamContactEventCount: number;
  };
} {
  const counters = {
    duplicateSourceEventCount: 0,
    untimedContactEventCount: 0,
    preMatchContactEventCount: 0,
    noParticipantContactEventCount: 0,
    sameTeamContactEventCount: 0,
    ineffectiveContactEventCount: 0,
    unknownPhaseContactEventCount: 0,
    unknownTeamContactEventCount: 0,
  };
  const seenSourceIds = new Set<string>();
  const seenSemanticIds = new Set<string>();
  const byPair = new Map<string, { sides: [TeamSide, TeamSide]; events: BattleSourceEvent[] }>();

  for (const event of events
    .filter((candidate) => COMBAT_CONTACT_TYPES.has(candidate.type))
    .sort(eventOrder)) {
    if (seenSourceIds.has(event.sourceEventId)) {
      counters.duplicateSourceEventCount += 1;
      continue;
    }
    seenSourceIds.add(event.sourceEventId);
    if (event.phase === 'pre_match') {
      counters.preMatchContactEventCount += 1;
      continue;
    }
    if (event.phase === 'unknown') {
      counters.unknownPhaseContactEventCount += 1;
      continue;
    }
    if (event.timeSeconds === null) {
      counters.untimedContactEventCount += 1;
      continue;
    }
    if (!event.actorId || !event.victimId) {
      counters.noParticipantContactEventCount += 1;
      continue;
    }
    const actorTeam = resolveTeamId(event.actorTeamId, event.actorId, playerTeam);
    const victimTeam = resolveTeamId(event.victimTeamId, event.victimId, playerTeam);
    if (actorTeam && victimTeam && actorTeam === victimTeam) {
      counters.sameTeamContactEventCount += 1;
      continue;
    }
    if (!contactIsEffective(event)) {
      counters.ineffectiveContactEventCount += 1;
      continue;
    }
    const sides = contactSides(event, playerTeam);
    if (!sides) {
      counters.noParticipantContactEventCount += 1;
      continue;
    }
    const key = pairKey(sides);
    const semantic = event.semanticKey;
    const semanticUniqueKey = `${key}\u001f${semantic}`;
    if (seenSemanticIds.has(semanticUniqueKey)) {
      counters.duplicateSourceEventCount += 1;
      continue;
    }
    seenSemanticIds.add(semanticUniqueKey);
    if (sides.some((side) => !side.teamId)) counters.unknownTeamContactEventCount += 1;
    const entry = byPair.get(key) ?? { sides, events: [] };
    entry.events.push(event);
    byPair.set(key, entry);
  }

  const sessions: ContactSession[] = [];
  for (const [key, pair] of [...byPair.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    let current: ContactSession | undefined;
    for (const event of pair.events.sort(eventOrder)) {
      const last = current?.seedEvents.at(-1)?.timeSeconds ?? null;
      const connectedByGap =
        last !== null && event.timeSeconds! - last <= BATTLE_CONTACT_GAP_SECONDS;
      const connectedByKnockOutcome = current ? directKillFollows(current, event) : false;
      if (!current || (!connectedByGap && !connectedByKnockOutcome)) {
        current = {
          pairKey: key,
          sides: pair.sides,
          seedEvents: [],
          startSeconds: event.timeSeconds!,
          endSeconds: event.timeSeconds!,
          pendingKnocks: [],
          assigned: [],
          positions: [],
          circleSampleRefs: [],
          id: '',
          diagnostics: {
            unknownTeamContacts: 0,
            ambiguousContextEvents: 0,
            positionsSuppressedBySampling: 0,
            conflictingStateTransitions: 0,
          },
        };
        sessions.push(current);
      }
      current.seedEvents.push(event);
      current.assigned.push(event);
      if (current.sides.some((side) => !side.teamId)) current.diagnostics.unknownTeamContacts += 1;
      current.endSeconds = event.timeSeconds!;
      if (event.type === 'KNOCK') current.pendingKnocks.push(event);
      if (event.type === 'KILL')
        current.pendingKnocks = current.pendingKnocks.filter(
          (knock) => !matchesKnockOutcome(knock, event),
        );
    }
  }
  for (const session of sessions) session.id = sessionId(matchId, session);
  return {
    sessions: sessions.sort(
      (left, right) => left.startSeconds - right.startSeconds || left.id.localeCompare(right.id),
    ),
    counters,
  };
}

function sideContainsEvent(
  session: ContactSession,
  event: BattleSourceEvent,
  playerTeam: Map<string, string | null>,
): boolean {
  const actorTeam = resolveTeamId(event.actorTeamId, event.actorId, playerTeam);
  const victimTeam = resolveTeamId(event.victimTeamId, event.victimId, playerTeam);
  const teamIds = new Set(
    session.sides.map((side) => side.teamId).filter((value): value is string => Boolean(value)),
  );
  const playerIds = new Set(
    session.sides
      .map((side) => side.seedPlayerId)
      .filter((value): value is string => Boolean(value)),
  );
  return Boolean(
    (actorTeam && teamIds.has(actorTeam)) ||
    (victimTeam && teamIds.has(victimTeam)) ||
    (event.actorId && playerIds.has(event.actorId)) ||
    (event.victimId && playerIds.has(event.victimId)),
  );
}

function distanceToSession(timeSeconds: number, session: ContactSession): number {
  if (timeSeconds < session.startSeconds) return session.startSeconds - timeSeconds;
  if (timeSeconds > session.endSeconds) return timeSeconds - session.endSeconds;
  return 0;
}

function chooseUniqueSession(
  event: BattleSourceEvent,
  sessions: ContactSession[],
  playerTeam: Map<string, string | null>,
): ContactSession | null | 'ambiguous' {
  if (event.timeSeconds === null) return null;
  const candidates = sessions.filter(
    (session) =>
      sideContainsEvent(session, event, playerTeam) &&
      event.timeSeconds! >= session.startSeconds - BATTLE_CONTEXT_BEFORE_SECONDS &&
      event.timeSeconds! <= session.endSeconds + BATTLE_CONTEXT_AFTER_SECONDS,
  );
  if (!candidates.length) return null;
  candidates.sort(
    (left, right) =>
      distanceToSession(event.timeSeconds!, left) - distanceToSession(event.timeSeconds!, right) ||
      left.id.localeCompare(right.id),
  );
  const bestDistance = distanceToSession(event.timeSeconds, candidates[0]!);
  const ties = candidates.filter(
    (candidate) => distanceToSession(event.timeSeconds!, candidate) === bestDistance,
  );
  return ties.length === 1 ? ties[0]! : 'ambiguous';
}

function assignRevives(
  events: BattleSourceEvent[],
  sessions: ContactSession[],
): { assigned: number; ambiguous: number } {
  let assigned = 0;
  let ambiguous = 0;
  const revives = events
    .filter((event) => event.type === 'REVIVE' && event.phase !== 'pre_match')
    .sort(eventOrder);
  for (const revive of revives) {
    if (revive.timeSeconds === null) {
      ambiguous += 1;
      continue;
    }
    const candidates = sessions.filter((session) =>
      session.seedEvents.some(
        (knock) => knock.type === 'KNOCK' && knockOutcome(knock, events)?.id === revive.id,
      ),
    );
    if (candidates.length !== 1) {
      ambiguous += 1;
      continue;
    }
    const session = candidates[0]!;
    if (session.assigned.some((event) => event.sourceEventId === revive.sourceEventId)) continue;
    session.assigned.push(revive);
    session.endSeconds = Math.max(session.endSeconds, revive.timeSeconds!);
    assigned += 1;
  }
  return { assigned, ambiguous };
}

function assignContextEvents(
  events: BattleSourceEvent[],
  sessions: ContactSession[],
  playerTeam: Map<string, string | null>,
): { ambiguous: number; suppressedPositions: number } {
  let ambiguous = 0;
  let suppressedPositions = 0;
  const contextEvents = events
    .filter(
      (event) =>
        TIMELINE_CONTEXT_TYPES.has(event.type) &&
        event.timeSeconds !== null &&
        event.phase !== 'pre_match',
    )
    .sort(eventOrder);
  const assignedIds = new Set(
    sessions.flatMap((session) => session.assigned.map((event) => event.sourceEventId)),
  );
  for (const event of contextEvents) {
    if (assignedIds.has(event.sourceEventId)) continue;
    const selected = chooseUniqueSession(event, sessions, playerTeam);
    if (selected === 'ambiguous') {
      ambiguous += 1;
      const candidates = sessions.filter(
        (session) =>
          sideContainsEvent(session, event, playerTeam) &&
          event.timeSeconds! >= session.startSeconds - BATTLE_CONTEXT_BEFORE_SECONDS &&
          event.timeSeconds! <= session.endSeconds + BATTLE_CONTEXT_AFTER_SECONDS,
      );
      const nearest = Math.min(
        ...candidates.map((session) => distanceToSession(event.timeSeconds!, session)),
      );
      for (const candidate of candidates) {
        if (distanceToSession(event.timeSeconds!, candidate) === nearest)
          candidate.diagnostics.ambiguousContextEvents += 1;
      }
      continue;
    }
    if (!selected) continue;
    if (
      event.type !== 'POSITION' ||
      !event.actorId ||
      !event.location ||
      event.location.x === null ||
      event.location.y === null
    ) {
      selected.assigned.push(event);
      assignedIds.add(event.sourceEventId);
      continue;
    }
    const bucket = Math.floor(event.timeSeconds! / BATTLE_POSITION_SAMPLE_INTERVAL_SECONDS);
    const previous = selected.positions.find(
      (sample) =>
        sample.playerRef === event.actorId &&
        Math.floor(sample.timeSeconds / BATTLE_POSITION_SAMPLE_INTERVAL_SECONDS) === bucket,
    );
    if (previous) {
      suppressedPositions += 1;
      selected.diagnostics.positionsSuppressedBySampling += 1;
      continue;
    }
    const teamId = resolveTeamId(event.actorTeamId, event.actorId, playerTeam);
    selected.positions.push({
      sourceEventId: event.sourceEventId,
      playerRef: event.actorId,
      teamRef: teamId,
      timeSeconds: event.timeSeconds!,
      location: { x: event.location.x, y: event.location.y, z: event.location.z },
    });
    selected.assigned.push(event);
    assignedIds.add(event.sourceEventId);
  }
  for (const session of sessions) {
    session.assigned = [
      ...new Map(session.assigned.map((event) => [event.sourceEventId, event])).values(),
    ].sort(eventOrder);
    session.positions.sort(
      (left, right) =>
        left.timeSeconds - right.timeSeconds ||
        left.sourceEventId.localeCompare(right.sourceEventId),
    );
  }
  return { ambiguous, suppressedPositions };
}

function stateAtEnd(
  session: ContactSession,
  events: BattleSourceEvent[],
  teamMembers: Map<string, Set<string>>,
  playerTeam: Map<string, string | null>,
  matchId: string,
): {
  summaries: BattleTeamSummary[];
  conflictCount: number;
  playerRefs: string[];
  conflictEventIds: Set<string>;
} {
  let conflictCount = 0;
  const conflictEventIds = new Set<string>();
  const noteConflict = (event: BattleSourceEvent): void => {
    conflictCount += 1;
    conflictEventIds.add(event.sourceEventId);
  };
  const stateByPlayer = new Map<string, { state: ObservedPlayerState; time: number | null }>();
  const observedPlayerIds = new Set(
    session.sides.flatMap((side) =>
      side.teamId
        ? [...(teamMembers.get(side.teamId) ?? [])]
        : side.seedPlayerId
          ? [side.seedPlayerId]
          : [],
    ),
  );
  const seenStateEvents = new Set<string>();
  const ordered = events
    .filter(
      (event) =>
        event.timeSeconds !== null &&
        event.timeSeconds <= session.endSeconds &&
        event.phase !== 'pre_match' &&
        Boolean(
          (event.actorId && observedPlayerIds.has(event.actorId)) ||
          (event.victimId && observedPlayerIds.has(event.victimId)),
        ),
    )
    .sort(eventOrder)
    .filter((event) => {
      const key = `${event.type}\u001f${event.semanticKey}`;
      if (seenStateEvents.has(key)) return false;
      seenStateEvents.add(key);
      return true;
    });
  for (const event of ordered) {
    if (
      event.actorId &&
      observedPlayerIds.has(event.actorId) &&
      (COMBAT_CONTACT_TYPES.has(event.type) || event.type === 'REVIVE' || event.type === 'ATTACK')
    ) {
      const state = stateByPlayer.get(event.actorId);
      if (state?.state === 'DEAD') noteConflict(event);
      else stateByPlayer.set(event.actorId, { state: 'ACTIVE_OBSERVED', time: event.timeSeconds });
    }
    if (
      !event.victimId ||
      !observedPlayerIds.has(event.victimId) ||
      (event.type !== 'KNOCK' && event.type !== 'KILL' && event.type !== 'REVIVE')
    )
      continue;
    const previous = stateByPlayer.get(event.victimId);
    if (event.type === 'KNOCK') {
      if (previous?.state === 'DEAD') noteConflict(event);
      else stateByPlayer.set(event.victimId, { state: 'KNOCKED', time: event.timeSeconds });
    } else if (event.type === 'KILL') {
      if (previous?.state === 'DEAD') noteConflict(event);
      stateByPlayer.set(event.victimId, { state: 'DEAD', time: event.timeSeconds });
    } else {
      if (previous?.state !== 'KNOCKED') noteConflict(event);
      stateByPlayer.set(event.victimId, { state: 'ACTIVE_OBSERVED', time: event.timeSeconds });
    }
  }

  const tracked = new Set<string>();
  const summaries = session.sides.map((side) => {
    const memberIds = side.teamId
      ? [...(teamMembers.get(side.teamId) ?? new Set<string>())].sort()
      : side.seedPlayerId
        ? [side.seedPlayerId]
        : [];
    const states = memberIds.map((playerId) => {
      const last = stateByPlayer.get(playerId);
      const state = last?.state ?? 'UNKNOWN';
      return {
        playerRef: battlePlayerRef(matchId, playerId),
        state,
        lastObservedAtSeconds: last?.time ?? null,
      } satisfies BattlePlayerState;
    });
    for (const [playerId, teamId] of playerTeam)
      if (teamId === side.teamId && side.teamId) tracked.add(playerId);
    return {
      teamRef: side.teamId ? battleTeamRef(matchId, side.teamId) : null,
      memberRefs: memberIds.map((playerId) => battlePlayerRef(matchId, playerId)),
      tracked: false,
      lastObserved: {
        active: states.filter((item) => item.state === 'ACTIVE_OBSERVED').length,
        knocked: states.filter((item) => item.state === 'KNOCKED').length,
        dead: states.filter((item) => item.state === 'DEAD').length,
        unknown: states.filter((item) => item.state === 'UNKNOWN').length,
        completeness: 'observed-members-only' as const,
        states,
      },
    };
  });
  return {
    summaries,
    conflictCount,
    playerRefs: [...tracked].map((playerId) => battlePlayerRef(matchId, playerId)),
    conflictEventIds,
  };
}

function timelineEvent(
  event: BattleSourceEvent,
  matchId: string,
  playerTeam: Map<string, string | null>,
): BattleTimelineEvent {
  const actorTeamId = resolveTeamId(event.actorTeamId, event.actorId, playerTeam);
  const victimTeamId = resolveTeamId(event.victimTeamId, event.victimId, playerTeam);
  return {
    id: event.sourceEventId,
    sourceEventId: event.sourceEventId,
    type: event.type,
    rawType: event.rawType,
    timeSeconds: event.timeSeconds!,
    timestampSource: event.timestampSource,
    actorRef: event.actorId ? battlePlayerRef(matchId, event.actorId) : null,
    victimRef: event.victimId ? battlePlayerRef(matchId, event.victimId) : null,
    actorTeamRef: actorTeamId ? battleTeamRef(matchId, actorTeamId) : null,
    victimTeamRef: victimTeamId ? battleTeamRef(matchId, victimTeamId) : null,
    damage: event.type === 'DAMAGE' ? event.damage : null,
    weapon: event.weaponId,
    location: vectorOf(event.location),
  };
}

function chainForKnock(
  knock: BattleSourceEvent,
  assigned: BattleSourceEvent[],
  events: BattleSourceEvent[],
  matchId: string,
): KnockChain {
  const outcome = knockOutcome(knock, events);
  const episodeOutcome =
    outcome && assigned.some((event) => event.id === outcome.id) ? outcome : null;
  return {
    knockEventId: knock.sourceEventId,
    knockedPlayerRef: knock.victimId ? battlePlayerRef(matchId, knock.victimId) : null,
    attackerRef: knock.actorId ? battlePlayerRef(matchId, knock.actorId) : null,
    knockAtSeconds: knock.timeSeconds!,
    outcome:
      episodeOutcome?.type === 'KILL' || episodeOutcome?.type === 'REVIVE'
        ? episodeOutcome.type
        : null,
    outcomeEventId: episodeOutcome?.sourceEventId ?? null,
    outcomeAtSeconds: episodeOutcome?.timeSeconds ?? null,
    elapsedSeconds:
      episodeOutcome && episodeOutcome.timeSeconds !== null
        ? Math.max(0, episodeOutcome.timeSeconds - knock.timeSeconds!)
        : null,
    windowSeconds: BATTLE_KNOCK_OUTCOME_WINDOW_SECONDS,
  };
}

function circleForEpisode(
  session: ContactSession,
  samples: BattleCircleSample[],
): BattleCircleSample[] {
  return samples.filter(
    (sample) =>
      sample.timeSeconds !== null &&
      sample.phase === 'in_match' &&
      sample.timeSeconds >= session.startSeconds - BATTLE_CONTEXT_BEFORE_SECONDS &&
      sample.timeSeconds <= session.endSeconds + BATTLE_CONTEXT_AFTER_SECONDS,
  );
}

function circleTransitions(
  samples: BattleCircleSample[],
  matchId: string,
): BattleCircleTransition[] {
  const zones = ['safetyZone', 'poisonGasWarningZone', 'redZone', 'blackZone'] as const;
  const transitions: BattleCircleTransition[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    if (
      previous.timeSeconds === null ||
      current.timeSeconds === null ||
      current.timeSeconds < previous.timeSeconds
    )
      continue;
    const changedZones = zones.filter(
      (zone) => JSON.stringify(previous[zone]) !== JSON.stringify(current[zone]),
    );
    if (!changedZones.length) continue;
    transitions.push({
      id: `circle-transition-${idDigest(`${matchId}\u001f${previous.id}\u001f${current.id}\u001f${changedZones.join(',')}`)}`,
      fromSampleId: previous.id,
      toSampleId: current.id,
      fromSourceEventId: previous.sourceEventId,
      toSourceEventId: current.sourceEventId,
      timeSeconds: current.timeSeconds,
      changedZones: [...changedZones],
    });
  }
  return transitions;
}

function episodeForSession(
  session: ContactSession,
  events: BattleSourceEvent[],
  circles: BattleCircleSample[],
  transitions: BattleCircleTransition[],
  teamMembers: Map<string, Set<string>>,
  playerTeam: Map<string, string | null>,
  trackedPlayerIds: Set<string>,
  matchId: string,
  globalStateConflictEventIds: Set<string>,
): BattleEpisode {
  const uniqueTimeline = [
    ...new Map(session.assigned.map((event) => [event.sourceEventId, event])).values(),
  ].sort(eventOrder);
  const states = stateAtEnd(session, events, teamMembers, playerTeam, matchId);
  for (const eventId of states.conflictEventIds) globalStateConflictEventIds.add(eventId);
  const teams = states.summaries.map((team, index) => ({
    ...team,
    tracked: session.sides[index]!.teamId
      ? [...(teamMembers.get(session.sides[index]!.teamId!) ?? [])].some((playerId) =>
          trackedPlayerIds.has(playerId),
        )
      : Boolean(
          session.sides[index]!.seedPlayerId &&
          trackedPlayerIds.has(session.sides[index]!.seedPlayerId!),
        ),
  }));
  const knocks = session.seedEvents.filter((event) => event.type === 'KNOCK').sort(eventOrder);
  const chains = knocks.map((knock) => chainForKnock(knock, uniqueTimeline, events, matchId));
  const first = knocks[0];
  const eventRecords = uniqueTimeline.map((event) => timelineEvent(event, matchId, playerTeam));
  const circleSamplesForEpisode = circleForEpisode(session, circles);
  session.circleSampleRefs = circleSamplesForEpisode.map((sample) => sample.id);
  const circleSampleRefs = new Set(session.circleSampleRefs);
  const circleTransitionRefs = transitions
    .filter(
      (transition) =>
        circleSampleRefs.has(transition.fromSampleId) &&
        circleSampleRefs.has(transition.toSampleId),
    )
    .map((transition) => transition.id);
  const evidenceEventIds = [
    ...new Set([
      ...uniqueTimeline.map((event) => event.sourceEventId),
      ...session.circleSampleRefs,
      ...circleTransitionRefs,
    ]),
  ];
  return {
    id: session.id,
    startSeconds: session.startSeconds,
    endSeconds: session.endSeconds,
    durationSeconds: Math.max(0, session.endSeconds - session.startSeconds),
    contactGapSeconds: BATTLE_CONTACT_GAP_SECONDS,
    participantRefs: [
      ...new Set(
        uniqueTimeline.flatMap((event) =>
          [event.actorId, event.victimId].filter((value): value is string => Boolean(value)),
        ),
      ),
    ]
      .map((playerId) => battlePlayerRef(matchId, playerId))
      .sort(),
    teams,
    firstKnock: first
      ? {
          sourceEventId: first.sourceEventId,
          attackerRef: first.actorId ? battlePlayerRef(matchId, first.actorId) : null,
          victimRef: first.victimId ? battlePlayerRef(matchId, first.victimId) : null,
          timeSeconds: first.timeSeconds!,
        }
      : null,
    knockChains: chains,
    timeline: eventRecords,
    positions: session.positions.map((position) => ({
      sourceEventId: position.sourceEventId,
      playerRef: battlePlayerRef(matchId, position.playerRef),
      teamRef: position.teamRef ? battleTeamRef(matchId, position.teamRef) : null,
      timeSeconds: position.timeSeconds,
      location: position.location,
    })),
    circleSampleRefs: session.circleSampleRefs,
    circleTransitionRefs,
    evidenceEventIds,
    diagnostics: {
      conflictingStateTransitions: states.conflictCount,
      unknownTeamContacts: session.diagnostics.unknownTeamContacts,
      ambiguousContextEvents: session.diagnostics.ambiguousContextEvents,
      positionsSuppressedBySampling: session.diagnostics.positionsSuppressedBySampling,
    },
  };
}

function episodeContactEventIds(episode: BattleEpisode): string[] {
  return episode.timeline
    .filter((event) => COMBAT_CONTACT_TYPES.has(event.type))
    .map((event) => event.sourceEventId);
}

function battleGroupsFor(
  matchId: string,
  episodes: readonly BattleEpisode[],
  events: readonly BattleSourceEvent[],
): BattleGroup[] {
  const parent = episodes.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index]!);
    return parent[index]!;
  };
  const bridgeEdges: Array<{ left: number; right: number; eventIds: string[] }> = [];
  for (let left = 0; left < episodes.length; left += 1) {
    for (let right = left + 1; right < episodes.length; right += 1) {
      const a = episodes[left]!;
      const b = episodes[right]!;
      const startsOverlap = Math.max(a.startSeconds, b.startSeconds);
      const endsOverlap = Math.min(a.endSeconds, b.endSeconds);
      if (startsOverlap > endsOverlap) continue;
      const aTeams = new Set(
        a.teams.map((team) => team.teamRef).filter((value): value is string => Boolean(value)),
      );
      const bTeams = new Set(
        b.teams.map((team) => team.teamRef).filter((value): value is string => Boolean(value)),
      );
      if (![...aTeams].some((teamRef) => bTeams.has(teamRef))) continue;
      const nearestContactEvidence = (episode: BattleEpisode) =>
        episode.timeline
          .filter((event) => COMBAT_CONTACT_TYPES.has(event.type))
          .sort((first, second) => {
            const distance = (time: number) =>
              time < startsOverlap
                ? startsOverlap - time
                : time > endsOverlap
                  ? time - endsOverlap
                  : 0;
            return (
              distance(first.timeSeconds) - distance(second.timeSeconds) ||
              first.timeSeconds - second.timeSeconds ||
              first.sourceEventId.localeCompare(second.sourceEventId)
            );
          })
          .slice(0, 1)
          .map((event) => event.sourceEventId);
      const evidenceEventIds = [
        ...new Set([...nearestContactEvidence(a), ...nearestContactEvidence(b)]),
      ];
      if (evidenceEventIds.length < 2) continue;
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
      bridgeEdges.push({ left, right, eventIds: evidenceEventIds });
    }
  }

  const indicesByRoot = new Map<number, number[]>();
  episodes.forEach((_, index) => {
    const root = find(index);
    indicesByRoot.set(root, [...(indicesByRoot.get(root) ?? []), index]);
  });
  const eventById = new Map(events.map((event) => [event.sourceEventId, event]));
  const groups: BattleGroup[] = [...indicesByRoot.values()]
    .map((indices): BattleGroup => {
      const groupEpisodes = indices
        .map((index) => episodes[index]!)
        .sort(
          (left, right) =>
            left.startSeconds - right.startSeconds || left.id.localeCompare(right.id),
        );
      const episodeIds = groupEpisodes.map((episode) => episode.id).sort();
      const indexSet = new Set(indices);
      const bridgeEvidenceEventIds = [
        ...new Set(
          bridgeEdges
            .filter((edge) => indexSet.has(edge.left) && indexSet.has(edge.right))
            .flatMap((edge) => edge.eventIds),
        ),
      ].sort();
      const timelineBySource = new Map<string, BattleTimelineEvent>();
      for (const episode of groupEpisodes) {
        for (const event of episode.timeline) timelineBySource.set(event.sourceEventId, event);
      }
      const timeline = [...timelineBySource.values()].sort(
        (left, right) =>
          left.timeSeconds - right.timeSeconds ||
          left.sourceEventId.localeCompare(right.sourceEventId),
      );
      const teamRefs = [
        ...new Set(
          groupEpisodes.flatMap((episode) =>
            episode.teams
              .map((team) => team.teamRef)
              .filter((value): value is string => Boolean(value)),
          ),
        ),
      ].sort();
      const startSeconds = Math.min(...groupEpisodes.map((episode) => episode.startSeconds));
      const endSeconds = Math.max(...groupEpisodes.map((episode) => episode.endSeconds));
      const groupId = `battle-${idDigest(`${matchId}\u001f${BATTLE_RECONSTRUCTION_PARSER_VERSION}\u001f${episodeIds.join('\u001f')}`)}`;
      const playerStates = new Map<string, ObservedPlayerState>();
      const playerTeams = new Map<string, string>();
      const membersByTeam = new Map<string, Set<string>>();
      for (const episode of groupEpisodes) {
        for (const team of episode.teams) {
          if (!team.teamRef) continue;
          const members = membersByTeam.get(team.teamRef) ?? new Set<string>();
          for (const ref of team.memberRefs) {
            members.add(ref);
            playerTeams.set(ref, team.teamRef);
          }
          membersByTeam.set(team.teamRef, members);
        }
      }
      const stateEvents = timeline.flatMap((timelineEvent) => {
        const event = eventById.get(timelineEvent.sourceEventId);
        if (!event || (event.type !== 'KNOCK' && event.type !== 'KILL' && event.type !== 'REVIVE'))
          return [];
        return [{ timelineEvent, event }];
      });
      const countStates = (): BattleObservedTeamState[] =>
        teamRefs.map((teamRef) => {
          const members = membersByTeam.get(teamRef) ?? new Set<string>();
          let activeObserved = 0;
          let knockedObserved = 0;
          let deadObserved = 0;
          let unknownObserved = 0;
          for (const member of members) {
            const state = playerStates.get(member) ?? 'UNKNOWN';
            if (state === 'ACTIVE_OBSERVED') activeObserved += 1;
            else if (state === 'KNOCKED') knockedObserved += 1;
            else if (state === 'DEAD') deadObserved += 1;
            else unknownObserved += 1;
          }
          return {
            teamRef,
            memberCountObserved: members.size,
            activeObserved,
            knockedObserved,
            deadObserved,
            unknownObserved,
            completeness: 'observed-members-only',
          };
        });
      const stateTimeline: BattleStateTimelineEntry[] = [];
      for (const { timelineEvent, event } of stateEvents) {
        const actorRef = timelineEvent.actorRef;
        const victimRef = timelineEvent.victimRef;
        if (actorRef && !playerStates.has(actorRef)) playerStates.set(actorRef, 'ACTIVE_OBSERVED');
        if (victimRef && !playerStates.has(victimRef))
          playerStates.set(victimRef, 'ACTIVE_OBSERVED');
        if (victimRef) {
          const previous = playerStates.get(victimRef) ?? 'UNKNOWN';
          if (event.type === 'KNOCK' && previous !== 'DEAD') playerStates.set(victimRef, 'KNOCKED');
          if (event.type === 'KILL') playerStates.set(victimRef, 'DEAD');
          if (event.type === 'REVIVE' && previous !== 'DEAD')
            playerStates.set(victimRef, 'ACTIVE_OBSERVED');
        }
        stateTimeline.push({
          sourceEventId: event.sourceEventId,
          timeSeconds: event.timeSeconds ?? timelineEvent.timeSeconds,
          type: event.type as BattleStateTimelineEntry['type'],
          actorRef: timelineEvent.actorRef,
          victimRef: timelineEvent.victimRef,
          actorTeamRef: timelineEvent.actorTeamRef,
          victimTeamRef: timelineEvent.victimTeamRef,
          states: countStates(),
        });
      }

      const advantageWindows: BattleAdvantageWindow[] = [];
      const advantageChanges: BattleAdvantageChange[] = [];
      for (let leftIndex = 0; leftIndex < teamRefs.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < teamRefs.length; rightIndex += 1) {
          const pair: [string, string] = [teamRefs[leftIndex]!, teamRefs[rightIndex]!];
          const downByPlayer = new Map<string, boolean>();
          let previousLead: string | null = null;
          let priorNonNullLead: string | null = null;
          let open: { leader: string; start: number; sourceEventId: string } | null = null;
          const close = (
            at: number,
            sourceEventId: string | null,
            resolution: BattleAdvantageWindow['resolution'],
          ) => {
            if (!open) return;
            advantageWindows.push({
              teamRefs: pair,
              observedLeadTeamRef: open.leader,
              startedAtSeconds: open.start,
              endedAtSeconds: at,
              durationSeconds: Math.max(0, at - open.start),
              resolution,
              startEventId: open.sourceEventId,
              endEventId: sourceEventId,
              evidenceEventIds: [
                ...new Set([open.sourceEventId, ...(sourceEventId ? [sourceEventId] : [])]),
              ],
              assessment: 'observed-knock-balance-only',
              rosterCompleteness: 'observed-members-only',
            });
            open = null;
          };
          for (const { event } of stateEvents) {
            if (
              !event.victimId ||
              !event.victimTeamId ||
              !pair.includes(battleTeamRef(matchId, event.victimTeamId)) ||
              event.timeSeconds === null
            )
              continue;
            if (event.type === 'KNOCK' || event.type === 'KILL')
              downByPlayer.set(event.victimId, true);
            if (event.type === 'REVIVE') downByPlayer.set(event.victimId, false);
            const downCount = (teamRef: string) =>
              [...downByPlayer.entries()].filter(
                ([playerId, down]) =>
                  down && playerTeams.get(battlePlayerRef(matchId, playerId)) === teamRef,
              ).length;
            const [leftDown, rightDown] = pair.map(downCount) as [number, number];
            const nextLead = leftDown < rightDown ? pair[0] : rightDown < leftDown ? pair[1] : null;
            if (nextLead !== previousLead) {
              const classification: BattleAdvantageChange['classification'] =
                previousLead && !nextLead
                  ? 'equalized'
                  : nextLead && priorNonNullLead && nextLead !== priorNonNullLead
                    ? 'reversed'
                    : nextLead
                      ? 'lead'
                      : 'equalized';
              advantageChanges.push({
                teamRefs: pair,
                timeSeconds: event.timeSeconds,
                previousLeadTeamRef: previousLead,
                nextLeadTeamRef: nextLead,
                classification,
                sourceEventId: event.sourceEventId,
              });
              close(event.timeSeconds, event.sourceEventId, nextLead ? 'reversed' : 'equalized');
              if (nextLead)
                open = {
                  leader: nextLead,
                  start: event.timeSeconds,
                  sourceEventId: event.sourceEventId,
                };
              previousLead = nextLead;
              if (nextLead) priorNonNullLead = nextLead;
            }
          }
          if (open) close(endSeconds, null, 'ongoing');
        }
      }
      advantageWindows.sort(
        (left, right) =>
          left.startedAtSeconds - right.startedAtSeconds ||
          left.teamRefs.join('\u001f').localeCompare(right.teamRefs.join('\u001f')),
      );
      const firstKnockEvent = stateEvents.find(({ event }) => event.type === 'KNOCK');
      const firstKnock = firstKnockEvent?.event;
      const groupEvents = timeline.flatMap((timelineEvent) => {
        const event = eventById.get(timelineEvent.sourceEventId);
        return event ? [event] : [];
      });
      const response =
        firstKnock?.actorTeamId && firstKnock.victimTeamId && firstKnock.timeSeconds !== null
          ? groupEvents
              .filter(
                (event) =>
                  event.sourceEventId !== firstKnock.sourceEventId &&
                  event.timeSeconds !== null &&
                  event.timeSeconds > firstKnock.timeSeconds! &&
                  event.timeSeconds <=
                    firstKnock.timeSeconds! + BATTLE_POST_KNOCK_RESPONSE_WINDOW_SECONDS &&
                  event.actorTeamId === firstKnock.actorTeamId &&
                  event.victimTeamId === firstKnock.victimTeamId &&
                  (event.type === 'KNOCK' ||
                    event.type === 'KILL' ||
                    (event.type === 'DAMAGE' && event.hit && event.damage > 0)),
              )
              .sort(
                (left, right) =>
                  left.timeSeconds! - right.timeSeconds! ||
                  left.sourceEventId.localeCompare(right.sourceEventId),
              )[0]
          : undefined;
      const firstKnockPair =
        firstKnock?.actorTeamId && firstKnock.victimTeamId
          ? [
              battleTeamRef(matchId, firstKnock.actorTeamId),
              battleTeamRef(matchId, firstKnock.victimTeamId),
            ].sort()
          : [];
      const firstKnockAdvantage = firstKnock
        ? (advantageWindows.find(
            (window) =>
              window.startEventId === firstKnock.sourceEventId &&
              (!firstKnockPair.length ||
                window.teamRefs.every((teamRef, index) => teamRef === firstKnockPair[index])),
          ) ?? null)
        : null;
      const firstEpisode = groupEpisodes[0]!;
      const firstPairTeams = new Set(
        firstEpisode.teams
          .map((team) => team.teamRef)
          .filter((value): value is string => Boolean(value)),
      );
      const possibleThirdParty = groupEpisodes.flatMap((episode) => {
        if (
          episode.id === firstEpisode.id ||
          episode.startSeconds > firstEpisode.endSeconds ||
          episode.endSeconds < firstEpisode.startSeconds
        )
          return [];
        const addedTeams = episode.teams
          .map((team) => team.teamRef)
          .filter((value): value is string => value !== null && !firstPairTeams.has(value));
        if (!episode.teams.some((team) => team.teamRef && firstPairTeams.has(team.teamRef)))
          return [];
        return addedTeams.map((teamRef) => ({
          teamRef,
          episodeId: episode.id,
          evidenceEventIds: episodeContactEventIds(episode).slice(0, 4),
          status: 'possible_third_party_contact' as const,
        }));
      });

      return {
        id: groupId,
        startSeconds,
        endSeconds,
        durationSeconds: Math.max(0, endSeconds - startSeconds),
        episodeIds,
        teamRefs,
        bridgeEvidenceEventIds,
        timeline,
        stateTimeline,
        advantageWindows,
        advantageChanges,
        firstKnockAdvantage,
        postKnockResponse: {
          status: response
            ? 'observed'
            : firstKnock?.actorTeamId && firstKnock.victimTeamId
              ? 'not_observed_in_window'
              : 'incomplete',
          firstKnockEventId: firstKnock?.sourceEventId ?? null,
          responseEventId: response?.sourceEventId ?? null,
          elapsedSeconds:
            response && firstKnock?.timeSeconds !== null && firstKnock?.timeSeconds !== undefined
              ? response.timeSeconds! - firstKnock.timeSeconds
              : null,
          windowSeconds: BATTLE_POST_KNOCK_RESPONSE_WINDOW_SECONDS,
        },
        possibleThirdParty,
        rosterCompleteness: 'observed-members-only',
      };
    })
    .sort(
      (left, right) => left.startSeconds - right.startSeconds || left.id.localeCompare(right.id),
    );
  return groups;
}

export interface ReconstructBattleOptions {
  match: Pick<NormalizedMatch, 'matchId'>;
  telemetry: BattleTelemetryDocument;
  trackedPlayerIds?: Iterable<string>;
}

export function reconstructBattleEpisodes(
  input: ReconstructBattleOptions,
): BattleReconstructionResult {
  const matchId = input.match.matchId;
  const events = input.telemetry.events;
  const {
    playerTeam,
    teamMembers,
    conflictCount: conflictingTeamReferenceCount,
  } = teamMembership(events);
  const segmented = segmentContacts(events, playerTeam, matchId);
  const sessions = segmented.sessions;
  const reviveAssignment = assignRevives(events, sessions);
  const contextAssignment = assignContextEvents(events, sessions, playerTeam);
  const trackedPlayerIds = new Set(input.trackedPlayerIds ?? []);
  const circleSamples = [...input.telemetry.circleSamples].sort(circleOrder);
  const transitions = circleTransitions(
    circleSamples.filter((sample) => sample.phase === 'in_match'),
    matchId,
  );
  const stateConflictEventIds = new Set<string>();
  const episodes = sessions.map((session) =>
    episodeForSession(
      session,
      events,
      circleSamples,
      transitions,
      teamMembers,
      playerTeam,
      trackedPlayerIds,
      matchId,
      stateConflictEventIds,
    ),
  );
  const battles = battleGroupsFor(matchId, episodes, events);
  const assignedTimelineIds = sessions.flatMap((session) =>
    session.assigned.map((event) => event.sourceEventId),
  );
  const countById = new Map<string, number>();
  for (const id of assignedTimelineIds) countById.set(id, (countById.get(id) ?? 0) + 1);
  const duplicateTimelineAssignmentCount = [...countById.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count - 1, 0);
  let overlappingEpisodePairCount = 0;
  for (let left = 0; left < sessions.length; left += 1) {
    for (let right = left + 1; right < sessions.length; right += 1) {
      const a = sessions[left]!;
      const b = sessions[right]!;
      if (
        a.startSeconds <= b.endSeconds &&
        b.startSeconds <= a.endSeconds &&
        a.pairKey !== b.pairKey
      )
        overlappingEpisodePairCount += 1;
    }
  }
  const unresolvedKnockChainCount = episodes
    .flatMap((episode) => episode.knockChains)
    .filter((chain) => chain.outcome === null).length;
  const conflictingStateTransitionCount = stateConflictEventIds.size;
  const ambiguousContextEventCount = contextAssignment.ambiguous;
  const positionsSuppressedBySampling = episodes.reduce(
    (sum, episode) => sum + episode.diagnostics.positionsSuppressedBySampling,
    0,
  );
  const circleAssignmentCounts = new Map<string, number>();
  for (const episode of episodes) {
    for (const circleRef of episode.circleSampleRefs)
      circleAssignmentCounts.set(circleRef, (circleAssignmentCounts.get(circleRef) ?? 0) + 1);
  }
  const sharedCircleSampleContextCount = [...circleAssignmentCounts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const assignedContactIds = new Set(
    sessions.flatMap((session) => session.seedEvents.map((event) => event.sourceEventId)),
  );
  const unassignedContactEventCount = [
    ...new Set(
      events
        .filter((event) => COMBAT_CONTACT_TYPES.has(event.type))
        .map((event) => event.sourceEventId),
    ),
  ].filter((sourceEventId) => !assignedContactIds.has(sourceEventId)).length;
  return {
    schemaVersion: BATTLE_RECONSTRUCTION_SCHEMA_VERSION,
    parserVersion: BATTLE_RECONSTRUCTION_PARSER_VERSION,
    status: episodes.length ? 'available' : 'no_contact_events',
    episodes,
    battles,
    circleSamples,
    circleTransitions: transitions,
    diagnostics: {
      rawEventCount: input.telemetry.rawEventCount,
      domainNormalizedEventCount: input.telemetry.domainNormalizedEventCount,
      battleEventCount: events.length,
      contactEventCount: events.filter((event) => COMBAT_CONTACT_TYPES.has(event.type)).length,
      episodeCount: episodes.length,
      battleGroupCount: battles.length,
      multiTeamBattleCount: battles.filter((battle) => battle.teamRefs.length >= 3).length,
      groupedEpisodeCount: battles
        .filter((battle) => battle.episodeIds.length > 1)
        .reduce((sum, battle) => sum + battle.episodeIds.length, 0),
      duplicateSourceEventCount: segmented.counters.duplicateSourceEventCount,
      duplicateTimelineAssignmentCount,
      unassignedContactEventCount,
      untimedContactEventCount: segmented.counters.untimedContactEventCount,
      preMatchContactEventCount:
        input.telemetry.diagnostics.excludedPreMatchContactEventCount +
        segmented.counters.preMatchContactEventCount,
      noParticipantContactEventCount: segmented.counters.noParticipantContactEventCount,
      sameTeamContactEventCount: segmented.counters.sameTeamContactEventCount,
      ineffectiveContactEventCount: segmented.counters.ineffectiveContactEventCount,
      unknownPhaseContactEventCount: segmented.counters.unknownPhaseContactEventCount,
      unknownTeamContactEventCount: segmented.counters.unknownTeamContactEventCount,
      unknownPhaseCircleSampleCount: circleSamples.filter((sample) => sample.phase === 'unknown')
        .length,
      unresolvedKnockChainCount,
      reviveWithoutUniqueKnockCount: reviveAssignment.ambiguous,
      conflictingTeamReferenceCount,
      conflictingStateTransitionCount,
      ambiguousContextEventCount: contextAssignment.ambiguous,
      positionsSuppressedBySampling: contextAssignment.suppressedPositions,
      overlappingEpisodePairCount,
      sharedCircleSampleContextCount,
    },
  };
}

export function reconstructBattleMatch(input: {
  match: NormalizedMatch;
  telemetry: unknown;
  trackedPlayerIds?: Iterable<string>;
}): BattleReconstructionResult {
  const telemetry = normalizeBattleTelemetry(input.telemetry, input.match);
  return reconstructBattleEpisodes({
    match: input.match,
    telemetry,
    ...(input.trackedPlayerIds === undefined ? {} : { trackedPlayerIds: input.trackedPlayerIds }),
  });
}
