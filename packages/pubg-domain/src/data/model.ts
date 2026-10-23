import type { Coverage, DataStatus, Evidence, SourceInfo } from '../schema/status.js';
import type { CanonicalQuery, Metric, Selector } from '../schema/query.js';
import type { MatchPickerModel, MatchReviewResult } from '../review/types.js';

export interface NormalizedPlayer {
  accountId: string;
  playerName: string;
  displayName: string;
  rank: number | null;
  kills: number;
  assists: number;
  damage: number;
  dbnos: number;
  revives: number;
  headshotKills: number;
  survivalTime: number;
  longestKill: number;
  deaths: number | null;
  deathSemantics: 'explicit' | 'placement_proxy' | 'unknown';
}

export interface NormalizedMatch {
  schemaVersion: number;
  matchId: string;
  shard: string;
  createdAt: string | null;
  timestamp: number;
  matchType: string;
  gameMode: string;
  isCompetitive: boolean;
  mapName: string;
  duration: number;
  patchVersion: string;
  players: NormalizedPlayer[];
  telemetryUrl?: string | null;
}

export interface DataLayerResult {
  records: NormalizedMatch[];
  coverage: Coverage;
  source: SourceInfo;
  diagnostics?: Record<string, unknown>;
}

export interface QueryRow {
  key: string;
  label: string;
  groupBy: 'player' | 'match' | 'day' | 'map' | 'mode' | 'team';
  metrics: Record<string, number | null | string>;
  matchId?: string;
  timestamp?: number | null;
  createdAt?: string | null;
  mapName?: string;
  gameMode?: string;
  duration?: number;
  players?: NormalizedPlayer[];
  activityStatus?: 'ACTIVE' | 'NO_ACTIVITY';
  bestRank?: number | null;
  position?: number;
  tied?: boolean;
  comparisonRatios?: Record<string, number | null>;
}

export interface OperationData {
  operation: CanonicalQuery['operation'];
  groupBy: CanonicalQuery['groupBy'];
  metric?: Metric;
  direction?: 'asc' | 'desc';
  rows: QueryRow[];
  summary: Record<string, unknown>;
  segments?: Array<{
    label: string;
    selector: Selector;
    rows: QueryRow[];
    summary: Record<string, unknown>;
  }>;
  dailySeries?: QueryRow[];
  change?: Record<string, unknown>;
  highlights?: Record<string, QueryRow[]>;
}

export interface StructuredResult {
  queryId: string;
  sessionId: string;
  status: DataStatus;
  data: OperationData;
  coverage: Coverage;
  source: SourceInfo;
  evidence: Evidence;
  resultSetId?: string;
  diagnostics: Record<string, unknown>;
  review?: MatchReviewResult;
  matchPicker?: MatchPickerModel;
}

export interface ResultSetRecord {
  id: string;
  queryId: string;
  sessionId: string;
  resolvedQuery: CanonicalQuery;
  resolvedSelector: Selector;
  playerIds: string[];
  matchIds: string[];
  rows: QueryRow[];
  aggregates: Record<string, unknown>;
  rankings: QueryRow[];
  coverage: Coverage;
  status: DataStatus;
  source: SourceInfo;
  createdAt: string;
  expiresAt: string;
}

export interface SessionContextRecord {
  schemaVersion: 3;
  sessionId: string;
  activeDomain: 'pubg' | 'homehub' | null;
  lastQuery: CanonicalQuery | null;
  lastSelector: Selector | null;
  lastResultSetId: string | null;
  lastSubject: CanonicalQuery['subject'] | null;
  references: Record<string, unknown>;
  activeMatchId?: string | null;
  activeMatchOrdinal?: number | null;
  activeReviewResultSetId?: string | null;
  sourceMatchResultSetId?: string | null;
  updatedAt: string;
  expiresAt: string;
}

export function numberOr(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberOrNullable(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePlayer(value: unknown): NormalizedPlayer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const accountId = String(raw.accountId ?? raw.playerId ?? '').trim();
  if (!accountId) return null;
  const playerName = String(raw.playerName ?? raw.displayName ?? accountId);
  const displayName = String(raw.displayName ?? playerName);
  const rankValue = numberOrNullable(raw.rank ?? raw.winPlace);
  const rank = rankValue !== null && rankValue > 0 ? rankValue : null;
  const hasDeaths = Object.prototype.hasOwnProperty.call(raw, 'deaths');
  const explicitDeaths = numberOrNullable(raw.deaths);
  const rawSemantics = String(raw.deathSemantics ?? '').trim();
  const knownSemantics =
    rawSemantics === 'explicit' || rawSemantics === 'placement_proxy' || rawSemantics === 'unknown'
      ? rawSemantics
      : null;

  // The PUBG match API does not expose a death counter. Older n8n rows omit
  // `deaths`, so derive the documented one-death-per-elimination proxy from
  // placement instead of silently turning every row into deaths=0/KD=∞.
  const deaths = hasDeaths ? explicitDeaths : rank === null ? null : rank > 1 ? 1 : 0;
  const deathSemantics: NormalizedPlayer['deathSemantics'] =
    knownSemantics ??
    (hasDeaths && explicitDeaths !== null
      ? 'explicit'
      : deaths === null
        ? 'unknown'
        : 'placement_proxy');

  return {
    accountId,
    playerName,
    displayName,
    rank,
    kills: Math.max(0, numberOr(raw.kills)),
    assists: Math.max(0, numberOr(raw.assists)),
    damage: Math.max(0, numberOr(raw.damage ?? raw.damageDealt)),
    dbnos: Math.max(0, numberOr(raw.dbnos ?? raw.DBNOs)),
    revives: Math.max(0, numberOr(raw.revives)),
    headshotKills: Math.max(0, numberOr(raw.headshotKills)),
    survivalTime: Math.max(0, numberOr(raw.survivalTime ?? raw.timeSurvived)),
    longestKill: Math.max(0, numberOr(raw.longestKill)),
    deaths: deaths === null ? null : Math.max(0, deaths),
    deathSemantics,
  };
}

export function normalizeRecords(records: unknown[]): NormalizedMatch[] {
  const byMatchId = new Map<string, NormalizedMatch>();
  for (const record of records) {
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      const r = record as Record<string, unknown>;
      const createdAt = r.createdAt ? String(r.createdAt) : null;
      const parsedCreatedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
      const timestamp = numberOr(
        r.timestamp,
        Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : 0,
      );
      const matchType = String(r.matchType ?? '');
      const normalized: NormalizedMatch = {
        schemaVersion: numberOr(r.schemaVersion, 3),
        matchId: String(r.matchId ?? ''),
        shard: String(r.shard ?? ''),
        createdAt,
        timestamp,
        matchType,
        gameMode: String(r.gameMode ?? ''),
        isCompetitive:
          r.isCompetitive === undefined
            ? matchType.toLowerCase() === 'competitive'
            : Boolean(r.isCompetitive),
        mapName: String(r.mapName ?? ''),
        duration: numberOr(r.duration, 0),
        patchVersion: String(r.patchVersion ?? ''),
        players: Array.isArray(r.players)
          ? r.players
              .map(normalizePlayer)
              .filter((player): player is NormalizedPlayer => player !== null)
          : [],
        telemetryUrl: r.telemetryUrl ? String(r.telemetryUrl) : null,
      };
      if (!normalized.matchId) continue;
      const previous = byMatchId.get(normalized.matchId);
      if (
        !previous ||
        normalized.players.length >= previous.players.length ||
        normalized.schemaVersion > previous.schemaVersion
      )
        byMatchId.set(normalized.matchId, normalized);
    }
  }
  return [...byMatchId.values()];
}
