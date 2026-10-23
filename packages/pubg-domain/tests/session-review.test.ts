import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSessionReview } from '@rine-kit/presentation';
import {
  buildSessionReview,
  businessDayWindow,
  dailySquadSession,
  latestCompleteBusinessDay,
  localTimeOn,
  sessionBaseline,
  SqlitePubgRepository,
  squadMatches,
  type MatchReviewFacts,
  type NormalizedMatch,
  type NormalizedPlayer,
  type SessionReviewRecord,
  type SessionTeam,
} from '../src/index.js';

const DAY = businessDayWindow('2026-10-18', 'Asia/Shanghai');

const MIN = 60_000;
const TEAM: SessionTeam = { id: 'squad', label: '小队', memberIds: ['a', 'b', 'c', 'd'] };
const T0 = Date.parse('2026-10-18T12:00:00Z');

interface Spec {
  id: string;
  at: number;
  rank: number;
  minutes?: number;
  competitive?: boolean;
  members?: string[];
  knocks?: number;
  damage?: number;
  /** Members out before 7 minutes of match time. */
  early?: string[];
}

function player(accountId: string, spec: Spec): NormalizedPlayer {
  const members = spec.members ?? TEAM.memberIds;
  const share = 1 / members.length;
  return {
    accountId,
    playerName: `P_${accountId}`,
    displayName: `P_${accountId}`,
    rank: spec.rank,
    kills: Math.round((spec.knocks ?? 4) * share),
    assists: 0,
    damage: (spec.damage ?? 600) * share,
    dbnos: Math.round((spec.knocks ?? 4) * share),
    revives: accountId === 'd' ? 1 : 0,
    headshotKills: 0,
    survivalTime: spec.early?.includes(accountId) ? 300 : (spec.minutes ?? 25) * 60 - 30,
    longestKill: 0,
    deaths: 1,
    deathSemantics: 'explicit',
  };
}

function match(spec: Spec): NormalizedMatch {
  return {
    schemaVersion: 1,
    matchId: spec.id,
    shard: 'steam',
    createdAt: new Date(spec.at).toISOString(),
    timestamp: spec.at,
    matchType: spec.competitive === false ? 'official' : 'competitive',
    gameMode: 'squad',
    isCompetitive: spec.competitive !== false,
    mapName: 'Baltic_Main',
    duration: (spec.minutes ?? 25) * 60,
    patchVersion: '1',
    players: (spec.members ?? TEAM.memberIds).map((id) => player(id, spec)),
  };
}

/** Thirty earlier matches spread over two weeks: average rank about 12, one early exit in five. */
function history(): NormalizedMatch[] {
  return Array.from({ length: 30 }, (_, index) =>
    match({
      id: `h${index}`,
      at: T0 - (14 * 24 * 60 - index * 600) * MIN,
      rank: 6 + ((index * 7) % 13),
      knocks: 3 + (index % 4),
      damage: 500 + (index % 5) * 60,
      early: index % 5 === 0 ? ['a'] : [],
    }),
  );
}

function sessionMatches(specs: Array<Omit<Spec, 'at' | 'id'>>, start = T0): NormalizedMatch[] {
  let at = start;
  return specs.map((spec, index) => {
    const built = match({ ...spec, id: `s${index}`, at });
    at += (spec.minutes ?? 25) * MIN + 5 * MIN;
    return built;
  });
}

test('only ranked matches with at least two members on one team count', () => {
  const matches = [
    match({ id: 'ranked', at: T0, rank: 3 }),
    match({ id: 'casual', at: T0 + 30 * MIN, rank: 2, competitive: false }),
    match({ id: 'solo', at: T0 + 60 * MIN, rank: 9, members: ['a'] }),
  ];
  assert.deepEqual(
    squadMatches(matches, TEAM.memberIds).map((item) => item.match.matchId),
    ['ranked'],
  );
  // Two members on different teams (different placements) are not a squad match.
  const split = match({ id: 'split', at: T0, rank: 4, members: ['a', 'b'] });
  split.players[1]!.rank = 30;
  assert.equal(squadMatches([split], TEAM.memberIds).length, 0);
});

test('a business day runs from 06:00 to 06:00 Shanghai time, and at 09:30 the latest complete one is yesterday', () => {
  assert.deepEqual(DAY, {
    businessDay: '2026-10-18',
    startMs: Date.parse('2026-10-17T22:00:00Z'),
    endMs: Date.parse('2026-10-18T22:00:00Z'),
  });
  const runAt = localTimeOn('2026-10-18', '09:30', 'Asia/Shanghai', 1);
  assert.equal(runAt.toISOString(), '2026-10-19T01:30:00.000Z');
  assert.equal(latestCompleteBusinessDay(runAt, 'Asia/Shanghai'), '2026-10-18');
  // 05:59 on the 19th is still the 18th's business day, so the latest complete one is the 17th.
  assert.equal(
    latestCompleteBusinessDay(new Date('2026-10-18T21:59:00Z'), 'Asia/Shanghai'),
    '2026-10-17',
  );
});

test('the daily session is every squad match that started inside the business day, past midnight included', () => {
  const matches = [
    match({ id: 'before', at: DAY.startMs - MIN, rank: 5 }),
    match({ id: 'morning', at: DAY.startMs, rank: 8 }),
    // Hours apart: the old 40-minute gap would have split these; the day keeps them together.
    match({ id: 'evening', at: DAY.startMs + 12 * 60 * MIN, rank: 2 }),
    match({ id: 'late', at: DAY.endMs - 10 * MIN, rank: 3, minutes: 30 }),
    match({ id: 'next', at: DAY.endMs, rank: 1 }),
  ];
  const session = dailySquadSession(matches, TEAM, DAY)!;
  assert.equal(session.key, 'pubg-daily:squad:2026-10-18');
  assert.deepEqual(
    session.matches.map((item) => item.match.matchId),
    ['morning', 'evening', 'late'],
  );
  assert.equal(session.lastEndMs, DAY.endMs + 20 * MIN);
  assert.equal(dailySquadSession(matches.slice(0, 1), TEAM, DAY), null);
});

function reviewFor(matches: NormalizedMatch[], facts = new Map<string, MatchReviewFacts | null>()) {
  const all = [...history(), ...matches];
  const session = dailySquadSession(all, TEAM, DAY)!;
  return buildSessionReview({
    session,
    baseline: sessionBaseline(all, TEAM, session),
    team: TEAM,
    facts,
    timezone: 'Asia/Shanghai',
    link: 'https://pubg.example.test/s/token',
    now: new Date(session.lastEndMs + 60 * MIN),
  });
}

test('a clear problem and a clear strength both make it into the review, in plain words', () => {
  const review = reviewFor(
    sessionMatches([
      { rank: 2, early: ['a'] },
      { rank: 3, early: ['b'] },
      { rank: 1, early: ['c'] },
      { rank: 4, early: ['a'] },
      { rank: 2, early: ['d'] },
      { rank: 3 },
    ]),
  );
  const early = review.findings.find((finding) => finding.metric === 'early_out');
  assert.deepEqual([early?.tone, early?.confidence], ['bad', 'clear']);
  assert.match(early!.text, /6 场里 5 场开局 7 分钟内就有人出局,平时约 2\/10/u);
  const placement = review.findings.find((finding) => finding.metric === 'placement');
  assert.deepEqual([placement?.tone, placement?.confidence], ['good', 'clear']);
  assert.ok(review.findings.length <= 3);
  assert.match(review.headline, /但开局减员太多/u);
  assert.equal(review.suggestion, '前期先求稳:换个人少的落点,落地先集合再搜。');
  assert.equal(review.summary.wins, 1);
  assert.equal(review.summary.baselineAvgPlacement !== null, true);
  assert.equal(review.link, 'https://pubg.example.test/s/token');
});

test('a session that looks like the squad usually plays claims nothing', () => {
  const ordinary = history()
    .slice(0, 6)
    .map((item, index) => ({ ...item, matchId: `s${index}` }));
  let at = T0;
  for (const item of ordinary) {
    item.timestamp = at;
    at += 30 * MIN;
  }
  const review = reviewFor(ordinary);
  assert.equal(review.findings.filter((finding) => finding.confidence === 'clear').length, 0);
  assert.match(review.headline, /和平时差不多/u);
});

test('members, best and worst match and the coverage line come from the data', () => {
  const facts = new Map<string, MatchReviewFacts | null>([
    [
      's0',
      {
        fights: [
          { start: 1440, result: 'WIN', teamKnocks: 4, receivedKnocks: 1, importanceScore: 5 },
        ],
      } as unknown as MatchReviewFacts,
    ],
    ['s1', { fights: [] } as unknown as MatchReviewFacts],
  ]);
  const review = reviewFor(
    sessionMatches([
      { rank: 1, knocks: 8, damage: 1400 },
      { rank: 9 },
      { rank: 25, minutes: 6, early: ['a', 'b', 'c', 'd'] },
    ]),
    facts,
  );
  assert.deepEqual(review.coverage, { telemetry: 2, total: 3 });
  assert.equal(review.bestMatch?.matchId, 's0');
  assert.match(review.bestMatch!.text, /第 24 分钟赢下交战击倒 4 人/u);
  assert.equal(review.worstMatch?.matchId, 's2');
  assert.match(review.worstMatch!.text, /全队在第 5 分钟前出局/u);
  assert.equal(review.members.length, 4);
  assert.ok(review.members.every((member) => member.matches === 3));
  const text = renderSessionReview(review);
  assert.ok(text.length <= 1000, `review is ${text.length} chars`);
  assert.match(text, /📎 2\/3 场有完整遥测/u);
});

test('a one-match session gets a short timeline review', () => {
  const facts = new Map<string, MatchReviewFacts | null>([
    [
      's0',
      {
        fights: [
          { start: 400, result: 'LOSS', teamKnocks: 0, receivedKnocks: 2, importanceScore: 9 },
          { start: 1100, result: 'WIN', teamKnocks: 3, receivedKnocks: 0, importanceScore: 3 },
        ],
      } as unknown as MatchReviewFacts,
    ],
  ]);
  const review = reviewFor(sessionMatches([{ rank: 14 }]), facts);
  assert.equal(review.matchCount, 1);
  assert.equal(review.headline, '第 14 名,没能进前十。');
  assert.deepEqual(
    review.timeline?.map((item) => Math.round(item.atSeconds / 60)),
    [7, 18, 25],
  );
  assert.ok(renderSessionReview(review).length <= 400);
});

test('the ledger round-trips records and meta, and reads the latest fetch', () => {
  const repository = new SqlitePubgRepository(':memory:');
  const record: SessionReviewRecord = {
    squadId: 'squad',
    sessionKey: 'pubg-session:squad:m1',
    matchIds: ['m1', 'm2'],
    lastMatchEndMs: 5,
    status: 'dry_run',
    detail: 'preview',
    message: 'text',
    attempts: 0,
    updatedAt: '2026-10-18T00:00:00.000Z',
  };
  repository.putSessionReview(record);
  assert.deepEqual(repository.getSessionReview('squad', record.sessionKey), record);
  repository.putSessionReview({ ...record, status: 'sent', attempts: 1 });
  assert.equal(repository.getSessionReview('squad', record.sessionKey)?.status, 'sent');
  assert.equal(repository.getSessionReviewMeta('enabled-at'), null);
  repository.setSessionReviewMeta('enabled-at', '2026-10-18T00:00:00.000Z');
  assert.equal(repository.getSessionReviewMeta('enabled-at'), '2026-10-18T00:00:00.000Z');
  assert.equal(repository.latestPrefetchFinishedMs(), null);
  repository.recordTelemetryPrefetchRun({
    runId: 'r1',
    reportDate: '2026-10-18',
    startedAt: '2026-10-18T10:05:00.000Z',
    finishedAt: '2026-10-18T10:05:04.000Z',
    trigger: 'hourly',
    discoveredMatchCount: 0,
    newMatchCount: 0,
    candidateMatchCount: 0,
    fetchedCount: 0,
    cacheHitCount: 0,
    unavailableCount: 0,
    pendingCount: 0,
    failedMatchIds: [],
  });
  assert.equal(repository.latestPrefetchFinishedMs(), Date.parse('2026-10-18T10:05:04.000Z'));
  repository.close();
});
