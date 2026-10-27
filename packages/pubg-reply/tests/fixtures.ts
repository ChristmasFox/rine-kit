/*
 * Domain envelopes shaped like what PubgDomainService returns, used to prove that the reply glue gives byte-identical
 * output to Lab's (see tests/golden and scripts/gen-golden-from-lab.ts).
 */
const range = { from: '2026-10-18T22:00:00.000Z', to: '2026-10-19T22:00:00.000Z', timezone: 'Asia/Shanghai' };
const coverage = {
  status: 'OK',
  complete: true,
  coverageStart: range.from,
  coverageEnd: range.to,
  checkedAt: '2026-10-19T15:50:00.000Z',
  failedMatchIds: [],
  sourceUnavailable: false,
  freshness: 'fresh',
};
const evidence = (matchIds: string[]) => ({ matchIds, playerIds: ['account.a', 'account.b', 'account.c'], fields: [], calculation: 'fixture' });
const base = { asOf: '2026-10-19T15:50:00.000Z', metricVersion: 'pubg-metrics-v1', coverage };

const row = (label: string, position: number, values: Record<string, number>) => ({ label, position, metrics: values, evidenceRefs: [] });

const A = { playerId: 'account.a', name: 'SG_LabmemNo007' };
const B = { playerId: 'account.b', name: 'SG_LabmemNo004' };
const C = { playerId: 'account.c', name: 'kim_kkl' };
const kick = { source: 'MELEE', meleeKind: 'KICK', weapon: 'PlayerMale_A_C' };
const hit = (actor: typeof A, victim: typeof A, hitCount: number, damage: number, extra: Record<string, unknown>) => ({
  actorPlayerId: actor.playerId,
  victimPlayerId: victim.playerId,
  hitCount,
  damage,
  ...extra,
});

export interface Fixture {
  tool: string;
  /** Shaped like a Domain ToolEnvelope. */
  envelope: object;
}

export const FIXTURES: Record<string, Fixture> = {
  stats_ok: {
    tool: 'pubg_query_stats',
    envelope: {
      ...base,
      status: 'ok',
      data: {
        operation: 'report',
        groupBy: 'player',
        summary: { uniqueMatchCount: 12 },
        rows: [
          row('kim_kkl', 1, { matches: 3, kills: 5, assists: 1, damage: 1283.71166, avg_damage: 427.90388666666666, kd: 1.6666666666666667, deaths: 3, wins: 0, top10: 2, dbnos: 9, revives: 1, headshot_kills: 2, longest_kill: 314.31113 }),
          row('SG_LabmemNo004', 2, { matches: 8, kills: 10, assists: 11, damage: 2743.0386630000003, avg_damage: 342.87983287500003, kd: 1.4285714285714286, deaths: 7, wins: 1, top10: 6, dbnos: 15, revives: 3, headshot_kills: 3, longest_kill: 318.54013 }),
          row('SG_LabmemNo007', 3, { matches: 12, kills: 10, assists: 4, damage: 1614.9, avg_damage: 134.575, kd: 0.909, deaths: 11, wins: 1, top10: 8, dbnos: 12, revives: 7, longest_kill: 192 }),
        ],
      },
      queryResolved: { tool: 'pubg_query_stats', resolvedSelector: { type: 'relative_period', value: 'yesterday', label: '10月19日星期一 全天', ...range }, metrics: ['kills', 'damage'], operation: 'report', groupBy: 'player' },
      evidenceRefs: evidence(['m1', 'm2', 'm3']),
    },
  },
  stats_no_matches: {
    tool: 'pubg_query_stats',
    envelope: { ...base, status: 'no_matches', data: { operation: 'report', groupBy: 'player', summary: { uniqueMatchCount: 0 }, rows: [] }, queryResolved: { tool: 'pubg_query_stats', resolvedSelector: { type: 'relative_period', value: 'today', ...range } }, evidenceRefs: evidence([]) },
  },
  stats_partial: {
    tool: 'pubg_query_stats',
    envelope: { ...base, status: 'partial', coverage: { ...coverage, status: 'PARTIAL', complete: false, freshness: 'unknown' }, data: { operation: 'report', groupBy: 'player', summary: { uniqueMatchCount: 2 }, rows: [row('kim_kkl', 1, { matches: 2, kills: 3, damage: 410.5, kd: 1.5, deaths: 2 })] }, queryResolved: { tool: 'pubg_query_stats', resolvedSelector: { type: 'relative_period', value: 'today', ...range } }, evidenceRefs: evidence(['m1']) },
  },
  stats_error: {
    tool: 'pubg_query_stats',
    envelope: { ...base, status: 'error', coverage: { ...coverage, status: 'SOURCE_UNAVAILABLE', complete: false, sourceUnavailable: true, freshness: 'unknown' }, data: {}, queryResolved: { tool: 'pubg_query_stats' }, evidenceRefs: evidence([]), error: { code: 'pubg_rate_limited', retryable: true, reason: 'upstream rate limit' } },
  },
  team_damage: {
    tool: 'pubg_query_team_damage',
    envelope: {
      ...base,
      status: 'ok',
      data: {
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
          { matchId: 'm1', mapName: 'Desert_Main', placement: 12, startedAtLocal: '21:01', teamDamage: [hit(A, B, 2, 40, kick), hit(B, C, 1, 19.75, { source: 'VEHICLE', weapon: 'BP_PickupTruck_A_04_C' })] },
          { matchId: 'm2', mapName: 'Neon_Main', placement: 4, startedAtLocal: '23:04', teamDamage: [hit(A, B, 3, 80.5, kick), hit(B, A, 3, 60, kick)] },
        ],
      },
      queryResolved: { tool: 'pubg_query_team_damage', resolvedSelector: { type: 'relative_period', value: 'yesterday', ...range } },
      evidenceRefs: evidence(['m1', 'm2']),
    },
  },
  match_list: {
    tool: 'pubg_search_matches',
    envelope: {
      ...base,
      status: 'ok',
      data: {
        total: 1,
        matches: [{ matchId: 'm1', createdAt: '2026-10-19T13:24:00.000Z', mapName: 'Desert_Main', gameMode: 'squad', placement: 14, players: [{ name: 'SG_LabmemNo004', kills: 0, damageDealt: 27.903175 }] }],
      },
      queryResolved: { tool: 'pubg_search_matches', resolvedSelector: { type: 'relative_period', value: 'yesterday', ...range } },
      evidenceRefs: evidence(['m1']),
      resultSetId: 'rs-fixture',
    },
  },
};
