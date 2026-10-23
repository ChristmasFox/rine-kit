import type { PublicSyncQueueSnapshot } from '@rine-kit/pubg-postgres';
import type { PublicSyncCycleResult } from './sync-worker.js';

export const PUBLIC_SYNC_ALERT_THRESHOLDS = Object.freeze({
  oldestDueAgeSeconds: 15 * 60,
  workerRssBytes: Math.floor(2 * 1024 * 1024 * 1024 * 0.8),
});

export type PublicSyncAlertCode =
  | 'public_sync_queue_snapshot_unavailable'
  | 'public_sync_queue_lag_high'
  | 'public_sync_queue_expired_lease'
  | 'public_sync_team_failures'
  | 'public_sync_worker_rss_high';

export interface PublicSyncAlert {
  code: PublicSyncAlertCode;
  severity: 'warning' | 'critical';
}

/** Stable, identifier-free alert signals for host log collection. This only
 * derives warnings; service health and worker admission remain independent. */
export function evaluatePublicSyncAlerts(input: {
  cycle: Pick<PublicSyncCycleResult, 'teamsFailed'>;
  queue: PublicSyncQueueSnapshot | null;
  rssBytes: number;
}): PublicSyncAlert[] {
  const alerts: PublicSyncAlert[] = [];
  if (input.queue === null) {
    alerts.push({ code: 'public_sync_queue_snapshot_unavailable', severity: 'critical' });
  } else {
    if (input.queue.oldestDueAgeSeconds !== null
      && input.queue.oldestDueAgeSeconds >= PUBLIC_SYNC_ALERT_THRESHOLDS.oldestDueAgeSeconds) {
      alerts.push({ code: 'public_sync_queue_lag_high', severity: 'warning' });
    }
    if (input.queue.expiredLeases > 0) {
      alerts.push({ code: 'public_sync_queue_expired_lease', severity: 'warning' });
    }
  }
  if (input.cycle.teamsFailed > 0) {
    alerts.push({ code: 'public_sync_team_failures', severity: 'warning' });
  }
  if (input.rssBytes >= PUBLIC_SYNC_ALERT_THRESHOLDS.workerRssBytes) {
    alerts.push({ code: 'public_sync_worker_rss_high', severity: 'warning' });
  }
  return alerts;
}

export function createPublicSyncCycleLog(input: {
  observedAt: string;
  cycle: PublicSyncCycleResult;
  durationMs: number;
  queue: PublicSyncQueueSnapshot | null;
  rssBytes: number;
  heapUsedBytes: number;
}) {
  return {
    event: 'pubg_saas_sync_cycle',
    observedAt: input.observedAt,
    cycle: { ...input.cycle, durationMs: input.durationMs },
    queue: input.queue,
    queueSnapshotError: input.queue === null,
    process: { rssBytes: input.rssBytes, heapUsedBytes: input.heapUsedBytes },
    alerts: evaluatePublicSyncAlerts({
      cycle: input.cycle,
      queue: input.queue,
      rssBytes: input.rssBytes,
    }),
  };
}
