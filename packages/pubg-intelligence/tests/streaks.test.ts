import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeStreaks, summarizeStreaks, type StreakMatchStats } from '../src/index.js';

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + seconds * 1000).toISOString();
const who = (id: string, team: number) => ({ accountId: id, teamId: team, name: id });
const knock = (
  seconds: number,
  attacker: string,
  attackerTeam: number,
  victim: string,
  victimTeam: number,
) => ({
  _T: 'LogPlayerMakeGroggy',
  _D: at(seconds),
  common: { isGame: 4 },
  attacker: who(attacker, attackerTeam),
  victim: who(victim, victimTeam),
});
const death = (
  seconds: number,
  victim: string,
  victimTeam: number,
  options: { knocker?: [string, number]; killer?: [string, number] } = {},
) => ({
  _T: 'LogPlayerKillV2',
  _D: at(seconds),
  common: { isGame: 4 },
  victim: who(victim, victimTeam),
  dBNOMaker: options.knocker ? who(...options.knocker) : null,
  finisher: options.killer ? who(...options.killer) : null,
  killer: options.killer ? who(...options.killer) : null,
});
const land = (id: string, team: number) => ({
  _T: 'LogParachuteLanding',
  _D: at(0),
  common: { isGame: 0.1 },
  character: who(id, team),
});

test('streaks group takedowns of different enemies within the gap, and a solo wipe of a full team is credited to the knocker', () => {
  const payload = [
    ...['a', 'b', 'c', 'd'].map((id) => land(id, 1)),
    ...['e1', 'e2', 'e3', 'e4'].map((id) => land(id, 2)),
    ...['f1', 'f2'].map((id) => land(id, 3)),
    knock(100, 'a', 1, 'e1', 2),
    knock(110, 'a', 1, 'e2', 2),
    knock(125, 'a', 1, 'e3', 2),
    knock(140, 'a', 1, 'e4', 2),
    ...['e1', 'e2', 'e3', 'e4'].map((id) => death(141, id, 2, { knocker: ['a', 1] })),
    // b knocks f1 then, long after, kills f2 directly: no streak, and the wipe is shared but not one push.
    knock(300, 'b', 1, 'f1', 3),
    death(305, 'f1', 3, { knocker: ['b', 1], killer: ['b', 1] }),
    death(500, 'f2', 3, { killer: ['b', 1] }),
    // Friendly fire is not a takedown.
    knock(600, 'c', 1, 'd', 1),
  ];
  const stats = analyzeStreaks(payload, new Set(['a', 'b', 'c', 'd']));
  assert.equal(stats.players.a!.takedowns, 4);
  assert.equal(stats.players.a!.streaks.fourPlus, 1);
  assert.equal(stats.players.a!.longest, 4);
  assert.equal(stats.players.a!.chainedTakedowns, 4);
  assert.equal(stats.players.b!.takedowns, 2, 'a knock and a direct kill');
  assert.equal(stats.players.b!.longest, 1);
  assert.equal(stats.players.c!.takedowns, 0, 'team kills do not count');
  assert.equal(
    stats.wipes.length,
    1,
    'team 3 fell in two separate pushes, so only team 2 is a wipe',
  );
  assert.deepEqual(
    {
      wiped: stats.wipes[0]!.wiped,
      teamSize: stats.wipes[0]!.teamSize,
      lead: stats.wipes[0]!.lead,
      solo: stats.wipes[0]!.solo,
    },
    { wiped: 4, teamSize: 4, lead: 'a', solo: true },
  );
  assert.equal(stats.players.a!.soloWipes, 1);
  assert.equal(stats.squadWiped, null, 'the squad was not eliminated');
});

test('a wipe needs every member of the final push to be taken down by the squad, and our own elimination is recorded', () => {
  const payload = [
    ...['a', 'b'].map((id) => land(id, 1)),
    ...['e1', 'e2'].map((id) => land(id, 2)),
    knock(100, 'a', 1, 'e1', 2),
    death(101, 'e1', 2, { knocker: ['a', 1] }),
    death(120, 'e2', 2, { killer: ['x', 9] }),
    knock(200, 'z', 5, 'a', 1),
    knock(210, 'z', 5, 'b', 1),
    death(211, 'a', 1, { knocker: ['z', 5] }),
    death(211, 'b', 1, { knocker: ['z', 5] }),
  ];
  const stats = analyzeStreaks(payload, new Set(['a', 'b']));
  assert.equal(stats.wipes.length, 0, 'the last enemy fell to another team');
  assert.deepEqual(stats.squadWiped, { wiped: 2, singleTeam: true, singlePlayer: true });
});

test('the summary counts wipes, solo wipes and multi-kills per ten matches, and stays quiet on small samples', () => {
  const match = (solo: boolean): StreakMatchStats => ({
    players: {
      a: {
        takedowns: 4,
        streaks: { two: 1, three: 0, fourPlus: solo ? 1 : 0 },
        chainedTakedowns: solo ? 6 : 2,
        longest: solo ? 4 : 2,
        wipeTakedowns: solo ? 4 : 1,
        soloWipes: solo ? 1 : 0,
      },
      b: {
        takedowns: 2,
        streaks: { two: 0, three: 0, fourPlus: 0 },
        chainedTakedowns: 0,
        longest: 1,
        wipeTakedowns: solo ? 0 : 1,
        soloWipes: 0,
      },
    },
    wipes: [
      solo
        ? {
            wiped: 4,
            teamSize: 4,
            lead: 'a',
            leadCount: 4,
            solo: true,
            phase: 6,
            durationSeconds: 40,
          }
        : {
            wiped: 2,
            teamSize: 4,
            lead: 'a',
            leadCount: 1,
            solo: false,
            phase: 2,
            durationSeconds: 20,
          },
    ],
    squadWiped: { wiped: 2, singleTeam: true, singlePlayer: false },
  });
  const names = new Map([
    ['a', 'A'],
    ['b', 'B'],
  ]);
  const summary = summarizeStreaks(
    Array.from({ length: 12 }, (_, index) => match(index % 2 === 0)),
    names,
  );
  assert.equal(summary.wipes.total, 12);
  assert.equal(summary.wipes.solo, 6);
  assert.equal(summary.wipes.fullTeam, 6);
  assert.deepEqual(
    summary.wipes.byStage.map((entry) => entry.count),
    [6, 0, 6],
  );
  assert.equal(summary.players[0]!.name, 'A');
  assert.equal(summary.players[0]!.multiPerTen, 15);
  assert.ok(
    summary.highlights.some((line) => line.includes('单人灭队') && line.includes('A 6 次')),
  );
  assert.ok(summary.highlights.some((line) => line.includes('最长连杀：A')));
  assert.ok(summary.highlights.some((line) => line.includes('同一支队伍')));
  assert.equal(summarizeStreaks([match(true)], names).highlights.length, 0);
});
