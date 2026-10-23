import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createTeamContext,
  PubgDomainService,
  SqlitePubgRepository,
  SqlitePubgRepositoryAdapter,
  type TeamConfig,
  type ToolEnvelope,
} from '@rine-kit/pubg-domain';
import {
  PUBG_TOOLS,
  queryStatsInput,
  runPubgTool,
  subjectError,
  type PubgSubjectHost,
} from '../src/index.js';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/shared-domain-golden.json', import.meta.url), 'utf8'),
) as {
  matches: Array<Record<string, unknown>>;
  expectedPlayers: Array<Record<string, number | string | null>>;
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
const RANGE = {
  type: 'time_range',
  from: '2026-09-15T00:00:00.000Z',
  to: '2026-09-17T00:00:00.000Z',
};

function withService<T>(work: (service: PubgDomainService) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'pubg-tools-'));
  const repository = new SqlitePubgRepository(join(root, 'pubg.sqlite'));
  repository.upsertMatches(golden.matches);
  const context = createTeamContext('tenant-1', TEAM);
  const service = new PubgDomainService({
    teamContext: context,
    repository: new SqlitePubgRepositoryAdapter(repository, context),
    now: () => new Date('2026-09-17T00:00:00.000Z'),
  });
  return work(service).finally(() => {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  });
}

const tool = (name: string) => PUBG_TOOLS.find((t) => t.name === name)!;
const noHost: PubgSubjectHost = {
  self: async () => subjectError('identity_sender_unbound', 'not bound'),
};
const rowsOf = (envelope: ToolEnvelope) =>
  (
    envelope.data as {
      rows: Array<{ key: string; metrics: Record<string, number | null | undefined> }>;
    }
  ).rows;

test('the catalogue has the eight read tools with unique names, strict inputs and model-facing descriptions', () => {
  assert.deepEqual(
    PUBG_TOOLS.map((t) => t.name),
    [
      'pubg_resolve_players',
      'pubg_search_matches',
      'pubg_query_stats',
      'pubg_compare_stats',
      'pubg_get_match',
      'pubg_get_review_facts',
      'pubg_get_period_review',
      'pubg_query_team_damage',
    ],
  );
  assert.equal(new Set(PUBG_TOOLS.map((t) => t.name)).size, PUBG_TOOLS.length);
  assert.ok(PUBG_TOOLS.every((t) => t.description.length > 20));
  // Strict: a field the model invents (for example a tenant) is refused, not silently passed on.
  assert.equal(
    queryStatsInput.safeParse({ selector: RANGE, metrics: ['kills'], tenantId: 'x' }).success,
    false,
  );
  assert.equal(queryStatsInput.safeParse({ selector: RANGE, metrics: [] }).success, false);
  assert.equal(
    queryStatsInput.safeParse({ selector: RANGE, metrics: ['kills'], team: true }).success,
    true,
  );
});

test('a team question returns the Domain numbers from the shared golden fixture', async () => {
  await withService(async (service) => {
    const result = await runPubgTool(
      tool('pubg_query_stats'),
      {
        selector: RANGE,
        metrics: ['matches', 'kills', 'assists', 'damage'],
        team: true,
        groupBy: 'player',
        refresh: false,
      },
      { service, host: noHost, sessionId: 's1' },
    );
    assert.ok(['ok', 'partial'].includes(result.status), result.status);
    const byKey = new Map(rowsOf(result).map((row) => [row.key, row]));
    for (const expected of golden.expectedPlayers) {
      const row = byKey.get(expected.key as string)!;
      for (const metric of ['matches', 'kills', 'assists', 'damage'])
        assert.equal(row.metrics[metric], expected[metric], `${expected.key} ${metric}`);
    }
  });
});

test('who the question is about is decided by the host, never by the model', async () => {
  await withService(async (service) => {
    const input = { selector: RANGE, metrics: ['kills'], groupBy: 'player', refresh: false };
    const run = (extra: object, host: PubgSubjectHost) =>
      runPubgTool(
        tool('pubg_query_stats'),
        { ...input, ...extra },
        { service, host, sessionId: 's' },
      );
    // Nobody named: the host's "self" answers; an unbound asker gets the host's error, not the team.
    assert.equal((await run({}, noHost)).error?.code, 'identity_sender_unbound');
    const asBob: PubgSubjectHost = { self: async () => ({ playerIds: ['p2'] }) };
    assert.deepEqual(
      rowsOf(await run({}, asBob)).map((r) => r.key),
      ['p2'],
    );
    // The team only on explicit request, and never mixed with other subjects.
    assert.deepEqual(
      rowsOf(await run({ team: true }, noHost))
        .map((r) => r.key)
        .sort(),
      ['p1', 'p2'],
    );
    assert.equal(
      (await run({ team: true, playerIds: ['p1'] }, noHost)).error?.code,
      'identity_subject_conflict',
    );
    assert.equal(
      (await run({ playerIds: ['p1'], personIds: ['x'] }, noHost)).error?.code,
      'identity_subject_conflict',
    );
    // Explicit players are used as given.
    assert.deepEqual(
      rowsOf(await run({ playerNames: ['Alice'] }, noHost)).map((r) => r.key),
      ['p1'],
    );
    // Person ids go to the host's identity store when it has one.
    const withPersons: PubgSubjectHost = {
      ...noHost,
      persons: async (ids) => ({ playerIds: ids.includes('person-1') ? ['p1'] : [] }),
    };
    assert.deepEqual(
      rowsOf(await run({ personIds: ['person-1'] }, withPersons)).map((r) => r.key),
      ['p1'],
    );
  });
});

test('tools about a match do not take a subject, and bad input or a failing Domain never throws', async () => {
  await withService(async (service) => {
    const ok = await runPubgTool(
      tool('pubg_get_match'),
      { matchId: 'm1', team: true, refresh: false },
      { service, host: noHost, sessionId: 's' },
    );
    assert.notEqual(ok.error?.code, 'identity_subject_conflict');
    assert.equal(ok.status === 'error', false, JSON.stringify(ok.error));
    const bad = await runPubgTool(
      tool('pubg_query_stats'),
      { selector: { type: 'nope' }, metrics: ['kills'] },
      { service, host: noHost, sessionId: 's' },
    );
    assert.equal(bad.status, 'error');
    assert.equal(bad.error?.code, 'invalid_input');
    const broken = {
      ...service,
      queryStats: async () => {
        throw new Error('secret database path /var/x');
      },
      team: service.team,
    } as unknown as PubgDomainService;
    const failed = await runPubgTool(
      tool('pubg_query_stats'),
      { selector: RANGE, metrics: ['kills'], team: true },
      { service: broken, host: noHost, sessionId: 's' },
    );
    assert.equal(failed.error?.code, 'plugin_runtime_error');
    assert.doesNotMatch(JSON.stringify(failed), /secret database path/u);
  });
});
