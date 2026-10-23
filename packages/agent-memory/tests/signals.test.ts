import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryUsageSignals, memoryQueryFingerprint } from '../src/signals.js';

test('memory query fingerprints normalize equivalent queries without retaining query text', () => {
  const query = '  我   常去艾伦格  ';
  const fingerprint = memoryQueryFingerprint(query);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(memoryQueryFingerprint('我 常去艾伦格'), fingerprint);
  assert.notEqual(memoryQueryFingerprint('我常去米拉玛'), fingerprint);
  assert.match(memoryQueryFingerprint('x'.repeat(8_000)), /^[a-f0-9]{64}$/u);
  assert.throws(
    () => memoryQueryFingerprint('x'.repeat(8_001)),
    /memory_query_fingerprint_input_invalid/u,
  );
  assert.doesNotMatch(
    JSON.stringify(
      createMemoryUsageSignals(query, [
        {
          key: 'favorite_map',
          revision: 2,
          sourceEventId: 'source-event',
        },
      ]),
    ),
    /艾伦格/u,
  );
});

test('usage signal factory deduplicates one entry and rejects malformed metadata', () => {
  const signals = createMemoryUsageSignals('favorite map', [
    { key: 'favorite_map', revision: 2, sourceEventId: 'source-1' },
    { key: 'favorite_map', revision: 2, sourceEventId: 'source-1' },
    { key: '', revision: 2, sourceEventId: 'source-2' },
    { key: 'stale', revision: 0, sourceEventId: 'source-3' },
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.key, 'favorite_map');
});
