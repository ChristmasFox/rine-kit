import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMatchRelative } from '../src/index.js';

const history = (count: number, damage: (index: number) => number) =>
  Array.from({ length: count }, (_, index) => ({
    damage: damage(index),
    kills: 1,
    knocks: 1,
    survival: 15,
    dpm: 10,
    timesDowned: 1,
  }));

test("a match is placed against each member's own history, and outliers become highlights", () => {
  const relative = buildMatchRelative({
    players: [
      {
        accountId: 'a',
        name: 'A',
        current: { damage: 900, kills: 6, knocks: 5, survival: 25, dpm: 36, timesDowned: 0 },
        history: history(20, (index) => 100 + index * 10),
      },
      {
        accountId: 'b',
        name: 'B',
        current: { damage: 50, kills: 0, knocks: 0, survival: 3, dpm: 4, timesDowned: 2 },
        history: history(20, (index) => 200 + index),
      },
      { accountId: 'c', name: 'C', current: { damage: 500 }, history: history(3, () => 300) },
    ],
    placement: { current: 1, history: [5, 8, 12, 3, 20, 15, 9, 7, 11, 6] },
  });
  const a = relative.players.find((player) => player.accountId === 'a')!;
  assert.equal(a.metrics.find((reading) => reading.key === 'damage')!.percentile, 1);
  assert.equal(
    a.metrics.find((reading) => reading.key === 'timesDowned')!.goodness,
    1,
    'fewer downs than usual is good',
  );
  assert.ok(a.form! > 0.9);
  const b = relative.players.find((player) => player.accountId === 'b')!;
  assert.ok(b.form! < 0.1);
  const c = relative.players.find((player) => player.accountId === 'c')!;
  assert.equal(
    c.metrics.find((reading) => reading.key === 'damage')!.percentile,
    null,
    'too little history',
  );
  assert.equal(c.form, null);
  assert.equal(relative.placement.goodness, 1);
  assert.ok(
    relative.highlights.some((item) => item.tone === 'good' && item.text.includes('第 1 名')),
  );
  assert.ok(relative.highlights.some((item) => item.text.startsWith('本局状态最好：A')));
  assert.ok(relative.highlights.some((item) => item.tone === 'bad' && item.text.startsWith('B ')));
  assert.ok(
    relative.highlights.filter((item) => item.text.startsWith('A ')).length <= 2,
    'at most two lines per player',
  );
});

test('an ordinary match says so instead of inventing highlights', () => {
  const relative = buildMatchRelative({
    players: [
      {
        accountId: 'a',
        name: 'A',
        current: { damage: 195, kills: 1, knocks: 1, survival: 15, dpm: 10 },
        history: history(20, (index) => 100 + index * 10),
      },
    ],
    placement: { current: 10, history: [5, 8, 12, 3, 20, 15, 9, 7, 11, 6, 14] },
  });
  assert.deepEqual(
    relative.highlights.map((item) => item.tone),
    ['info'],
  );
});
