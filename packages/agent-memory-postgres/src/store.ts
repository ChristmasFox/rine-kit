import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  MAX_MEMORY_RESULTS,
  MemoryPolicyError,
  canonicalizeMemoryKey,
  estimateMemoryEmbeddingTokens,
  memorySearchTokens,
  validateMemoryDraft,
} from '@rine-kit/agent-memory';
import type {
  MemoryDraft,
  MemoryEmbeddingClient,
  MemoryEntry,
  MemoryRecallStoragePort,
  MemorySearchSources,
  MemoryUsageSignal,
  MemoryUsageSignalKind,
  MemoryWriteMetadata,
  MemoryWriteState,
  MemoryWriteStoragePort,
} from '@rine-kit/agent-memory';
import { reserveMemoryEmbeddingBudget, settleMemoryEmbeddingBudget } from './embedding-budget.js';
import { boundedText, scopeArgs, SCOPE_FILTER, type MemoryAuthorization } from './scope.js';

export interface PostgresMemoryStoreOptions {
  /** Statement timeout for lexical and vector scans. */
  searchTimeoutMs?: number;
  /** Semantic search is off (reason `semantic_unconfigured`) without a provider. */
  embedding?: MemoryEmbeddingClient | null;
  /**
   * Called before every operation on a request's scope. The scope itself is already authorised by the
   * host; this lets a host re-check at the last moment (membership revoked, lease expired) and throw.
   */
  authorize?: (authorization: MemoryAuthorization) => Promise<void> | void;
}

const DEFAULT_SEARCH_TIMEOUT_MS = 500;
const ACTIVE = `revoked_at IS NULL AND superseded_at IS NULL
  AND (valid_until IS NULL OR valid_until>now()) AND source_kind<>'unknown'`;
const ACTIVE_JOINED = `memory.revoked_at IS NULL AND memory.superseded_at IS NULL
  AND (memory.valid_until IS NULL OR memory.valid_until>now()) AND memory.source_kind<>'unknown'`;
const COLUMNS = `memory_key,content,revision,updated_at,source_event_id,source_kind,
  source_reliability,valid_until`;

const enqueueUpserts = (
  source: 'updated',
) => `INSERT INTO agent_memory_embedding_jobs(memory_id,source_revision,operation,index_version)
  SELECT ${source}.memory_id,${source}.revision,'upsert',generation.index_version FROM ${source}
  CROSS JOIN LATERAL agent_memory_index_job_versions(${source}.namespace) generation
  ON CONFLICT DO NOTHING RETURNING job_id`;

function vectorLiteral(values: readonly number[]): string {
  if (!values.length || values.some((value) => !Number.isFinite(value)))
    throw new Error('agent_memory_embedding_vector_invalid');
  return `[${values.map(String).join(',')}]`;
}

function withPolicyErrors<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof MemoryPolicyError)
      throw new Error(`agent_memory_${error.code}`, { cause: error });
    throw error;
  }
}

export function validateStoredMemoryDraft(input: MemoryDraft): MemoryDraft {
  return withPolicyErrors(() => validateMemoryDraft(input));
}

export function canonicalStoredMemoryKey(value: string): string {
  return withPolicyErrors(() => canonicalizeMemoryKey(value));
}

function validatedWriteMetadata(input: MemoryWriteMetadata = {}): {
  sourceKind: NonNullable<MemoryWriteMetadata['sourceKind']>;
  sourceReliability: number;
  validUntil: string | null;
} {
  const sourceKind = input.sourceKind ?? 'trusted_ingress';
  if (!['trusted_ingress', 'user_confirmed', 'system_verified', 'unknown'].includes(sourceKind)) {
    throw new Error('agent_memory_source_kind_invalid');
  }
  const sourceReliability = input.sourceReliability ?? (sourceKind === 'user_confirmed' ? 95 : 80);
  if (
    !Number.isSafeInteger(sourceReliability) ||
    sourceReliability < 0 ||
    sourceReliability > 100
  ) {
    throw new Error('agent_memory_source_reliability_invalid');
  }
  let validUntil: string | null = null;
  if (input.validUntil != null) {
    const timestamp = Date.parse(input.validUntil);
    if (!Number.isFinite(timestamp)) throw new Error('agent_memory_valid_until_invalid');
    validUntil = new Date(timestamp).toISOString();
  }
  return { sourceKind, sourceReliability, validUntil };
}

function project(row: Record<string, unknown>): MemoryEntry {
  return {
    key: String(row.memory_key),
    content: String(row.content),
    revision: Number(row.revision),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    sourceEventId: String(row.source_event_id),
    sourceKind:
      row.source_kind === 'user_confirmed' ||
      row.source_kind === 'system_verified' ||
      row.source_kind === 'unknown'
        ? row.source_kind
        : 'trusted_ingress',
    sourceReliability: Number(row.source_reliability),
    validUntil:
      row.valid_until == null
        ? null
        : row.valid_until instanceof Date
          ? row.valid_until.toISOString()
          : String(row.valid_until),
    ...(row.semantic_similarity == null
      ? {}
      : { semanticSimilarity: Number(row.semantic_similarity) }),
  };
}

function checkLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MEMORY_RESULTS)
    throw new Error('agent_memory_limit_invalid');
}

/**
 * Scoped memory storage on PostgreSQL. Every statement is filtered by the scope the host authorised for
 * this request; entries carry source trust, freshness and supersession metadata; writes are
 * revision-fenced and queue embedding work in the same statement. Implements the recall and write
 * storage ports of @rine-kit/agent-memory.
 */
export class PostgresMemoryStore
  implements
    MemoryRecallStoragePort<MemoryAuthorization>,
    MemoryWriteStoragePort<MemoryAuthorization>
{
  private readonly searchTimeoutMs: number;
  private readonly embedding: MemoryEmbeddingClient | null;
  private readonly authorize: PostgresMemoryStoreOptions['authorize'];

  constructor(
    private readonly pool: Pool,
    options: PostgresMemoryStoreOptions = {},
  ) {
    this.searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.embedding = options.embedding ?? null;
    this.authorize = options.authorize;
    if (
      !Number.isSafeInteger(this.searchTimeoutMs) ||
      this.searchTimeoutMs < 10 ||
      this.searchTimeoutMs > 10_000
    ) {
      throw new Error('agent_memory_search_timeout_invalid');
    }
  }

  private async scope(authorization: MemoryAuthorization): Promise<[string, string, string]> {
    const scope = scopeArgs(authorization.scope);
    await this.authorize?.(authorization);
    return scope;
  }

  /** Authorises once, then exposes only scoped reads. */
  async withAuthorizedSearch<T>(
    authorization: MemoryAuthorization,
    work: (sources: MemorySearchSources) => Promise<T>,
  ): Promise<T> {
    const scope = await this.scope(authorization);
    return work({
      exact: (query, limit = 8) => this.searchExact(query, limit, scope),
      lexical: (query, limit = 8) => this.searchLexical(query, limit, scope),
      semantic: (query, limit = 8) => this.searchSemantic(query, limit, scope),
    });
  }

  /** Persist only keyed usage evidence; query text and memory content are not copied. */
  async recordUsageSignals(
    authorization: MemoryAuthorization,
    kind: MemoryUsageSignalKind,
    signals: readonly MemoryUsageSignal[],
  ): Promise<void> {
    if (!signals.length) return;
    if (kind !== 'recalled' && kind !== 'used')
      throw new Error('agent_memory_usage_signal_kind_invalid');
    const valid = signals.filter(
      (signal) =>
        typeof signal.key === 'string' &&
        signal.key.length > 0 &&
        signal.key.length <= 96 &&
        Number.isSafeInteger(signal.revision) &&
        signal.revision > 0 &&
        typeof signal.sourceEventId === 'string' &&
        signal.sourceEventId.length > 0 &&
        signal.sourceEventId.length <= 256 &&
        /^[a-f0-9]{64}$/u.test(signal.queryFingerprint),
    );
    if (!valid.length) return;
    const scope = await this.scope(authorization);
    const sql = `WITH requested AS (
        SELECT * FROM unnest($5::TEXT[],$6::BIGINT[],$7::TEXT[],$8::CHAR(64)[])
          AS item(memory_key,memory_revision,memory_source_event_id,query_fingerprint)
      )
      INSERT INTO agent_memory_usage_signals(
        namespace,scope_kind,scope_key,
        memory_key,memory_revision,memory_source_event_id,request_event_id,query_fingerprint,signal_kind
      )
      SELECT $1,$2,$3,item.memory_key,item.memory_revision,item.memory_source_event_id,
        $4,item.query_fingerprint,$9
      FROM requested item
      JOIN agent_memory_entries memory ON memory.namespace=$1 AND memory.scope_kind=$2
        AND memory.scope_key=$3
        AND memory.memory_key=item.memory_key AND memory.revision=item.memory_revision
        AND memory.source_event_id=item.memory_source_event_id
        AND memory.revoked_at IS NULL AND memory.superseded_at IS NULL
        AND (memory.valid_until IS NULL OR memory.valid_until>now()) AND memory.source_kind<>'unknown'
      ON CONFLICT DO NOTHING`;
    await this.pool.query(sql, [
      ...scope,
      boundedText(authorization.eventId, 256),
      valid.map((signal) => signal.key),
      valid.map((signal) => signal.revision),
      valid.map((signal) => signal.sourceEventId),
      valid.map((signal) => signal.queryFingerprint),
      kind,
    ]);
  }

  async listRecent(authorization: MemoryAuthorization, limit = 16): Promise<MemoryEntry[]> {
    checkLimit(limit);
    const scope = await this.scope(authorization);
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM agent_memory_entries WHERE ${SCOPE_FILTER} AND ${ACTIVE}
       ORDER BY updated_at DESC,memory_id LIMIT $4`,
      [...scope, limit],
    );
    return result.rows.map(project);
  }

  async getWriteState(
    authorization: MemoryAuthorization,
    key: string,
  ): Promise<MemoryWriteState | null> {
    const canonicalKey = canonicalStoredMemoryKey(key);
    const scope = await this.scope(authorization);
    const result = await this.pool.query(
      `SELECT ${COLUMNS},(revoked_at IS NOT NULL) AS revoked
       FROM agent_memory_entries WHERE ${SCOPE_FILTER} AND memory_key=$4 LIMIT 1`,
      [...scope, canonicalKey],
    );
    const row = result.rows[0];
    return row ? { ...project(row), revoked: row.revoked === true } : null;
  }

  private async searchExact(
    rawQuery: string,
    limit: number,
    scope: [string, string, string],
  ): Promise<MemoryEntry[]> {
    checkLimit(limit);
    const search = boundedText(rawQuery, 240, true).toLocaleLowerCase('en-US');
    let canonicalKey = '';
    if (search.length <= 96) {
      try {
        canonicalKey = canonicalStoredMemoryKey(search);
      } catch {
        /* Non-key queries still use exact content matching. */
      }
    }
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM agent_memory_entries WHERE ${SCOPE_FILTER} AND ${ACTIVE}
       AND (memory_key=$4 OR lower(content)=$5)
       ORDER BY (memory_key=$4) DESC,updated_at DESC,memory_key LIMIT $6`,
      [...scope, canonicalKey, search, limit],
    );
    return result.rows.map(project);
  }

  private async timedQuery<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[],
    timeoutCode: string,
  ): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout',$1,true)", [
        `${this.searchTimeoutMs}ms`,
      ]);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows as T[];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error && typeof error === 'object' && 'code' in error && error.code === '57014') {
        throw new Error(timeoutCode, { cause: error });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async searchLexical(
    rawQuery: string,
    limit: number,
    scope: [string, string, string],
  ): Promise<MemoryEntry[]> {
    checkLimit(limit);
    const search = boundedText(rawQuery, 240, true).toLocaleLowerCase('en-US');
    const grams = withPolicyErrors(() => memorySearchTokens(search));
    // Filter candidates before expensive scoring; never discard old matches by age.
    const terms = [...new Set([search, ...grams])].slice(0, 32);
    const patterns = terms.map((term) => '%' + term.replace(/[#%_]/gu, (char) => '#' + char) + '%');
    const candidates = terms
      .map(
        (_, i) =>
          '(lower(memory_key) LIKE $' +
          (7 + i) +
          " ESCAPE '#' OR lower(content) LIKE $" +
          (7 + i) +
          " ESCAPE '#')",
      )
      .join(' OR ');
    const sql = `WITH candidates AS (
      SELECT ${COLUMNS},
        CASE WHEN position($4 in lower(memory_key))>0 OR position($4 in lower(content))>0
          THEN 1000 ELSE (
            SELECT COUNT(*)::INTEGER FROM unnest($5::TEXT[]) AS gram(token)
            WHERE position(gram.token in lower(memory_key))>0
               OR position(gram.token in lower(content))>0
          ) END AS score
      FROM agent_memory_entries WHERE ${SCOPE_FILTER} AND ${ACTIVE} AND (${candidates})
    )
    SELECT ${COLUMNS} FROM candidates WHERE score>0
    ORDER BY score DESC,updated_at DESC,memory_key LIMIT $6`;
    const rows = await this.timedQuery(
      sql,
      [...scope, search, grams, limit, ...patterns],
      'agent_memory_lexical_timeout',
    );
    return rows.map(project);
  }

  private async searchVector(
    vector: readonly number[],
    contract: MemoryEmbeddingClient['contract'],
    limit: number,
    scope: [string, string, string],
  ): Promise<MemoryEntry[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_MEMORY_RESULTS ||
      vector.length !== contract.dimensions ||
      !Number.isSafeInteger(contract.indexVersion) ||
      contract.indexVersion < 1 ||
      contract.indexVersion > 1_000_000 ||
      contract.normalization !== 'l2_unit'
    ) {
      throw new Error('agent_memory_embedding_contract_invalid');
    }
    const sql = `SELECT memory.memory_key,memory.content,memory.revision,memory.updated_at,
        memory.source_event_id,memory.source_kind,memory.source_reliability,memory.valid_until,
        1-(embedded.embedding <=> $5::vector) AS semantic_similarity
      FROM agent_memory_embeddings embedded
      JOIN agent_memory_entries memory ON memory.memory_id=embedded.memory_id
      WHERE memory.namespace=$1 AND memory.scope_kind=$2 AND memory.scope_key=$3 AND ${ACTIVE_JOINED}
        AND memory.revision=embedded.source_revision
        AND embedded.namespace=$1 AND embedded.scope_kind=$2 AND embedded.scope_key=$3
        AND embedded.provider_id=$6 AND embedded.model_id=$7
        AND embedded.dimensions=$8 AND embedded.index_version=$9 AND embedded.normalization='l2_unit'
        AND EXISTS (SELECT 1 FROM agent_memory_index_generation_state generation
          WHERE generation.namespace=$1 AND generation.active_provider_id=$6
            AND generation.active_model_id=$7 AND generation.active_dimensions=$8
            AND generation.active_index_version=$9)
      ORDER BY embedded.embedding <=> $5::vector,memory.updated_at DESC,memory.memory_key LIMIT $4`;
    const rows = await this.timedQuery(
      sql,
      [
        ...scope,
        limit,
        vectorLiteral(vector),
        contract.providerId,
        contract.modelId,
        contract.dimensions,
        contract.indexVersion,
      ],
      'agent_memory_semantic_timeout',
    );
    return rows.map(project);
  }

  private async searchSemantic(rawQuery: string, limit: number, scope: [string, string, string]) {
    const search = boundedText(rawQuery, 240, true);
    checkLimit(limit);
    const provider = this.embedding;
    if (!provider) return { matches: [], reason: 'semantic_unconfigured' as const };
    try {
      const available = await this.pool.query<{ available: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector')
           AND to_regclass('agent_memory_embeddings') IS NOT NULL AS available`,
      );
      if (available.rows[0]?.available !== true)
        return { matches: [], reason: 'vector_index_unavailable' as const };
    } catch {
      return { matches: [], reason: 'vector_index_unavailable' as const };
    }

    try {
      const active = await this.pool.query<{ active: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM agent_memory_index_generation_state generation
         WHERE generation.namespace=$1 AND generation.active_provider_id=$2
           AND generation.active_model_id=$3 AND generation.active_dimensions=$4
           AND generation.active_index_version=$5) AS active`,
        [
          scope[0],
          provider.contract.providerId,
          provider.contract.modelId,
          provider.contract.dimensions,
          provider.contract.indexVersion,
        ],
      );
      if (active.rows[0]?.active !== true)
        return { matches: [], reason: 'semantic_unavailable' as const };
    } catch {
      return { matches: [], reason: 'semantic_unavailable' as const };
    }

    const estimatedTokens = estimateMemoryEmbeddingTokens([search]);
    let budgetDay: string | null;
    try {
      budgetDay = await reserveMemoryEmbeddingBudget(
        this.pool,
        scope[0],
        estimatedTokens,
        provider,
      );
    } catch {
      return { matches: [], reason: 'embedding_budget_unavailable' as const };
    }
    if (!budgetDay) return { matches: [], reason: 'embedding_budget_exhausted' as const };

    let budgetSettled = false;
    try {
      const batch = await provider.embedMany([search]);
      await settleMemoryEmbeddingBudget(
        this.pool,
        scope[0],
        budgetDay,
        estimatedTokens,
        batch.inputTokens,
      );
      budgetSettled = true;
      const vector = batch.vectors[0];
      const norm = vector?.reduce((sum, value) => sum + value * value, 0) ?? 0;
      if (
        !vector ||
        batch.vectors.length !== 1 ||
        vector.length !== provider.contract.dimensions ||
        vector.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(norm) ||
        Math.abs(Math.sqrt(norm) - 1) > 1e-3 ||
        batch.contract.providerId !== provider.contract.providerId ||
        batch.contract.modelId !== provider.contract.modelId ||
        batch.contract.dimensions !== provider.contract.dimensions ||
        batch.contract.normalization !== 'l2_unit' ||
        batch.contract.indexVersion !== provider.contract.indexVersion
      ) {
        throw new Error('agent_memory_embedding_contract_invalid');
      }
      return {
        matches: await this.searchVector(vector, provider.contract, limit, scope),
        reason: null,
      };
    } catch (error) {
      if (!budgetSettled) {
        await settleMemoryEmbeddingBudget(
          this.pool,
          scope[0],
          budgetDay,
          estimatedTokens,
          null,
        ).catch(() => undefined);
      }
      const reason =
        error instanceof Error &&
        (error.message === 'agent_memory_embedding_timeout' ||
          error.message === 'agent_memory_semantic_timeout')
          ? ('semantic_timeout' as const)
          : ('semantic_unavailable' as const);
      return { matches: [], reason };
    }
  }

  /** New key only; a conflicting revision/tombstone is never overwritten. */
  async create(
    authorization: MemoryAuthorization,
    draft: MemoryDraft,
    metadata: MemoryWriteMetadata = {},
  ): Promise<'created' | 'already_exists'> {
    const value = validateStoredMemoryDraft(draft);
    const source = validatedWriteMetadata(metadata);
    const scope = await this.scope(authorization);
    const sql = `WITH inserted AS (
        INSERT INTO agent_memory_entries
        (namespace,scope_kind,scope_key,memory_key,content,source_event_id,source_kind,source_reliability,valid_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT DO NOTHING RETURNING memory_id,namespace
      ), queued AS (
        INSERT INTO agent_memory_embedding_jobs(memory_id,source_revision,operation,index_version)
        SELECT inserted.memory_id,1,'upsert',generation.index_version FROM inserted
        CROSS JOIN LATERAL agent_memory_index_job_versions(inserted.namespace) generation
        ON CONFLICT DO NOTHING RETURNING job_id
      )
      SELECT EXISTS(SELECT 1 FROM inserted) AS inserted, EXISTS(SELECT 1 FROM queued) AS queued`;
    const result = await this.pool.query(sql, [
      ...scope,
      value.key,
      value.content,
      boundedText(authorization.eventId, 256),
      source.sourceKind,
      source.sourceReliability,
      source.validUntil,
    ]);
    return result.rows[0]?.inserted === true ? 'created' : 'already_exists';
  }

  async revise(
    authorization: MemoryAuthorization,
    draft: MemoryDraft,
    expectedRevision: number,
    metadata: MemoryWriteMetadata = {},
  ): Promise<boolean> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new Error('agent_memory_revision_invalid');
    const value = validateStoredMemoryDraft(draft);
    const source = validatedWriteMetadata(metadata);
    const scope = await this.scope(authorization);
    const sql = `WITH updated AS (
      UPDATE agent_memory_entries SET content=$5,source_event_id=$6,source_kind=$7,source_reliability=$8,
        valid_until=$9,revision=revision+1,updated_at=now() WHERE ${SCOPE_FILTER}
      AND memory_key=$4 AND revision=$10 AND revoked_at IS NULL
      RETURNING memory_id,revision,namespace
    ), queued AS (
      ${enqueueUpserts('updated')}
    ) SELECT EXISTS(SELECT 1 FROM updated) AS updated,EXISTS(SELECT 1 FROM queued) AS queued`;
    const result = await this.pool.query(sql, [
      ...scope,
      value.key,
      value.content,
      boundedText(authorization.eventId, 256),
      source.sourceKind,
      source.sourceReliability,
      source.validUntil,
      expectedRevision,
    ]);
    return result.rows[0]?.updated === true;
  }

  /** Only an event received after revocation can restore a tombstone. */
  async rememberAgain(
    authorization: MemoryAuthorization,
    draft: MemoryDraft,
    expectedRevision: number,
    metadata: MemoryWriteMetadata = {},
  ): Promise<boolean> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new Error('agent_memory_revision_invalid');
    const value = validateStoredMemoryDraft(draft);
    const source = validatedWriteMetadata(metadata);
    const scope = await this.scope(authorization);
    const sql = `WITH updated AS (UPDATE agent_memory_entries
      SET content=$5,source_event_id=$6,source_kind=$7,source_reliability=$8,valid_until=$9,
        revoked_at=NULL,revision=revision+1,updated_at=now()
      WHERE ${SCOPE_FILTER} AND memory_key=$4 AND revision=$10
      AND revoked_at IS NOT NULL AND source_event_id<>$6 AND revoked_at < $11::TIMESTAMPTZ
      RETURNING memory_id,revision,namespace), queued AS (
      ${enqueueUpserts('updated')}
      ) SELECT EXISTS(SELECT 1 FROM updated) AS updated,EXISTS(SELECT 1 FROM queued) AS queued`;
    const result = await this.pool.query(sql, [
      ...scope,
      value.key,
      value.content,
      boundedText(authorization.eventId, 256),
      source.sourceKind,
      source.sourceReliability,
      source.validUntil,
      expectedRevision,
      authorization.receivedAt,
    ]);
    return result.rows[0]?.updated === true;
  }

  /** Tombstone removes stored text, usage evidence, and stale episodic candidates. */
  async forget(
    authorization: MemoryAuthorization,
    key: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    ) {
      throw new Error('agent_memory_revision_invalid');
    }
    const scope = await this.scope(authorization);
    const canonicalKey = canonicalStoredMemoryKey(key);
    const memoryLockKey = createHash('sha256')
      .update([...scope, canonicalKey].join('\0'))
      .digest('hex');
    const sql = `WITH key_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtextextended($7,0))
      ), updated AS (UPDATE agent_memory_entries SET content='',revoked_at=now(),source_event_id=$5,
      revision=revision+1,updated_at=now() WHERE ${SCOPE_FILTER} AND memory_key=$4 AND revoked_at IS NULL
      AND ($6::BIGINT IS NULL OR revision=$6)
      AND EXISTS (SELECT 1 FROM key_lock)
      RETURNING memory_id,revision), usage_deleted AS (
        DELETE FROM agent_memory_usage_signals WHERE ${SCOPE_FILTER} AND memory_key=$4
          AND EXISTS (SELECT 1 FROM key_lock)
          AND EXISTS (SELECT 1 FROM updated) RETURNING signal_id
      ), candidates_deleted AS (
        UPDATE agent_memory_consolidation_candidates SET status='rejected',result_reason=NULL,
          memory_key='rejected',content='[rejected]',source_event_ids=ARRAY[]::TEXT[],
          expected_revision=NULL,confirmed_by_event_id=NULL,updated_at=now()
        WHERE ${SCOPE_FILTER} AND memory_key=$4
          AND status IN ('pending_confirmation','conflict','duplicate','promoted')
          AND (EXISTS (SELECT 1 FROM updated) OR $6::BIGINT IS NULL)
          AND EXISTS (SELECT 1 FROM key_lock) RETURNING candidate_id
      ), queued AS (
        INSERT INTO agent_memory_embedding_jobs(memory_id,source_revision,operation)
        SELECT memory_id,revision,'delete' FROM updated ON CONFLICT DO NOTHING RETURNING job_id
      ) SELECT EXISTS(SELECT 1 FROM updated) AS updated,EXISTS(SELECT 1 FROM queued) AS queued,
        EXISTS(SELECT 1 FROM candidates_deleted) AS candidate_deleted`;
    const result = await this.pool.query(sql, [
      ...scope,
      canonicalKey,
      boundedText(authorization.eventId, 256),
      expectedRevision ?? null,
      memoryLockKey,
    ]);
    return result.rows[0]?.updated === true || result.rows[0]?.candidate_deleted === true;
  }
}
