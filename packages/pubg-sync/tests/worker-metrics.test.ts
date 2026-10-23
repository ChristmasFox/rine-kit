import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicSyncCycleLog } from '../src/worker-alerts.js';
import { PublicSyncWorkerMetrics } from '../src/worker-metrics.js';

test('worker metrics expose aggregate counters, queue gauges and fixed alert labels only', () => {
  const metrics = new PublicSyncWorkerMetrics();
  metrics.recordCycle(createPublicSyncCycleLog({
    observedAt: '2026-10-14T00:00:00.000Z',
    cycle: {
      teamsDiscovered: 7,
      teamsAttempted: 3,
      teamsCompleted: 2,
      teamsFailed: 1,
      matchesDiscovered: 9,
      telemetryFetched: 4,
      telemetryUnavailable: 1,
    },
    durationMs: 275,
    queue: {
      totalJobs: 7,
      dueJobs: 2,
      delayedJobs: 4,
      activeLeases: 1,
      expiredLeases: 1,
      retryingJobs: 1,
      oldestDueAgeSeconds: 1_000,
    },
    rssBytes: 2 * 1024 * 1024 * 1024,
    heapUsedBytes: 64,
  }));

  const rendered = metrics.render({
    rssBytes: 128,
    heapUsedBytes: 64,
    pool: { totalCount: 4, idleCount: 3, waitingCount: 1 },
  });
  assert.match(rendered, /pubg_saas_worker_queue_jobs_total 7\n/u);
  assert.match(rendered, /pubg_saas_worker_queue_jobs_due 2\n/u);
  assert.match(rendered, /pubg_saas_worker_sync_teams_attempted_total 3\n/u);
  assert.match(rendered, /pubg_saas_worker_sync_cycle_duration_milliseconds_bucket\{le="500"\} 1\n/u);
  assert.match(rendered, /pubg_saas_worker_alerts_total\{code="public_sync_queue_lag_high",severity="warning"\} 1\n/u);
  assert.match(rendered, /pubg_saas_worker_alerts_total\{code="public_sync_team_failures",severity="warning"\} 1\n/u);
  assert.doesNotMatch(rendered, /tenant|guild|player|actor|m2-local|team_id/iu);
});

test('worker metrics distinguish a missing queue snapshot from an empty one', () => {
  const rendered = new PublicSyncWorkerMetrics().render({
    rssBytes: 1,
    heapUsedBytes: 1,
    pool: { totalCount: 0, idleCount: 0, waitingCount: 0 },
  });
  assert.match(rendered, /pubg_saas_worker_queue_snapshot_available 0\n/u);
  assert.match(rendered, /pubg_saas_worker_queue_jobs_total 0\n/u);
});
