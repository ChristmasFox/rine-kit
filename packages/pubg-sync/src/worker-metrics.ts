import type { PublicSyncQueueSnapshot } from '@rine-kit/pubg-postgres';
import type { createPublicSyncCycleLog, PublicSyncAlertCode } from './worker-alerts.js';

const DURATION_BUCKETS_MS = [10, 50, 100, 250, 500, 1_000, 5_000, 30_000] as const;

type CycleLog = ReturnType<typeof createPublicSyncCycleLog>;

const ALERT_CODES: readonly { code: PublicSyncAlertCode; severity: 'warning' | 'critical' }[] = [
  { code: 'public_sync_queue_snapshot_unavailable', severity: 'critical' },
  { code: 'public_sync_queue_lag_high', severity: 'warning' },
  { code: 'public_sync_queue_expired_lease', severity: 'warning' },
  { code: 'public_sync_team_failures', severity: 'warning' },
  { code: 'public_sync_worker_rss_high', severity: 'warning' },
];

function number(value: number): string {
  return Number.isFinite(value) && value >= 0 ? String(value) : '0';
}

function gauge(name: string, help: string, value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${number(value)}`];
}

function counter(name: string, help: string, value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${number(value)}`];
}

/** Process-local, aggregate Worker metrics. Label values are fixed codes/states;
 * tenant, team, player, guild, channel and actor identifiers never enter this registry. */
export class PublicSyncWorkerMetrics {
  private cycles = 0;
  private readonly counters = {
    teamsDiscovered: 0,
    teamsAttempted: 0,
    teamsCompleted: 0,
    teamsFailed: 0,
    matchesDiscovered: 0,
    telemetryFetched: 0,
    telemetryUnavailable: 0,
  };
  private readonly alertCounts = new Map<PublicSyncAlertCode, number>(ALERT_CODES.map(({ code }) => [code, 0]));
  private readonly durationBuckets = DURATION_BUCKETS_MS.map(() => 0);
  private durationCount = 0;
  private durationSumMs = 0;
  private latestDurationMs = 0;
  private latestQueue: PublicSyncQueueSnapshot | null = null;

  recordCycle(log: CycleLog): void {
    this.cycles += 1;
    this.counters.teamsDiscovered += log.cycle.teamsDiscovered;
    this.counters.teamsAttempted += log.cycle.teamsAttempted;
    this.counters.teamsCompleted += log.cycle.teamsCompleted;
    this.counters.teamsFailed += log.cycle.teamsFailed;
    this.counters.matchesDiscovered += log.cycle.matchesDiscovered;
    this.counters.telemetryFetched += log.cycle.telemetryFetched;
    this.counters.telemetryUnavailable += log.cycle.telemetryUnavailable;
    this.latestDurationMs = log.cycle.durationMs;
    this.durationCount += 1;
    this.durationSumMs += log.cycle.durationMs;
    DURATION_BUCKETS_MS.forEach((bound, index) => {
      if (log.cycle.durationMs <= bound) this.durationBuckets[index]! += 1;
    });
    this.latestQueue = log.queue;
    for (const alert of log.alerts) this.alertCounts.set(alert.code, (this.alertCounts.get(alert.code) ?? 0) + 1);
  }

  render(input: {
    rssBytes: number;
    heapUsedBytes: number;
    pool: { totalCount: number; idleCount: number; waitingCount: number };
  }): string {
    const lines = [
      ...gauge('pubg_saas_worker_up', 'Worker process is serving metrics.', 1),
      ...gauge('pubg_saas_worker_process_rss_bytes', 'Current Worker resident memory in bytes.', input.rssBytes),
      ...gauge('pubg_saas_worker_process_heap_used_bytes', 'Current Worker V8 heap used in bytes.', input.heapUsedBytes),
      ...gauge('pubg_saas_worker_pg_pool_total', 'Current PostgreSQL pool connections.', input.pool.totalCount),
      ...gauge('pubg_saas_worker_pg_pool_idle', 'Idle PostgreSQL pool connections.', input.pool.idleCount),
      ...gauge('pubg_saas_worker_pg_pool_waiting', 'Clients waiting for a PostgreSQL pool connection.', input.pool.waitingCount),
      ...gauge('pubg_saas_worker_sync_cycle_duration_ms', 'Duration of the most recently completed sync cycle.', this.latestDurationMs),
      ...gauge('pubg_saas_worker_queue_snapshot_available', 'Whether the most recent queue snapshot was available.', this.latestQueue === null ? 0 : 1),
      ...gauge('pubg_saas_worker_queue_jobs_total', 'Jobs in the most recent queue snapshot.', this.latestQueue?.totalJobs ?? 0),
      ...gauge('pubg_saas_worker_queue_jobs_due', 'Due jobs in the most recent queue snapshot.', this.latestQueue?.dueJobs ?? 0),
      ...gauge('pubg_saas_worker_queue_jobs_delayed', 'Delayed jobs in the most recent queue snapshot.', this.latestQueue?.delayedJobs ?? 0),
      ...gauge('pubg_saas_worker_queue_active_leases', 'Active leases in the most recent queue snapshot.', this.latestQueue?.activeLeases ?? 0),
      ...gauge('pubg_saas_worker_queue_expired_leases', 'Expired leases in the most recent queue snapshot.', this.latestQueue?.expiredLeases ?? 0),
      ...gauge('pubg_saas_worker_queue_retrying_jobs', 'Retrying jobs in the most recent queue snapshot.', this.latestQueue?.retryingJobs ?? 0),
      ...gauge('pubg_saas_worker_queue_oldest_due_age_seconds', 'Age of the oldest due job in seconds; zero when no due job exists.', this.latestQueue?.oldestDueAgeSeconds ?? 0),
      '# HELP pubg_saas_worker_sync_cycle_duration_milliseconds Sync cycle duration histogram since process start.',
      '# TYPE pubg_saas_worker_sync_cycle_duration_milliseconds histogram',
    ];
    lines.push(...counter('pubg_saas_worker_sync_cycles_total', 'Completed public sync cycles since process start.', this.cycles));
    lines.push(...counter('pubg_saas_worker_sync_teams_discovered_total', 'Teams discovered since process start.', this.counters.teamsDiscovered));
    lines.push(...counter('pubg_saas_worker_sync_teams_attempted_total', 'Teams attempted since process start.', this.counters.teamsAttempted));
    lines.push(...counter('pubg_saas_worker_sync_teams_completed_total', 'Teams completed since process start.', this.counters.teamsCompleted));
    lines.push(...counter('pubg_saas_worker_sync_teams_failed_total', 'Teams failed since process start.', this.counters.teamsFailed));
    lines.push(...counter('pubg_saas_worker_sync_matches_discovered_total', 'Matches discovered since process start.', this.counters.matchesDiscovered));
    lines.push(...counter('pubg_saas_worker_sync_telemetry_fetched_total', 'Telemetry files fetched since process start.', this.counters.telemetryFetched));
    lines.push(...counter('pubg_saas_worker_sync_telemetry_unavailable_total', 'Telemetry files unavailable since process start.', this.counters.telemetryUnavailable));
    DURATION_BUCKETS_MS.forEach((bound, index) => {
      lines.push(`pubg_saas_worker_sync_cycle_duration_milliseconds_bucket{le="${bound}"} ${number(this.durationBuckets[index]!)}`);
    });
    lines.push(
      `pubg_saas_worker_sync_cycle_duration_milliseconds_bucket{le="+Inf"} ${number(this.durationCount)}`,
      `pubg_saas_worker_sync_cycle_duration_milliseconds_sum ${number(this.durationSumMs)}`,
      `pubg_saas_worker_sync_cycle_duration_milliseconds_count ${number(this.durationCount)}`,
      '# HELP pubg_saas_worker_alerts_total Worker alert codes observed since process start.',
      '# TYPE pubg_saas_worker_alerts_total counter',
    );
    for (const { code, severity } of ALERT_CODES) {
      lines.push(`pubg_saas_worker_alerts_total{code="${code}",severity="${severity}"} ${this.alertCounts.get(code) ?? 0}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
