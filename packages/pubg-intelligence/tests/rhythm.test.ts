import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeRhythm,
  mulberry32,
  splitSessions,
  SESSION_GAP_MINUTES,
  type RhythmMatch,
} from '../src/index.js';

/** Builds `sessions` evenings of `games` matches ten minutes... twenty minutes apart; `shape` sets each game's expected damage. */
function evenings(
  sessions: number,
  games: number,
  shape: (index: number, rng: () => number) => { damage: number; rank: number },
  seed = 7,
): RhythmMatch[] {
  const rng = mulberry32(seed);
  const out: RhythmMatch[] = [];
  for (let night = 0; night < sessions; night += 1) {
    // 14:00 UTC is 22:00 in Shanghai.
    const start = Date.UTC(2026, 8, 1 + night * 2, 14, 0, 0);
    for (let index = 0; index < games; index += 1)
      out.push({ timestamp: start + index * 22 * 60_000, ...shape(index, rng) });
  }
  return out;
}

test('matches are split into sessions at gaps longer than the session gap, and numbered within them', () => {
  const base = Date.UTC(2026, 9, 1, 12, 0, 0);
  const minute = 60_000;
  const sessions = splitSessions([
    { timestamp: base + 200 * minute, rank: 5, damage: 1 },
    { timestamp: base, rank: 1, damage: 1 },
    { timestamp: base + 30 * minute, rank: 2, damage: 1 },
    { timestamp: base + (30 + SESSION_GAP_MINUTES) * minute, rank: 3, damage: 1 },
    { timestamp: base + (31 + 2 * SESSION_GAP_MINUTES) * minute, rank: 4, damage: 1 },
  ]);
  assert.deepEqual(
    sessions.map((session) => session.map((game) => game.index)),
    [[1, 2, 3], [1], [1]],
    'a gap of exactly the limit stays in the session',
  );
  assert.equal(sessions[0]![0]!.hour, 20, '12:00 UTC is 20:00 in Shanghai');
});

test('a weak first game is found, with an interval from resampling whole sessions, while fatigue and tilt are reported as absent', () => {
  const matches = evenings(60, 6, (index, rng) => ({
    damage: (index === 0 ? 300 : 600) + (rng() - 0.5) * 200,
    rank: index === 0 ? 8 + Math.floor(rng() * 10) : 3 + Math.floor(rng() * 12),
  }));
  const result = analyzeRhythm({ matches, now: matches.at(-1)!.timestamp + 10 * 60_000 });
  assert.equal(result.sessions, 60);
  assert.equal(result.matches, 360);
  assert.equal(result.byIndex[0]!.index, 1);
  assert.ok(result.byIndex[0]!.damage.mean! < result.byIndex[1]!.damage.mean! - 200);
  const warm = result.warmup!;
  assert.ok(
    warm.damage.clear && warm.damage.diff! < -200 && warm.damage.high! < 0,
    'the interval excludes zero',
  );
  assert.ok(Math.abs(warm.damage.a! - 300) < 40 && Math.abs(warm.damage.b! - 600) < 20);
  assert.equal(warm.damage.nA, 60);
  assert.equal(warm.damage.nB, 300);
  assert.ok(result.insights.some((line) => line.startsWith('每个时段的第一局明显偏弱')));
  assert.ok(
    [22, 23].includes(result.bestHour!.hour),
    'the games fall in the 22:00 and 23:00 hours',
  );
  assert.deepEqual(
    result.current && { next: result.current.nextGame, since: result.current.minutesSinceLast },
    { next: 7, since: 10 },
  );
});

test('no first-game effect means no claim, and a late slump in long sessions is reported when it is real', () => {
  const flat = analyzeRhythm({
    matches: evenings(
      50,
      5,
      (_index, rng) => ({ damage: 500 + (rng() - 0.5) * 300, rank: 2 + Math.floor(rng() * 14) }),
      11,
    ),
    now: 0,
  });
  assert.equal(flat.warmup!.damage.clear, false);
  assert.ok(
    flat.insights.some((line) => line.includes('没有可靠差别')),
    'the page says so instead of staying silent',
  );
  assert.equal(flat.current, null, 'an old last match is not a session in progress');

  const slump = analyzeRhythm({
    matches: evenings(
      40,
      10,
      (index, rng) => ({
        damage: (index >= 7 ? 300 : 600) + (rng() - 0.5) * 100,
        rank: 4 + Math.floor(rng() * 8),
      }),
      13,
    ),
    now: 0,
  });
  assert.equal(slump.fatigue!.sessions, 40);
  assert.ok(slump.fatigue!.damage.clear && slump.fatigue!.damage.diff! < -200);
  assert.ok(slump.insights.some((line) => line.includes('最后 3 局比前 3 局弱')));
  const fine = analyzeRhythm({
    matches: evenings(
      40,
      10,
      (_index, rng) => ({ damage: 500 + (rng() - 0.5) * 300, rank: 4 + Math.floor(rng() * 8) }),
      17,
    ),
    now: 0,
  });
  assert.ok(fine.insights.some((line) => line.includes('没有发现疲劳效应')));
});

test('too few sessions give descriptive tables but no tested claims, and an empty input is harmless', () => {
  const few = analyzeRhythm({ matches: evenings(6, 5, () => ({ damage: 400, rank: 5 })), now: 0 });
  assert.equal(few.warmup, null);
  assert.equal(few.fatigue, null);
  assert.equal(few.insights.length, 0);
  assert.ok(few.byIndex.length > 0);
  const empty = analyzeRhythm({ matches: [] });
  assert.deepEqual(
    { matches: empty.matches, sessions: empty.sessions, byIndex: empty.byIndex.length },
    { matches: 0, sessions: 0, byIndex: 0 },
  );
});

test('a game that follows an early exit is compared with the others of the same session', () => {
  // The game after a rank-17 finish is always weak; everything else is steady.
  const rng = mulberry32(23);
  const matches: RhythmMatch[] = [];
  for (let night = 0; night < 45; night += 1) {
    const start = Date.UTC(2026, 8, 1 + night * 2, 14);
    let previousBad = false;
    for (let index = 0; index < 7; index += 1) {
      const bad = index < 6 && rng() < 0.4;
      matches.push({
        timestamp: start + index * 22 * 60_000,
        damage: (previousBad ? 280 : 600) + (rng() - 0.5) * 80,
        rank: bad ? 17 : 5 + Math.floor(rng() * 5),
      });
      previousBad = bad;
    }
  }
  const tilt = analyzeRhythm({ matches, now: 0 }).tilt!;
  assert.ok(tilt.damage.clear && tilt.damage.diff! < -250 && tilt.damage.nA >= 20);
  assert.ok(
    analyzeRhythm({ matches, now: 0 }).insights.some((line) => line.includes('下一局更差')),
  );
});

test('a first-game gap whose interval just touches zero is flagged as suggestive, not as a finding', () => {
  // Top-10 finishes: the first game does worse, but with so few sessions the evidence is thin.
  const rng = mulberry32(31);
  const matches = evenings(
    16,
    4,
    (index) => ({
      damage: 500 + (rng() - 0.5) * 100,
      rank: index === 0 ? (rng() < 0.25 ? 6 : 14) : rng() < 0.7 ? 6 : 14,
    }),
    37,
  );
  const warm = analyzeRhythm({ matches, now: 0 });
  assert.equal(warm.warmup!.damage.clear, false);
  assert.ok(
    !warm.insights.some((line) => line.startsWith('每个时段的第一局明显偏弱')),
    'no claim without a clear interval',
  );
});
