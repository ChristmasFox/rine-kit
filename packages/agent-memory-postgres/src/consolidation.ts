import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { evaluateDeepPromotion, normalizeMemoryCandidates } from '@rine-kit/agent-memory';
import type {
  MemoryCandidateDraft,
  MemoryObservation,
  NormalizedMemoryCandidate,
} from '@rine-kit/agent-memory';
import { boundedText, type MemoryAuthorization } from './scope.js';
import { canonicalStoredMemoryKey } from './store.js';

// Extracted from Gate's gate-memory-consolidation.ts. The KOOK DM actor became the host-authorised scope
// (one scope kind per service, "user" by default), KOOK ingress fences and transcript joins became the
// package-owned observation corpus; consent, admission leases, candidate normalisation, evidence-based
// Deep promotion and the safety text policies are unchanged.

export type MemoryConsolidationWorkflow = 'light' | 'rem';
export interface MemoryConsolidationConsent {
  light: { enabled: boolean; version: number };
  rem: { enabled: boolean; version: number };
}

export const MemoryConsolidationCandidateSchema = z
  .object({
    confidence: z.enum(['high', 'medium']),
    subject: z.enum(['self', 'third_party', 'unknown']),
    kind: z.enum(['stable_preference', 'verifiable_fact', 'episodic_checkpoint']),
    key: z.string().trim().min(1).max(96),
    content: z.string().trim().min(1).max(800),
    evidence: z.string().trim().min(1).max(800),
    validity: z.enum(['stable', '7_days', '30_days', '90_days', 'unknown']),
  })
  .strict();

export interface MemoryConsolidationPlanner {
  /** Only bounded, already-admitted text is supplied; no IDs or scope are exposed. */
  plan(
    input: {
      workflow: MemoryConsolidationWorkflow;
      messages: readonly { content: string; createdAt: string }[];
    },
    signal: AbortSignal,
  ): Promise<unknown[]>;
}

const AUTO_LEARN_SOURCE_RELIABILITY = 85;
const SCOPE_KIND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;

export interface MemoryConsolidationWorkerOptions {
  maxRemBatch?: number;
  maxDeepCandidates?: number;
  maxInputCharacters?: number;
  maxCandidates?: number;
  leaseMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

export type MemoryConsolidationRun =
  | {
      status: 'processed';
      workflow: MemoryConsolidationWorkflow;
      admitted: number;
      candidates: number;
    }
  | { status: 'skipped'; workflow: MemoryConsolidationWorkflow; reason: string; admitted: number }
  | { status: 'SKIPPED_NO_ELIGIBLE_CORPUS'; workflow: MemoryConsolidationWorkflow }
  | {
      status: 'retry' | 'dead' | 'timed_out';
      workflow: MemoryConsolidationWorkflow;
      admitted: number;
    };

export type MemoryDeepRun =
  | { status: 'processed'; inspected: number; promoted: number; rejected: number; deferred: number }
  | { status: 'SKIPPED_NO_ELIGIBLE_CORPUS' };

interface DeepCandidateHandle extends QueryResultRow {
  candidate_id: string;
  scope_key: string;
  memory_key: string;
  workflow: MemoryConsolidationWorkflow;
  consent_version: string;
}

interface DeepCandidate extends QueryResultRow {
  candidate_id: string;
  workflow: MemoryConsolidationWorkflow;
  consent_version: string;
  memory_key: string;
  content: string;
  candidate_kind: ValidCandidate['kind'];
  valid_until: Date | null;
  source_event_ids: string[];
  expected_revision: string | null;
  status: 'pending_confirmation' | 'conflict';
  created_at: Date;
}

interface DeepSource extends QueryResultRow {
  candidate_id: string;
  source_event_id: string;
  created_at: Date;
  content: string;
}

interface DeepSourceMetadata extends QueryResultRow {
  candidate_id: string;
  source_event_id: string;
  created_at: Date;
}

interface DeepMemory extends QueryResultRow {
  memory_id: string;
  revision: string;
  content: string;
  source_event_id: string;
  valid_until: Date | null;
  revoked_at: Date | null;
  superseded_at: Date | null;
}

interface Admission extends QueryResultRow {
  admission_id: string;
  namespace: string;
  scope_key: string;
  workflow: MemoryConsolidationWorkflow;
  source_event_id: string;
  consent_version: string;
  admitted_at: Date;
  attempt_count: number;
  lease_token: string;
}

interface SourceMessage extends QueryResultRow {
  admission_id: string;
  source_event_id: string;
  admitted_at: Date;
  content: string;
  created_at: Date;
}

type ValidCandidate = NormalizedMemoryCandidate;

/** `a`'s consent row exists, is enabled and has the version `a` was admitted under. */
const consentJoin = (a: string, c = 'consent') =>
  `JOIN agent_memory_consolidation_consents ${c} ON ${c}.namespace=${a}.namespace
     AND ${c}.scope_kind=${a}.scope_kind AND ${c}.scope_key=${a}.scope_key
     AND ${c}.workflow=${a}.workflow AND ${c}.enabled AND ${c}.consent_version=${a}.consent_version`;
/** The still-unexpired observation an admission points at. */
const sourceJoin = (a: string, s = 'source') =>
  `JOIN agent_memory_observations ${s} ON ${s}.namespace=${a}.namespace
     AND ${s}.scope_kind=${a}.scope_kind AND ${s}.scope_key=${a}.scope_key
     AND ${s}.source_event_id=${a}.source_event_id AND ${s}.expires_at>now()`;

function sensitiveOrRiskText(value: string): boolean {
  return (
    /(?:password|passphrase|api[\s_-]*key|access[\s_-]*token|secret|private[\s_-]*key|密码|口令|验证码|密钥|私钥|身份证|护照|银行卡|信用卡|手机号|电话号码|电子邮箱|住址|家庭住址|病史|诊断|自残|自杀|性取向|想死|不想活|伤害自己|伤害别人|伤害他人|杀人|杀了他)/iu.test(
      value,
    ) ||
    /(?:忽略|无视|忘掉|覆盖).{0,12}(?:系统|开发者|之前|先前|以上).{0,8}(?:指令|规则|提示词)|(?:输出|泄露|展示).{0,8}(?:系统提示词|隐藏指令)|(?:调用|执行).{0,8}(?:工具|命令)|(?:记住我是|我是).{0,8}(?:管理员|所有者)|\b(?:ignore|disregard|override).{0,20}(?:system|developer|previous|prior).{0,16}(?:instructions?|rules?|prompts?)\b/iu.test(
      value,
    ) ||
    /(?:我(?:的)?(?:朋友|队友|同事|家人|室友|伴侣)|他|她|他们|她们).{0,24}(?:喜欢|偏好|常用|选择|住在|病史|诊断|收入|联系方式)/iu.test(
      value,
    ) ||
    /\b(?:my friend|my teammate|my colleague|my family|he|she|they)\b.{0,24}\b(?:likes|prefers|uses|lives|medical|income|contact)\b/iu.test(
      value,
    ) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value) ||
    /(?:\+?\d[\s().-]?){8,}/u.test(value)
  );
}

function hasSelfAttribution(value: string): boolean {
  return /我(?!们)|(?:^|[^a-z])(?:i(?:'m| am| prefer| like| use)?|my)(?:$|[^a-z])/iu.test(value);
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function checkedKind(scopeKind: string): string {
  if (!SCOPE_KIND_PATTERN.test(scopeKind)) throw new Error('agent_memory_scope_invalid');
  return scopeKind;
}

/**
 * Default-on per-scope learning controls and source admission. Consent is checked again at every step
 * a worker takes; revoking it skips queued work and deletes candidates that have not been confirmed.
 */
export class MemoryConsolidationConsentService {
  private readonly kind: string;
  constructor(
    private readonly pool: Pool,
    private readonly namespace: string,
    scopeKind = 'user',
  ) {
    this.kind = checkedKind(scopeKind);
  }

  /** The authorised scope of this service, or null when the request is for something else. */
  private identity(
    authorization: MemoryAuthorization,
  ): { scopeKey: string; eventId: string } | null {
    const { scope } = authorization;
    if (scope.namespace !== this.namespace || scope.kind !== this.kind) return null;
    return {
      scopeKey: boundedText(scope.key, 256),
      eventId: boundedText(authorization.eventId, 256),
    };
  }

  async setConsent(
    authorization: MemoryAuthorization,
    workflow: MemoryConsolidationWorkflow,
    enabled: boolean,
  ): Promise<{ enabled: boolean; version: number }> {
    const identity = this.identity(authorization);
    if (!identity) throw new Error('agent_memory_consent_scope_required');
    return transaction(this.pool, async (client) => {
      const result = await client.query<{ enabled: boolean; consent_version: string }>(
        `INSERT INTO agent_memory_consolidation_consents(
           namespace,scope_kind,scope_key,workflow,enabled,consent_version,changed_by_event_id
         ) VALUES ($1,$2,$3,$4,$5,1,$6)
         ON CONFLICT (namespace,scope_kind,scope_key,workflow) DO UPDATE SET
           enabled=EXCLUDED.enabled,
           consent_version=agent_memory_consolidation_consents.consent_version
             + CASE WHEN agent_memory_consolidation_consents.enabled IS DISTINCT FROM EXCLUDED.enabled THEN 1 ELSE 0 END,
           changed_by_event_id=EXCLUDED.changed_by_event_id,updated_at=now()
         RETURNING enabled,consent_version::TEXT AS consent_version`,
        [this.namespace, this.kind, identity.scopeKey, workflow, enabled, identity.eventId],
      );
      const row = result.rows[0]!;
      if (!row.enabled) {
        await client.query(
          `UPDATE agent_memory_consolidation_admissions SET status='skipped',skip_reason='consent_revoked',
             lease_token=NULL,lease_until=NULL,updated_at=now()
           WHERE namespace=$1 AND scope_kind=$2 AND scope_key=$3 AND workflow=$4
             AND status IN ('pending','retry','processing')`,
          [this.namespace, this.kind, identity.scopeKey, workflow],
        );
        await client.query(
          `DELETE FROM agent_memory_consolidation_candidates
           WHERE namespace=$1 AND scope_kind=$2 AND scope_key=$3 AND workflow=$4
             AND status IN ('pending_confirmation','conflict','duplicate')`,
          [this.namespace, this.kind, identity.scopeKey, workflow],
        );
      }
      return { enabled: row.enabled, version: Number(row.consent_version) };
    });
  }

  async getConsent(authorization: MemoryAuthorization): Promise<MemoryConsolidationConsent> {
    const identity = this.identity(authorization);
    if (!identity) throw new Error('agent_memory_consent_scope_required');
    const result = await this.pool.query<{
      workflow: MemoryConsolidationWorkflow;
      enabled: boolean;
      consent_version: string;
    }>(
      `SELECT workflow,enabled,consent_version::TEXT AS consent_version
       FROM agent_memory_consolidation_consents
       WHERE namespace=$1 AND scope_kind=$2 AND scope_key=$3`,
      [this.namespace, this.kind, identity.scopeKey],
    );
    const value: MemoryConsolidationConsent = {
      light: { enabled: true, version: 0 },
      rem: { enabled: true, version: 0 },
    };
    for (const row of result.rows)
      value[row.workflow] = { enabled: row.enabled, version: Number(row.consent_version) };
    return value;
  }

  /**
   * Admit one utterance of the authorised scope for learning. The host must pass the member's own
   * words from the current trusted request: the observation has to carry this request as its evidence.
   * Returns how many workflows queued it (0 when learning is off for this scope).
   */
  async observe(
    authorization: MemoryAuthorization,
    observation: MemoryObservation,
  ): Promise<number> {
    const identity = this.identity(authorization);
    if (!identity) return 0;
    if (
      !observation.evidence.some(
        (evidence) =>
          evidence.id === identity.eventId &&
          evidence.source === 'conversation' &&
          evidence.observedAt === observation.observedAt,
      )
    )
      return 0;
    const content = boundedText(observation.content, 1200, true);
    const observedAt = new Date(observation.observedAt);
    if (!Number.isFinite(observedAt.getTime())) return 0;
    return transaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO agent_memory_consolidation_consents(
           namespace,scope_kind,scope_key,workflow,enabled,consent_version,changed_by_event_id
         ) SELECT $1,$2,$3,workflow,true,1,$4
           FROM (VALUES ('light'::TEXT),('rem'::TEXT)) AS defaults(workflow)
         ON CONFLICT (namespace,scope_kind,scope_key,workflow) DO NOTHING`,
        [this.namespace, this.kind, identity.scopeKey, identity.eventId],
      );
      const enabled = await client.query(
        `SELECT 1 FROM agent_memory_consolidation_consents
         WHERE namespace=$1 AND scope_kind=$2 AND scope_key=$3 AND enabled LIMIT 1`,
        [this.namespace, this.kind, identity.scopeKey],
      );
      if (!enabled.rowCount) return 0;
      await client.query(
        `INSERT INTO agent_memory_observations(namespace,scope_kind,scope_key,source_event_id,content,observed_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [this.namespace, this.kind, identity.scopeKey, identity.eventId, content, observedAt],
      );
      const result = await client.query(
        `INSERT INTO agent_memory_consolidation_admissions(
           namespace,scope_kind,scope_key,workflow,source_event_id,consent_version
         ) SELECT consent.namespace,consent.scope_kind,consent.scope_key,consent.workflow,$4,consent.consent_version
         FROM agent_memory_consolidation_consents consent
         WHERE consent.namespace=$1 AND consent.scope_kind=$2 AND consent.scope_key=$3 AND consent.enabled
         ON CONFLICT (namespace,scope_kind,scope_key,workflow,source_event_id) DO NOTHING`,
        [this.namespace, this.kind, identity.scopeKey, identity.eventId],
      );
      return result.rowCount ?? 0;
    });
  }

  async pendingCandidates(authorization: MemoryAuthorization): Promise<
    Array<{
      candidateId: string;
      key: string;
      content: string;
      kind: string;
      validUntil: string | null;
      status: 'pending_confirmation' | 'conflict';
    }>
  > {
    const identity = this.identity(authorization);
    if (!identity) throw new Error('agent_memory_candidate_scope_required');
    const result = await this.pool.query<{
      candidate_id: string;
      memory_key: string;
      content: string;
      candidate_kind: string;
      valid_until: Date | null;
      status: 'pending_confirmation' | 'conflict';
    }>(
      `SELECT candidate.candidate_id,candidate.memory_key,candidate.content,candidate.candidate_kind,
         candidate.valid_until,candidate.status
       FROM agent_memory_consolidation_candidates candidate
       WHERE candidate.namespace=$1 AND candidate.scope_kind=$2 AND candidate.scope_key=$3
         AND candidate.status IN ('pending_confirmation','conflict') AND candidate.expires_at>now()
         AND EXISTS (SELECT 1 FROM agent_memory_consolidation_consents consent
           WHERE consent.namespace=candidate.namespace AND consent.scope_kind=candidate.scope_kind
             AND consent.scope_key=candidate.scope_key
             AND consent.workflow=candidate.workflow AND consent.enabled
             AND consent.consent_version=candidate.consent_version)
         AND NOT EXISTS (
           SELECT 1 FROM unnest(candidate.source_event_ids) AS source(event_id)
           WHERE NOT EXISTS (SELECT 1 FROM agent_memory_consolidation_admissions admission
             ${sourceJoin('admission', 'obs')}
             WHERE admission.namespace=candidate.namespace AND admission.scope_kind=candidate.scope_kind
               AND admission.scope_key=candidate.scope_key
               AND admission.workflow=candidate.workflow AND admission.consent_version=candidate.consent_version
               AND admission.source_event_id=source.event_id AND admission.status='done' AND admission.expires_at>now())
         )
       ORDER BY candidate.created_at DESC,candidate.candidate_id LIMIT 12`,
      [this.namespace, this.kind, identity.scopeKey],
    );
    return result.rows.map((row) => ({
      candidateId: row.candidate_id,
      key: row.memory_key,
      content: row.content,
      kind: row.candidate_kind,
      validUntil: row.valid_until?.toISOString() ?? null,
      status: row.status,
    }));
  }

  async confirmCandidate(
    authorization: MemoryAuthorization,
    candidateId: string,
  ): Promise<'promoted' | 'already_promoted' | 'conflict' | 'unavailable'> {
    const identity = this.identity(authorization);
    if (!identity || !/^[0-9a-f-]{36}$/iu.test(candidateId)) return 'unavailable';
    const base = [this.namespace, this.kind, identity.scopeKey];
    return transaction(this.pool, async (client) => {
      const candidateScope = await client.query<{
        workflow: MemoryConsolidationWorkflow;
        consent_version: string;
        memory_key: string;
      }>(
        `SELECT candidate.workflow,candidate.consent_version::TEXT AS consent_version,candidate.memory_key
         FROM agent_memory_consolidation_candidates candidate
         ${consentJoin('candidate')}
         WHERE candidate.candidate_id=$4 AND candidate.namespace=$1 AND candidate.scope_kind=$2
           AND candidate.scope_key=$3
           AND candidate.expires_at>now() AND candidate.status IN ('pending_confirmation','conflict','promoted')`,
        [...base, candidateId],
      );
      const scope = candidateScope.rows[0];
      if (!scope) return 'unavailable';
      const memoryLockKey = createHash('sha256')
        .update([...base, scope.memory_key].join('\0'))
        .digest('hex');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [memoryLockKey]);
      const memory = await client.query<{
        memory_id: string;
        revision: string;
        revoked_at: Date | null;
        content: string;
      }>(
        `SELECT memory_id,revision::TEXT AS revision,revoked_at,content FROM agent_memory_entries
         WHERE namespace=$1 AND scope_kind=$2 AND scope_key=$3 AND memory_key=$4 FOR UPDATE`,
        [...base, scope.memory_key],
      );
      const current = memory.rows[0];
      const consent = await client.query(
        `SELECT 1 FROM agent_memory_consolidation_consents
         WHERE namespace=$1 AND scope_kind=$2 AND scope_key=$3 AND workflow=$4 AND consent_version=$5::BIGINT
           AND enabled FOR SHARE`,
        [...base, scope.workflow, scope.consent_version],
      );
      if (!consent.rowCount) return 'unavailable';
      const candidate = await client.query<{
        candidate_id: string;
        workflow: MemoryConsolidationWorkflow;
        consent_version: string;
        memory_key: string;
        content: string;
        valid_until: Date | null;
        expected_revision: string | null;
        status: string;
        confirmed_by_event_id: string | null;
        source_event_ids: string[];
      }>(
        `SELECT candidate.candidate_id,candidate.workflow,candidate.consent_version::TEXT AS consent_version,
           candidate.memory_key,candidate.content,candidate.valid_until,
           candidate.expected_revision::TEXT AS expected_revision,candidate.status,
           candidate.confirmed_by_event_id,candidate.source_event_ids
         FROM agent_memory_consolidation_candidates candidate
         ${consentJoin('candidate')}
         WHERE candidate.candidate_id=$4 AND candidate.namespace=$1 AND candidate.scope_kind=$2
           AND candidate.scope_key=$3
           AND candidate.expires_at>now() AND candidate.status IN ('pending_confirmation','conflict','promoted')
         FOR UPDATE OF candidate`,
        [...base, candidateId],
      );
      const row = candidate.rows[0];
      if (!row) return 'unavailable';
      if (row.status === 'promoted' && row.confirmed_by_event_id === identity.eventId)
        return 'already_promoted';
      if (!['pending_confirmation', 'conflict'].includes(row.status)) return 'unavailable';

      const sources = await client.query<{ count: number }>(
        `SELECT COUNT(*)::INTEGER AS count FROM unnest($5::TEXT[]) AS source(event_id)
         WHERE EXISTS (SELECT 1 FROM agent_memory_consolidation_admissions admission
           ${consentJoin('admission')}
           ${sourceJoin('admission', 'message')}
           WHERE admission.namespace=$1 AND admission.scope_kind=$2 AND admission.scope_key=$3
             AND admission.workflow=$4 AND admission.consent_version=$6
             AND admission.source_event_id=source.event_id
             AND admission.status='done' AND admission.expires_at>now())`,
        [...base, row.workflow, row.source_event_ids, row.consent_version],
      );
      if (sources.rows[0]?.count !== row.source_event_ids.length) {
        await client.query(
          `UPDATE agent_memory_consolidation_candidates SET status='expired',result_reason='source_expired',
             content='[expired]',memory_key='expired',source_event_ids=ARRAY[]::TEXT[],updated_at=now()
           WHERE candidate_id=$1`,
          [candidateId],
        );
        return 'unavailable';
      }

      const expected = row.expected_revision === null ? null : Number(row.expected_revision);
      if ((!current && expected !== null) || (current && Number(current.revision) !== expected)) {
        await client.query(
          `UPDATE agent_memory_consolidation_candidates SET status='conflict',result_reason='cas_conflict',updated_at=now()
           WHERE candidate_id=$1`,
          [candidateId],
        );
        return 'conflict';
      }

      let memoryId: string | null;
      let revision: number | null;
      if (current) {
        if (current.revoked_at && current.revoked_at >= authorization.receivedAt) return 'conflict';
        const update = await client.query<{ memory_id: string; revision: string }>(
          `UPDATE agent_memory_entries SET content=$1,source_event_id=$2,source_kind='user_confirmed',
             source_reliability=95,valid_until=$3,revoked_at=NULL,superseded_at=NULL,
             revision=revision+1,updated_at=now()
           WHERE memory_id=$4 AND revision=$5::BIGINT
             AND (revoked_at IS NULL OR revoked_at<$6::TIMESTAMPTZ)
           RETURNING memory_id,revision::TEXT AS revision`,
          [
            row.content,
            identity.eventId,
            row.valid_until,
            current.memory_id,
            row.expected_revision,
            authorization.receivedAt,
          ],
        );
        memoryId = update.rows[0]?.memory_id ?? null;
        revision = update.rows[0] ? Number(update.rows[0].revision) : null;
      } else {
        const insert = await client.query<{ memory_id: string; revision: string }>(
          `INSERT INTO agent_memory_entries(
             namespace,scope_kind,scope_key,memory_key,content,source_event_id,source_kind,source_reliability,valid_until
           ) VALUES ($1,$2,$3,$4,$5,$6,'user_confirmed',95,$7)
           ON CONFLICT DO NOTHING RETURNING memory_id,revision::TEXT AS revision`,
          [...base, row.memory_key, row.content, identity.eventId, row.valid_until],
        );
        memoryId = insert.rows[0]?.memory_id ?? null;
        revision = insert.rows[0] ? Number(insert.rows[0].revision) : null;
      }
      if (!memoryId || !revision) {
        await client.query(
          `UPDATE agent_memory_consolidation_candidates SET status='conflict',result_reason='cas_conflict',updated_at=now()
           WHERE candidate_id=$1`,
          [candidateId],
        );
        return 'conflict';
      }
      await client.query(
        `INSERT INTO agent_memory_embedding_jobs(memory_id,source_revision,operation,index_version)
         SELECT $1,$2,'upsert',generation.index_version
         FROM agent_memory_index_job_versions($3) generation ON CONFLICT DO NOTHING`,
        [memoryId, revision, this.namespace],
      );
      await client.query(
        `UPDATE agent_memory_consolidation_candidates SET status='promoted',confirmed_by_event_id=$2,
           expected_revision=$3,result_reason=NULL,updated_at=now()
         WHERE candidate_id=$1`,
        [candidateId, identity.eventId, revision],
      );
      return 'promoted';
    });
  }

  async rejectCandidate(authorization: MemoryAuthorization, candidateId: string): Promise<boolean> {
    const identity = this.identity(authorization);
    if (!identity || !/^[0-9a-f-]{36}$/iu.test(candidateId)) return false;
    const result = await this.pool.query(
      `UPDATE agent_memory_consolidation_candidates candidate SET status='rejected',result_reason=NULL,
         memory_key='rejected',content='[rejected]',source_event_ids=ARRAY[]::TEXT[],updated_at=now()
       WHERE candidate.candidate_id=$4 AND candidate.namespace=$1 AND candidate.scope_kind=$2
         AND candidate.scope_key=$3 AND candidate.status IN ('pending_confirmation','conflict')
         AND EXISTS (SELECT 1 FROM agent_memory_consolidation_consents consent
           WHERE consent.namespace=candidate.namespace AND consent.scope_kind=candidate.scope_kind
             AND consent.scope_key=candidate.scope_key
             AND consent.workflow=candidate.workflow AND consent.enabled
             AND consent.consent_version=candidate.consent_version)`,
      [this.namespace, this.kind, identity.scopeKey, candidateId],
    );
    return result.rowCount === 1;
  }
}

/** Background-capable worker; callers provide scheduling and the inference planner. */
export class MemoryConsolidationWorker {
  private readonly kind: string;
  private readonly maxRemBatch: number;
  private readonly maxDeepCandidates: number;
  private readonly maxInputCharacters: number;
  private readonly maxCandidates: number;
  private readonly leaseMs: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    private readonly namespace: string,
    private readonly planner: MemoryConsolidationPlanner,
    options: MemoryConsolidationWorkerOptions & { scopeKind?: string } = {},
  ) {
    this.kind = checkedKind(options.scopeKind ?? 'user');
    this.maxRemBatch = options.maxRemBatch ?? 8;
    this.maxDeepCandidates = options.maxDeepCandidates ?? 64;
    this.maxInputCharacters = options.maxInputCharacters ?? 6_000;
    this.maxCandidates = options.maxCandidates ?? 4;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.maxRemBatch) ||
      this.maxRemBatch < 1 ||
      this.maxRemBatch > 8 ||
      !Number.isSafeInteger(this.maxDeepCandidates) ||
      this.maxDeepCandidates < 1 ||
      this.maxDeepCandidates > 128 ||
      !Number.isSafeInteger(this.maxInputCharacters) ||
      this.maxInputCharacters < 100 ||
      this.maxInputCharacters > 12_000 ||
      !Number.isSafeInteger(this.maxCandidates) ||
      this.maxCandidates < 1 ||
      this.maxCandidates > 8 ||
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 1_000 ||
      this.leaseMs > 60_000 ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 30_000 ||
      !Number.isSafeInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 8
    ) {
      throw new Error('agent_memory_consolidation_limits_invalid');
    }
  }

  private async claim(workflow: MemoryConsolidationWorkflow): Promise<Admission[] | null> {
    // Revoke stale queue rows from metadata alone, before any observation is read.
    await this.pool.query(
      `UPDATE agent_memory_consolidation_admissions admission SET status='skipped',lease_token=NULL,lease_until=NULL,
         skip_reason=CASE WHEN admission.expires_at<=now() THEN 'source_expired' ELSE 'consent_revoked' END,updated_at=now()
       WHERE admission.namespace=$1 AND admission.scope_kind=$3 AND admission.workflow=$2
         AND admission.status IN ('pending','retry')
         AND (admission.expires_at<=now() OR NOT EXISTS (
           SELECT 1 FROM agent_memory_consolidation_consents consent
           WHERE consent.namespace=admission.namespace AND consent.scope_kind=admission.scope_kind
             AND consent.scope_key=admission.scope_key
             AND consent.workflow=admission.workflow
             AND consent.enabled AND consent.consent_version=admission.consent_version))`,
      [this.namespace, workflow, this.kind],
    );
    const leaseToken = randomUUID();
    return transaction(this.pool, async (client) => {
      const anchor = await client.query<{ scope_key: string; consent_version: string }>(
        `SELECT admission.scope_key,admission.consent_version::TEXT AS consent_version
         FROM agent_memory_consolidation_admissions admission
         ${consentJoin('admission')}
         WHERE admission.namespace=$1 AND admission.scope_kind=$3 AND admission.workflow=$2
           AND admission.expires_at>now()
           AND ((admission.status IN ('pending','retry') AND admission.next_attempt_at<=now())
             OR (admission.status='processing' AND admission.lease_until<=now()))
         ORDER BY admission.admitted_at,admission.source_event_id
         FOR UPDATE OF admission SKIP LOCKED LIMIT 1`,
        [this.namespace, workflow, this.kind],
      );
      if (!anchor.rows[0]) return null;
      const batchSize = workflow === 'light' ? 1 : this.maxRemBatch;
      const rows = await client.query<{ admission_id: string }>(
        `SELECT admission.admission_id FROM agent_memory_consolidation_admissions admission
         ${consentJoin('admission')}
         WHERE admission.namespace=$1 AND admission.scope_kind=$6 AND admission.scope_key=$3
           AND admission.workflow=$2
           AND admission.consent_version=$4 AND admission.expires_at>now()
           AND ((admission.status IN ('pending','retry') AND admission.next_attempt_at<=now())
             OR (admission.status='processing' AND admission.lease_until<=now()))
         ORDER BY admission.admitted_at,admission.source_event_id
         FOR UPDATE OF admission SKIP LOCKED LIMIT $5`,
        [
          this.namespace,
          workflow,
          anchor.rows[0].scope_key,
          anchor.rows[0].consent_version,
          batchSize,
          this.kind,
        ],
      );
      const ids = rows.rows.map((row) => row.admission_id);
      if (!ids.length) return null;
      const claimed = await client.query<Admission>(
        `UPDATE agent_memory_consolidation_admissions admission SET status='processing',
           attempt_count=attempt_count+1,lease_token=$2::uuid,lease_until=now()+($3::BIGINT*interval '1 millisecond'),
           skip_reason=NULL,updated_at=now()
         WHERE admission.admission_id=ANY($1::uuid[])
         RETURNING admission_id,namespace,scope_key,workflow,source_event_id,
           consent_version::TEXT AS consent_version,admitted_at,attempt_count,lease_token::TEXT AS lease_token`,
        [ids, leaseToken, this.leaseMs],
      );
      return claimed.rows;
    });
  }

  private async authorizeMetadata(
    batch: Admission[],
  ): Promise<{ valid: Admission[]; skipped: number }> {
    const ids = batch.map((row) => row.admission_id);
    const result = await this.pool.query<{
      admission_id: string;
      consent_valid: boolean;
      message_valid: boolean;
      message_exists: boolean;
    }>(
      `SELECT admission.admission_id,
         EXISTS (SELECT 1 FROM agent_memory_consolidation_consents consent
           WHERE consent.namespace=admission.namespace AND consent.scope_kind=admission.scope_kind
             AND consent.scope_key=admission.scope_key
             AND consent.workflow=admission.workflow AND consent.enabled
             AND consent.consent_version=admission.consent_version) AS consent_valid,
         EXISTS (SELECT 1 FROM agent_memory_observations source
           WHERE source.namespace=admission.namespace AND source.scope_kind=admission.scope_kind
             AND source.scope_key=admission.scope_key AND source.source_event_id=admission.source_event_id
             AND source.expires_at>now()) AS message_valid,
         EXISTS (SELECT 1 FROM agent_memory_observations source
           WHERE source.namespace=admission.namespace AND source.scope_kind=admission.scope_kind
             AND source.scope_key=admission.scope_key AND source.source_event_id=admission.source_event_id) AS message_exists
       FROM agent_memory_consolidation_admissions admission
       WHERE admission.admission_id=ANY($1::uuid[]) AND admission.status='processing'
         AND admission.lease_token=$2::uuid`,
      [ids, batch[0]!.lease_token],
    );
    const states = new Map(result.rows.map((row) => [row.admission_id, row]));
    const valid: Admission[] = [];
    let skipped = 0;
    for (const admission of batch) {
      const state = states.get(admission.admission_id);
      const reason = !state?.consent_valid
        ? 'consent_revoked'
        : !state.message_valid
          ? state.message_exists
            ? 'source_expired'
            : 'source_provenance_missing'
          : null;
      if (!reason) valid.push(admission);
      else {
        await this.skip([admission], reason);
        skipped += 1;
      }
    }
    return { valid, skipped };
  }

  private async skip(batch: Admission[], reason: string): Promise<void> {
    if (!batch.length) return;
    await this.pool.query(
      `UPDATE agent_memory_consolidation_admissions SET status='skipped',skip_reason=$3,
         lease_token=NULL,lease_until=NULL,updated_at=now()
       WHERE admission_id=ANY($1::uuid[]) AND status='processing' AND lease_token=$2::uuid`,
      [batch.map((row) => row.admission_id), batch[0]!.lease_token, reason],
    );
  }

  private async readMessages(batch: Admission[]): Promise<SourceMessage[]> {
    return transaction(this.pool, async (client) => {
      // This first read validates the server-issued capability and current consent again without
      // selecting content.
      const capability = await client.query<{ admission_id: string }>(
        `SELECT admission.admission_id FROM agent_memory_consolidation_admissions admission
         ${consentJoin('admission')}
         WHERE admission.admission_id=ANY($1::uuid[]) AND admission.status='processing'
           AND admission.lease_token=$2::uuid AND admission.expires_at>now()
         FOR SHARE OF admission,consent`,
        [batch.map((row) => row.admission_id), batch[0]!.lease_token],
      );
      if (capability.rows.length !== batch.length) return [];
      // Observation text is selected only after the consent, expiry and lease checks above passed.
      const result = await client.query<SourceMessage>(
        `SELECT admission.admission_id,admission.source_event_id,admission.admitted_at,
           source.content,source.observed_at AS created_at
         FROM agent_memory_consolidation_admissions admission
         ${consentJoin('admission')}
         ${sourceJoin('admission')}
         WHERE admission.admission_id=ANY($1::uuid[]) AND admission.status='processing'
           AND admission.lease_token=$2::uuid AND admission.expires_at>now()
         ORDER BY admission.admitted_at,admission.source_event_id`,
        [batch.map((row) => row.admission_id), batch[0]!.lease_token],
      );
      return result.rows;
    });
  }

  private validateCandidates(
    raw: unknown[],
    messages: SourceMessage[],
    workflow: MemoryConsolidationWorkflow,
  ): ValidCandidate[] {
    const drafts: MemoryCandidateDraft[] = [];
    for (const item of raw.slice(0, this.maxCandidates)) {
      const parsed = MemoryConsolidationCandidateSchema.safeParse(item);
      if (parsed.success) drafts.push(parsed.data);
    }
    return normalizeMemoryCandidates(
      drafts,
      messages.map((source) => ({
        content: source.content,
        sourceEventId: source.source_event_id,
      })),
      {
        maxCandidates: this.maxCandidates,
        now: this.now,
        canonicalizeKey: canonicalStoredMemoryKey,
        isProhibited: sensitiveOrRiskText,
        createIdempotencyKey: ({ key, content, evidenceEventIds }) =>
          createHash('sha256')
            .update(
              [
                this.namespace,
                messages[0]!.source_event_id,
                workflow,
                messages[0]!.admission_id, // a new consent version receives a new admission capability
                ...evidenceEventIds,
                key,
                content,
              ].join('\0'),
            )
            .digest('hex'),
      },
    );
  }

  private async complete(
    batch: Admission[],
    messages: SourceMessage[],
    candidates: ValidCandidate[],
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const leaseToken = batch[0]!.lease_token;
      const ids = batch.map((row) => row.admission_id);
      const authority = await client.query<{ admission_id: string }>(
        `SELECT admission.admission_id FROM agent_memory_consolidation_admissions admission
         ${consentJoin('admission')}
         ${sourceJoin('admission')}
         WHERE admission.admission_id=ANY($1::uuid[]) AND admission.status='processing'
           AND admission.lease_token=$2::uuid AND admission.expires_at>now()
         FOR SHARE OF admission,consent,source`,
        [ids, leaseToken],
      );
      if (authority.rows.length !== batch.length) {
        await client.query(
          `UPDATE agent_memory_consolidation_admissions admission SET status='skipped',skip_reason=
             CASE WHEN NOT EXISTS (SELECT 1 FROM agent_memory_consolidation_consents consent
               WHERE consent.namespace=admission.namespace AND consent.scope_kind=admission.scope_kind
                 AND consent.scope_key=admission.scope_key
                 AND consent.workflow=admission.workflow AND consent.enabled
                 AND consent.consent_version=admission.consent_version)
               THEN 'consent_revoked' ELSE 'source_provenance_missing' END,
             lease_token=NULL,lease_until=NULL,updated_at=now()
           WHERE admission.admission_id=ANY($1::uuid[]) AND admission.status='processing' AND admission.lease_token=$2::uuid`,
          [ids, leaseToken],
        );
        return false;
      }
      const first = batch[0]!;
      const base = [first.namespace, this.kind, first.scope_key];
      for (const candidate of candidates) {
        const consolidated = await client.query<{ candidate_id: string }>(
          `UPDATE agent_memory_consolidation_candidates existing SET
             source_event_ids=ARRAY(
               SELECT live.event_id FROM (
                 SELECT requested.event_id,MAX(admission.admitted_at) AS admitted_at
                 FROM unnest(existing.source_event_ids || $10::TEXT[]) AS requested(event_id)
                 JOIN agent_memory_consolidation_admissions admission
                   ON admission.namespace=$1 AND admission.scope_kind=$2 AND admission.scope_key=$3
                     AND admission.workflow=$4
                     AND admission.consent_version=$5::BIGINT AND admission.source_event_id=requested.event_id
                     AND admission.expires_at>now()
                     AND (admission.status='done' OR (admission.status='processing'
                       AND admission.admission_id=ANY($11::uuid[]) AND admission.lease_token=$12::uuid))
                 ${sourceJoin('admission')}
                 GROUP BY requested.event_id
                 ORDER BY MAX(admission.admitted_at) DESC,requested.event_id DESC
                 LIMIT 8
               ) live ORDER BY live.admitted_at,live.event_id
             ),
             valid_until=$9,updated_at=now()
           FROM agent_memory_consolidation_consents consent
           WHERE existing.namespace=$1 AND existing.scope_kind=$2 AND existing.scope_key=$3
             AND existing.workflow=$4
             AND existing.consent_version=$5::BIGINT AND existing.memory_key=$6 AND existing.content=$7
             AND existing.candidate_kind=$8 AND existing.status IN ('pending_confirmation','conflict')
             AND existing.expires_at>now() AND consent.namespace=existing.namespace
             AND consent.scope_kind=existing.scope_kind AND consent.scope_key=existing.scope_key
             AND consent.workflow=existing.workflow
             AND consent.enabled AND consent.consent_version=existing.consent_version
             AND EXISTS (SELECT 1 FROM agent_memory_consolidation_admissions admission
               WHERE admission.admission_id=ANY($11::uuid[]) AND admission.status='processing'
                 AND admission.lease_token=$12::uuid)
           RETURNING existing.candidate_id::TEXT AS candidate_id`,
          [
            ...base,
            first.workflow,
            first.consent_version,
            candidate.key,
            candidate.content,
            candidate.kind,
            candidate.validUntil,
            candidate.evidenceEventIds,
            ids,
            leaseToken,
          ],
        );
        if (consolidated.rows[0]) continue;
        const inserted = await client.query<{ candidate_id: string }>(
          `INSERT INTO agent_memory_consolidation_candidates(
             idempotency_key,namespace,scope_kind,scope_key,workflow,consent_version,memory_key,content,
             candidate_kind,valid_until,source_event_ids,expected_revision,status,result_reason
           ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::TEXT[],NULL,'pending_confirmation',NULL
           WHERE EXISTS (SELECT 1 FROM agent_memory_consolidation_admissions admission
             ${consentJoin('admission')}
             WHERE admission.admission_id=ANY($12::uuid[]) AND admission.status='processing'
               AND admission.lease_token=$13::uuid)
             AND $11::TEXT[] <@ (SELECT array_agg(admission.source_event_id)
               FROM agent_memory_consolidation_admissions admission
               WHERE admission.admission_id=ANY($12::uuid[]) AND admission.status='processing'
                 AND admission.lease_token=$13::uuid)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING candidate_id::TEXT AS candidate_id`,
          [
            candidate.idempotencyKey,
            ...base,
            first.workflow,
            first.consent_version,
            candidate.key,
            candidate.content,
            candidate.kind,
            candidate.validUntil,
            candidate.evidenceEventIds,
            ids,
            leaseToken,
          ],
        );
        const candidateId = inserted.rows[0]?.candidate_id;
        if (!candidateId) continue;

        const existing = await client.query<{
          memory_id: string;
          revision: string;
          content: string;
          revoked_at: Date | null;
        }>(
          `SELECT memory_id,revision::TEXT AS revision,content,revoked_at
           FROM agent_memory_entries WHERE namespace=$1 AND scope_kind=$2 AND scope_key=$3 AND memory_key=$4
           FOR UPDATE`,
          [...base, candidate.key],
        );
        const current = existing.rows[0];
        if (current?.revoked_at) {
          await client.query(
            `UPDATE agent_memory_consolidation_candidates
             SET status='conflict',result_reason='existing_memory_conflict',expected_revision=$2,updated_at=now()
             WHERE candidate_id=$1`,
            [candidateId, Number(current.revision)],
          );
          continue;
        }
        if (current?.content === candidate.content) {
          await client.query(
            `UPDATE agent_memory_consolidation_candidates
             SET status='duplicate',result_reason='already_present',expected_revision=$2,updated_at=now()
             WHERE candidate_id=$1`,
            [candidateId, Number(current.revision)],
          );
          continue;
        }

        if (current) {
          await client.query(
            `UPDATE agent_memory_consolidation_candidates
             SET status='conflict',result_reason='cas_conflict',expected_revision=$2,updated_at=now()
             WHERE candidate_id=$1`,
            [candidateId, Number(current.revision)],
          );
        }
      }
      const latest = messages.reduce((left, right) =>
        left.admitted_at > right.admitted_at ||
        (left.admitted_at.getTime() === right.admitted_at.getTime() &&
          left.source_event_id > right.source_event_id)
          ? left
          : right,
      );
      await client.query(
        `INSERT INTO agent_memory_consolidation_checkpoints(
           namespace,scope_kind,scope_key,workflow,consent_version,last_admitted_at,last_event_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (namespace,scope_kind,scope_key,workflow,consent_version) DO UPDATE SET
           last_admitted_at=EXCLUDED.last_admitted_at,last_event_id=EXCLUDED.last_event_id,updated_at=now()
         WHERE (agent_memory_consolidation_checkpoints.last_admitted_at,agent_memory_consolidation_checkpoints.last_event_id)
           < (EXCLUDED.last_admitted_at,EXCLUDED.last_event_id)`,
        [
          ...base,
          first.workflow,
          first.consent_version,
          latest.admitted_at,
          latest.source_event_id,
        ],
      );
      await client.query(
        `UPDATE agent_memory_consolidation_admissions SET status='done',lease_token=NULL,lease_until=NULL,
           skip_reason=NULL,updated_at=now()
         WHERE admission_id=ANY($1::uuid[]) AND status='processing' AND lease_token=$2::uuid`,
        [ids, leaseToken],
      );
      return true;
    });
  }

  /** Consolidate eligible episodic candidates into long-term memory using evidence, not planner confidence. */
  async processDeep(limit = this.maxDeepCandidates): Promise<MemoryDeepRun> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxDeepCandidates) {
      throw new Error('agent_memory_deep_limit_invalid');
    }
    const result = await this.pool.query<DeepCandidateHandle>(
      `SELECT candidate.candidate_id::TEXT AS candidate_id,candidate.scope_key,candidate.memory_key,
         candidate.workflow,candidate.consent_version::TEXT AS consent_version
       FROM agent_memory_consolidation_candidates candidate
       ${consentJoin('candidate')}
       WHERE candidate.namespace=$1 AND candidate.scope_kind=$3
         AND candidate.status IN ('pending_confirmation','conflict')
         AND candidate.expires_at>now()
       ORDER BY candidate.created_at,candidate.candidate_id LIMIT $2`,
      [this.namespace, limit, this.kind],
    );
    if (!result.rows.length) return { status: 'SKIPPED_NO_ELIGIBLE_CORPUS' };

    const groups = new Map<string, DeepCandidateHandle[]>();
    for (const row of result.rows) {
      const key = `${row.scope_key}\0${row.memory_key}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    const totals = { inspected: 0, promoted: 0, rejected: 0, deferred: 0 };
    for (const handles of groups.values()) {
      const outcome = await this.processDeepGroup(
        handles[0]!.scope_key,
        handles[0]!.memory_key,
        handles,
      );
      totals.inspected += outcome.inspected;
      totals.promoted += outcome.promoted;
      totals.rejected += outcome.rejected;
      totals.deferred += outcome.deferred;
    }
    return { status: 'processed', ...totals };
  }

  private async processDeepGroup(
    scopeKey: string,
    memoryKey: string,
    handles: DeepCandidateHandle[],
  ): Promise<{ inspected: number; promoted: number; rejected: number; deferred: number }> {
    const base = [this.namespace, this.kind, scopeKey];
    return transaction(this.pool, async (client) => {
      // Coordinate missing-row tombstones, then use memory -> consent -> candidate lock order.
      const memoryLockKey = createHash('sha256')
        .update([...base, memoryKey].join('\0'))
        .digest('hex');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [memoryLockKey]);
      const memoryResult = await client.query<DeepMemory>(
        `SELECT memory_id::TEXT AS memory_id,revision::TEXT AS revision,content,source_event_id,valid_until,
           revoked_at,superseded_at
         FROM agent_memory_entries WHERE namespace=$1 AND scope_kind=$2 AND scope_key=$3 AND memory_key=$4
         FOR UPDATE`,
        [...base, memoryKey],
      );
      const current = memoryResult.rows[0] ?? null;

      await client.query(
        `SELECT workflow,consent_version FROM agent_memory_consolidation_consents
         WHERE namespace=$1 AND scope_kind=$2 AND scope_key=$3 FOR SHARE`,
        base,
      );
      const locked = await client.query<DeepCandidate>(
        `SELECT candidate.candidate_id::TEXT AS candidate_id,candidate.workflow,
           candidate.consent_version::TEXT AS consent_version,candidate.memory_key,candidate.content,
           candidate.candidate_kind,candidate.valid_until,candidate.source_event_ids,
           candidate.expected_revision::TEXT AS expected_revision,candidate.status,candidate.created_at
         FROM agent_memory_consolidation_candidates candidate
         ${consentJoin('candidate')}
         WHERE candidate.candidate_id=ANY($5::UUID[]) AND candidate.namespace=$1 AND candidate.scope_kind=$2
           AND candidate.scope_key=$3 AND candidate.memory_key=$4
           AND candidate.status IN ('pending_confirmation','conflict') AND candidate.expires_at>now()
         ORDER BY candidate.created_at,candidate.candidate_id
         FOR UPDATE OF candidate SKIP LOCKED`,
        [...base, memoryKey, handles.map((row) => row.candidate_id)],
      );
      const candidates = locked.rows;
      if (!candidates.length)
        return { inspected: 0, promoted: 0, rejected: 0, deferred: handles.length };

      // Validate authority and provenance without selecting observation text.
      const metadata = await client.query<DeepSourceMetadata>(
        `SELECT candidate.candidate_id::TEXT AS candidate_id,admission.source_event_id,
           source.observed_at AS created_at
         FROM agent_memory_consolidation_candidates candidate
         CROSS JOIN LATERAL unnest(candidate.source_event_ids) requested(event_id)
         JOIN agent_memory_consolidation_admissions admission
           ON admission.namespace=candidate.namespace AND admission.scope_kind=candidate.scope_kind
             AND admission.scope_key=candidate.scope_key
             AND admission.workflow=candidate.workflow AND admission.consent_version=candidate.consent_version
             AND admission.source_event_id=requested.event_id AND admission.status='done'
             AND admission.expires_at>now()
         ${sourceJoin('admission')}
         WHERE candidate.candidate_id=ANY($1::UUID[])
         FOR SHARE OF admission,source`,
        [candidates.map((row) => row.candidate_id)],
      );
      const metadataByCandidate = new Map<string, Set<string>>();
      for (const row of metadata.rows) {
        const sources = metadataByCandidate.get(row.candidate_id) ?? new Set<string>();
        sources.add(row.source_event_id);
        metadataByCandidate.set(row.candidate_id, sources);
      }
      const invalidSourceIds = candidates
        .filter(
          (candidate) =>
            new Set(candidate.source_event_ids).size === 0 ||
            (metadataByCandidate.get(candidate.candidate_id)?.size ?? 0) !==
              new Set(candidate.source_event_ids).size,
        )
        .map((candidate) => candidate.candidate_id);
      if (invalidSourceIds.length) {
        await client.query(
          `UPDATE agent_memory_consolidation_candidates SET status='expired',result_reason='source_expired',
             content='[expired]',memory_key='expired',source_event_ids=ARRAY[]::TEXT[],
             expected_revision=NULL,confirmed_by_event_id=NULL,updated_at=now()
           WHERE candidate_id=ANY($1::UUID[]) AND status IN ('pending_confirmation','conflict')`,
          [invalidSourceIds],
        );
      }
      const validCandidates = candidates.filter(
        (candidate) => !invalidSourceIds.includes(candidate.candidate_id),
      );
      if (!validCandidates.length) {
        return { inspected: candidates.length, promoted: 0, rejected: 0, deferred: 0 };
      }

      // Observation text is read only after current consent, completed admission and expiry pass.
      const sources = await client.query<DeepSource>(
        `SELECT candidate.candidate_id::TEXT AS candidate_id,admission.source_event_id,
           source.observed_at AS created_at,source.content
         FROM agent_memory_consolidation_candidates candidate
         CROSS JOIN LATERAL unnest(candidate.source_event_ids) requested(event_id)
         JOIN agent_memory_consolidation_admissions admission
           ON admission.namespace=candidate.namespace AND admission.scope_kind=candidate.scope_kind
             AND admission.scope_key=candidate.scope_key
             AND admission.workflow=candidate.workflow AND admission.consent_version=candidate.consent_version
             AND admission.source_event_id=requested.event_id AND admission.status='done'
             AND admission.expires_at>now()
         ${sourceJoin('admission')}
         WHERE candidate.candidate_id=ANY($1::UUID[])
         ORDER BY candidate.candidate_id,source.observed_at,admission.source_event_id
         FOR SHARE OF admission,source`,
        [validCandidates.map((row) => row.candidate_id)],
      );
      const sourcesByCandidate = new Map<string, DeepSource[]>();
      for (const row of sources.rows) {
        const values = sourcesByCandidate.get(row.candidate_id) ?? [];
        values.push(row);
        sourcesByCandidate.set(row.candidate_id, values);
      }

      type ValueEvidence = {
        content: string;
        candidates: DeepCandidate[];
        sources: Map<string, { createdAt: Date; content: string }>;
      };
      const values = new Map<string, ValueEvidence>();
      const rejectedIds: string[] = [];
      const expiredIds: string[] = [];
      for (const candidate of validCandidates) {
        const normalizedContent = candidate.content.normalize('NFKC').trim();
        const candidateSources = sourcesByCandidate.get(candidate.candidate_id) ?? [];
        const sourceTextUnsafe = candidateSources.some(
          (source) => sensitiveOrRiskText(source.content) || !hasSelfAttribution(source.content),
        );
        const candidateUnsafe =
          !normalizedContent ||
          normalizedContent.length > 800 ||
          sensitiveOrRiskText(normalizedContent);
        const sourceMismatch =
          candidateSources.length !== new Set(candidate.source_event_ids).size ||
          candidateSources.some(
            (source) => !source.content.normalize('NFKC').includes(normalizedContent),
          );
        if (sourceTextUnsafe || candidateUnsafe || sourceMismatch) {
          rejectedIds.push(candidate.candidate_id);
          continue;
        }
        if (candidate.valid_until && candidate.valid_until.getTime() <= this.now()) {
          expiredIds.push(candidate.candidate_id);
          continue;
        }
        const value: ValueEvidence = values.get(normalizedContent) ?? {
          content: normalizedContent,
          candidates: [],
          sources: new Map(),
        };
        value.candidates.push(candidate);
        for (const source of candidateSources) {
          value.sources.set(source.source_event_id, {
            createdAt: source.created_at,
            content: source.content,
          });
        }
        values.set(normalizedContent, value);
      }
      if (rejectedIds.length) {
        await client.query(
          `UPDATE agent_memory_consolidation_candidates SET status='rejected',result_reason=NULL,
             memory_key='rejected',content='[rejected]',source_event_ids=ARRAY[]::TEXT[],
             expected_revision=NULL,confirmed_by_event_id=NULL,updated_at=now()
           WHERE candidate_id=ANY($1::UUID[]) AND status IN ('pending_confirmation','conflict')`,
          [rejectedIds],
        );
      }
      if (expiredIds.length) {
        await client.query(
          `UPDATE agent_memory_consolidation_candidates SET status='expired',result_reason=NULL,
             memory_key='expired',content='[expired]',source_event_ids=ARRAY[]::TEXT[],
             expected_revision=NULL,confirmed_by_event_id=NULL,updated_at=now()
           WHERE candidate_id=ANY($1::UUID[]) AND status IN ('pending_confirmation','conflict')`,
          [expiredIds],
        );
      }
      const rejected = rejectedIds.length;
      const deferredCandidates = validCandidates.length - rejectedIds.length - expiredIds.length;
      if (!values.size) {
        return {
          inspected: candidates.length,
          promoted: 0,
          rejected,
          deferred: Math.max(0, deferredCandidates),
        };
      }

      // A tombstone is an explicit boundary: Deep has no path that can restore it.
      if (current?.revoked_at || current?.superseded_at) {
        return {
          inspected: candidates.length,
          promoted: 0,
          rejected,
          deferred: deferredCandidates,
        };
      }

      let usage = { recallCount: 0, distinctQueries: 0, usedCount: 0 };
      if (current && (!current.valid_until || current.valid_until.getTime() > this.now())) {
        const result = await client.query<{
          recall_count: number;
          distinct_queries: number;
          used_count: number;
        }>(
          `SELECT COUNT(*) FILTER (WHERE signal_kind='recalled')::INTEGER AS recall_count,
             COUNT(DISTINCT query_fingerprint) FILTER (WHERE signal_kind='recalled')::INTEGER AS distinct_queries,
             COUNT(*) FILTER (WHERE signal_kind='used')::INTEGER AS used_count
           FROM agent_memory_usage_signals
           WHERE namespace=$1 AND scope_kind=$2 AND scope_key=$3 AND memory_key=$4
             AND memory_revision=$5::BIGINT AND memory_source_event_id=$6 AND expires_at>now()`,
          [...base, memoryKey, current.revision, current.source_event_id],
        );
        usage = {
          recallCount: result.rows[0]?.recall_count ?? 0,
          distinctQueries: result.rows[0]?.distinct_queries ?? 0,
          usedCount: result.rows[0]?.used_count ?? 0,
        };
      }

      const summarized = [...values.values()].map((value) => {
        const sourceRows = [...value.sources.entries()].map(([eventId, source]) => ({
          eventId,
          ...source,
        }));
        const latestSource = sourceRows.reduce((latest, source) =>
          source.createdAt > latest.createdAt ||
          (source.createdAt.getTime() === latest.createdAt.getTime() &&
            source.eventId > latest.eventId)
            ? source
            : latest,
        );
        const latestCandidate = value.candidates.reduce((latest, candidate) =>
          candidate.created_at > latest.created_at ? candidate : latest,
        );
        const days = new Set(
          sourceRows.map((source) => source.createdAt.toISOString().slice(0, 10)),
        );
        return { ...value, sourceRows, latestSource, latestCandidate, days };
      });
      const evaluated = summarized.map((value) => {
        const competingValues = summarized.filter(
          (other) => other !== value && other.sources.size >= value.sources.size,
        ).length;
        const ageDays = Math.max(
          0,
          (this.now() - value.latestSource.createdAt.getTime()) / 86_400_000,
        );
        const decision = evaluateDeepPromotion({
          candidateKind: value.latestCandidate.candidate_kind,
          sourceReliability: AUTO_LEARN_SOURCE_RELIABILITY,
          supportingObservations: value.sources.size,
          distinctObservationDays: value.days.size,
          recallCount: usage.recallCount,
          distinctQueries: usage.distinctQueries,
          usedCount: usage.usedCount,
          ageDays,
          conflictsWithCurrent: Boolean(
            current && current.content.normalize('NFKC').trim() !== value.content,
          ),
          competingValues,
          prohibited: false,
        });
        return { ...value, decision };
      });
      const promotable = evaluated.filter((value) => value.decision.promote);
      if (promotable.length !== 1) {
        return {
          inspected: candidates.length,
          promoted: 0,
          rejected,
          deferred: deferredCandidates,
        };
      }
      const winner = promotable[0]!;
      if (
        current &&
        (!current.valid_until || current.valid_until.getTime() > this.now()) &&
        current.content.normalize('NFKC').trim() === winner.content
      ) {
        const winnerIds = winner.candidates.map((candidate) => candidate.candidate_id);
        await client.query(
          `UPDATE agent_memory_consolidation_candidates SET status='duplicate',result_reason='already_present',
             expected_revision=$2::BIGINT,updated_at=now()
           WHERE candidate_id=ANY($1::UUID[]) AND status IN ('pending_confirmation','conflict')`,
          [winnerIds, current.revision],
        );
        return {
          inspected: candidates.length,
          promoted: 0,
          rejected,
          deferred: Math.max(0, deferredCandidates - winnerIds.length),
        };
      }

      const expectedRevision = current?.revision ?? null;
      if (winner.candidates.some((candidate) => candidate.expected_revision !== expectedRevision)) {
        await client.query(
          `UPDATE agent_memory_consolidation_candidates SET status='conflict',result_reason='cas_conflict',updated_at=now()
           WHERE candidate_id=ANY($1::UUID[]) AND status IN ('pending_confirmation','conflict')`,
          [winner.candidates.map((candidate) => candidate.candidate_id)],
        );
        return {
          inspected: candidates.length,
          promoted: 0,
          rejected,
          deferred: deferredCandidates,
        };
      }

      let written: { memory_id: string; revision: string } | undefined;
      if (current) {
        const result = await client.query<{ memory_id: string; revision: string }>(
          `UPDATE agent_memory_entries SET content=$1,source_event_id=$2,source_kind='trusted_ingress',
             source_reliability=$3,valid_until=$4,revision=revision+1,updated_at=now(),superseded_at=NULL
           WHERE memory_id=$5::UUID AND revision=$6::BIGINT AND revoked_at IS NULL AND superseded_at IS NULL
           RETURNING memory_id::TEXT AS memory_id,revision::TEXT AS revision`,
          [
            winner.content,
            winner.latestSource.eventId,
            AUTO_LEARN_SOURCE_RELIABILITY,
            winner.latestCandidate.valid_until,
            current.memory_id,
            current.revision,
          ],
        );
        written = result.rows[0];
      } else {
        const result = await client.query<{ memory_id: string; revision: string }>(
          `INSERT INTO agent_memory_entries(
             namespace,scope_kind,scope_key,memory_key,content,source_event_id,source_kind,source_reliability,valid_until
           ) VALUES ($1,$2,$3,$4,$5,$6,'trusted_ingress',$7,$8)
           ON CONFLICT DO NOTHING RETURNING memory_id::TEXT AS memory_id,revision::TEXT AS revision`,
          [
            ...base,
            memoryKey,
            winner.content,
            winner.latestSource.eventId,
            AUTO_LEARN_SOURCE_RELIABILITY,
            winner.latestCandidate.valid_until,
          ],
        );
        written = result.rows[0];
      }
      if (!written) {
        await client.query(
          `UPDATE agent_memory_consolidation_candidates SET status='conflict',result_reason='cas_conflict',updated_at=now()
           WHERE candidate_id=ANY($1::UUID[]) AND status IN ('pending_confirmation','conflict')`,
          [winner.candidates.map((candidate) => candidate.candidate_id)],
        );
        return {
          inspected: candidates.length,
          promoted: 0,
          rejected,
          deferred: deferredCandidates,
        };
      }
      await client.query(
        `INSERT INTO agent_memory_embedding_jobs(memory_id,source_revision,operation,index_version)
         SELECT $1::UUID,$2::BIGINT,'upsert',generation.index_version
         FROM agent_memory_index_job_versions($3) generation ON CONFLICT DO NOTHING`,
        [written.memory_id, written.revision, this.namespace],
      );
      const winnerIds = winner.candidates.map((candidate) => candidate.candidate_id);
      await client.query(
        `UPDATE agent_memory_consolidation_candidates SET status='promoted',confirmed_by_event_id=NULL,
           expected_revision=$2::BIGINT,result_reason=NULL,updated_at=now()
         WHERE candidate_id=ANY($1::UUID[]) AND status IN ('pending_confirmation','conflict')`,
        [winnerIds, written.revision],
      );
      const losingIds = candidates
        .filter((candidate) => !winnerIds.includes(candidate.candidate_id))
        .map((candidate) => candidate.candidate_id);
      if (losingIds.length) {
        await client.query(
          `UPDATE agent_memory_consolidation_candidates SET status='rejected',result_reason=NULL,
             memory_key='rejected',content='[rejected]',source_event_ids=ARRAY[]::TEXT[],
             expected_revision=NULL,confirmed_by_event_id=NULL,updated_at=now()
           WHERE candidate_id=ANY($1::UUID[]) AND status IN ('pending_confirmation','conflict')`,
          [losingIds],
        );
      }
      return {
        inspected: candidates.length,
        promoted: 1,
        rejected: rejected + losingIds.length,
        deferred: Math.max(0, deferredCandidates - winnerIds.length - losingIds.length),
      };
    });
  }

  private async failed(batch: Admission[], reason: string): Promise<'retry' | 'dead'> {
    const dead = batch.some((row) => row.attempt_count >= this.maxAttempts);
    const waitSeconds = Math.min(3600, 5 * 2 ** Math.min(batch[0]!.attempt_count, 9));
    await this.pool.query(
      `UPDATE agent_memory_consolidation_admissions SET status=$3,
         next_attempt_at=now()+($4::INTEGER*interval '1 second'),
         skip_reason=CASE WHEN $3='dead' THEN 'system_work_unavailable' ELSE NULL END,
         lease_token=NULL,lease_until=NULL,updated_at=now()
       WHERE admission_id=ANY($1::uuid[]) AND status='processing' AND lease_token=$2::uuid`,
      [
        batch.map((row) => row.admission_id),
        batch[0]!.lease_token,
        dead ? 'dead' : 'retry',
        waitSeconds,
      ],
    );
    void reason; // Provider detail is deliberately never stored or logged.
    return dead ? 'dead' : 'retry';
  }

  async processNext(
    workflow: MemoryConsolidationWorkflow,
    signal?: AbortSignal,
  ): Promise<MemoryConsolidationRun> {
    const batch = await this.claim(workflow);
    if (!batch?.length) return { status: 'SKIPPED_NO_ELIGIBLE_CORPUS', workflow };
    const metadata = await this.authorizeMetadata(batch);
    if (!metadata.valid.length)
      return {
        status: 'skipped',
        workflow,
        reason: 'no_authorized_source',
        admitted: batch.length,
      };
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('agent_memory_consolidation_timeout')),
      this.timeoutMs,
    );
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const messages = await this.readMessages(metadata.valid);
      const messageIds = new Set(messages.map((item) => item.admission_id));
      const missingMessages = metadata.valid.filter((item) => !messageIds.has(item.admission_id));
      if (missingMessages.length) await this.skip(missingMessages, 'source_provenance_missing');
      const readable = metadata.valid.filter((item) => messageIds.has(item.admission_id));
      if (!messages.length) {
        return {
          status: 'skipped',
          workflow,
          reason: 'source_provenance_missing',
          admitted: batch.length,
        };
      }
      const totalCharacters = messages.reduce((total, item) => total + item.content.length, 0);
      if (totalCharacters > this.maxInputCharacters) {
        await this.skip(readable, 'input_over_budget');
        return { status: 'skipped', workflow, reason: 'input_over_budget', admitted: batch.length };
      }
      const raw = await this.planner.plan(
        {
          workflow,
          messages: messages.map((item) => ({
            content: item.content,
            createdAt: item.created_at.toISOString(),
          })),
        },
        controller.signal,
      );
      if (controller.signal.aborted) throw new Error('agent_memory_consolidation_timeout');
      const candidates = this.validateCandidates(raw, messages, workflow);
      const completed = await this.complete(readable, messages, candidates);
      if (!completed)
        return { status: 'skipped', workflow, reason: 'consent_revoked', admitted: batch.length };
      return {
        status: 'processed',
        workflow,
        admitted: metadata.valid.length,
        candidates: candidates.length,
      };
    } catch {
      const timedOut = controller.signal.aborted;
      const status = await this.failed(
        metadata.valid.filter(
          (item) => !item.lease_token || item.lease_token === batch[0]!.lease_token,
        ),
        timedOut ? 'worker_timeout' : 'planner_failed',
      );
      return { status: timedOut ? 'timed_out' : status, workflow, admitted: metadata.valid.length };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
