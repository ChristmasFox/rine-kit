-- Rebuildable, bounded extractive checkpoints for older working context. Adapted from Gate migration
-- 0023: the KOOK channel / binding columns become an opaque conversation key chosen by the host.
-- The host's transcript stays the source of truth; this is never semantic memory.
CREATE TABLE agent_memory_conversation_checkpoints (
  namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 128),
  conversation_key TEXT NOT NULL CHECK (length(conversation_key) BETWEEN 1 AND 256),
  generation BIGINT NOT NULL CHECK (generation > 0),
  coverage_from TIMESTAMPTZ NOT NULL,
  coverage_through TIMESTAMPTZ NOT NULL,
  covered_message_count INTEGER NOT NULL CHECK (covered_message_count BETWEEN 1 AND 100),
  source_event_ids TEXT[] NOT NULL CHECK (cardinality(source_event_ids) <= 48),
  checkpoint_text TEXT NOT NULL CHECK (length(checkpoint_text) <= 16000),
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  rebuildable BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace,conversation_key),
  CHECK (coverage_through >= coverage_from)
);
