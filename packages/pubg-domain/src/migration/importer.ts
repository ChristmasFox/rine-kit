import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { TelemetryFeatureRecord } from '../review/telemetry.js';
import type { NormalizedMatch } from '../data/model.js';
import { normalizeRecords } from '../data/model.js';
import { SqlitePubgRepository } from '../storage/sqlite-repository.js';

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

export interface LegacyImportOptions {
  n8nDatabasePath?: string;
  stateJsonPath?: string;
  featuresJsonPath?: string;
  migrationId?: string;
  now?: Date;
  apply?: boolean;
}

export interface LegacyImportReport {
  migrationId: string;
  apply: boolean;
  sources: Array<{ source: string; rows: number; usable: number; errors: number }>;
  inputMatchRows: number;
  uniqueMatchIds: number;
  inserted: number;
  updated: number;
  duplicateInputs: number;
  invalidInputs: number;
  featureRows: number;
  importedFeatures: number;
  orphanFeatures: number;
  errors: Array<{ source: string; message: string }>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJson(value: unknown): unknown | null {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isMatchCandidate(value: unknown): boolean {
  const item = objectValue(value);
  return (
    Boolean(String(item.matchId ?? '').trim()) &&
    Array.isArray(item.players) &&
    Boolean(item.createdAt || item.timestamp) &&
    Boolean(item.mapName || item.gameMode)
  );
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function collectMatches(value: unknown, target: unknown[] = []): unknown[] {
  if (isMatchCandidate(value)) target.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collectMatches(item, target);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>))
      collectMatches(child, target);
  }
  return target;
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function readN8nMatches(
  path: string,
  errors: LegacyImportReport['errors'],
): { rows: unknown[]; tables: number } {
  const database = new DatabaseSync('file:' + path + '?mode=ro');
  const rows: unknown[] = [];
  let tables = 0;
  try {
    const names = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'data_table_user_%'",
      )
      .all();
    for (const row of names) {
      const table = String(row.name ?? '');
      if (!table) continue;
      const columns = database
        .prepare('PRAGMA table_info(' + quoteIdentifier(table) + ')')
        .all()
        .map((item) => String(item.name ?? ''));
      if (!columns.includes('payload')) continue;
      tables += 1;
      try {
        const values = database.prepare('SELECT payload FROM ' + quoteIdentifier(table)).all();
        for (const value of values) {
          const parsed = parseJson(value.payload);
          if (parsed === null && typeof value.payload === 'string') {
            errors.push({ source: 'n8n:' + table, message: 'invalid_payload_json' });
            continue;
          }
          if (isMatchCandidate(parsed)) rows.push(parsed);
        }
      } catch (error) {
        errors.push({
          source: 'n8n:' + table,
          message: error instanceof Error ? error.message : 'table_read_failed',
        });
      }
    }
  } finally {
    database.close();
  }
  return { rows, tables };
}

function featureRecords(value: unknown): TelemetryFeatureRecord[] {
  const root = objectValue(value);
  const values = Object.values(objectValue(root.features));
  return values.flatMap((item) => {
    const record = objectValue(item);
    const matchId = String(record.matchId ?? '').trim();
    const parserVersion = String(record.parserVersion ?? '').trim();
    const featureVersion = String(record.featureVersion ?? '').trim();
    const facts = record.facts;
    if (!matchId || !parserVersion || !featureVersion || !facts || typeof facts !== 'object')
      return [];
    return [
      {
        matchId,
        parserVersion,
        featureVersion,
        facts: facts as TelemetryFeatureRecord['facts'],
        createdAt: String(record.createdAt ?? new Date(0).toISOString()),
      },
    ];
  });
}

export function importLegacyPubgData(
  repository: SqlitePubgRepository,
  options: LegacyImportOptions = {},
): LegacyImportReport {
  const now = options.now ?? new Date();
  const migrationId =
    options.migrationId ?? 'pubg-legacy-' + now.toISOString().replace(/[^0-9]/g, '');
  const errors: LegacyImportReport['errors'] = [];
  const sources: LegacyImportReport['sources'] = [];
  const matchRows: unknown[] = [];
  if (options.n8nDatabasePath) {
    try {
      const result = readN8nMatches(options.n8nDatabasePath, errors);
      matchRows.push(...result.rows);
      sources.push({
        source: 'n8n:data-tables:' + result.tables,
        rows: result.rows.length,
        usable: result.rows.length,
        errors: errors.length,
      });
    } catch (error) {
      errors.push({
        source: 'n8n',
        message: error instanceof Error ? error.message : 'n8n_read_failed',
      });
      sources.push({ source: 'n8n', rows: 0, usable: 0, errors: 1 });
    }
  }
  if (options.stateJsonPath) {
    try {
      const rows = collectMatches(readJson(options.stateJsonPath));
      matchRows.push(...rows);
      sources.push({
        source: 'runtime-state-json',
        rows: rows.length,
        usable: rows.length,
        errors: 0,
      });
    } catch (error) {
      errors.push({
        source: 'runtime-state-json',
        message: error instanceof Error ? error.message : 'state_read_failed',
      });
      sources.push({ source: 'runtime-state-json', rows: 0, usable: 0, errors: 1 });
    }
  }
  const normalizedRows = matchRows.flatMap((row) => normalizeRecords([row]));
  const normalized = normalizeRecords(matchRows);
  const uniqueIds = new Set(normalized.map((match) => match.matchId));
  const duplicateInputs = Math.max(0, normalizedRows.length - uniqueIds.size);
  const invalidInputs = Math.max(0, matchRows.length - normalizedRows.length);
  const shouldApply = options.apply === true;
  const write = shouldApply
    ? repository.upsertMatches(normalized, {
        source: 'legacy-import',
        fetchedAt: now.toISOString(),
      })
    : { inserted: 0, updated: 0, duplicateInputs, invalidInputs };

  let featureRows = 0;
  let importedFeatures = 0;
  let orphanFeatures = 0;
  if (options.featuresJsonPath) {
    try {
      const features = featureRecords(readJson(options.featuresJsonPath));
      featureRows = features.length;
      const importedMatchIds = new Set(normalized.map((match) => match.matchId));
      for (const feature of features) {
        if (!importedMatchIds.has(feature.matchId)) orphanFeatures += 1;
        if (shouldApply) {
          awaitableSet(repository, feature);
          importedFeatures += 1;
        }
      }
      sources.push({
        source: 'runtime-features-json',
        rows: featureRows,
        usable: features.length,
        errors: 0,
      });
    } catch (error) {
      errors.push({
        source: 'runtime-features-json',
        message: error instanceof Error ? error.message : 'features_read_failed',
      });
      sources.push({ source: 'runtime-features-json', rows: 0, usable: 0, errors: 1 });
    }
  }
  const report: LegacyImportReport = {
    migrationId,
    apply: shouldApply,
    sources,
    inputMatchRows: matchRows.length,
    uniqueMatchIds: uniqueIds.size,
    inserted: write.inserted,
    updated: write.updated,
    duplicateInputs,
    invalidInputs,
    featureRows,
    importedFeatures,
    orphanFeatures,
    errors,
  };
  if (shouldApply) {
    repository.recordMigration(
      migrationId,
      'legacy-pubg-runtime-and-n8n',
      report,
      now.toISOString(),
      new Date().toISOString(),
    );
  }
  return report;
}

function awaitableSet(repository: SqlitePubgRepository, record: TelemetryFeatureRecord): void {
  // DatabaseSync writes synchronously; keep the importer API synchronous for a
  // one-time CLI and for idempotence tests.
  const statement = repository.db.prepare(
    'INSERT INTO telemetry_features(match_id, parser_version, feature_version, facts_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(match_id, parser_version, feature_version) DO UPDATE SET facts_json=excluded.facts_json, created_at=excluded.created_at',
  );
  statement.run(
    record.matchId,
    record.parserVersion,
    record.featureVersion,
    JSON.stringify(record.facts),
    record.createdAt,
  );
}

export function legacyMatchRecordsForMigration(value: unknown): NormalizedMatch[] {
  return normalizeRecords(collectMatches(value));
}
