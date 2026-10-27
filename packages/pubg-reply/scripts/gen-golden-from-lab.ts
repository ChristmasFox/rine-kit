/*
 * Regenerates tests/golden/*.json by running Lab's OWN code (plugins/pubg/src/index.ts jsonToolResult and its
 * helpers, plus reply-guides.ts), sliced out of the Lab checkout and run unmodified except for stubbing the OpenClaw
 * `jsonResult` wrapper. Read-only on Lab. Usage:
 *   LAB_ROOT=~/amadeus-home pnpm --filter @rine-kit/pubg-reply exec tsx scripts/gen-golden-from-lab.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES } from '../tests/fixtures.ts';

const lab = (process.env.LAB_ROOT ?? '').replace(/^~/u, process.env.HOME ?? '');
if (!lab) throw new Error('set LAB_ROOT to the Lab checkout (read only)');
const presentation = pathToFileURL(new URL('../../presentation/src/index.ts', import.meta.url).pathname).href;
const index = readFileSync(join(lab, 'plugins/pubg/src/index.ts'), 'utf8');
const start = index.indexOf('type DataSourceRange = {');
const end = index.indexOf('const shareStores');
if (start < 0 || end < 0) throw new Error('Lab index.ts layout changed');
const labGuides = readFileSync(join(lab, 'plugins/pubg/src/reply-guides.ts'), 'utf8').replace("'@rine-kit/presentation'", `'${presentation}'`);

const dir = mkdtempSync(join(tmpdir(), 'lab-golden-'));
writeFileSync(join(dir, 'reply-guides.ts'), labGuides);
writeFileSync(
  join(dir, 'slice.ts'),
  [
    `import { buildPubgStatusPresentation, buildPubgToolPresentation, formatDisplayTime, renderPubgMatchList, renderPubgStats, renderPubgStatus, renderPubgTeamDamage } from '${presentation}';`,
    `import type { PubgMatchListPresentation, PubgRenderOptions, PubgSourceRange, PubgStatsPresentation, PubgTeamDamagePresentation } from '${presentation}';`,
    `import { replyGuideFor } from './reply-guides.ts';`,
    'const jsonResult = (value: unknown) => value;',
    'type ToolEnvelope = any;',
    index.slice(start, end),
    'export { jsonToolResult };',
  ].join('\n'),
);

const { jsonToolResult } = (await import(pathToFileURL(join(dir, 'slice.ts')).href)) as {
  jsonToolResult: (name: string, envelope: unknown, tz: string, share?: unknown) => unknown;
};
const share = (_envelope: unknown, displayText: string) => ({
  text: `${displayText}\n\n🔗 https://share.example/s/AAAAAAAAAAAAAAAAAAAAAA`,
  url: 'https://share.example/s/AAAAAAAAAAAAAAAAAAAAAA',
});
const out = new URL('../tests/golden/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const [name, fixture] of Object.entries(FIXTURES)) {
  for (const withShare of [false, true]) {
    const result = jsonToolResult(fixture.tool, structuredClone(fixture.envelope), 'Asia/Shanghai', withShare ? share : undefined);
    writeFileSync(join(out, `${name}${withShare ? '.share' : ''}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
}
console.log('golden files written to', out);
