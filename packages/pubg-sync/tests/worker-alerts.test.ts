import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPublicSyncCycleLog,
  evaluatePublicSyncAlerts,
  PUBLIC_SYNC_ALERT_THRESHOLDS,
} from '../src/worker-alerts.js';
import type { PublicSyncQueueSnapshot } from '@rine-kit/pubg-postgres';

const queue: PublicSyncQueueSnapshot = {
  totalJobs: 0,
  dueJobs: 0,
  delayedJobs: 0,
  activeLeases: 0,
  expiredLeases: 0,
  retryingJobs: 0,
  oldestDueAgeSeconds: null,
};

test('worker alert policy stays quiet below queue, failure, lease and memory thresholds', () => {
  assert.deepEqual(evaluatePublicSyncAlerts({
    cycle: { teamsFailed: 0 },
    queue: { ...queue, dueJobs: 1, oldestDueAgeSeconds: PUBLIC_SYNC_ALERT_THRESHOLDS.oldestDueAgeSeconds - 1 },
    rssBytes: PUBLIC_SYNC_ALERT_THRESHOLDS.workerRssBytes - 1,
  }), []);
});

test('worker alert policy reports aggregate queue lag, expired leases, team failures and high RSS', () => {
  assert.deepEqual(evaluatePublicSyncAlerts({
    cycle: { teamsFailed: 2 },
    queue: {
      ...queue,
      dueJobs: 3,
      expiredLeases: 1,
      oldestDueAgeSeconds: PUBLIC_SYNC_ALERT_THRESHOLDS.oldestDueAgeSeconds,
    },
    rssBytes: PUBLIC_SYNC_ALERT_THRESHOLDS.workerRssBytes,
  }), [
    { code: 'public_sync_queue_lag_high', severity: 'warning' },
    { code: 'public_sync_queue_expired_lease', severity: 'warning' },
    { code: 'public_sync_team_failures', severity: 'warning' },
    { code: 'public_sync_worker_rss_high', severity: 'warning' },
  ]);
});

test('unavailable queue telemetry is critical and emits no tenant identifiers', () => {
  const alerts = evaluatePublicSyncAlerts({
    cycle: { teamsFailed: 0 },
    queue: null,
    rssBytes: 1,
  });
  assert.deepEqual(alerts, [{ code: 'public_sync_queue_snapshot_unavailable', severity: 'critical' }]);
  assert.equal(JSON.stringify(alerts).includes('tenant'), false);
  assert.equal(JSON.stringify(alerts).includes('team'), false);
});

test('structured worker cycle log carries alert codes without queue identifiers', () => {
  const log = createPublicSyncCycleLog({
    observedAt: '2026-10-14T00:00:00.000Z',
    cycle: {
      teamsDiscovered: 2,
      teamsAttempted: 0,
      teamsCompleted: 0,
      teamsFailed: 0,
      matchesDiscovered: 0,
      telemetryFetched: 0,
      telemetryUnavailable: 0,
    },
    durationMs: 4,
    queue: null,
    rssBytes: 100,
    heapUsedBytes: 50,
  });
  assert.equal(log.event, 'pubg_saas_sync_cycle');
  assert.equal(log.queueSnapshotError, true);
  assert.deepEqual(log.alerts, [{ code: 'public_sync_queue_snapshot_unavailable', severity: 'critical' }]);
  const serialized = JSON.stringify(log);
  assert.equal(serialized.includes('tenantId'), false);
  assert.equal(serialized.includes('teamId'), false);
});
