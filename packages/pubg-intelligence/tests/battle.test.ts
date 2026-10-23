import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedMatch } from '@rine-kit/pubg-domain';
import {
  BATTLE_CONTACT_GAP_SECONDS,
  BATTLE_KNOCK_OUTCOME_WINDOW_SECONDS,
  normalizeBattleTelemetry,
  reconstructBattleEpisodes,
  reconstructBattleMatch,
} from '../src/battle.js';

const start = Date.parse('2026-03-01T00:00:00.000Z');
const match: NormalizedMatch = {
  schemaVersion: 3,
  matchId: 'sanitized-r1-fixture',
  shard: 'steam',
  createdAt: new Date(start).toISOString(),
  timestamp: start,
  matchType: 'competitive',
  gameMode: 'squad-fpp',
  isCompetitive: true,
  mapName: 'Erangel',
  duration: 1200,
  patchVersion: 'fixture',
  players: [
    {
      accountId: 'tracked-1',
      playerName: 'Tracked One',
      displayName: 'Tracked One',
      rank: 2,
      kills: 1,
      assists: 0,
      damage: 100,
      dbnos: 1,
      revives: 1,
      headshotKills: 0,
      survivalTime: 500,
      longestKill: 0,
      deaths: 1,
      deathSemantics: 'explicit',
    },
    {
      accountId: 'tracked-2',
      playerName: 'Tracked Two',
      displayName: 'Tracked Two',
      rank: 2,
      kills: 0,
      assists: 0,
      damage: 80,
      dbnos: 1,
      revives: 0,
      headshotKills: 0,
      survivalTime: 500,
      longestKill: 0,
      deaths: 1,
      deathSemantics: 'explicit',
    },
  ],
};

type Actor = {
  accountId: string;
  teamId?: string;
  location?: { x: number; y: number; z?: number };
};
function event(
  type: string,
  seconds: number | null,
  actor: Actor,
  victim?: Actor,
  extra: Record<string, unknown> = {},
) {
  const raw: Record<string, unknown> = { _T: type, common: { isGame: true }, ...extra };
  if (seconds !== null) raw._D = new Date(start + seconds * 1000).toISOString();
  if (type.includes('Revive')) raw.reviver = actor;
  else if (type.includes('Kill')) raw.killer = actor;
  else if (type.includes('Position')) raw.character = actor;
  else if (type.includes('Attack')) raw.attacker = actor;
  else raw.attacker = actor;
  if (victim) raw.victim = victim;
  return raw;
}

const A = (accountId: string, teamId = 'team-a'): Actor => ({ accountId, teamId });
const B = (accountId: string, teamId = 'team-b'): Actor => ({ accountId, teamId });

test('sanitized fixed fixture replays deterministically with stable IDs, evidence, chains and no duplicate assignment', () => {
  const telemetry = [
    event('LogPlayerTakeDamage', 10, A('tracked-1'), B('enemy-1'), { damage: 25 }),
    event('LogPlayerMakeGroggy', 28, A('tracked-1'), B('enemy-1'), { dBNOId: 'dbno-1' }),
    event('LogPlayerRevive', 45, B('enemy-2'), B('enemy-1')),
    event('LogPlayerTakeDamage', 60, A('tracked-2'), B('enemy-3'), { damage: 40 }),
    event('LogPlayerMakeGroggy', 65, A('tracked-2'), B('enemy-3'), { dBNOId: 'dbno-2' }),
    event('LogPlayerKill', 80, A('tracked-1'), B('enemy-3'), { dBNOId: 'dbno-2' }),
    event('LogGameStatePeriodic', 70, A('tracked-1'), undefined, {
      gameState: {
        elapsedTime: 70,
        numAlivePlayers: 30,
        numAliveTeams: 9,
        safetyZonePosition: { x: 1000, y: 2000, z: 0 },
        safetyZoneRadius: 1500,
        poisonGasWarningPosition: { x: 1200, y: 1800, z: 0 },
        poisonGasWarningRadius: 2200,
      },
    }),
    event('LogGameStatePeriodic', 85, A('tracked-1'), undefined, {
      gameState: {
        elapsedTime: 85,
        numAlivePlayers: 28,
        numAliveTeams: 8,
        safetyZonePosition: { x: 1000, y: 2000, z: 0 },
        safetyZoneRadius: 1200,
        poisonGasWarningPosition: { x: 1200, y: 1800, z: 0 },
        poisonGasWarningRadius: 1900,
      },
    }),
    event('LogPlayerPosition', 72, { ...A('tracked-1'), location: { x: 1100, y: 2100, z: 0 } }),
    event('LogPlayerTakeDamage', 200, A('tracked-1'), B('enemy-4'), { damage: 20 }),
    event('LogPlayerTakeDamage', 205, A('tracked-1'), A('tracked-2'), { damage: 3 }),
  ];
  const first = reconstructBattleMatch({
    match,
    telemetry,
    trackedPlayerIds: ['tracked-1', 'tracked-2'],
  });
  const second = reconstructBattleMatch({
    match,
    telemetry,
    trackedPlayerIds: ['tracked-1', 'tracked-2'],
  });
  assert.deepEqual(first, second);
  assert.equal(first.episodes.length, 3);
  assert.equal(first.diagnostics.duplicateTimelineAssignmentCount, 0);
  assert.equal(first.diagnostics.sameTeamContactEventCount, 1);
  assert.equal(
    first.episodes.every(
      (episode) => episode.id.startsWith('episode-') && episode.evidenceEventIds.length > 0,
    ),
    true,
  );
  assert.equal(
    new Set(first.episodes.flatMap((episode) => episode.timeline.map((item) => item.sourceEventId)))
      .size,
    first.episodes.reduce((count, episode) => count + episode.timeline.length, 0),
  );
  assert.equal(
    first.episodes.some((episode) =>
      episode.knockChains.some(
        (chain) => chain.outcome === 'REVIVE' && chain.elapsedSeconds === 17,
      ),
    ),
    true,
  );
  assert.equal(
    first.episodes.some((episode) =>
      episode.knockChains.some((chain) => chain.outcome === 'KILL' && chain.elapsedSeconds === 15),
    ),
    true,
  );
  assert.equal(first.circleSamples[0]?.safetyZone.radius, 1500);
  assert.equal(first.circleSamples[0]?.poisonGasWarningZone.center?.x, 1200);
  assert.equal(first.circleTransitions.length, 1);
  assert.deepEqual(first.circleTransitions[0]?.changedZones, [
    'safetyZone',
    'poisonGasWarningZone',
  ]);
  const episodeWithCircleChange = first.episodes.find(
    (episode) => episode.circleTransitionRefs.length > 0,
  );
  assert.ok(episodeWithCircleChange);
  assert.equal(
    episodeWithCircleChange.evidenceEventIds.includes(first.circleTransitions[0]!.id),
    true,
  );
  assert.equal(
    first.episodes.some((episode) =>
      episode.positions.some((position) => position.location.x === 1100),
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(first), /tracked-1|enemy-1|team-a|team-b/u);
});

test('exact contact and knock outcome boundaries are inclusive; one second beyond starts a new episode', () => {
  const exactGap = reconstructBattleMatch({
    match,
    telemetry: [
      event('LogPlayerTakeDamage', 0, A('tracked-1'), B('enemy-1'), { damage: 1 }),
      event('LogPlayerTakeDamage', BATTLE_CONTACT_GAP_SECONDS, A('tracked-1'), B('enemy-1'), {
        damage: 1,
      }),
      event('LogPlayerMakeGroggy', 40, A('tracked-1'), B('enemy-2'), { dBNOId: 'boundary' }),
      event(
        'LogPlayerKill',
        40 + BATTLE_KNOCK_OUTCOME_WINDOW_SECONDS,
        A('tracked-1'),
        B('enemy-2'),
        { dBNOId: 'boundary' },
      ),
    ],
  });
  assert.equal(exactGap.episodes.length, 1);
  assert.equal(
    exactGap.episodes[0]?.knockChains[0]?.elapsedSeconds,
    BATTLE_KNOCK_OUTCOME_WINDOW_SECONDS,
  );

  const split = reconstructBattleMatch({
    match,
    telemetry: [
      event('LogPlayerTakeDamage', 0, A('tracked-1'), B('enemy-1'), { damage: 1 }),
      event('LogPlayerTakeDamage', BATTLE_CONTACT_GAP_SECONDS + 1, A('tracked-1'), B('enemy-1'), {
        damage: 1,
      }),
      event('LogPlayerMakeGroggy', 300, A('tracked-1'), B('enemy-2'), { dBNOId: 'outside' }),
      event(
        'LogPlayerKill',
        301 + BATTLE_KNOCK_OUTCOME_WINDOW_SECONDS,
        A('tracked-1'),
        B('enemy-2'),
        { dBNOId: 'outside' },
      ),
    ],
  });
  assert.equal(split.episodes.length, 4);
  assert.equal(split.episodes.at(-2)?.knockChains[0]?.outcome, null);
});

test('overlapping team-pair episodes stay distinct and contact evidence is assigned once', () => {
  const overlap = reconstructBattleMatch({
    match,
    telemetry: [
      event('LogPlayerTakeDamage', 10, A('tracked-1'), B('enemy-1'), { damage: 5 }),
      event('LogPlayerTakeDamage', 12, B('enemy-1'), A('tracked-1'), { damage: 5 }),
      event('LogPlayerTakeDamage', 11, B('enemy-1'), A('third-team', 'team-c'), { damage: 5 }),
      event('LogPlayerAttack', 11, B('enemy-1')),
    ],
  });
  assert.equal(overlap.episodes.length, 2);
  assert.equal(overlap.diagnostics.overlappingEpisodePairCount, 1);
  assert.equal(overlap.diagnostics.ambiguousContextEventCount, 1);
  assert.equal(overlap.diagnostics.duplicateTimelineAssignmentCount, 0);
  assert.equal(
    overlap.episodes.reduce((sum, episode) => sum + episode.timeline.length, 0),
    3,
  );
  assert.equal(
    overlap.episodes.every((episode) => episode.diagnostics.ambiguousContextEvents === 1),
    true,
  );
});

test('V2 groups only overlapping known-team pair episodes and preserves a three-team state timeline', () => {
  const grouped = reconstructBattleMatch({
    match,
    telemetry: [
      event('LogPlayerMakeGroggy', 10, A('tracked-1'), B('enemy-1'), { dBNOId: 'triad-first' }),
      event('LogPlayerMakeGroggy', 11, B('enemy-1'), A('third-player', 'team-c'), {
        dBNOId: 'triad-third',
      }),
      event('LogPlayerMakeGroggy', 12, B('enemy-2'), A('tracked-1'), { dBNOId: 'triad-equalize' }),
      event('LogPlayerMakeGroggy', 13, B('enemy-2'), A('tracked-2'), { dBNOId: 'triad-reverse' }),
      event('LogPlayerTakeDamage', 15, A('tracked-2'), B('enemy-2'), { damage: 10 }),
    ],
    trackedPlayerIds: ['tracked-1', 'tracked-2'],
  });
  assert.equal(grouped.episodes.length, 2);
  assert.equal(grouped.battles.length, 1);
  const battle = grouped.battles[0]!;
  assert.equal(battle.teamRefs.length, 3);
  assert.equal(battle.episodeIds.length, 2);
  assert.equal(battle.bridgeEvidenceEventIds.length, 2);
  assert.equal(battle.possibleThirdParty.length, 1);
  assert.equal(battle.possibleThirdParty[0]?.status, 'possible_third_party_contact');
  assert.equal(battle.firstKnockAdvantage?.durationSeconds, 2);
  assert.equal(battle.firstKnockAdvantage?.resolution, 'equalized');
  assert.equal(battle.postKnockResponse.status, 'observed');
  assert.equal(battle.postKnockResponse.elapsedSeconds, 5);
  assert.equal(
    battle.advantageChanges.some((change) => change.classification === 'reversed'),
    true,
  );
  assert.equal(battle.rosterCompleteness, 'observed-members-only');
  assert.equal(
    battle.stateTimeline.every((item) =>
      item.states.every((state) => state.completeness === 'observed-members-only'),
    ),
    true,
  );
  assert.equal(grouped.diagnostics.multiTeamBattleCount, 1);
});

test('V2 does not merge team-pair episodes based on time proximity without overlap', () => {
  const result = reconstructBattleMatch({
    match,
    telemetry: [
      event('LogPlayerTakeDamage', 10, A('tracked-1'), B('enemy-1'), { damage: 5 }),
      event('LogPlayerTakeDamage', 20, B('enemy-2'), A('third-player', 'team-c'), { damage: 5 }),
    ],
  });
  assert.equal(result.episodes.length, 2);
  assert.equal(result.battles.length, 2);
  assert.equal(
    result.battles.every(
      (battle) => battle.episodeIds.length === 1 && battle.bridgeEvidenceEventIds.length === 0,
    ),
    true,
  );
});

test('semantic duplicate, conflicting team, unknown time and circle normalization are explicit', () => {
  const payload = [
    event('LogPlayerMakeGroggy', 20, A('tracked-1'), B('enemy-1'), { dBNOId: 'duplicate-dbno' }),
    event('LogPlayerMakeGroggy', 20, A('tracked-1'), B('enemy-1'), { dBNOId: 'duplicate-dbno' }),
    event('LogPlayerTakeDamage', null, A('tracked-1', 'team-other'), B('enemy-2'), { damage: 5 }),
    event(
      'LogPlayerTakeDamage',
      22,
      { accountId: 'tracked-1' },
      { accountId: 'unrostered-enemy' },
      { damage: 5 },
    ),
    event('LogPlayerTakeDamage', 23, A('tracked-1'), B('enemy-2'), { damage: 0 }),
    event('LogGameStatePeriodic', 25, A('tracked-1'), undefined, {
      gameState: { elapsedTime: 25, numAlivePlayers: 14, numAliveTeams: 4, safetyZoneRadius: 900 },
    }),
  ];
  const normalized = normalizeBattleTelemetry(payload, match);
  const result = reconstructBattleMatch({ match, telemetry: payload });
  assert.equal(normalized.events[0]?.timestampSource, 'absolute');
  assert.equal(normalized.circleSamples[0]?.timestampSource, 'absolute');
  assert.equal(result.diagnostics.duplicateSourceEventCount, 1);
  assert.equal(result.diagnostics.unassignedContactEventCount, 3);
  assert.equal(result.diagnostics.ineffectiveContactEventCount, 1);
  assert.equal(result.diagnostics.untimedContactEventCount, 1);
  assert.equal(result.diagnostics.conflictingTeamReferenceCount, 1);
  assert.equal(result.diagnostics.unknownTeamContactEventCount, 1);
  assert.equal(result.circleSamples[0]?.aliveTeams, 4);
});

test('timestamps retain absolute, clock, elapsed and unknown provenance', () => {
  const clock = event('LogPlayerAttack', null, A('tracked-1'));
  clock._D = '00:01:02';
  const elapsed = event('LogPlayerTakeDamage', null, A('tracked-1'), B('enemy-1'), {
    damage: 5,
    elapsedTime: 34,
  });
  const unknown = event('LogPlayerMakeGroggy', null, A('tracked-1'), B('enemy-1'), {
    dBNOId: 'no-time',
  });
  const circle = event('LogGameStatePeriodic', null, A('tracked-1'), undefined, {
    gameState: { elapsedTime: 25, numAlivePlayers: 12, numAliveTeams: 3 },
  });
  const telemetry = normalizeBattleTelemetry([clock, elapsed, unknown, circle], match);
  assert.equal(
    telemetry.events.find((item) => item.rawType === 'LogPlayerAttack')?.timestampSource,
    'clock',
  );
  assert.equal(
    telemetry.events.find((item) => item.rawType === 'LogPlayerAttack')?.timeSeconds,
    62,
  );
  assert.equal(
    telemetry.events.find((item) => item.rawType === 'LogPlayerTakeDamage')?.timestampSource,
    'elapsed',
  );
  assert.equal(
    telemetry.events.find((item) => item.rawType === 'LogPlayerTakeDamage')?.timeSeconds,
    34,
  );
  assert.equal(
    telemetry.events.find((item) => item.rawType === 'LogPlayerMakeGroggy')?.timestampSource,
    'unknown',
  );
  assert.equal(
    telemetry.events.find((item) => item.rawType === 'LogPlayerMakeGroggy')?.timeSeconds,
    null,
  );
  assert.equal(telemetry.circleSamples[0]?.timestampSource, 'elapsed');
  assert.equal(telemetry.circleSamples[0]?.timeSeconds, 25);
});

test('numeric safe-zone phases 1+ stay in-match while missing phase and time remain unknown', () => {
  const secondZoneContact = event('LogPlayerMakeGroggy', 40, A('tracked-1'), B('enemy-1'), {
    dBNOId: 'phase-two',
  });
  secondZoneContact.common = { isGame: 2 };
  const laterZoneContact = event('LogPlayerTakeDamage', 45, B('enemy-1'), A('tracked-1'), {
    damage: 10,
  });
  laterZoneContact.common = { isGame: 4.5 };
  const preMatchContact = event('LogPlayerTakeDamage', 50, A('tracked-1'), B('enemy-2'), {
    damage: 10,
  });
  preMatchContact.common = { isGame: 0.5 };
  const unknownContact = event('LogPlayerTakeDamage', null, A('tracked-1'), B('enemy-3'), {
    damage: 10,
  });
  unknownContact.common = {};
  const secondZoneCircle = event('LogGameStatePeriodic', 45, A('tracked-1'), undefined, {
    gameState: { elapsedTime: 45, numAlivePlayers: 20, numAliveTeams: 6, safetyZoneRadius: 500 },
  });
  secondZoneCircle.common = { isGame: 2 };
  const telemetry = normalizeBattleTelemetry(
    [secondZoneContact, laterZoneContact, preMatchContact, unknownContact, secondZoneCircle],
    match,
  );
  const result = reconstructBattleEpisodes({ match, telemetry });
  assert.equal(
    telemetry.events.find((item) => item.rawType === 'LogPlayerMakeGroggy')?.phase,
    'in_match',
  );
  assert.equal(
    telemetry.events.find((item) => item.sourceEventId === 'telemetry-2')?.phase,
    'in_match',
  );
  assert.equal(telemetry.circleSamples[0]?.phase, 'in_match');
  assert.equal(result.episodes.length, 1);
  assert.equal(telemetry.diagnostics.excludedPreMatchEventCount, 1);
  assert.equal(telemetry.diagnostics.excludedPreMatchContactEventCount, 1);
  assert.equal(result.diagnostics.preMatchContactEventCount, 1);
  assert.equal(result.diagnostics.unknownPhaseContactEventCount, 1);
});
