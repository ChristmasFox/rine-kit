import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Per-match analysis results kept on disk, so a restart (the page restarts whenever the snapshot refreshes) loads
 * them instead of re-parsing every raw telemetry file. Entries are keyed by a version that changes whenever the
 * analysis code does, so stale results are never served; old versions are left in place, never deleted.
 */
export class AnalysisCache {
  private readonly directory: string;

  constructor(
    root: string,
    readonly version: string,
  ) {
    this.directory = join(root, version);
  }

  private path(squadId: string, matchId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(squadId) || !/^[A-Za-z0-9-]{1,64}$/u.test(matchId))
      throw new Error('analysis_cache_key_invalid');
    return join(this.directory, squadId, `${matchId}.json`);
  }

  read<T>(squadId: string, matchId: string): T | null {
    try {
      const file = this.path(squadId, matchId);
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
    } catch {
      return null;
    }
  }

  write(squadId: string, matchId: string, value: unknown): void {
    try {
      const file = this.path(squadId, matchId);
      mkdirSync(join(this.directory, squadId), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      renameSync(temporary, file);
    } catch {
      // The cache is an optimisation; a failed write only costs a recompute.
    }
  }

  /** Number of cached results for a squad (used by tests and diagnostics). */
  count(squadId: string): number {
    try {
      return readdirSync(join(this.directory, squadId)).filter((name) => name.endsWith('.json'))
        .length;
    } catch {
      return 0;
    }
  }
}

function filesUnder(directory: string, extension: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(directory, name);
    const info = statSync(full);
    if (info.isDirectory()) filesUnder(full, extension, out);
    else if (name.endsWith(extension)) out.push(full);
  }
  return out;
}

/** Hash of the built packages and this app's analysis source: any change to the analysis code invalidates the cache. */
export function analysisVersion(
  sourceDirectories: readonly string[],
  extra: readonly string[] = [],
): string {
  const hash = createHash('sha256');
  for (const directory of sourceDirectories) {
    for (const file of filesUnder(directory, '.js'))
      hash.update(file.slice(directory.length)).update(readFileSync(file));
  }
  for (const text of extra) hash.update(text);
  return hash.digest('hex').slice(0, 16);
}
