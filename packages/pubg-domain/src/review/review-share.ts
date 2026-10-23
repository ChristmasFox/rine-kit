import { createHash, randomBytes } from 'node:crypto';

/** How long a shared review link opens without a login. */
export const REVIEW_SHARE_TTL_MS = 7 * 24 * 60 * 60_000;
/** 128 random bits, base64url: 22 characters. */
export const REVIEW_SHARE_TOKEN = /^[A-Za-z0-9_-]{22}$/u;

/** A delivered session review, a one-match review, or a query result (今日战绩 and other answers). */
export type ReviewShareKind = 'session' | 'match' | 'query';

/**
 * One shared review: the matches it may show and the review exactly as it was sent. Only the token's SHA-256 is
 * stored, so a copy of the database (the Intelligence Lab snapshot) cannot be turned back into a working link.
 */
export interface ReviewShareRecord {
  tokenHash: string;
  kind: ReviewShareKind;
  squadId: string;
  sessionKey: string;
  matchIds: string[];
  presentationJson: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface ReviewShareStore {
  putReviewShare(record: ReviewShareRecord): void;
  getReviewShare(tokenHash: string): ReviewShareRecord | null;
  latestReviewShare(squadId: string, sessionKey: string): ReviewShareRecord | null;
  revokeReviewShares(squadId: string, sessionKey: string, revokedAt: string): number;
}

export function newReviewShareToken(): string {
  return randomBytes(16).toString('base64url');
}

export function reviewShareTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether a stored share may be opened now. */
export function reviewShareOpen(record: ReviewShareRecord, now: Date): boolean {
  return record.revokedAt === null && Date.parse(record.expiresAt) > now.getTime();
}

/**
 * Issues a fresh link for a review. Earlier links of the same session are revoked first, so only the link in the
 * message that was actually delivered keeps working.
 */
export function issueReviewShare(
  store: ReviewShareStore,
  input: {
    squadId: string;
    sessionKey: string;
    matchIds: readonly string[];
    presentationJson: string;
    now: Date;
    ttlMs?: number;
    /** Defaults to a session or one-match review by the number of matches. */
    kind?: ReviewShareKind;
  },
): { token: string; record: ReviewShareRecord } {
  store.revokeReviewShares(input.squadId, input.sessionKey, input.now.toISOString());
  const token = newReviewShareToken();
  const record: ReviewShareRecord = {
    tokenHash: reviewShareTokenHash(token),
    kind: input.kind ?? (input.matchIds.length === 1 ? 'match' : 'session'),
    squadId: input.squadId,
    sessionKey: input.sessionKey,
    matchIds: [...input.matchIds],
    presentationJson: input.presentationJson,
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + (input.ttlMs ?? REVIEW_SHARE_TTL_MS)).toISOString(),
    revokedAt: null,
  };
  store.putReviewShare(record);
  return { token, record };
}
