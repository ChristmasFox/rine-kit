import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CanonicalQuerySchema,
  createTeamContext,
  DeterministicQueryEngine,
  type Coverage,
  type SourceInfo,
  type TeamConfig,
} from '../src/index.js';

interface EdgeCase {
  id: string;
  now?: string;
  query: Record<string, unknown>;
  coverage?: Partial<Coverage>;
  expected: {
    status: string;
    matchIds: string[];
    metrics: Record<string, Record<string, number | null>>;
    unranked?: string[];
    nullKillRatios?: string[];
  };
}
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/shared-edge-cases.json', import.meta.url), 'utf8'),
) as {
  contract: string;
  now: string;
  team: TeamConfig;
  matches: unknown[];
  coverage: Coverage;
  source: SourceInfo;
  cases: EdgeCase[];
};
for (const scenario of fixture.cases) {
  test(`shared edge golden: ${scenario.id}`, () => {
    assert.equal(fixture.contract, 'pubg-domain-edge-parity-v1');
    const query = CanonicalQuerySchema.parse({
      version: 3,
      queryId: scenario.id,
      domain: 'pubg',
      subject: { type: 'team', ids: [] },
      operation: 'report',
      selector: { type: 'relative_period', value: 'yesterday' },
      groupBy: 'player',
      metrics: ['kills', 'kd', 'revives', 'rank'],
      orderBy: { metric: 'kills', direction: 'desc' },
      limit: null,
      reference: {
        sessionId: 'edge-fixture-session',
        selectorExplicit: true,
        subjectExplicit: true,
        planner: 'provided',
      },
      ...scenario.query,
    });
    const coverage = { ...fixture.coverage, ...scenario.coverage };
    const result = new DeterministicQueryEngine({
      teamContext: createTeamContext('edge-fixture-tenant', fixture.team),
      now: new Date(scenario.now ?? fixture.now),
    }).execute(query, fixture.matches, coverage, fixture.source);
    assert.equal(result.status, scenario.expected.status);
    assert.deepEqual(result.evidence.matchIds, scenario.expected.matchIds);
    assert.deepEqual(result.coverage, coverage);
    for (const [key, metrics] of Object.entries(scenario.expected.metrics)) {
      const row = result.data.rows.find((item) => item.key === key);
      assert.ok(row, `missing row ${key}`);
      for (const [metric, value] of Object.entries(metrics))
        assert.equal(row.metrics[metric], value, `${key}.${metric}`);
    }
    for (const key of scenario.expected.unranked ?? [])
      assert.equal(result.data.rows.find((item) => item.key === key)?.position, undefined);
    for (const key of scenario.expected.nullKillRatios ?? [])
      assert.equal(
        result.data.rows.find((item) => item.key === key)?.comparisonRatios?.kills,
        null,
      );
    const finite = (value: unknown): void => {
      if (typeof value === 'number') assert.ok(Number.isFinite(value));
      else if (value && typeof value === 'object') Object.values(value).forEach(finite);
    };
    finite(result);
  });
}
