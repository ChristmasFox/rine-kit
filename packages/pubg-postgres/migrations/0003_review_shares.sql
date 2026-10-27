-- Share pages (no login) for a query answer: the matches it may show and the answer exactly as it was sent. Only the
-- SHA-256 of the token is stored, so a copy of this table cannot be turned back into a working link.
-- Same record as pubg-domain's ReviewShareRecord (Lab keeps it in SQLite `review_shares`); team_id is the squad.
CREATE TABLE IF NOT EXISTS pubg_review_shares (
  tenant_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'match', 'query')),
  team_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  match_ids_json TEXT NOT NULL,
  presentation_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, token_hash)
);
CREATE INDEX IF NOT EXISTS idx_pubg_review_shares_session ON pubg_review_shares(tenant_id, team_id, session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_pubg_review_shares_token ON pubg_review_shares(token_hash);
