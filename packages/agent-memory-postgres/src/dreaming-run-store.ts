import type { Pool } from 'pg';
import type { MemoryDreamingRunStore } from '@rine-kit/agent-memory';

export interface MemoryDreamingRunIdentity {
  namespace: string;
  timezone: string;
  localDate: string;
  scheduledAt: Date;
}

/** Durable claim so a scheduled Dreaming run happens once per namespace and local date (Gate's run store). */
export class PostgresMemoryDreamingRunStore implements MemoryDreamingRunStore<MemoryDreamingRunIdentity> {
  constructor(private readonly pool: Pool) {}

  async claim(identity: MemoryDreamingRunIdentity): Promise<string | null> {
    const result = await this.pool.query<{ run_id: string }>(
      `INSERT INTO agent_memory_dreaming_runs(namespace,timezone,scheduled_date,scheduled_at)
       VALUES ($1,$2,$3::DATE,$4::TIMESTAMPTZ)
       ON CONFLICT (namespace,timezone,scheduled_date) DO NOTHING
       RETURNING run_id::TEXT`,
      [identity.namespace, identity.timezone, identity.localDate, identity.scheduledAt],
    );
    return result.rows[0]?.run_id ?? null;
  }

  async finish(
    identity: MemoryDreamingRunIdentity,
    runId: string,
    status: 'succeeded' | 'failed',
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE agent_memory_dreaming_runs SET status=$5,completed_at=now(),
         error_code=CASE WHEN $5='failed' THEN 'dreaming_run_failed' ELSE NULL END
       WHERE namespace=$1 AND timezone=$2 AND scheduled_date=$3::DATE
         AND run_id=$4::UUID AND status='running'`,
      [identity.namespace, identity.timezone, identity.localDate, runId, status],
    );
    if (result.rowCount !== 1) throw new Error('agent_memory_dreaming_run_state_lost');
  }
}
