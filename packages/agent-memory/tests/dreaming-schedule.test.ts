import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDreamingLocalDateAt, nextMemoryDreamingAt } from '../src/dreaming/schedule.js';

const at = (value: string) => Date.parse(value);
const timezone = 'Asia/Shanghai';

test('Dreaming schedules the next strictly future local 03:00 without startup catch-up', () => {
  assert.equal(
    nextMemoryDreamingAt(at('2026-10-15T18:59:00Z'), timezone),
    at('2026-10-15T19:00:00Z'),
  );
  assert.equal(
    nextMemoryDreamingAt(at('2026-10-15T19:00:00Z'), timezone),
    at('2026-10-16T19:00:00Z'),
  );
  assert.equal(
    nextMemoryDreamingAt(at('2026-10-15T19:01:00Z'), timezone),
    at('2026-10-16T19:00:00Z'),
  );
  assert.equal(memoryDreamingLocalDateAt(at('2026-10-15T19:00:00Z'), timezone), '2026-10-16');
});

test('Dreaming rejects invalid clock and timezone inputs', () => {
  assert.throws(() => nextMemoryDreamingAt(Number.NaN, timezone), /memory_dreaming_clock_invalid/u);
  assert.throws(() => nextMemoryDreamingAt(at('2026-10-15T00:00:00Z'), 'Invalid/Zone'));
});
