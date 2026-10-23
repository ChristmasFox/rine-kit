import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  DeterministicQueryEngine,
  BUSINESS_DAY_START,
  createTeamContext,
  parseTeamContext,
  PubgApiClient,
  PubgApiError,
  PubgApiTelemetryDownloader,
  PubgDomainService,
  SqlitePubgRepository,
  SqlitePubgRepositoryAdapter,
  TelemetryWorker,
  businessDayLabel,
  extractMatchReviewFacts,
  importLegacyPubgData,
  normalizeRecords,
  normalizeTelemetryEvents,
  resolveSelector,
  resolvePreviousPeriodSelector,
  selectMatchReviewFactCategories,
  scopeMatchReviewFacts,
  type Coverage,
  type NormalizedMatch,
  type SourceInfo,
  type TeamConfig,
} from '../src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown };
    close(): void;
  };
};

const TEAM: TeamConfig = {
  id: 'team-test',
  label: 'Test Team',
  platform: 'steam',
  players: [
    { id: 'p1', name: 'Alice', aliases: ['a'] },
    { id: 'p2', name: 'Bob', aliases: ['b'] },
  ],
};
const TEAM_CONTEXT = createTeamContext('test-tenant', TEAM);

const SHARED_DOMAIN_GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/shared-domain-golden.json', import.meta.url), 'utf8'),
) as {
  contract: string;
  matches: Array<Record<string, unknown>>;
  source: SourceInfo;
  coverage: Coverage;
  syntheticMatchIdsInRange: string[];
  expectedPlayers: Array<Record<string, string | number | null>>;
};
const SOURCE = SHARED_DOMAIN_GOLDEN.source;
const COVERAGE = SHARED_DOMAIN_GOLDEN.coverage;

test('PUBG common.isGame phase values follow safe-zone stages: below 1 is pre-match and 1+ is in-match', () => {
  const phaseMatch = normalizeRecords([
    rawMatch('phase-test', '2026-10-12T12:00:00.000Z', [{ accountId: 'p1', playerName: 'Alice' }]),
  ])[0]!;
  const events = normalizeTelemetryEvents(
    [
      { _T: 'LogPlayerAttack', timeSeconds: 10, common: { isGame: 0.5 } },
      { _T: 'LogPlayerAttack', timeSeconds: 20, common: { isGame: 1 } },
      { _T: 'LogPlayerAttack', timeSeconds: 30, common: { isGame: 1.5 } },
      { _T: 'LogPlayerAttack', timeSeconds: 40, common: { isGame: 2 } },
      { _T: 'LogPlayerAttack', timeSeconds: 50, common: { isGame: 4.5 } },
    ],
    phaseMatch,
  );
  assert.deepEqual(
    events.map((event) => event.phase),
    ['pre_match', 'in_match', 'in_match', 'in_match', 'in_match'],
  );
});

function rawMatch(
  matchId: string,
  createdAt: string,
  players: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 3,
    matchId,
    shard: 'steam',
    createdAt,
    matchType: 'competitive',
    gameMode: 'squad-fpp',
    isCompetitive: true,
    mapName: 'Erangel',
    duration: 1200,
    patchVersion: 'test',
    players,
    ...extra,
  };
}

const RAW_RECORDS = SHARED_DOMAIN_GOLDEN.matches;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/vnd.api+json' },
  });
}

function playerDiscovery(matchIds: string[]): Record<string, unknown> {
  return {
    data: TEAM.players.map((player) => ({
      type: 'player',
      id: player.id,
      attributes: { name: player.name },
      relationships: { matches: { data: matchIds.map((id) => ({ type: 'match', id })) } },
    })),
  };
}

function matchPayload(matchId: string, createdAt: string): Record<string, unknown> {
  return {
    data: {
      type: 'match',
      id: matchId,
      attributes: {
        createdAt,
        matchType: 'competitive',
        gameMode: 'squad-fpp',
        mapName: 'Erangel',
        duration: 1200,
        patchVersion: 'test',
      },
      relationships: { assets: { data: [] } },
    },
    included: TEAM.players.map((player, index) => ({
      type: 'participant',
      id: 'participant-' + player.id,
      attributes: {
        stats: {
          playerId: player.id,
          winPlace: index + 1,
          kills: index + 1,
          assists: 0,
          damageDealt: 100,
        },
      },
      relationships: {},
    })),
  };
}

function query(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    queryId: 'q-test',
    domain: 'pubg',
    subject: { type: 'players', ids: ['p1', 'p2'] },
    operation: 'report',
    selector: {
      type: 'time_range',
      start: '2026-09-15T00:00:00.000Z',
      end: '2026-09-17T00:00:00.000Z',
      timezone: 'Asia/Shanghai',
      businessDayStart: '00:00',
    },
    matchSelector: null,
    segments: [],
    groupBy: 'player',
    metrics: ['kills', 'kd', 'assists'],
    filters: {},
    orderBy: { metric: 'kills', direction: 'desc' },
    limit: null,
    reference: {
      sessionId: 'telegram:chat-a:user-a:pubg',
      selectorExplicit: true,
      subjectExplicit: true,
      useResultSet: false,
      inheritedFromContext: false,
      planner: 'provided',
    },
    presentation: { compact: true },
    ...overrides,
  };
}

test('normalization deduplicates match IDs and preserves unknown death semantics', () => {
  const records = normalizeRecords([
    ...RAW_RECORDS,
    rawMatch('m1', '2026-09-15T16:00:00.000Z', [
      {
        accountId: 'p1',
        playerName: 'Alice',
        kills: 4,
        deaths: 2,
        assists: 1,
        damage: 100,
        rank: 3,
      },
      { accountId: 'p2', playerName: 'Bob', kills: 3, deaths: 0, damage: 50, rank: 1 },
      { accountId: 'p3', playerName: 'Other', kills: 1, deaths: 1, rank: 8 },
    ]),
  ]);
  assert.equal(records.length, 3);
  assert.equal(records.find((record) => record.matchId === 'm1')?.players.length, 3);
  const unknown = normalizeRecords([
    rawMatch('unknown', '2026-09-16T00:00:00.000Z', [{ accountId: 'p1', kills: 1 }]),
  ])[0]!;
  assert.equal(unknown.players[0]?.deaths, null);
  assert.equal(unknown.players[0]?.deathSemantics, 'unknown');
  assert.ok(unknown.players.every((player) => Number.isFinite(player.kills)));
});

test('query engine uses half-open time ranges, zero-safe KD, missing assists, and category grouping', () => {
  const engine = new DeterministicQueryEngine({
    teamContext: TEAM_CONTEXT,
    now: new Date('2026-09-17T00:00:00.000Z'),
  });
  const result = engine.execute(query(), RAW_RECORDS, COVERAGE, SOURCE);
  assert.equal(result.status, 'OK');
  assert.equal(result.evidence.matchIds.includes('m3'), false);
  const alice = result.data.rows.find((row) => row.key === 'p1')!;
  const bob = result.data.rows.find((row) => row.key === 'p2')!;
  assert.equal(alice.metrics.kills, 6);
  assert.equal(alice.metrics.kd, 2);
  assert.equal(alice.metrics.assists, 3);
  assert.equal(bob.metrics.kd, null);
  assert.equal(bob.metrics.denominatorZero, 1);

  const mapResult = engine.execute(query({ groupBy: 'map' }), RAW_RECORDS, COVERAGE, SOURCE);
  assert.deepEqual(
    mapResult.data.rows.map((row) => row.label),
    ['Erangel', 'Taego'],
  );
  const modeResult = engine.execute(query({ groupBy: 'mode' }), RAW_RECORDS, COVERAGE, SOURCE);
  assert.deepEqual(
    modeResult.data.rows.map((row) => row.label),
    ['squad-fpp', 'duo-fpp'],
  );
});

test('shared domain golden preserves synthetic private/public stat parity', () => {
  const golden = SHARED_DOMAIN_GOLDEN;
  assert.equal(golden.contract, 'pubg-query-v1');
  const result = new DeterministicQueryEngine({
    teamContext: TEAM_CONTEXT,
    now: new Date('2026-09-17T00:00:00.000Z'),
  }).execute(query(), RAW_RECORDS, COVERAGE, SOURCE);
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.evidence.matchIds, golden.syntheticMatchIdsInRange);
  assert.deepEqual(
    result.data.rows.map((row) => {
      const expected = golden.expectedPlayers.find((item) => item.key === row.key)!;
      return Object.fromEntries(
        Object.keys(expected)
          .filter((key) => key !== 'key')
          .map((key) => [key, row.metrics[key] ?? null])
          .concat([['key', row.key]]),
      );
    }),
    golden.expectedPlayers,
  );
});

test('query engine requires an explicit scoped team context', () => {
  const result = new DeterministicQueryEngine().execute(query(), RAW_RECORDS, COVERAGE, SOURCE);
  assert.equal(result.status, 'INVALID_QUERY');
  assert.deepEqual(result.diagnostics.errors, ['TEAM_CONTEXT_REQUIRED']);
  assert.deepEqual(result.evidence.playerIds, []);
  assert.throws(
    () => parseTeamContext({ tenantId: 'tenant-a', teamId: 'other-team', team: TEAM }),
    /invalid_team_context/,
  );
});

test('domain service rejects a repository bound to another tenant scope', () => {
  const repository = new SqlitePubgRepositoryAdapter(
    new SqlitePubgRepository(),
    createTeamContext('other-tenant', TEAM),
  );
  assert.throws(
    () => new PubgDomainService({ teamContext: TEAM_CONTEXT, repository }),
    /repository_scope_mismatch/,
  );
  repository.sqlite.close();
});

test('business-day labels handle cross-midnight boundaries in Asia/Shanghai', () => {
  const beforeStart = Date.parse('2026-09-15T21:59:00.000Z');
  const atStart = Date.parse('2026-09-15T22:00:00.000Z');
  assert.equal(businessDayLabel(beforeStart, 'Asia/Shanghai', '06:00'), '2026-09-15');
  assert.equal(businessDayLabel(atStart, 'Asia/Shanghai', '06:00'), '2026-09-16');
});

test('PUBG relative selectors use the canonical 06:00 business day', () => {
  assert.equal(BUSINESS_DAY_START, '06:00');
  for (const now of ['2026-09-19T19:00:00.000Z', '2026-09-20T01:00:00.000Z']) {
    const today = resolveSelector(
      { type: 'relative_period', value: 'today' },
      { now: new Date(now), timezone: 'Asia/Shanghai' },
    );
    const yesterday = resolveSelector(
      { type: 'relative_period', value: 'yesterday' },
      { now: new Date(now), timezone: 'Asia/Shanghai' },
    );
    const expectedTodayStart =
      now === '2026-09-19T19:00:00.000Z' ? '2026-09-18T22:00:00.000Z' : '2026-09-19T22:00:00.000Z';
    const expectedYesterdayStart =
      now === '2026-09-19T19:00:00.000Z' ? '2026-09-17T22:00:00.000Z' : '2026-09-18T22:00:00.000Z';
    assert.equal(today.start, expectedTodayStart);
    assert.equal(today.end, now);
    assert.equal(yesterday.start, expectedYesterdayStart);
    assert.equal(yesterday.end, expectedTodayStart);
  }
});

test('rolling windows and previous-period selection are resolved by the shared Domain', () => {
  const now = new Date('2026-09-19T00:30:00.000Z');
  const options = { now, timezone: 'Asia/Shanghai', businessDayStart: '06:00' };
  const expected: Record<string, [string, string]> = {
    today: ['2026-09-18T22:00:00.000Z', now.toISOString()],
    yesterday: ['2026-09-17T22:00:00.000Z', '2026-09-18T22:00:00.000Z'],
    last_night: ['2026-09-18T10:00:00.000Z', '2026-09-18T22:00:00.000Z'],
    last_7_days: ['2026-09-12T00:30:00.000Z', now.toISOString()],
    previous_7_days: ['2026-09-05T00:30:00.000Z', '2026-09-12T00:30:00.000Z'],
    this_week: ['2026-09-13T22:00:00.000Z', now.toISOString()],
    last_week: ['2026-09-06T22:00:00.000Z', '2026-09-13T22:00:00.000Z'],
  };
  for (const [period, [start, end]] of Object.entries(expected)) {
    const resolved = resolveSelector({ type: 'relative_period', value: period }, options);
    assert.deepEqual([resolved.start, resolved.end], [start, end], period);
  }
  const recentDays = resolveSelector({ type: 'recent_days', count: 3 }, options);
  assert.deepEqual(
    [recentDays.start, recentDays.end],
    ['2026-09-16T22:00:00.000Z', now.toISOString()],
  );
  const previousRecentDays = resolvePreviousPeriodSelector(
    { type: 'recent_days', count: 3 },
    options,
  );
  assert.equal(previousRecentDays?.type, 'time_range');
  if (previousRecentDays?.type === 'time_range') {
    assert.deepEqual(
      [previousRecentDays.start, previousRecentDays.end],
      ['2026-09-13T22:00:00.000Z', '2026-09-16T22:00:00.000Z'],
    );
  }

  const previousCases = [
    ['today', 'yesterday', ['2026-09-17T22:00:00.000Z', '2026-09-18T22:00:00.000Z']],
    ['yesterday', 'day_before_yesterday', ['2026-09-16T22:00:00.000Z', '2026-09-17T22:00:00.000Z']],
    ['last_7_days', 'previous_7_days', ['2026-09-05T00:30:00.000Z', '2026-09-12T00:30:00.000Z']],
    [
      'previous_7_days',
      'days_14_to_21_ago',
      ['2026-08-29T00:30:00.000Z', '2026-09-05T00:30:00.000Z'],
    ],
  ] as const;
  for (const [period, previousValue, range] of previousCases) {
    const previous = resolvePreviousPeriodSelector(
      { type: 'relative_period', value: period },
      options,
    );
    assert.deepEqual(previous, { type: 'relative_period', value: previousValue });
    const resolved = resolveSelector(previous!, options);
    assert.deepEqual([resolved.start, resolved.end], range, `${period} previous period`);
  }
  assert.deepEqual(resolvePreviousPeriodSelector({ type: 'last_n_matches', count: 4, offset: 0 }), {
    type: 'last_n_matches',
    count: 4,
    offset: 4,
  });
  assert.equal(
    resolvePreviousPeriodSelector({ type: 'relative_period', value: 'last_night' }),
    null,
  );
});

test('PUBG explicit ranges preserve caller instants instead of applying the 06:00 boundary', () => {
  const resolved = resolveSelector({
    type: 'time_range',
    start: '2026-09-19T00:00:00+08:00',
    end: '2026-09-20T00:00:00+08:00',
    timezone: 'Asia/Shanghai',
    businessDayStart: '06:00',
  });
  assert.equal(resolved.start, '2026-09-18T16:00:00.000Z');
  assert.equal(resolved.end, '2026-09-19T16:00:00.000Z');
  assert.equal(resolved.businessDayStart, '06:00');
});

test('day grouping honors the selector business-day boundary', () => {
  const records = normalizeRecords([
    rawMatch('boundary', '2026-09-18T21:00:00.000Z', [
      { accountId: 'p1', playerName: 'Alice', kills: 1, deaths: 1, damage: 10, rank: 5 },
    ]),
  ]);
  const engine = new DeterministicQueryEngine({
    teamContext: TEAM_CONTEXT,
    timezone: 'Asia/Shanghai',
    businessDayStart: '00:00',
  });
  const result = engine.execute(
    query({
      subject: { type: 'player', ids: ['p1'] },
      selector: {
        type: 'time_range',
        start: '2026-09-18T00:00:00.000Z',
        end: '2026-09-20T00:00:00.000Z',
        timezone: 'Asia/Shanghai',
        businessDayStart: '06:00',
      },
      groupBy: 'day',
    }),
    records,
    COVERAGE,
    SOURCE,
  );
  assert.deepEqual(
    result.data.rows.map((row) => row.label),
    ['2026-09-18'],
  );
});

test('unknown metrics stay out of ranking and performance scoring', () => {
  const engine = new DeterministicQueryEngine({
    teamContext: TEAM_CONTEXT,
    now: new Date('2026-09-17T00:00:00.000Z'),
  });
  const ranked = engine.execute(
    query({ operation: 'rank', orderBy: { metric: 'kd', direction: 'desc' } }),
    RAW_RECORDS,
    COVERAGE,
    SOURCE,
  );
  const bob = ranked.data.rows.find((row) => row.key === 'p2')!;
  assert.equal(bob.metrics.kd, null);
  assert.equal(bob.position, undefined);
  const strongest = engine.execute(
    query({ operation: 'strongest' }),
    RAW_RECORDS,
    COVERAGE,
    SOURCE,
  );
  assert.equal(
    strongest.data.rows.find((row) => row.key === 'p2')?.metrics.performance_score,
    null,
  );
});

test('compare emits null ratios when a denominator is zero and never serializes Infinity or NaN', () => {
  const engine = new DeterministicQueryEngine({
    teamContext: TEAM_CONTEXT,
    now: new Date('2026-09-17T00:00:00.000Z'),
  });
  const compared = engine.execute(
    query({
      operation: 'compare',
      segments: [
        {
          label: 'first',
          selector: {
            type: 'time_range',
            start: '2026-09-15T00:00:00.000Z',
            end: '2026-09-16T00:00:00.000Z',
            timezone: 'Asia/Shanghai',
            businessDayStart: '00:00',
          },
        },
        {
          label: 'second',
          selector: {
            type: 'time_range',
            start: '2026-09-16T00:00:00.000Z',
            end: '2026-09-17T00:00:00.000Z',
            timezone: 'Asia/Shanghai',
            businessDayStart: '00:00',
          },
        },
      ],
    }),
    RAW_RECORDS,
    COVERAGE,
    SOURCE,
  );
  const alice = compared.data.rows.find((row) => row.key === 'p1')!;
  assert.equal(alice.comparisonRatios?.kd, 1);
  const bob = compared.data.rows.find((row) => row.key === 'p2')!;
  assert.equal(bob.comparisonRatios?.kd, null);
  assert.equal(bob.metrics.kd, null);
  const serialized = JSON.stringify(compared);
  assert.equal(serialized.includes('Infinity'), false);
  assert.equal(serialized.includes('NaN'), false);
});

test('person-scoped review facts do not expand back to the full squad', () => {
  const match = normalizeRecords([RAW_RECORDS[0]!])[0]!;
  const facts = extractMatchReviewFacts(match, { events: [] }, TEAM);
  const scoped = scopeMatchReviewFacts(facts, ['p1']);
  assert.deepEqual(scoped.squad.playerIds, ['p1']);
  assert.deepEqual(
    scoped.players.map((player) => player.playerId),
    ['p1'],
  );
  assert.equal(scoped.squad.kills, 4);
  assert.ok(scoped.evidence.every((item) => !item.id.includes('-p2')));
});

test('PUBG API retries bounded 5xx responses and never exposes credentials in errors', async () => {
  let calls = 0;
  const delays: number[] = [];
  const client = new PubgApiClient({
    apiKey: 'secret-api-key',
    baseUrl: 'https://api.example.test',
    maxRetries: 2,
    sleep: async (ms) => {
      delays.push(ms);
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1)
        return new Response(JSON.stringify({ errors: [{ title: 'temporary' }] }), { status: 503 });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/vnd.api+json' },
      });
    },
  });
  assert.deepEqual(await client.discoverPlayers('steam', ['p1']), []);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000]);

  const failing = new PubgApiClient({
    apiKey: 'secret-api-key',
    maxRetries: 0,
    fetchImpl: async () =>
      new Response(JSON.stringify({ errors: [{ title: 'unauthorized' }] }), { status: 401 }),
  });
  await assert.rejects(failing.discoverPlayers('steam', ['p1']), (error: unknown) => {
    assert.ok(error instanceof PubgApiError);
    assert.equal(error.code, 'unauthorized');
    assert.equal(error.name, 'PubgApiError');
    assert.equal(String(error).includes('secret-api-key'), false);
    return true;
  });
});

test('PUBG API sync refreshes the match list but fetches only matches missing from cache', async () => {
  const requestedPaths: string[] = [];
  const client = new PubgApiClient({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.example.test',
    maxRetries: 0,
    fetchImpl: async (input) => {
      const url = String(input);
      requestedPaths.push(new URL(url).pathname + new URL(url).search);
      if (url.includes('/players?')) return jsonResponse(playerDiscovery(['m1', 'm2']));
      if (url.endsWith('/matches/m2'))
        return jsonResponse(matchPayload('m2', '2026-09-18T12:00:00.000Z'));
      throw new Error('unexpected PUBG API request: ' + url);
    },
  });

  const synced = await client.syncTeam(TEAM, {
    knownMatchIds: new Set(['m1']),
    now: new Date('2026-09-19T00:00:00.000Z'),
  });
  assert.equal(synced.records.length, 1);
  assert.equal(synced.records[0]?.matchId, 'm2');
  assert.equal(synced.diagnostics?.cachedMatchCount, 1);
  assert.equal(synced.diagnostics?.newMatchCount, 1);
  assert.equal(requestedPaths.filter((path) => path.endsWith('/matches/m1')).length, 0);
  assert.equal(requestedPaths.filter((path) => path.endsWith('/matches/m2')).length, 1);
});

test('PUBG API sync fairly rotates player match lists before applying a small match ceiling', async () => {
  const requestedMatchIds: string[] = [];
  const client = new PubgApiClient({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.example.test',
    maxRetries: 0,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/players')) {
        return jsonResponse({
          data: [
            {
              type: 'player',
              id: 'p1',
              relationships: {
                matches: {
                  data: ['p1-newest', 'p1-older', 'p1-oldest'].map((id) => ({ type: 'match', id })),
                },
              },
            },
            {
              type: 'player',
              id: 'p2',
              relationships: {
                matches: { data: ['p1-newest', 'p2-only'].map((id) => ({ type: 'match', id })) },
              },
            },
          ],
        });
      }
      const matchId = url.pathname.split('/').at(-1)!;
      requestedMatchIds.push(matchId);
      return jsonResponse(
        matchPayload(
          matchId,
          matchId === 'p1-newest' ? '2026-09-18T12:00:00.000Z' : '2026-09-18T11:00:00.000Z',
        ),
      );
    },
  });

  const synced = await client.syncTeam(TEAM, {
    maxMatches: 2,
    now: new Date('2026-09-19T00:00:00.000Z'),
  });

  assert.deepEqual(synced.discoveredMatchIds, ['p1-newest', 'p2-only']);
  assert.deepEqual(new Set(requestedMatchIds), new Set(['p1-newest', 'p2-only']));
  assert.equal(
    requestedMatchIds.includes('p1-older'),
    false,
    'a small shared ceiling reserves a slot for the other player before advancing the first player list',
  );
});

test('recent PUBG searches force fresh discovery and reuse cached details when no match is new', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-domain-latest-cache-'));
  const dbPath = join(root, 'pubg.sqlite');
  let discoveredMatchIds = ['m1'];
  const requestedMatchIds: string[] = [];
  try {
    const client = new PubgApiClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.test',
      maxRetries: 0,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/players?')) return jsonResponse(playerDiscovery(discoveredMatchIds));
        const matchId = url.split('/matches/')[1];
        requestedMatchIds.push(matchId ?? '');
        if (matchId === 'm1') return jsonResponse(matchPayload('m1', '2026-09-18T11:00:00.000Z'));
        if (matchId === 'm2') return jsonResponse(matchPayload('m2', '2026-09-18T12:00:00.000Z'));
        throw new Error('unexpected PUBG match: ' + matchId);
      },
    });
    const repository = new SqlitePubgRepository(dbPath);
    const service = new PubgDomainService({
      teamContext: TEAM_CONTEXT,
      repository: new SqlitePubgRepositoryAdapter(repository, TEAM_CONTEXT),
      apiClient: client,
      now: () => new Date('2026-09-19T00:00:00.000Z'),
    });

    const first = await service.searchMatches({
      sessionId: 'session-latest',
      recentN: 1,
      refresh: false,
    });
    assert.equal(first.status, 'ok');
    assert.equal((first.data as { matches: Array<{ matchId: string }> }).matches[0]?.matchId, 'm1');

    discoveredMatchIds = ['m1', 'm2'];
    const second = await service.searchMatches({
      sessionId: 'session-latest',
      recentN: 1,
      refresh: false,
    });
    assert.equal(second.status, 'ok');
    assert.equal(
      (second.data as { matches: Array<{ matchId: string }> }).matches[0]?.matchId,
      'm2',
    );

    const matchCallsAfterNewMatch = requestedMatchIds.length;
    const third = await service.searchMatches({
      sessionId: 'session-latest',
      recentN: 1,
      refresh: false,
    });
    assert.equal(third.status, 'ok');
    assert.equal((third.data as { matches: Array<{ matchId: string }> }).matches[0]?.matchId, 'm2');
    assert.equal(requestedMatchIds.length, matchCallsAfterNewMatch);
    assert.deepEqual(requestedMatchIds, ['m1', 'm2']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('period searches default to chronological order while recent searches stay newest-first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-domain-search-order-'));
  const requestedMatchIds: string[] = [];
  try {
    const repository = new SqlitePubgRepository(join(root, 'pubg.sqlite'));
    const client = new PubgApiClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.test',
      maxRetries: 0,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/players?')) return jsonResponse(playerDiscovery(['m1', 'm2']));
        const matchId = url.split('/matches/')[1];
        requestedMatchIds.push(matchId ?? '');
        if (matchId === 'm1') return jsonResponse(matchPayload('m1', '2026-09-18T11:00:00.000Z'));
        if (matchId === 'm2') return jsonResponse(matchPayload('m2', '2026-09-18T12:00:00.000Z'));
        throw new Error('unexpected PUBG match: ' + matchId);
      },
    });
    const service = new PubgDomainService({
      teamContext: TEAM_CONTEXT,
      repository: new SqlitePubgRepositoryAdapter(repository, TEAM_CONTEXT),
      apiClient: client,
      now: () => new Date('2026-09-19T00:30:00.000Z'),
    });

    const period = await service.searchMatches({
      sessionId: 'session-search-order',
      selector: { type: 'relative_period', value: 'yesterday' },
      refresh: false,
      pageSize: 50,
    });
    assert.equal(period.status, 'ok');
    assert.deepEqual(
      (period.data as { matches: Array<{ matchId: string }> }).matches.map(
        (match) => match.matchId,
      ),
      ['m1', 'm2'],
    );
    assert.equal((period.queryResolved as { order: string }).order, 'asc');

    const recent = await service.searchMatches({
      sessionId: 'session-search-order',
      recentN: 1,
      refresh: false,
    });
    assert.equal(recent.status, 'ok');
    assert.deepEqual(
      (recent.data as { matches: Array<{ matchId: string }> }).matches.map(
        (match) => match.matchId,
      ),
      ['m2'],
    );
    assert.equal((recent.queryResolved as { order: string }).order, 'desc');
    assert.deepEqual(requestedMatchIds, ['m1', 'm2']);
    repository.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PUBG telemetry downloader archives the complete CDN body before parsing and replays it without a second request', async () => {
  const raw = Buffer.from('[ {"_T":"LogPlayerTakeDamage","opaque":"retained exactly"} ]\n', 'utf8');
  let stored: Uint8Array | null = null;
  let requests = 0;
  let cdnAuthorization: string | null = null;
  const archive = {
    async read() {
      return stored;
    },
    async write(_matchId: string, value: Uint8Array) {
      stored = Buffer.from(value);
    },
    async getOrFetch(_matchId: string, fetchRaw: () => Promise<Uint8Array>) {
      if (stored) return stored;
      const value = await fetchRaw();
      stored = Buffer.from(value);
      return value;
    },
    async refresh(_matchId: string, fetchRaw: () => Promise<Uint8Array>) {
      const value = await fetchRaw();
      stored = Buffer.from(value);
      return value;
    },
  };
  const downloader = new PubgApiTelemetryDownloader({
    apiKey: 'must-not-be-forwarded',
    archive,
    fetchImpl: async (_input, init) => {
      requests += 1;
      cdnAuthorization = new Headers(init?.headers).get('authorization');
      return new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const match: NormalizedMatch = {
    schemaVersion: 3,
    matchId: 'archive-downloader-fixture',
    shard: 'steam',
    createdAt: '2026-09-18T12:00:00.000Z',
    timestamp: Date.parse('2026-09-18T12:00:00.000Z'),
    matchType: 'competitive',
    gameMode: 'squad-fpp',
    isCompetitive: true,
    mapName: 'Erangel',
    duration: 1200,
    patchVersion: 'fixture',
    players: [],
    telemetryUrl: 'https://telemetry-cdn.pubg.com/archive-downloader-fixture.json',
  };
  const first = await downloader.download(match);
  const second = await downloader.download(match);
  assert.ok(Buffer.isBuffer(first));
  assert.ok(Buffer.isBuffer(second));
  assert.deepEqual(first, raw);
  assert.deepEqual(second, raw);
  assert.deepEqual(stored, raw);
  assert.equal(requests, 1);
  assert.equal(cdnAuthorization, null);
});

test('relative-period match search uses the 06:00 business day and review requires a fresh result set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-domain-review-freshness-'));
  let currentNow = new Date('2026-09-19T00:30:00.000Z');
  try {
    const repository = new SqlitePubgRepository(join(root, 'pubg.sqlite'));
    const client = new PubgApiClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.test',
      maxRetries: 0,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/players?')) return jsonResponse(playerDiscovery(['m1']));
        if (url.endsWith('/matches/m1'))
          return jsonResponse(matchPayload('m1', '2026-09-18T12:00:00.000Z'));
        throw new Error('unexpected PUBG API request: ' + url);
      },
    });
    const worker = new TelemetryWorker({
      team: TEAM,
      store: repository,
      downloader: {
        async download() {
          return { events: [] };
        },
      },
    });
    const service = new PubgDomainService({
      teamContext: TEAM_CONTEXT,
      repository: new SqlitePubgRepositoryAdapter(repository, TEAM_CONTEXT),
      apiClient: client,
      telemetryWorker: worker,
      now: () => currentNow,
    });

    const search = await service.searchMatches({
      sessionId: 'session-review-freshness',
      selector: { type: 'relative_period', value: 'yesterday' },
      refresh: false,
      pageSize: 50,
    });
    assert.equal(search.status, 'ok');
    assert.deepEqual(
      (search.data as { matches: Array<{ matchId: string }> }).matches.map(
        (match) => match.matchId,
      ),
      ['m1'],
    );
    const resolved = search.queryResolved as {
      selector: { from: string; to: string; businessDayStart: string };
      refresh: { forcedForSelector: boolean };
    };
    assert.equal(resolved.selector.from, '2026-09-17T22:00:00.000Z');
    assert.equal(resolved.selector.to, '2026-09-18T22:00:00.000Z');
    assert.equal(resolved.selector.businessDayStart, '06:00');
    assert.equal(resolved.refresh.forcedForSelector, true);
    assert.ok(search.resultSetId);

    const review = await service.getReviewFacts({
      sessionId: 'session-review-freshness',
      matchId: 'm1',
      searchResultSetId: search.resultSetId!,
    });
    const reviewData = review.data as {
      telemetry: { status: string; cacheStatus: string; cacheLookup: string; availability: string };
    };
    assert.equal(reviewData.telemetry.status, 'FETCHED');
    assert.equal(reviewData.telemetry.cacheStatus, 'FETCHED');
    assert.equal(reviewData.telemetry.cacheLookup, 'MISS');
    assert.equal(reviewData.telemetry.availability, 'AVAILABLE');
    const reviewResolved = review.queryResolved as {
      sourceRange: { from: string; to: string; timezone: string; businessDayStart: string };
    };
    assert.equal(reviewResolved.sourceRange.from, '2026-09-17T22:00:00.000Z');
    assert.equal(reviewResolved.sourceRange.to, '2026-09-18T22:00:00.000Z');
    assert.equal(reviewResolved.sourceRange.timezone, 'Asia/Shanghai');
    assert.equal(reviewResolved.sourceRange.businessDayStart, '06:00');

    currentNow = new Date('2026-09-19T00:36:00.000Z');
    const staleReview = await service.getReviewFacts({
      sessionId: 'session-review-freshness',
      matchId: 'm1',
      searchResultSetId: search.resultSetId!,
    });
    assert.equal(staleReview.status, 'error');
    assert.equal(staleReview.error?.code, 'review_search_required');
    repository.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('period review consumes the fresh search result set in Domain order and preserves partial coverage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-domain-period-review-'));
  try {
    const repository = new SqlitePubgRepository(join(root, 'pubg.sqlite'));
    const client = new PubgApiClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.test',
      maxRetries: 0,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/players?')) return jsonResponse(playerDiscovery(['m1', 'm2']));
        const matchId = url.split('/matches/')[1];
        if (matchId === 'm1') return jsonResponse(matchPayload('m1', '2026-09-18T10:00:00.000Z'));
        if (matchId === 'm2') return jsonResponse(matchPayload('m2', '2026-09-18T12:00:00.000Z'));
        throw new Error('unexpected PUBG API request: ' + url);
      },
    });
    const worker = new TelemetryWorker({
      team: TEAM,
      store: repository,
      downloader: {
        async download(match) {
          if (match.matchId === 'm2') throw new Error('telemetry unavailable');
          return { events: [] };
        },
      },
    });
    const service = new PubgDomainService({
      teamContext: TEAM_CONTEXT,
      repository: new SqlitePubgRepositoryAdapter(repository, TEAM_CONTEXT),
      apiClient: client,
      telemetryWorker: worker,
      now: () => new Date('2026-09-19T00:30:00.000Z'),
    });
    const search = await service.searchMatches({
      sessionId: 'session-period-review',
      selector: { type: 'relative_period', value: 'yesterday' },
      refresh: false,
      sort: 'asc',
      pageSize: 50,
    });
    assert.equal(search.status, 'ok');
    assert.ok(search.resultSetId);

    const review = await service.getPeriodReview({
      sessionId: 'session-period-review',
      searchResultSetId: search.resultSetId!,
    });
    assert.equal(review.status, 'partial');
    const data = review.data as {
      period: { orderedMatchIds: string[] };
      reviews: Array<{ matchId: string; status: string }>;
    };
    assert.deepEqual(data.period.orderedMatchIds, ['m1', 'm2']);
    assert.deepEqual(
      data.reviews.map((item) => [item.matchId, item.status]),
      [
        ['m1', 'ok'],
        ['m2', 'partial'],
      ],
    );
    assert.deepEqual((review.queryResolved as { order: string[] }).order, ['m1', 'm2']);
    assert.equal(review.error?.code, 'period_review_partial');
    repository.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('period team-damage query resolves aliases, aggregates every Telemetry match, and preserves partial unknowns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-domain-team-damage-'));
  const repository = new SqlitePubgRepository(join(root, 'pubg.sqlite'));
  const matches = normalizeRecords([
    rawMatch('td1', '2026-09-18T10:00:00.000Z', [
      { accountId: 'p1', playerName: 'Alice', kills: 1, deaths: 0, damage: 100, rank: 3 },
      { accountId: 'p2', playerName: 'Bob', kills: 1, deaths: 0, damage: 90, rank: 3 },
    ]),
    rawMatch('td2', '2026-09-18T20:00:00.000Z', [
      { accountId: 'p1', playerName: 'Alice', kills: 2, deaths: 0, damage: 140, rank: 1 },
      { accountId: 'p2', playerName: 'Bob', kills: 0, deaths: 1, damage: 50, rank: 1 },
    ]),
  ]);
  repository.upsertMatches(matches);
  const event = (
    actor: string,
    victim: string,
    damage: number,
    category: string,
    timeSeconds: number,
  ): Record<string, unknown> => ({
    _T: 'LogPlayerTakeDamage',
    attacker: { accountId: actor },
    victim: { accountId: victim },
    damage,
    damageTypeCategory: category,
    timeSeconds,
    common: { isGame: true },
  });
  const worker = new TelemetryWorker({
    team: TEAM,
    store: repository,
    downloader: {
      async download(match) {
        return {
          events:
            match.matchId === 'td1'
              ? [
                  event('p1', 'p2', 1, 'Damage_Kick', 10),
                  event('p1', 'p2', 2, 'Damage_Kick', 11),
                  event('p1', 'p2', 3, 'Damage_Punch', 12),
                  { ...event('p2', 'p1', 4, 'Damage_Bullet', 20), damageCauserName: 'WeapAK47_C' },
                ]
              : [
                  event('p1', 'p2', 2, 'Damage_Kick', 15),
                  { ...event('p2', 'p1', 5, 'Damage_Bullet', 20), damageCauserName: 'FragGrenade' },
                ],
        };
      },
    },
  });
  try {
    const service = new PubgDomainService({
      teamContext: TEAM_CONTEXT,
      repository: new SqlitePubgRepositoryAdapter(repository, TEAM_CONTEXT),
      telemetryWorker: worker,
      now: () => new Date('2026-09-19T00:30:00.000Z'),
    });
    const all = await service.queryTeamDamage({
      sessionId: 'session-team-damage',
      selector: { type: 'relative_period', value: 'yesterday' },
      refresh: false,
    });
    assert.equal(all.status, 'ok');
    const allData = all.data as {
      totalHitCount: number | null;
      totalDamage: number | null;
      directions: Array<{
        actor: { playerId: string };
        victim: { playerId: string };
        hitCount: number | null;
        damage: number | null;
      }>;
      matches: Array<{ matchId: string; hitCount: number | null; damage: number | null }>;
      bySource: Array<{ source: string; hitCount: number | null; damage: number | null }>;
    };
    assert.equal(allData.totalHitCount, 6);
    assert.equal(allData.totalDamage, 17);
    assert.deepEqual(
      allData.matches.map((match) => match.matchId),
      ['td1', 'td2'],
    );
    assert.deepEqual(
      allData.matches.map((match) => match.hitCount),
      [4, 2],
    );
    assert.deepEqual(
      allData.directions.map((direction) => [
        direction.actor.playerId,
        direction.victim.playerId,
        direction.hitCount,
        direction.damage,
      ]),
      [
        ['p1', 'p2', 4, 8],
        ['p2', 'p1', 2, 9],
      ],
    );
    assert.deepEqual(allData.bySource, [
      { source: 'MELEE', hitCount: 4, damage: 8, knownHitCount: 4, knownDamage: 8 },
      { source: 'GUN', hitCount: 1, damage: 4, knownHitCount: 1, knownDamage: 4 },
      { source: 'EXPLOSIVE', hitCount: 1, damage: 5, knownHitCount: 1, knownDamage: 5 },
    ]);
    const allResolved = all.queryResolved as {
      sourceRange: { from: string; to: string };
      selector: { from: string; to: string };
    };
    assert.equal(allResolved.sourceRange.from, '2026-09-17T22:00:00.000Z');
    assert.equal(allResolved.sourceRange.to, '2026-09-18T22:00:00.000Z');
    assert.equal(allResolved.selector.from, allResolved.sourceRange.from);
    assert.equal(allResolved.selector.to, allResolved.sourceRange.to);

    const kicks = await service.queryTeamDamage({
      sessionId: 'session-team-damage',
      selector: { type: 'relative_period', value: 'yesterday' },
      actorPlayer: 'a',
      victimPlayer: 'b',
      source: 'MELEE',
      meleeKind: 'KICK',
      refresh: false,
    });
    assert.equal(kicks.status, 'ok');
    const kickData = kicks.data as {
      direction: string;
      totalHitCount: number | null;
      totalDamage: number | null;
      directions: Array<{
        actor: { playerId: string };
        victim: { playerId: string };
        hitCount: number | null;
        damage: number | null;
      }>;
      matches: Array<{ matchId: string; hitCount: number | null; damage: number | null }>;
    };
    assert.equal(kickData.direction, 'Alice → Bob');
    assert.equal(kickData.totalHitCount, 3);
    assert.equal(kickData.totalDamage, 5);
    assert.deepEqual(
      kickData.directions.map((direction) => [
        direction.actor.playerId,
        direction.victim.playerId,
        direction.hitCount,
        direction.damage,
      ]),
      [['p1', 'p2', 3, 5]],
    );
    assert.deepEqual(
      kickData.matches.map((match) => [match.matchId, match.hitCount, match.damage]),
      [
        ['td1', 2, 3],
        ['td2', 1, 2],
      ],
    );

    const unavailableWorker = new TelemetryWorker({
      team: TEAM,
      store: repository,
      featureVersion: 'unavailable-team-damage-test',
    });
    const unavailableService = new PubgDomainService({
      teamContext: TEAM_CONTEXT,
      repository: new SqlitePubgRepositoryAdapter(repository, TEAM_CONTEXT),
      telemetryWorker: unavailableWorker,
      now: () => new Date('2026-09-19T00:30:00.000Z'),
    });
    const partial = await unavailableService.queryTeamDamage({
      sessionId: 'session-team-damage',
      selector: { type: 'relative_period', value: 'yesterday' },
      actorPlayer: 'a',
      victimPlayer: 'b',
      source: 'MELEE',
      meleeKind: 'KICK',
      refresh: false,
    });
    assert.equal(partial.status, 'partial');
    const partialData = partial.data as {
      totalHitCount: number | null;
      totalDamage: number | null;
      matches: Array<{ hitCount: number | null; damage: number | null }>;
    };
    assert.equal(partialData.totalHitCount, null);
    assert.equal(partialData.totalDamage, null);
    assert.deepEqual(
      partialData.matches.map((match) => [match.hitCount, match.damage]),
      [
        [null, null],
        [null, null],
      ],
    );
    assert.equal(partial.coverage.complete, false);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Telemetry distinguishes a successful cache miss from unavailable data', async () => {
  const match = normalizeRecords([RAW_RECORDS[0]!])[0]!;
  let downloads = 0;
  const worker = new TelemetryWorker({
    team: TEAM,
    downloader: {
      async download() {
        downloads += 1;
        return { events: [] };
      },
    },
  });
  const fetched = await worker.ensure(match);
  assert.equal(fetched.status, 'FETCHED');
  assert.equal(fetched.cacheStatus, 'FETCHED');
  assert.equal(fetched.cacheLookup, 'MISS');
  assert.equal(fetched.availability, 'AVAILABLE');
  const hit = await worker.ensure(match);
  assert.equal(hit.status, 'HIT');
  assert.equal(hit.cacheStatus, 'HIT');
  assert.equal(hit.cacheLookup, 'HIT');
  assert.equal(hit.availability, 'AVAILABLE');
  assert.equal(downloads, 1);

  const unavailable = await new TelemetryWorker({ team: TEAM }).ensure(match);
  assert.equal(unavailable.status, 'UNAVAILABLE');
  assert.equal(unavailable.cacheStatus, 'UNAVAILABLE');
  assert.equal(unavailable.cacheLookup, 'MISS');
  assert.equal(unavailable.availability, 'UNAVAILABLE');
});

test('hourly telemetry prefetch only fetches new matches, persists retry state, and builds a structured report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-domain-prefetch-'));
  let currentNow = new Date('2026-09-18T15:00:00.000Z');
  let discoveredMatchIds = ['m1'];
  try {
    const repository = new SqlitePubgRepository(join(root, 'pubg.sqlite'));
    const client = new PubgApiClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.test',
      maxRetries: 0,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/players?')) return jsonResponse(playerDiscovery(discoveredMatchIds));
        const matchId = url.split('/matches/')[1];
        if (matchId === 'm1') return jsonResponse(matchPayload('m1', '2026-09-18T14:00:00.000Z'));
        if (matchId === 'm2') return jsonResponse(matchPayload('m2', '2026-09-18T14:30:00.000Z'));
        throw new Error('unexpected PUBG match: ' + matchId);
      },
    });
    const worker = new TelemetryWorker({
      team: TEAM,
      store: repository,
      downloader: {
        async download() {
          return { events: [] };
        },
      },
    });
    const service = new PubgDomainService({
      teamContext: TEAM_CONTEXT,
      repository: new SqlitePubgRepositoryAdapter(repository, TEAM_CONTEXT),
      apiClient: client,
      telemetryWorker: worker,
      now: () => currentNow,
    });
    const first = await service.prefetchTelemetry({ maxFetches: 20 });
    assert.equal(first.status, 'ok');
    const firstRun = (
      first.data as { run: { fetchedCount: number; newMatchCount: number; pendingCount: number } }
    ).run;
    assert.equal(firstRun.fetchedCount, 1);
    assert.equal(firstRun.newMatchCount, 1);
    assert.equal(firstRun.pendingCount, 0);
    assert.equal(repository.snapshot().features, 1);
    assert.equal(
      repository.getTelemetryPrefetchAttempt({
        matchId: 'm1',
        parserVersion: worker.parserVersion,
        featureVersion: worker.featureVersion,
      })?.status,
      'FETCHED',
    );

    discoveredMatchIds = ['m1', 'm2'];
    currentNow = new Date('2026-09-18T15:30:00.000Z');
    const second = await service.prefetchTelemetry({ maxFetches: 1 });
    assert.equal(second.status, 'ok');
    assert.equal(
      (second.data as { run: { newMatchCount: number; fetchedCount: number } }).run.newMatchCount,
      1,
    );
    assert.equal((second.data as { run: { fetchedCount: number } }).run.fetchedCount, 1);
    assert.equal(repository.snapshot().features, 2);

    const report = await service.getTelemetrySyncReport({ reportDate: '2026-09-18' });
    assert.equal(report.status, 'ok');
    const reportData = report.data as {
      summary: { newMatchCount: number; fetchedCount: number };
      notification?: unknown;
    };
    assert.equal(reportData.summary.newMatchCount, 2);
    assert.equal(reportData.summary.fetchedCount, 2);
    assert.equal(reportData.notification, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cached PUBG records become stale partial data when discovery is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-domain-stale-cache-'));
  try {
    const repository = new SqlitePubgRepository(join(root, 'pubg.sqlite'));
    repository.upsertMatches([RAW_RECORDS[0]]);
    const client = new PubgApiClient({
      apiKey: 'test-api-key',
      maxRetries: 0,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    const service = new PubgDomainService({
      teamContext: TEAM_CONTEXT,
      repository: new SqlitePubgRepositoryAdapter(repository, TEAM_CONTEXT),
      apiClient: client,
      now: () => new Date('2026-09-19T00:00:00.000Z'),
    });
    const result = await service.queryStats({
      sessionId: 'session-stale',
      playerIds: ['p1'],
      selector: {
        type: 'time_range',
        from: '2026-09-15T00:00:00.000Z',
        to: '2026-09-17T00:00:00.000Z',
      },
      metrics: ['matches', 'kills'],
      refresh: true,
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.error, undefined);
    assert.equal(result.coverage.status, 'STALE');
    assert.equal((result.data as { rows: unknown[] }).rows.length, 1);
    repository.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite repository survives restart, counts duplicate inputs, and isolates result sets by session', () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-domain-repository-'));
  const dbPath = join(root, 'pubg.sqlite');
  try {
    const first = new SqlitePubgRepository(dbPath);
    const write = first.upsertMatches([RAW_RECORDS[0], RAW_RECORDS[0], RAW_RECORDS[1]]);
    assert.equal(write.inserted, 2);
    assert.equal(write.duplicateInputs, 1);
    assert.equal(first.countMatches(), 2);
    const storedResult = {
      id: 'rs-a',
      queryId: 'q',
      sessionId: 'session-a',
      resolvedQuery: query(),
      resolvedSelector: query().selector,
      playerIds: ['p1'],
      matchIds: ['m1'],
      rows: [],
      aggregates: {},
      rankings: [],
      coverage: COVERAGE,
      status: 'OK',
      source: SOURCE,
      createdAt: '2026-09-17T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    } as never;
    first.setResultSet(storedResult);
    first.close();

    const second = new SqlitePubgRepository(dbPath);
    assert.equal(second.countMatches(), 2);
    assert.equal(second.getMatch('m1')?.players.length, 2);
    assert.ok(second.getResultSet('session-a', 'rs-a'));
    assert.equal(second.getResultSet('session-b', 'rs-a'), null);
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite repository opens an existing database without migration or write access in read-only mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-domain-readonly-'));
  const dbPath = join(root, 'pubg.sqlite');
  try {
    const writable = new SqlitePubgRepository(dbPath);
    writable.upsertMatches([RAW_RECORDS[0]!]);
    writable.close();
    const sourceHash = createHash('sha256').update(readFileSync(dbPath)).digest('hex');

    const reader = new SqlitePubgRepository(dbPath, { readOnly: true });
    assert.equal(reader.countMatches(), 1);
    assert.equal(reader.getMatch('m1')?.players.length, 2);
    assert.throws(() => reader.upsertMatches([RAW_RECORDS[1]!]), /readonly|read-only/iu);
    reader.close();

    const verification = new SqlitePubgRepository(dbPath, { readOnly: true });
    assert.equal(verification.countMatches(), 1);
    assert.equal(verification.getMatch('m2'), null);
    verification.close();
    assert.equal(createHash('sha256').update(readFileSync(dbPath)).digest('hex'), sourceHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite listMatches loads players only for the selected match window', () => {
  const repository = new SqlitePubgRepository();
  try {
    repository.upsertMatches(
      Array.from({ length: 40 }, (_, index) =>
        rawMatch(
          `perf-${index}`,
          new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
          ['a', 'b', 'c'].map((player) => ({ accountId: `${player}-${index}`, kills: index })),
        ),
      ),
    );

    const selected = repository.listMatches({
      fromMs: Date.parse('2026-09-01T00:10:00.000Z'),
      toMs: Date.parse('2026-09-01T00:11:00.000Z'),
      limit: 5,
    });
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.matchId, 'perf-10');
    assert.deepEqual(
      selected[0]?.players.map((player) => player.accountId),
      ['a-10', 'b-10', 'c-10'],
    );

    const plan = repository.db
      .prepare(
        `
      EXPLAIN QUERY PLAN
      WITH selected_matches AS (
        SELECT match_id, timestamp_ms FROM matches
        WHERE timestamp_ms >= ? AND timestamp_ms < ?
        ORDER BY timestamp_ms ASC, match_id ASC LIMIT ?
      )
      SELECT player.* FROM selected_matches AS selected
      JOIN match_players AS player ON player.match_id = selected.match_id
      ORDER BY selected.timestamp_ms ASC, selected.match_id ASC, player.account_id ASC
    `,
      )
      .all(Date.parse('2026-09-01T00:10:00.000Z'), Date.parse('2026-09-01T00:11:00.000Z'), 5);
    const details = plan.map((row) => String(row.detail ?? '')).join('\n');
    assert.match(details, /SEARCH player USING/);
    assert.doesNotMatch(details, /SCAN player/);
  } finally {
    repository.close();
  }
});

test('legacy importer is dry-run first, idempotent on apply, and reports invalid/duplicate data', () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-domain-import-'));
  const legacyPath = join(root, 'n8n.sqlite');
  const statePath = join(root, 'state.json');
  const featuresPath = join(root, 'features.json');
  const targetPath = join(root, 'target.sqlite');
  try {
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec('CREATE TABLE "data_table_user_fixture" (payload TEXT)');
    const insert = legacy.prepare('INSERT INTO "data_table_user_fixture" (payload) VALUES (?)');
    insert.run(JSON.stringify(RAW_RECORDS[0]));
    insert.run(JSON.stringify(RAW_RECORDS[0]));
    insert.run('{invalid-json');
    legacy.close();
    writeFileSync(
      statePath,
      JSON.stringify({ contexts: { stale: true }, records: [RAW_RECORDS[1]] }),
    );
    writeFileSync(
      featuresPath,
      JSON.stringify({
        features: {
          f1: {
            matchId: 'm1',
            parserVersion: 'p1',
            featureVersion: 'f1',
            facts: { evidence: [] },
            createdAt: '2026-09-17T00:00:00.000Z',
          },
        },
      }),
    );

    const dryRepository = new SqlitePubgRepository(targetPath);
    const dry = importLegacyPubgData(dryRepository, {
      n8nDatabasePath: legacyPath,
      stateJsonPath: statePath,
      featuresJsonPath: featuresPath,
      migrationId: 'migration-1',
      apply: false,
    });
    assert.equal(dry.apply, false);
    assert.equal(dry.uniqueMatchIds, 2);
    assert.equal(dry.duplicateInputs, 1);
    assert.equal(dry.invalidInputs, 0);
    assert.ok(dry.errors.length > 0);
    assert.equal(dryRepository.countMatches(), 0);
    dryRepository.close();

    const appliedRepository = new SqlitePubgRepository(targetPath);
    const applied = importLegacyPubgData(appliedRepository, {
      n8nDatabasePath: legacyPath,
      stateJsonPath: statePath,
      featuresJsonPath: featuresPath,
      migrationId: 'migration-1',
      apply: true,
    });
    assert.equal(applied.inserted, 2);
    assert.equal(applied.importedFeatures, 1);
    assert.equal(appliedRepository.snapshot().matches, 2);
    assert.ok(appliedRepository.getMigration('migration-1'));
    const rerun = importLegacyPubgData(appliedRepository, {
      n8nDatabasePath: legacyPath,
      stateJsonPath: statePath,
      featuresJsonPath: featuresPath,
      migrationId: 'migration-1',
      apply: true,
    });
    assert.equal(rerun.inserted, 0);
    assert.equal(rerun.updated, 2);
    assert.equal(appliedRepository.snapshot().matches, 2);
    appliedRepository.close();
    assert.ok(readFileSync(targetPath).byteLength > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review facts retain evidence IDs for Match Store facts', () => {
  const match = normalizeRecords([RAW_RECORDS[0]])[0]!;
  const facts = extractMatchReviewFacts(match, { events: [] }, TEAM);
  const evidenceIds = new Set(facts.evidence.map((item) => item.id));
  assert.ok(evidenceIds.has('match-summary-m1'));
  assert.ok(evidenceIds.has('player-summary-m1-p1'));
  assert.ok(evidenceIds.has('player-summary-m1-p2'));
  for (const evidenceId of facts.players.flatMap((player) =>
    player.keyOperations.flatMap((operation) => operation.evidenceIds),
  )) {
    assert.ok(evidenceIds.has(evidenceId));
  }
});

test('review fact categories bound detail groups without losing the match summary', () => {
  const match = normalizeRecords([RAW_RECORDS[0]!])[0]!;
  const facts = extractMatchReviewFacts(match, { events: [] }, TEAM);
  const selected = selectMatchReviewFactCategories(facts, ['weapons']);
  assert.equal(selected.match.matchId, 'm1');
  assert.deepEqual(selected.squad.playerIds, ['p1', 'p2']);
  assert.deepEqual(selected.fights, []);
  assert.deepEqual(selected.combat.events, []);
  assert.equal(selected.combat.eventCount, 0);
  assert.deepEqual(selected.vehicles, []);
  assert.deepEqual(selected.evidence, []);
  assert.deepEqual(selectMatchReviewFactCategories(facts, []), facts);
});
