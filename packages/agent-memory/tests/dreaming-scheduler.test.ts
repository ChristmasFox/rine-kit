import assert from 'node:assert/strict';
import test from 'node:test';
import { runMemoryDreamingScheduler } from '../src/dreaming/scheduler.js';
import type { DreamingReport } from '../src/contracts.js';
import type { MemoryDreamingSchedulePoint } from '../src/dreaming/scheduler.js';

const shanghai = 'Asia/Shanghai';
const at = (value: string) => Date.parse(value);
const report: DreamingReport = {
  startedAt: '2026-10-15T19:00:00.000Z',
  completedAt: '2026-10-15T19:01:00.000Z',
  stages: [],
};

test('generic scheduler sleeps to one local 03:00, claims once, and runs through the plugin', async () => {
  let now = at('2026-10-15T18:59:00.000Z');
  const identities: Array<{ localDate: string; timezone: string }> = [];
  const statuses: string[] = [];
  const events: Record<string, unknown>[] = [];
  let runs = 0;
  const controller = new AbortController();
  await runMemoryDreamingScheduler<{ localDate: string; timezone: string }>(
    {
      async runDreaming() {
        runs += 1;
        return report;
      },
    },
    {
      async claim(identity) {
        identities.push(identity);
        return 'run-1';
      },
      async finish(_identity, _runId, status) {
        statuses.push(status);
      },
    },
    controller.signal,
    (event) => {
      events.push(event);
      if (event.event === 'dreaming_run_completed') controller.abort();
    },
    {
      timezone: shanghai,
      fallbackTimezone: 'UTC',
      identity: (point) => ({ localDate: point.localDate, timezone: point.timezone }),
      now: () => now,
      sleepUntil: async (scheduledAt) => {
        now = scheduledAt;
      },
    },
  );

  assert.equal(now, at('2026-10-15T19:00:00.000Z'));
  assert.deepEqual(identities, [{ localDate: '2026-10-16', timezone: shanghai }]);
  assert.deepEqual(statuses, ['succeeded']);
  assert.equal(runs, 1);
  assert.equal(events.at(-1)?.event, 'dreaming_run_completed');
});

test('generic scheduler retries a failed run on the next local date without blocking chat', async () => {
  let now = at('2026-10-15T18:59:59.000Z');
  const dates: string[] = [];
  const statuses: string[] = [];
  const events: Record<string, unknown>[] = [];
  let runs = 0;
  const controller = new AbortController();
  await runMemoryDreamingScheduler<MemoryDreamingSchedulePoint>(
    {
      async runDreaming() {
        runs += 1;
        if (runs === 1) throw new Error('transcript must not be logged');
        return report;
      },
    },
    {
      async claim(identity) {
        dates.push(identity.localDate);
        return `run-${dates.length}`;
      },
      async finish(_identity, _runId, status) {
        statuses.push(status);
      },
    },
    controller.signal,
    (event) => {
      events.push(event);
      if (event.event === 'dreaming_run_completed') controller.abort();
    },
    {
      timezone: shanghai,
      fallbackTimezone: 'UTC',
      identity: (point) => point,
      now: () => now,
      sleepUntil: async (scheduledAt) => {
        now = scheduledAt;
      },
    },
  );

  assert.deepEqual(dates, ['2026-10-16', '2026-10-17']);
  assert.deepEqual(statuses, ['failed', 'succeeded']);
  assert.equal(events.filter((event) => event.event === 'dreaming_run_failed').length, 1);
  assert.equal(JSON.stringify(events).includes('transcript must not be logged'), false);
});
