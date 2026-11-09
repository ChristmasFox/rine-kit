import assert from 'node:assert/strict';
import test from 'node:test';
import { forceTeamScope, isBareRecordRequest } from '../src/evidence.js';

test('a bare record request names no one: 战绩, 战况, 战报 and 日报 all count, with or without a period or a mention', () => {
  for (const request of ['今日战绩', '昨天战绩', '昨日战绩', '本周战绩', '@Kurisu 今天战绩', '昨日战报', '昨天战报', '战报', '@Kurisu 昨日战报', '今日日报', '昨日战况', '昨日战报？']) {
    assert.equal(isBareRecordRequest(request), true, request);
  }
  for (const request of ['我的战绩', '我昨日战报', '猴昨日战报', '昨日小队战绩', '战报怎么看', '', undefined]) {
    assert.equal(isBareRecordRequest(request), false, String(request));
  }
});

test('forcing the team clears the person fields with empty arrays so a shallow merge over the original params cannot bring them back', () => {
  const original = { metrics: ['matches'], personIds: ['p'], playerNames: ['n'], operation: 'report' };
  const forced = forceTeamScope(original)!;
  assert.deepEqual(forced, { metrics: ['matches'], operation: 'report', personIds: [], playerNames: [], playerIds: [], team: true });
  // how a host applies a hook's params: on top of the model's own
  const merged = { ...original, ...forced };
  assert.equal(merged.team, true);
  for (const key of ['personIds', 'playerNames', 'playerIds'] as const) assert.deepEqual(merged[key], [], key);
});

test('already a clean team request: nothing to change, also on a second pass', () => {
  assert.equal(forceTeamScope({ team: true, metrics: ['matches'] }), undefined);
  assert.equal(forceTeamScope({ team: true, personIds: [], playerNames: [], playerIds: [] }), undefined);
  const first = forceTeamScope({ personIds: ['p'] })!;
  assert.equal(forceTeamScope(first), undefined);
  assert.deepEqual(forceTeamScope({ team: false, personIds: ['p'] }), { team: true, personIds: [], playerNames: [], playerIds: [] });
});
