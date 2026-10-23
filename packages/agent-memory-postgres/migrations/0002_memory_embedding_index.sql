-- Durable, additive embedding work, daily usage accounting and versioned index generations.
-- Extracted from Gate migrations 0024 and 0029. Does not require pgvector.
CREATE TABLE agent_memory_embedding_jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES agent_memory_entries(memory_id) ON DELETE CASCADE,
  source_revision BIGINT NOT NULL CHECK (source_revision > 0),
  index_version INTEGER NOT NULL DEFAULT 1 CHECK (index_version > 0),
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','retry','done','dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT agent_memory_embedding_jobs_memory_revision_version_key
    UNIQUE (memory_id,source_revision,index_version),
  CHECK ((status='processing') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX idx_agent_memory_embedding_jobs_ready
  ON agent_memory_embedding_jobs(status,next_attempt_at,created_at,job_id)
  WHERE status IN ('pending','retry','processing');

CREATE TABLE agent_memory_embedding_usage_daily (
  namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 128),
  budget_day DATE NOT NULL,
  actual_tokens BIGINT NOT NULL DEFAULT 0 CHECK (actual_tokens >= 0),
  reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  reserved_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace,budget_day)
);

CREATE TABLE agent_memory_index_generation_state (
  namespace TEXT PRIMARY KEY CHECK (length(namespace) BETWEEN 1 AND 128),
  active_provider_id TEXT NOT NULL CHECK (length(active_provider_id) BETWEEN 1 AND 96),
  active_model_id TEXT NOT NULL CHECK (length(active_model_id) BETWEEN 1 AND 200),
  active_dimensions INTEGER NOT NULL CHECK (active_dimensions BETWEEN 1 AND 16000),
  active_index_version INTEGER NOT NULL CHECK (active_index_version > 0),
  latest_index_version INTEGER NOT NULL DEFAULT 1 CHECK (latest_index_version > 0),
  building_provider_id TEXT CHECK (building_provider_id IS NULL OR length(building_provider_id) BETWEEN 1 AND 96),
  building_model_id TEXT CHECK (building_model_id IS NULL OR length(building_model_id) BETWEEN 1 AND 200),
  building_dimensions INTEGER CHECK (building_dimensions IS NULL OR building_dimensions BETWEEN 1 AND 16000),
  building_index_version INTEGER CHECK (building_index_version IS NULL OR building_index_version > 0),
  reindex_status TEXT NOT NULL DEFAULT 'idle' CHECK (reindex_status IN ('idle','building','paused','failed')),
  scan_cursor_memory_id UUID,
  scan_complete BOOLEAN NOT NULL DEFAULT FALSE,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((building_index_version IS NULL) = (building_provider_id IS NULL)),
  CHECK ((building_index_version IS NULL) = (building_model_id IS NULL)),
  CHECK ((building_index_version IS NULL) = (building_dimensions IS NULL)),
  CHECK (active_index_version<=latest_index_version),
  CHECK ((reindex_status='idle') = (building_index_version IS NULL))
);
CREATE INDEX idx_agent_memory_index_rebuild_scan
  ON agent_memory_entries(namespace,memory_id) WHERE revoked_at IS NULL;

-- Mutations enqueue the active index and any in-progress shadow index. If the per-namespace state has
-- not yet been bootstrapped, the legacy generation is v1.
CREATE FUNCTION agent_memory_index_job_versions(target_namespace TEXT)
RETURNS TABLE(index_version INTEGER)
LANGUAGE SQL STABLE
AS $agent_memory_index_job_versions$
  SELECT COALESCE(state.active_index_version, 1) AS index_version
  FROM (SELECT 1) seed
  LEFT JOIN agent_memory_index_generation_state state ON state.namespace=target_namespace
  UNION
  SELECT state.building_index_version
  FROM agent_memory_index_generation_state state
  WHERE state.namespace=target_namespace AND state.building_index_version IS NOT NULL
$agent_memory_index_job_versions$;
