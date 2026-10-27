import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { assertArchiveOutsideRepository } from '@rine-kit/pubg-intelligence/backfill';
import { RawTelemetryArchive } from '@rine-kit/pubg-intelligence/archive';
import {
  clampSyncDelayMs,
  HOURLY_PREFETCH_MINUTE,
  HOURLY_PREFETCH_TIMEZONE,
  nextHourlyPrefetchDelayMs,
  syncCyclePauseMs,
} from './hourly-prefetch.js';
import { PublicSyncWorker } from './sync-worker.js';
import { PostgresPublicPubgAdmission } from './request-limiter.js';
import { configurePublicEgress } from './public-egress.js';
import {
  startWorkerHealthServer,
  startWorkerMetricsServer,
  stopWorkerHealthServer,
  stopWorkerMetricsServer,
} from './worker-health-server.js';
import { createPublicSyncCycleLog } from './worker-alerts.js';
import { PublicSyncWorkerMetrics } from './worker-metrics.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;

function hourMinute(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 59) throw new Error('pubg_saas_worker_config_invalid');
  return result;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error('pubg_saas_worker_config_invalid');
  return result;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { signal.removeEventListener('abort', finish); clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Without --apply this entrypoint is a side-effect-free preview. --once keeps
 * an explicitly applied worker run bounded for local acceptance and recovery. */
export async function publicSyncWorkerMain(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (args.length === 0) {
    process.stdout.write('PUBG_SAAS_SYNC_WORKER=dry-run; start requires --apply, DATABASE_URL, and PUBLIC_PUBG_API_KEY.\n');
    return;
  }
  const once = args.includes('--once');
  if (!args.includes('--apply') || args.length !== (once ? 2 : 1) || args.some(value => value !== '--apply' && value !== '--once')) {
    throw new Error('pubg_saas_worker_arguments_invalid');
  }
  const databaseUrl = env.DATABASE_URL;
  const apiKey = env.PUBLIC_PUBG_API_KEY;
  if (!databaseUrl || !apiKey?.trim()) throw new Error('pubg_saas_worker_config_missing');
  configurePublicEgress(env);
  let parsed: URL;
  try { parsed = new URL(databaseUrl); }
  catch { throw new Error('pubg_saas_database_url_invalid'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('pubg_saas_database_url_invalid');

  const requestsPerMinute = positiveInteger(env.PUBLIC_PUBG_REQUESTS_PER_MINUTE, 10, 1000);
  const explicitInterval = env.PUBLIC_SYNC_INTERVAL_MS?.trim();
  const hourly = !explicitInterval;
  const intervalMs = positiveInteger(explicitInterval, DEFAULT_INTERVAL_MS, 24 * 60 * 60_000);
  const timeZone = env.PUBLIC_SYNC_TIMEZONE?.trim() || HOURLY_PREFETCH_TIMEZONE;
  const minute = hourMinute(env.PUBLIC_SYNC_HOURLY_MINUTE, HOURLY_PREFETCH_MINUTE);
  if (hourly) nextHourlyPrefetchDelayMs(new Date(), { timeZone, minute });
  const maxMatches = positiveInteger(env.PUBLIC_SYNC_MAX_MATCHES, 500, 1000);
  const maxTelemetryFetches = positiveInteger(env.PUBLIC_SYNC_MAX_TELEMETRY_FETCHES, 20, 50);
  const teamConcurrency = positiveInteger(env.PUBLIC_SYNC_TEAM_CONCURRENCY, 2, 16);
  const catchupRaw = env.PUBLIC_SYNC_CATCHUP_MS?.trim();
  // Hourly mode only: a team with telemetry still waiting is run again after this long (default 5 minutes; 0 = off).
  const catchupDelayMs = hourly && catchupRaw !== '0' ? positiveInteger(catchupRaw, 5 * 60_000, 60 * 60_000) : undefined;
  const leaseMs = positiveInteger(env.PUBLIC_SYNC_LEASE_MS, 120_000, 15 * 60_000);
  const archiveDirectory = env.PUBLIC_TELEMETRY_ARCHIVE_DIR?.trim() || undefined;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 30_000 });
  const stop = new AbortController();
  const metrics = new PublicSyncWorkerMetrics();
  let healthServer: Awaited<ReturnType<typeof startWorkerHealthServer>> | undefined;
  let metricsServer: Awaited<ReturnType<typeof startWorkerMetricsServer>> | undefined;
  const onStop = () => stop.abort();
  process.once('SIGINT', onStop);
  process.once('SIGTERM', onStop);
  try {
    const ready = await pool.query("SELECT 1 FROM pubg_schema_migrations WHERE migration_id='0001_pubg_schema.sql'");
    const current = await pool.query("SELECT 1 FROM pubg_schema_migrations WHERE migration_id='0004_sync_job_dirty.sql'");
    if (!ready.rowCount || !current.rowCount) throw new Error('pubg_saas_schema_upgrade_required');
    healthServer = await startWorkerHealthServer();
    const metricsPort = positiveInteger(env.PUBG_SAAS_WORKER_METRICS_PORT, 9464, 65_535);
    metricsServer = await startWorkerMetricsServer(() => {
      const memory = process.memoryUsage();
      return metrics.render({
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        pool: { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount },
      });
    }, metricsPort);
    const worker = new PublicSyncWorker(pool, {
      apiKey,
      admission: new PostgresPublicPubgAdmission(pool, requestsPerMinute, 30_000),
      maxMatches,
      maxTelemetryFetches,
      teamConcurrency,
      syncIntervalMs: intervalMs,
      leaseMs,
      ...(archiveDirectory ? { rawTelemetryArchive: new RawTelemetryArchive(await assertArchiveOutsideRepository(archiveDirectory, env.PUBLIC_SYNC_REPOSITORY_ROOT?.trim() || process.cwd())) } : {}),
      ...(catchupDelayMs !== undefined ? { catchupDelayMs } : {}),
      ...(hourly ? { nextSyncDelayMs: (now: Date) => clampSyncDelayMs(nextHourlyPrefetchDelayMs(now, { timeZone, minute })) } : {}),
      onTeamError: code => process.stderr.write(`${code}\n`),
    });
    do {
      const cycleStartedAt = performance.now();
      const result = await worker.runOnce(stop.signal);
      let queue: Awaited<ReturnType<PublicSyncWorker['getQueueSnapshot']>> | null = null;
      try {
        queue = await worker.getQueueSnapshot();
      } catch {
        // A telemetry read failure must not discard a completed sync cycle or
        // print database details into collected worker logs.
      }
      const memory = process.memoryUsage();
      const cycleLog = createPublicSyncCycleLog({
        observedAt: new Date().toISOString(),
        cycle: result,
        durationMs: Math.round((performance.now() - cycleStartedAt) * 10) / 10,
        queue,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      });
      metrics.recordCycle(cycleLog);
      process.stdout.write(`${JSON.stringify(cycleLog)}\n`);
      if (once || stop.signal.aborted) break;
      await wait(syncCyclePauseMs({ hourly, intervalMs, now: new Date(), timeZone, minute }), stop.signal);
    } while (!stop.signal.aborted);
  } finally {
    stop.abort();
    process.removeListener('SIGINT', onStop);
    process.removeListener('SIGTERM', onStop);
    try {
      if (metricsServer) await stopWorkerMetricsServer(metricsServer);
    } finally {
      try {
        if (healthServer) await stopWorkerHealthServer(healthServer);
      } finally {
        await pool.end();
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void publicSyncWorkerMain(process.argv.slice(2)).catch(() => {
    process.stderr.write('pubg_saas_sync_worker_startup_failed\n');
    process.exitCode = 1;
  });
}
