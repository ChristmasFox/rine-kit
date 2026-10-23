import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { migratePubgDatabase } from '@rine-kit/pubg-postgres';
import { createConfiguredPublicPubgPlayerResolver, PostgresPublicPubgAdmission, PublicPubgPlayerResolver } from '../src/index.js';
import { DATABASE_URL } from './helpers.js';

function success(data: unknown) { return new Response(JSON.stringify({ data }), { status: 200, headers: { 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '9' } }); }
const databaseUrl = DATABASE_URL;

test('name lookup batches original case, normalizes canonical players, and reports missing/ambiguous names without guessing', async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = []; let permits = 0; let observations = 0;
  const resolver = new PublicPubgPlayerResolver({
apiKey: 'public-fixture-only', admission: { async acquire() { permits++; }, async observe(headers, status) { observations++; assert.equal(status, 200); assert.equal(headers.get('x-ratelimit-limit'), '10'); } }, fetcher: async (url, init) => {
      requests.push({ url: new URL(String(url)), init: init ?? {} });
      return success([
        { type: 'player', id: 'account.synthetic_alice', attributes: { name: 'Alice' } },
        { type: 'player', id: 'account.synthetic_bob1', attributes: { name: 'Bob' } },
        { type: 'player', id: 'account.synthetic_bob2', attributes: { name: 'BOB' } },
        { type: 'player', id: 'account.unrequested', attributes: { name: 'Other' } },
      ]);
    }
});
  const result = await resolver.resolveNames('steam', ['Alice', 'Bob', 'Missing']);
  assert.deepEqual(result, { players: [{ accountId: 'account.synthetic_alice', name: 'Alice' }], missingNames: ['Missing'], ambiguousNames: ['Bob'] });
  const request = requests[0]!;
  assert.equal(request.url.origin, 'https://api.pubg.com'); assert.equal(request.url.pathname, '/shards/steam/players');
  assert.equal(request.url.searchParams.get('filter[playerNames]'), 'Alice,Bob,Missing');
  assert.equal(new Headers(request.init.headers).get('authorization'), 'Bearer public-fixture-only');
  assert.equal(request.init.redirect, 'error'); assert.equal(permits, 1); assert.equal(observations, 1);
  const eightNames = Array.from({ length: 8 }, (_, index) => `Roster${index + 1}`);
  await resolver.resolveNames('steam', eightNames);
  assert.deepEqual(requests[1]?.url.searchParams.get('filter[playerNames]')?.split(','), eightNames,
    'an eight-player roster is resolved in one bounded PUBG API request');
  await assert.rejects(resolver.resolveNames('steam', [...eightNames, 'Roster9']), /names_invalid/u);
  await assert.rejects(resolver.resolveNames('console', ['Alice']), /shard_invalid/u);
  await assert.rejects(resolver.resolveNames('steam', ['Alice', 'alice']), /names_invalid/u);
  await assert.rejects(resolver.resolveNames('steam', ['Alice,Bob']), /names_invalid/u);
  assert.equal(requests.length, 2, 'invalid roster sizes are rejected before making another request');
});

test('name lookup follows the shared Domain client retry defaults after a transient provider error', async () => {
  let permits = 0, observations = 0, calls = 0;
  const resolver = new PublicPubgPlayerResolver({
    apiKey: 'public-fixture-only',
    admission: { async acquire() { permits++; }, async observe() { observations++; } },
    fetcher: async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ errors: [{ detail: 'temporary provider failure' }] }), { status: 503 })
        : success([{ type: 'player', id: 'account.synthetic_alice', attributes: { name: 'Alice' } }]);
    },
  });
  assert.deepEqual(await resolver.resolveNames('steam', ['Alice']), {
    players: [{ accountId: 'account.synthetic_alice', name: 'Alice' }], missingNames: [], ambiguousNames: [],
  });
  assert.equal(calls, 2);
  assert.equal(permits, 2, 'each retry passes through the public shared-key admission limiter');
  assert.equal(observations, 2);
});

test('lookup sanitizes upstream errors and cannot bypass a rejected public admission permit', async () => {
  let calls = 0;
  const resolver = new PublicPubgPlayerResolver({ apiKey: 'must-not-leak', admission: { async acquire() { throw new Error('public_pubg_lookup_rate_limited'); }, async observe() { } }, fetcher: async () => { calls++; return success([]); } });
  await assert.rejects(resolver.resolveNames('steam', ['Alice']), error => error instanceof Error && error.message === 'public_pubg_lookup_rate_limited');
  assert.equal(calls, 0);
  const unavailable = new PublicPubgPlayerResolver({ apiKey: 'must-not-leak', admission: { async acquire() { }, async observe() { } }, fetcher: async () => new Response(JSON.stringify({ errors: [{ detail: 'must-not-leak / private upstream body' }] }), { status: 403 }) });
  await assert.rejects(unavailable.resolveNames('steam', ['Alice']), error => error instanceof Error && error.message === 'public_pubg_lookup_unavailable' && !error.message.includes('must-not-leak'));
});

test('isolated acceptance resolver returns only fixed synthetic PUBG identities and never falls through', async () => {
  const configured = createConfiguredPublicPubgPlayerResolver({
    env: { PUBG_SAAS_ACCEPTANCE_MODE: 'isolated', PUBG_SAAS_SYNTHETIC_PUBG_PLAYERS: '1', NODE_ENV: 'test' },
    admission: { async acquire() { assert.fail('synthetic lookup must not acquire public PUBG admission'); }, async observe() { assert.fail('synthetic lookup must not observe an upstream response'); } },
  });
  assert.equal(configured.synthetic, true);
  assert.deepEqual(await configured.resolver.resolveNames('steam', ['P3SyntheticAlpha', 'unknown-name']), {
    players: [{ accountId: 'account.p3synthetic_alpha', name: 'P3SyntheticAlpha' }],
    missingNames: ['unknown-name'], ambiguousNames: [],
  });
  assert.deepEqual(await configured.resolver.resolveNames('kakao', ['P3SyntheticAlpha']), {
    players: [], missingNames: ['P3SyntheticAlpha'], ambiguousNames: [],
  });
  await assert.rejects(configured.resolver.resolveNames('steam', ['P3SyntheticAlpha', 'p3syntheticalpha']), /names_invalid/u);
});

test('synthetic PUBG identities require explicit isolated acceptance mode and are forbidden in production', () => {
  const admission = { async acquire() { }, async observe() { } };
  assert.throws(() => createConfiguredPublicPubgPlayerResolver({
    env: { PUBG_SAAS_ACCEPTANCE_MODE: 'isolated', PUBG_SAAS_SYNTHETIC_PUBG_PLAYERS: '1', NODE_ENV: 'production' },
    admission,
  }), /synthetic_resolver_forbidden/u);
  assert.throws(() => createConfiguredPublicPubgPlayerResolver({
    env: { PUBG_SAAS_SYNTHETIC_PUBG_PLAYERS: '1', NODE_ENV: 'test' }, admission,
  }), /synthetic_resolver_forbidden/u);
  assert.throws(() => createConfiguredPublicPubgPlayerResolver({ env: { NODE_ENV: 'test' }, admission }), /public_pubg_api_key_missing/u);
});

test('explicit command arguments preserve player/label case and quoted spaces', () => {
});

test('public API admission is shared across connections and respects provider exhaustion/reset headers', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  try {
    await migratePubgDatabase(pool);
    await pool.query("DELETE FROM pubg_api_admission WHERE quota_scope='public-pubg'");
    const first = new PostgresPublicPubgAdmission(pool, 10, 0), second = new PostgresPublicPubgAdmission(pool, 10, 0);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second).tryAcquire()));
    assert.equal(results.filter(wait => wait === 0).length, 1);
    assert.ok(results.filter(wait => wait > 0).every(wait => wait > 5000));
    await first.observe(new Headers({'x-ratelimit-limit':'2','x-ratelimit-remaining':'1'}),200);
    assert.ok(await second.tryAcquire()>29_000);
    await first.observe(new Headers({ 'x-ratelimit-limit': '2', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) }), 429);
    assert.ok(await second.tryAcquire() > 50_000);
    await assert.rejects(second.acquire(), /public_pubg_lookup_rate_limited/u);
    await pool.query("UPDATE pubg_api_admission SET blocked_until=NULL,next_request_at=now()-interval '1 second' WHERE quota_scope='public-pubg'");
    assert.equal(await second.tryAcquire(), 0);
    assert.ok(await first.tryAcquire() > 29_000); // provider limit 2 conservatively clamps configured 10
  } finally { await pool.query("DELETE FROM pubg_api_admission WHERE quota_scope='public-pubg'"); await pool.end(); }
});
