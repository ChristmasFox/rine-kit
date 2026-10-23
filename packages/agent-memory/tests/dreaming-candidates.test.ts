import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMemoryCandidates, type MemoryCandidateDraft } from '../src/index.js';

function draft(overrides: Partial<MemoryCandidateDraft> = {}): MemoryCandidateDraft {
  return {
    key: 'favorite-map',
    content: 'Erangel',
    confidence: 'high',
    subject: 'self',
    kind: 'stable_preference',
    evidence: 'I prefer Erangel',
    validity: 'stable',
    ...overrides,
  };
}

function options(overrides: Partial<Parameters<typeof normalizeMemoryCandidates>[2]> = {}) {
  return {
    maxCandidates: 4,
    now: () => Date.parse('2026-10-16T00:00:00.000Z'),
    canonicalizeKey: (key: string) => key.toLowerCase(),
    isProhibited: () => false,
    createIdempotencyKey: ({ key, content }: { key: string; content: string }) =>
      `${key}:${content}`,
    ...overrides,
  };
}

test('normalizes supported self candidates only when content and evidence match source text', () => {
  const result = normalizeMemoryCandidates(
    [
      draft(),
      draft({
        key: 'next-season',
        kind: 'verifiable_fact',
        content: 'next season',
        evidence: 'I will play next season',
        validity: '30_days',
      }),
    ],
    [{ sourceEventId: 'event-1', content: 'I prefer Erangel and I will play next season' }],
    options(),
  );
  assert.deepEqual(result, [
    {
      key: 'favorite-map',
      content: 'Erangel',
      kind: 'stable_preference',
      validUntil: null,
      evidenceEventIds: ['event-1'],
      idempotencyKey: 'favorite-map:Erangel',
    },
    {
      key: 'next-season',
      content: 'next season',
      kind: 'verifiable_fact',
      validUntil: '2026-11-15T00:00:00.000Z',
      evidenceEventIds: ['event-1'],
      idempotencyKey: 'next-season:next season',
    },
  ]);
});

test('rejects weak, third-party, unsupported-validity, missing-source, and prohibited drafts', () => {
  const unsafe = draft({ key: 'secret', content: 'password', evidence: 'I use password' });
  const result = normalizeMemoryCandidates(
    [
      draft({ confidence: 'medium' }),
      draft({ subject: 'third_party' }),
      draft({ kind: 'episodic_checkpoint', validity: '90_days' }),
      draft({ evidence: 'I prefer Vikendi', content: 'Vikendi' }),
      unsafe,
    ],
    [
      { sourceEventId: 'event-1', content: 'I prefer Erangel' },
      { sourceEventId: 'event-secret', content: 'I use password' },
    ],
    options({
      isProhibited: (text) => text.includes('password'),
    }),
  );
  assert.deepEqual(result, []);
});

test('canonical-key duplicates keep the first source-grounded candidate and cap evidence IDs', () => {
  const sources = Array.from({ length: 10 }, (_, index) => ({
    sourceEventId: `event-${index}`,
    content: 'I prefer Erangel',
  }));
  const result = normalizeMemoryCandidates(
    [draft(), draft({ key: 'FAVORITE-MAP', content: 'Erangel', evidence: 'I prefer Erangel' })],
    sources,
    options(),
  );
  assert.equal(result.length, 1);
  assert.deepEqual(
    result[0]?.evidenceEventIds,
    sources.slice(0, 8).map((source) => source.sourceEventId),
  );
});
