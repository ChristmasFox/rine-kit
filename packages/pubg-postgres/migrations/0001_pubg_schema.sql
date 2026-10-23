-- PUBG team data, extracted from Gate's public schema (migrations 0001, 0005-0009, 0013-0014, 0020).
-- Differences from Gate: every table is prefixed pubg_; tenancy is an opaque host-supplied tenant_id (no
-- platform/bot/guild tuple, no KOOK tables); a conversation is (actor_id, channel_id, session_id).
-- The legacy non-team telemetry tables are not carried over.

CREATE TABLE IF NOT EXISTS pubg_tenants (
  tenant_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pubg_teams (
  tenant_id TEXT NOT NULL REFERENCES pubg_tenants(tenant_id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  label TEXT NOT NULL,
  pubg_shard TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  query_revision BIGINT NOT NULL DEFAULT 0 CHECK (query_revision >= 0),
  PRIMARY KEY (tenant_id, team_id)
);

CREATE TABLE IF NOT EXISTS pubg_team_members (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  pubg_account_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id, pubg_account_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES pubg_teams(tenant_id, team_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pubg_team_members_account ON pubg_team_members(pubg_account_id, tenant_id, team_id);

CREATE TABLE IF NOT EXISTS pubg_team_aliases (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  alias_key TEXT NOT NULL,
  pubg_account_id TEXT NOT NULL,
  display_alias TEXT NOT NULL,
  PRIMARY KEY (tenant_id, team_id, alias_key),
  FOREIGN KEY (tenant_id, team_id, pubg_account_id)
    REFERENCES pubg_team_members(tenant_id, team_id, pubg_account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pubg_team_preferences (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  preference_key TEXT NOT NULL,
  preference_json JSONB NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id, preference_key),
  FOREIGN KEY (tenant_id, team_id) REFERENCES pubg_teams(tenant_id, team_id) ON DELETE CASCADE
);

-- PUBG account display names learnt from the provider (shared by all tenants).
CREATE TABLE IF NOT EXISTS pubg_account_names (
  shard TEXT NOT NULL CHECK (shard IN ('steam', 'kakao', 'psn', 'xbox')),
  account_id TEXT NOT NULL CHECK (account_id ~ '^account\.[A-Za-z0-9_-]{1,128}$'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  last_resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shard, account_id)
);

-- Matches are provider facts, shared across tenants; a team sees a match only through its members.
CREATE TABLE IF NOT EXISTS pubg_matches (
  match_id TEXT NOT NULL,
  shard TEXT NOT NULL,
  created_at TEXT,
  timestamp_ms BIGINT NOT NULL,
  match_type TEXT NOT NULL,
  game_mode TEXT NOT NULL,
  is_competitive BOOLEAN NOT NULL,
  map_name TEXT NOT NULL,
  duration DOUBLE PRECISION NOT NULL,
  patch_version TEXT NOT NULL,
  telemetry_url TEXT,
  schema_version INTEGER NOT NULL,
  parser_version TEXT,
  fetched_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  checked_player_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_json JSONB,
  PRIMARY KEY (shard, match_id)
);
CREATE INDEX IF NOT EXISTS idx_pubg_matches_mode_map ON pubg_matches(game_mode, map_name);
CREATE INDEX IF NOT EXISTS idx_pubg_matches_shard_time ON pubg_matches(shard, timestamp_ms, match_id);
CREATE INDEX IF NOT EXISTS idx_pubg_matches_timestamp ON pubg_matches(timestamp_ms, match_id);

CREATE TABLE IF NOT EXISTS pubg_match_players (
  match_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  rank DOUBLE PRECISION,
  kills DOUBLE PRECISION NOT NULL,
  assists DOUBLE PRECISION NOT NULL,
  damage DOUBLE PRECISION NOT NULL,
  dbnos DOUBLE PRECISION NOT NULL,
  revives DOUBLE PRECISION NOT NULL,
  headshot_kills DOUBLE PRECISION NOT NULL,
  survival_time DOUBLE PRECISION NOT NULL,
  longest_kill DOUBLE PRECISION NOT NULL,
  deaths DOUBLE PRECISION,
  death_semantics TEXT NOT NULL,
  shard TEXT NOT NULL,
  PRIMARY KEY (shard, match_id, account_id),
  FOREIGN KEY (shard, match_id) REFERENCES pubg_matches(shard, match_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pubg_match_players_account_match ON pubg_match_players(account_id, match_id);
CREATE INDEX IF NOT EXISTS idx_pubg_match_players_shard_account ON pubg_match_players(shard, account_id, match_id);

CREATE TABLE IF NOT EXISTS pubg_sync_state (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  state_key TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL,
  state_json JSONB NOT NULL,
  PRIMARY KEY (tenant_id, team_id, state_key)
);

CREATE TABLE IF NOT EXISTS pubg_telemetry_team_features (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  team_config_hash TEXT NOT NULL,
  shard TEXT NOT NULL,
  match_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  facts_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, team_config_hash, shard, match_id, parser_version, feature_version),
  FOREIGN KEY (shard, match_id) REFERENCES pubg_matches(shard, match_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, team_id) REFERENCES pubg_teams(tenant_id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pubg_telemetry_team_prefetch_attempts (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  team_config_hash TEXT NOT NULL,
  shard TEXT NOT NULL,
  match_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'FETCHED', 'HIT', 'UNAVAILABLE')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, team_id, team_config_hash, shard, match_id, parser_version, feature_version),
  FOREIGN KEY (shard, match_id) REFERENCES pubg_matches(shard, match_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, team_id) REFERENCES pubg_teams(tenant_id, team_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pubg_telemetry_team_attempts_due ON pubg_telemetry_team_prefetch_attempts(
  tenant_id, team_id, team_config_hash, parser_version, feature_version, status, next_retry_at);

CREATE TABLE IF NOT EXISTS pubg_telemetry_prefetch_runs (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  trigger TEXT NOT NULL,
  discovered_match_count INTEGER NOT NULL,
  new_match_count INTEGER NOT NULL,
  candidate_match_count INTEGER NOT NULL,
  fetched_count INTEGER NOT NULL,
  cache_hit_count INTEGER NOT NULL,
  unavailable_count INTEGER NOT NULL,
  pending_count INTEGER NOT NULL,
  failed_match_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (tenant_id, team_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_pubg_telemetry_prefetch_runs_date
  ON pubg_telemetry_prefetch_runs(tenant_id, team_id, report_date, started_at);

-- Conversation-scoped state: who asked (actor_id), where (channel_id) and in which session. The host
-- decides what an actor and a channel are (for RINE: the user and the room).
CREATE TABLE IF NOT EXISTS pubg_result_sets (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  result_set_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  result_json JSONB NOT NULL,
  PRIMARY KEY (tenant_id, team_id, actor_id, channel_id, session_id, result_set_id)
);
CREATE INDEX IF NOT EXISTS idx_pubg_result_sets_expiry ON pubg_result_sets(tenant_id, team_id, expires_at);

CREATE TABLE IF NOT EXISTS pubg_session_contexts (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  context_json JSONB NOT NULL,
  PRIMARY KEY (tenant_id, team_id, actor_id, channel_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_pubg_session_contexts_expiry ON pubg_session_contexts(tenant_id, team_id, expires_at);

CREATE TABLE IF NOT EXISTS pubg_usage_records (
  usage_id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  provider TEXT,
  model_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_pubg_usage_records_tenant_date ON pubg_usage_records(tenant_id, recorded_at);

-- Durable, team-scoped scheduling for the sync worker (see sync-queue.ts).
CREATE TABLE IF NOT EXISTS pubg_sync_jobs (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  FOREIGN KEY (tenant_id, team_id) REFERENCES pubg_teams(tenant_id, team_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pubg_sync_jobs_due ON pubg_sync_jobs(next_attempt_at, tenant_id, team_id);

-- Admission control for the provider API key: one row per quota scope, shared by every process that
-- talks to PUBG with that key (see the sync package). Identical to Gate's pubg_api_admission.
CREATE TABLE IF NOT EXISTS pubg_api_admission (
  quota_scope TEXT PRIMARY KEY,
  next_request_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reserved_at TIMESTAMPTZ,
  blocked_until TIMESTAMPTZ,
  observed_limit INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A change to a team's metadata, roster or aliases advances its query_revision, so a conversation
-- authorised against an older revision can be told apart from one authorised against the current team.
CREATE OR REPLACE FUNCTION pubg_advance_team_metadata_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.label,NEW.pubg_shard) IS DISTINCT FROM (OLD.label,OLD.pubg_shard) THEN
    NEW.query_revision:=OLD.query_revision+1;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pubg_advance_team_query_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    UPDATE pubg_teams SET query_revision=query_revision+1
      WHERE tenant_id=OLD.tenant_id AND team_id=OLD.team_id;
  END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (NEW.tenant_id,NEW.team_id) IS DISTINCT FROM (OLD.tenant_id,OLD.team_id)) THEN
    UPDATE pubg_teams SET query_revision=query_revision+1
      WHERE tenant_id=NEW.tenant_id AND team_id=NEW.team_id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS pubg_team_metadata_query_revision ON pubg_teams;
CREATE TRIGGER pubg_team_metadata_query_revision BEFORE UPDATE OF label, pubg_shard ON pubg_teams
  FOR EACH ROW EXECUTE FUNCTION pubg_advance_team_metadata_revision();
DROP TRIGGER IF EXISTS pubg_team_members_query_revision ON pubg_team_members;
CREATE TRIGGER pubg_team_members_query_revision AFTER INSERT OR DELETE OR UPDATE ON pubg_team_members
  FOR EACH ROW EXECUTE FUNCTION pubg_advance_team_query_revision();
DROP TRIGGER IF EXISTS pubg_team_aliases_query_revision ON pubg_team_aliases;
CREATE TRIGGER pubg_team_aliases_query_revision AFTER INSERT OR DELETE OR UPDATE ON pubg_team_aliases
  FOR EACH ROW EXECUTE FUNCTION pubg_advance_team_query_revision();
