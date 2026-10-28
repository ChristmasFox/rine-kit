import { RawTelemetryArchive } from '@rine-kit/pubg-intelligence/archive';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalysisCache } from './analysis-cache.js';
import { WorkerPool } from './analysis-pool.js';
import type { MatchTelemetryAnalysis } from './match-analysis.js';

const ARCHIVE_LIST_TTL_MS = 30_000;

/**
 * What the share page needs to turn a stored match into its story: the raw telemetry archive (shared with the sync
 * worker), a worker pool for the CPU-bound parsing, and caches. Holds no database and no secrets.
 */
export class StoryContext {
  readonly archive: RawTelemetryArchive;
  readonly pool: WorkerPool;
  readonly cache: AnalysisCache;
  readonly telemetry = new Map<string, Promise<MatchTelemetryAnalysis | 'missing' | 'failed'>>();
  private archived: { at: number; ids: ReadonlySet<string> } | null = null;

  constructor(
    readonly archiveDirectory: string,
    cacheDirectory: string,
    cacheVersion: string,
    workers = 2,
    workerExecArgv: string[] = [],
  ) {
    this.archive = new RawTelemetryArchive(archiveDirectory);
    this.pool = new WorkerPool(
      new URL(`./analysis-worker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url),
      workers,
      workerExecArgv,
    );
    this.cache = new AnalysisCache(join(cacheDirectory, 'analysis-cache'), cacheVersion);
  }

  /** Match ids with a verified archive entry, re-read at most every 30 seconds (the prefetch adds entries). */
  async archivedIds(): Promise<ReadonlySet<string>> {
    if (this.archived && Date.now() - this.archived.at < ARCHIVE_LIST_TTL_MS)
      return this.archived.ids;
    const ids = new Set(await this.archive.listMatchIds());
    this.archived = { at: Date.now(), ids };
    return ids;
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}

/** Bump when match-analysis.ts or the story code changes what a stored result means. */
const LOCAL_ANALYSIS_REVISION = 1;

/**
 * Names the analysis cache: stored results are reused only while the telemetry analysers (the installed
 * @rine-kit/pubg-intelligence version) and this package's revision are the same, so stale results are never served.
 */
export function analysisCacheVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.resolve('@rine-kit/pubg-intelligence')));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === '@rine-kit/pubg-intelligence')
        return `kit${pkg.version}-r${LOCAL_ANALYSIS_REVISION}`;
    } catch {
      // keep walking up
    }
    directory = dirname(directory);
  }
  return `kit-unknown-r${LOCAL_ANALYSIS_REVISION}`;
}
