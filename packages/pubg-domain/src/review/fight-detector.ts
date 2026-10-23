import type { Fight } from './types.js';
import type { NormalizedTelemetryEvent } from './telemetry-events.js';
import {
  dedupeRelevantCombatEvents,
  isOpponentOffensiveEvent,
  isOpponentReviveEvent,
  isTrackedOffensiveEvent,
  isTrackedReviveEvent,
} from './combat-scope.js';

const FIGHT_GAP_SECONDS = 28;

function resultFor(teamKills: number, opponentKills: number): Fight['result'] {
  if (teamKills > 0 && opponentKills === 0) return 'WIN';
  if (opponentKills > 0 && teamKills === 0) return 'LOSS';
  if (teamKills > 0 && opponentKills > 0) return 'TRADE';
  return 'UNKNOWN';
}

function timeOf(event: NormalizedTelemetryEvent): number {
  return event.timeSeconds ?? Number.POSITIVE_INFINITY;
}

function sortEvents(events: NormalizedTelemetryEvent[]): NormalizedTelemetryEvent[] {
  return [...events].sort(
    (left, right) => timeOf(left) - timeOf(right) || left.id.localeCompare(right.id),
  );
}

export function detectFights(events: NormalizedTelemetryEvent[], teamIds: Set<string>): Fight[] {
  const relevant = dedupeRelevantCombatEvents(events, teamIds);
  const seeds = sortEvents(
    relevant
      .filter(
        (event) =>
          isTrackedOffensiveEvent(event, teamIds) || isOpponentOffensiveEvent(event, teamIds),
      )
      .filter((event) => event.timeSeconds !== null),
  );
  const revives = sortEvents(
    relevant
      .filter(
        (event) => isTrackedReviveEvent(event, teamIds) || isOpponentReviveEvent(event, teamIds),
      )
      .filter((event) => event.timeSeconds !== null),
  );
  const seedGroups: NormalizedTelemetryEvent[][] = [];
  for (const event of seeds) {
    const current = seedGroups.at(-1);
    const previousTime = current?.at(-1)?.timeSeconds;
    if (
      !current ||
      previousTime === null ||
      previousTime === undefined ||
      timeOf(event) - previousTime > FIGHT_GAP_SECONDS
    ) {
      seedGroups.push([event]);
    } else {
      current.push(event);
    }
  }

  const assignedRevives = new Set<string>();
  return seedGroups.map((seedGroup, index) => {
    const start = seedGroup[0]?.timeSeconds ?? 0;
    const seedEnd = seedGroup.at(-1)?.timeSeconds ?? start;
    const group = sortEvents([
      ...seedGroup,
      ...revives.filter((event) => {
        const time = event.timeSeconds;
        if (
          time === null ||
          assignedRevives.has(event.id) ||
          time < start ||
          time > seedEnd + FIGHT_GAP_SECONDS
        )
          return false;
        assignedRevives.add(event.id);
        return true;
      }),
    ]);
    const end = group.at(-1)?.timeSeconds ?? seedEnd;
    const teamEvents = group.filter(
      (event) => isTrackedOffensiveEvent(event, teamIds) || isTrackedReviveEvent(event, teamIds),
    );
    const opponentEvents = group.filter(
      (event) => isOpponentOffensiveEvent(event, teamIds) || isOpponentReviveEvent(event, teamIds),
    );
    const teamDamage = teamEvents
      .filter((event) => event.type === 'DAMAGE')
      .reduce((sum, event) => sum + event.damage, 0);
    const receivedDamage = opponentEvents
      .filter((event) => event.type === 'DAMAGE')
      .reduce((sum, event) => sum + event.damage, 0);
    const teamKnocks = teamEvents.filter((event) => event.type === 'KNOCK').length;
    const receivedKnocks = opponentEvents.filter((event) => event.type === 'KNOCK').length;
    const teamKills = teamEvents.filter((event) => event.type === 'KILL').length;
    const receivedKills = opponentEvents.filter((event) => event.type === 'KILL').length;
    const teamRevives = teamEvents.filter((event) => event.type === 'REVIVE').length;
    const receivedRevives = opponentEvents.filter((event) => event.type === 'REVIVE').length;
    const participants = [
      ...new Set(
        group.flatMap((event) =>
          [event.actorId, event.victimId].filter((id): id is string => Boolean(id)),
        ),
      ),
    ];
    const opponentTeamIds = [
      ...new Set(
        group.flatMap((event) => {
          const ids: string[] = [];
          if (event.actorId && !teamIds.has(event.actorId) && event.actorTeamId)
            ids.push(event.actorTeamId);
          if (event.victimId && !teamIds.has(event.victimId) && event.victimTeamId)
            ids.push(event.victimTeamId);
          return ids;
        }),
      ),
    ].sort();
    const byPlayer = new Map<string, number>();
    for (const event of teamEvents) {
      if (!event.actorId || !teamIds.has(event.actorId)) continue;
      const score =
        event.damage + event.knocks * 250 + event.kills * 500 + (event.type === 'REVIVE' ? 100 : 0);
      byPlayer.set(event.actorId, (byPlayer.get(event.actorId) ?? 0) + score);
    }
    const keyPlayers = [...byPlayer.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 3)
      .map(([playerId]) => playerId);
    const location = group.find((event) => event.location?.reliable && event.location.label)
      ?.location?.label;
    const importanceScore = Math.round(
      teamDamage +
        receivedDamage * 0.75 +
        (teamKnocks + receivedKnocks) * 250 +
        (teamKills + receivedKills) * 500 +
        (teamRevives + receivedRevives) * 100,
    );
    return {
      id: `fight-${index + 1}`,
      start,
      end,
      participants,
      damage: teamDamage,
      knocks: teamKnocks,
      kills: teamKills,
      revives: teamRevives,
      teamDamage,
      teamKnocks,
      teamKills,
      teamRevives,
      receivedDamage,
      receivedKnocks,
      receivedKills,
      receivedRevives,
      opponentTeamIds,
      eventCount: group.length,
      result: resultFor(teamKills, receivedKills),
      importanceScore,
      keyPlayers,
      ...(location ? { location } : {}),
      evidenceIds: [...new Set(group.map((event) => event.id))],
    } satisfies Fight;
  });
}

export function selectKeyFights(fights: Fight[], limit = 3): Fight[] {
  return [...fights]
    .sort(
      (left, right) =>
        right.importanceScore - left.importanceScore ||
        left.start - right.start ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit)
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
}
