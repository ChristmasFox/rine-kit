import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { RawTelemetryArchivePort } from '@rine-kit/pubg-domain';

export const RAW_TELEMETRY_ARCHIVE_VERSION = 'pubg-raw-telemetry-archive-v1';
const MATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const LOCK_WAIT_MS = 120_000;
const STALE_LOCK_MS = 10 * 60_000;

export interface RawTelemetryCapture {
  rawSha256: string;
  rawBytes: number;
  gzipSha256: string;
  gzipBytes: number;
  archivedAt: string;
}

interface RawTelemetryManifest {
  schema: typeof RAW_TELEMETRY_ARCHIVE_VERSION;
  matchId: string;
  captures: RawTelemetryCapture[];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function matchKey(matchId: string): string {
  if (!MATCH_ID_PATTERN.test(matchId)) throw new Error('telemetry_archive_match_id_invalid');
  return sha256(Buffer.from(matchId, 'utf8'));
}

function isCapture(value: unknown): value is RawTelemetryCapture {
  if (!value || typeof value !== 'object') return false;
  const capture = value as Partial<RawTelemetryCapture>;
  return (
    /^[a-f0-9]{64}$/u.test(capture.rawSha256 ?? '') &&
    /^[a-f0-9]{64}$/u.test(capture.gzipSha256 ?? '') &&
    Number.isSafeInteger(capture.rawBytes) &&
    Number(capture.rawBytes) >= 0 &&
    Number.isSafeInteger(capture.gzipBytes) &&
    Number(capture.gzipBytes) > 0 &&
    typeof capture.archivedAt === 'string' &&
    Number.isFinite(Date.parse(capture.archivedAt))
  );
}

function parseManifest(value: unknown, matchId: string): RawTelemetryManifest {
  if (!value || typeof value !== 'object') throw new Error('telemetry_archive_manifest_invalid');
  const manifest = value as Partial<RawTelemetryManifest>;
  if (
    manifest.schema !== RAW_TELEMETRY_ARCHIVE_VERSION ||
    manifest.matchId !== matchId ||
    !Array.isArray(manifest.captures) ||
    manifest.captures.length === 0 ||
    !manifest.captures.every(isCapture)
  ) {
    throw new Error('telemetry_archive_manifest_invalid');
  }
  return manifest as RawTelemetryManifest;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await syncFile(temporary);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Immutable, Match-ID-keyed gzip storage for complete PUBG telemetry bodies.
 * Unique response bodies for a match are retained as captures; repeated body
 * hashes are deduplicated. Manifest publication and payload publication are
 * atomic, and readers verify both compressed and uncompressed SHA-256 values.
 */
export class RawTelemetryArchive implements RawTelemetryArchivePort {
  private readonly root: string;
  private readonly inFlight = new Map<string, Promise<Uint8Array>>();

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim()) throw new Error('telemetry_archive_directory_required');
    this.root = rootDirectory;
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      throw new Error('telemetry_archive_directory_invalid');
    if (process.getuid && rootInfo.uid !== process.getuid())
      throw new Error('telemetry_archive_owner_invalid');
    if ((rootInfo.mode & 0o077) !== 0) await chmod(this.root, 0o700);
  }

  private directory(matchId: string): string {
    return join(this.root, matchKey(matchId));
  }

  private async readManifest(matchId: string): Promise<RawTelemetryManifest | null> {
    const directory = this.directory(matchId);
    let directoryInfo;
    try {
      directoryInfo = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      throw new Error('telemetry_archive_entry_invalid');
    const manifestPath = join(directory, 'manifest.json');
    let manifestInfo;
    try {
      manifestInfo = await lstat(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
      throw new Error('telemetry_archive_manifest_invalid');
    let value: unknown;
    try {
      value = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    } catch {
      throw new Error('telemetry_archive_manifest_invalid');
    }
    return parseManifest(value, matchId);
  }

  async read(matchId: string): Promise<Uint8Array | null> {
    matchKey(matchId);
    await this.ensureRoot();
    const manifest = await this.readManifest(matchId);
    if (!manifest) return null;
    const directory = this.directory(matchId);
    for (const capture of [...manifest.captures].reverse()) {
      const payloadPath = join(directory, `${capture.rawSha256}.json.gz`);
      let payloadInfo;
      try {
        payloadInfo = await lstat(payloadPath);
      } catch {
        throw new Error('telemetry_archive_payload_missing');
      }
      if (!payloadInfo.isFile() || payloadInfo.isSymbolicLink())
        throw new Error('telemetry_archive_payload_invalid');
      const compressed = await readFile(payloadPath);
      if (
        compressed.byteLength !== capture.gzipBytes ||
        sha256(compressed) !== capture.gzipSha256
      ) {
        throw new Error('telemetry_archive_gzip_integrity_failed');
      }
      let raw: Buffer;
      try {
        raw = gunzipSync(compressed);
      } catch {
        throw new Error('telemetry_archive_gzip_invalid');
      }
      if (raw.byteLength !== capture.rawBytes || sha256(raw) !== capture.rawSha256) {
        throw new Error('telemetry_archive_raw_integrity_failed');
      }
      return raw;
    }
    return null;
  }

  async write(matchId: string, rawInput: Uint8Array): Promise<void> {
    matchKey(matchId);
    await this.ensureRoot();
    const raw = Buffer.from(rawInput);
    const rawSha256 = sha256(raw);
    const directory = this.directory(matchId);
    const payloadPath = join(directory, `${rawSha256}.json.gz`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    let manifest = await this.readManifest(matchId);
    const sameCapture = manifest?.captures.find((capture) => capture.rawSha256 === rawSha256);
    if (sameCapture) {
      const existing = await readFile(payloadPath);
      if (
        existing.byteLength !== sameCapture.gzipBytes ||
        sha256(existing) !== sameCapture.gzipSha256
      ) {
        throw new Error('telemetry_archive_gzip_integrity_failed');
      }
      const decoded = gunzipSync(existing);
      if (decoded.byteLength !== sameCapture.rawBytes || sha256(decoded) !== rawSha256) {
        throw new Error('telemetry_archive_raw_integrity_failed');
      }
      return;
    }

    const compressed = gzipSync(raw, { level: 6 });
    const capture: RawTelemetryCapture = {
      rawSha256,
      rawBytes: raw.byteLength,
      gzipSha256: sha256(compressed),
      gzipBytes: compressed.byteLength,
      archivedAt: new Date().toISOString(),
    };
    try {
      await writeFile(payloadPath, compressed, { flag: 'wx', mode: 0o600 });
      await chmod(payloadPath, 0o600);
      await syncFile(payloadPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(payloadPath);
      if (sha256(existing) !== capture.gzipSha256)
        throw new Error('telemetry_archive_gzip_integrity_failed');
    }
    await syncDirectory(directory);
    manifest = manifest ?? { schema: RAW_TELEMETRY_ARCHIVE_VERSION, matchId, captures: [] };
    manifest.captures.push(capture);
    await atomicJsonWrite(join(directory, 'manifest.json'), manifest);
  }

  async getOrFetch(matchId: string, fetchRaw: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const key = matchKey(matchId);
    const inFlight = this.inFlight.get(`${key}:read`);
    if (inFlight) return inFlight;
    const pending = this.withFileLock(matchId, key, fetchRaw, true);
    this.inFlight.set(`${key}:read`, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(`${key}:read`) === pending) this.inFlight.delete(`${key}:read`);
    }
  }

  async refresh(matchId: string, fetchRaw: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const key = matchKey(matchId);
    const refreshKey = `${key}:refresh`;
    const inFlight = this.inFlight.get(refreshKey);
    if (inFlight) return inFlight;
    const pending = this.withFileLock(matchId, key, fetchRaw, false);
    this.inFlight.set(refreshKey, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(refreshKey) === pending) this.inFlight.delete(refreshKey);
    }
  }

  private async withFileLock(
    matchId: string,
    key: string,
    fetchRaw: () => Promise<Uint8Array>,
    reuseExisting: boolean,
  ): Promise<Uint8Array> {
    await this.ensureRoot();
    if (reuseExisting) {
      const existing = await this.read(matchId);
      if (existing) return existing;
    }
    const lockDirectory = join(this.root, '.locks');
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(lockDirectory, `${key}.lock`);
    const startedAt = Date.now();
    let lockHandle;
    while (!lockHandle) {
      try {
        lockHandle = await open(lockPath, 'wx', 0o600);
        await lockHandle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
        await lockHandle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (reuseExisting) {
          const cached = await this.read(matchId);
          if (cached) return cached;
        }
        try {
          const lockInfo = await stat(lockPath);
          if (Date.now() - lockInfo.mtimeMs > STALE_LOCK_MS) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw lockError;
        }
        if (Date.now() - startedAt > LOCK_WAIT_MS)
          throw new Error('telemetry_archive_lock_timeout');
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    try {
      if (reuseExisting) {
        const cached = await this.read(matchId);
        if (cached) return cached;
      }
      const raw = Buffer.from(await fetchRaw());
      await this.write(matchId, raw);
      return raw;
    } finally {
      await lockHandle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async listMatchIds(): Promise<string[]> {
    await this.ensureRoot();
    const ids: string[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.locks' || !/^[a-f0-9]{64}$/u.test(entry.name))
        continue;
      const directory = join(this.root, entry.name);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const manifestPath = join(directory, 'manifest.json');
      try {
        const value = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
        if (
          !value ||
          typeof value !== 'object' ||
          !('matchId' in value) ||
          typeof value.matchId !== 'string'
        )
          continue;
        const manifest = parseManifest(value, value.matchId);
        if (matchKey(manifest.matchId) === entry.name) ids.push(manifest.matchId);
      } catch {
        // A malformed entry remains on disk for integrity review, but is not indexed.
      }
    }
    return ids.sort();
  }
}
