import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { estimateMemoryEmbeddingTokens, type MemoryEmbeddingClient } from '@rine-kit/agent-memory';
import { reserveMemoryEmbeddingBudget, settleMemoryEmbeddingBudget } from './embedding-budget.js';
import { MemoryIndexGenerationManager } from './index-generation.js';

export type MemoryIndexWorkerResult =
  | 'empty'
  | 'indexed'
  | 'deleted'
  | 'obsolete'
  | 'semantic_unconfigured'
  | 'budget_deferred'
  | 'retry'
  | 'dead';

interface ClaimedJob {
  job_id: string;
  memory_id: string;
  source_revision: string;
  index_version: number;
  operation: 'upsert' | 'delete';
  attempt_count: number;
  lease_token: string;
}

interface MemoryRow extends QueryResultRow {
  memory_id: string;
  namespace: string;
  scope_kind: string;
  scope_key: string;
  memory_key: string;
  content: string;
  revision: string;
  revoked_at: unknown;
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values
    .map((value) => {
      if (!Number.isFinite(value)) throw new Error('agent_memory_embedding_vector_invalid');
      return String(value);
    })
    .join(',')}]`;
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

export class MemoryIndexWorker {
  constructor(
    private readonly pool: Pool,
    private readonly provider: MemoryEmbeddingClient | null,
    private readonly maxAttempts = 6,
  ) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 12) {
      throw new Error('agent_memory_embedding_worker_limits_invalid');
    }
  }

  private async claim(): Promise<ClaimedJob | null> {
    const result = await this.pool.query<ClaimedJob>(
      `WITH candidate AS (
         SELECT job.job_id FROM agent_memory_embedding_jobs job
         WHERE ((job.status IN ('pending','retry') AND job.next_attempt_at<=now())
           OR (job.status='processing' AND job.lease_until<=now()))
           AND (job.operation='delete' OR $1::TEXT IS NULL OR (
             job.index_version=$4 AND (
               EXISTS (SELECT 1 FROM agent_memory_entries memory
                 JOIN agent_memory_index_generation_state state USING (namespace)
                 WHERE memory.memory_id=job.memory_id AND state.active_index_version=job.index_version
                   AND state.active_provider_id=$1 AND state.active_model_id=$2 AND state.active_dimensions=$3)
               OR EXISTS (SELECT 1 FROM agent_memory_entries memory
                 JOIN agent_memory_index_generation_state state USING (namespace)
                 WHERE memory.memory_id=job.memory_id AND state.reindex_status='building'
                   AND state.building_index_version=job.index_version
                   AND state.building_provider_id=$1 AND state.building_model_id=$2
                   AND state.building_dimensions=$3)
               OR (job.index_version=1 AND NOT EXISTS (SELECT 1 FROM agent_memory_entries memory
                   JOIN agent_memory_index_generation_state state USING (namespace)
                   WHERE memory.memory_id=job.memory_id))
             )
           ))
         ORDER BY (job.operation='delete') DESC,job.next_attempt_at,job.created_at,job.job_id
         FOR UPDATE OF job SKIP LOCKED LIMIT 1
       )
       UPDATE agent_memory_embedding_jobs job SET status='processing',attempt_count=job.attempt_count+1,
         lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds',updated_at=now()
       FROM candidate WHERE job.job_id=candidate.job_id
       RETURNING job.job_id,job.memory_id,job.source_revision,job.index_version,job.operation,job.attempt_count,job.lease_token`,
      [
        this.provider?.contract.providerId ?? null,
        this.provider?.contract.modelId ?? null,
        this.provider?.contract.dimensions ?? null,
        this.provider?.contract.indexVersion ?? null,
      ],
    );
    return result.rows[0] ?? null;
  }

  private async availability(): Promise<{ extension: boolean; table: boolean }> {
    const result = await this.pool.query<{ extension: boolean; table: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector') AS extension,
              to_regclass('agent_memory_embeddings') IS NOT NULL AS table`,
    );
    return result.rows[0] ?? { extension: false, table: false };
  }

  private async releaseUnconfigured(job: ClaimedJob): Promise<void> {
    await this.pool.query(
      `UPDATE agent_memory_embedding_jobs SET status='retry',lease_token=NULL,lease_until=NULL,
         next_attempt_at=now()+interval '5 minutes',updated_at=now()
       WHERE job_id=$1 AND status='processing' AND lease_token=$2`,
      [job.job_id, job.lease_token],
    );
  }

  private async finish(job: ClaimedJob): Promise<void> {
    await this.pool.query(
      `UPDATE agent_memory_embedding_jobs SET status='done',lease_token=NULL,lease_until=NULL,
         last_error_code=NULL,finished_at=now(),updated_at=now()
       WHERE job_id=$1 AND status='processing' AND lease_token=$2`,
      [job.job_id, job.lease_token],
    );
  }

  private async failed(job: ClaimedJob, reason: string): Promise<MemoryIndexWorkerResult> {
    const dead = job.attempt_count >= this.maxAttempts;
    const delaySeconds = Math.min(3600, 5 * 2 ** Math.min(job.attempt_count, 10));
    await this.pool.query(
      `UPDATE agent_memory_embedding_jobs SET status=$3,lease_token=NULL,lease_until=NULL,
         last_error_code=$4,next_attempt_at=now()+($5::INTEGER*interval '1 second'),
         finished_at=CASE WHEN $3='dead' THEN now() ELSE NULL END,updated_at=now()
       WHERE job_id=$1 AND status='processing' AND lease_token=$2`,
      [job.job_id, job.lease_token, dead ? 'dead' : 'retry', reason, delaySeconds],
    );
    return dead ? 'dead' : 'retry';
  }

  private async memory(job: ClaimedJob): Promise<MemoryRow | null> {
    const result = await this.pool.query<MemoryRow>(
      `SELECT memory.memory_id,memory.namespace,memory.scope_kind,memory.scope_key,
         memory.memory_key,memory.content,
         memory.revision,memory.revoked_at
       FROM agent_memory_entries memory WHERE memory.memory_id=$1`,
      [job.memory_id],
    );
    return result.rows[0] ?? null;
  }

  private async writeEmbedding(
    job: ClaimedJob,
    memory: MemoryRow,
    batch: Awaited<ReturnType<MemoryEmbeddingClient['embedMany']>>,
  ): Promise<boolean> {
    const vector = batch.vectors[0];
    const contentHash = batch.contentHashes[0];
    const norm = vector?.reduce((sum, value) => sum + value * value, 0) ?? 0;
    if (
      !this.provider ||
      !vector ||
      !contentHash ||
      batch.vectors.length !== 1 ||
      batch.contract.modelId !== this.provider.contract.modelId ||
      batch.contract.providerId !== this.provider.contract.providerId ||
      batch.contract.dimensions !== this.provider.contract.dimensions ||
      batch.contract.normalization !== 'l2_unit' ||
      batch.contract.indexVersion !== this.provider.contract.indexVersion ||
      batch.contract.indexVersion !== job.index_version ||
      vector.length !== this.provider.contract.dimensions ||
      vector.some((value) => !Number.isFinite(value)) ||
      !Number.isFinite(norm) ||
      Math.abs(Math.sqrt(norm) - 1) > 1e-3
    ) {
      throw new Error('agent_memory_embedding_contract_invalid');
    }

    const currentTextHash = createHash('sha256')
      .update(`${memory.memory_key}\n${memory.content}`)
      .digest('hex');
    if (contentHash !== currentTextHash)
      throw new Error('agent_memory_embedding_content_hash_invalid');

    return transaction(this.pool, async (client) => {
      const current = await client.query<MemoryRow>(
        `SELECT memory.memory_id,memory.namespace,memory.scope_kind,memory.scope_key,
           memory.memory_key,memory.content,
           memory.revision,memory.revoked_at
         FROM agent_memory_entries memory WHERE memory.memory_id=$1 FOR UPDATE`,
        [job.memory_id],
      );
      const row = current.rows[0];
      if (!row || String(row.revision) !== job.source_revision || row.revoked_at !== null) {
        if (!row || row.revoked_at !== null) {
          await client.query('DELETE FROM agent_memory_embeddings WHERE memory_id=$1', [
            job.memory_id,
          ]);
        }
        await client.query(
          `UPDATE agent_memory_embedding_jobs SET status='done',lease_token=NULL,lease_until=NULL,
             finished_at=now(),updated_at=now() WHERE job_id=$1 AND status='processing' AND lease_token=$2`,
          [job.job_id, job.lease_token],
        );
        return false;
      }

      const generation = await client.query<{
        active_index_version: number;
        active_provider_id: string;
        active_model_id: string;
        active_dimensions: number;
        building_index_version: number | null;
        building_provider_id: string | null;
        building_model_id: string | null;
        building_dimensions: number | null;
        reindex_status: string;
      }>(
        `SELECT active_index_version,active_provider_id,active_model_id,active_dimensions,
           building_index_version,building_provider_id,building_model_id,building_dimensions,reindex_status
         FROM agent_memory_index_generation_state WHERE namespace=$1 FOR SHARE`,
        [memory.namespace],
      );
      const state = generation.rows[0];
      const generationAllowed = state
        ? (state.active_index_version === job.index_version &&
            state.active_provider_id === batch.contract.providerId &&
            state.active_model_id === batch.contract.modelId &&
            state.active_dimensions === batch.contract.dimensions) ||
          (state.reindex_status === 'building' &&
            state.building_index_version === job.index_version &&
            state.building_provider_id === batch.contract.providerId &&
            state.building_model_id === batch.contract.modelId &&
            state.building_dimensions === batch.contract.dimensions)
        : job.index_version === 1;
      if (!generationAllowed) {
        await client.query(
          `UPDATE agent_memory_embedding_jobs SET status='done',lease_token=NULL,lease_until=NULL,
             finished_at=now(),updated_at=now() WHERE job_id=$1 AND status='processing' AND lease_token=$2`,
          [job.job_id, job.lease_token],
        );
        return false;
      }

      await client.query(
        `INSERT INTO agent_memory_embeddings(
           memory_id,namespace,scope_kind,scope_key,
           source_revision,provider_id,model_id,dimensions,normalization,index_version,content_hash,embedding
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'l2_unit',$9,$10,$11::vector)
         ON CONFLICT (memory_id,provider_id,model_id,index_version) DO UPDATE SET
           namespace=EXCLUDED.namespace,scope_kind=EXCLUDED.scope_kind,scope_key=EXCLUDED.scope_key,
           source_revision=EXCLUDED.source_revision,
           dimensions=EXCLUDED.dimensions,normalization=EXCLUDED.normalization,
           content_hash=EXCLUDED.content_hash,embedding=EXCLUDED.embedding,created_at=now()`,
        [
          row.memory_id,
          row.namespace,
          row.scope_kind,
          row.scope_key,
          row.revision,
          batch.contract.providerId,
          batch.contract.modelId,
          batch.contract.dimensions,
          batch.contract.indexVersion,
          contentHash,
          vectorLiteral(vector),
        ],
      );
      await client.query(
        `UPDATE agent_memory_embedding_jobs SET status='done',lease_token=NULL,lease_until=NULL,
           last_error_code=NULL,finished_at=now(),updated_at=now()
         WHERE job_id=$1 AND status='processing' AND lease_token=$2`,
        [job.job_id, job.lease_token],
      );
      return true;
    });
  }

  async processOne(signal?: AbortSignal): Promise<MemoryIndexWorkerResult> {
    const job = await this.claim();
    if (!job) return 'empty';
    if (job.operation === 'delete') {
      try {
        const availability = await this.availability();
        if (availability.table)
          await this.pool.query('DELETE FROM agent_memory_embeddings WHERE memory_id=$1', [
            job.memory_id,
          ]);
        await this.finish(job);
        return 'deleted';
      } catch {
        return this.failed(job, 'embedding_delete_failed');
      }
    }
    if (!this.provider) {
      await this.releaseUnconfigured(job);
      return 'semantic_unconfigured';
    }
    let reservedTokens = 0;
    let budgetDay: string | null = null;
    let settled = false;
    try {
      const availability = await this.availability();
      if (!availability.extension || !availability.table) {
        await this.releaseUnconfigured(job);
        return 'semantic_unconfigured';
      }
      const row = await this.memory(job);
      if (!row || row.revoked_at !== null || String(row.revision) !== job.source_revision) {
        if (!row || row.revoked_at !== null) {
          await this.pool.query('DELETE FROM agent_memory_embeddings WHERE memory_id=$1', [
            job.memory_id,
          ]);
        }
        await this.finish(job);
        return 'obsolete';
      }
      if (job.index_version === 1) {
        await new MemoryIndexGenerationManager(this.pool).initialize(
          row.namespace,
          this.provider.contract,
        );
      }
      const value = `${row.memory_key}\n${row.content}`;
      reservedTokens = estimateMemoryEmbeddingTokens([value]);
      budgetDay = await reserveMemoryEmbeddingBudget(
        this.pool,
        row.namespace,
        reservedTokens,
        this.provider,
      );
      if (!budgetDay) {
        await this.releaseUnconfigured(job);
        return 'budget_deferred';
      }
      const batch = await this.provider.embedMany([value], signal);
      await settleMemoryEmbeddingBudget(
        this.pool,
        row.namespace,
        budgetDay,
        reservedTokens,
        batch.inputTokens,
      );
      settled = true;
      const written = await this.writeEmbedding(job, row, batch);
      return written ? 'indexed' : 'obsolete';
    } catch (error) {
      if (budgetDay && !settled) {
        const row = await this.memory(job).catch(() => null);
        if (row)
          await settleMemoryEmbeddingBudget(
            this.pool,
            row.namespace,
            budgetDay,
            reservedTokens,
            null,
          ).catch(() => undefined);
      }
      const reason =
        error instanceof Error && /^[a-z0-9_]{1,64}$/u.test(error.message)
          ? error.message
          : 'embedding_index_failed';
      return this.failed(job, reason);
    }
  }
}
