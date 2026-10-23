-- Who is who in a team: a member (actor) declares which PUBG account is theirs. The roster of a
-- team is the set of its claimed accounts. New in this package (Gate keeps claims per KOOK bot/user).
CREATE TABLE IF NOT EXISTS pubg_account_claims (
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  pubg_shard TEXT NOT NULL,
  pubg_account_id TEXT NOT NULL CHECK (pubg_account_id ~ '^account\.[A-Za-z0-9_-]{1,128}$'),
  claim_status TEXT NOT NULL DEFAULT 'self_declared' CHECK (claim_status IN ('self_declared', 'verified')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id, actor_id),
  UNIQUE (tenant_id, team_id, pubg_account_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES pubg_teams(tenant_id, team_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pubg_account_claims_actor ON pubg_account_claims(tenant_id, actor_id);
