import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedMatch } from '@rine-kit/pubg-domain';
import {
  analyzeLobby,
  buildLongRunCombat,
  summarizeLobby,
  type LobbyMatchStats,
} from '../src/index.js';

const start = Date.parse('2026-03-01T00:00:00.000Z');
const day = (seconds: number) => new Date(start + seconds * 1000).toISOString();

function match(
  index: number,
  players: Record<string, { damage: number; kills: number; knocks: number; assists?: number }>,
): NormalizedMatch {
  return {
    schemaVersion: 3,
    matchId: `lr${index}`,
    shard: 'steam',
    createdAt: day(index),
    timestamp: start + index * 1000,
    matchType: 'competitive',
    gameMode: 'squad',
    isCompetitive: true,
    mapName: 'Baltic_Main',
    duration: 1200,
    patchVersion: 'fixture',
    players: Object.entries(players).map(([accountId, value]) => ({
      accountId,
      playerName: accountId,
      displayName: accountId,
      rank: 5,
      kills: value.kills,
      assists: value.assists ?? 0,
      damage: value.damage,
      dbnos: value.knocks,
      revives: 0,
      headshotKills: 0,
      survivalTime: 900,
      longestKill: 0,
      deaths: 1,
      deathSemantics: 'explicit' as const,
    })),
  };
}

test('long-run combat compares each member with a fair split of every match', () => {
  const matches = Array.from({ length: 40 }, (_, index) =>
    match(index, {
      ace: { damage: 300 + (index % 3) * 20, kills: 2, knocks: 3 },
      b: { damage: 100, kills: 1, knocks: 1 },
      c: { damage: 100, kills: 1, knocks: 1 },
      d: { damage: 100, kills: 1, knocks: 1 },
    }),
  );
  const result = buildLongRunCombat({ matches, memberIds: ['ace', 'b', 'c', 'd'] });
  assert.equal(result.entries[0]!.accountId, 'ace');
  assert.equal(result.entries[0]!.rank, 1);
  assert.equal(result.entries[0]!.composite.tier, 'stable');
  assert.ok(result.entries[0]!.composite.ratio! > 1.4 && result.entries[0]!.composite.low! > 1);
  const damage = result.entries[0]!.metrics.find((metric) => metric.key === 'damage')!;
  // ace deals 300-340 of a 600-640 total, i.e. roughly twice the fair quarter of 150-160
  assert.ok(damage.ratio! > 1.9 && damage.ratio! < 2.2, `damage ratio ${damage.ratio}`);
  assert.ok(result.entries.slice(1).every((entry) => entry.composite.ratio! < 1));
  assert.ok(result.verdict.includes('ace'));
});

test('long-run combat says nobody stands out when shares are fair, and refuses tiny samples', () => {
  const fair = Array.from({ length: 40 }, (_, index) =>
    match(
      index,
      Object.fromEntries(
        ['a', 'b', 'c'].map((id) => [
          id,
          { damage: 100 + ((index + id.charCodeAt(0)) % 3) * 5, kills: 1, knocks: 1 },
        ]),
      ),
    ),
  );
  const flat = buildLongRunCombat({ matches: fair, memberIds: ['a', 'b', 'c'] });
  assert.ok(flat.verdict.includes('没有人稳定地多拿'));
  assert.ok(flat.entries.every((entry) => entry.composite.tier === 'even'));
  const tiny = buildLongRunCombat({ matches: fair.slice(0, 5), memberIds: ['a', 'b', 'c'] });
  assert.ok(tiny.verdict.includes('不足'));
  assert.ok(tiny.entries.every((entry) => entry.composite.low === null));
  const solo = buildLongRunCombat({
    matches: [match(1, { a: { damage: 100, kills: 1, knocks: 1 } })],
    memberIds: ['a'],
  });
  assert.equal(solo.entries.length, 0, 'a match with one member cannot be split');
});

function lobbyPayload(): unknown[] {
  const events: unknown[] = [];
  const who = (index: number, extra: Record<string, unknown> = {}) => ({
    accountId: `p${index}`,
    teamId: index + 1,
    type: 'user',
    location: { x: 0, y: 0, z: 0 },
    ...extra,
  });
  for (let index = 0; index < 12; index += 1)
    events.push({
      _T: 'LogParachuteLanding',
      _D: day(0),
      common: { isGame: 0.1 },
      character: who(index),
    });
  for (let index = 0; index < 12; index += 1)
    events.push({
      _T: 'LogPlayerPosition',
      _D: day(index === 0 ? 30 : 600),
      elapsedTime: 600,
      common: { isGame: 3 },
      character: who(index),
    });
  events.push({
    _T: 'LogPlayerKillV2',
    _D: day(60),
    common: { isGame: 2 },
    killer: who(5),
    victim: who(0),
  });
  for (let index = 1; index < 12; index += 1) {
    events.push({
      _T: 'LogPlayerTakeDamage',
      _D: day(100 + index),
      common: { isGame: 2 },
      damage: 100 * index,
      damageTypeCategory: 'Damage_Gun',
      attacker: who(index),
      victim: { accountId: 'x', teamId: 99 },
    });
    for (let knock = 0; knock < index; knock += 1)
      events.push({
        _T: 'LogPlayerMakeGroggy',
        _D: day(200 + index),
        common: { isGame: 2 },
        attacker: who(index),
        victim: { accountId: 'x', teamId: 99 },
      });
  }
  // damage to a teammate and damage before the match started must not count
  events.push({
    _T: 'LogPlayerTakeDamage',
    _D: day(150),
    common: { isGame: 2 },
    damage: 9999,
    damageTypeCategory: 'Damage_Gun',
    attacker: who(1),
    victim: who(1, { accountId: 'mate' }),
  });
  events.push({
    _T: 'LogPlayerTakeDamage',
    _D: day(5),
    common: { isGame: 0.2 },
    damage: 9999,
    damageTypeCategory: 'Damage_Gun',
    attacker: who(1),
    victim: { accountId: 'x', teamId: 99 },
  });
  return events;
}

test('lobby analysis places each tracked player among every eligible player in the match', () => {
  const stats = analyzeLobby(lobbyPayload(), new Set(['p11', 'p1', 'p0']));
  assert.equal(
    stats.p0!.damagePercentile,
    null,
    'a player who died within two minutes is not part of the lobby',
  );
  assert.equal(stats.p11!.lobbySize, 11);
  assert.ok(Math.abs(stats.p11!.damagePercentile! - 10.5 / 11) < 1e-9);
  assert.ok(Math.abs(stats.p1!.damagePercentile! - 0.5 / 11) < 1e-9);
  assert.ok(
    Math.abs(stats.p11!.damagePerMinute - 110) < 1e-6,
    'damage per minute alive: 1100 over 10 minutes',
  );
  assert.ok(stats.p11!.knockPercentile! > stats.p1!.knockPercentile!);
});

test('lobby summary grades members against the lobby median and names a separated leader', () => {
  const row = (damage: number, knock: number): LobbyMatchStats => ({
    aliveMinutes: 15,
    damagePerMinute: 20 * damage,
    knocksPerMinute: 0.1,
    damagePercentile: damage,
    knockPercentile: knock,
    lobbySize: 90,
  });
  const items = Array.from({ length: 30 }, (_, index) => ({
    hi: row(0.9 + (index % 3) * 0.01, 0.85),
    lo: row(0.2 + (index % 3) * 0.01, 0.25),
  }));
  const summary = summarizeLobby(
    items,
    new Map([
      ['hi', 'Hi'],
      ['lo', 'Lo'],
    ]),
  );
  assert.equal(summary.entries[0]!.accountId, 'hi');
  assert.equal(summary.entries[0]!.tier, 'above');
  assert.equal(summary.entries[1]!.tier, 'below');
  assert.ok(summary.verdict.includes('Hi') && summary.verdict.includes('不重叠'));
  const mid = summarizeLobby(
    Array.from({ length: 30 }, (_, index) => ({
      a: row(0.5 + (index % 2) * 0.02, 0.5),
      b: row(0.5, 0.5 + (index % 2) * 0.02),
    })),
    new Map([
      ['a', 'A'],
      ['b', 'B'],
    ]),
  );
  assert.ok(mid.entries.every((entry) => entry.tier === 'even'));
  assert.ok(mid.verdict.includes('不能断定'));
  const few = summarizeLobby(
    items.slice(0, 5),
    new Map([
      ['hi', 'Hi'],
      ['lo', 'Lo'],
    ]),
  );
  assert.ok(few.verdict.includes('不足'));
});
