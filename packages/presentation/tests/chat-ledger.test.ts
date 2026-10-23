import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPubgToolPresentation,
  renderPubgMatchList,
  renderPubgTeamDamage,
} from '../src/index.js';

const A = { playerId: 'account.a', name: 'SG_LabmemNo007' };
const B = { playerId: 'account.b', name: 'SG_LabmemNo004' };
const C = { playerId: 'account.c', name: 'kim_kkl' };
const event = (
  actor: typeof A,
  victim: typeof A,
  hitCount: number,
  damage: number,
  extra: Record<string, unknown>,
) => ({
  actorPlayerId: actor.playerId,
  victimPlayerId: victim.playerId,
  hitCount,
  damage,
  ...extra,
});
const kick = { source: 'MELEE', meleeKind: 'KICK', weapon: 'PlayerMale_A_C' };
const range = { from: '2026-10-18T21:00:00.000Z', to: '2026-10-19T21:00:00.000Z' };

const data = {
  direction: 'all directions',
  totalHitCount: 9,
  totalDamage: 200.25,
  complete: true,
  directions: [
    { actor: A, victim: B, hitCount: 5, damage: 120.5, complete: true },
    { actor: B, victim: A, hitCount: 3, damage: 60, complete: true },
    { actor: B, victim: C, hitCount: 1, damage: 19.75, complete: true },
  ],
  matches: [
    {
      matchId: 'm1',
      mapName: 'Desert_Main',
      placement: 12,
      startedAtLocal: '21:01',
      teamDamage: [
        event(A, B, 2, 40, kick),
        event(B, C, 1, 19.75, { source: 'VEHICLE', weapon: 'BP_PickupTruck_A_04_C' }),
      ],
    },
    {
      matchId: 'm2',
      mapName: 'Neon_Main',
      placement: 4,
      startedAtLocal: '23:04',
      teamDamage: [event(A, B, 3, 80.5, kick), event(B, A, 3, 60, kick)],
    },
  ],
};

test('chat team-damage ledger shows kinds, every direction, the worst match and the clean players', () => {
  const { presentation } = buildPubgToolPresentation(
    'pubg_query_team_damage',
    { status: 'ok', data, dataUpdatedAt: '2026-10-19T15:50:00.000Z', sourceRange: range },
    { timezone: 'Asia/Shanghai' },
  );
  const text = renderPubgTeamDamage(presentation as never, {
    timezone: 'Asia/Shanghai',
    chatEmphasis: true,
  });
  assert.match(text, /^🥊 10月19日星期一 队内误伤账本/u);
  assert.match(text, /总命中：\*\*9 次\*\*（飞踢 8 次、皮卡撞击 1 次）/u);
  assert.match(
    text,
    /1\. \*\*SG_LabmemNo007 ➡️ SG_LabmemNo004\*\*\n {2}• 总输出：\*\*5 次命中，造成 120\.5 伤害\*\*（飞踢 5 次）/u,
  );
  assert.match(text, /• 第 2 局（荣都 #4，23:04）：单局 \*\*140\.5 点（6 次命中）\*\*/u);
  assert.match(text, /清白名单：kim_kkl/u);
  // The plain (share/KOOK) rendering keeps its existing shape.
  assert.doesNotMatch(
    renderPubgTeamDamage(presentation as never, { timezone: 'Asia/Shanghai' }),
    /队内误伤账本/u,
  );
});

test('Gate (public agent) gets the same ledger, and its per-player totals lead the chat layout', () => {
  const { presentation, displayText } = buildPubgToolPresentation(
    'pubg_query_team_damage',
    {
      status: 'ok',
      data,
      dataUpdatedAt: '2026-10-19T15:50:00.000Z',
      presentationStyle: 'public_agent',
      teamDamage: { aggregateByActor: true },
    },
    { timezone: 'Asia/Shanghai', chatEmphasis: true },
  );
  assert.equal(
    (presentation as { ledger?: { highlights: unknown[] } }).ledger?.highlights.length,
    2,
  );
  assert.match(
    displayText,
    /\*\*队员误伤输出排名：\*\*\n1\. SG_LabmemNo007：120\.5 伤害 \/ 5 次\n2\. SG_LabmemNo004：79\.8 伤害 \/ 4 次/u,
  );
  assert.match(displayText, /名场面/u);
});

test('chat match list uses Chinese map and mode names and rounds damage', () => {
  const { presentation } = buildPubgToolPresentation(
    'pubg_search_matches',
    {
      status: 'ok',
      dataUpdatedAt: '2026-10-19T15:50:00.000Z',
      sourceRange: range,
      data: {
        total: 1,
        matches: [
          {
            matchId: 'm1',
            createdAt: '2026-10-19T13:24:00.000Z',
            mapName: 'Desert_Main',
            gameMode: 'squad',
            placement: 14,
            players: [{ name: 'SG_LabmemNo004', kills: 0, damageDealt: 27.903175 }],
          },
        ],
      },
    },
    { timezone: 'Asia/Shanghai' },
  );
  const text = renderPubgMatchList(presentation as never, {
    timezone: 'Asia/Shanghai',
    chatEmphasis: true,
  });
  assert.match(text, /^🗂️ 10月19日星期一 四排对局列表/u);
  assert.match(text, /米拉玛｜\*\*#14\*\*/u);
  assert.doesNotMatch(text, /Desert_Main|27\.903175/u);
});

test('reply check names the dropped card numbers, titles and directions, and ignores swapped names', async () => {
  const { missingReplyFacts } = await import('../src/index.js');
  const stats = {
    type: 'pubg_stats',
    status: 'ok',
    dataUpdatedAt: '2026-10-19T15:50:00.000Z',
    headline: 'x',
    operation: 'report',
    groupBy: 'player',
    summary: 'x',
    evidenceRefs: [],
    rows: [
      { label: 'kim_kkl', evidenceRefs: [], values: { kd: 1.5555, damage: 1935.27, assists: 4 } },
      {
        label: 'SG_LabmemNo004',
        evidenceRefs: [],
        values: { kd: 1.333, damage: 2630.04, assists: 5 },
      },
    ],
  } as never;
  const full =
    'Nori：KD 1.56，1935.3 伤害\n变态猴：KD 1.33，2630 伤害（全队伤害第一），5 助攻（全队助攻王）\n团队合计：…';
  assert.deepEqual(missingReplyFacts(stats, full), []);
  assert.deepEqual(
    missingReplyFacts(stats, 'Nori：KD 1.56，1935.3 伤害\n变态猴：2630 伤害\n团队合计'),
    [
      'SG_LabmemNo004 的 KD 1.33',
      'SG_LabmemNo004 的称号「全队助攻王」',
      'SG_LabmemNo004 的称号「全队伤害第一」',
    ],
  );
  const { presentation } = buildPubgToolPresentation(
    'pubg_query_team_damage',
    { status: 'ok', data, dataUpdatedAt: '2026-10-19T15:50:00.000Z' },
    {},
  );
  assert.deepEqual(missingReplyFacts(presentation, '120.5 ... 60 ... 19.8'), []);
  assert.deepEqual(missingReplyFacts(presentation, '120.5 ... 600'), [
    'SG_LabmemNo004 → SG_LabmemNo007 的 60 伤害',
    'SG_LabmemNo004 → kim_kkl 的 19.8 伤害',
  ]);
  assert.deepEqual(
    missingReplyFacts({ ...(stats as object), status: 'no_matches' } as never, ''),
    [],
  );
});
