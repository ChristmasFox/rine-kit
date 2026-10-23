import assert from 'node:assert/strict';
import test from 'node:test';
import {
  containsInternalTimeTerms,
  adaptWorldlineNotification,
  buildPubgToolPresentation,
  formatDisplayRange,
  formatDisplayTime,
  renderOwnerNotification,
  renderPubgMatchReview,
  renderPubgPeriodReview,
  renderWorldlineNotification,
  selectWorldlineTheme,
  WORLDLINE_THEME_LABELS,
  WORLDLINE_THEMES,
  validateOwnerNotificationPresentation,
  validatePubgMatchReviewPresentation,
  validatePubgPeriodReviewPresentation,
  validatePubgPresentation,
  PUBG_PRESENTATION_REGISTRY,
} from '../src/index.js';

test('display time uses Beijing-friendly same-day and cross-day forms', () => {
  const now = '2026-09-20T15:00:00.000Z';
  assert.equal(formatDisplayTime('2026-09-20T15:05:00.000Z', { now }), '23:05');
  assert.equal(formatDisplayTime('2026-09-19T15:05:00.000Z', { now }), '2026-09-19 23:05');
  assert.equal(
    formatDisplayRange('2026-09-19T22:00:00.000Z', '2026-09-20T22:00:00.000Z', { now }),
    '2026-09-20 06:00 至 2026-09-21 06:00',
  );
});

test('review contract rejects missing structure and unknown evidence', () => {
  const invalid = validatePubgMatchReviewPresentation(
    {
      type: 'pubg_match_review',
      headline: 'match',
      overview: { placement: 1, kills: 0, assists: null, damage: 10, dbnos: 1, revives: null },
      keyMoments: [],
      highlights: [],
      improvements: [],
      analysis: 'ok',
      dataUpdatedAt: '2026-09-20T15:00:00.000Z',
      evidenceRefs: ['missing'],
    },
    new Set(['known']),
  );
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join('\n'), /unknown evidence/);
  assert.equal(validatePubgMatchReviewPresentation({ type: 'pubg_match_review' }).valid, false);
});

test('owner notification contract is hard validated and rendered deterministically', () => {
  const presentation = {
    type: 'owner_notification' as const,
    eventType: 'test',
    severity: 'success' as const,
    significance: 'notable' as const,
    theme: 'worldline_observation' as const,
    eventKey: 'test:1',
    source: 'test',
    headline: '测试通知',
    facts: [{ label: '计数', value: 2, evidenceRefs: [] }],
    summary: '事实摘要',
    dataUpdatedAt: '2026-09-20T15:05:00.000Z',
    occurredAt: '2026-09-20T15:10:00.000Z',
    worldLineClosing: true,
  };
  assert.equal(validateOwnerNotificationPresentation(presentation).valid, true);
  const output = renderOwnerNotification(presentation, { now: '2026-09-20T15:10:00.000Z' });
  assert.match(output, /数据更新时间：23:05/u);
  assert.match(output, /El Psy Kongroo\.$/u);
  assert.equal(containsInternalTimeTerms(output), false);
  assert.equal(
    validateOwnerNotificationPresentation({
      ...presentation,
      facts: [{ label: 'bad', value: { x: 1 }, evidenceRefs: [] }],
    }).valid,
    false,
  );
});

test('worldline policy keeps theme separate from severity and preserves structured facts', () => {
  const intent = {
    type: 'worldline_notification_intent' as const,
    eventType: 'price_changed',
    kind: 'price_changed',
    severity: 'warning' as const,
    significance: 'major' as const,
    eventKey: 'radar:1',
    source: 'product-radar',
    headline: '价格变化',
    facts: [{ label: '标题', value: '相机', evidenceRefs: ['listing:1'] }],
    links: [{ label: '查看', url: 'https://example.test/item/1', evidenceRefs: ['listing:1'] }],
    occurredAt: '2026-09-20T15:10:00.000Z',
  };
  const presentation = adaptWorldlineNotification(intent);
  assert.equal(presentation.theme, 'worldline_divergence');
  assert.equal(presentation.significance, 'major');
  assert.match(presentation.headline, /世界线偏移/u);
  assert.equal(presentation.facts[0]?.value, '相机');
  assert.equal(
    renderWorldlineNotification(intent, { now: intent.occurredAt }).includes(
      'https://example.test/item/1',
    ),
    true,
  );
  assert.equal(selectWorldlineTheme({ ...intent, kind: 'price_changed' }), 'worldline_divergence');
  assert.equal(selectWorldlineTheme({ ...intent, kind: 'scheduled_report' }), 'dmail');
});

test('worldline policy covers every formal theme and rejects misleading upgrades', () => {
  const base = {
    type: 'worldline_notification_intent' as const,
    eventType: 'test',
    kind: 'ordinary_event',
    severity: 'info' as const,
    significance: 'notable' as const,
    eventKey: 'worldline:test',
    source: 'test',
    headline: '测试',
    facts: [{ label: '未知事实', value: null, evidenceRefs: [] }],
    occurredAt: '2026-09-20T15:10:00.000Z',
  };
  const cases = [
    ['ordinary_event', 'worldline_observation', '世界线观测'],
    ['price_changed', 'worldline_divergence', '世界线偏移'],
    [
      'operation_completed',
      'worldline_convergence',
      '世界线收束',
      { severity: 'success' as const },
    ],
    ['scheduled_report', 'dmail', 'D-Mail'],
    ['state_drift', 'reading_steiner', 'Reading Steiner'],
    ['incident', 'attractor_field', '吸引子场', { correlation: { occurrenceCount: 3 } }],
    ['security_scan', 'rounder_activity', 'Rounder 活动'],
    [
      'confirmed_compromise',
      'sern_alert',
      'SERN 警报',
      { severity: 'error' as const, significance: 'critical' as const },
    ],
    ['critical_dependency', 'ibn_5100', 'IBN 5100'],
    ['rollback', 'time_leap', '时间跳跃'],
    ['migration_readiness', 'operation_skuld', 'Operation Skuld · 斯库尔德行动'],
  ] as const;
  for (const [kind, expected, label, overrides] of cases) {
    const intent = { ...base, kind, ...(overrides ?? {}) };
    assert.equal(selectWorldlineTheme(intent), expected);
    const presentation = adaptWorldlineNotification(intent);
    assert.equal(presentation.theme, expected);
    assert.match(presentation.headline, new RegExp(label, 'u'));
    assert.equal(presentation.facts[0]?.value, null);
  }
  assert.deepEqual(Object.keys(WORLDLINE_THEME_LABELS).sort(), [...WORLDLINE_THEMES].sort());
  assert.equal(
    selectWorldlineTheme({ ...base, kind: 'confirmed_compromise' }),
    'worldline_observation',
  );
  assert.equal(
    selectWorldlineTheme({ ...base, kind: 'incident', correlation: { occurrenceCount: 2 } }),
    'worldline_observation',
  );
  assert.equal(selectWorldlineTheme({ ...base, kind: 'restart' }), 'worldline_observation');
  assert.equal(
    selectWorldlineTheme({ ...base, kind: 'ordinary_event', severity: 'success' }),
    'worldline_observation',
  );
  const output = renderWorldlineNotification(
    { ...base, kind: 'ordinary_event' },
    { now: base.occurredAt },
  );
  assert.match(output, /未知/u);
  assert.doesNotMatch(output, /Asia\/Shanghai|UTC\+08/u);
  assert.doesNotMatch(output, /SREN/u);
});

test('PUBG renderer preserves null as unknown instead of inventing zero', () => {
  const presentation = {
    type: 'pubg_match_review' as const,
    status: 'partial' as const,
    headline: '第1局 · Erangel',
    overview: { placement: null, kills: null, assists: 1, damage: 20, dbnos: null, revives: 0 },
    keyMoments: [],
    highlights: [],
    improvements: [],
    analysis: '证据有限',
    dataUpdatedAt: '2026-09-20T15:00:00.000Z',
    evidenceRefs: [],
  };
  const output = renderPubgMatchReview(presentation, { now: '2026-09-20T15:05:00.000Z' });
  assert.match(output, /排名：未知/u);
  assert.match(output, /击杀：未知/u);
  assert.doesNotMatch(output, /击杀：0/u);
});

test('PUBG period review keeps Domain order and renders cross-day match times', () => {
  const presentation = {
    type: 'pubg_period_review' as const,
    status: 'ok' as const,
    period: { label: '昨天对局' },
    summary: '共 2 场',
    orderedMatches: [
      { matchId: 'm1', label: '第一局', startedAt: '2026-09-19T15:00:00.000Z', placement: 2 },
      { matchId: 'm2', label: '第二局', startedAt: null, placement: null },
    ],
    highlights: [],
    patterns: [],
    analysis: '证据有限',
    dataUpdatedAt: '2026-09-20T15:05:00.000Z',
    evidenceRefs: [],
  };
  assert.equal(validatePubgPeriodReviewPresentation(presentation).valid, true);
  const output = renderPubgPeriodReview(presentation, { now: '2026-09-20T15:05:00.000Z' });
  assert.match(output, /第一局 （2026-09-19 23:00）：第2名/u);
  assert.match(output, /第二局 ：第未知名/u);
  assert.match(output, /数据更新时间：23:05/u);
});

test('PUBG team damage presentation aggregates full and partial facts without losing field semantics', () => {
  const base = {
    dataUpdatedAt: '2026-09-20T15:05:00.000Z',
    evidenceRefs: { matchIds: ['m1'], playerIds: ['p1', 'p2'], fields: ['teamDamage'] },
    queryResolved: {},
    teamDamage: { aggregateByActor: true },
  };
  const full = buildPubgToolPresentation(
    'pubg_query_team_damage',
    {
      ...base,
      status: 'ok',
      coverage: {
        status: 'OK',
        complete: true,
        freshness: 'fresh',
        checkedAt: base.dataUpdatedAt,
        coverageStart: null,
        coverageEnd: null,
        sourceUnavailable: false,
      },
      data: {
        direction: 'all directions',
        source: null,
        meleeKind: null,
        totalHitCount: 6,
        totalDamage: 20,
        directions: [
          {
            actor: { playerId: 'p1', name: 'Alice' },
            victim: { playerId: 'p2', name: 'Bob' },
            hitCount: 2,
            damage: 10,
            knownHitCount: 2,
            knownDamage: 10,
            complete: true,
            evidenceRefs: ['m1'],
          },
          {
            actor: { playerId: 'p1', name: 'Alice' },
            victim: { playerId: 'p2', name: 'Bob' },
            hitCount: 1,
            damage: 4,
            knownHitCount: 1,
            knownDamage: 4,
            complete: true,
            evidenceRefs: ['m1'],
          },
          {
            actor: { playerId: 'p2', name: 'Bob' },
            victim: { playerId: 'p1', name: 'Alice' },
            hitCount: 3,
            damage: 6,
            knownHitCount: 3,
            knownDamage: 6,
            complete: true,
            evidenceRefs: ['m1'],
          },
        ],
      },
    },
    { now: base.dataUpdatedAt, includeCoverage: true },
  );
  assert.equal(validatePubgPresentation(full.presentation).valid, true);
  assert.equal(full.presentation.type, 'pubg_team_damage');
  if (full.presentation.type !== 'pubg_team_damage') return;
  assert.equal(full.presentation.rankingBasis, 'damage');
  assert.deepEqual(
    full.presentation.actorTotals?.map((row) => [
      row.actor,
      row.damage,
      row.hitCount,
      row.knownDamage,
      row.position,
    ]),
    [
      ['Alice', 14, 3, 14, 1],
      ['Bob', 6, 3, 6, 2],
    ],
  );
  assert.match(full.displayText, /Alice：14 伤害 \/ 3 次/u);
  assert.match(full.displayText, /数据覆盖：完整（OK）/u);
  assert.match(full.displayText, /数据新鲜度：较新/u);

  const partial = buildPubgToolPresentation(
    'pubg_query_team_damage',
    {
      ...base,
      status: 'partial',
      coverage: {
        status: 'PARTIAL',
        complete: false,
        freshness: 'unknown',
        checkedAt: base.dataUpdatedAt,
        coverageStart: null,
        coverageEnd: null,
        sourceUnavailable: false,
      },
      data: {
        direction: 'all directions',
        source: null,
        meleeKind: null,
        totalHitCount: null,
        totalDamage: null,
        directions: [
          {
            actor: { playerId: 'p1', name: 'Alice' },
            victim: { playerId: 'p2', name: 'Bob' },
            hitCount: null,
            damage: null,
            knownHitCount: 2,
            knownDamage: 10,
            complete: false,
            evidenceRefs: ['m1'],
          },
        ],
      },
    },
    { now: base.dataUpdatedAt, includeCoverage: true },
  );
  assert.equal(validatePubgPresentation(partial.presentation).valid, true);
  assert.equal(partial.presentation.type, 'pubg_team_damage');
  if (partial.presentation.type !== 'pubg_team_damage') return;
  assert.equal(partial.presentation.rankingBasis, 'knownDamage');
  assert.deepEqual(
    partial.presentation.actorTotals?.map((row) => [
      row.damage,
      row.hitCount,
      row.knownDamage,
      row.knownHitCount,
    ]),
    [[null, null, 10, 2]],
  );
  assert.match(partial.displayText, /Alice：已知至少 10 伤害 \/ 2 次/u);
  assert.match(partial.displayText, /数据覆盖：不完整（PARTIAL）/u);
  assert.match(partial.displayText, /数据新鲜度：未知/u);
});

test('every registered PUBG native tool has a validated presentation and displayText', () => {
  for (const toolName of Object.keys(PUBG_PRESENTATION_REGISTRY)) {
    const result = buildPubgToolPresentation(
      toolName,
      {
        status: 'ok',
        data: {},
        dataUpdatedAt: '2026-09-20T15:05:00.000Z',
        evidenceRefs: { matchIds: [], playerIds: [], fields: [] },
        queryResolved: {},
      },
      { now: '2026-09-20T15:10:00.000Z' },
    );
    assert.equal(validatePubgPresentation(result.presentation).valid, true, toolName);
    assert.match(result.displayText, /数据更新时间/u, toolName);
  }
});
