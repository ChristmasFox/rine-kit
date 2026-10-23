import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderSessionReview,
  SESSION_REVIEW_MAX_CHARS,
  validateSessionReviewPresentation,
  type SessionReviewPresentation,
} from '../src/index.js';

function review(overrides: Partial<SessionReviewPresentation> = {}): SessionReviewPresentation {
  return {
    type: 'pubg_session_review',
    version: 1,
    sessionKey: 'pubg-session:squad:m1',
    squadLabel: '小队',
    timezone: 'Asia/Shanghai',
    startAt: '2026-10-18T12:12:00.000Z',
    endAt: '2026-10-18T15:40:00.000Z',
    matchCount: 7,
    maps: [
      { mapName: 'Baltic_Main', count: 4 },
      { mapName: 'Desert_Main', count: 2 },
      { mapName: 'Tiger_Main', count: 1 },
    ],
    headline: '名次比平时好,但开局减员太多。',
    placements: [5, 12, 2, 18, 7, 3, 1],
    summary: {
      avgPlacement: 6.9,
      baselineAvgPlacement: 11.2,
      wins: 1,
      top10: 5,
      teamKnocks: 23,
      avgTeamDamage: 612,
    },
    findings: [
      {
        metric: 'early_out',
        tone: 'bad',
        confidence: 'clear',
        text: '7 场里 4 场开局 7 分钟内就有人出局,平时约 2/10。',
      },
      {
        metric: 'placement',
        tone: 'good',
        confidence: 'clear',
        text: '场均名次 6.9,比平时(11.2)明显靠前。',
      },
      {
        metric: 'tilt',
        tone: 'bad',
        confidence: 'observation',
        text: '早出局后的下一局平均 #15,其余场次 #6(仅本时段观察)。',
      },
    ],
    members: [
      {
        name: 'SG_007',
        matches: 7,
        kills: 6,
        knocks: 9,
        damagePerMatch: 980,
        earlyOuts: 0,
        revives: 1,
        tags: ['top_damage'],
      },
      {
        name: 'SG_004',
        matches: 7,
        kills: 4,
        knocks: 6,
        damagePerMatch: 640,
        earlyOuts: 1,
        revives: 0,
        tags: [],
      },
      {
        name: 'kim_kk',
        matches: 7,
        kills: 3,
        knocks: 5,
        damagePerMatch: 410,
        earlyOuts: 3,
        revives: 0,
        tags: ['early_outs'],
      },
      {
        name: 'SG_008',
        matches: 7,
        kills: 2,
        knocks: 3,
        damagePerMatch: 380,
        earlyOuts: 1,
        revives: 4,
        tags: ['medic'],
      },
    ],
    bestMatch: {
      matchId: 'm7',
      rank: 1,
      mapName: 'Desert_Main',
      text: '击倒 7 · 第 24 分钟赢下交战击倒 4 人',
    },
    worstMatch: { matchId: 'm4', rank: 18, mapName: 'Baltic_Main', text: '全队在第 5 分钟前出局' },
    suggestion: '前期先求稳:换个人少的落点,落地先集合再搜。',
    coverage: { telemetry: 6, total: 7 },
    link: 'https://pubg.example.test/?match=m7',
    generatedAt: '2026-10-18T16:30:00.000Z',
    ...overrides,
  };
}

test('the full review renders every section in order with local times and map names', () => {
  const text = renderSessionReview(review());
  assert.ok(text.startsWith('*🎮 时段复盘 · 10/18 20:12–23:40*'));
  assert.match(text, /7 场排位 · 艾伦格×4 米拉玛×2 泰戈/u);
  assert.match(text, /\*名次\* #5 #12 #2 #18 #7 #3 🏆/u);
  assert.match(text, /场均名次 6\.9\(你们平时 11\.2\)/u);
  const order = [
    '*一句话',
    '*名次*',
    '*结论*',
    '*队员*',
    '*最好一局*',
    '*最差一局*',
    '*下次试试*',
    '📎 6/7',
  ];
  const positions = order.map((marker) => text.indexOf(marker));
  assert.ok(
    positions.every((position) => position >= 0),
    `missing section in:\n${text}`,
  );
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
  assert.match(text, /SG_007 击倒 9 · 淘汰 6 · 伤害 980\/场 ⭐/u);
  assert.match(text, /kim_kk .*⚠ 早出局 3 次/u);
  assert.ok(text.length <= SESSION_REVIEW_MAX_CHARS);
  assert.ok(!text.includes('讲真话'));
  assert.match(text, /🔗 https:\/\/pubg\.example\.test\/\?match=m7$/u);
});

test('a long review drops whole sections from the least important up and never cuts the core', () => {
  const full = renderSessionReview(review());
  const trimmed = renderSessionReview(review(), { maxChars: full.length - 1 });
  assert.ok(!trimmed.includes('*最差一局*'));
  assert.ok(trimmed.includes('*最好一局*'));
  const tight = renderSessionReview(review(), { maxChars: 420 });
  for (const kept of [
    '*🎮 时段复盘',
    '*一句话',
    '*名次*',
    '*结论*',
    'https://pubg.example.test/?match=m7',
  ])
    assert.ok(tight.includes(kept), `${kept} dropped:\n${tight}`);
  for (const dropped of ['*最差一局*', '*最好一局*', '*队员*'])
    assert.ok(!tight.includes(dropped), `${dropped} kept:\n${tight}`);
  // Every line that survives is a whole line from the full render.
  const fullLines = new Set(full.split('\n'));
  for (const line of tight.split('\n'))
    assert.ok(
      fullLines.has(line) || line.startsWith('SG_') || line.startsWith('kim_'),
      `cut line: ${line}`,
    );
});

test('many matches fold into a single placement line', () => {
  const placements = Array.from({ length: 20 }, (_, index) => index + 2);
  const text = renderSessionReview(review({ matchCount: 20, placements }));
  assert.match(text, /\*名次\* #2 #3 #4 #5 #6 #7 … #16 #17 #18 #19 #20 #21/u);
});

test('a one-match session uses the short single-match layout', () => {
  const text = renderSessionReview(
    review({
      matchCount: 1,
      maps: [{ mapName: 'Tiger_Main', count: 1 }],
      placements: [11],
      summary: {
        avgPlacement: 11,
        baselineAvgPlacement: 11.2,
        wins: 0,
        top10: 0,
        teamKnocks: 2,
        avgTeamDamage: 253,
      },
      timeline: [
        { atSeconds: 669, text: '第一次交战,输了' },
        { atSeconds: 1500, text: '全队出局' },
      ],
      coverage: { telemetry: 1, total: 1 },
    }),
  );
  assert.ok(text.startsWith('*🎮 单局复盘'));
  assert.match(text, /\*名次\* #11 · 击倒 2 · 团队伤害 253/u);
  assert.match(text, /第 12 分钟 第一次交战,输了/u);
  assert.ok(!text.includes('*队员*') && !text.includes('2. '));
  assert.ok(text.length <= 400, `single review too long (${text.length})`);
});

test('no findings is said plainly instead of inventing one', () => {
  assert.match(renderSessionReview(review({ findings: [] })), /各项都在你们平时的正常波动范围内/u);
});

test('the contract rejects inconsistent or malformed reviews', () => {
  assert.equal(validateSessionReviewPresentation(review()).valid, true);
  assert.equal(validateSessionReviewPresentation(review({ placements: [1, 2] })).valid, false);
  assert.equal(
    validateSessionReviewPresentation(review({ coverage: { telemetry: 8, total: 7 } })).valid,
    false,
  );
  assert.equal(
    validateSessionReviewPresentation({
      ...review(),
      findings: [{ metric: 'x', tone: 'great', confidence: 'clear', text: 't' }],
    }).valid,
    false,
  );
  assert.throws(() =>
    renderSessionReview({ ...review(), type: 'other' } as unknown as SessionReviewPresentation),
  );
});
