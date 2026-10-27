/*
 * Compares the shape of every PUBG tool's input in Lab's built plugin (plugins/pubg/dist/index.js, TypeBox) with the
 * shared catalogue (zod). Read-only on Lab. Exits 1 when they differ.
 *   LAB_ROOT=~/amadeus-home pnpm --filter @rine-kit/pubg-tools exec tsx scripts/compare-lab-schemas.ts
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { PUBG_TOOLS } from '../src/catalog.ts';
import { schemaShape } from '../src/schema-shape.ts';

const lab = (process.env.LAB_ROOT ?? '').replace(/^~/u, process.env.HOME ?? '');
if (!lab) throw new Error('set LAB_ROOT to the Lab checkout (read only)');
const mod = (await import(pathToFileURL(join(lab, 'plugins/pubg/dist/index.js')).href)) as {
  default: { register(api: unknown): void };
};
const factories: Array<(ctx: unknown) => unknown> = [];
mod.default.register({
  registerTool: (f: (ctx: unknown) => unknown) => factories.push(f),
  on() {}, logger: { info() {}, warn() {}, error() {} }, pluginConfig: {}, config: {}, registerService() {}, registerHook() {}, runtime: {},
});
const labTools = new Map<string, { parameters: unknown; description: string }>();
for (const f of factories) {
  const made = f({});
  for (const t of Array.isArray(made) ? made : [made]) {
    const tool = t as { name: string; parameters: unknown; description: string };
    labTools.set(tool.name, tool);
  }
}
// The built dist can be older than the source, so descriptions are compared with the source's own text.
const labSource = readFileSync(join(lab, 'plugins/pubg/src/index.ts'), 'utf8');
const sourceDescription = (name: string): string | undefined =>
  new RegExp(`name: '${name}',\\s*description: '((?:[^'\\\\]|\\\\.)*)'`, 'u').exec(labSource)?.[1]?.replace(/\\'/gu, "'");
let differences = 0;
for (const spec of PUBG_TOOLS) {
  const lab = labTools.get(spec.name);
  if (!lab) { console.log(`${spec.name}: missing in Lab`); differences++; continue; }
  const kit = schemaShape(z.toJSONSchema(spec.input, { io: 'input' }));
  const theirs = schemaShape(lab.parameters);
  const same = JSON.stringify(kit) === JSON.stringify(theirs);
  const labDescription = sourceDescription(spec.name) ?? lab.description;
  const descSame = labDescription === spec.description;
  console.log(`${spec.name}: schema ${same ? 'identical' : 'DIFFERS'}, description ${descSame ? 'identical' : 'DIFFERS'}`);
  if (!same) {
    differences++;
    console.log('  kit:', JSON.stringify(kit));
    console.log('  lab:', JSON.stringify(theirs));
  }
  if (!descSame) { differences++; console.log('  kit:', spec.description, '\n  lab:', labDescription); }
}
process.exit(differences ? 1 : 0);
