import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRecallService } from '../src/recall/service.js';
import type { MemoryEntry, MemoryUsageSignalKind } from '../src/contracts.js';

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    key: 'favorite_map',
    content: 'I usually land in Erangel forest',
    revision: 2,
    updatedAt: '2026-10-01T00:00:00.000Z',
    sourceEventId: 'source-event',
    sourceKind: 'user_confirmed',
    sourceReliability: 95,
    validUntil: null,
    ...overrides,
  };
}

function harness(
  sources: {
    exact?: () => Promise<MemoryEntry[]>;
    lexical?: () => Promise<MemoryEntry[]>;
    semantic?: () => Promise<{
      matches: MemoryEntry[];
      reason: 'semantic_unconfigured' | 'semantic_timeout' | null;
    }>;
  },
  scope: () => Promise<void> = async () => {},
) {
  const usage: Array<{
    kind: MemoryUsageSignalKind;
    signals: readonly { queryFingerprint: string }[];
  }> = [];
  const service = new MemoryRecallService<string>(
    {
      async withAuthorizedSearch(authorization, work) {
        assert.equal(authorization, 'owner-dm');
        await scope();
        return work({
          exact: sources.exact ?? (async () => []),
          lexical: sources.lexical ?? (async () => []),
          semantic:
            sources.semantic ?? (async () => ({ matches: [], reason: 'semantic_unconfigured' })),
        });
      },
      async recordUsageSignals(authorization, kind, signals) {
        assert.equal(authorization, 'owner-dm');
        usage.push({ kind, signals });
      },
    },
    { now: () => Date.parse('2026-10-02T00:00:00.000Z') },
  );
  return { service, usage };
}

test('generic recall keeps lexical fallback and records content-free recalled/used signals', async () => {
  const fact = entry();
  const fixture = harness({
    lexical: async () => [fact],
    semantic: async () => ({ matches: [], reason: 'semantic_unconfigured' }),
  });
  const result = await fixture.service.recall('owner-dm', 'Erangel forest');

  assert.equal(result.mode, 'lexical_only');
  assert.equal(result.reason, 'semantic_unconfigured');
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.key),
    ['favorite_map'],
  );
  assert.match(result.context ?? '', /Erangel forest/u);
  assert.equal(fixture.usage[0]?.kind, 'recalled');
  assert.equal(fixture.usage[0]?.signals.length, 1);
  assert.equal(JSON.stringify(fixture.usage[0]?.signals).includes('Erangel forest'), false);

  await fixture.service.recordUsed('owner-dm', 'Erangel forest', result.candidates);
  assert.deepEqual(
    fixture.usage.map((write) => write.kind),
    ['recalled', 'used'],
  );
  assert.equal(
    fixture.usage[0]?.signals[0]?.queryFingerprint,
    fixture.usage[1]?.signals[0]?.queryFingerprint,
  );
});

test('generic recall returns disabled on authorization or complete source failure', async () => {
  const unauthorized = harness({}, async () => {
    throw new Error('scope must remain private');
  });
  const denied = await unauthorized.service.recall('owner-dm', 'query');
  assert.equal(denied.mode, 'disabled');
  assert.equal(denied.reason, 'memory_scope_unavailable');
  assert.equal(denied.context, null);

  const failed = harness({
    exact: async () => {
      throw new Error('database unavailable');
    },
    lexical: async () => {
      throw new Error('database unavailable');
    },
    semantic: async () => {
      throw new Error('embedding unavailable');
    },
  });
  const unavailable = await failed.service.recall('owner-dm', 'query');
  assert.equal(unavailable.mode, 'disabled');
  assert.equal(unavailable.reason, 'memory_store_unavailable');
  assert.deepEqual(unavailable.candidates, []);
  assert.equal(unavailable.context, null);
});
