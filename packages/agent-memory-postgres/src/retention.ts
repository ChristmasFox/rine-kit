import type { Pool } from 'pg';

export interface MemoryPurgeResult {
  observations: number;
  admissions: number;
  usageSignals: number;
  candidates: number;
}

/**
 * Deletes what has expired: observed utterances (7 days), finished admissions, usage evidence (90 days)
 * and candidates (30 days). Run it with the daily Dreaming pass so personal text never outlives its
 * retention window, whether or not a worker ever read it.
 */
export async function purgeExpiredMemoryData(pool: Pool): Promise<MemoryPurgeResult> {
  const count = async (sql: string) => (await pool.query(sql)).rowCount ?? 0;
  const admissions = await count(
    `DELETE FROM agent_memory_consolidation_admissions
     WHERE expires_at<=now() AND status<>'processing'`,
  );
  const observations = await count(`DELETE FROM agent_memory_observations WHERE expires_at<=now()`);
  const usageSignals = await count(
    `DELETE FROM agent_memory_usage_signals WHERE expires_at<=now()`,
  );
  const candidates = await count(
    `DELETE FROM agent_memory_consolidation_candidates WHERE expires_at<=now()`,
  );
  return { observations, admissions, usageSignals, candidates };
}
