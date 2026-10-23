import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedMatch } from '@rine-kit/pubg-domain';
import { normalizeBattleTelemetry, reconstructBattleMatch } from '../src/battle.js';
import {
  analyzeCombatQuality,
  analyzeDeaths,
  analyzeFieldTelemetry,
  analyzeFights,
  buildFieldInsights,
  summarizeDistance,
  summarizeFights,
  summarizeRoles,
  summarizeZone,
  type FieldMatchStats,
  buildCombatInsights,
  buildLandingPreference,
  buildPerformanceInsights,
  buildSquadAnalytics,
  emptyCombatQuality,
  INSIGHT_MAX,
  buildLineupAnalytics,
  buildMapAnalytics,
  buildMatchSeries,
  deathStageOf,
  extractLandings,
  gridCell,
  mapDisplayName,
  modeGroupOf,
  newcombeDifference,
  summarizeCombatQuality,
  summarizeDeaths,
  wilsonInterval,
} from '../src/index.js';

const start = Date.parse('2026-03-01T00:00:00.000Z');
function matchOf(
  id: string,
  mapName: string,
  rank: number,
  survival: number,
  damage = 100,
): NormalizedMatch {
  return {
    schemaVersion: 3,
    matchId: id,
    shard: 'steam',
    createdAt: new Date(start).toISOString(),
    timestamp: start,
    matchType: 'competitive',
    gameMode: 'squad-fpp',
    isCompetitive: true,
    mapName,
    duration: 1200,
    patchVersion: 'fixture',
    players: ['t1', 't2'].map((accountId) => ({
      accountId,
      playerName: accountId,
      displayName: accountId,
      rank,
      kills: 1,
      assists: 0,
      damage,
      dbnos: 1,
      revives: 0,
      headshotKills: 0,
      survivalTime: survival,
      longestKill: 0,
      deaths: 1,
      deathSemantics: 'explicit' as const,
    })),
  };
}

test('grid cells use one-kilometre squares and reject out-of-map or unknown maps', () => {
  assert.equal(gridCell(2500, 4200, 'Baltic_Main'), 'C5');
  assert.equal(gridCell(500, 500, 'Savage_Main'), 'A1');
  assert.equal(gridCell(9000, 100, 'Baltic_Main'), null);
  assert.equal(gridCell(100, 100, 'Mystery_Main'), null);
  assert.equal(mapDisplayName('Baltic_Main'), '艾伦格');
  assert.equal(mapDisplayName('Mystery_Main'), 'Mystery');
});

test('landing extraction keeps tracked members once, converts centimetres, and ignores others', () => {
  const landing = (accountId: string, x: number, y: number) => ({
    _T: 'LogParachuteLanding',
    character: { accountId, location: { x, y, z: 1 } },
  });
  const samples = extractLandings(
    [
      landing('t1', 250_000, 420_000),
      landing('t1', 10, 10),
      landing('enemy', 1, 1),
      landing('t2', 260_000, 430_000),
    ],
    { mapName: 'Baltic_Main' },
    new Set(['t1', 't2']),
  );
  assert.equal(samples.length, 2);
  assert.equal(samples[0]!.cell, 'C5');
  assert.equal(samples[0]!.xMeters, 2500);
  const gz = extractLandings(
    JSON.parse(JSON.stringify([landing('t1', 100_000, 100_000)])),
    { mapName: 'Baltic_Main' },
    new Set(['t1']),
  );
  assert.equal(gz[0]!.cell, 'B2');
});

test('landing preference ranks cells by use and reports outcome per cell', () => {
  const members = new Set(['t1', 't2']);
  const at = (cell: [number, number]) =>
    ['t1', 't2'].map((playerRef, index) => ({
      playerRef,
      xMeters: cell[0] * 1000 + 100 + index * 50,
      yMeters: cell[1] * 1000 + 100,
      cell: gridCell(cell[0] * 1000 + 100, cell[1] * 1000 + 100, 'Baltic_Main'),
    }));
  const result = buildLandingPreference([
    { match: matchOf('a', 'Baltic_Main', 1, 1500), landings: at([2, 4]), memberIds: members },
    { match: matchOf('b', 'Baltic_Main', 15, 200), landings: at([2, 4]), memberIds: members },
    { match: matchOf('c', 'Baltic_Main', 5, 900), landings: at([6, 1]), memberIds: members },
    { match: matchOf('d', 'Baltic_Main', 3, 900), landings: [], memberIds: members },
  ]);
  const map = result.maps[0]!;
  assert.equal(map.matches, 4);
  assert.equal(map.matchesWithLanding, 3);
  assert.equal(map.cells[0]!.cell, 'C5');
  assert.equal(map.cells[0]!.matches, 2);
  assert.equal(map.cells[0]!.earlyWipeRate, 0.5);
  assert.equal(map.cells[0]!.top10.successes, 1);
  assert.equal(map.topCellRepeatRate, 2 / 3);
  assert.ok(map.medianSpreadMeters! > 0 && map.medianSpreadMeters! < 100);
  assert.ok(result.notes.some((note) => note.includes('1 场没有可读的落地事件')));
});

test('map analytics groups by map with Wilson rates and a damage index', () => {
  const maps = buildMapAnalytics({
    matches: [
      matchOf('a', 'Baltic_Main', 1, 1500, 300),
      matchOf('b', 'Baltic_Main', 12, 500, 100),
      matchOf('c', 'Desert_Main', 4, 800, 100),
    ],
    memberIds: ['t1', 't2'],
  });
  assert.equal(maps[0]!.mapName, 'Baltic_Main');
  assert.equal(maps[0]!.label, '艾伦格');
  assert.equal(maps[0]!.matches, 2);
  assert.equal(maps[0]!.win.successes, 1);
  assert.equal(maps[0]!.medianPlacement, 6.5);
  assert.equal(maps[0]!.damageIndex, null, 'fewer than five matches gives no index');
});

type Actor = { accountId: string; teamId: string };
function raw(
  type: string,
  seconds: number,
  actor: Actor,
  victim?: Actor,
  extra: Record<string, unknown> = {},
) {
  const event: Record<string, unknown> = {
    _T: type,
    common: { isGame: true },
    _D: new Date(start + seconds * 1000).toISOString(),
    ...extra,
  };
  if (type.includes('Revive')) event.reviver = actor;
  else if (type.includes('Kill')) event.killer = actor;
  else event.attacker = actor;
  if (victim) event.victim = victim;
  return event;
}
const us = (accountId: string): Actor => ({ accountId, teamId: 'team-us' });
const them = (accountId: string, teamId = 'team-b'): Actor => ({ accountId, teamId });

test('combat quality measures first knock, finish and revive timing from reconstructed battles', () => {
  const telemetry = [
    raw('LogPlayerTakeDamage', 10, us('t1'), them('e1'), { damage: 25 }),
    raw('LogPlayerMakeGroggy', 28, us('t1'), them('e1'), { dBNOId: 'd1' }),
    raw('LogPlayerTakeDamage', 35, us('t1'), them('e1'), { damage: 20 }),
    raw('LogPlayerKill', 43, us('t2'), them('e1'), { dBNOId: 'd1' }),
    raw('LogPlayerTakeDamage', 300, them('e2', 'team-c'), us('t2'), { damage: 30 }),
    raw('LogPlayerMakeGroggy', 310, them('e2', 'team-c'), us('t2'), { dBNOId: 'd2' }),
    raw('LogPlayerRevive', 330, us('t1'), us('t2')),
  ];
  const match = matchOf('cq', 'Baltic_Main', 3, 900);
  const result = reconstructBattleMatch({ match, telemetry, trackedPlayerIds: ['t1', 't2'] });
  const stats = analyzeCombatQuality(result);
  assert.equal(stats.groups, 2);
  assert.equal(stats.firstKnockFor, 1);
  assert.equal(stats.firstKnockAgainst, 1);
  assert.equal(stats.downedFinished, 1);
  assert.deepEqual(stats.finishSeconds, [15]);
  assert.equal(stats.knockedRevived, 1);
  assert.deepEqual(stats.reviveSeconds, [20]);
  const summary = summarizeCombatQuality([stats, stats]);
  assert.equal(summary.revive.knocked, 2);
  assert.equal(summary.revive.reviveRate.rate, 1);
  assert.equal(summary.revive.medianSeconds, 20);
  assert.equal(summary.firstKnock.ourRate.rate, 0.5);
});

test('combat quality returns empty counts when no tracked team is observed', () => {
  const result = reconstructBattleMatch({
    match: matchOf('none', 'Baltic_Main', 3, 900),
    telemetry: [],
    trackedPlayerIds: ['t1'],
  });
  const stats = analyzeCombatQuality(result);
  assert.equal(stats.groups, 0);
  assert.equal(summarizeCombatQuality([stats]).revive.reviveRate.rate, null);
});

test('mode groups keep team sizes apart', () => {
  assert.equal(modeGroupOf('squad-fpp'), 'squad');
  assert.equal(modeGroupOf('duo'), 'duo');
  assert.equal(modeGroupOf('solo-fpp'), 'solo');
  assert.equal(modeGroupOf('tdm'), 'other');
  assert.equal(modeGroupOf('zulu-fpp'), 'other');
});

test('newcombe difference flags only intervals that exclude zero', () => {
  const big = newcombeDifference(wilsonInterval(80, 100), wilsonInterval(20, 100));
  assert.equal(big.significant, true);
  assert.ok(big.low! > 0.3);
  const small = newcombeDifference(wilsonInterval(6, 10), wilsonInterval(5, 10));
  assert.equal(small.significant, false);
  assert.equal(newcombeDifference(wilsonInterval(0, 0), wilsonInterval(1, 2)).delta, null);
});

test('lineup analytics groups present members and compares with and without each one', () => {
  const make = (id: number, names: string[], rank: number) => ({
    ...matchOf(`l${id}`, 'Baltic_Main', rank, 900),
    timestamp: start + id * 1000,
    players: names.map((accountId) => ({
      ...matchOf('x', 'Baltic_Main', rank, 900).players[0]!,
      accountId,
      playerName: accountId,
      displayName: accountId,
      rank,
    })),
  });
  const matches = [
    ...Array.from({ length: 6 }, (_, index) => make(index, ['t1', 't2'], 3)),
    ...Array.from({ length: 6 }, (_, index) => make(10 + index, ['t1'], 25)),
  ];
  const result = buildLineupAnalytics({ matches, memberIds: ['t1', 't2'] });
  assert.equal(result.lineups.length, 2);
  assert.equal(result.lineups[0]!.size, 2);
  const t2 = result.members.find((member) => member.name === 't2')!;
  assert.equal(t2.withMatches, 6);
  assert.equal(t2.withoutMatches, 6);
  assert.equal(t2.withTop10.rate, 1);
  assert.equal(t2.withoutTop10.rate, 0);
  assert.equal(t2.difference.significant, true);
});

test('match series is chronological, per-player averaged and capped', () => {
  const matches = Array.from({ length: 200 }, (_, index) => ({
    ...matchOf(`s${index}`, 'Desert_Main', (index % 12) + 1, 900, 100 + index),
    timestamp: start + index * 1000,
  }));
  const series = buildMatchSeries({ matches: matches.reverse(), memberIds: ['t1', 't2'] });
  assert.equal(series.length, 150);
  assert.equal(series[0]!.matchId, 's50');
  assert.equal(series.at(-1)!.matchId, 's199');
  assert.equal(series.at(-1)!.damage, 299);
  assert.equal(series[0]!.mapLabel, '米拉玛');
});

test('death analysis stages deaths by teams alive, detects knock-then-kill and marks the squad wipe', () => {
  const telemetry = [
    raw('LogPlayerMakeGroggy', 100, them('e1'), us('t1'), { dBNOId: 'k1' }),
    raw('LogPlayerKill', 110, them('e1'), us('t1'), {
      dBNOId: 'k1',
      damageCauserName: 'WeapAUG_C',
    }),
    raw('LogPlayerKill', 600, them('e2', 'team-c'), us('t2'), { damageCauserName: 'WeapKar98k_C' }),
    {
      _T: 'LogGameStatePeriodic',
      common: { isGame: 1 },
      _D: new Date(start + 90_000).toISOString(),
      gameState: { elapsedTime: 90, numAlivePlayers: 80, numAliveTeams: 22 },
    },
    {
      _T: 'LogGameStatePeriodic',
      common: { isGame: 5 },
      _D: new Date(start + 500_000).toISOString(),
      gameState: { elapsedTime: 500, numAlivePlayers: 9, numAliveTeams: 3 },
    },
  ];
  const doc = normalizeBattleTelemetry(telemetry, matchOf('d', 'Baltic_Main', 4, 900));
  const records = analyzeDeaths(doc, ['t1', 't2']);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.stage, '开局');
  assert.equal(records[0]!.afterKnock, true);
  assert.equal(records[0]!.squadWipe, false);
  assert.equal(records[1]!.stage, '决赛圈');
  assert.equal(records[1]!.squadWipe, true);
  const summary = summarizeDeaths(records);
  assert.equal(summary.deaths, 2);
  assert.equal(summary.afterKnock.count, 1);
  assert.deepEqual(summary.wipeStages, [{ stage: '决赛圈', wipes: 1 }]);
  assert.equal(deathStageOf(null), '未知');
});

test('performance insights only flag significant differences and always carry evidence', () => {
  const make = (id: number, names: string[], rank: number) => ({
    ...matchOf(`i${id}`, 'Baltic_Main', rank, 900),
    timestamp: start + id * 1000,
    players: names.map((accountId) => ({
      ...matchOf('x', 'Baltic_Main', rank, 900).players[0]!,
      accountId,
      playerName: accountId,
      displayName: accountId,
      rank,
    })),
  });
  const matches = [
    ...Array.from({ length: 30 }, (_, index) => make(index, ['t1', 't2'], 3)),
    ...Array.from({ length: 30 }, (_, index) => make(100 + index, ['t1'], 25)),
  ];
  const input = { matches, memberIds: ['t1', 't2'] };
  const insights = buildPerformanceInsights({
    squad: buildSquadAnalytics(input),
    maps: buildMapAnalytics(input),
    lineups: buildLineupAnalytics(input),
    series: buildMatchSeries(input),
  });
  const member = insights.find((item) => item.id.startsWith('member-'));
  assert.ok(member && member.tone === 'good' && member.title.includes('t2'));
  assert.ok(insights.every((item) => item.evidence.length > 0 && item.detail.length > 0));
  assert.ok(insights.length <= INSIGHT_MAX);
  const flat = buildPerformanceInsights({
    squad: buildSquadAnalytics({ matches: matches.slice(0, 6), memberIds: ['t1'] }),
    maps: [],
    lineups: { lineups: [], members: [], notes: [] },
    series: [],
  });
  assert.equal(flat.length, 0);
});

test('combat insights flag a weak revive rate and post-knock deaths, and stay quiet on small samples', () => {
  const empty = emptyCombatQuality();
  const stats = {
    ...empty,
    groups: 40,
    knockedChains: 40,
    knockedRevived: 4,
    knockedKilled: 33,
    downedChains: 40,
    downedFinished: 30,
  };
  const combat = summarizeCombatQuality([stats]);
  const deathRecords = Array.from({ length: 40 }, (_, index) => ({
    stage: '中期' as const,
    weapon: 'AUG',
    afterKnock: index < 30,
    squadWipe: false,
  }));
  const insights = buildCombatInsights({
    combat,
    deaths: summarizeDeaths(deathRecords),
    landing: buildLandingPreference([]),
  });
  assert.ok(insights.some((item) => item.id === 'revive-weak' && item.tone === 'warn'));
  assert.ok(insights.some((item) => item.id === 'death-after-knock'));
  assert.ok(insights.some((item) => item.id === 'death-stage'));
  const quiet = buildCombatInsights({
    combat: summarizeCombatQuality([{ ...empty, knockedChains: 3, knockedRevived: 0 }]),
    deaths: summarizeDeaths([]),
    landing: buildLandingPreference([]),
  });
  assert.equal(quiet.length, 0);
});

const geo = (x: number, y: number, z = 0) => ({ x, y, z });
function character(
  accountId: string,
  teamId: number,
  location = geo(0, 0),
  extra: Record<string, unknown> = {},
) {
  return { accountId, teamId, location, isInBlueZone: false, zone: [], ...extra };
}

test('field telemetry measures damage by engagement distance, zone position, blue damage, contest and region', () => {
  const day = (seconds: number) => new Date(start + seconds * 1000).toISOString();
  const tracked = new Set(['t1', 't2']);
  const payload = [
    {
      _T: 'LogParachuteLanding',
      _D: day(100),
      common: { isGame: 0.1 },
      character: character('t1', 1, geo(100_000, 100_000)),
    },
    {
      _T: 'LogParachuteLanding',
      _D: day(101),
      common: { isGame: 0.1 },
      character: character('t2', 1, geo(100_000, 100_000)),
    },
    {
      _T: 'LogParachuteLanding',
      _D: day(100),
      common: { isGame: 0.1 },
      character: character('e1', 2, geo(100_000 + 30_000, 100_000)),
    },
    {
      _T: 'LogParachuteLanding',
      _D: day(100),
      common: { isGame: 0.1 },
      character: character('e2', 3, geo(100_000 + 300_000, 100_000)),
    },
    {
      _T: 'LogPlayerPosition',
      _D: day(110),
      common: { isGame: 1 },
      character: character('t1', 1, geo(100_000, 100_000), { zone: ['school'] }),
    },
    {
      _T: 'LogGameStatePeriodic',
      _D: day(200),
      common: { isGame: 2 },
      gameState: {
        safetyZonePosition: geo(100_000, 100_000),
        safetyZoneRadius: 100_000,
        numAliveTeams: 10,
      },
    },
    {
      _T: 'LogPlayerPosition',
      _D: day(210),
      common: { isGame: 2 },
      character: character('t1', 1, geo(110_000, 100_000)),
    },
    {
      _T: 'LogPlayerPosition',
      _D: day(220),
      common: { isGame: 2 },
      character: character('t2', 1, geo(300_000, 100_000), { isInBlueZone: true }),
    },
    // we hit an enemy from 50 m with a headshot, and an enemy hits us from 200 m
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(230),
      common: { isGame: 2 },
      damage: 40,
      damageTypeCategory: 'Damage_Gun',
      damageReason: 'HeadShot',
      damageCauserName: 'WeapAUG_C',
      attacker: character('t1', 1, geo(0, 0)),
      victim: character('e1', 2, geo(5_000, 0)),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(240),
      common: { isGame: 2 },
      damage: 30,
      damageTypeCategory: 'Damage_Gun',
      damageReason: 'TorsoShot',
      damageCauserName: 'WeapKar98k_C',
      attacker: character('e1', 2, geo(20_000, 0)),
      victim: character('t2', 1, geo(0, 0)),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(250),
      common: { isGame: 2 },
      damage: 7,
      damageTypeCategory: 'Damage_BlueZone',
      attacker: null,
      victim: character('t2', 1),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: day(5),
      common: { isGame: 0.2 },
      damage: 99,
      damageTypeCategory: 'Damage_Gun',
      attacker: character('t1', 1, geo(0, 0)),
      victim: character('e1', 2, geo(100, 0)),
    },
  ];
  const stats = analyzeFieldTelemetry(payload, tracked);
  assert.deepEqual(stats.distance.dealt, [0, 40, 0, 0]);
  assert.deepEqual(stats.distance.dealtHead, [0, 40, 0, 0]);
  assert.deepEqual(stats.distance.taken, [0, 0, 0, 30]);
  assert.deepEqual(stats.distance.weapons.AUG, [0, 40, 0, 0]);
  assert.equal(stats.zone.blueDamage, 7);
  assert.equal(stats.zone.damageTaken, 37);
  assert.equal(stats.zone.phases[1]!.samples, 1);
  assert.equal(stats.zone.phases[2]!.samples, 2);
  assert.equal(stats.zone.phases[2]!.blueSamples, 1);
  assert.deepEqual(stats.zone.phases[2]!.bins, [1, 0, 0, 1]);
  assert.equal(stats.landing.contestedTeams, 1);
  assert.equal(Math.round(stats.landing.nearestEnemyMeters!), 300);
  assert.equal(stats.landing.region, 'school');

  const summary = summarizeDistance([stats]);
  assert.equal(summary.bands[1]!.dealtShare, 1);
  assert.equal(summary.bands[3]!.takenShare, 1);
  assert.equal(summary.bands[1]!.headshotShare, 1);
  assert.equal(summary.longRangeGap, null, 'too little damage to call a gap');
  const zone = summarizeZone([stats]);
  assert.equal(zone.phases.find((phase) => phase.phase === 2)!.outsideRate.rate, 0.5);
  assert.equal(zone.blueDamageShare, 7 / 37);
});

test('fight analysis scores wins and losses, initiator, stage and roles', () => {
  const telemetry = [
    raw('LogPlayerTakeDamage', 10, them('e1'), us('t1'), { damage: 10 }),
    raw('LogPlayerTakeDamage', 12, us('t1'), them('e1'), { damage: 25 }),
    raw('LogPlayerMakeGroggy', 20, us('t1'), them('e1'), { dBNOId: 'd1' }),
    raw('LogPlayerKill', 30, us('t2'), them('e1'), { dBNOId: 'd1' }),
    raw('LogPlayerTakeDamage', 300, us('t2'), them('e2', 'team-c'), { damage: 20 }),
    raw('LogPlayerMakeGroggy', 310, them('e2', 'team-c'), us('t2'), { dBNOId: 'd2' }),
    raw('LogPlayerMakeGroggy', 315, them('e2', 'team-c'), us('t1'), { dBNOId: 'd3' }),
    raw('LogPlayerRevive', 330, us('t1'), us('t2')),
    {
      _T: 'LogGameStatePeriodic',
      common: { isGame: 1 },
      _D: new Date(start + 5_000).toISOString(),
      gameState: { elapsedTime: 5, numAlivePlayers: 80, numAliveTeams: 22 },
    },
    {
      _T: 'LogGameStatePeriodic',
      common: { isGame: 3 },
      _D: new Date(start + 200_000).toISOString(),
      gameState: { elapsedTime: 200, numAlivePlayers: 30, numAliveTeams: 8 },
    },
  ];
  const match = matchOf('fx', 'Baltic_Main', 5, 900);
  const result = reconstructBattleMatch({ match, telemetry, trackedPlayerIds: ['t1', 't2'] });
  const stats = analyzeFights(result, 'fx', ['t1', 't2']);
  assert.equal(stats.fights.length, 2);
  assert.deepEqual(
    stats.fights.map((fight) => [fight.outcome, fight.initiator, fight.stage]),
    [
      ['win', 'them', '开局'],
      ['lose', 'us', '后期'],
    ],
  );
  assert.equal(stats.roles.t1!.firstKnocks, 1);
  assert.equal(stats.roles.t2!.kills, 1);
  assert.equal(stats.roles.t2!.firstDowned, 1);
  assert.equal(stats.roles.t1!.revives, 1);

  const summary = summarizeFights(stats.fights);
  assert.equal(summary.overall.wins, 1);
  assert.equal(summary.byInitiator[0]!.losses, 1);
  assert.equal(summary.initiatorEdge.delta, null, 'two fights are too few to compare initiators');
  const roles = summarizeRoles(
    [stats],
    new Map([
      ['t1', 'T1'],
      ['t2', 'T2'],
    ]),
  );
  assert.equal(roles.find((role) => role.name === 'T1')!.counts.revives, 1);
  assert.deepEqual(
    roles.flatMap((role) => role.titles),
    [],
    'titles need at least 15 events',
  );
});

test('landing contest compares early wipes with and without nearby landings', () => {
  const members = new Set(['t1', 't2']);
  const input = (index: number, contested: number, rank: number, survival: number) => ({
    match: matchOf(`c${index}`, 'Baltic_Main', rank, survival),
    landings: [{ playerRef: 'x', xMeters: 2100, yMeters: 4100, cell: 'C5' }],
    memberIds: members,
    contestedTeams: contested,
    region: contested ? 'school' : 'pochinki',
  });
  const result = buildLandingPreference([
    ...Array.from({ length: 12 }, (_, index) => input(index, 0, 4, 1200)),
    ...Array.from({ length: 13 }, (_, index) => input(100 + index, 2, 20, 200)),
  ]);
  assert.equal(result.contest.matches, 25);
  assert.equal(result.contest.buckets[0]!.earlyWipe.rate, 0);
  assert.equal(result.contest.buckets[2]!.earlyWipe.rate, 1);
  assert.equal(result.contest.earlyWipeEdge.significant, true);
  assert.equal(result.contest.top10Edge.significant, true);
  assert.equal(result.maps[0]!.cells[0]!.region, 'school');
  const quiet = buildLandingPreference([input(1, 0, 4, 1200), input(2, 2, 20, 200)]);
  assert.equal(quiet.contest.earlyWipeEdge.delta, null);
});

test('field insights surface significant initiative, long-range and contest effects only', () => {
  const record = (outcome: 'win' | 'lose', initiator: 'us' | 'them') => ({
    outcome,
    initiator,
    stage: '中期' as const,
    thirdParty: false,
    teams: 2,
    durationSeconds: 40,
  });
  const records = [
    ...Array.from({ length: 24 }, () => record('win', 'us')),
    ...Array.from({ length: 6 }, () => record('lose', 'us')),
    ...Array.from({ length: 8 }, () => record('win', 'them')),
    ...Array.from({ length: 22 }, () => record('lose', 'them')),
  ];
  const fights = summarizeFights(records);
  const longBand = (dealt: number, taken: number): FieldMatchStats => ({
    distance: {
      dealt: [dealt * 2, 0, 0, dealt],
      dealtHead: [0, 0, 0, 0],
      taken: [taken, 0, taken * 2, taken * 2],
      takenHead: [0, 0, 0, 0],
      weapons: {},
    },
    zone: { phases: {}, blueDamage: 0, damageTaken: 0 },
    landing: { contestedTeams: null, nearestEnemyMeters: null, region: null },
  });
  const distance = summarizeDistance([longBand(500, 400)]);
  const landing = buildLandingPreference([]);
  const insights = buildFieldInsights({
    fights,
    distance,
    zone: summarizeZone([]),
    landing,
    roles: [],
  });
  assert.ok(insights.some((item) => item.id === 'fight-initiator' && item.tone === 'good'));
  assert.ok(insights.some((item) => item.id === 'distance-gap' && item.tone === 'warn'));
  assert.ok(insights.every((item) => item.evidence.length > 0));
  assert.equal(
    buildFieldInsights({
      fights: summarizeFights([]),
      distance: summarizeDistance([]),
      zone: summarizeZone([]),
      landing,
      roles: [],
    }).length,
    0,
  );
});
