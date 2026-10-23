import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedMatch } from '@rine-kit/pubg-domain';
import {
  analyzeTacticalMatch,
  buildFrequentPairCandidates,
  normalizeBattleTelemetry,
  reconstructBattleEpisodes,
  TACTICAL_ISOLATION_DISTANCE_UNITS,
  TACTICAL_PAIR_MIN_SHARED_MATCHES,
  type TacticalMatchAnalysis,
} from '../src/index.js';

const start = Date.parse('2026-04-12T00:00:00.000Z');
const trackedPlayerIds = ['tracked-1', 'tracked-2'];
const match: NormalizedMatch = {
  schemaVersion: 3,
  matchId: 'sanitized-r2-fixture',
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
): Record<string, unknown> {
  const raw: Record<string, unknown> = { _T: type, common: { isGame: true }, ...extra };
  if (seconds !== null) raw._D = new Date(start + seconds * 1000).toISOString();
  if (type.includes('Revive')) raw.reviver = actor;
  else if (type.includes('Kill')) raw.killer = actor;
  else if (type.includes('Position')) raw.character = actor;
  else raw.attacker = actor;
  if (victim) raw.victim = victim;
  return raw;
}

const A = (accountId: string, teamId = 'team-a'): Actor => ({ accountId, teamId });
const B = (accountId: string, teamId = 'team-b'): Actor => ({ accountId, teamId });

function circle(seconds: number, radius: number) {
  return event('LogGameStatePeriodic', seconds, A('tracked-1'), undefined, {
    gameState: {
      elapsedTime: seconds,
      numAlivePlayers: 30,
      numAliveTeams: 9,
      safetyZonePosition: { x: 1000, y: 1000, z: 0 },
      safetyZoneRadius: radius,
      poisonGasWarningPosition: { x: 1100, y: 1100, z: 0 },
      poisonGasWarningRadius: radius + 500,
    },
  });
}

function fixtureEvents() {
  const blueDamage = event('LogPlayerTakeDamage', 70, A('zone-source', 'zone'), A('tracked-2'), {
    damage: 12,
    damageReason: 'Damage_BlueZone',
  });
  blueDamage.character = { accountId: 'tracked-2', teamId: 'team-a', isInBlueZone: true };
  return [
    event('LogPlayerPosition', 0, { ...A('tracked-1'), location: { x: 0, y: 0, z: 0 } }),
    event('LogPlayerPosition', 0, { ...A('tracked-2'), location: { x: 2000, y: 0, z: 0 } }),
    event('LogGameStatePeriodic', 0, A('tracked-1'), undefined, {
      gameState: {
        elapsedTime: 0,
        numAlivePlayers: 50,
        numAliveTeams: 15,
        safetyZonePosition: { x: 5000, y: 5000, z: 0 },
        safetyZoneRadius: 3000,
        poisonGasWarningPosition: { x: 5000, y: 5000, z: 0 },
        poisonGasWarningRadius: 4000,
      },
    }),
    event('LogPlayerTakeDamage', 5, A('tracked-1'), B('enemy-1'), { damage: 20 }),
    event('LogPlayerMakeGroggy', 8, A('tracked-1'), B('enemy-1'), { dBNOId: 'enemy-down-1' }),
    event('LogPlayerTakeDamage', 13, A('tracked-2'), B('enemy-1'), { damage: 10 }),
    event('LogPlayerKill', 18, A('tracked-2'), B('enemy-1'), { dBNOId: 'enemy-down-1' }),
    event('LogPlayerMakeGroggy', 30, B('enemy-2'), A('tracked-1'), { dBNOId: 'tracked-down-1' }),
    event('LogPlayerTakeDamage', 35, A('tracked-2'), B('enemy-2'), { damage: 8 }),
    event('LogPlayerRevive', 40, A('tracked-2'), A('tracked-1')),
    event('LogPlayerTakeDamage', 50, A('tracked-1'), A('tracked-2'), { damage: 5 }),
    event('LogPlayerMakeGroggy', 55, B('enemy-2'), A('tracked-2'), { dBNOId: 'tracked-down-2' }),
    event('LogPlayerRevive', 60, A('tracked-1'), A('tracked-2')),
    blueDamage,
    event('LogGameStatePeriodic', 45, A('tracked-1'), undefined, {
      gameState: {
        elapsedTime: 45,
        numAlivePlayers: 30,
        numAliveTeams: 9,
        safetyZonePosition: { x: 5000, y: 5000, z: 0 },
        safetyZoneRadius: 2500,
        poisonGasWarningPosition: { x: 5000, y: 5000, z: 0 },
        poisonGasWarningRadius: 3500,
      },
    }),
    event('LogPlayerPosition', 15, { ...A('tracked-1'), location: { x: 100, y: 0, z: 0 } }),
    event('LogPlayerPosition', 15, { ...A('tracked-2'), location: { x: 2100, y: 0, z: 0 } }),
    event('LogPlayerPosition', 30, { ...A('tracked-1'), location: { x: 200, y: 0, z: 0 } }),
    event('LogPlayerPosition', 30, { ...A('tracked-2'), location: { x: 2200, y: 0, z: 0 } }),
    event('LogPlayerPosition', 90, { ...A('tracked-1'), location: { x: 0, y: 0, z: 0 } }),
    event('LogPlayerPosition', 90, { ...A('tracked-2'), location: { x: 2500, y: 0, z: 0 } }),
    event('LogPlayerTakeDamage', 100, B('enemy-3'), A('tracked-1'), { damage: 9 }),
    event('LogPlayerMakeGroggy', 101, B('enemy-3'), A('tracked-1'), { dBNOId: 'tracked-down-3' }),
  ];
}

function analyze(events: unknown[], target: NormalizedMatch = match): TacticalMatchAnalysis {
  const telemetry = normalizeBattleTelemetry(events, target);
  const reconstruction = reconstructBattleEpisodes({ match: target, telemetry, trackedPlayerIds });
  return analyzeTacticalMatch({ match: target, telemetry, reconstruction, trackedPlayerIds });
}

function candidate(analysis: TacticalMatchAnalysis, ruleId: string) {
  const found = analysis.candidates.find((item) => item.ruleId === ruleId);
  assert.ok(found, `expected candidate ${ruleId}`);
  return found;
}

test('R2 fixed fixture is deterministic, sanitized, cited and reports every rule with explicit denominator', () => {
  const payload = fixtureEvents();
  const first = analyze(payload);
  const second = analyze(payload);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.ruleVersion, 'tactical-social-rules-v2');

  const requiredRules = [
    'combat.first-knock-share',
    'combat.follow-up-hit-window',
    'combat.knock-kill-conversion',
    'combat.first-knock-observed-advantage-duration',
    'combat.observed-knock-advantage-reversal',
    'combat.subsequent-contact-after-first-knock',
    'combat.possible-third-party-contact',
    'coordination.sampled-teammate-distance',
    'coordination.combat-onset-separation',
    'coordination.sampled-isolation-candidate',
    'coordination.response-after-ally-knock',
    'social.directed-friendly-damage',
    'social.directed-rescue',
    'social.shared-engagement-pair',
    'social.friendly-fire-followed-by-rescue',
    'rotation.engagement-near-circle-transition',
    'rotation.sampled-movement',
    'rotation.explicit-blue-zone-damage',
  ];
  for (const ruleId of requiredRules) {
    const rows = first.candidates.filter((item) => item.ruleId === ruleId);
    assert.ok(rows.length, `missing rule ${ruleId}`);
    for (const row of rows) {
      assert.equal(row.ruleVersion, first.ruleVersion);
      assert.equal(typeof row.metric.sampleSize, 'number');
      assert.equal(typeof row.metric.unit, 'string');
      for (const refs of [row.supportEvents, row.counterexamples]) {
        assert.equal(
          new Set(refs.map((ref) => `${ref.matchId}:${ref.eventId ?? ''}:${ref.kind}`)).size,
          refs.length,
        );
        assert.ok(refs.every((ref) => ref.matchId === match.matchId));
      }
    }
  }

  assert.equal(candidate(first, 'combat.follow-up-hit-window').metric.numerator, 1);
  assert.equal(candidate(first, 'combat.knock-kill-conversion').metric.numerator, 1);
  assert.equal(
    candidate(first, 'combat.first-knock-observed-advantage-duration').status,
    'incomplete',
  );
  assert.match(
    candidate(first, 'combat.first-knock-observed-advantage-duration').quality.reasons.join(' '),
    /敌队完整名单/u,
  );
  assert.equal(candidate(first, 'combat.subsequent-contact-after-first-knock').metric.numerator, 1);
  assert.ok(
    (candidate(first, 'combat.possible-third-party-contact').metric.numerator ?? 0) <=
      (candidate(first, 'combat.possible-third-party-contact').metric.denominator ?? 0),
  );
  assert.equal(
    candidate(first, 'coordination.sampled-teammate-distance').metric.sampleSize > 0,
    true,
  );
  assert.equal(candidate(first, 'coordination.sampled-isolation-candidate').metric.numerator, 1);
  assert.equal(candidate(first, 'coordination.response-after-ally-knock').metric.numerator, 1);
  assert.equal(candidate(first, 'social.directed-friendly-damage').metric.numerator, 1);
  assert.equal(candidate(first, 'social.directed-rescue').metric.numerator, 2);
  assert.equal(candidate(first, 'social.friendly-fire-followed-by-rescue').metric.numerator, 1);
  assert.equal(candidate(first, 'rotation.explicit-blue-zone-damage').metric.numerator, 1);
  const directedFriendlyEvent = candidate(first, 'social.directed-friendly-damage')
    .supportEvents[0];
  assert.ok(directedFriendlyEvent?.actorRef && directedFriendlyEvent.victimRef);
  assert.notEqual(directedFriendlyEvent.actorRef, directedFriendlyEvent.victimRef);
  assert.ok(candidate(first, 'combat.first-knock-share').supportEvents[0]?.eventId);
  assert.ok(Array.isArray(candidate(first, 'combat.first-knock-share').counterexamples));
  assert.doesNotMatch(JSON.stringify(first), /tracked-1|tracked-2|enemy-1|team-a|team-b/u);
});

test('empty and incomplete telemetry fixtures keep unknown distinct from zero for every R2 metric', () => {
  const empty = analyze([]);
  const partialPayload = [
    event('LogPlayerPosition', 0, { accountId: 'tracked-1', location: { x: 10, y: 10, z: 0 } }),
    event('LogPlayerMakeGroggy', null, A('tracked-1'), B('enemy-unknown'), {
      dBNOId: 'unknown-clock',
    }),
    event(
      'LogPlayerTakeDamage',
      20,
      { accountId: 'tracked-1' },
      { accountId: 'enemy-unknown' },
      { damage: 4 },
    ),
  ];
  const incomplete = analyze(partialPayload);
  const expectedRules = [
    'combat.first-knock-share',
    'combat.follow-up-hit-window',
    'combat.knock-kill-conversion',
    'combat.first-knock-observed-advantage-duration',
    'combat.observed-knock-advantage-reversal',
    'combat.subsequent-contact-after-first-knock',
    'combat.possible-third-party-contact',
    'coordination.sampled-teammate-distance',
    'coordination.combat-onset-separation',
    'coordination.sampled-isolation-candidate',
    'coordination.response-after-ally-knock',
    'social.directed-friendly-damage',
    'social.directed-rescue',
    'social.shared-engagement-pair',
    'social.friendly-fire-followed-by-rescue',
    'rotation.engagement-near-circle-transition',
    'rotation.sampled-movement',
    'rotation.explicit-blue-zone-damage',
  ];
  for (const ruleId of expectedRules) {
    assert.ok(
      empty.candidates.some((item) => item.ruleId === ruleId),
      `empty fixture missing ${ruleId}`,
    );
    assert.ok(
      incomplete.candidates.some((item) => item.ruleId === ruleId),
      `incomplete fixture missing ${ruleId}`,
    );
    const row = incomplete.candidates.find((item) => item.ruleId === ruleId)!;
    assert.ok(row.quality.reasons.length > 0);
    assert.equal(Number.isInteger(row.metric.sampleSize), true);
  }
  assert.equal(candidate(empty, 'rotation.explicit-blue-zone-damage').metric.denominator, null);
  assert.equal(candidate(empty, 'coordination.sampled-teammate-distance').metric.denominator, null);
  assert.equal(
    candidate(incomplete, 'coordination.sampled-teammate-distance').status,
    'incomplete',
  );
  assert.equal(
    candidate(incomplete, 'rotation.explicit-blue-zone-damage').metric.denominator,
    null,
  );
  assert.ok(incomplete.diagnostics.incompleteTeamEventCount > 0);
  assert.ok(incomplete.diagnostics.unknownTimestampEventCount > 0);
});

test('follow-up and response windows include exactly 30 seconds and exclude 31 seconds', () => {
  const followUpAtBoundary = analyze([
    event('LogPlayerMakeGroggy', 5, A('tracked-1'), B('enemy-1'), { dBNOId: 'follow-boundary' }),
    event('LogPlayerTakeDamage', 35, A('tracked-2'), B('enemy-1'), { damage: 4 }),
  ]);
  const followUpAfterBoundary = analyze([
    event('LogPlayerMakeGroggy', 5, A('tracked-1'), B('enemy-1'), { dBNOId: 'follow-after' }),
    event('LogPlayerTakeDamage', 36, A('tracked-2'), B('enemy-1'), { damage: 4 }),
  ]);
  assert.equal(candidate(followUpAtBoundary, 'combat.follow-up-hit-window').metric.numerator, 1);
  assert.equal(candidate(followUpAfterBoundary, 'combat.follow-up-hit-window').metric.numerator, 0);

  const responseAtBoundary = analyze([
    event('LogPlayerMakeGroggy', 5, B('enemy-1'), A('tracked-1'), { dBNOId: 'response-boundary' }),
    event('LogPlayerTakeDamage', 35, A('tracked-2'), B('enemy-1'), { damage: 4 }),
  ]);
  const responseAfterBoundary = analyze([
    event('LogPlayerMakeGroggy', 5, B('enemy-1'), A('tracked-1'), { dBNOId: 'response-after' }),
    event('LogPlayerTakeDamage', 36, A('tracked-2'), B('enemy-1'), { damage: 4 }),
  ]);
  assert.equal(
    candidate(responseAtBoundary, 'coordination.response-after-ally-knock').metric.numerator,
    1,
  );
  assert.equal(
    candidate(responseAfterBoundary, 'coordination.response-after-ally-knock').metric.numerator,
    0,
  );
});

test('isolation threshold is explicit and strict; same sampled bucket is required', () => {
  const makeIsolationFixture = (distance: number) =>
    analyze([
      event('LogPlayerPosition', 0, { ...A('tracked-1'), location: { x: 0, y: 0, z: 0 } }),
      event('LogPlayerPosition', 0, { ...A('tracked-2'), location: { x: distance, y: 0, z: 0 } }),
      event('LogPlayerTakeDamage', 5, B('enemy-1'), A('tracked-1'), { damage: 4 }),
    ]);
  assert.equal(TACTICAL_ISOLATION_DISTANCE_UNITS, 1000);
  assert.equal(
    candidate(makeIsolationFixture(1000), 'coordination.sampled-isolation-candidate').metric
      .numerator,
    0,
  );
  assert.equal(
    candidate(makeIsolationFixture(1001), 'coordination.sampled-isolation-candidate').metric
      .numerator,
    1,
  );
});

test('recurrent pair candidate aggregates distinct matches and requires three supported matches', () => {
  const base = analyze(fixtureEvents());
  const duplicateForMatch = (
    source: TacticalMatchAnalysis,
    matchId: string,
  ): TacticalMatchAnalysis => ({
    ...source,
    matchId,
    pairObservations: source.pairObservations.map((observation) => ({
      ...observation,
      matchId,
      supportEvents: observation.supportEvents.map((ref) => ({ ...ref, matchId })),
      counterexamples: observation.counterexamples.map((ref) => ({ ...ref, matchId })),
    })),
  });
  const twoMatches = buildFrequentPairCandidates([
    base,
    duplicateForMatch(base, 'fixture-match-2'),
  ]);
  const threeMatches = buildFrequentPairCandidates([
    base,
    duplicateForMatch(base, 'fixture-match-2'),
    duplicateForMatch(base, 'fixture-match-3'),
  ]);
  assert.ok(twoMatches.every((item) => item.status === 'insufficient_data'));
  assert.equal(
    threeMatches.every((item) => item.metric.numerator === TACTICAL_PAIR_MIN_SHARED_MATCHES),
    true,
  );
  assert.ok(threeMatches.every((item) => item.status === 'observed'));
  assert.ok(
    threeMatches.every((item) =>
      item.supportEvents.some((ref) => ref.matchId === 'fixture-match-3' && ref.eventId),
    ),
  );
  assert.ok(threeMatches.every((item) => item.counterexamples.length > 0));
});

test('circle-window samples use transition event citations and do not invent movement or blue-zone facts', () => {
  const output = analyze([
    circle(0, 3000),
    ...fixtureEvents().filter(
      (item) => !(item as { _T?: string })._T?.includes('GameStatePeriodic'),
    ),
    circle(45, 2500),
  ]);
  const circleCandidate = candidate(output, 'rotation.engagement-near-circle-transition');
  assert.ok(
    circleCandidate.supportEvents.some((ref) => ref.kind === 'circle-window-before' && ref.eventId),
  );
  assert.ok(
    circleCandidate.supportEvents.some((ref) => ref.kind === 'circle-window-after' && ref.eventId),
  );
  const blue = candidate(output, 'rotation.explicit-blue-zone-damage');
  assert.ok(blue.supportEvents.every((ref) => ref.eventId));
  assert.ok(candidate(output, 'rotation.sampled-movement').metric.sampleSize > 0);
});
