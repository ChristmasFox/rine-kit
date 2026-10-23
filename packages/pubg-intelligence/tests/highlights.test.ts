import assert from 'node:assert/strict';
import test from 'node:test';
import { identifyMatchHighlights, rankCrossMatchHighlights } from '../src/highlights.js';
import { analyzeMatchStory } from '../src/match-story.js';
import { highlightMatch, highlightMemberIds, highlightTelemetry } from './highlight-fixture.js';

const identify = (payload = highlightTelemetry(), match = highlightMatch()) =>
  identifyMatchHighlights({ payload, match, memberIds: highlightMemberIds });

test('recognises streak, observed wipe, knock-balance comeback and rescue with exact replay/source references', () => {
  const payload = highlightTelemetry();
  const items = identify(payload);
  assert.deepEqual(
    items.map((item) => item.kind),
    ['wipe', 'comeback', 'streak', 'rescue'],
  );
  assert.deepEqual(
    items.find((item) => item.kind === 'streak')!.evidence.map((ref) => ref.eventId),
    ['telemetry-7', 'telemetry-8'],
  );
  assert.equal(
    items.find((item) => item.kind === 'rescue')!.summary,
    'B 扶起 A，距已记录倒地 30 秒。',
  );
  assert.equal(
    items.find((item) => item.kind === 'streak')!.count,
    2,
    'finishing kills do not add takedowns',
  );
  assert.ok(
    items.find((item) => item.kind === 'wipe')!.notes.some((note) => note.includes('不推断')),
  );
  assert.ok(
    items.every(
      (item) =>
        item.evidence.length &&
        item.evidence.every(
          (ref) =>
            ref.matchId === 'highlight-match' && payload[Number(ref.eventId.split('-')[1]) - 1],
        ),
    ),
  );
  assert.ok(
    items.every((item) => item.players.every((player) => highlightMemberIds.includes(player.id))),
    'no enemy identity in presentation',
  );
  assert.deepEqual(identify(payload), items, 'repeatable IDs and ordering');
  const offsetMatch = highlightMatch('offset', '2026-10-19T14:59:30.000Z');
  assert.equal(
    identify(payload, offsetMatch).find((item) => item.kind === 'streak')!.startSeconds,
    110,
    'replay uses LogMatchStart, not match API creation time',
  );
});

test('60-second chain boundary, distinct victims and unknown/pre-match/duplicate evidence stay conservative', () => {
  const payload = highlightTelemetry();
  const justKnocks = payload
    .slice(0, 5)
    .concat(payload[6]!, { ...payload[7]!, _D: '2026-10-19T15:02:50.000Z' });
  assert.equal(
    identify(justKnocks).filter((item) => item.kind === 'streak').length,
    1,
    'exactly 60 seconds',
  );
  assert.equal(
    identify([...justKnocks.slice(0, -1), { ...justKnocks.at(-1), _D: '2026-10-19T15:02:51.000Z' }])
      .length,
    0,
    '61 seconds splits the chain',
  );
  assert.equal(
    identify(payload.slice(0, 5).concat(payload[6]!, payload[6]!)).length,
    0,
    'same enemy twice is not a streak',
  );
  const unknownTeams = payload.map((event) =>
    Object.fromEntries(
      Object.entries(event).map(([key, value]) => [
        key,
        value && typeof value === 'object' && 'teamId' in value
          ? { ...(value as object), teamId: null }
          : value,
      ]),
    ),
  );
  assert.equal(
    identify(unknownTeams).length,
    0,
    'unknown teams cannot establish enemies or a rescue',
  );
  assert.equal(
    identify(payload.map((event) => ({ ...event, common: { isGame: 0 } }))).length,
    0,
    'pre-match contacts ignored',
  );
  assert.equal(
    identify(payload.map((event) => ({ ...event, _D: 'unknown' }))).length,
    0,
    'no invented start time',
  );
});

test('a rescue without a recorded knock retains an unknown delay; outsider revives and unproven comeback are excluded', () => {
  const payload = highlightTelemetry();
  const withoutKnock = payload.filter((_, index) => index !== 5);
  const rescue = identify(withoutKnock).find((item) => item.kind === 'rescue')!;
  assert.equal(rescue.evidence.length, 1);
  assert.ok(rescue.notes.some((note) => note.includes('未知')));
  assert.ok(!identify(withoutKnock).some((item) => item.kind === 'comeback'));
  const outsider = payload.map((event) =>
    event._T === 'LogPlayerRevive'
      ? { ...event, reviver: { accountId: 'outsider', teamId: 1 } }
      : event,
  );
  assert.ok(!identify(outsider).some((item) => item.kind === 'rescue'));
  const thirdParty = payload.map((event, index) =>
    index === 9
      ? {
          ...event,
          dBNOMaker: null,
          killer: { accountId: 'outsider', teamId: 3 },
          finisher: { accountId: 'outsider', teamId: 3 },
        }
      : event,
  );
  assert.ok(
    !identify(thirdParty).some((item) => item.kind === 'wipe'),
    'a third-party finish without squad knock attribution cannot be our wipe',
  );
});

test('cross-match ranking is stable, deduplicated and puts newer moments first within type and strength', () => {
  const old = identify();
  const newer = identify(
    highlightTelemetry('2026-10-20T15:00:00.000Z'),
    highlightMatch('newer', '2026-10-20T15:00:00.000Z'),
  );
  const ranked = rankCrossMatchHighlights([...old, ...newer, ...old]);
  assert.equal(ranked.length, old.length + newer.length);
  assert.equal(ranked[0]!.matchId, 'newer');
  assert.deepEqual(rankCrossMatchHighlights([...newer, ...old].reverse()), ranked);
});

test('observed wipe cites older roster deaths while replay starts at the final push', () => {
  const payload = highlightTelemetry();
  const earlier = {
    ...payload[8]!,
    _D: '2026-10-19T15:00:40.000Z',
    victim: { accountId: 'earlier-enemy', teamId: 2 },
    dBNOMaker: null,
    finisher: { accountId: 'third-party', teamId: 3 },
    killer: { accountId: 'third-party', teamId: 3 },
  };
  const wipe = identify([...payload.slice(0, 5), earlier, ...payload.slice(5)]).find(
    (item) => item.kind === 'wipe',
  )!;
  assert.equal(wipe.count, 2);
  assert.match(wipe.summary, /已观测的 3 名成员/u);
  assert.equal(wipe.startSeconds, 110, 'old deaths support the roster, not the replay start');
  assert.ok(wipe.evidence.some((ref) => ref.eventId === 'telemetry-6' && ref.timeSeconds === 40));
});

test('comeback counts come from the cited knock events, not story aggregates that also include direct kills', () => {
  const payload = highlightTelemetry();
  const story = analyzeMatchStory(payload, new Set(highlightMemberIds));
  story.fights[0]!.enemyDowns = 99;
  const item = identifyMatchHighlights({
    payload,
    match: highlightMatch(),
    memberIds: highlightMemberIds,
    story,
  }).find((item) => item.kind === 'comeback')!;
  assert.equal(item.count, 2);
  assert.match(item.summary, /击倒 2 名不同敌人、本队 1 人倒地/u);
  assert.doesNotMatch(item.summary, /99/u);
});
