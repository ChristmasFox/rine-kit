import type { NormalizedMatch, RawTelemetryArchivePort } from '@rine-kit/pubg-domain';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * PUBG's telemetry CDN only serves a match for roughly two weeks, so the useful window is whatever the CDN still
 * answers for. The cap bounds one run; expired assets (HTTP 403/404/410) are counted as missing, not retried.
 */
export const HISTORICAL_TELEMETRY_BACKFILL_LIMIT = 500;

export function isExpiredTelemetryAsset(error: unknown): boolean {
  return error instanceof Error && /^pubg_telemetry_http_(403|404|410)$/u.test(error.message);
}

async function canonicalFuturePath(value: string): Promise<string> {
  let current = resolve(value);
  const missingTail: string[] = [];
  while (true) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...missingTail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingTail.push(basename(current));
      current = parent;
    }
  }
}

/** Resolve symlinks in existing parents and keep private captures outside Git. */
export async function assertArchiveOutsideRepository(
  archiveDirectory: string,
  repositoryRoot: string,
): Promise<string> {
  const root = await realpath(repositoryRoot);
  const archive = await canonicalFuturePath(archiveDirectory);
  const relativePath = relative(root, archive);
  const isInsideRepository =
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  if (isInsideRepository) throw new Error('telemetry_archive_must_be_outside_repository');
  return archive;
}

export interface RawTelemetryBackfillResult {
  selectedMatchCount: number;
  eligibleMatchCount: number;
  alreadyArchivedCount: number;
  archivedCount: number;
  missingAssetCount: number;
  failedCount: number;
}

export interface RawTelemetryBackfillOptions {
  limit?: number;
  retries?: number;
  concurrency?: number;
  fetchRaw(match: NormalizedMatch): Promise<Uint8Array>;
  isAllowedUrl?(value: string): boolean;
  wait?(milliseconds: number): Promise<void>;
}

export function selectRecentTelemetryMatches(
  matches: NormalizedMatch[],
  requestedLimit = HISTORICAL_TELEMETRY_BACKFILL_LIMIT,
): NormalizedMatch[] {
  const limit = Math.min(
    HISTORICAL_TELEMETRY_BACKFILL_LIMIT,
    Math.max(0, Math.trunc(requestedLimit)),
  );
  return [...matches]
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp || right.matchId.localeCompare(left.matchId),
    )
    .slice(0, limit);
}

function telemetryJsonIsReadable(raw: Uint8Array): boolean {
  try {
    const payload: unknown = JSON.parse(Buffer.from(raw).toString('utf8'));
    if (Array.isArray(payload)) return true;
    if (!payload || typeof payload !== 'object') return false;
    const object = payload as Record<string, unknown>;
    return (
      Array.isArray(object.events) || Array.isArray(object.data) || Array.isArray(object.telemetry)
    );
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  callback: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await callback(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Backfill is capped at the newest source matches (see the limit constant) with no older fallback. */
export async function backfillRecentRawTelemetry(
  matches: NormalizedMatch[],
  archive: RawTelemetryArchivePort,
  options: RawTelemetryBackfillOptions,
): Promise<RawTelemetryBackfillResult> {
  const limit = Math.min(
    HISTORICAL_TELEMETRY_BACKFILL_LIMIT,
    Math.max(0, Math.trunc(options.limit ?? HISTORICAL_TELEMETRY_BACKFILL_LIMIT)),
  );
  const retries = Math.min(5, Math.max(1, Math.trunc(options.retries ?? 3)));
  const concurrency = Math.min(4, Math.max(1, Math.trunc(options.concurrency ?? 2)));
  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const selected = selectRecentTelemetryMatches(matches, limit);
  const counts: RawTelemetryBackfillResult = {
    selectedMatchCount: selected.length,
    eligibleMatchCount: 0,
    alreadyArchivedCount: 0,
    archivedCount: 0,
    missingAssetCount: 0,
    failedCount: 0,
  };
  const eligible: NormalizedMatch[] = [];
  for (const match of selected) {
    const url = match.telemetryUrl;
    if (!url || (options.isAllowedUrl && !options.isAllowedUrl(url))) {
      counts.missingAssetCount += 1;
      continue;
    }
    eligible.push(match);
  }
  counts.eligibleMatchCount = eligible.length;

  await mapWithConcurrency(eligible, concurrency, async (match) => {
    let forceRefresh = false;
    try {
      const cached = await archive.read(match.matchId);
      if (cached) {
        if (telemetryJsonIsReadable(cached)) counts.alreadyArchivedCount += 1;
        else forceRefresh = true;
        if (!forceRefresh) return;
      }
    } catch {
      counts.failedCount += 1;
      return;
    }
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const fetchRaw = () => options.fetchRaw(match);
        const raw = forceRefresh
          ? await archive.refresh(match.matchId, fetchRaw)
          : await archive.getOrFetch(match.matchId, fetchRaw);
        if (!telemetryJsonIsReadable(raw)) {
          forceRefresh = true;
          throw new Error('telemetry_response_json_invalid');
        }
        counts.archivedCount += 1;
        return;
      } catch (error) {
        if (isExpiredTelemetryAsset(error)) {
          counts.missingAssetCount += 1;
          return;
        }
        if (attempt === retries) {
          counts.failedCount += 1;
          return;
        }
        await wait(Math.min(500 * 2 ** (attempt - 1), 4000));
      }
    }
  });
  return counts;
}
