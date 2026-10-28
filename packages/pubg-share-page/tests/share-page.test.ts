import type { NormalizedMatch, ReviewShareRecord } from '@rine-kit/pubg-domain';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSharePage } from '../src/server/render.js';
import { aliasEnemies, shareTitle, shareViewPayload } from '../src/server/share-page.js';

const squad = {
  id: 'room-1',
  label: 'Squad',
  memberIds: ['p1', 'p2'],
  members: [
    { id: 'p1', name: 'P1' },
    { id: 'p2', name: 'P2' },
  ],
  matchCount: 1,
};
const player = (accountId: string, kills: number, damage: number) => ({
  accountId,
  playerName: accountId,
  displayName: accountId,
  rank: 4,
  kills,
  assists: 0,
  damage,
  dbnos: kills,
});
const match = {
  matchId: 'm1',
  mapName: 'Baltic_Main',
  duration: 1500,
  createdAt: '2026-10-18T12:00:00.000Z',
  players: [player('p1', 2, 210.4), player('p2', 1, 100)],
} as unknown as NormalizedMatch;
const share = (over: Partial<ReviewShareRecord> = {}): ReviewShareRecord => ({
  tokenHash: 'h',
  kind: 'query',
  squadId: 'room-1',
  sessionKey: 'k',
  matchIds: ['m1', 'gone'],
  presentationJson: JSON.stringify({ title: '📊 今日战绩', displayText: '📊 今日战绩\n场次 1' }),
  createdAt: '2026-10-18T12:00:00.000Z',
  expiresAt: '2026-10-25T12:00:00.000Z',
  revokedAt: null,
  ...over,
});

describe('opposing teams', () => {
  it('become 敌方 A, B in the order they were met, and their account ids are dropped', () => {
    const aliased = aliasEnemies({
      fights: [
        { start: 300, enemies: [{ team: '7' }] },
        { start: 100, enemies: [{ team: '12' }, { team: '7' }] },
      ],
      downs: [
        { t: 120, attackerTeam: '12' },
        { t: 500, attackerTeam: null },
      ],
      enemies: [
        { id: 'account.secret-1', team: '7', route: [[50, 1, 1]] },
        { id: 'account.secret-2', team: '30', route: [[10, 2, 2]] },
      ],
    });
    assert.deepEqual(
      aliased.fights.map((f) => f.enemies.map((e) => e.team)),
      [['敌方 B'], ['敌方 A', '敌方 B']],
    );
    assert.deepEqual(
      aliased.downs.map((d) => d.attackerTeam),
      ['敌方 A', null],
    );
    assert.deepEqual(
      aliased.enemies.map((e) => [e.id, e.team]),
      [
        ['enemy-1', '敌方 B'],
        ['enemy-2', '敌方 C'],
      ],
    );
    assert.ok(!(JSON.stringify(aliased)).includes('account.secret'));
  });
});

describe('the view of a share', () => {
  it('sums the squad per match and marks a match that is not stored as unavailable', () => {
    const view = shareViewPayload(share(), squad, new Map([['m1', match]])) as {
      kind: string;
      matches: Array<Record<string, unknown>>;
    };
    assert.equal(view.kind, 'query');
    assert.partialDeepStrictEqual(view.matches[0], {
      matchId: 'm1',
      available: true,
      placement: 4,
      kills: 3,
      knocks: 3,
      damage: 310,
      mapLabel: '艾伦格',
    });
    assert.deepEqual(view.matches[1], { matchId: 'gone', available: false });
  });

  it('titles a query share by its title and the match count', () => {
    assert.equal(shareTitle(share()).title, '📊 今日战绩 · 2 场');
  });
});

describe('the page shell', () => {
  const shell = '<html><head><title>x</title></head><body><div id="root"></div></body></html>';

  it('carries the view inline and cannot be closed early by text in the report', () => {
    const html = renderSharePage(
      shell,
      share({
        presentationJson: JSON.stringify({
          title: '</script><script>alert(1)</script>',
          displayText: '</script><b>x</b>',
        }),
      }),
      squad,
      new Map([['m1', match]]),
    );
    assert.equal(html.match(/<script>/g)?.length, 1);
    assert.ok(!(html).includes('</script><script>alert(1)'));
    assert.ok(html.includes('window.__SHARE_VIEW__='));
    assert.ok(html.includes('og:title'));
    assert.ok(html.includes('读取复盘与 2 场对局'));
  });
});
