import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { buildExtractiveCheckpoint } from '@rine-kit/agent-memory';
import type { CheckpointSourceRow, ConversationCheckpointView } from '@rine-kit/agent-memory';
import { boundedText } from './scope.js';

export interface ConversationCheckpointScope {
  namespace: string;
  /** Names one conversation in the host (a room, a channel, a DM pair). Opaque to this package. */
  conversationKey: string;
}

function args(scope: ConversationCheckpointScope): [string, string] {
  return [boundedText(scope.namespace, 128), boundedText(scope.conversationKey, 256)];
}

/**
 * Rebuilds the stored checkpoint of one conversation from the rows the host says are older than the
 * live window (newest first, at most 100). The generation only moves when the covered rows changed.
 * No model is involved; running it again is harmless.
 */
export async function refreshConversationCheckpoint(
  pool: Pool,
  scope: ConversationCheckpointScope,
  olderRowsNewestFirst: readonly CheckpointSourceRow[],
): Promise<void> {
  const checkpoint = buildExtractiveCheckpoint(olderRowsNewestFirst);
  if (!checkpoint || !checkpoint.text) return;
  const [namespace, key] = args(scope);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = createHash('sha256').update(`${namespace}\0${key}`).digest('hex');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `memory-checkpoint:${lock}`,
    ]);
    await client.query(
      `INSERT INTO agent_memory_conversation_checkpoints(
         namespace,conversation_key,generation,coverage_from,coverage_through,covered_message_count,
         source_event_ids,checkpoint_text,source_digest,rebuildable,updated_at
       ) VALUES ($1,$2,1,$3::TIMESTAMPTZ,$4::TIMESTAMPTZ,$5,$6::TEXT[],$7,$8,true,now())
       ON CONFLICT (namespace,conversation_key) DO UPDATE SET
         generation=CASE WHEN agent_memory_conversation_checkpoints.source_digest IS DISTINCT FROM EXCLUDED.source_digest
           THEN agent_memory_conversation_checkpoints.generation+1 ELSE agent_memory_conversation_checkpoints.generation END,
         coverage_from=EXCLUDED.coverage_from,coverage_through=EXCLUDED.coverage_through,
         covered_message_count=EXCLUDED.covered_message_count,source_event_ids=EXCLUDED.source_event_ids,
         checkpoint_text=EXCLUDED.checkpoint_text,source_digest=EXCLUDED.source_digest,
         rebuildable=true,updated_at=CASE WHEN agent_memory_conversation_checkpoints.source_digest IS DISTINCT FROM EXCLUDED.source_digest
           THEN now() ELSE agent_memory_conversation_checkpoints.updated_at END`,
      [
        namespace,
        key,
        checkpoint.coverageFrom,
        checkpoint.coverageThrough,
        checkpoint.coveredMessageCount,
        checkpoint.sourceEventIds,
        checkpoint.text,
        checkpoint.sourceDigest,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The stored checkpoint in the shape the context budget builder takes, or null. */
export async function loadConversationCheckpoint(
  pool: Pool,
  scope: ConversationCheckpointScope,
): Promise<ConversationCheckpointView | null> {
  const [namespace, key] = args(scope);
  const result = await pool.query<{
    checkpoint_text: string;
    generation: string;
    coverage_from: Date;
    coverage_through: Date;
    covered_message_count: number;
    source_event_ids: string[];
  }>(
    `SELECT checkpoint_text,generation::TEXT AS generation,coverage_from,coverage_through,
       covered_message_count,source_event_ids
     FROM agent_memory_conversation_checkpoints WHERE namespace=$1 AND conversation_key=$2`,
    [namespace, key],
  );
  const row = result.rows[0];
  return row
    ? {
        text: row.checkpoint_text,
        generation: Number(row.generation),
        coverageFrom: row.coverage_from.toISOString(),
        coverageThrough: row.coverage_through.toISOString(),
        coveredMessageCount: row.covered_message_count,
        sourceEventIds: row.source_event_ids,
      }
    : null;
}
