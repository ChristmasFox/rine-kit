import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  classifyResearchQuestion,
  buildResearchReport,
  buildResearchSquads,
  ExperimentRunStore,
  NaturalLanguageResearchPlanner,
  redactSensitiveText,
  type ResearchIntent,
} from '../src/index.js';
import type { NormalizedMatch } from '@rine-kit/pubg-domain';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    prepare(sql: string): { get(): { count: number } };
    close(): void;
  };
};

const matches: NormalizedMatch[] = [
  {
    schemaVersion: 3,
    matchId: 'match-1',
    shard: 'steam',
    createdAt: '2026-10-05T12:00:00.000Z',
    timestamp: Date.parse('2026-10-05T12:00:00.000Z'),
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
        rank: 1,
        kills: 3,
        assists: 1,
        damage: 230,
        dbnos: 3,
        revives: 0,
        headshotKills: 1,
        survivalTime: 1500,
        longestKill: 100,
        deaths: 0,
        deathSemantics: 'placement_proxy',
      },
      {
        accountId: 'p2',
        playerName: 'Beta',
        displayName: 'Beta',
        rank: 1,
        kills: 2,
        assists: 1,
        damage: 170,
        dbnos: 2,
        revives: 1,
        headshotKills: 1,
        survivalTime: 1500,
        longestKill: 80,
        deaths: 0,
        deathSemantics: 'placement_proxy',
      },
    ],
  },
  {
    schemaVersion: 3,
    matchId: 'match-2',
    shard: 'steam',
    createdAt: '2026-10-12T12:00:00.000Z',
    timestamp: Date.parse('2026-10-12T12:00:00.000Z'),
    matchType: 'competitive',
    gameMode: 'squad-fpp',
    isCompetitive: true,
    mapName: 'Miramar',
    duration: 1400,
    patchVersion: 'test',
    players: [
      {
        accountId: 'p1',
        playerName: 'Alpha',
        displayName: 'Alpha',
        rank: 4,
        kills: 1,
        assists: 0,
        damage: 80,
        dbnos: 1,
        revives: 0,
        headshotKills: 0,
        survivalTime: 1100,
        longestKill: 50,
        deaths: 1,
        deathSemantics: 'placement_proxy',
      },
      {
        accountId: 'p2',
        playerName: 'Beta',
        displayName: 'Beta',
        rank: 4,
        kills: 2,
        assists: 0,
        damage: 120,
        dbnos: 2,
        revives: 0,
        headshotKills: 0,
        survivalTime: 1100,
        longestKill: 70,
        deaths: 1,
        deathSemantics: 'placement_proxy',
      },
    ],
  },
  {
    schemaVersion: 3,
    matchId: 'other-team',
    shard: 'steam',
    createdAt: '2026-10-13T12:00:00.000Z',
    timestamp: Date.parse('2026-10-13T12:00:00.000Z'),
    matchType: 'competitive',
    gameMode: 'squad-fpp',
    isCompetitive: true,
    mapName: 'Taego',
    duration: 1000,
    patchVersion: 'test',
    players: [
      {
        accountId: 'p3',
        playerName: 'Gamma',
        displayName: 'Gamma',
        rank: 2,
        kills: 4,
        assists: 0,
        damage: 500,
        dbnos: 4,
        revives: 0,
        headshotKills: 0,
        survivalTime: 1000,
        longestKill: 100,
        deaths: 1,
        deathSemantics: 'placement_proxy',
      },
      {
        accountId: 'p4',
        playerName: 'Delta',
        displayName: 'Delta',
        rank: 2,
        kills: 1,
        assists: 2,
        damage: 150,
        dbnos: 1,
        revives: 1,
        headshotKills: 0,
        survivalTime: 1000,
        longestKill: 50,
        deaths: 1,
        deathSemantics: 'placement_proxy',
      },
    ],
  },
];

const squad = { label: '小队 A', memberIds: ['p1', 'p2'] };
const summaryIntent: ResearchIntent = { action: 'summary', metric: 'damage', groupBy: null };

test('local research planner recognizes trends, member comparisons, maps, and telemetry coverage', async () => {
  assert.deepEqual(classifyResearchQuestion('最近比赛的平均伤害趋势'), {
    action: 'trend',
    metric: 'damage',
    groupBy: 'week',
  });
  assert.deepEqual(classifyResearchQuestion('比较队员的击杀和伤害'), {
    action: 'player_comparison',
    metric: 'kills',
    groupBy: 'player',
  });
  assert.deepEqual(classifyResearchQuestion('SG_LabmemNo007 近 10 场打法'), {
    action: 'player_comparison',
    metric: 'damage',
    groupBy: 'player',
  });
  assert.deepEqual(classifyResearchQuestion('按地图拆分前十率'), {
    action: 'map_breakdown',
    metric: 'top10',
    groupBy: 'map',
  });
  assert.equal(classifyResearchQuestion('Telemetry 缓存覆盖情况').action, 'telemetry_coverage');
  assert.equal(classifyResearchQuestion('你好').action, 'unsupported');
  assert.equal(
    (await new NaturalLanguageResearchPlanner().plan('最近一周整体表现')).source,
    'local-rule',
  );
});

test('research text redaction removes phone-like values, credentials, and local paths', () => {
  const phone = '13' + '8' + '0'.repeat(8);
  const credential = 'sk-' + 'a'.repeat(24);
  assert.equal(
    redactSensitiveText(`联系 ${phone}，token ${credential}`),
    '联系 [手机号已隐藏]，token [凭据已隐藏]',
  );
  assert.equal(
    redactSensitiveText('数据库 /DATA/AppData/openclaw/data/private.sqlite'),
    '数据库 [路径已隐藏]',
  );
  assert.equal(redactSensitiveText('配置 ~/.config/amadeus/private.json'), '配置 [路径已隐藏]');
});

test('research aggregates only the selected roster and date window with linked match evidence', () => {
  const report = buildResearchReport({
    matches,
    squad,
    intent: summaryIntent,
    fromMs: Date.parse('2026-10-06T00:00:00.000Z'),
    toMs: Date.parse('2026-10-14T00:00:00.000Z'),
    telemetryMatchIds: new Set(['match-2']),
  });
  assert.equal(report.scope.selectedMatches, 1);
  assert.equal(report.summary.totalDamage, 200);
  assert.equal(report.summary.totalKills, 3);
  assert.equal(report.summary.wins, 0);
  assert.equal(report.telemetry.currentCacheMatches, 1);
  assert.deepEqual(
    report.evidence.map((item) => item.matchId),
    ['match-2'],
  );
  assert.equal(report.status, 'ok');
});

test('weekly and map analyses retain their bucket counts and display rates correctly', () => {
  const trend = buildResearchReport({
    matches,
    squad,
    intent: { action: 'trend', metric: 'damage', groupBy: 'week' },
  });
  assert.equal(trend.breakdown.length, 2);
  assert.equal(trend.breakdown[0]?.average, 400);
  const maps = buildResearchReport({
    matches,
    squad,
    intent: { action: 'map_breakdown', metric: 'top10', groupBy: 'map' },
  });
  assert.deepEqual(
    maps.breakdown.map((item) => item.label),
    ['Erangel', 'Miramar'],
  );
  assert.equal(maps.breakdown[0]?.average, 1);
});

test('inconsistent team placements remain unknown and are excluded from win-rate denominators', () => {
  const inconsistent = {
    ...matches[0]!,
    matchId: 'rank-conflict',
    players: matches[0]!.players.map((player, index) => ({ ...player, rank: index === 0 ? 1 : 3 })),
  };
  const report = buildResearchReport({
    matches: [inconsistent],
    squad,
    intent: { action: 'summary', metric: 'wins', groupBy: null },
  });
  assert.equal(report.scope.selectedMatches, 1);
  assert.equal(report.summary.rankedMatches, 0);
  assert.equal(report.summary.wins, 0);
  assert.equal(report.summary.winRate, null);
  assert.equal(report.evidence[0]?.value, '排名未知');
});

test('squad discovery groups repeated co-play rosters without exposing account IDs in member labels', () => {
  const squads = buildResearchSquads(matches.slice(0, 2));
  assert.equal(squads.length, 1);
  assert.equal(squads[0]?.members.length, 2);
  assert.equal(squads[0]?.matchCount, 2);
  assert.deepEqual(squads[0]?.members.map((member) => member.name).sort(), ['Alpha', 'Beta']);
});

test('experiment results persist in a private database separate from the source cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-intelligence-store-'));
  const path = join(root, 'experiments.sqlite');
  try {
    const store = new ExperimentRunStore(path);
    const runId = store.save({
      question: 'damage trend',
      intent: { action: 'trend' },
      source: 'local-rule',
      report: { count: 2 },
    });
    assert.ok(runId.length > 10);
    store.saveBattleReview({
      matchId: 'match-1',
      battleId: 'battle-0123456789ab',
      label: 'correct',
    });
    store.saveBattleReview({
      matchId: 'match-1',
      battleId: 'battle-0123456789ab',
      label: 'insufficient_inference',
    });
    assert.deepEqual(
      store.listBattleReviews('match-1').map((review) => [review.battleId, review.label]),
      [['battle-0123456789ab', 'insufficient_inference']],
    );
    store.close();
    const database = new DatabaseSync(path);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM research_runs').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM battle_reviews').get().count, 1);
    database.close();
    const reopened = new ExperimentRunStore(path);
    assert.equal(reopened.listBattleReviews('match-1')[0]?.label, 'insufficient_inference');
    reopened.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('experiment store creates private child directories without changing an existing parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-intelligence-parent-mode-'));
  const directory = join(root, 'private-experiments');
  const path = join(directory, 'experiments.sqlite');
  try {
    chmodSync(root, 0o755);
    const store = new ExperimentRunStore(path);
    store.close();
    assert.equal(statSync(root).mode & 0o777, 0o755);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
