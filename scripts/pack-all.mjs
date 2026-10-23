#!/usr/bin/env node
// 构建并打出所有包的 tarball 到 .scratch/tarballs（本地验证用，不发布）。
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const out = new URL('../.scratch/tarballs', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
execSync('pnpm build', { stdio: 'inherit' });
const pkgs = new URL('../packages/', import.meta.url).pathname;
for (const name of readdirSync(pkgs)) {
  execSync(`pnpm pack --pack-destination ${out}`, { cwd: join(pkgs, name), stdio: 'inherit' });
}
console.log('tarballs ->', out);
