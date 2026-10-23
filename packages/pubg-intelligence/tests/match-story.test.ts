import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeMatchStory } from '../src/index.js';

const start = Date.UTC(2026, 9, 1, 12, 0, 0);
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const who = (id: string, team: number, extra: Record<string, unknown> = {}) => ({
  accountId: id,
  teamId: team,
  name: id.toUpperCase(),
  ...extra,
});
const loc = (x: number, y: number) => ({ x: x * 100, y: y * 100, z: 0 });

test('a match becomes lifelines, fights, route, circle and a squad-out time', () => {
  const payload = [
    { _T: 'LogMatchStart', _D: at(0), mapName: 'Baltic_Main', common: { isGame: 0.1 } },
    {
      _T: 'LogGameStatePeriodic',
      _D: at(60),
      common: { isGame: 1 },
      gameState: {
        elapsedTime: 60,
        numStartTeams: 20,
        numAliveTeams: 18,
        numStartPlayers: 80,
        numAlivePlayers: 70,
        safetyZonePosition: loc(4000, 4000),
        safetyZoneRadius: 300000,
        poisonGasWarningPosition: loc(4000, 4000),
        poisonGasWarningRadius: 200000,
      },
    },
    {
      _T: 'LogGameStatePeriodic',
      _D: at(270),
      common: { isGame: 3.5 },
      gameState: {
        elapsedTime: 270,
        numStartTeams: 20,
        numAliveTeams: 9,
        numStartPlayers: 80,
        numAlivePlayers: 33,
      },
    },
    {
      _T: 'LogParachuteLanding',
      _D: at(20),
      common: { isGame: 0.1 },
      character: who('a', 1, { location: loc(1000, 1000) }),
    },
    {
      _T: 'LogParachuteLanding',
      _D: at(22),
      common: { isGame: 0.1 },
      character: who('b', 1, { location: loc(1100, 1000) }),
    },
    {
      _T: 'LogPlayerPosition',
      _D: at(5),
      elapsedTime: 5,
      common: { isGame: 0.1 },
      character: who('a', 1, { location: loc(7000, 7000) }),
    },
    {
      _T: 'LogPlayerPosition',
      _D: at(40),
      elapsedTime: 40,
      common: { isGame: 0.5 },
      character: who('a', 1, { location: loc(1200, 1100) }),
    },
    {
      _T: 'LogPlayerPosition',
      _D: at(44),
      elapsedTime: 44,
      common: { isGame: 0.5 },
      character: who('a', 1, { location: loc(1210, 1100) }),
    },
    {
      _T: 'LogPlayerPosition',
      _D: at(52),
      elapsedTime: 52,
      common: { isGame: 0.5 },
      character: who('a', 1, { location: loc(1300, 1200), isInVehicle: true }),
    },
    {
      _T: 'LogParachuteLanding',
      _D: at(60),
      common: { isGame: 0.1 },
      character: who('e1', 2, { location: loc(6000, 5000) }),
    },
    {
      _T: 'LogPlayerPosition',
      _D: at(30),
      elapsedTime: 30,
      common: { isGame: 0.1 },
      character: who('e1', 2, { location: loc(1, 1), type: 'user' }),
    },
    {
      _T: 'LogPlayerPosition',
      _D: at(100),
      elapsedTime: 100,
      common: { isGame: 1 },
      character: who('e1', 2, { location: loc(6000, 5000), type: 'user' }),
    },
    {
      _T: 'LogPlayerPosition',
      _D: at(110),
      elapsedTime: 110,
      common: { isGame: 1 },
      character: who('e1', 2, { location: loc(6050, 5000), type: 'user' }),
    },
    {
      _T: 'LogPlayerPosition',
      _D: at(130),
      elapsedTime: 130,
      common: { isGame: 1 },
      character: who('e1', 2, { location: loc(6100, 5000), type: 'user' }),
    },
    {
      _T: 'LogPlayerPosition',
      _D: at(100),
      elapsedTime: 100,
      common: { isGame: 1 },
      character: who('e2', 2, { location: loc(6000, 5100), type: 'user' }),
    },
    {
      _T: 'LogPlayerPosition',
      _D: at(100),
      elapsedTime: 100,
      common: { isGame: 1 },
      character: who('bot', 7, { location: loc(1, 1), type: 'ai' }),
    },
    // Fight 1: a knocks e1 then kills it; e2 knocks b who is revived by a.
    {
      _T: 'LogPlayerTakeDamage',
      _D: at(100),
      common: { isGame: 1 },
      damage: 40,
      damageTypeCategory: 'Damage_Gun',
      attacker: who('a', 1),
      victim: who('e1', 2),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: at(102),
      common: { isGame: 1 },
      damage: 20,
      damageTypeCategory: 'Damage_Gun',
      attacker: who('e2', 2),
      victim: who('b', 1),
    },
    {
      _T: 'LogPlayerMakeGroggy',
      _D: at(105),
      common: { isGame: 1 },
      attacker: who('a', 1),
      victim: who('e1', 2),
      damageCauserName: 'WeapM416_C',
      distance: 8700,
    },
    {
      _T: 'LogPlayerMakeGroggy',
      _D: at(108),
      common: { isGame: 1 },
      attacker: who('e2', 2),
      victim: who('b', 1),
      damageCauserName: 'WeapAKM_C',
      distance: 5000,
    },
    {
      _T: 'LogPlayerKillV2',
      _D: at(112),
      common: { isGame: 1 },
      victim: who('e1', 2),
      dBNOMaker: who('a', 1),
      finisher: who('a', 1),
      killer: who('a', 1),
      finishDamageInfo: { damageCauserName: 'WeapM416_C', distance: 900 },
    },
    {
      _T: 'LogPlayerRevive',
      _D: at(120),
      common: { isGame: 1 },
      reviver: who('a', 1),
      victim: who('b', 1),
    },
    // Fight 2, much later: both squad members go down and die.
    {
      _T: 'LogPlayerTakeDamage',
      _D: at(280),
      common: { isGame: 3 },
      damage: 55,
      damageTypeCategory: 'Damage_Gun',
      attacker: who('e3', 3),
      victim: who('a', 1),
    },
    {
      _T: 'LogPlayerMakeGroggy',
      _D: at(284),
      common: { isGame: 3 },
      attacker: who('e3', 3),
      victim: who('a', 1),
      damageCauserName: 'WeapKar98k_C',
      distance: 20000,
    },
    {
      _T: 'LogPlayerKillV2',
      _D: at(290),
      common: { isGame: 3 },
      victim: who('a', 1),
      dBNOMaker: who('e3', 3),
      finisher: who('e3', 3),
      killer: who('e3', 3),
      finishDamageInfo: { damageCauserName: 'WeapKar98k_C', distance: 21000 },
    },
    {
      _T: 'LogPlayerKillV2',
      _D: at(295),
      common: { isGame: 3 },
      victim: who('b', 1),
      dBNOMaker: null,
      finisher: who('e3', 3),
      killer: who('e3', 3),
      finishDamageInfo: { damageCauserName: 'WeapKar98k_C', distance: 15000 },
    },
    {
      _T: 'LogPlayerKillV2',
      _D: at(299),
      common: { isGame: 3 },
      victim: who('x', 4),
      dBNOMaker: null,
      finisher: who('e3', 3),
      killer: who('e3', 3),
    },
  ];
  const story = analyzeMatchStory(payload, new Set(['a', 'b']));
  assert.equal(story.mapName, 'Baltic_Main');
  assert.equal(story.startTeams, 20);
  assert.deepEqual(
    story.phaseStarts.map((item) => item.phase),
    [1, 3],
  );
  assert.deepEqual(story.circle[0]!.zone, { x: 4000, y: 4000, r: 3000 });
  const a = story.players.find((player) => player.member === 'a')!;
  assert.deepEqual(a.landing, { t: 20, x: 1000, y: 1000 });
  assert.equal(
    a.route.length,
    2,
    'plane-flight positions and samples under ten seconds apart are dropped',
  );
  assert.equal(a.route[1]!.vehicle, true);
  assert.deepEqual(
    a.lifeline.map((segment) => segment.state),
    ['alive', 'down'],
  );
  assert.equal(a.diedAt, 290);
  const b = story.players.find((player) => player.member === 'b')!;
  assert.deepEqual(
    b.lifeline.map((segment) => segment.state),
    ['alive', 'down', 'alive'],
  );
  assert.equal(b.diedAt, 295);
  assert.equal(story.squadOutAt, 295);
  assert.equal(story.teamsAtEnd, 9);
  const kinds = story.events.map((event) => event.kind);
  assert.deepEqual(kinds, ['knock', 'downed', 'kill', 'revive', 'downed', 'death', 'death']);
  const knock = story.events.find((event) => event.kind === 'knock')!;
  assert.deepEqual({ weapon: knock.weapon, meters: knock.meters }, { weapon: 'M416', meters: 87 });
  assert.equal(story.events.find((event) => event.kind === 'kill')!.afterKnock, true);
  assert.equal(story.fights.length, 2);
  assert.deepEqual(
    {
      outcome: story.fights[0]!.outcome,
      enemyDowns: story.fights[0]!.enemyDowns,
      ourDowns: story.fights[0]!.ourDowns,
      initiator: story.fights[0]!.initiator,
      revives: story.fights[0]!.revives,
    },
    { outcome: 'draw', enemyDowns: 1, ourDowns: 1, initiator: 'us', revives: 1 },
  );
  assert.equal(story.fights[1]!.outcome, 'lose');
  assert.equal(story.fights[1]!.phase, 3);
  assert.equal(story.fights[1]!.aliveTeams, 9);
  assert.equal(a.damagePerMinute[1], 40, 'damage lands in the minute it was dealt');
  const enemyTeam2 = story.fights[0]!.enemies.find((item) => item.team === '2')!;
  assert.deepEqual(
    {
      size: enemyTeam2.size,
      downed: enemyTeam2.downed,
      from: enemyTeam2.damageFromUs,
      to: enemyTeam2.damageToUs,
    },
    { size: 2, downed: 1, from: 40, to: 20 },
  );
  assert.equal(story.fights[1]!.enemies[0]!.team, '3');
  assert.equal(
    story.fights[1]!.enemies[0]!.weapons.length,
    0,
    'damage without a recorded weapon lists none',
  );
  const e1 = story.enemies.find((enemy) => enemy.id === 'e1')!;
  assert.deepEqual(
    e1.route,
    [
      [100, 6000, 5000],
      [130, 6100, 5000],
    ],
    'enemy routes are thinned to one sample every twenty seconds',
  );
  assert.equal(e1.diedAt, 112);
  assert.ok(
    !story.enemies.some((enemy) => ['a', 'b'].includes(enemy.id)),
    'the squad is not an enemy',
  );
});

test('a squad that is still alive at the end has no out-time, and empty input yields an empty story', () => {
  const alive = analyzeMatchStory(
    [
      { _T: 'LogMatchStart', _D: at(0), common: { isGame: 0 } },
      {
        _T: 'LogParachuteLanding',
        _D: at(10),
        common: { isGame: 0.1 },
        character: who('a', 1, { location: loc(1, 1) }),
      },
      {
        _T: 'LogGameStatePeriodic',
        _D: at(600),
        common: { isGame: 6 },
        gameState: { elapsedTime: 600, numAliveTeams: 2 },
      },
    ],
    new Set(['a']),
  );
  assert.equal(alive.squadOutAt, null);
  assert.equal(alive.players[0]!.lifeline.at(-1)!.state, 'alive');
  const empty = analyzeMatchStory([], new Set(['a']));
  assert.deepEqual(
    { players: empty.players.length, fights: empty.fights.length, events: empty.events.length },
    { players: 0, fights: 0, events: 0 },
  );
});
