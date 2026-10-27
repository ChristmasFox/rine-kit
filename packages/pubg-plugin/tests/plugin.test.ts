import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PluginRegistry } from '@rine-kit/plugin-sdk';
import {
  createTeamContext,
  PubgDomainService,
  SqlitePubgRepository,
  SqlitePubgRepositoryAdapter,
  type TeamConfig,
  type ToolEnvelope,
} from '@rine-kit/pubg-domain';
import { createPubgPlugin } from '../src/index.js';

const golden = JSON.parse(
  readFileSync(
    new URL('../../pubg-tools/tests/fixtures/shared-domain-golden.json', import.meta.url),
    'utf8',
  ),
) as { matches: Array<Record<string, unknown>> };

const team = (id: string, ...players: string[]): TeamConfig => ({
  id,
  label: id,
  platform: 'steam',
  players: players.map((p) => ({ id: p, name: p.toUpperCase(), aliases: [] })),
});

interface Ctx {
  tenant: string;
  userId: string;
}

test('the PUBG tools run through the plugin SDK for the tenant the host authorised, and no other', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-plugin-'));
  const repositories: SqlitePubgRepository[] = [];
  try {
    const serviceFor = (tenant: string, squad: TeamConfig) => {
      const repository = new SqlitePubgRepository(join(root, `${tenant}.sqlite`));
      repositories.push(repository);
      if (tenant === 'tenant-a') repository.upsertMatches(golden.matches);
      const context = createTeamContext(tenant, squad);
      return new PubgDomainService({
        teamContext: context,
        repository: new SqlitePubgRepositoryAdapter(repository, context),
        now: () => new Date('2026-09-17T00:00:00.000Z'),
      });
    };
    const services = {
      'tenant-a': serviceFor('tenant-a', team('squad-a', 'p1', 'p2')),
      'tenant-b': serviceFor('tenant-b', team('squad-b', 'p1', 'p2')),
    } as const;
    const registry = new PluginRegistry<Ctx>().register(
      createPubgPlugin<Ctx>({
        access: (ctx) => ({
          service: services[ctx.tenant as keyof typeof services],
          host: { self: async () => ({ playerIds: ['p1'] }) },
          sessionId: `session-${ctx.userId}`,
        }),
      }),
    );
    const tools = Object.fromEntries(registry.tools().map((t) => [t.tool.name, t.tool]));
    assert.equal(Object.keys(tools).length, 8);
    assert.match(registry.instructions()[0]!, /Never pass tenant, team or user identifiers/u);

    const input = {
      selector: {
        type: 'time_range',
        from: '2026-09-15T00:00:00.000Z',
        to: '2026-09-17T00:00:00.000Z',
      },
      metrics: ['matches', 'kills'],
      refresh: false,
    };
    const a = (await tools.pubg_query_stats!.run(
      tools.pubg_query_stats!.input.parse(input),
      { tenant: 'tenant-a', userId: 'u1' },
      {},
    )) as ToolEnvelope;
    const rows = (a.data as { rows: Array<{ key: string; metrics: Record<string, number> }> }).rows;
    assert.deepEqual(
      rows.map((r) => [r.key, r.metrics.kills]),
      [['p1', 6]],
    );
    // Tenant B's data store is empty: the same question there sees none of tenant A's matches.
    const b = (await tools.pubg_query_stats!.run(
      tools.pubg_query_stats!.input.parse(input),
      { tenant: 'tenant-b', userId: 'u2' },
      {},
    )) as ToolEnvelope;
    assert.equal(
      (b.data as { rows: unknown[] }).rows.length === 0 || b.status === 'no_matches',
      true,
    );
    // The model cannot reach another tenant: the schema has no such field.
    assert.equal(
      tools.pubg_query_stats!.input.safeParse({ ...input, tenantId: 'tenant-a' }).success,
      false,
    );
  } finally {
    for (const repository of repositories) repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('with the reply option a result carries displayText and replyGuide, and a bare record request is the whole team', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pubg-plugin-reply-'));
  const repository = new SqlitePubgRepository(join(root, 'a.sqlite'));
  try {
    repository.upsertMatches(golden.matches);
    const context = createTeamContext('tenant-a', team('squad-a', 'p1', 'p2'));
    const service = new PubgDomainService({
      teamContext: context,
      repository: new SqlitePubgRepositoryAdapter(repository, context),
      now: () => new Date('2026-09-17T00:00:00.000Z'),
    });
    let asked = '今日战绩';
    const registry = new PluginRegistry<Ctx>().register(
      createPubgPlugin<Ctx>({
        rules: 'chat',
        reply: { request: () => asked },
        access: () => ({
          service,
          host: { self: async () => ({ playerIds: ['p1'] }) },
          sessionId: 'session',
        }),
      }),
    );
    assert.match(registry.instructions()[0]!, /Mandatory identity-first dispatch/u);
    assert.doesNotMatch(registry.instructions()[0]!, /pubg_prefetch_telemetry/u);
    const tool = registry.tools().find((t) => t.tool.name === 'pubg_query_stats')!.tool;
    const input = {
      selector: {
        type: 'time_range',
        from: '2026-09-15T00:00:00.000Z',
        to: '2026-09-17T00:00:00.000Z',
      },
      metrics: ['matches', 'kills'],
      operation: 'report',
      groupBy: 'player',
      refresh: false,
    };
    const run = async (extra: object) =>
      (await tool.run(tool.input.parse({ ...input, ...extra }), { tenant: 'tenant-a', userId: 'u1' }, {})) as Record<
        string,
        unknown
      >;
    // The model carried a person over from earlier chat into a bare "今日战绩": still the team.
    const bare = await run({ playerIds: ['p1'] });
    assert.equal(typeof bare.displayText, 'string');
    assert.equal(typeof bare.replyGuide, 'string');
    assert.equal((bare.data as { rows: unknown[] }).rows.length, 2);
    // A named request keeps the person.
    asked = '我的战绩';
    const mine = await run({ playerIds: ['p1'] });
    assert.equal((mine.data as { rows: unknown[] }).rows.length, 1);
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});
