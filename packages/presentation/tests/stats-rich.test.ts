import assert from 'node:assert/strict';
import test from 'node:test';
import { assignStatTitles, renderPubgStats, type PubgStatsPresentation } from '../src/index.js';

const presentation: PubgStatsPresentation = {
  type: 'pubg_stats',
  status: 'ok',
  dataUpdatedAt: '2026-10-19T07:32:00.000Z',
  headline: '指定时间',
  operation: 'report',
  groupBy: 'player',
  summary: '共 12 场。',
  evidenceRefs: ['m1'],
  rows: [
    {
      label: 'kim_kkl',
      position: 1,
      evidenceRefs: [],
      values: {
        matches: 3,
        kills: 5,
        assists: 1,
        damage: 1283.71166,
        avg_damage: 427.90388666666666,
        kd: 1.6666666666666667,
        deaths: 3,
        wins: 0,
        top10: 2,
        dbnos: 9,
        revives: 1,
        headshot_kills: 2,
        longest_kill: 314.31113,
        denominatorZero: 0,
      },
    },
    {
      label: 'SG_LabmemNo004',
      position: 2,
      evidenceRefs: [],
      values: {
        matches: 8,
        kills: 10,
        assists: 11,
        damage: 2743.0386630000003,
        avg_damage: 342.87983287500003,
        kd: 1.4285714285714286,
        deaths: 7,
        wins: 1,
        top10: 6,
        dbnos: 15,
        revives: 3,
        headshot_kills: 3,
        longest_kill: 318.54013,
        denominatorZero: 0,
      },
    },
    {
      label: 'SG_LabmemNo007',
      position: 3,
      evidenceRefs: [],
      values: {
        matches: 12,
        kills: 10,
        assists: 4,
        damage: 1614.9,
        avg_damage: 134.575,
        kd: 0.909,
        deaths: 11,
        wins: 1,
        top10: 8,
        dbnos: 12,
        revives: 7,
        longest_kill: 192,
      },
    },
  ],
};

test('localized stats round floats, hide internal keys, and award clear team titles', () => {
  const text = renderPubgStats(presentation, { localizedMetrics: true, timezone: 'Asia/Shanghai' });
  assert.match(text, /1283\.7 伤害/u);
  assert.match(text, /KD 1\.67/u);
  assert.doesNotMatch(text, /denominatorZero/u);
  assert.doesNotMatch(text, /matches=/u);
  assert.match(text, /全队助攻王/u);
  assert.match(text, /全队伤害第一/u);
  assert.match(text, /破点王/u);
  assert.match(text, /全队救援王/u);
  assert.match(text, /团队合计：/u);
  const titles = assignStatTitles(presentation.rows);
  assert.deepEqual(titles.get(1), ['全队助攻王', '全队伤害第一', '破点王']);
  assert.deepEqual(titles.get(2), ['全队救援王']);
});

test('raw key=value mode still exists but rounds numbers and hides internal keys', () => {
  const text = renderPubgStats(presentation, { timezone: 'Asia/Shanghai' });
  assert.match(text, /damage=1283\.7/u);
  assert.doesNotMatch(text, /denominatorZero/u);
  assert.doesNotMatch(text, /全队助攻王/u);
});

test('chat emphasis bolds names, titles and totals and drops filler metrics', () => {
  const text = renderPubgStats(presentation, { chatEmphasis: true, timezone: 'Asia/Shanghai' });
  assert.match(text, /🥇 \*\*kim_kkl\*\*/u);
  assert.match(text, /🥈 \*\*SG_LabmemNo004\*\*\n• \*\*出战 8 局\*\*：/u);
  assert.match(text, /• 个人数据：\*\*KD 1\.43\*\*，场均伤害 342\.9，最远击杀 318\.5m/u);
  assert.match(text, /^🏆 /u);
  assert.match(text, /\*\*11 助攻（全队助攻王）\*\*/u);
  assert.match(text, /\*\*团队合计：[^*]+\*\*/u);
  assert.match(text, /3 爆头/u);
  assert.match(text, /最远击杀 318\.5m/u);
  assert.doesNotMatch(text, /场均排名|前十率|生存/u);
  assert.doesNotMatch(
    renderPubgStats(presentation, { localizedMetrics: true, timezone: 'Asia/Shanghai' }),
    /\*\*/u,
  );
});
