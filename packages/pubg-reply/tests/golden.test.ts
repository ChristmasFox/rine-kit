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
        structuredClone(fixture.envelope),
        'Asia/Shanghai',
        withShare ? share : undefined,
      );
      assert.equal(`${JSON.stringify(result, null, 2)}\n`, golden(`${name}${withShare ? '.share' : ''}`));
    });
  }
}

test('the chat card keeps the bold markers, medals and team total', () => {
  const result = jsonToolResult('pubg_query_stats', structuredClone(FIXTURES.stats_ok!.envelope));
  const text = String(result.displayText);
  assert.match(text, /^🏆 /u);
  assert.match(text, /🥇 \*\*kim_kkl\*\*/u);
  assert.match(text, /\*\*团队合计：/u);
  assert.ok(typeof result.replyGuide === 'string' && result.replyGuide.includes('战报'));
});
