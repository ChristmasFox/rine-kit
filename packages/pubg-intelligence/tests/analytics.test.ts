import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSquadAnalytics,
  buildWeaponEfficiency,
  normalizeWeaponName,
  summarizeSeries,
  theilSenSlope,
  wilsonInterval,
} from '../src/index.js';
import type { NormalizedMatch } from '@rine-kit/pubg-domain';

function match(index: number, damage: number, rank: number | null): NormalizedMatch {
  const timestamp = Date.parse('2026-10-01T00:00:00.000Z') + index * 3_600_000;
  return {
    schemaVersion: 3,
    matchId: `m${index}`,
    shard: 'steam',
    createdAt: new Date(timestamp).toISOString(),
    timestamp,
    matchType: 'competitive',
    gameMode: 'squad-fpp',
    isCompetitive: true,
    mapName: 'Erangel',
    duration: 1500,
    patchVersion: 'test',
    players: [
      {
        accountId: 'p1',
        playerName: 'Alpha',
        displayName: 'Alpha',
        rank,
        kills: Math.round(damage / 100),
        assists: 0,
        damage,
        dbnos: 1,
        revives: 0,
        headshotKills: 0,
        survivalTime: 1200,
        longestKill: 50,
        deaths: 1,
        deathSemantics: 'placement_proxy',
      },
    ],
  };
}

test('wilson interval brackets the rate and rejects invalid counts', () => {
  const rate = wilsonInterval(2, 10);
  assert.equal(rate.rate, 0.2);
  assert.ok(rate.low! < 0.2 && rate.high! > 0.2 && rate.low! >= 0 && rate.high! <= 1);
  assert.equal(wilsonInterval(3, 2).rate, null);
  assert.equal(wilsonInterval(0, 0).rate, null);
});

test('theil-sen ignores a single outlier and needs three points', () => {
  assert.equal(theilSenSlope([1, 2]), null);
  assert.equal(theilSenSlope([1, 2, 3, 4, 100, 6, 7]), 1);
});

test('form detection flags a sustained jump and holds back on short history', () => {
  const baseline = [100, 110, 90, 105, 95, 100];
  const hot = summarizeSeries('damage', '伤害', [...baseline, 200, 210, 190, 205, 195], 20);
  assert.equal(hot.form, 'hot');
  const cold = summarizeSeries('damage', '伤害', [...baseline, 20, 10, 30, 15, 25], 20);
  assert.equal(cold.form, 'cold');
  const steady = summarizeSeries('damage', '伤害', [...baseline, 100, 105, 95, 100, 98], 20);
  assert.equal(steady.form, 'steady');
  const short = summarizeSeries('damage', '伤害', [100, 300, 50], 20);
  assert.equal(short.form, 'insufficient');
  assert.equal(short.formZ, null);
});

test('squad analytics keeps unknown placement out of rates and reports sample notes', () => {
  const matches = [match(0, 100, 1), match(1, 120, null), match(2, 90, 5)];
  const result = buildSquadAnalytics({ matches, memberIds: ['p1'] });
  assert.equal(result.matches, 3);
  assert.equal(result.rankedMatches, 2);
  assert.equal(result.win.trials, 2);
  assert.equal(result.win.successes, 1);
  assert.equal(result.medianPlacement, 3);
  assert.equal(result.players[0]!.damageShare, 1);
  assert.ok(result.notes.some((note) => note.includes('样本不足')));
  assert.ok(result.notes.some((note) => note.includes('排名仅 2/3')));
});

test('weapon names merge across attack, damage and variant spellings and drop non-firearms', () => {
  assert.equal(normalizeWeaponName('Item_Weapon_BerylM762_C'), 'BerylM762');
  assert.equal(normalizeWeaponName('WeapBerylM762_C'), 'BerylM762');
  assert.equal(normalizeWeaponName('PanzerFaust100M_Projectile_C'), 'PanzerFaust');
  assert.equal(normalizeWeaponName('WeapPanzerFaust100M1_C'), 'PanzerFaust');
  assert.equal(normalizeWeaponName('ZU_Item_Weapon_Groza'), 'Groza');
  assert.equal(normalizeWeaponName('ZU_Item_Weapon_MG3_Reward'), 'MG3');
  assert.equal(normalizeWeaponName('Pickaxe'), null);
  assert.equal(normalizeWeaponName('Grenade'), null);
  const rows = buildWeaponEfficiency([
    { playerId: 'p1', weapon: 'BerylM762', shots: 100, hits: 0, damage: 0, knocks: 0, kills: 0 },
    {
      playerId: 'p1',
      weapon: 'WeapBerylM762',
      shots: 0,
      hits: 40,
      damage: 1000,
      knocks: 2,
      kills: 1,
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.rawHitRate, 0.4);
  assert.equal(rows[0]!.kills, 1);
});

test('weapon efficiency shrinks small samples toward the pooled hit rate', () => {
  const rows = buildWeaponEfficiency([
    { playerId: 'p1', weapon: 'M416', shots: 400, hits: 120, damage: 3600, knocks: 4, kills: 2 },
    { playerId: 'p1', weapon: 'Rare', shots: 4, hits: 4, damage: 200, knocks: 1, kills: 0 },
    { playerId: 'p1', weapon: 'Bad', shots: 5, hits: 6, damage: 0, knocks: 0, kills: 0 },
  ]);
  const rare = rows.find((row) => row.weapon === 'Rare')!;
  assert.equal(rare.rawHitRate, 1);
  assert.ok(rare.shrunkHitRate! < 0.5, 'a perfect 4-shot sample must not look perfect');
  assert.equal(rare.reliable, false);
  assert.equal(
    rows.some((row) => row.weapon === 'Bad'),
    false,
    'pooled hits above shots are discarded',
  );
  assert.equal(rows[0]!.weapon, 'M416');
});
