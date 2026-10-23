import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { RawTelemetryArchive } from '../src/raw-telemetry-archive.js';

test('raw telemetry archives gzip complete bodies, deduplicate Match IDs and verify both hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubg-telemetry-archive-'));
  const archive = new RawTelemetryArchive(join(root, 'archive'));
  const matchId = 'match-fixture-01';
  const raw = Buffer.from('[{"_T":"LogPlayerTakeDamage","opaque":"kept byte for byte"}]\n', 'utf8');
  try {
    let loads = 0;
    const [first, concurrent] = await Promise.all([
      archive.getOrFetch(matchId, async () => {
        loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return raw;
      }),
      new RawTelemetryArchive(join(root, 'archive')).getOrFetch(matchId, async () => {
        loads += 1;
        return raw;
      }),
    ]);
    assert.deepEqual(first, raw);
    assert.deepEqual(concurrent, raw);
    assert.equal(loads, 1);
    assert.deepEqual(await archive.read(matchId), raw);
    assert.deepEqual(await archive.listMatchIds(), [matchId]);

    const entries = await readdir(join(root, 'archive'));
    assert.equal(entries.filter((entry) => entry !== '.locks').length, 1);
    const matchDirectory = join(
      root,
      'archive',
      entries.find((entry) => entry !== '.locks')!,
    );
    const manifest = JSON.parse(await readFile(join(matchDirectory, 'manifest.json'), 'utf8')) as {
      schema: string;
      matchId: string;
      captures: Array<{
        rawSha256: string;
        rawBytes: number;
        gzipSha256: string;
        gzipBytes: number;
      }>;
    };
    assert.equal(manifest.schema, 'pubg-raw-telemetry-archive-v1');
    assert.equal(manifest.matchId, matchId);
    assert.equal(manifest.captures.length, 1);
    const capture = manifest.captures[0]!;
    const compressed = await readFile(join(matchDirectory, `${capture.rawSha256}.json.gz`));
    assert.deepEqual(gunzipSync(compressed), raw);
    assert.equal(compressed.byteLength, capture.gzipBytes);
    assert.equal(raw.byteLength, capture.rawBytes);
    await archive.write(matchId, raw);
    const unchanged = JSON.parse(
      await readFile(join(matchDirectory, 'manifest.json'), 'utf8'),
    ) as typeof manifest;
    assert.equal(unchanged.captures.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('different response bytes for one Match ID are retained as immutable captures under one deduplicated entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubg-telemetry-revisions-'));
  const archive = new RawTelemetryArchive(join(root, 'archive'));
  try {
    await archive.write('match-fixture-02', Buffer.from('[{"revision":1}]'));
    await archive.write('match-fixture-02', Buffer.from('[{"revision":2}]'));
    assert.equal(
      Buffer.from((await archive.read('match-fixture-02'))!).toString(),
      '[{"revision":2}]',
    );
    assert.deepEqual(await archive.listMatchIds(), ['match-fixture-02']);
    const matchDirectory = join(
      root,
      'archive',
      (await readdir(join(root, 'archive'))).find((entry) => entry !== '.locks')!,
    );
    const manifest = JSON.parse(await readFile(join(matchDirectory, 'manifest.json'), 'utf8')) as {
      captures: unknown[];
    };
    assert.equal(manifest.captures.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed loaders leave no capture and can retry; corrupt gzip fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubg-telemetry-retry-'));
  const directory = join(root, 'archive');
  const archive = new RawTelemetryArchive(directory);
  try {
    await assert.rejects(
      archive.getOrFetch('match-fixture-03', async () => {
        throw new Error('network-failure');
      }),
      /network-failure/u,
    );
    assert.equal(await archive.read('match-fixture-03'), null);
    const raw = Buffer.from('[{"retry":true}]');
    assert.deepEqual(await archive.getOrFetch('match-fixture-03', async () => raw), raw);
    const matchDirectory = join(
      directory,
      (await readdir(directory)).find((entry) => entry !== '.locks')!,
    );
    const manifest = JSON.parse(await readFile(join(matchDirectory, 'manifest.json'), 'utf8')) as {
      captures: Array<{ rawSha256: string }>;
    };
    const payload = join(matchDirectory, `${manifest.captures[0]!.rawSha256}.json.gz`);
    const compressed = await readFile(payload);
    const lastByte = compressed.length - 1;
    compressed[lastByte] = compressed[lastByte]! ^ 0xff;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(payload, compressed);
    await assert.rejects(
      archive.read('match-fixture-03'),
      /telemetry_archive_gzip_integrity_failed/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('archive rejects unsafe Match IDs without creating entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubg-telemetry-id-'));
  const archive = new RawTelemetryArchive(join(root, 'archive'));
  try {
    await assert.rejects(
      archive.write('../outside', Buffer.from('x')),
      /telemetry_archive_match_id_invalid/u,
    );
    assert.equal((await readdir(root)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
