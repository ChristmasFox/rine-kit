import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { NormalizedMatch } from '@rine-kit/pubg-domain';
import { RawTelemetryArchive } from '../src/raw-telemetry-archive.js';
import {
  assertArchiveOutsideRepository,
  backfillRecentRawTelemetry,
  HISTORICAL_TELEMETRY_BACKFILL_LIMIT,
  selectRecentTelemetryMatches,
} from '../src/raw-telemetry-backfill.js';

function match(
  index: number,
  telemetryUrl: string | null = `https://telemetry-cdn.pubg.com/${index}.json`,
): NormalizedMatch {
  return {
    schemaVersion: 3,
    matchId: `match-${String(index).padStart(3, '0')}`,
    shard: 'steam',
    createdAt: new Date(index * 60_000).toISOString(),
    timestamp: index * 60_000,
    matchType: 'competitive',
    gameMode: 'squad-fpp',
    isCompetitive: true,
    mapName: 'Erangel',
    duration: 1200,
    patchVersion: 'fixture',
    players: [],
    telemetryUrl,
  };
}

test('historical selection is capped at the newest matches and never falls back to older ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubg-telemetry-backfill-'));
  const archive = new RawTelemetryArchive(join(root, 'archive'));
  const extra = 3;
  const total = HISTORICAL_TELEMETRY_BACKFILL_LIMIT + extra;
  const matches = Array.from({ length: total }, (_, index) => match(index));
  let fetchCount = 0;
  const fetchRaw = async (record: NormalizedMatch) => {
    fetchCount += 1;
    return Buffer.from(JSON.stringify([{ matchId: record.matchId }]));
  };
  try {
    assert.equal(
      selectRecentTelemetryMatches(matches, total).length,
      HISTORICAL_TELEMETRY_BACKFILL_LIMIT,
    );
    assert.equal(
      selectRecentTelemetryMatches(matches, total)[0]?.matchId,
      `match-${String(total - 1).padStart(3, '0')}`,
    );
    assert.equal(
      selectRecentTelemetryMatches(matches, total).at(-1)?.matchId,
      `match-${String(extra).padStart(3, '0')}`,
    );
    const result = await backfillRecentRawTelemetry(matches, archive, {
      limit: total,
      fetchRaw,
      isAllowedUrl: (value) => value.startsWith('https://telemetry-cdn.pubg.com/'),
    });
    assert.deepEqual(result, {
      selectedMatchCount: HISTORICAL_TELEMETRY_BACKFILL_LIMIT,
      eligibleMatchCount: HISTORICAL_TELEMETRY_BACKFILL_LIMIT,
      alreadyArchivedCount: 0,
      archivedCount: HISTORICAL_TELEMETRY_BACKFILL_LIMIT,
      missingAssetCount: 0,
      failedCount: 0,
    });
    assert.equal(fetchCount, HISTORICAL_TELEMETRY_BACKFILL_LIMIT);
    const second = await backfillRecentRawTelemetry(matches, archive, { fetchRaw });
    assert.equal(second.alreadyArchivedCount, HISTORICAL_TELEMETRY_BACKFILL_LIMIT);
    assert.equal(second.archivedCount, 0);
    assert.equal(fetchCount, HISTORICAL_TELEMETRY_BACKFILL_LIMIT);
    assert.equal(await archive.read('match-002'), null);
    assert.equal((await archive.read(`match-${String(extra).padStart(3, '0')}`)) !== null, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backfill retries failures, deduplicates concurrent requests and skips missing assets within the same match window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubg-telemetry-backfill-retry-'));
  const archive = new RawTelemetryArchive(join(root, 'archive'));
  let attempts = 0;
  try {
    const result = await backfillRecentRawTelemetry([match(4), match(5, null)], archive, {
      concurrency: 2,
      retries: 3,
      wait: async () => undefined,
      async fetchRaw() {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary-cdn-failure');
        if (attempts === 2) return Buffer.from('not-json');
        return Buffer.from('[{"complete":true}]');
      },
      isAllowedUrl: (value) => value.startsWith('https://telemetry-cdn.pubg.com/'),
    });
    assert.deepEqual(result, {
      selectedMatchCount: 2,
      eligibleMatchCount: 1,
      alreadyArchivedCount: 0,
      archivedCount: 1,
      missingAssetCount: 1,
      failedCount: 0,
    });
    assert.equal(attempts, 3);
    assert.deepEqual(
      Buffer.from((await archive.read('match-004'))!).toString(),
      '[{"complete":true}]',
    );
    assert.equal(await archive.read('match-005'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('private archive path guard rejects repository data paths and resolves symlinked parents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubg-telemetry-path-guard-'));
  const repository = join(root, 'repository');
  const outside = join(root, 'outside');
  try {
    await mkdir(repository);
    await mkdir(outside);
    await symlink(outside, join(repository, 'external-link'));
    const canonicalOutside = await realpath(outside);
    await assert.rejects(
      assertArchiveOutsideRepository(join(repository, 'private-data'), repository),
      /telemetry_archive_must_be_outside_repository/u,
    );
    assert.equal(
      await assertArchiveOutsideRepository(
        join(repository, 'external-link', 'archive'),
        repository,
      ),
      join(canonicalOutside, 'archive'),
    );
    assert.equal(
      await assertArchiveOutsideRepository(join(outside, 'archive'), repository),
      join(canonicalOutside, 'archive'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expired CDN assets count as missing without being retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubg-telemetry-backfill-expired-'));
  const archive = new RawTelemetryArchive(join(root, 'archive'));
  const attempts = new Map<string, number>();
  try {
    const result = await backfillRecentRawTelemetry([match(7), match(8)], archive, {
      retries: 3,
      wait: async () => undefined,
      isAllowedUrl: (value) => value.startsWith('https://telemetry-cdn.pubg.com/'),
      async fetchRaw(record) {
        attempts.set(record.matchId, (attempts.get(record.matchId) ?? 0) + 1);
        if (record.matchId === 'match-007') throw new Error('pubg_telemetry_http_403');
        return Buffer.from('[{"ok":true}]');
      },
    });
    assert.equal(result.missingAssetCount, 1);
    assert.equal(result.archivedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.equal(attempts.get('match-007'), 1);
    assert.equal(await archive.read('match-007'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
