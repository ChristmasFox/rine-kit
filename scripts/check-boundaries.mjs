#!/usr/bin/env node
// 公共包边界检查：不得依赖 RINE 私有源码、LiveKit、OpenClaw 或 Lab 内部包（AGENTS.md「架构边界」）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../packages/', import.meta.url).pathname;
const FORBIDDEN = [/^@rine\//, /^@agent\//, /^livekit/, /^@livekit\//, /^openclaw/, /^@openclaw\//];
const problems = [];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|mts|js|mjs)$/.test(name)) yield p;
  }
}

for (const pkg of readdirSync(root)) {
  const dir = join(root, pkg);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (FORBIDDEN.some((re) => re.test(dep))) problems.push(`${manifest.name}: ${field} -> ${dep}`);
    }
  }
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (FORBIDDEN.some((re) => re.test(spec))) problems.push(`${file.slice(root.length)}: imports ${spec}`);
    }
  }
}

if (problems.length) {
  console.error('BOUNDARY_CHECK_FAIL');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log(`boundary check ok (${readdirSync(root).length} packages)`);
