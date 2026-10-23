-- Agent memory in PostgreSQL. Extracted from Gate's gate_memory_* migrations 0021, 0026, 0027, 0030 and
-- generalised: the KOOK scope tuple (bot/dm|channel/actor/channel/tenant/team/binding revision) becomes
-- an opaque host-authorised scope (namespace, scope_kind, scope_key). Built-in PostgreSQL types only.
CREATE TABLE agent_memory_entries (
  memory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 128),
  scope_kind TEXT NOT NULL CHECK (scope_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
  memory_key TEXT NOT NULL CHECK (length(memory_key) BETWEEN 1 AND 96),
  content TEXT NOT NULL CHECK (length(content) <= 800),
  source_event_id TEXT NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source_kind TEXT NOT NULL DEFAULT 'trusted_ingress'
    CHECK (source_kind IN ('trusted_ingress','user_confirmed','system_verified','unknown')),
  source_reliability SMALLINT NOT NULL DEFAULT 80 CHECK (source_reliability BETWEEN 0 AND 100),
  valid_until TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_memory_revoked_blank CHECK (revoked_at IS NULL OR content=''),
  UNIQUE (namespace,scope_kind,scope_key,memory_key)
);
CREATE INDEX idx_agent_memory_scope_recent
  ON agent_memory_entries(namespace,scope_kind,scope_key,updated_at DESC,memory_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_agent_memory_active_scope
  ON agent_memory_entries(namespace,scope_kind,scope_key,memory_key,updated_at DESC,memory_id)
  WHERE revoked_at IS NULL AND superseded_at IS NULL AND source_kind <> 'unknown';

-- Mutation idempotency without retaining candidate text or credentials.
CREATE TABLE agent_memory_write_receipts (
  idempotency_key CHAR(64) PRIMARY KEY CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 128),
  scope_kind TEXT NOT NULL CHECK (scope_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
  source_event_id TEXT NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 256),
  intent TEXT NOT NULL CHECK (intent IN ('remember','correct','forget')),
  memory_key TEXT NOT NULL CHECK (length(memory_key) BETWEEN 1 AND 96),
  outcome TEXT NOT NULL CHECK (outcome IN ('created','revised','forgotten','already_present','not_found')),
  memory_revision BIGINT CHECK (memory_revision IS NULL OR memory_revision>=1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (namespace,scope_kind,scope_key,source_event_id)
);
CREATE INDEX idx_agent_memory_write_receipts_scope_recent
  ON agent_memory_write_receipts(namespace,scope_kind,scope_key,created_at DESC);

-- Content-free recall/use evidence for Dreaming promotion decisions.
-- Query text is never stored; fingerprints and event identifiers expire after 90 days.
CREATE TABLE agent_memory_usage_signals (
  signal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 128),
  scope_kind TEXT NOT NULL CHECK (scope_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
  memory_key TEXT NOT NULL CHECK (length(memory_key) BETWEEN 1 AND 96),
  memory_revision BIGINT NOT NULL CHECK (memory_revision >= 1),
  memory_source_event_id TEXT NOT NULL CHECK (length(memory_source_event_id) BETWEEN 1 AND 256),
  request_event_id TEXT NOT NULL CHECK (length(request_event_id) BETWEEN 1 AND 256),
  query_fingerprint CHAR(64) NOT NULL CHECK (query_fingerprint ~ '^[a-f0-9]{64}$'),
  signal_kind TEXT NOT NULL CHECK (signal_kind IN ('recalled','used')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '90 days'),
  UNIQUE (namespace,scope_kind,scope_key,request_event_id,memory_key,memory_revision,signal_kind)
);
CREATE INDEX idx_agent_memory_usage_evidence
  ON agent_memory_usage_signals(namespace,scope_kind,scope_key,memory_key,memory_revision,signal_kind,created_at DESC);
CREATE INDEX idx_agent_memory_usage_expiry ON agent_memory_usage_signals(expires_at);
