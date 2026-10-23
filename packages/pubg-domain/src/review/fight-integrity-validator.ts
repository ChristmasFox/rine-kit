import type { ReviewPlayerFacts, Fight, FightIntegrityResult } from './types.js';
import type { NormalizedTelemetryEvent } from './telemetry-events.js';
import {
  dedupeRelevantCombatEvents,
  isRelevantCombatEvent,
  isTrackedOffensiveEvent,
} from './combat-scope.js';

const COMBAT_TYPES = new Set<NormalizedTelemetryEvent['type']>([
  'DAMAGE',
  'KNOCK',
  'KILL',
  'REVIVE',
]);
export const FIGHT_DAMAGE_TOLERANCE = 1;

function candidateEvents(events: NormalizedTelemetryEvent[]): NormalizedTelemetryEvent[] {
  return events.filter((event) => COMBAT_TYPES.has(event.type));
}

function eventMetrics(
  events: NormalizedTelemetryEvent[],
  teamIds: Set<string>,
): { kills: number; knocks: number; damage: number } {
  const deduped = dedupeRelevantCombatEvents(events, teamIds);
  return {
    kills: deduped.filter(
      (event) => isTrackedOffensiveEvent(event, teamIds) && event.type === 'KILL',
    ).length,
    knocks: deduped.filter(
      (event) => isTrackedOffensiveEvent(event, teamIds) && event.type === 'KNOCK',
    ).length,
    damage: deduped
      .filter((event) => isTrackedOffensiveEvent(event, teamIds) && event.type === 'DAMAGE')
      .reduce((sum, event) => sum + event.damage, 0),
  };
}

export interface FightIntegrityInput {
  fights: Fight[];
  events: NormalizedTelemetryEvent[];
  teamIds: Set<string>;
  players: ReviewPlayerFacts[];
  matchTeamKills: number;
  matchTeamDamage: number;
  matchTeamDBNOs: number;
}

export function validateFightIntegrity(input: FightIntegrityInput): FightIntegrityResult {
  const candidates = candidateEvents(input.events);
  const relevantRaw = candidates.filter((event) => isRelevantCombatEvent(event, input.teamIds));
  const relevant = dedupeRelevantCombatEvents(relevantRaw, input.teamIds);
  const eventById = new Map(input.events.map((event) => [event.id, event]));
  const perPlayer = new Map<string, { kills: number; knocks: number; damage: number }>();
  const eventAssignments = new Map<string, string[]>();
  const errors: string[] = [];
  const addPlayerMetrics = (
    playerId: string,
    metrics: { kills: number; knocks: number; damage: number },
  ): void => {
    const current = perPlayer.get(playerId) ?? { kills: 0, knocks: 0, damage: 0 };
    current.kills += metrics.kills;
    current.knocks += metrics.knocks;
    current.damage += metrics.damage;
    perPlayer.set(playerId, current);
  };
  const fightMetrics = input.fights.map((fight) => {
    const fightEvents = [...new Set(fight.evidenceIds)]
      .map((id) => eventById.get(id))
      .filter((event): event is NormalizedTelemetryEvent => Boolean(event));
    const relevantFightEvents = dedupeRelevantCombatEvents(fightEvents, input.teamIds);
    const metrics = eventMetrics(relevantFightEvents, input.teamIds);
    const teamDamage = metrics.damage;
    const teamKills = metrics.kills;
    const teamKnocks = metrics.knocks;
    for (const playerId of input.teamIds) {
      addPlayerMetrics(
        playerId,
        eventMetrics(
          relevantFightEvents.filter((event) => event.actorId === playerId),
          input.teamIds,
        ),
      );
    }
    for (const id of new Set(fight.evidenceIds)) {
      const assigned = eventAssignments.get(id) ?? [];
      assigned.push(fight.id);
      eventAssignments.set(id, assigned);
    }
    const missingEvidence = fight.evidenceIds.some((id) => !eventById.has(id));
    const irrelevantEvidence = fightEvents.some(
      (event) => !isRelevantCombatEvent(event, input.teamIds),
    );
    const declaredMetricsMatch =
      fight.teamKills === teamKills &&
      fight.kills === teamKills &&
      fight.teamKnocks === teamKnocks &&
      fight.knocks === teamKnocks &&
      Math.abs(fight.teamDamage - teamDamage) <= FIGHT_DAMAGE_TOLERANCE &&
      Math.abs(fight.damage - teamDamage) <= FIGHT_DAMAGE_TOLERANCE &&
      fight.eventCount === relevantFightEvents.length;
    const integrityPass =
      !missingEvidence &&
      !irrelevantEvidence &&
      declaredMetricsMatch &&
      teamKills <= input.matchTeamKills &&
      teamKnocks <= input.matchTeamDBNOs &&
      teamDamage <= input.matchTeamDamage + FIGHT_DAMAGE_TOLERANCE;
    return {
      fight,
      metrics: { teamKills, teamKnocks, teamDamage },
      id: fight.id,
      duration: Math.max(0, fight.end - fight.start),
      opponentTeamIds: fight.opponentTeamIds,
      eventCount: relevantFightEvents.length,
      teamKills,
      teamKnocks,
      teamDamage,
      receivedDamage: fight.receivedDamage,
      integrityPass,
      missingEvidence,
      irrelevantEvidence,
      declaredMetricsMatch,
    };
  });
  for (const [eventId, fightIds] of eventAssignments) {
    if (fightIds.length > 1) errors.push(`combat_event_assigned_to_multiple_fights:${eventId}`);
  }
  for (const diagnostic of fightMetrics) {
    if (diagnostic.missingEvidence) errors.push(`fight_missing_evidence:${diagnostic.id}`);
    if (diagnostic.irrelevantEvidence)
      errors.push(`fight_contains_irrelevant_event:${diagnostic.id}`);
    if (!diagnostic.declaredMetricsMatch) errors.push(`fight_metrics_mismatch:${diagnostic.id}`);
  }
  const totalKills = fightMetrics.reduce((sum, item) => sum + item.metrics.teamKills, 0);
  const totalKnocks = fightMetrics.reduce((sum, item) => sum + item.metrics.teamKnocks, 0);
  const totalDamage = fightMetrics.reduce((sum, item) => sum + item.metrics.teamDamage, 0);
  if (totalKills > input.matchTeamKills) errors.push('fight_team_kills_exceed_match_kills');
  if (totalKnocks > input.matchTeamDBNOs) errors.push('fight_team_knocks_exceed_match_dbnos');
  if (totalDamage > input.matchTeamDamage + FIGHT_DAMAGE_TOLERANCE)
    errors.push('fight_team_damage_exceed_match_damage');
  for (const player of input.players) {
    const metrics = perPlayer.get(player.playerId) ?? { kills: 0, knocks: 0, damage: 0 };
    if (metrics.kills > player.kills)
      errors.push(`fight_player_kills_exceed_match:${player.playerId}`);
    if (metrics.knocks > player.dbnos)
      errors.push(`fight_player_knocks_exceed_match:${player.playerId}`);
    if (metrics.damage > player.damage + FIGHT_DAMAGE_TOLERANCE)
      errors.push(`fight_player_damage_exceed_match:${player.playerId}`);
  }
  const pass = errors.length === 0 && fightMetrics.every((fight) => fight.integrityPass);
  return {
    pass,
    status: pass ? 'FIGHT_ANALYTICS_VALID' : 'FIGHT_ANALYTICS_INVALID',
    diagnostics: {
      matchTeamKills: input.matchTeamKills,
      matchTeamDamage: input.matchTeamDamage,
      matchTeamDBNOs: input.matchTeamDBNOs,
      candidateCombatEvents: candidates.length,
      trackedRelevantEvents: relevant.length,
      ignoredGlobalEvents: Math.max(0, candidates.length - relevantRaw.length),
      fightCount: input.fights.length,
      damageTolerance: FIGHT_DAMAGE_TOLERANCE,
      fights: fightMetrics.map(
        ({
          fight: _fight,
          metrics: _metrics,
          missingEvidence: _missing,
          irrelevantEvidence: _irrelevant,
          declaredMetricsMatch: _declared,
          ...diagnostic
        }) => diagnostic,
      ),
    },
    errors: [...new Set(errors)],
  };
}
