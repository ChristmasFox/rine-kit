import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { jsonToolResult, type ShareAppender } from '../src/index.js';
import { FIXTURES } from './fixtures.js';

const share: ShareAppender = (_envelope, displayText) => ({
  text: `${displayText}\n\n🔗 https://share.example/s/AAAAAAAAAAAAAAAAAAAAAA`,
  url: 'https://share.example/s/AAAAAAAAAAAAAAAAAAAAAA',
});

const golden = (name: string) =>
  readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8');

// The golden files are produced by Lab's own jsonToolResult (scripts/gen-golden-from-lab.ts), so equality here means
// a host using this package answers byte for byte like Lab.
for (const [name, fixture] of Object.entries(FIXTURES)) {
  for (const withShare of [false, true]) {
    test(`${name}${withShare ? ' with share link' : ''}: same result as Lab`, () => {
      const result = jsonToolResult(
        fixture.tool,
        structuredClone(fixture.envelope) as never,
        'Asia/Shanghai',
        withShare ? share : undefined,
      );
      assert.equal(`${JSON.stringify(result, null, 2)}\n`, golden(`${name}${withShare ? '.share' : ''}`));
    });
  }
}

test('the chat card keeps the bold markers, medals and team total', () => {
  const result = jsonToolResult('pubg_query_stats', structuredClone(FIXTURES.stats_ok!.envelope) as never);
  const text = String(result.displayText);
  assert.match(text, /^🏆 /u);
  assert.match(text, /🥇 \*\*kim_kkl\*\*/u);
  assert.match(text, /\*\*团队合计：/u);
  assert.ok(typeof result.replyGuide === 'string' && result.replyGuide.includes('战报'));
});

test('queryShareFor issues one link for a query answer, none for an error, and none without a base URL', async () => {
  const { queryShareFor } = await import('../src/index.js');
  const { reviewShareTokenHash } = await import('@rine-kit/pubg-domain');
  const stored: Array<{ tokenHash: string; squadId: string; kind: string }> = [];
  const store = {
    putReviewShare: (record: { tokenHash: string; squadId: string; kind: string }) => void stored.push(record),
    getReviewShare: () => null,
    latestReviewShare: () => null,
    revokeReviewShares: () => 0,
  };
  const options = { shareBaseUrl: 'https://rine.example/', squadId: 'room-1', store: () => store, now: () => new Date('2026-10-20T10:00:00.000Z') };
  const reply = jsonToolResult('pubg_query_stats', structuredClone(FIXTURES.stats_ok!.envelope) as never, 'Asia/Shanghai', queryShareFor('pubg_query_stats', options));
  const link = (reply.replyLink as { url: string }).url;
  assert.match(link, /^https:\/\/rine\.example\/s\/[A-Za-z0-9_-]{22}$/u);
  assert.ok(String(reply.displayText).endsWith(`\n\n🔗 ${link}`));
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.tokenHash, reviewShareTokenHash(link.split('/s/')[1]!));
  assert.equal(stored[0]!.squadId, 'room-1');
  const failed = jsonToolResult('pubg_query_stats', structuredClone(FIXTURES.stats_error!.envelope) as never, 'Asia/Shanghai', queryShareFor('pubg_query_stats', options));
  assert.equal(failed.replyLink, undefined);
  const damage = jsonToolResult('pubg_query_team_damage', structuredClone(FIXTURES.team_damage!.envelope) as never, 'Asia/Shanghai', queryShareFor('pubg_query_team_damage', options));
  assert.equal(damage.replyLink, undefined, 'the 误伤 ledger is a fact about teammates, not a record: no link');
  assert.equal(queryShareFor('pubg_query_stats', { ...options, shareBaseUrl: undefined }), undefined);
});

test('assessTurn: facts without a tool result are refused, a verified card is accepted, a dropped card is named', async () => {
  const { assessTurn, jsonToolResult: result } = await import('../src/index.js');
  const output = result('pubg_query_stats', structuredClone(FIXTURES.stats_ok!.envelope) as never);
  const card = String(output.displayText);
  const call = { name: 'pubg_query_stats', input: { team: true }, output };
  assert.equal(assessTurn({ request: '昨日战绩', calls: [], finalText: '昨天打了 3 局，5 杀' }).verdict, 'missing_data');
  assert.equal(assessTurn({ request: '昨日战绩', calls: [call], finalText: card }).verdict, 'verified');
  assert.equal(assessTurn({ request: '你好', calls: [], finalText: '你好呀' }).verdict, 'not_applicable');
  assert.equal(assessTurn({ request: '胶昨天战绩', calls: [call], finalText: card }).verdict, 'wrong_scope');
  const short = assessTurn({ request: '昨日战绩', calls: [call], finalText: '昨天战绩：kim_kkl 5 杀，SG_LabmemNo004 10 杀。' });
  assert.equal(short.verdict, 'verified');
  assert.ok(short.dropped.length > 0, 'a one-line summary drops card facts');
  assert.deepEqual(assessTurn({ request: '昨日战绩', calls: [call], finalText: card }).dropped, []);
});

test('the roster heading is Lab’s exact wording by default and takes the host’s own authority', async () => {
  const { renderGroupRoster, LAB_ROSTER_AUTHORITY } = await import('../src/index.js');
  const entries = [
    { personId: 'p1', displayName: 'Mei', addressAs: '变态猴', avoid: ['猴子'], note: '爱吐槽', externalAccounts: [{ provider: 'pubg', externalId: 'SG_LabmemNo004' }] },
  ];
  const lab = renderGroupRoster(entries)!;
  // Lab's output, character for character (plugins/amadeus/src/group-roster.ts).
  assert.equal(
    lab,
    [
      '本群成员的称呼（成员约定、Arthur 审核过的长期设定；与聊天记录里的旧叫法冲突时以这里为准）：',
      '- Mei（PUBG SG_LabmemNo004）：称呼「变态猴」；不要叫：猴子；爱吐槽',
      '称呼成员时用这里的叫法。查询战绩、确认身份仍按身份与 PUBG 工具，不要从称呼推断账号。',
    ].join('\n'),
  );
  assert.equal(LAB_ROSTER_AUTHORITY, 'Arthur 审核过的长期设定');
  const room = renderGroupRoster(entries, { authority: '由该房间管理员审核决定' })!;
  assert.ok(room.startsWith('本群成员的称呼（成员约定、由该房间管理员审核决定；'));
  assert.ok(!room.includes('Arthur'));
  assert.equal(room.split('\n').slice(1).join('\n'), lab.split('\n').slice(1).join('\n'));
});

test('the worked examples take the squad from the host; Lab’s squad is the default and changes nothing', async () => {
  const { kurisuReplyExamples, KURISU_REPLY_EXAMPLES, LAB_EXAMPLE_SQUAD } = await import('../src/index.js');
  assert.deepEqual(kurisuReplyExamples(), KURISU_REPLY_EXAMPLES);
  assert.deepEqual(kurisuReplyExamples(LAB_EXAMPLE_SQUAD), KURISU_REPLY_EXAMPLES);
  const squad = {
    a: { name: '小A', account: 'PlayerA' },
    b: { name: '小B', account: 'PlayerB' },
    c: { name: '小C', account: 'PlayerC' },
    d: { name: '小D' },
  };
  const room = kurisuReplyExamples(squad);
  for (const text of [room.stats!, room.teamDamage!]) {
    for (const lab of ['Arthur', 'Nori', '变态猴', 'kim_kkl', 'SG_Labmem', '打工战士']) assert.ok(!text.includes(lab), lab);
    assert.ok(!text.includes('{{'));
  }
  assert.match(room.stats!, /🥇 \*\*效率杀手：小A（PlayerA）\*\*/u);
  assert.match(room.teamDamage!, /狂气压制：小C（PlayerC） ➡️ 小B（PlayerB）/u);
  // Everything but the names is the same text: mapping the names back gives Lab's examples.
  const back = (text: string) =>
    text.replaceAll('小A（PlayerA）', 'Nori（kim_kkl）').replaceAll('小B（PlayerB）', '变态猴（SG_LabmemNo004）').replaceAll('小C（PlayerC）', 'Arthur（SG_LabmemNo007）').replaceAll('小B', '变态猴').replaceAll('小C', 'Arthur').replaceAll('小D', '打工战士');
  assert.equal(back(room.stats!), KURISU_REPLY_EXAMPLES.stats);
  assert.equal(back(room.teamDamage!), KURISU_REPLY_EXAMPLES.teamDamage);
});
