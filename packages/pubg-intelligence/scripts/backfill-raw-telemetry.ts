import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync, statSync } from 'node:fs';
import { PubgApiTelemetryDownloader, SqlitePubgRepository } from '@rine-kit/pubg-domain';
import { RawTelemetryArchive } from '../src/raw-telemetry-archive.js';
import {
  assertArchiveOutsideRepository,
  backfillRecentRawTelemetry,
  HISTORICAL_TELEMETRY_BACKFILL_LIMIT,
} from '../src/raw-telemetry-backfill.js';

function allowedTelemetryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'telemetry-cdn.pubg.com' &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const configuredSource = process.env.PUBG_INTELLIGENCE_DB?.trim();
  if (!configuredSource) throw new Error('PUBG_INTELLIGENCE_DB_REQUIRED_READ_ONLY_SNAPSHOT');
  const sourcePath = realpathSync(configuredSource);
  if (!statSync(sourcePath).isFile()) throw new Error('PUBG_INTELLIGENCE_DB_INVALID');
  const archiveDirectory =
    process.env.PUBG_TELEMETRY_ARCHIVE_DIR?.trim() ||
    join(homedir(), '.local', 'share', 'amadeus', 'pubg-telemetry-archive');
  const repositoryRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const archivePath = await assertArchiveOutsideRepository(archiveDirectory, repositoryRoot);
  if (archivePath === sourcePath)
    throw new Error('telemetry_archive_must_be_separate_from_source_snapshot');

  const repository = new SqlitePubgRepository(sourcePath, { readOnly: true });
  let matches;
  try {
    // The SQL query is newest-first; this candidate window contains the latest
    // 10,000 source rows, after which the backfill itself caps at the historical limit.
    matches = repository.listMatches({ limit: 10000, order: 'desc' });
  } finally {
    repository.close();
  }

  const requestedLimit = Number(process.env.PUBG_TELEMETRY_BACKFILL_LIMIT);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(HISTORICAL_TELEMETRY_BACKFILL_LIMIT, Math.trunc(requestedLimit))
      : HISTORICAL_TELEMETRY_BACKFILL_LIMIT;
  const archive = new RawTelemetryArchive(archivePath);
  const downloader = new PubgApiTelemetryDownloader({
    apiKey: '',
    timeoutMs: 60_000,
    fetchImpl: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  const result = await backfillRecentRawTelemetry(matches, archive, {
    limit,
    retries: 3,
    concurrency: 2,
    isAllowedUrl: allowedTelemetryUrl,
    fetchRaw: async (match) => {
      const payload = await downloader.download(match);
      if (Buffer.isBuffer(payload)) return payload;
      if (payload instanceof Uint8Array) return payload;
      throw new Error('telemetry_downloader_did_not_return_raw_bytes');
    },
  });
  console.log(JSON.stringify({ sourceReadOnly: true, historicalLimit: limit, ...result }));
  if (result.failedCount > 0) process.exitCode = 1;
}

main().catch(() => {
  console.error('RAW_TELEMETRY_BACKFILL=failed');
  process.exitCode = 1;
});
