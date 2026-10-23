import assert from 'node:assert/strict';
import test from 'node:test';
import type { MatchReviewFacts, NormalizedMatch } from '@rine-kit/pubg-domain';
import { buildPlayerProfiles, buildProfileInsights, rankInsights } from '../src/index.js';

const start = Date.parse('2026-03-01T00:00:00.000Z');
function match(index: number, ids: string[]): NormalizedMatch {
  return {
    schemaVersion: 3,
    matchId: `p${index}`,
    shard: 'steam',
    createdAt: new Date(start + index * 1000).toISOString(),
    timestamp: start + index * 1000,
    matchType: 'competitive',
    gameMode: 'squad',
    isCompetitive: true,
    mapName: 'Baltic_Main',
    duration: 1200,
    patchVersion: 'fixture',
    players: ids.map((accountId) => ({
      accountId,
      playerName: accountId,
      displayName: accountId,
      rank: 3,
      kills: 1,
      assists: 0,
      damage: 100,
      dbnos: 1,
      revives: 0,
      headshotKills: 0,
      survivalTime: 600,
      longestKill: 0,
      deaths: 1,
      deathSemantics: 'explicit' as const,
    })),
  };
}

function facts(overrides: Partial<MatchReviewFacts>): MatchReviewFacts {
  return { vehicles: [], ...overrides } as MatchReviewFacts;
}

const recovery = (playerId: string, bandages: number) => ({
  id: `r-${playerId}`,
  playerId,
  bandages,
  firstAids: 0,
  medKits: 0,
  adrenaline: 0,
  energyDrinks: 0,
  painkillers: 0,
  otherUses: 0,
  healingAmount: 0,
  evidenceIds: [],
});

test('profiles normalise healing per alive minute and compare with the other members', () => {
  const matches = Array.from({ length: 12 }, (_, index) => match(index, ['a', 'b', 'c']));
  const features = new Map(
    matches.map((item) => [
      item.matchId,
      facts({
        recovery: [recovery('a', 1), recovery('b', 10), recovery('c', 10)],
        armorBreaks: [
          {
            id: 'x',
            actorPlayerId: 'a',
            victimPlayerId: 'z',
            armorItem: null,
            armorSlot: null,
            weapon: null,
            damageReason: null,
            distanceMeters: null,
            attackId: null,
            time: 1,
            followUp: 'KNOCK',
            evidenceIds: [],
          },
          {
            id: 'y',
            actorPlayerId: 'a',
            victimPlayerId: 'z',
            armorItem: null,
            armorSlot: null,
            weapon: null,
            damageReason: null,
            distanceMeters: null,
            attackId: null,
            time: 2,
            followUp: null,
            evidenceIds: [],
          },
        ],
        teamDamage: [
          {
            id: 't',
            actorPlayerId: 'a',
            victimPlayerId: 'b',
            hitCount: 1,
            damage: 40,
            source: 'GRENADE',
            timestamp: 1,
            timestamps: [1],
            weapon: null,
            damageTypeCategory: null,
            evidenceIds: [],
          },
        ],
      } as unknown as Partial<MatchReviewFacts>),
    ]),
  );
  const profiles = buildPlayerProfiles({ matches, memberIds: ['a', 'b', 'c'], facts: features });
  assert.equal(profiles.matches, 12);
  const a = profiles.players.find((player) => player.name === 'a')!;
  assert.equal(a.minutesAlive, 120);
  assert.equal(a.healPerMinute, 12 / 120);
  assert.equal(a.healVsSquad, 0.1);
  assert.equal(a.armorBreaks, 24);
  assert.equal(a.armorBreakConversion.rate, 0.5);
  assert.equal(a.friendlyDamageDealt, 480);
  assert.equal(profiles.players.find((player) => player.name === 'b')!.friendlyDamageTaken, 480);
  const insights = buildProfileInsights(profiles);
  assert.ok(insights.some((item) => item.id.startsWith('heal-') && item.title.includes('a ')));
  assert.ok(insights.some((item) => item.id.startsWith('friendly-')));
  assert.equal(rankInsights(insights)[0]!.tone, 'warn');
});

test('profiles stay quiet without enough matches or telemetry features', () => {
  const matches = Array.from({ length: 4 }, (_, index) => match(index, ['a', 'b']));
  const features = new Map(
    matches.map((item) => [
      item.matchId,
      facts({ recovery: [recovery('a', 0), recovery('b', 9)] }),
    ]),
  );
  const profiles = buildPlayerProfiles({ matches, memberIds: ['a', 'b'], facts: features });
  assert.equal(buildProfileInsights(profiles).length, 0);
  assert.equal(
    buildPlayerProfiles({ matches, memberIds: ['a', 'b'], facts: new Map() }).players.length,
    0,
  );
});
