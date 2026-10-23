import type { TeamConfig } from '../config/team.js';
import type { NormalizedMatch } from '../data/model.js';
import { extractMatchReviewFacts } from './review-facts.js';
import type { MatchReviewFacts, ReviewEvidence } from './types.js';

export const DEFAULT_TELEMETRY_PARSER_VERSION = 'telemetry-parser-6';
export const DEFAULT_REVIEW_FEATURE_VERSION = 'review-features-6';

export interface TelemetryFeatureKey {
  matchId: string;
  parserVersion: string;
  featureVersion: string;
}

export interface TelemetryFeatureRecord extends TelemetryFeatureKey {
  facts: MatchReviewFacts;
  createdAt: string;
}

function cacheKey(key: TelemetryFeatureKey): string {
  return [key.matchId, key.parserVersion, key.featureVersion].join(':');
}

function compactEvidence(facts: MatchReviewFacts): ReviewEvidence[] {
  const original = new Map(facts.evidence.map((item) => [item.id, item]));
  const retained: ReviewEvidence[] = [];
  const retainedIds = new Set<string>();
  const add = (
    id: string,
    kind: ReviewEvidence['kind'],
    source: ReviewEvidence['source'],
    eventIds: string[],
    description: string,
  ): void => {
    if (retainedIds.has(id)) return;
    retainedIds.add(id);
    retained.push(
      original.get(id) ?? {
        id,
        kind,
        source,
        eventIds: [...new Set(eventIds)],
        description,
      },
    );
  };

  add(`match-summary-${facts.match.matchId}`, 'FACT', 'match_store', [], 'Match Store 基础战绩');
  facts.weapons.forEach((weapon, index) =>
    add(
      `evidence-weapon-${index + 1}`,
      'DERIVED',
      'telemetry',
      weapon.evidenceIds,
      `${weapon.playerId} 使用 ${weapon.weapon} 的武器统计`,
    ),
  );
  facts.vehicles.forEach((vehicle, index) =>
    add(
      `evidence-vehicle-${index + 1}`,
      'DERIVED',
      'telemetry',
      vehicle.evidenceIds,
      `${vehicle.playerId} 的载具统计`,
    ),
  );
  facts.heavyWeapons.forEach((weapon, index) =>
    add(
      `evidence-heavy-weapon-${index + 1}`,
      'DERIVED',
      'telemetry',
      weapon.evidenceIds,
      `${weapon.playerId} 的 ${weapon.weapon} 统计`,
    ),
  );
  facts.fights.forEach((fight) =>
    add(`evidence-${fight.id}`, 'DERIVED', 'telemetry', fight.evidenceIds, '聚合团战'),
  );
  facts.players.forEach((player) =>
    add(
      `player-summary-${facts.match.matchId}-${player.playerId}`,
      'FACT',
      'match_store',
      [],
      `${player.playerName} 的 Match Store 基础战绩`,
    ),
  );
  facts.players
    .flatMap((player) => player.keyOperations)
    .forEach((operation) =>
      add(
        `evidence-${operation.id}`,
        'DERIVED',
        'telemetry',
        operation.evidenceIds,
        operation.impact,
      ),
    );
  facts.specialEvents.forEach((event) =>
    add(`evidence-${event.id}`, 'DERIVED', 'telemetry', event.evidenceIds, event.impact),
  );
  facts.teamDamage?.forEach((fact) =>
    add(
      `evidence-${fact.id}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.actorPlayerId} 对 ${fact.victimPlayerId} 的队友伤害事实`,
    ),
  );
  facts.teamVehicleEvents?.forEach((fact) =>
    add(
      `evidence-${fact.id}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.actorPlayerId} 对 ${fact.victimPlayerId} 的车辆队伤事实`,
    ),
  );
  facts.flash?.forEach((fact) =>
    add(
      `evidence-flash-${fact.playerId}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.playerId} 的闪光弹使用事实`,
    ),
  );
  facts.stunGuns?.forEach((fact) =>
    add(
      `evidence-${fact.id}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.playerId} 的电击枪使用事实`,
    ),
  );
  facts.recovery?.forEach((fact) =>
    add(
      `evidence-${fact.id}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.playerId} 的恢复/能量物品使用事实`,
    ),
  );
  facts.loot?.forEach((fact) =>
    add(
      `evidence-${fact.id}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.playerId} 的死亡盒搜包事实`,
    ),
  );
  facts.lootActivity?.forEach((fact) =>
    add(
      `evidence-${fact.id}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.playerId} 的物资拾取与丢弃事实`,
    ),
  );
  facts.vehicleTrunk?.forEach((fact) =>
    add(
      `evidence-${fact.id}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.playerId} 的载具仓库${fact.direction === 'PUT' ? '存入' : '取出'}事实`,
    ),
  );
  facts.environment?.forEach((fact) =>
    add(
      `evidence-${fact.id}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.playerId} 的环境互动事实`,
    ),
  );
  facts.armorBreaks?.forEach((fact) =>
    add(
      `evidence-${fact.id}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.actorPlayerId} 的护甲破坏事实`,
    ),
  );
  facts.vehicleImpacts?.forEach((fact) =>
    add(
      `evidence-${fact.id}`,
      'DERIVED',
      'telemetry',
      fact.evidenceIds,
      `${fact.playerId} 的载具攻击组合事实`,
    ),
  );
  return retained;
}

/**
 * Keep durable review facts and evidence references, but not the event stream.
 * The normalized stream is needed during extraction only and can dominate the
 * feature file without adding anything to the rendered review.
 */
export function compactReviewFactsForFeatureStore(facts: MatchReviewFacts): MatchReviewFacts {
  const compacted = structuredClone(facts);
  compacted.combat.events = [];
  compacted.evidence = compactEvidence(compacted);
  return compacted;
}

function compactFeatureRecord(record: TelemetryFeatureRecord): TelemetryFeatureRecord {
  return { ...record, facts: compactReviewFactsForFeatureStore(record.facts) };
}

export interface TelemetryFeatureStore {
  get(key: TelemetryFeatureKey): Promise<TelemetryFeatureRecord | null>;
  set(record: TelemetryFeatureRecord): Promise<void>;
}

export class InMemoryTelemetryFeatureStore implements TelemetryFeatureStore {
  private readonly values = new Map<string, TelemetryFeatureRecord>();

  async get(key: TelemetryFeatureKey): Promise<TelemetryFeatureRecord | null> {
    const value = this.values.get(cacheKey(key));
    return value ? structuredClone(value) : null;
  }

  async set(record: TelemetryFeatureRecord): Promise<void> {
    this.values.set(cacheKey(record), structuredClone(record));
  }
}

export interface TelemetryDownloader {
  download(match: NormalizedMatch, signal?: AbortSignal): Promise<unknown>;
}

/** Storage boundary for the complete response body; implementations live outside the Domain. */
export interface RawTelemetryArchivePort {
  read(matchId: string): Promise<Uint8Array | null>;
  write(matchId: string, raw: Uint8Array): Promise<void>;
  getOrFetch(matchId: string, fetchRaw: () => Promise<Uint8Array>): Promise<Uint8Array>;
  refresh(matchId: string, fetchRaw: () => Promise<Uint8Array>): Promise<Uint8Array>;
}

export interface PubgApiTelemetryDownloaderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  archive?: RawTelemetryArchivePort;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function authorizationValue(apiKey: string): string {
  const value = apiKey.trim();
  return /^Bearer\s+/iu.test(value) ? value : `Bearer ${value}`;
}

function telemetryBodyHasJsonShape(raw: Uint8Array): boolean {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw).toString('utf8'));
    if (Array.isArray(value)) return true;
    if (!value || typeof value !== 'object') return false;
    const object = value as Record<string, unknown>;
    return (
      Array.isArray(object.events) || Array.isArray(object.data) || Array.isArray(object.telemetry)
    );
  } catch {
    return false;
  }
}

export class PubgApiTelemetryDownloader implements TelemetryDownloader {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: PubgApiTelemetryDownloaderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? 'https://api.pubg.com').replace(/\/$/u, '');
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private async get(url: string, authorize = true, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      const headers = new Headers({ accept: 'application/json' });
      if (authorize) headers.set('authorization', authorizationValue(this.options.apiKey));
      const response = await this.fetchImpl(url, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`pubg_telemetry_http_${response.status}`);
      return response;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async download(match: NormalizedMatch, signal?: AbortSignal): Promise<unknown> {
    const fetchRaw = async (): Promise<Uint8Array> => {
      const detailResponse = match.telemetryUrl
        ? null
        : await this.get(
            `${this.baseUrl}/shards/${encodeURIComponent(match.shard)}/matches/${encodeURIComponent(match.matchId)}`,
            true,
            signal,
          );
      let telemetryUrl = match.telemetryUrl ?? null;
      if (!telemetryUrl && detailResponse) {
        const body = objectValue(await detailResponse.json());
        const included = Array.isArray(body.included) ? body.included : [];
        const relationships = objectValue(objectValue(body.data).relationships);
        const assets = Array.isArray(objectValue(relationships.assets).data)
          ? (objectValue(relationships.assets).data as unknown[])
          : [];
        const assetIds = new Set(assets.map((asset) => String(objectValue(asset).id ?? '')));
        const asset = included.find(
          (item) =>
            objectValue(item).type === 'asset' &&
            (assetIds.size === 0 || assetIds.has(String(objectValue(item).id ?? ''))),
        );
        telemetryUrl =
          String(
            objectValue(objectValue(asset).attributes).URL ??
              objectValue(objectValue(asset).attributes).url ??
              '',
          ) || null;
      }
      if (!telemetryUrl) throw new Error('telemetry_asset_not_found');
      // PUBG returns a signed asset URL; never forward the API credential to it.
      // Save the complete body before JSON or feature parsing can discard anything.
      const response = await this.get(telemetryUrl, false, signal);
      return new Uint8Array(await response.arrayBuffer());
    };
    let raw = this.options.archive
      ? await this.options.archive.getOrFetch(match.matchId, fetchRaw)
      : await fetchRaw();
    if (this.options.archive) {
      for (let refresh = 0; !telemetryBodyHasJsonShape(raw) && refresh < 2; refresh += 1) {
        raw = await this.options.archive.refresh(match.matchId, fetchRaw);
      }
      if (!telemetryBodyHasJsonShape(raw)) throw new Error('pubg_telemetry_json_invalid');
    }
    return Buffer.from(raw);
  }
}

export interface TelemetryWorkerOptions {
  team: TeamConfig;
  store?: TelemetryFeatureStore;
  downloader?: TelemetryDownloader;
  parserVersion?: string;
  featureVersion?: string;
}

export interface TelemetryEnsureResult {
  /** HIT is a cache read; FETCHED is a successful upstream fetch and cache write. */
  status: 'HIT' | 'FETCHED' | 'UNAVAILABLE';
  /** User-facing cache resolution. Do not use MISS for a successful fetch. */
  cacheStatus: 'HIT' | 'FETCHED' | 'UNAVAILABLE';
  /** Low-level diagnostic: whether the feature cache was populated before this call. */
  cacheLookup: 'HIT' | 'MISS';
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  facts?: MatchReviewFacts;
  parserVersion: string;
  featureVersion: string;
  error?: string;
}

function factsForOrdinal(facts: MatchReviewFacts, ordinal: number): MatchReviewFacts {
  if (facts.match.ordinal === ordinal) return facts;
  const rebound = structuredClone(facts);
  rebound.match.ordinal = ordinal;
  return rebound;
}

export class TelemetryWorker {
  private readonly team: TeamConfig;
  private readonly store: TelemetryFeatureStore;
  private readonly downloader: TelemetryDownloader | undefined;
  private readonly inFlight = new Map<string, Promise<TelemetryEnsureResult>>();
  readonly parserVersion: string;
  readonly featureVersion: string;

  constructor(options: TelemetryWorkerOptions) {
    this.team = options.team;
    this.store = options.store ?? new InMemoryTelemetryFeatureStore();
    this.downloader = options.downloader;
    this.parserVersion = options.parserVersion ?? DEFAULT_TELEMETRY_PARSER_VERSION;
    this.featureVersion = options.featureVersion ?? DEFAULT_REVIEW_FEATURE_VERSION;
  }

  async ensure(
    match: NormalizedMatch,
    ordinal = 1,
    signal?: AbortSignal,
  ): Promise<TelemetryEnsureResult> {
    const key = {
      matchId: match.matchId,
      parserVersion: this.parserVersion,
      featureVersion: this.featureVersion,
    };
    const cached = await this.store.get(key);
    if (cached) {
      return {
        status: 'HIT',
        cacheStatus: 'HIT',
        cacheLookup: 'HIT',
        availability: 'AVAILABLE',
        facts: factsForOrdinal(cached.facts, ordinal),
        parserVersion: this.parserVersion,
        featureVersion: this.featureVersion,
      };
    }
    const keyValue = cacheKey(key);
    const existing = this.inFlight.get(keyValue);
    if (existing) {
      const result = await existing;
      return result.facts ? { ...result, facts: factsForOrdinal(result.facts, ordinal) } : result;
    }
    const pending = this.fetchAndPersist(match, ordinal, key, signal);
    this.inFlight.set(keyValue, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(keyValue);
    }
  }

  private async fetchAndPersist(
    match: NormalizedMatch,
    ordinal: number,
    key: TelemetryFeatureKey,
    signal?: AbortSignal,
  ): Promise<TelemetryEnsureResult> {
    if (!this.downloader) {
      return {
        status: 'UNAVAILABLE',
        cacheStatus: 'UNAVAILABLE',
        cacheLookup: 'MISS',
        availability: 'UNAVAILABLE',
        parserVersion: this.parserVersion,
        featureVersion: this.featureVersion,
        error: 'telemetry_downloader_not_configured',
      };
    }
    try {
      const raw = await this.downloader.download(match, signal);
      const facts = extractMatchReviewFacts(match, raw, this.team, ordinal);
      const persistedFacts = compactReviewFactsForFeatureStore(facts);
      await this.store.set({ ...key, facts: persistedFacts, createdAt: new Date().toISOString() });
      // Keep the normalized event stream inside the Worker boundary. Review
      // analysis and presentation consume derived facts/evidence only.
      return {
        status: 'FETCHED',
        cacheStatus: 'FETCHED',
        cacheLookup: 'MISS',
        availability: 'AVAILABLE',
        facts: persistedFacts,
        parserVersion: this.parserVersion,
        featureVersion: this.featureVersion,
      };
    } catch (error) {
      return {
        status: 'UNAVAILABLE',
        cacheStatus: 'UNAVAILABLE',
        cacheLookup: 'MISS',
        availability: 'UNAVAILABLE',
        parserVersion: this.parserVersion,
        featureVersion: this.featureVersion,
        error: error instanceof Error ? error.message : 'telemetry_unavailable',
      };
    }
  }
}
