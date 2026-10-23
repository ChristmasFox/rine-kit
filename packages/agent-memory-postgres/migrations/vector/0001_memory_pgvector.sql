-- Optional vector schema (Gate migration 0025, generalised). Applied by enableMemoryVectorIndex() only
-- when the vector extension is already installed; without it every recall degrades to exact + lexical.
DO $agent_vector_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') THEN
    RAISE EXCEPTION 'agent_memory_vector_extension_required';
  END IF;
END
$agent_vector_check$;

CREATE TABLE agent_memory_embeddings (
  memory_id UUID NOT NULL REFERENCES agent_memory_entries(memory_id) ON DELETE CASCADE,
  namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 128),
  scope_kind TEXT NOT NULL CHECK (scope_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
  source_revision BIGINT NOT NULL CHECK (source_revision > 0),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 96),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  normalization TEXT NOT NULL CHECK (normalization='l2_unit'),
  index_version INTEGER NOT NULL CHECK (index_version > 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  embedding vector NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id,provider_id,model_id,index_version),
  CHECK (vector_dims(embedding)=dimensions)
);

-- Scope-first B-tree for exact filtered cosine scans. No global HNSW/ANN index is created: an
-- approximate index would need a separate filter-recall study.
CREATE INDEX idx_agent_memory_embeddings_scope
  ON agent_memory_embeddings(
    namespace,scope_kind,scope_key,provider_id,model_id,dimensions,index_version,memory_id
  );
