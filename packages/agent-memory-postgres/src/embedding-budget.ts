import type { Pool } from 'pg';

export interface MemoryEmbeddingBudgetLimits {
  dailyTokenBudget: number;
  dailyRequestBudget: number;
}

/** Atomically reserves estimated request cost across workers. Unknown responses are settled at the
 * estimate so provider failures cannot refund a request that may already have been billed. */
export async function reserveMemoryEmbeddingBudget(
  pool: Pool,
  namespace: string,
  estimatedTokens: number,
  limits: MemoryEmbeddingBudgetLimits,
): Promise<string | null> {
  if (
    !Number.isSafeInteger(estimatedTokens) ||
    estimatedTokens < 1 ||
    !Number.isSafeInteger(limits.dailyTokenBudget) ||
    limits.dailyTokenBudget < 1 ||
    !Number.isSafeInteger(limits.dailyRequestBudget) ||
    limits.dailyRequestBudget < 1
  ) {
    throw new Error('agent_memory_embedding_budget_invalid');
  }
  if (estimatedTokens > limits.dailyTokenBudget || limits.dailyRequestBudget < 1) return null;
  const result = await pool.query<{ budget_day: string }>(
    `INSERT INTO agent_memory_embedding_usage_daily(
       namespace,budget_day,actual_tokens,reserved_tokens,request_count,reserved_updated_at
     ) VALUES ($1,(now() AT TIME ZONE 'UTC')::DATE,0,$2,1,now())
     ON CONFLICT (namespace,budget_day) DO UPDATE SET
       reserved_tokens=CASE
         WHEN agent_memory_embedding_usage_daily.reserved_updated_at < now()-interval '15 minutes' THEN $2
         ELSE agent_memory_embedding_usage_daily.reserved_tokens+$2 END,
       request_count=agent_memory_embedding_usage_daily.request_count+1,
       reserved_updated_at=now()
     WHERE agent_memory_embedding_usage_daily.actual_tokens
        + CASE WHEN agent_memory_embedding_usage_daily.reserved_updated_at < now()-interval '15 minutes'
            THEN 0 ELSE agent_memory_embedding_usage_daily.reserved_tokens END + $2 <= $3
       AND agent_memory_embedding_usage_daily.request_count+1 <= $4
     RETURNING budget_day::TEXT`,
    [namespace, estimatedTokens, limits.dailyTokenBudget, limits.dailyRequestBudget],
  );
  return result.rows[0]?.budget_day ?? null;
}

export async function settleMemoryEmbeddingBudget(
  pool: Pool,
  namespace: string,
  budgetDay: string,
  reservedTokens: number,
  actualTokens: number | null,
): Promise<void> {
  if (
    !Number.isSafeInteger(reservedTokens) ||
    reservedTokens < 1 ||
    (actualTokens !== null && (!Number.isFinite(actualTokens) || actualTokens < 0))
  ) {
    throw new Error('agent_memory_embedding_budget_invalid');
  }
  await pool.query(
    `UPDATE agent_memory_embedding_usage_daily SET
       reserved_tokens=GREATEST(0,reserved_tokens-$3),
       actual_tokens=actual_tokens+$4,reserved_updated_at=now()
     WHERE namespace=$1 AND budget_day=$2::DATE`,
    [
      namespace,
      budgetDay,
      reservedTokens,
      actualTokens === null ? reservedTokens : Math.max(reservedTokens, Math.floor(actualTokens)),
    ],
  );
}
