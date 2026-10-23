import assert from 'node:assert/strict';
import test from 'node:test';
import {
  issueReviewShare,
  REVIEW_SHARE_TOKEN,
  REVIEW_SHARE_TTL_MS,
  reviewShareOpen,
  reviewShareTokenHash,
  SqlitePubgRepository,
} from '../src/index.js';

const NOW = new Date('2026-10-19T04:00:00.000Z');

test('a share stores only the token hash, its matches and the review, and expires after seven days', () => {
  const repository = new SqlitePubgRepository(':memory:');
  const { token, record } = issueReviewShare(repository, {
    squadId: 'squad',
    sessionKey: 'pubg-session:squad:m1',
    matchIds: ['m1', 'm2'],
    presentationJson: '{"type":"pubg_session_review"}',
    now: NOW,
  });
  assert.match(token, REVIEW_SHARE_TOKEN);
  assert.equal(record.tokenHash, reviewShareTokenHash(token));
  assert.notEqual(record.tokenHash, token);
  assert.equal(record.kind, 'session');
  assert.equal(Date.parse(record.expiresAt) - NOW.getTime(), REVIEW_SHARE_TTL_MS);
  const stored = repository.getReviewShare(reviewShareTokenHash(token));
  assert.deepEqual(stored, record);
  assert.equal(reviewShareOpen(stored!, NOW), true);
  assert.equal(reviewShareOpen(stored!, new Date(NOW.getTime() + REVIEW_SHARE_TTL_MS)), false);
  assert.equal(JSON.stringify(repository.listReviewShares()).includes(token), false);
  repository.close();
});

test('issuing again revokes the earlier link of the same session only', () => {
  const repository = new SqlitePubgRepository(':memory:');
  const first = issueReviewShare(repository, {
    squadId: 'squad',
    sessionKey: 's1',
    matchIds: ['m1'],
    presentationJson: '{}',
    now: NOW,
  });
  const other = issueReviewShare(repository, {
    squadId: 'squad',
    sessionKey: 's2',
    matchIds: ['m9'],
    presentationJson: '{}',
    now: NOW,
  });
  const second = issueReviewShare(repository, {
    squadId: 'squad',
    sessionKey: 's1',
    matchIds: ['m1'],
    presentationJson: '{}',
    now: new Date(NOW.getTime() + 1000),
  });
  assert.equal(first.record.kind, 'match');
  assert.equal(reviewShareOpen(repository.getReviewShare(first.record.tokenHash)!, NOW), false);
  assert.equal(reviewShareOpen(repository.getReviewShare(second.record.tokenHash)!, NOW), true);
  assert.equal(reviewShareOpen(repository.getReviewShare(other.record.tokenHash)!, NOW), true);
  assert.equal(repository.latestReviewShare('squad', 's1')?.tokenHash, second.record.tokenHash);
  repository.close();
});

test('a query result can be shared as its own kind', () => {
  const repository = new SqlitePubgRepository(':memory:');
  const { token } = issueReviewShare(repository, {
    squadId: 'squad',
    sessionKey: 'pubg-query:1',
    matchIds: ['m1'],
    presentationJson: '{}',
    now: NOW,
    kind: 'query',
  });
  assert.equal(repository.getReviewShare(reviewShareTokenHash(token))?.kind, 'query');
  repository.close();
});
