import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeStyleTelemetry,
  buildSquadStyle,
  emptyFights,
  weaponClassOf,
  weightedMedianDistance,
  STYLE_DISTANCE_EDGES,
  STYLE_SPACING_EDGES,
  type PlayerStyleMatch,
  type StyleInputMatch,
} from '../src/index.js';

const geo = (x: number, y: number, z = 0) => ({ x, y, z });
const who = (
  accountId: string,
  teamId: number,
  location = geo(0, 0),
  extra: Record<string, unknown> = {},
) => ({ accountId, teamId, location, isDBNO: false, isInVehicle: false, ...extra });
const day = (seconds: number) =>
  new Date(Date.parse('2026-03-01T00:00:00.000Z') + seconds * 1000).toISOString();

test('weapon classes and the damage-weighted median distance', () => {
  assert.equal(weaponClassOf('M24'), 'SR');
  assert.equal(weaponClassOf('Mini14'), 'DMR');
  assert.equal(weaponClassOf('UMP'), 'SMG');
  assert.equal(weaponClassOf('Banana'), 'other');
  assert.equal(weightedMedianDistance(new Array(STYLE_DISTANCE_EDGES.length + 1).fill(0)), null);
  const bins = new Array(STYLE_DISTANCE_EDGES.length + 1).fill(0);
  bins[0] = 100;
  assert.ok(weightedMedianDistance(bins)! <= 10);
  bins[5] = 400;
  const median = weightedMedianDistance(bins)!;
  assert.ok(median >= 100 && median <= 150, `median ${median} should fall in the 100-150 m bin`);
});

test('style telemetry measures distance, stage, healing, early loot, movement, circle position and spacing', () => {
  const tracked = new Set(['a', 'b']);
  const payload = [
    {
      _T: 'LogParachuteLanding',
      _D: day(10),
      common: { isGame: 0.1 },
      character: who('a', 1, geo(100_000, 100_000)),
    },
    {
      _T: 'LogParachuteLanding',
      _D: day(10),
      common: { isGame: 0.1 },
      character: who('b', 1, geo(100_000 + 20_000, 100_000)),
    },
    {
      _T: 'LogItemPickup',
      _D: day(60),
      common: { isGame: 1 },
      character: who('a', 1),
      item: { category: 'Weapon' },
    },
    {
      _T: 'LogItemPickupFromLootBox',
      _D: day(100),
      common: { isGame: 1 },
      character: who('a', 1),
      item: { category: 'Use' },
    },
    {
      _T: 'LogItemPickup',
      _D: day(900),
      common: { isGame: 3 },
      character: who('a', 1),
      item: { category: 'Use' },
    },
    {
      _T: 'LogItemUse',
      _D: day(110),
      common: { isGame: 2 },
      character: who('a', 1),
      item: { category: 'Use', subCategory: 'Heal', itemId: 'Item_Heal_Bandage_C' },
    },
    {
      _T: 'LogItemUse',
      _D: day(111),
      common: { isGame: 2 },
      character: who('a', 1),
      item: { category: 'Use', subCategory: 'Boost', itemId: 'Item_Boost_PainKiller_C' },
    },
    {
      _T: 'LogItemUse',
      _D: day(112),
      common: { isGame: 2 },
      character: who('a', 1),
      item: { category: 'Ammunition', subCategory: 'None' },
    },
    {
      _T: 'LogGameStatePeriodic',
      _D: day(115),
      common: { isGame: 2 },
      gameState: { safetyZonePosition: geo(0, 0), safetyZoneRadius: 1_000 },
    },
    {
      _T: 'LogPlayerPosition',
      _D: day(120),
      elapsedTime: 120,
      common: { isGame: 2 },
      character: who('a', 1, geo(0, 0)),
    },
    {
      _T: 'LogPlayerPosition',
      _D: day(130),
      elapsedTime: 130,
      common: { isGame: 2 },
      character: who('a', 1, geo(1_000, 0)),
    },
    {
      _T: 'LogPlayerPosition',
      _D: day(121),
      elapsedTime: 121,
      common: { isGame: 2 },
      character: who('b', 1, geo(30_000, 0)),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(135.5),
      common: { isGame: 2 },
      attackId: 11,
      damage: 30,
      damageTypeCategory: 'Damage_Gun',
      damageReason: 'HeadShot',
      damageCauserName: 'WeapKar98k_C',
      attacker: who('a', 1, geo(0, 0)),
      victim: who('e', 2, geo(20_000, 0)),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(141),
      common: { isGame: 6 },
      damage: 20,
      damageTypeCategory: 'Damage_Gun',
      damageReason: 'TorsoShot',
      damageCauserName: 'WeapUMP_C',
      attacker: who('b', 1, geo(0, 0)),
      victim: who('e', 2, geo(1_000, 0)),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(142),
      common: { isGame: 2 },
      damage: 99,
      damageTypeCategory: 'Damage_Gun',
      attacker: who('a', 1),
      victim: who('b', 1, geo(500, 0)),
    },
    {
      _T: 'LogPlayerAttack',
      _D: day(135),
      common: { isGame: 2 },
      attackId: 11,
      attackType: 'Weapon',
      attacker: who('a', 1),
      weapon: { itemId: 'Item_Weapon_Kar98k_C', category: 'Weapon', subCategory: 'Main' },
    },
    {
      _T: 'LogPlayerAttack',
      _D: day(136),
      common: { isGame: 2 },
      attackId: 12,
      attackType: 'Weapon',
      attacker: who('a', 1),
      weapon: { itemId: 'Item_Weapon_Kar98k_C', category: 'Weapon', subCategory: 'Main' },
    },
    // A burst of three UMP shots 80 ms apart: one first shot and two follow-ups, one of which hits.
    {
      _T: 'LogPlayerAttack',
      _D: day(138.0),
      common: { isGame: 2 },
      attackId: 21,
      attackType: 'Weapon',
      attacker: who('a', 1),
      weapon: { itemId: 'Item_Weapon_UMP_C', category: 'Weapon', subCategory: 'Main' },
    },
    {
      _T: 'LogPlayerAttack',
      _D: day(138.08),
      common: { isGame: 2 },
      attackId: 22,
      attackType: 'Weapon',
      attacker: who('a', 1),
      weapon: { itemId: 'Item_Weapon_UMP_C', category: 'Weapon', subCategory: 'Main' },
    },
    {
      _T: 'LogPlayerAttack',
      _D: day(138.16),
      common: { isGame: 2 },
      attackId: 23,
      attackType: 'Weapon',
      attacker: who('a', 1),
      weapon: { itemId: 'Item_Weapon_UMP_C', category: 'Weapon', subCategory: 'Main' },
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(138.17),
      common: { isGame: 2 },
      attackId: 23,
      damage: 25,
      damageTypeCategory: 'Damage_Gun',
      damageCauserName: 'WeapUMP_C',
      attacker: who('a', 1, geo(0, 0)),
      victim: who('e', 2, geo(1_500, 0)),
    },
    // A shot far from any fight: neither a hit nor a miss that counts against the hit rate.
    {
      _T: 'LogPlayerAttack',
      _D: day(900),
      common: { isGame: 3 },
      attackId: 31,
      attackType: 'Weapon',
      attacker: who('a', 1),
      weapon: { itemId: 'Item_Weapon_UMP_C', category: 'Weapon', subCategory: 'Main' },
    },
    {
      _T: 'LogPlayerAttack',
      _D: day(137),
      common: { isGame: 2 },
      attackType: 'Weapon',
      attacker: who('a', 1),
      weapon: { itemId: 'Item_Weapon_Grenade_C', category: 'Equipment', subCategory: 'Throwable' },
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(136.01),
      common: { isGame: 2 },
      attackId: 12,
      damage: 0,
      damageTypeCategory: 'Damage_Gun',
      damageCauserName: 'WeapKar98k_C',
      attacker: who('a', 1, geo(0, 0)),
      victim: who('e', 2, geo(20_000, 0), { isDBNO: true }),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(139),
      common: { isGame: 2 },
      damage: 80,
      damageTypeCategory: 'Damage_Explosion_PanzerFaustWarhead',
      damageCauserName: 'PanzerFaust100M_Projectile_C',
      attacker: who('b', 1),
      victim: who('e', 2),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(139),
      common: { isGame: 2 },
      damage: 15,
      damageTypeCategory: 'Damage_Molotov',
      attacker: who('b', 1),
      victim: who('e', 2),
    },
    {
      _T: 'LogPlayerAttack',
      _D: day(139),
      common: { isGame: 2 },
      attackType: 'Weapon',
      attacker: who('b', 1),
      weapon: { itemId: 'Item_Weapon_PanzerFaust100M_C', category: 'Weapon', subCategory: 'Main' },
    },
    {
      _T: 'LogPlayerUseThrowable',
      _D: day(143),
      common: { isGame: 2 },
      attacker: who('a', 1),
      weapon: { itemId: 'Item_Weapon_SmokeBomb_C' },
    },
    {
      _T: 'LogPlayerUseThrowable',
      _D: day(144),
      common: { isGame: 2 },
      attacker: who('a', 1),
      weapon: { itemId: 'Item_Weapon_Juju_C' },
    },
    {
      _T: 'LogVehicleRide',
      _D: day(145),
      common: { isGame: 2 },
      character: who('b', 1),
      vehicle: { vehicleType: 'WheeledVehicle' },
    },
    {
      _T: 'LogVehicleRide',
      _D: day(5),
      common: { isGame: 0.1 },
      character: who('b', 1),
      vehicle: { vehicleType: 'TransportAircraft' },
    },
  ];
  const stats = analyzeStyleTelemetry(payload, tracked);
  assert.equal(
    stats.a!.gunDamage,
    55,
    'friendly fire and unknown damage are ignored: the 30 and the 25 from the burst',
  );
  assert.equal(stats.a!.headDamage, 30);
  assert.equal(
    stats.b!.explosiveDamage,
    95,
    'rocket and fire damage count toward damage per minute',
  );
  assert.equal(stats.b!.gunDamage, 20, 'but not toward gun damage');
  assert.equal(stats.b!.weaponDamage.PanzerFaust, 80);
  assert.equal(stats.b!.shots, 0, 'rocket launches are not shots');
  assert.equal(stats.a!.dealtBins[STYLE_DISTANCE_EDGES.findIndex((edge) => 200 < edge)], 30);
  assert.equal(stats.b!.dealtBins[1], 20, 'a 10 m shot lands in the 10-25 m bin');
  assert.deepEqual(stats.a!.phaseDamage, [55, 0, 0]);
  assert.deepEqual(stats.b!.phaseDamage, [0, 0, 20], 'circle 6 counts as late game');
  assert.equal(stats.a!.weaponDamage.Kar98k, 30);
  // Kar98k #11 hit a standing player, #12 went into a downed one, the UMP burst has one hit among three, #31 was far from any fight.
  assert.deepEqual(
    {
      shots: stats.a!.shots,
      hits: stats.a!.hits,
      finishing: stats.a!.finishingShots,
      idle: stats.a!.idleShots,
    },
    { shots: 4, hits: 2, finishing: 1, idle: 1 },
    'a finishing shot is neither a hit nor a miss; a shot outside any fight is counted apart',
  );
  assert.equal(stats.a!.hitDamage, 55, 'damage of the shots that hurt a standing opponent');
  assert.equal(stats.a!.classShots[3], 1, 'the aimed Kar98k shot is a sniper-rifle shot');
  assert.deepEqual(
    {
      first: stats.a!.firstShots,
      firstHits: stats.a!.firstHits,
      follow: stats.a!.followShots,
      followHits: stats.a!.followHits,
    },
    { first: 2, firstHits: 1, follow: 2, followHits: 1 },
    'the first UMP shot and the Kar98k shot are first shots; the two bullets 80 ms behind are follow-ups',
  );
  assert.equal(stats.a!.gunDamage, 55, 'distance damage stays on standing targets');
  assert.equal(stats.a!.throwables.smoke, 1);
  assert.equal(stats.a!.throwables.frag + stats.a!.throwables.fire + stats.a!.throwables.flash, 0);
  assert.equal(stats.b!.rides, 1, 'aircraft rides do not count');
  assert.equal(stats.a!.healUses, 1);
  assert.equal(stats.a!.boostUses, 1);
  assert.equal(stats.a!.earlyPickups, 2, 'only pickups within four minutes of landing');
  assert.equal(Math.round(stats.a!.footMeters), 10);
  assert.equal(stats.a!.zoneSamples, 2);
  assert.equal(stats.a!.zoneEdgeSamples, 1);
  assert.equal(
    stats.a!.spacingBins[STYLE_SPACING_EDGES.length],
    1,
    '300 m apart falls in the open-ended last bin',
  );
  assert.equal(Math.round(stats.a!.landingSpread!), 100);
});

function playerMatch(
  overrides: {
    range?: number;
    isolated?: boolean;
    revives?: number;
    downed?: number;
    weapons?: Record<string, number>;
    skill?: number;
  } = {},
): PlayerStyleMatch {
  const skill = overrides.skill ?? 1;
  const dealtBins = new Array(STYLE_DISTANCE_EDGES.length + 1).fill(0);
  dealtBins[overrides.range ?? 3] = 300;
  const spacingBins = new Array(STYLE_SPACING_EDGES.length + 1).fill(0);
  if (overrides.isolated) {
    spacingBins[1] = 5;
    spacingBins[4] = 15;
  } else {
    spacingBins[0] = 15;
    spacingBins[1] = 5;
  }
  return {
    minutes: 15,
    gunDamage: 300 * skill,
    explosiveDamage: 0,
    headDamage: 30 * skill,
    shots: 100,
    hits: Math.round(25 * skill),
    hitDamage: 400 * skill,
    classShots: [100, 0, 0, 0, 0, 0, 0, 0],
    classHits: [Math.round(25 * skill), 0, 0, 0, 0, 0, 0, 0],
    classHitDamage: [400 * skill, 0, 0, 0, 0, 0, 0, 0],
    firstShots: 30,
    firstHits: Math.round(10 * skill),
    followShots: 70,
    followHits: Math.round(15 * skill),
    idleShots: 20,
    finishingShots: 5,
    dealtBins,
    phaseDamage: [100, 100, 100],
    weaponDamage: overrides.weapons ?? { Kar98k: 150, UMP: 150 },
    spacingBins,
    throwables: { frag: 0, smoke: 0, flash: 0, fire: 0 },
    rides: 0,
    healUses: 0,
    boostUses: 0,
    earlyPickups: 0,
    footMeters: 0,
    zoneSamples: 0,
    zoneEdgeSamples: 0,
    landingSpread: 20,
    fights: {
      ...emptyFights(),
      fights: 6,
      initiations: 2,
      firstKnocks: 1,
      firstDowned: 1,
      knocksDealt: 2,
      timesDowned: overrides.downed ?? 1,
      kills: 2,
      revives: overrides.revives ?? 0,
      fightsWithKnock: skill > 1 ? 5 : 3,
      chainsDealt: 3,
      chainsFinished: skill > 1 ? 3 : 2,
    },
  };
}

const NAMES = new Map([
  ['near', 'Near'],
  ['far', 'Far'],
  ['loner', 'Loner'],
  ['mid', 'Mid'],
  ['mid2', 'Mid2'],
]);

test('squad style finds stable traits, archetypes, spreads, overlaps and gaps, and stays quiet on small samples', () => {
  const matches: StyleInputMatch[] = Array.from({ length: 30 }, (_, index) => ({
    matchId: `m${index}`,
    players: {
      near: playerMatch({ range: 1, downed: 3, revives: index % 5 === 0 ? 1 : 0 }),
      far: playerMatch({ range: 6, weapons: { M24: 250, Mini14: 50 } }),
      loner: playerMatch({ range: 3, isolated: true }),
      mid: playerMatch({ range: 3 }),
      mid2: playerMatch({ range: 3, isolated: index % 2 === 0 }),
    },
  }));
  const style = buildSquadStyle({ matches, names: NAMES });
  const by = (id: string) => style.players.find((player) => player.accountId === id)!;
  const axis = (id: string, key: string) => by(id).axes.find((item) => item.key === key)!;

  assert.equal(axis('near', 'range').tier, 'stable');
  assert.equal(axis('near', 'range').direction, 'low');
  assert.equal(axis('far', 'range').direction, 'high');
  assert.equal(axis('far', 'marksman').tier, 'stable', 'weapon class share separates the sniper');
  assert.equal(axis('loner', 'isolation').direction, 'high');
  assert.equal(axis('near', 'risk').direction, 'high');
  assert.ok(axis('far', 'range').ratio! > 1 && axis('far', 'range').low! > 1);
  assert.ok(by('far').traits.some((trait) => trait.key === 'range' && trait.ratio > 1));
  assert.ok(by('loner').archetypes.some((entry) => entry.id === 'roamer'));
  assert.ok(by('far').archetypes.some((entry) => entry.id === 'marksman'));
  assert.ok(by('near').archetypes.some((entry) => entry.id === 'rusher'));
  assert.equal(by('far').weapons.length, 2);
  assert.ok(style.spreads.length > 0 && style.spreads[0]!.supported);
  assert.ok(style.spreads.some((entry) => entry.key === 'range' && entry.spread > 2));
  assert.ok(style.gaps.some((gap) => gap.includes('投掷物')));
  assert.ok(style.players.every((player) => player.summary.length > 0));

  const tiny = buildSquadStyle({ matches: matches.slice(0, 4), names: NAMES });
  assert.ok(
    tiny.players.every(
      (player) =>
        player.traits.length === 0 &&
        player.archetypes.length === 1 &&
        player.archetypes[0]!.tier === 'balanced',
    ),
  );
  assert.ok(
    tiny.players.every((player) =>
      player.axes.every((reading) => reading.tier === 'even' || reading.tier === 'unknown'),
    ),
  );
});

test('a difference that holds in most resamples but crosses parity is graded as a lean, not hidden', () => {
  const downed = [
    0, 3, 0, 2, 4, 0, 1, 0, 3, 0, 2, 1, 0, 4, 0, 1, 3, 0, 0, 2, 4, 0, 1, 0, 3, 0, 2, 1, 0, 3,
  ];
  const matches: StyleInputMatch[] = downed.map((count, index) => ({
    matchId: `l${index}`,
    players: {
      a: playerMatch({ downed: count }),
      b: playerMatch(),
      c: playerMatch(),
      d: playerMatch(),
    },
  }));
  const style = buildSquadStyle({
    matches,
    names: new Map([
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
      ['d', 'D'],
    ]),
  });
  const risk = style.players
    .find((player) => player.accountId === 'a')!
    .axes.find((item) => item.key === 'risk')!;
  assert.equal(risk.tier, 'lean');
  assert.ok(risk.low! < 1 && risk.high! > 1, 'the interval still crosses parity');
  assert.ok(risk.confidence! >= 0.85 && risk.confidence! < 1);
  assert.ok(Math.abs(risk.ratio! - 4 / 3) < 0.01);
  const trait = style.players
    .find((player) => player.accountId === 'a')!
    .traits.find((item) => item.key === 'risk')!;
  assert.equal(trait.tier, 'lean');
  assert.ok(style.players.find((player) => player.accountId === 'a')!.summary.includes('倾向于'));
});

test('a squad with no differences at all is reported as homogeneous', () => {
  const matches: StyleInputMatch[] = Array.from({ length: 30 }, (_, index) => ({
    matchId: `h${index}`,
    players: Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, playerMatch({ downed: 1 })])),
  }));
  const style = buildSquadStyle({
    matches,
    names: new Map([
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
      ['d', 'D'],
    ]),
  });
  assert.ok(style.gaps.some((gap) => gap.includes('高度同质')));
  assert.ok(style.players.every((player) => player.traits.length === 0));
  assert.ok(
    style.players.every((player) => player.archetypes[0]!.label === '均衡全能型'),
    'a player is never left without a type',
  );
});

test('every player gets a type, faint leans are named with a qualifier, and balanced is a positive label', () => {
  const matches: StyleInputMatch[] = Array.from({ length: 30 }, (_, index) => ({
    matchId: `q${index}`,
    players: {
      a: playerMatch({ range: index % 2 ? 2 : 3 }),
      b: playerMatch({ range: 3 }),
      c: playerMatch({ range: 3 }),
      d: playerMatch({ range: 3 }),
    },
  }));
  const style = buildSquadStyle({
    matches,
    names: new Map([
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
      ['d', 'D'],
    ]),
  });
  assert.ok(
    style.players.every((player) => player.archetypes.length >= 1 && player.summary.length > 0),
  );
  assert.ok(style.players.every((player) => !player.summary.includes('没有单一鲜明类型')));
});

test('the fighting-power index ranks the stronger fighter first and the funnel reports each conversion step', () => {
  const matches: StyleInputMatch[] = Array.from({ length: 30 }, (_, index) => ({
    matchId: `c${index}`,
    players: {
      ace: playerMatch({ skill: 1.6 }),
      b: playerMatch(),
      c: playerMatch(),
      d: playerMatch(),
    },
  }));
  const style = buildSquadStyle({
    matches,
    names: new Map([
      ['ace', 'Ace'],
      ['b', 'B'],
      ['c', 'C'],
      ['d', 'D'],
    ]),
  });
  assert.equal(style.combat[0]!.accountId, 'ace');
  assert.equal(style.combat[0]!.rank, 1);
  assert.equal(style.combat[0]!.tier, 'stable');
  assert.ok(style.combat[0]!.ratio! > 1.3 && style.combat[0]!.low! > 1);
  assert.equal(style.combat[0]!.components.length, 3);
  assert.ok(style.combat.at(-1)!.ratio! < 1);
  const ace = style.funnel.find((entry) => entry.accountId === 'ace')!;
  const other = style.funnel.find((entry) => entry.accountId === 'b')!;
  assert.equal(ace.shots, 3000);
  assert.ok(Math.abs(ace.hitRate! - 0.4) < 1e-9);
  assert.ok(Math.abs(other.hitRate! - 0.25) < 1e-9);
  assert.ok(Math.abs(ace.conversion! - 1) < 1e-9);
  assert.ok(Math.abs(other.conversion! - 2 / 3) < 1e-9);
  assert.ok(ace.hitsPerKnock! > 0);
  assert.ok(
    style.players
      .find((player) => player.accountId === 'ace')!
      .archetypes.some((entry) => entry.id === 'carry'),
  );
  assert.ok(style.combatVerdict.includes('综合战斗力最强：Ace'));
  assert.ok(style.combatHighlights.some((entry) => entry.name === 'Ace' && entry.ratio > 1));
});

test('when nobody leads on the overall index the verdict says so instead of naming a winner', () => {
  const matches: StyleInputMatch[] = Array.from({ length: 30 }, (_, index) => ({
    matchId: `v${index}`,
    players: Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((id, offset) => [
        id,
        playerMatch({ skill: 1 + ((index + offset) % 3 === 0 ? 0.04 : 0) }),
      ]),
    ),
  }));
  const style = buildSquadStyle({
    matches,
    names: new Map([
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
      ['d', 'D'],
    ]),
  });
  assert.ok(style.combatVerdict.includes('没有显著差距'));
});

test('hit rate is compared on the same weapon mix, so a sniper is not rated a better shot just for using a bolt-action', () => {
  const sniper = (): PlayerStyleMatch => ({
    ...playerMatch(),
    shots: 100,
    hits: 40,
    hitDamage: 4000,
    classShots: [0, 0, 0, 100, 0, 0, 0, 0],
    classHits: [0, 0, 0, 40, 0, 0, 0, 0],
    classHitDamage: [0, 0, 0, 4000, 0, 0, 0, 0],
  });
  const mixed = (): PlayerStyleMatch => ({
    ...playerMatch(),
    shots: 200,
    hits: 60,
    hitDamage: 4800,
    classShots: [100, 0, 0, 100, 0, 0, 0, 0],
    classHits: [20, 0, 0, 40, 0, 0, 0, 0],
    classHitDamage: [800, 0, 0, 4000, 0, 0, 0, 0],
  });
  const matches = Array.from({ length: 20 }, (_, index) => ({
    matchId: `m${index}`,
    players: { s: sniper(), a: mixed(), b: mixed(), c: mixed() },
  }));
  const style = buildSquadStyle({
    matches,
    names: new Map([
      ['s', 'S'],
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
    ]),
  });
  const hitRate = style.players
    .find((player) => player.accountId === 's')!
    .axes.find((axis) => axis.key === 'hitRate')!;
  assert.equal(hitRate.value, 0.4, 'raw sniper hit rate');
  assert.ok(
    Math.abs(hitRate.ratio! - 1) < 0.02,
    `same class rates read as parity, got ${hitRate.ratio}`,
  );
  // Shotguns are included now that shots are paired with hits by attack: a blast is one shot and at most one hit.
  const withShotgun = buildSquadStyle({
    matches: matches.map((match) => ({
      ...match,
      players: {
        ...match.players,
        s: {
          ...sniper(),
          shots: 150,
          hits: 40,
          classShots: [0, 0, 0, 100, 0, 50, 0, 0],
          classHits: [0, 0, 0, 40, 0, 0, 0, 0],
        },
      },
    })),
    names: new Map([
      ['s', 'S'],
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
    ]),
  });
  assert.ok(
    withShotgun.players
      .find((player) => player.accountId === 's')!
      .axes.find((axis) => axis.key === 'hitRate')!.value! < 0.3,
    'fifty missed shotgun shots lower the hit rate',
  );
});
