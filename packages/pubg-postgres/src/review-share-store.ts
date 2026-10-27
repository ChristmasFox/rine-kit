// NEW in this package: a PostgreSQL home for share pages, so a multi-tenant host can issue them the way Lab does
// from SQLite. pubg-domain's ReviewShareStore is synchronous (issueReviewShare writes and revokes in one call), so
// this store queues the writes and the host awaits `flush()` before it hands the link out.
import type { Pool } from 'pg';
import type { ReviewShareRecord, ReviewShareStore } from '@rine-kit/pubg-domain';

interface Row {
  token_hash: string;
  kind: ReviewShareRecord['kind'];
  team_id: string;
  session_key: string;
  match_ids_json: string;
  presentation_json: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const toRecord = (row: Row): ReviewShareRecord => ({
  tokenHash: row.token_hash,
  kind: row.kind,
  squadId: row.team_id,
  sessionKey: row.session_key,
  matchIds: JSON.parse(row.match_ids_json) as string[],
  presentationJson: row.presentation_json,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
});

/** Share pages of one tenant. Writes are queued by the synchronous ReviewShareStore methods; `flush()` stores them. */
export class PostgresReviewShareStore implements ReviewShareStore {
  private queue: Array<() => Promise<unknown>> = [];

  constructor(
    private readonly pool: Pool,
    private readonly tenantId: string,
  ) {}

  putReviewShare(record: ReviewShareRecord): void {
    this.queue.push(() =>
      this.pool.query(
        `INSERT INTO pubg_review_shares(tenant_id, token_hash, kind, team_id, session_key, match_ids_json, presentation_json, created_at, expires_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, token_hash) DO NOTHING`,
        [
          this.tenantId,
          record.tokenHash,
          record.kind,
          record.squadId,
          record.sessionKey,
          JSON.stringify(record.matchIds),
          record.presentationJson,
          record.createdAt,
          record.expiresAt,
          record.revokedAt,
        ],
      ),
    );
  }

  revokeReviewShares(squadId: string, sessionKey: string, revokedAt: string): number {
    this.queue.push(() =>
      this.pool.query(
        `UPDATE pubg_review_shares SET revoked_at=$4
          WHERE tenant_id=$1 AND team_id=$2 AND session_key=$3 AND revoked_at IS NULL`,
        [this.tenantId, squadId, sessionKey, revokedAt],
      ),
    );
    return 0; // the count is only known after flush(); issueReviewShare ignores it
  }

  // The synchronous readers of the interface are not used when issuing; reading goes through the async methods.
  getReviewShare(): ReviewShareRecord | null {
    return null;
  }

  latestReviewShare(): ReviewShareRecord | null {
    return null;
  }

  /** Stores everything queued so far, in order. Call it before the link is shown to anyone. */
  async flush(): Promise<void> {
    const work = this.queue;
    this.queue = [];
    for (const step of work) await step();
  }

  /** The share behind a token hash (any tenant of this database: the public page only has the token). */
  static async find(pool: Pool, tokenHash: string): Promise<(ReviewShareRecord & { tenantId: string }) | null> {
    const { rows } = await pool.query<Row & { tenant_id: string }>(
      'SELECT * FROM pubg_review_shares WHERE token_hash=$1 LIMIT 1',
      [tokenHash],
    );
    const row = rows[0];
    return row ? { ...toRecord(row), tenantId: row.tenant_id } : null;
  }
}
