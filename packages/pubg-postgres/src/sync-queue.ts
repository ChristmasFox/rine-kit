import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export interface PublicSyncJob {
  tenantId: string;
  teamId: string;
  leaseToken: string;
  attemptCount: number;
}

export interface PublicSyncQueueOptions {
  leaseMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
}

export interface PublicSyncQueueSnapshot {
  totalJobs: number;
  dueJobs: number;
  delayedJobs: number;
  activeLeases: number;
  expiredLeases: number;
  retryingJobs: number;
  oldestDueAgeSeconds: number | null;
}

interface CandidateRow extends QueryResultRow {
  tenant_id: string;
  team_id: string;
  attempt_count: number;
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('public_sync_queue_config_invalid');
  }
  return value;
}

/** Durable, team-scoped scheduling for the independent public SaaS worker.
 * Queue rows are keyed and cascaded by (tenant_id, team_id); each claim uses a
 * per-job fencing token so expired workers cannot complete a newer lease. */
export class PublicSyncQueue {
  private readonly leaseMs: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;

  constructor(private readonly pool: Pool, options: PublicSyncQueueOptions = {}) {
    this.leaseMs = boundedInteger(options.leaseMs ?? 120_000, 1_000, 15 * 60_000);
    this.baseRetryMs = boundedInteger(options.baseRetryMs ?? 30_000, 100, 15 * 60_000);
    this.maxRetryMs = boundedInteger(options.maxRetryMs ?? 30 * 60_000, this.baseRetryMs, 24 * 60 * 60_000);
  }

  /** Add newly registered teams without resetting their existing schedule. */
  async ensureTeams(): Promise<number> {
    return transaction(this.pool, async (client) => {
      await client.query(`INSERT INTO pubg_sync_jobs(tenant_id,team_id)
        SELECT tenant_id,team_id FROM pubg_teams ON CONFLICT(tenant_id,team_id) DO NOTHING`);
      const result = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM pubg_teams');
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  /** Returns deployment-wide counts only; tenant and team identifiers never
   * leave PostgreSQL through worker telemetry. */
  async getSnapshot(): Promise<PublicSyncQueueSnapshot> {
    const result = await this.pool.query<{
      total_jobs: string;
      due_jobs: string;
      delayed_jobs: string;
      active_leases: string;
      expired_leases: string;
      retrying_jobs: string;
      oldest_due_age_seconds: number | null;
    }>(`SELECT COUNT(*)::text AS total_jobs,
        COUNT(*) FILTER (WHERE lease_token IS NULL AND next_attempt_at<=now())::text AS due_jobs,
        COUNT(*) FILTER (WHERE lease_token IS NULL AND next_attempt_at>now())::text AS delayed_jobs,
        COUNT(*) FILTER (WHERE lease_token IS NOT NULL AND lease_until>now())::text AS active_leases,
        COUNT(*) FILTER (WHERE lease_token IS NOT NULL AND lease_until<=now())::text AS expired_leases,
        COUNT(*) FILTER (WHERE last_error_code IS NOT NULL)::text AS retrying_jobs,
        EXTRACT(EPOCH FROM (now() - MIN(next_attempt_at)
          FILTER (WHERE lease_token IS NULL AND next_attempt_at<=now())))::double precision AS oldest_due_age_seconds
      FROM pubg_sync_jobs`);
    const row = result.rows[0];
    if (!row) throw new Error('public_sync_queue_snapshot_unavailable');
    return {
      totalJobs: Number(row.total_jobs),
      dueJobs: Number(row.due_jobs),
      delayedJobs: Number(row.delayed_jobs),
      activeLeases: Number(row.active_leases),
      expiredLeases: Number(row.expired_leases),
      retryingJobs: Number(row.retrying_jobs),
      oldestDueAgeSeconds: row.oldest_due_age_seconds,
    };
  }

  /** Claims at most `limit` due teams atomically across all worker processes. */
  async claimDue(limit: number): Promise<PublicSyncJob[]> {
    boundedInteger(limit, 1, 64);
    return transaction(this.pool, async (client) => {
      const candidates = await client.query<CandidateRow>(`SELECT job.tenant_id,job.team_id,job.attempt_count
        FROM pubg_sync_jobs job JOIN pubg_teams team
          ON team.tenant_id=job.tenant_id AND team.team_id=job.team_id
        WHERE job.next_attempt_at<=now() AND (job.lease_until IS NULL OR job.lease_until<=now())
        ORDER BY job.next_attempt_at,job.tenant_id,job.team_id
        LIMIT $1 FOR UPDATE OF job SKIP LOCKED`, [limit]);
      const jobs: PublicSyncJob[] = [];
      for (const candidate of candidates.rows) {
        const leaseToken = randomBytes(24).toString('base64url');
        const claimed = await client.query(`UPDATE pubg_sync_jobs SET lease_token=$3,
          lease_until=now()+($4::BIGINT*interval '1 millisecond'),attempt_count=LEAST(attempt_count+1,32767),
          updated_at=now() WHERE tenant_id=$1 AND team_id=$2 RETURNING attempt_count`,
        [candidate.tenant_id, candidate.team_id, leaseToken, this.leaseMs]);
        if (claimed.rowCount !== 1) throw new Error('public_sync_queue_claim_lost');
        jobs.push({
          tenantId: candidate.tenant_id,
          teamId: candidate.team_id,
          leaseToken,
          attemptCount: Number(claimed.rows[0]?.attempt_count ?? candidate.attempt_count + 1),
        });
      }
      return jobs;
    });
  }

  async renew(job: PublicSyncJob): Promise<boolean> {
    const result = await this.pool.query(`UPDATE pubg_sync_jobs SET
      lease_until=now()+($4::BIGINT*interval '1 millisecond'),updated_at=now()
      WHERE tenant_id=$1 AND team_id=$2 AND lease_token=$3 AND lease_until>now()`,
    [job.tenantId, job.teamId, job.leaseToken, this.leaseMs]);
    return result.rowCount === 1;
  }

  async complete(job: PublicSyncJob, intervalMs: number): Promise<boolean> {
    boundedInteger(intervalMs, 1_000, 24 * 60 * 60_000);
    const result = await this.pool.query(`UPDATE pubg_sync_jobs SET lease_token=NULL,lease_until=NULL,
      attempt_count=0,last_error_code=NULL,next_attempt_at=now()+($4::BIGINT*interval '1 millisecond'),updated_at=now()
      WHERE tenant_id=$1 AND team_id=$2 AND lease_token=$3 AND lease_until>now()`,
    [job.tenantId, job.teamId, job.leaseToken, intervalMs]);
    return result.rowCount === 1;
  }

  /** Failures retain the durable job and use capped exponential retry. Error
   * values are deliberately restricted to stable codes; raw provider/DB errors
   * are never persisted in the queue. */
  async fail(job: PublicSyncJob, errorCode: string): Promise<boolean> {
    const code = /^[a-z0-9_]{1,64}$/u.test(errorCode) ? errorCode : 'public_sync_team_failed';
    const retryMs = Math.min(this.maxRetryMs, this.baseRetryMs * 2 ** Math.min(job.attemptCount - 1, 20));
    const result = await this.pool.query(`UPDATE pubg_sync_jobs SET lease_token=NULL,lease_until=NULL,
      last_error_code=$4,next_attempt_at=now()+($5::BIGINT*interval '1 millisecond'),updated_at=now()
      WHERE tenant_id=$1 AND team_id=$2 AND lease_token=$3 AND lease_until>now()`,
    [job.tenantId, job.teamId, job.leaseToken, code, retryMs]);
    return result.rowCount === 1;
  }
}
