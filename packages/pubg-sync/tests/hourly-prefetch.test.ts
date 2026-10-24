import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampSyncDelayMs,
  nextHourlyPrefetchDelayMs,
  syncCyclePauseMs,
} from '../src/hourly-prefetch.js';

test('hourly prefetch matches Lab: minute 5 Asia/Shanghai, and the same slot is not run twice', () => {
  const before = new Date('2026-10-24T02:04:30.000Z');
  assert.equal(nextHourlyPrefetchDelayMs(before), 30_000);
  const exactly = new Date('2026-10-24T02:05:00.000Z');
  assert.equal(nextHourlyPrefetchDelayMs(exactly), 60 * 60_000);
  const justAfter = new Date('2026-10-24T02:05:01.000Z');
  assert.equal(nextHourlyPrefetchDelayMs(justAfter), 60 * 60_000 - 1_000);
});

test('hourly prefetch rolls to 00:05 the next calendar day', () => {
  const evening = new Date('2026-10-24T15:30:00.000Z');
  assert.equal(nextHourlyPrefetchDelayMs(evening), 35 * 60_000);
});

test('an explicit sync interval is unchanged; the hourly clock only shortens the idle wait', () => {
  const now = new Date('2026-10-24T02:00:00.000Z');
  assert.equal(syncCyclePauseMs({ hourly: false, intervalMs: 5 * 60_000, now }), 5 * 60_000);
  assert.equal(syncCyclePauseMs({ hourly: true, intervalMs: 5 * 60_000, now }), 60_000);
  const near = new Date('2026-10-24T02:04:30.000Z');
  assert.equal(syncCyclePauseMs({ hourly: true, intervalMs: 5 * 60_000, now: near }), 30_000);
});

test('queue delay stays inside the sync job bounds', () => {
  assert.equal(clampSyncDelayMs(200), 1_000);
  assert.equal(clampSyncDelayMs(30_000), 30_000);
  assert.equal(clampSyncDelayMs(48 * 60 * 60_000), 24 * 60 * 60_000);
});

test('hourly clock rejects a bad minute or timezone', () => {
  assert.throws(() => nextHourlyPrefetchDelayMs(new Date(), { minute: 60 }), /public_sync_hourly_minute_invalid/);
  assert.throws(() => nextHourlyPrefetchDelayMs(new Date(), { timeZone: 'Not/AZone' }), /public_sync_hourly_timezone_invalid/);
});
