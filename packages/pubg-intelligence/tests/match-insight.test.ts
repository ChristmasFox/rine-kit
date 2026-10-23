import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeMatchStory,
  buildTurningPoints,
  summarizeDowns,
  summarizeRotation,
  type MatchRotation,
  type MatchStory,
  type StoryDown,
} from '../src/index.js';

const start = Date.UTC(2026, 9, 1, 12, 0, 0);
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const who = (id: string, team: number, extra: Record<string, unknown> = {}) => ({
  accountId: id,
  teamId: team,
  name: id.toUpperCase(),
  ...extra,
});
const loc = (x: number, y: number) => ({ x: x * 100, y: y * 100, z: 0 });
const hit = (
  t: number,
  attacker: ReturnType<typeof who>,
  victim: ReturnType<typeof who>,
  damage = 30,
) => ({
  _T: 'LogPlayerTakeDamage',
  _D: at(t),
  common: { isGame: 3 },
  damage,
  damageTypeCategory: 'Damage_Gun',
  damageCauserName: 'WeapM416_C',
  attacker,
  victim,
});
const down = (
  t: number,
  attacker: ReturnType<typeof who> | null,
  victim: ReturnType<typeof who>,
  meters: number,
  category = 'Damage_Gun',
) => ({
  _T: 'LogPlayerMakeGroggy',
  _D: at(t),
  common: { isGame: 3 },
  attacker,
  victim,
  damageCauserName: 'WeapKar98k_C',
  damageTypeCategory: category,
  distance: meters * 100,
});
const pos = (t: number, id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  _T: 'LogPlayerPosition',
  _D: at(t),
  elapsedTime: t,
  common: { isGame: 3 },
  character: who(id, 1, { location: loc(x, y), ...extra }),
});

test('every knock-down gets a cause from the fire taken and returned, the company around it and what happened next', () => {
  const a = who('a', 1);
  const b = who('b', 1);
  const payload = [
    { _T: 'LogMatchStart', _D: at(0), common: { isGame: 0 } },
    {
      _T: 'LogParachuteLanding',
      _D: at(10),
      common: { isGame: 0.1 },
      character: who('a', 1, { location: loc(1000, 1000) }),
    },
    {
      _T: 'LogParachuteLanding',
      _D: at(10),
      common: { isGame: 0.1 },
      character: who('b', 1, { location: loc(1000, 1000) }),
    },
    // Squad members stay together until t=250, then b wanders 500 m away.
    ...[90, 100, 110, 190, 200, 210, 220, 230, 240].flatMap((t) => [
      pos(t, 'a', 1000, 1000),
      pos(t, 'b', 1010, 1000),
    ]),
    ...[290, 300, 310].flatMap((t) => [pos(t, 'a', 1000, 1000), pos(t, 'b', 1500, 1000)]),
    // 1. Shot from 250 m, no return fire.
    hit(100, who('e1', 2), a, 40),
    down(105, who('e1', 2), a, 250),
    { _T: 'LogPlayerRevive', _D: at(118), common: { isGame: 3 }, reviver: b, victim: a },
    // 2. A duel at 40 m: both sides hurt, teammate next to the victim.
    hit(200, b, who('e3', 3), 25),
    hit(201, who('e3', 3), b, 45),
    down(210, who('e3', 3), b, 40),
    {
      _T: 'LogPlayerKillV2',
      _D: at(240),
      common: { isGame: 3 },
      victim: b,
      dBNOMaker: who('e3', 3),
      finisher: who('e3', 3),
      killer: who('e3', 3),
      finishDamageInfo: { damageCauserName: 'WeapM416_C', distance: 3000 },
    },
    // 3. Two teams shooting at once.
    hit(290, who('e5', 5), a, 20),
    hit(292, who('e6', 6), a, 20),
    down(295, who('e5', 5), a, 60),
    // 4. The gas.
    {
      _T: 'LogPlayerTakeDamage',
      _D: at(400),
      common: { isGame: 4 },
      damage: 4,
      damageTypeCategory: 'Damage_BlueZone',
      damageCauserName: 'BlueZone',
      attacker: null,
      victim: a,
    },
    down(404, null, a, 0, 'Damage_BlueZone'),
  ];
  const story = analyzeMatchStory(payload, new Set(['a', 'b']));
  const byTime = (t: number) => story.downs.find((item) => item.t === t)!;
  assert.deepEqual(
    story.downs.map((item) => item.cause),
    ['ambush_far', 'lost_duel', 'crossfire', 'bluezone'],
  );
  assert.deepEqual(
    {
      returned: byTime(105).returnDamage,
      taken: byTime(105).takenDamage,
      alone: byTime(105).alone,
      outcome: byTime(105).outcome,
      after: byTime(105).afterSeconds,
    },
    { returned: 0, taken: 40, alone: false, outcome: 'revived', after: 13 },
  );
  assert.deepEqual(
    {
      returned: byTime(210).returnDamage,
      outcome: byTime(210).outcome,
      after: byTime(210).afterSeconds,
    },
    { returned: 25, outcome: 'died', after: 30 },
  );
  assert.equal(byTime(295).teamsHitting, 2);
  assert.equal(byTime(404).meters, 0);
});

test('a duel while far from every teammate is an isolation, and a close ambush is told from a long one', () => {
  const b = who('b', 1);
  const payload = [
    { _T: 'LogMatchStart', _D: at(0), common: { isGame: 0 } },
    {
      _T: 'LogParachuteLanding',
      _D: at(10),
      common: { isGame: 0.1 },
      character: who('a', 1, { location: loc(1000, 1000) }),
    },
    {
      _T: 'LogParachuteLanding',
      _D: at(10),
      common: { isGame: 0.1 },
      character: who('b', 1, { location: loc(1000, 1000) }),
    },
    ...[190, 200, 210, 220].flatMap((t) => [pos(t, 'a', 1000, 1000), pos(t, 'b', 1600, 1000)]),
    hit(200, b, who('e1', 2), 25),
    hit(201, who('e1', 2), b, 45),
    down(210, who('e1', 2), b, 60),
    hit(300, who('e2', 3), b, 30),
    down(302, who('e2', 3), b, 30),
  ];
  const story = analyzeMatchStory(payload, new Set(['a', 'b']));
  assert.deepEqual(
    story.downs.map((item) => [item.cause, item.alone]),
    [
      ['isolated', true],
      ['ambush_close', null],
    ],
  );
});

test('turning points name the first loss, a collapse of consecutive lost fights, the costliest and the decisive fight', () => {
  const fight = (
    index: number,
    start: number,
    outcome: 'win' | 'lose' | 'draw',
    enemyDowns: number,
    ourDowns: number,
  ) => ({
    index,
    start,
    end: start + 20,
    phase: 4,
    aliveTeams: 10,
    enemyTeams: 1,
    outcome,
    initiator: 'us',
    enemyDowns,
    ourDowns,
    ourKills: 0,
    revives: 0,
    damageDealt: 0,
    damageTaken: 0,
    members: [],
    enemies: [],
  });
  const story = {
    events: [
      {
        t: 400,
        kind: 'death',
        member: 'a',
        other: null,
        weapon: null,
        meters: null,
        byPlayer: true,
        afterKnock: true,
      },
    ],
    fights: [
      fight(1, 100, 'win', 3, 0),
      fight(2, 300, 'lose', 0, 1),
      fight(3, 400, 'lose', 0, 2),
      fight(4, 500, 'lose', 1, 3),
    ],
    squadOutAt: 530,
  } as unknown as MatchStory;
  const points = buildTurningPoints(story);
  assert.deepEqual(
    points.map((point) => [point.kind, point.fight]),
    [
      ['decisive', 1],
      ['collapse', 2],
      ['first_loss', 3],
      ['costly', 4],
    ],
  );
  assert.equal(
    points.find((point) => point.kind === 'collapse')!.count,
    3,
    'three consecutive losses end the match',
  );
  assert.equal(points.find((point) => point.kind === 'first_loss')!.member, 'a');
  assert.equal(
    buildTurningPoints({
      events: [],
      fights: [fight(1, 100, 'win', 1, 0)],
      squadOutAt: null,
    } as unknown as MatchStory).length,
    0,
    'a one-down win has no turning point',
  );
});

test('rotation counts when the squad got into each white circle relative to the gas wall closing, the gas it stood in and the damage it took', () => {
  // `poisonGasWarning*` is the next safe circle (white); `safetyZone*` is the gas wall (blue) that later closes on it.
  const state = (t: number, wall: number, x: number, y: number, r: number) => ({
    _T: 'LogGameStatePeriodic',
    _D: at(t),
    common: { isGame: 3 },
    gameState: {
      elapsedTime: t,
      numStartTeams: 20,
      numAliveTeams: 10,
      numAlivePlayers: 30,
      safetyZonePosition: loc(x, y),
      safetyZoneRadius: wall * 100,
      poisonGasWarningPosition: loc(x, y),
      poisonGasWarningRadius: r * 100,
    },
  });
  const walk = Array.from({ length: 11 }, (_, index) => 100 + index * 10).flatMap((t) => {
    const x = 6500 - (t - 100) * 10; // 100 m every 10 s toward the centre at x=5000
    return [
      pos(t, 'a', x, 5000, { isInBlueZone: t <= 140 }),
      pos(t, 'b', x, 5000, { isInBlueZone: false }),
    ];
  });
  const payload = [
    { _T: 'LogMatchStart', _D: at(0), common: { isGame: 0 } },
    {
      _T: 'LogParachuteLanding',
      _D: at(20),
      common: { isGame: 0.1 },
      character: who('a', 1, { location: loc(6500, 5000) }),
    },
    {
      _T: 'LogParachuteLanding',
      _D: at(20),
      common: { isGame: 0.1 },
      character: who('b', 1, { location: loc(6500, 5000) }),
    },
    // Circle 1 (white, radius 500 m at x=5000) appears at 100 s; the wall (3000 m) starts to close at 200 s.
    state(100, 3000, 5000, 5000, 500),
    state(120, 3000, 5000, 5000, 500),
    state(140, 3000, 5000, 5000, 500),
    state(160, 3000, 5000, 5000, 500),
    state(180, 3000, 5000, 5000, 500),
    state(200, 2900, 5000, 5000, 500),
    state(220, 2800, 5000, 5000, 500),
    // Circle 2 appears at 400 s with the squad already inside it; the wall closes from 460 s.
    state(400, 600, 5300, 5000, 300),
    state(420, 600, 5300, 5000, 300),
    state(440, 600, 5300, 5000, 300),
    state(460, 590, 5300, 5000, 300),
    state(700, 300, 5300, 5000, 300),
    ...walk,
    ...[400, 410, 420, 430].flatMap((t) => [pos(t, 'a', 5250, 5000), pos(t, 'b', 5260, 5000)]),
    ...[110, 120, 130].map((t) => ({
      _T: 'LogPlayerTakeDamage',
      _D: at(t),
      common: { isGame: 3 },
      damage: 10,
      damageTypeCategory: 'Damage_BlueZone',
      attacker: null,
      victim: who('a', 1),
    })),
    hit(405, who('e1', 2), who('a', 1), 20),
    down(412, who('e1', 2), who('a', 1), 80),
  ];
  const story = analyzeMatchStory(payload, new Set(['a', 'b']));
  const [first, second] = story.rotation.epochs;
  assert.equal(story.rotation.epochs.length, 2);
  assert.deepEqual(
    {
      outside: first!.outsideAtStart,
      entered: first!.enteredAfter,
      shrink: first!.shrinkAfter,
      margin: first!.margin,
      blueDamage: first!.blueDamage,
      blue: first!.blueSeconds > 0,
    },
    { outside: 1000, entered: 100, shrink: 100, margin: 0, blueDamage: 30, blue: true },
  );
  assert.deepEqual(
    { entered: second!.enteredAfter, shrink: second!.shrinkAfter, margin: second!.margin },
    { entered: 0, shrink: 60, margin: 60 },
    'already inside when it appeared, a minute before the wall moved',
  );
  assert.deepEqual(
    {
      late: story.rotation.lateEntries,
      checked: story.rotation.circlesChecked,
      blueDamage: story.rotation.blueDamage,
    },
    { late: 0, checked: 2, blueDamage: 30 },
    'arriving exactly as the wall starts to move is not late',
  );
  assert.equal(
    story.rotation.landingToFight,
    385,
    'from the landing at 20 s to the first fight at 405 s',
  );
});

test('the summaries put the causes, lone downs and circle trouble into plain numbers and honest comparisons', () => {
  const down = (cause: StoryDown['cause'], extra: Partial<StoryDown> = {}): StoryDown => ({
    t: 100,
    member: 'a',
    cause,
    attackerTeam: '2',
    weapon: 'M416',
    meters: 100,
    returnDamage: cause === 'ambush_far' || cause === 'ambush_close' ? 0 : 20,
    takenDamage: 40,
    teamsHitting: 1,
    nearestTeammate: 50,
    alone: false,
    teamsNearby: 1,
    phase: 4,
    outcome: 'revived',
    afterSeconds: 10,
    ...extra,
  });
  const items = [
    {
      downs: [
        ...Array.from({ length: 12 }, () => down('ambush_far')),
        ...Array.from({ length: 5 }, () =>
          down('isolated', { alone: true, outcome: 'died', member: 'b' }),
        ),
        ...Array.from({ length: 5 }, () => down('lost_duel')),
        down('bluezone', { returnDamage: 0, attackerTeam: null }),
      ],
    },
  ];
  const summary = summarizeDowns(
    items,
    new Map([
      ['a', 'A'],
      ['b', 'B'],
    ]),
  );
  assert.equal(summary.downs, 23);
  assert.equal(summary.byCause[0]!.cause, 'ambush_far');
  assert.equal(summary.byCause[0]!.count, 12);
  assert.ok(summary.insights.some((line) => line.includes('没有任何还手')));
  assert.ok(summary.insights.some((line) => line.includes('最常见的倒地原因')));
  assert.equal(
    summarizeDowns([{ downs: [down('ambush_far')] }], new Map()).insights.length,
    0,
    'few downs, no claims',
  );

  const rotation = (blueDamage: number, late: number): MatchRotation => ({
    epochs: [
      {
        phase: 3,
        start: 100,
        end: 300,
        radius: 500,
        outsideAtStart: 600,
        enteredAfter: late ? 90 : 20,
        shrinkAfter: 60,
        margin: late ? -30 : 40,
        blueSeconds: blueDamage ? 40 : 0,
        blueDamage,
        distance: 900,
        vehicleShare: 0.4,
      },
    ],
    blueSeconds: blueDamage ? 40 : 0,
    blueDamage,
    distance: 900,
    vehicleShare: 0.4,
    landingToFight: 60,
    lateEntries: late,
    circlesChecked: 1,
  });
  const rotations = [
    ...Array.from({ length: 15 }, () => ({ rotation: rotation(0, 0) })),
    ...Array.from({ length: 15 }, () => ({ rotation: rotation(80, 1) })),
  ];
  const summary2 = summarizeRotation(rotations);
  assert.equal(summary2.matches, 30);
  assert.equal(summary2.bluePenaltyRate.successes, 15);
  assert.equal(summary2.byPhase[0]!.lateRate, 0.5);
  assert.ok(summary2.insights.some((line) => line.includes('毒圈开始收缩')));
  assert.ok(
    !summary2.insights.some((line) => line.includes('前十率')),
    'no placement comparison: it would be confounded by survival time',
  );
  assert.equal(
    summarizeRotation(rotations.slice(0, 4)).insights.length,
    0,
    'few matches, no claims',
  );
});
