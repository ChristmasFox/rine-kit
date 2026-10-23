import type { NormalizedMatch } from '@rine-kit/pubg-domain';
import type { BenchmarkSplit } from './evaluation.js';

export interface TacticalBenchmarkFixtureCase {
  caseId: string;
  split: BenchmarkSplit;
  stratum: string;
  expectedFirstKnockBySquad: boolean | null;
  match: NormalizedMatch;
  trackedPlayerIds: string[];
  telemetryPayload: unknown[];
}

type Actor = { accountId: string; teamId?: string };

const trackedOne: Actor = { accountId: 'squad-member-a', teamId: 'squad-team' };
const trackedTwo: Actor = { accountId: 'squad-member-b', teamId: 'squad-team' };
const opponentOne: Actor = { accountId: 'opponent-member-a', teamId: 'opponent-team' };
const opponentTwo: Actor = { accountId: 'opponent-member-b', teamId: 'opponent-team' };

function knock(
  seconds: number | null,
  attacker: Actor,
  victim: Actor,
  dbnoId: string,
): Record<string, unknown> {
  return {
    _T: 'LogPlayerMakeGroggy',
    ...(seconds === null
      ? {}
      : { _D: new Date(Date.parse('2026-10-01T12:00:00.000Z') + seconds * 1000).toISOString() }),
    common: { isGame: true },
    attacker,
    victim,
    dBNOId: dbnoId,
  };
}

function damage(seconds: number, attacker: Actor, victim: Actor): Record<string, unknown> {
  return {
    _T: 'LogPlayerTakeDamage',
    _D: new Date(Date.parse('2026-10-01T12:00:00.000Z') + seconds * 1000).toISOString(),
    common: { isGame: true },
    attacker,
    victim,
    damage: 20,
  };
}

function fixtureCase(input: {
  caseId: string;
  split: BenchmarkSplit;
  stratum: string;
  expected: boolean | null;
  events: unknown[];
}): TacticalBenchmarkFixtureCase {
  const timestamp = Date.parse('2026-10-01T12:00:00.000Z');
  const player = (accountId: string, displayName: string) => ({
    accountId,
    playerName: displayName,
    displayName,
    rank: 8,
    kills: 1,
    assists: 0,
    damage: 80,
    dbnos: 1,
    revives: 0,
    headshotKills: 0,
    survivalTime: 800,
    longestKill: 0,
    deaths: 1,
    deathSemantics: 'explicit' as const,
  });
  const match: NormalizedMatch = {
    schemaVersion: 3,
    matchId: input.caseId,
    shard: 'fixture',
    createdAt: new Date(timestamp).toISOString(),
    timestamp,
    matchType: 'competitive',
    gameMode: 'squad-fpp',
    isCompetitive: true,
    mapName: 'Sanitized Training Range',
    duration: 900,
    patchVersion: 'fixture',
    players: [player(trackedOne.accountId, 'SQUAD_A'), player(trackedTwo.accountId, 'SQUAD_B')],
  };
  return {
    caseId: input.caseId,
    split: input.split,
    stratum: input.stratum,
    expectedFirstKnockBySquad: input.expected,
    match,
    trackedPlayerIds: [trackedOne.accountId, trackedTwo.accountId],
    telemetryPayload: input.events,
  };
}

/** Synthetic identities and telemetry; holdout is split by whole match case. */
export function createTacticalBenchmarkFixtures(): TacticalBenchmarkFixtureCase[] {
  return [
    fixtureCase({
      caseId: 'r4-dev-positive-01',
      split: 'development',
      stratum: 'clear-squad-first-knock',
      expected: true,
      events: [
        knock(5, trackedOne, opponentOne, 'fixture-dbno-01'),
        damage(8, trackedTwo, opponentOne),
      ],
    }),
    fixtureCase({
      caseId: 'r4-dev-negative-01',
      split: 'development',
      stratum: 'opponent-first-then-squad-knock',
      expected: false,
      events: [
        knock(5, opponentOne, trackedOne, 'fixture-dbno-02'),
        knock(11, trackedOne, opponentOne, 'fixture-dbno-03'),
      ],
    }),
    fixtureCase({
      caseId: 'r4-dev-unresolved-01',
      split: 'development',
      stratum: 'no-knock-opportunity',
      expected: null,
      events: [damage(5, trackedOne, opponentOne)],
    }),
    fixtureCase({
      caseId: 'r4-holdout-positive-01',
      split: 'holdout',
      stratum: 'clear-squad-first-knock',
      expected: true,
      events: [knock(7, trackedTwo, opponentTwo, 'fixture-dbno-04')],
    }),
    fixtureCase({
      caseId: 'r4-holdout-negative-01',
      split: 'holdout',
      stratum: 'opponent-first-then-squad-knock',
      expected: false,
      events: [
        knock(4, opponentTwo, trackedTwo, 'fixture-dbno-05'),
        knock(9, trackedOne, opponentTwo, 'fixture-dbno-06'),
      ],
    }),
    fixtureCase({
      caseId: 'r4-holdout-negative-02',
      split: 'holdout',
      stratum: 'opponent-only-knock',
      expected: false,
      events: [knock(10, opponentOne, trackedOne, 'fixture-dbno-07')],
    }),
    fixtureCase({
      caseId: 'r4-holdout-unresolved-01',
      split: 'holdout',
      stratum: 'unknown-timestamp',
      expected: null,
      events: [
        knock(null, trackedOne, opponentOne, 'fixture-dbno-08'),
        knock(13, opponentTwo, trackedTwo, 'fixture-dbno-09'),
      ],
    }),
    fixtureCase({
      caseId: 'r4-holdout-unresolved-02',
      split: 'holdout',
      stratum: 'missing-team-attribution',
      expected: null,
      events: [
        knock(
          12,
          { accountId: trackedOne.accountId },
          { accountId: 'opponent-member-unknown' },
          'fixture-dbno-10',
        ),
      ],
    }),
  ];
}
