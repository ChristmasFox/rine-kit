import assert from 'node:assert/strict';
import test from 'node:test';
import { equivalentMemoryContent, findMemoryConflicts } from '../src/write/conflicts.js';
import type { MemoryEntry } from '../src/contracts.js';

function entry(key: string, content: string, revision = 1): MemoryEntry {
  return {
    key,
    content,
    revision,
    updatedAt: '2026-10-01T00:00:00.000Z',
    sourceEventId: `event-${key}`,
    sourceKind: 'user_confirmed',
    sourceReliability: 95,
    validUntil: null,
  };
}

test('generic write conflict detection excludes the active key, collapses revisions, and ranks overlap', () => {
  const conflicts = findMemoryConflicts('map', 'I prefer Erangel forest', [
    entry('map', 'Erangel forest'),
    entry('favorite_map', 'I prefer the Erangel forest', 1),
    entry('favorite_map', 'I prefer Erangel forest', 2),
    entry('favorite_weapon', 'I prefer the AKM'),
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.entry.revision, 2);
  assert.ok(conflicts[0]!.overlap >= 0.72);
  assert.equal(equivalentMemoryContent('I prefer Erangel forest', 'I prefer Erangel forest'), true);
  assert.equal(equivalentMemoryContent('Erangel forest', 'Miramar desert'), false);
});

test('generic write conflict detection rejects invalid thresholds', () => {
  assert.throws(
    () => findMemoryConflicts('map', 'Erangel', [], 1.1),
    /memory_conflict_threshold_invalid/,
  );
});
