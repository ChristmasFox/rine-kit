import type { NormalizedMatch, ReviewShareRecord } from '@rine-kit/pubg-domain';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  analysisCacheVersion,
  clientBuilt,
  createShareHandler,
  SHARE_COOKIE,
  StoryContext,
  type ShareHandler,
  type ShareRequest,
  type ShareStore,
} from '../src/server/index.js';
import { squadIds, telemetry } from './telemetry-fixture.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBB';
const FORGED = 'CCCCCCCCCCCCCCCCCCCCCC';

const player = (id: string, rank: number) => ({
  accountId: id,
  playerName: id.toUpperCase(),
  displayName: id.toUpperCase(),
  rank,
  kills: 1,
  assists: 0,
  damage: 150,
  dbnos: 1,
  revives: 0,
  headshotKills: 0,
  survivalTime: 1200,
  longestKill: 40,
  deaths: 1,
  deathSemantics: 'placement_proxy',
});
const matchAt = (matchId: string, hour: number) =>
  ({
    schemaVersion: 3,
    shard: 'steam',
    matchType: 'competitive',
    gameMode: 'squad',
    isCompetitive: true,
    mapName: 'Baltic_Main',
    duration: 1500,
    patchVersion: 'test',
    matchId,
    createdAt: new Date(Date.UTC(2026, 9, 18, hour)).toISOString(),
    timestamp: Date.UTC(2026, 9, 18, hour),
    players: squadIds.map((id) => player(id, 5)),
  }) as unknown as NormalizedMatch;

// The store holds more than any one link may see: a match no link lists.
const stored = [matchAt('with-telemetry', 12), matchAt('without-telemetry', 13), matchAt('unlisted', 14)];
const shares = new Map<string, ReviewShareRecord>();
const share = (over: Partial<ReviewShareRecord> = {}): ReviewShareRecord => ({
  tokenHash: hash(TOKEN),
  kind: 'query',
  squadId: 'room-1',
  sessionKey: 'pubg-query:1',
  presentationJson: JSON.stringify({
    type: 'pubg_query_share',
    title: '📊 今日战绩',
    displayText: '📊 今日战绩\n场次 2',
    matchCount: 2,
  }),
  matchIds: ['with-telemetry', 'without-telemetry'],
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  revokedAt: null,
  ...over,
});
const lookups: string[] = [];
const store: ShareStore = {
  findShare: async (tokenHash) => {
    lookups.push(tokenHash);
    return shares.get(tokenHash) ?? null;
  },
  // Like a database-backed host: only the matches the share lists.
  loadContent: async (record) => ({
    squad: {
      id: record.squadId,
      label: 'Squad',
      members: squadIds.map((id) => ({ id, name: id.toUpperCase() })),
    },
    matches: stored.filter((match) => record.matchIds.includes(match.matchId)),
  }),
};

let root: string;
let story: StoryContext;
let handler: ShareHandler;
let limited = false;

const get = async (path: string, cookie?: string): Promise<{ status: number; headers: Record<string, string>; text: string }> => {
  const request: ShareRequest = { path, cookie, remote: '203.0.113.9' };
  const res = await handler(request);
  assert.ok(res, `${path} is a share route`);
  return { status: res.status, headers: res.headers, text: res.body.toString() };
};
const asVisitor = (token: string) => `${SHARE_COOKIE}=${token}`;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pubg-share-page-'));
  story = new StoryContext(join(root, 'archive'), join(root, 'state'), analysisCacheVersion(), 1, [
    '--import',
    'tsx',
  ]);
  await story.archive.write(
    'with-telemetry',
    Buffer.from(JSON.stringify(telemetry(stored[0]!.createdAt!))),
  );
  mkdirSync(join(root, 'maps'));
  writeFileSync(join(root, 'maps', 'Baltic_Main.jpg'), 'jpeg-bytes');
  handler = createShareHandler({
    store,
    story,
    mapDirectory: join(root, 'maps'),
    allow: () => !limited,
  });
});
after(async () => {
  await story.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the page behind a link', { skip: !clientBuilt() && 'run `pnpm build` first' }, () => {
  it('opens a link with the tactical page, a share-only cookie and the view inline', async () => {
    shares.set(hash(TOKEN), share());
    const res = await get(`/s/${TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type']!, /text\/html/u);
    assert.ok(res.text.includes('<title>📊 今日战绩 · 2 场</title>'));
    assert.equal(res.headers['x-robots-tag'], 'noindex');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(
      res.headers['set-cookie']!,
      new RegExp(`^${SHARE_COOKIE}=${TOKEN}; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Strict$`, 'u'),
    );
    const inline = res.text.match(/<script>window\.__SHARE_VIEW__=(.+?)<\/script>/u)?.[1];
    assert.ok(inline);
    const payload = JSON.parse(inline) as { kind: string; matches: Array<Record<string, unknown>> };
    assert.equal(payload.kind, 'query');
    assert.deepEqual(
      payload.matches.map((m) => [m.matchId, m.available, m.placement]),
      [
        ['with-telemetry', true, 5],
        ['without-telemetry', true, 5],
      ],
    );
    const api = await get('/api/share/view', asVisitor(TOKEN));
    assert.deepEqual(JSON.parse(api.text), payload);
    const script = res.text.match(/src="(\/assets\/[^"]+\.js)"/u)?.[1];
    assert.ok(script);
    const asset = await get(script);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  it('adds Secure to the cookie over https, and /share reopens the page from the cookie', async () => {
    shares.set(hash(TOKEN), share());
    const first = await handler({ path: `/s/${TOKEN}`, https: true });
    assert.match(first!.headers['set-cookie']!, /; Secure$/u);
    const again = await get('/share', asVisitor(TOKEN));
    assert.equal(again.status, 200);
    assert.ok(again.text.includes('window.__SHARE_VIEW__='));
  });

  it('serves the story of a match with telemetry, the opposing teams made anonymous', async () => {
    shares.set(hash(TOKEN), share());
    const res = await get('/api/share/matches/with-telemetry/story', asVisitor(TOKEN));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text) as {
      available: boolean;
      story: {
        downs: Array<{ attackerTeam: string | null }>;
        fights: Array<{ enemies: Array<{ team: string }> }>;
        enemies: Array<{ id: string; team: string }>;
      };
    };
    assert.equal(body.available, true, (JSON.parse(res.text) as { reason: string }).reason);
    const teams = [
      ...body.story.downs.map((d) => d.attackerTeam),
      ...body.story.fights.flatMap((f) => f.enemies.map((e) => e.team)),
      ...body.story.enemies.map((e) => e.team),
    ].filter((team): team is string => team !== null);
    assert.ok(teams.length > 0);
    assert.ok(teams.every((team) => /^敌方 [A-Z]/u.test(team)));
    assert.ok(body.story.enemies.every((e) => e.id.startsWith('enemy-')));
    assert.doesNotMatch(res.text, /"e[12]"|account\./u);
  });

  it('says the match has no archived telemetry instead of failing', async () => {
    shares.set(hash(TOKEN), share());
    const res = await get('/api/share/matches/without-telemetry/story', asVisitor(TOKEN));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text) as { available: boolean; reason: string };
    assert.deepEqual([body.available, body.reason], [false, 'no_archive']);
  });

  it('serves map artwork to a link holder, and never reads a map name as a path', async () => {
    shares.set(hash(TOKEN), share());
    const map = await get('/api/maps/Baltic_Main', asVisitor(TOKEN));
    assert.equal(map.status, 200);
    assert.equal(map.headers['content-type'], 'image/jpeg');
    assert.equal((await get('/api/maps/Erangel_Main', asVisitor(TOKEN))).status, 404);
    assert.equal((await get('/api/maps/..%2F..%2Fetc%2Fpasswd', asVisitor(TOKEN))).status, 404);
    assert.equal((await get('/assets/..%2Findex.html')).status, 404);
    assert.equal((await get('/assets/../index.html')).status, 404);
  });
});

describe('who gets in', () => {
  const DATA_ROUTES = [
    '/api/share/view',
    '/api/share/matches/with-telemetry/story',
    '/api/maps/Baltic_Main',
  ];

  it('refuses every data route without a token, and the page itself', async () => {
    shares.set(hash(TOKEN), share());
    for (const path of DATA_ROUTES) {
      const res = await get(path);
      assert.equal(res.status, 401, path);
      assert.doesNotMatch(res.text, /with-telemetry|Baltic|P1/u, path);
    }
    assert.equal((await get('/share')).status, 404);
    assert.equal((await get('/s/')).status, 404);
    // a cookie with another name is no token either
    assert.equal((await get('/api/share/view', `other=${TOKEN}`)).status, 401);
  });

  it('refuses a forged or malformed token on every route, and looks nothing up for a malformed one', async () => {
    shares.set(hash(TOKEN), share());
    lookups.length = 0;
    for (const bad of ['short', `${TOKEN}x`, '../../etc/passwd', ' '.repeat(22), '"; DROP TABLE--------']) {
      assert.equal((await get(`/s/${encodeURIComponent(bad)}`)).status, 404, bad);
      assert.equal((await get('/api/share/view', asVisitor(bad))).status, 401, bad);
    }
    assert.deepEqual(lookups, []);
    // well-formed but never issued
    assert.equal((await get(`/s/${FORGED}`)).status, 404);
    for (const path of DATA_ROUTES) {
      assert.equal((await get(path, asVisitor(FORGED))).status, 401, path);
    }
    assert.equal((await get('/share', asVisitor(FORGED))).status, 404);
    // every refusal of the page looks alike
    const unknown = await get(`/s/${FORGED}`);
    shares.set(hash(OTHER), share({ tokenHash: hash(OTHER), revokedAt: new Date().toISOString() }));
    const revoked = await get(`/s/${OTHER}`);
    assert.equal(unknown.text, revoked.text);
  });

  it('refuses a revoked link at once, page and data alike', async () => {
    shares.set(hash(TOKEN), share({ revokedAt: new Date().toISOString() }));
    assert.equal((await get(`/s/${TOKEN}`)).status, 404);
    assert.equal((await get('/share', asVisitor(TOKEN))).status, 404);
    for (const path of DATA_ROUTES) {
      assert.equal((await get(path, asVisitor(TOKEN))).status, 401, path);
    }
  });

  it('refuses an expired link, page and data alike', async () => {
    shares.set(hash(TOKEN), share({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    assert.equal((await get(`/s/${TOKEN}`)).status, 404);
    for (const path of DATA_ROUTES) {
      assert.equal((await get(path, asVisitor(TOKEN))).status, 401, path);
    }
  });

  it('stops a link that was valid a moment ago the moment it is revoked', async () => {
    shares.set(hash(TOKEN), share());
    assert.equal((await get('/api/share/view', asVisitor(TOKEN))).status, 200);
    shares.set(hash(TOKEN), share({ revokedAt: new Date().toISOString() }));
    assert.equal((await get('/api/share/view', asVisitor(TOKEN))).status, 401);
  });

  it("opens only the matches the link lists, and never another link's", async () => {
    shares.set(hash(TOKEN), share({ matchIds: ['with-telemetry'] }));
    const cookie = asVisitor(TOKEN);
    assert.equal((await get('/api/share/matches/without-telemetry/story', cookie)).status, 404);
    assert.equal((await get('/api/share/matches/unlisted/story', cookie)).status, 404);
    assert.equal((await get('/api/share/matches/..%2Fx/story', cookie)).status, 404);
    const view = JSON.parse((await get('/api/share/view', cookie)).text) as {
      matches: Array<{ matchId: string }>;
    };
    assert.deepEqual(view.matches.map((m) => m.matchId), ['with-telemetry']);
    // a token that was never issued opens nothing, even though another link exists
    assert.equal((await get('/api/share/view', asVisitor(OTHER))).status, 401);
  });

  it('answers only GET and only its own paths', async () => {
    shares.set(hash(TOKEN), share());
    assert.equal(await handler({ method: 'POST', path: `/s/${TOKEN}` }), null);
    assert.equal(await handler({ method: 'DELETE', path: '/api/share/view', cookie: asVisitor(TOKEN) }), null);
    for (const path of ['/', '/api/share', '/api/share/matches', '/api/share/everything', '/api/maps', '/admin', '/health']) {
      assert.equal(await handler({ path, cookie: asVisitor(TOKEN) }), null, path);
    }
  });

  it('is rate limited by the host on every route that takes a token', async () => {
    shares.set(hash(TOKEN), share());
    limited = true;
    try {
      assert.equal((await get(`/s/${TOKEN}`)).status, 429);
      assert.equal((await get('/api/share/view', asVisitor(TOKEN))).status, 429);
    } finally {
      limited = false;
    }
  });
});
