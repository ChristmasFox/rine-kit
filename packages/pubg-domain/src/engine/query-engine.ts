import { randomUUID } from 'node:crypto';
import type { TeamConfig } from '../config/team.js';
import { parseTeamContext, type TeamContext } from '../context/team-context.js';
import type { CanonicalQuery, GroupBy, Metric, Selector } from '../schema/query.js';
import { CanonicalQuerySchema } from '../schema/query.js';
import type { Coverage, DataStatus, Evidence, SourceInfo } from '../schema/status.js';
import type {
  NormalizedMatch,
  NormalizedPlayer,
  OperationData,
  QueryRow,
  ResultSetRecord,
  StructuredResult,
} from '../data/model.js';
import { normalizeRecords, numberOr } from '../data/model.js';
import {
  CHICKEN_INDEX_WEIGHTS,
  normalizeChickenIndexWeights,
  type ChickenIndexWeights,
} from '../config/chicken-index.js';
import {
  BUSINESS_DAY_START,
  DEFAULT_TIMEZONE,
  businessDayLabel,
  describeRange,
  resolveQuerySelectors,
  resolveSelector,
  type ResolverOptions,
} from '../time/selector-resolver.js';

export interface QueryEngineOptions extends ResolverOptions {
  teamContext?: TeamContext;
  resultSetMatchIds?: string[];
  chickenIndexWeights?: Partial<ChickenIndexWeights>;
}

interface Accumulator {
  matchIds: Set<string>;
  kills: number;
  assists: number;
  damage: number;
  dbnos: number;
  revives: number;
  headshotKills: number;
  survivalTime: number;
  longestKill: number;
  deaths: number;
  unknownDeathCount: number;
  rankValues: number[];
  wins: number;
  top10: number;
  deathSemantics: Set<string>;
}

function emptyAccumulator(): Accumulator {
  return {
    matchIds: new Set(),
    kills: 0,
    assists: 0,
    damage: 0,
    dbnos: 0,
    revives: 0,
    headshotKills: 0,
    survivalTime: 0,
    longestKill: 0,
    deaths: 0,
    unknownDeathCount: 0,
    rankValues: [],
    wins: 0,
    top10: 0,
    deathSemantics: new Set(),
  };
}

function addPlayer(
  accumulator: Accumulator,
  match: NormalizedMatch,
  player: NormalizedPlayer,
): void {
  accumulator.matchIds.add(match.matchId);
  accumulator.kills += numberOr(player.kills);
  accumulator.assists += numberOr(player.assists);
  accumulator.damage += numberOr(player.damage);
  accumulator.dbnos += numberOr(player.dbnos);
  accumulator.revives += numberOr(player.revives);
  accumulator.headshotKills += numberOr(player.headshotKills);
  accumulator.survivalTime += numberOr(player.survivalTime);
  accumulator.longestKill = Math.max(accumulator.longestKill, numberOr(player.longestKill));
  if (typeof player.deaths === 'number' && Number.isFinite(player.deaths))
    accumulator.deaths += Math.max(0, player.deaths);
  else accumulator.unknownDeathCount += 1;
  if (player.deathSemantics) accumulator.deathSemantics.add(player.deathSemantics);
  if (player.rank !== null) {
    accumulator.rankValues.push(player.rank);
    if (player.rank === 1) accumulator.wins += 1;
    if (player.rank <= 10) accumulator.top10 += 1;
  }
}

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function metricNullableNumber(row: QueryRow | undefined, metric: Metric): number | null {
  if (!row) return null;
  const value = row.metrics[metric];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? round(value) : null;
}

function metricValue(accumulator: Accumulator, metric: Metric): number | string | null {
  const matches = accumulator.matchIds.size;
  const avgRank = accumulator.rankValues.length
    ? accumulator.rankValues.reduce((sum, value) => sum + value, 0) / accumulator.rankValues.length
    : null;
  const kd =
    accumulator.unknownDeathCount > 0
      ? null
      : accumulator.deaths > 0
        ? accumulator.kills / accumulator.deaths
        : null;
  switch (metric) {
    case 'matches':
      return matches;
    case 'kills':
      return accumulator.kills;
    case 'assists':
      return accumulator.assists;
    case 'damage':
      return accumulator.damage;
    case 'avg_damage':
      return matches ? accumulator.damage / matches : 0;
    case 'kd':
      return kd;
    case 'deaths':
      return accumulator.unknownDeathCount > 0 ? null : accumulator.deaths;
    case 'wins':
      return accumulator.wins;
    case 'top10':
      return accumulator.top10;
    case 'rank':
      return avgRank === null ? null : avgRank;
    case 'dbnos':
      return accumulator.dbnos;
    case 'revives':
      return accumulator.revives;
    case 'headshot_kills':
      return accumulator.headshotKills;
    case 'survival_time':
      return accumulator.survivalTime;
    case 'longest_kill':
      return accumulator.longestKill;
    case 'performance_score':
      return null;
    case 'chicken_index':
      return null;
  }
}

function playerIdsForSubject(query: CanonicalQuery, team: TeamConfig): string[] {
  const ids = query.subject.ids.map(String);
  if (query.subject.type === 'team' && (ids.length === 0 || ids.includes(team.id)))
    return team.players.map((player) => player.id);
  return ids;
}

function aliasesForTeam(team: TeamConfig): Map<string, string> {
  const result = new Map<string, string>();
  for (const player of team.players) {
    result.set(player.id, player.name);
    result.set(player.name, player.name);
  }
  return result;
}

function createRow(
  key: string,
  label: string,
  groupBy: GroupBy,
  accumulator: Accumulator,
  metadata: Partial<QueryRow> = {},
): QueryRow {
  const metrics: Record<string, number | null | string> = {};
  const metricNames: Metric[] = [
    'matches',
    'kills',
    'assists',
    'damage',
    'avg_damage',
    'kd',
    'deaths',
    'wins',
    'top10',
    'rank',
    'dbnos',
    'revives',
    'headshot_kills',
    'survival_time',
    'longest_kill',
  ];
  for (const metric of metricNames) metrics[metric] = metricValue(accumulator, metric);
  metrics.avg_kills = accumulator.matchIds.size ? accumulator.kills / accumulator.matchIds.size : 0;
  metrics.avg_rank = accumulator.rankValues.length
    ? accumulator.rankValues.reduce((sum, value) => sum + value, 0) / accumulator.rankValues.length
    : null;
  metrics.top10_rate = accumulator.matchIds.size
    ? accumulator.top10 / accumulator.matchIds.size
    : 0;
  metrics.denominatorZero =
    accumulator.matchIds.size === 0 || accumulator.unknownDeathCount > 0
      ? null
      : accumulator.deaths === 0
        ? 1
        : 0;
  return {
    key,
    label,
    groupBy,
    metrics,
    activityStatus: accumulator.matchIds.size ? 'ACTIVE' : 'NO_ACTIVITY',
    bestRank: accumulator.rankValues.length ? Math.min(...accumulator.rankValues) : null,
    ...metadata,
  };
}

function selectedPlayers(match: NormalizedMatch, ids: Set<string>): NormalizedPlayer[] {
  const byId = new Map<string, NormalizedPlayer>();
  for (const player of match.players)
    if (ids.has(player.accountId)) byId.set(player.accountId, player);
  return [...byId.values()];
}

function selectBySelector(
  records: NormalizedMatch[],
  selector: Selector,
  subjectIds: Set<string>,
  options: QueryEngineOptions,
): NormalizedMatch[] {
  if (selector.type === 'result_set') {
    const ids = new Set(options.resultSetMatchIds ?? []);
    return records.filter((record) => ids.has(record.matchId));
  }
  const hasSubject = (record: NormalizedMatch) => selectedPlayers(record, subjectIds).length > 0;
  const competitive = records.filter(
    (record) => record.isCompetitive !== false && hasSubject(record),
  );
  if (selector.type === 'last_n_matches') {
    const ordered = [...competitive].sort(
      (left, right) =>
        right.timestamp - left.timestamp || right.matchId.localeCompare(left.matchId),
    );
    return ordered.slice(selector.offset, selector.offset + selector.count);
  }
  const resolved = resolveSelector(selector, options);
  const start = Date.parse(resolved.start);
  const end = Date.parse(resolved.end);
  return competitive.filter((record) => record.timestamp >= start && record.timestamp < end);
}

function aggregatePlayerRows(
  records: NormalizedMatch[],
  ids: string[],
  team: TeamConfig,
): QueryRow[] {
  const buckets = new Map<string, Accumulator>();
  for (const id of ids) buckets.set(id, emptyAccumulator());
  const idSet = new Set(ids);
  for (const match of records) {
    for (const player of selectedPlayers(match, idSet)) {
      const accumulator = buckets.get(player.accountId);
      if (accumulator) addPlayer(accumulator, match, player);
    }
  }
  const aliasMap = aliasesForTeam(team);
  const rows: QueryRow[] = [];
  for (const id of ids)
    rows.push(
      createRow(id, aliasMap.get(id) ?? id, 'player', buckets.get(id) ?? emptyAccumulator()),
    );
  return rows;
}

function aggregateTeamRow(
  records: NormalizedMatch[],
  ids: Set<string>,
  team: TeamConfig,
): QueryRow {
  const accumulator = emptyAccumulator();
  const seenMatches = new Set<string>();
  for (const match of records) {
    const players = selectedPlayers(match, ids);
    if (!players.length || seenMatches.has(match.matchId)) continue;
    seenMatches.add(match.matchId);
    for (const player of players) addPlayer(accumulator, match, player);
  }
  const row = createRow(team.id, team.label, 'team', accumulator);
  const teamRanks = records.flatMap((match) =>
    selectedPlayers(match, ids)
      .map((player) => player.rank)
      .filter((rank): rank is number => rank !== null),
  );
  const bestRankByMatch = new Map<string, number>();
  for (const match of records) {
    const ranks = selectedPlayers(match, ids)
      .map((player) => player.rank)
      .filter((rank): rank is number => rank !== null);
    if (ranks.length) bestRankByMatch.set(match.matchId, Math.min(...ranks));
  }
  const teamWins = [...bestRankByMatch.values()].filter((rank) => rank === 1).length;
  const teamTop10 = [...bestRankByMatch.values()].filter((rank) => rank <= 10).length;
  row.metrics.wins = teamWins;
  row.metrics.top10 = teamTop10;
  row.metrics.rank = teamRanks.length
    ? round(teamRanks.reduce((sum, value) => sum + value, 0) / teamRanks.length)
    : null;
  row.metrics.avg_damage = accumulator.matchIds.size
    ? round(accumulator.damage / accumulator.matchIds.size)
    : 0;
  row.metrics.teamCombinedKD =
    accumulator.unknownDeathCount > 0 || accumulator.deaths === 0
      ? null
      : round(accumulator.kills / accumulator.deaths);
  row.metrics.deathSemantics = [...accumulator.deathSemantics].join(',') || 'unknown';
  return row;
}

function aggregateMatchRows(records: NormalizedMatch[], ids: Set<string>): QueryRow[] {
  return records.map((match) => {
    const players = selectedPlayers(match, ids);
    const accumulator = emptyAccumulator();
    for (const player of players) addPlayer(accumulator, match, player);
    const row = createRow(match.matchId, match.matchId, 'match', accumulator, {
      matchId: match.matchId,
      timestamp: match.timestamp,
      createdAt: match.createdAt,
      mapName: match.mapName,
      gameMode: match.gameMode,
      duration: match.duration,
      players,
    });
    row.metrics.rank =
      players
        .map((player) => player.rank)
        .filter((rank): rank is number => rank !== null)
        .sort((left, right) => left - right)[0] ?? null;
    row.metrics.wins = row.metrics.rank === 1 ? 1 : 0;
    row.metrics.top10 = typeof row.metrics.rank === 'number' && row.metrics.rank <= 10 ? 1 : 0;
    row.metrics.avg_damage = row.metrics.damage ?? 0;
    return row;
  });
}

function aggregateDayRows(
  records: NormalizedMatch[],
  ids: Set<string>,
  team: TeamConfig,
  timezone: string,
  businessDayStart: string,
): QueryRow[] {
  const groups = new Map<string, NormalizedMatch[]>();
  for (const record of records) {
    const label = businessDayLabel(record.timestamp, timezone, businessDayStart);
    const bucket = groups.get(label) ?? [];
    bucket.push(record);
    groups.set(label, bucket);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, matches]) => {
      const row = aggregateTeamRow(matches, ids, team);
      return { ...row, key: label, label, groupBy: 'day' as const };
    });
}

function aggregateCategoryRows(
  records: NormalizedMatch[],
  ids: Set<string>,
  team: TeamConfig,
  groupBy: 'map' | 'mode',
): QueryRow[] {
  const groups = new Map<string, NormalizedMatch[]>();
  for (const record of records) {
    const label = groupBy === 'map' ? record.mapName : record.gameMode;
    const bucket = groups.get(label) ?? [];
    bucket.push(record);
    groups.set(label, bucket);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([label, matches]) => {
      const row = aggregateTeamRow(matches, ids, team);
      return { ...row, key: label, label, groupBy };
    });
}

function normalizeComponent(value: number, values: number[], higherIsBetter: boolean): number {
  const finiteValues = values.filter((item) => Number.isFinite(item));
  if (!finiteValues.length) return 0;
  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  if (max === min) return 100;
  const normalized = higherIsBetter ? (value - min) / (max - min) : (max - value) / (max - min);
  return Math.max(0, Math.min(100, normalized * 100));
}

function applyChickenIndex(rows: QueryRow[], override: Partial<ChickenIndexWeights> = {}): void {
  const weights = normalizeChickenIndexWeights(override);
  const eligible = rows.filter((row) => row.activityStatus !== 'NO_ACTIVITY');
  const knownValues = (metric: Metric): number[] =>
    eligible.flatMap((row) => {
      const value = metricNullableNumber(row, metric);
      return value === null ? [] : [value];
    });
  const rateValues = (metric: Metric): number[] =>
    eligible.flatMap((row) => {
      const value = metricNullableNumber(row, metric);
      const matches = metricNullableNumber(row, 'matches');
      return value === null || matches === null || matches <= 0 ? [] : [value / matches];
    });
  const kdValues = knownValues('kd');
  const damageValues = knownValues('avg_damage');
  const killsValues = rateValues('kills');
  const rankValues = knownValues('rank');
  const top10Values = rateValues('top10');
  for (const row of rows) {
    if (row.activityStatus === 'NO_ACTIVITY') {
      row.metrics.performance_score = null;
      row.metrics.chicken_index = null;
      continue;
    }
    const kd = metricNullableNumber(row, 'kd');
    const avgDamage = metricNullableNumber(row, 'avg_damage');
    const kills = metricNullableNumber(row, 'kills');
    const matches = metricNullableNumber(row, 'matches');
    const avgRank = metricNullableNumber(row, 'rank');
    const top10 = metricNullableNumber(row, 'top10');
    if (
      kd === null ||
      avgDamage === null ||
      kills === null ||
      matches === null ||
      matches <= 0 ||
      avgRank === null ||
      top10 === null
    ) {
      row.metrics.performance_score = null;
      row.metrics.chicken_index = null;
      continue;
    }
    const avgKills = kills / matches;
    const top10Rate = top10 / matches;
    const score =
      normalizeComponent(kd, kdValues, true) * weights.kd +
      normalizeComponent(avgDamage, damageValues, true) * weights.avgDamage +
      normalizeComponent(avgKills, killsValues, true) * weights.avgKills +
      normalizeComponent(avgRank, rankValues, false) * weights.placement +
      normalizeComponent(top10Rate, top10Values, true) * weights.top10Rate;
    row.metrics.performance_score = round(score);
    row.metrics.chicken_index = round(Math.max(0, Math.min(100, 100 - score)));
  }
}

function sortRows(rows: QueryRow[], metric: Metric, direction: 'asc' | 'desc'): QueryRow[] {
  return [...rows].sort((left, right) => {
    const leftValue = metricNullableNumber(left, metric);
    const rightValue = metricNullableNumber(right, metric);
    if (leftValue === null || rightValue === null) {
      if (leftValue === null && rightValue === null) return left.label.localeCompare(right.label);
      return leftValue === null ? 1 : -1;
    }
    if (leftValue !== rightValue)
      return direction === 'desc' ? rightValue - leftValue : leftValue - rightValue;
    return left.label.localeCompare(right.label);
  });
}

function positionRows(rows: QueryRow[], metric: Metric): QueryRow[] {
  let previous: number | null = null;
  let position = 0;
  return rows.map((row, index) => {
    const value = metricNullableNumber(row, metric);
    if (value === null) return { ...row, tied: false };
    if (previous === null || value !== previous) position = index + 1;
    previous = value;
    return {
      ...row,
      position,
      tied: index > 0 && value === metricNullableNumber(rows[index - 1]!, metric),
    };
  });
}

function highlights(rows: QueryRow[]): Record<string, QueryRow[]> {
  const eligible = rows.filter((row) => row.activityStatus !== 'NO_ACTIVITY');
  const result: Record<string, QueryRow[]> = {};
  const highest = (metric: Metric) => {
    const known = eligible.flatMap((row) => {
      const value = metricNullableNumber(row, metric);
      return value === null ? [] : [value];
    });
    if (!known.length) return [];
    const max = Math.max(...known);
    return eligible.filter((row) => metricNullableNumber(row, metric) === max);
  };
  result.kd = highest('kd');
  result.kills = highest('kills');
  result.damage = highest('damage');
  result.dbnos = highest('dbnos');
  result.revives = highest('revives');
  result.longest_kill = highest('longest_kill');
  const chickenValues = eligible.flatMap((row) => {
    const value = metricNullableNumber(row, 'chicken_index');
    return value === null ? [] : [value];
  });
  const maxChicken = chickenValues.length ? Math.max(...chickenValues) : null;
  result.chicken_index =
    maxChicken === null
      ? []
      : eligible.filter((row) => metricNullableNumber(row, 'chicken_index') === maxChicken);
  return result;
}

function selectorTimeOptions(
  selector: CanonicalQuery['selector'],
  options: QueryEngineOptions,
): { timezone: string; businessDayStart: string } {
  if (selector.type === 'time_range')
    return { timezone: selector.timezone, businessDayStart: selector.businessDayStart };
  return {
    timezone: options.timezone ?? DEFAULT_TIMEZONE,
    businessDayStart: options.businessDayStart ?? BUSINESS_DAY_START,
  };
}

function statusFor(coverage: Coverage, selectedCount: number): DataStatus {
  if (coverage.status === 'SOURCE_UNAVAILABLE') {
    if (
      coverage.queryCovered === true ||
      (coverage.queryCovered === undefined && (coverage.complete || selectedCount > 0))
    )
      return 'STALE';
    return 'SOURCE_UNAVAILABLE';
  }
  if (coverage.status === 'PARTIAL') return 'PARTIAL';
  if (coverage.status === 'COVERAGE_GAP') return 'COVERAGE_GAP';
  if (coverage.status === 'STALE') return 'STALE';
  return coverage.complete ? 'OK' : 'COVERAGE_GAP';
}

function evidence(records: NormalizedMatch[], _query: CanonicalQuery): Evidence {
  const fields = new Set<string>([
    'matchId',
    'timestamp',
    'players.kills',
    'players.assists',
    'players.damage',
    'players.deaths',
    'players.rank',
    'players.dbnos',
    'players.revives',
    'players.headshotKills',
    'players.survivalTime',
    'players.longestKill',
  ]);
  return {
    matchIds: records.map((record) => record.matchId),
    playerIds: [
      ...new Set(records.flatMap((record) => record.players.map((player) => player.accountId))),
    ],
    fields: [...fields],
    calculation: 'deterministic_query_engine_v3',
  };
}

export class DeterministicQueryEngine {
  constructor(private readonly defaults: QueryEngineOptions = {}) {}

  execute(
    input: unknown,
    sourceRecords: unknown[],
    coverage: Coverage,
    source: SourceInfo,
    options: QueryEngineOptions = {},
  ): StructuredResult {
    const parsed = CanonicalQuerySchema.safeParse(input);
    const queryId =
      typeof input === 'object' && input !== null && 'queryId' in input
        ? String((input as { queryId?: unknown }).queryId ?? '')
        : 'unknown-query';
    const sessionId =
      typeof input === 'object' && input !== null && 'reference' in input
        ? String(
            (input as { reference?: { sessionId?: unknown } }).reference?.sessionId ??
              'unknown-session',
          )
        : 'unknown-session';
    if (!parsed.success)
      return this.invalid(
        queryId,
        sessionId,
        'INVALID_QUERY',
        parsed.error.issues.map((issue) => issue.message),
        coverage,
        source,
      );
    const query = parsed.data;
    if (query.reference.unsupportedCapability)
      return this.invalid(
        query.queryId,
        sessionId,
        'UNSUPPORTED_CAPABILITY',
        [query.reference.unsupportedCapability],
        coverage,
        source,
      );
    const mergedOptions = { ...this.defaults, ...options };
    const resolved = resolveQuerySelectors(query, mergedOptions);
    if (!mergedOptions.teamContext)
      return this.invalid(
        query.queryId,
        sessionId,
        'INVALID_QUERY',
        ['TEAM_CONTEXT_REQUIRED'],
        coverage,
        source,
      );
    let teamContext: TeamContext;
    try {
      teamContext = parseTeamContext(mergedOptions.teamContext);
    } catch {
      return this.invalid(
        query.queryId,
        sessionId,
        'INVALID_QUERY',
        ['TEAM_CONTEXT_INVALID'],
        coverage,
        source,
      );
    }
    const team = teamContext.team;
    const ids = playerIdsForSubject(resolved, team);
    const knownIds = new Set(team.players.map((player) => player.id));
    const unknown = resolved.subject.type !== 'team' ? ids.filter((id) => !knownIds.has(id)) : [];
    if (unknown.length)
      return this.invalid(query.queryId, sessionId, 'UNKNOWN_PLAYER', unknown, coverage, source);
    const records = normalizeRecords(sourceRecords);
    const subjectIds = new Set(ids);
    const querySessionId = String(
      (resolved.reference as Record<string, unknown>).sessionId ?? sessionId,
    );
    const selected =
      resolved.operation === 'compare'
        ? normalizeRecords(
            resolved.segments.flatMap((segment) =>
              selectBySelector(records, segment.selector, subjectIds, mergedOptions),
            ),
          )
        : selectBySelector(records, resolved.selector, subjectIds, mergedOptions);
    const baseStatus = statusFor(coverage, selected.length);
    if (resolved.operation === 'compare')
      return this.executeCompare(
        resolved,
        records,
        coverage,
        source,
        team,
        subjectIds,
        mergedOptions,
        baseStatus,
        querySessionId,
      );
    if (resolved.selector.type === 'result_set' && !mergedOptions.resultSetMatchIds)
      return this.invalid(
        resolved.queryId,
        querySessionId,
        'INVALID_QUERY',
        ['RESULT_SET_NOT_FOUND'],
        coverage,
        source,
      );
    const selectorTime = selectorTimeOptions(resolved.selector, mergedOptions);
    const data = this.executeSingle(
      resolved,
      selected,
      subjectIds,
      ids,
      team,
      selectorTime.timezone,
      selectorTime.businessDayStart,
      mergedOptions.chickenIndexWeights ?? CHICKEN_INDEX_WEIGHTS,
    );
    const status: DataStatus =
      selected.length === 0 && coverage.complete && baseStatus === 'OK' ? 'NO_MATCHES' : baseStatus;
    const result: StructuredResult = {
      queryId: resolved.queryId,
      sessionId: querySessionId,
      status,
      data,
      coverage,
      source,
      evidence: evidence(selected, resolved),
      diagnostics: {
        selectedMatchCount: selected.length,
        resolvedSelector: resolved.selector,
        selectorDescription: describeRange(resolved.selector),
        calculation: 'deterministic_query_engine_v3',
      },
    };
    return result;
  }

  private executeSingle(
    query: CanonicalQuery,
    selected: NormalizedMatch[],
    subjectIds: Set<string>,
    playerIds: string[],
    team: TeamConfig,
    timezone: string,
    businessDayStart: string,
    chickenIndexWeights: Partial<ChickenIndexWeights> = CHICKEN_INDEX_WEIGHTS,
  ): OperationData {
    let rows: QueryRow[];
    if (query.groupBy === 'player') rows = aggregatePlayerRows(selected, playerIds, team);
    else if (query.groupBy === 'match') rows = aggregateMatchRows(selected, subjectIds);
    else if (query.groupBy === 'day')
      rows = aggregateDayRows(selected, subjectIds, team, timezone, businessDayStart);
    else if (query.groupBy === 'map' || query.groupBy === 'mode')
      rows = aggregateCategoryRows(selected, subjectIds, team, query.groupBy);
    else rows = [aggregateTeamRow(selected, subjectIds, team)];
    if (query.groupBy !== 'match') {
      applyChickenIndex(rows, chickenIndexWeights);
    }
    const orderMetric =
      query.operation === 'strongest'
        ? 'performance_score'
        : query.operation === 'weakest'
          ? 'chicken_index'
          : query.orderBy.metric;
    const orderDirection =
      query.operation === 'weakest'
        ? 'desc'
        : query.operation === 'strongest'
          ? 'desc'
          : query.orderBy.direction;
    let outputRows = rows;
    if (
      query.operation === 'rank' ||
      query.operation === 'strongest' ||
      query.operation === 'weakest' ||
      query.operation === 'report'
    ) {
      outputRows = sortRows(rows, orderMetric, orderDirection);
      outputRows = positionRows(outputRows, orderMetric);
      if (query.operation !== 'report' && query.limit)
        outputRows = outputRows
          .filter((row) => row.activityStatus !== 'NO_ACTIVITY')
          .slice(0, query.limit);
    }
    if (query.operation === 'list') outputRows = rows.slice(0, query.limit ?? 20);
    if (query.operation === 'detail' && query.limit) outputRows = outputRows.slice(0, query.limit);
    const teamRow =
      query.groupBy === 'team' ? outputRows[0] : aggregateTeamRow(selected, subjectIds, team);
    const result: OperationData = {
      operation: query.operation,
      groupBy: query.groupBy,
      ...(query.operation === 'rank' ||
      query.operation === 'strongest' ||
      query.operation === 'weakest'
        ? { metric: orderMetric, direction: orderDirection }
        : {}),
      rows: outputRows,
      summary: {
        periodLabel: query.selector.label ?? describeRange(query.selector),
        uniqueMatchCount: new Set(selected.map((record) => record.matchId)).size,
        team: teamRow?.metrics ?? {},
      },
    };
    if (query.operation === 'report') result.highlights = highlights(rows);
    if (query.operation === 'trend') {
      const ordered = [...rows].sort((left, right) =>
        (left.label ?? '').localeCompare(right.label ?? ''),
      );
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const metricNames: Metric[] = ['kd', 'avg_damage', 'kills'];
      const changes: Record<
        string,
        { from: number | null; to: number | null; delta: number | null }
      > = {};
      for (const metric of metricNames) {
        const from = first ? metricNullableNumber(first, metric) : null;
        const to = last ? metricNullableNumber(last, metric) : null;
        const delta = from === null || to === null ? null : round(to - from);
        changes[metric] = { from: round(from), to: round(to), delta };
      }
      const positive = [changes.kd?.delta, changes.avg_damage?.delta, changes.kills?.delta].some(
        (value) => typeof value === 'number' && value > 0,
      );
      const negative = [changes.kd?.delta, changes.avg_damage?.delta].every(
        (value) => typeof value === 'number' && value < 0,
      );
      result.dailySeries = ordered;
      result.change = {
        direction: positive && !negative ? 'up' : negative ? 'down' : 'stable',
        metrics: changes,
      };
    }
    return result;
  }

  private executeCompare(
    query: CanonicalQuery,
    records: NormalizedMatch[],
    coverage: Coverage,
    source: SourceInfo,
    team: TeamConfig,
    ids: Set<string>,
    options: QueryEngineOptions,
    baseStatus: DataStatus,
    sessionId: string,
  ): StructuredResult {
    const segmentData = query.segments.map((segment) => {
      const selected = selectBySelector(records, segment.selector, ids, options);
      const segmentQuery = {
        ...query,
        operation: 'report' as const,
        selector: segment.selector,
        segments: [],
      };
      const segmentTime = selectorTimeOptions(segment.selector, options);
      const data = this.executeSingle(
        segmentQuery,
        selected,
        ids,
        [...ids],
        team,
        segmentTime.timezone,
        segmentTime.businessDayStart,
        options.chickenIndexWeights ?? CHICKEN_INDEX_WEIGHTS,
      );
      return {
        label: segment.label,
        selector: segment.selector,
        rows: data.rows,
        summary: data.summary,
      };
    });
    const first = segmentData[0];
    const second = segmentData[1];
    const deltaRows: QueryRow[] = [];
    if (first && second) {
      const secondByKey = new Map(second.rows.map((row) => [row.key, row]));
      const keys = new Set([
        ...first.rows.map((row) => row.key),
        ...second.rows.map((row) => row.key),
      ]);
      for (const key of keys) {
        const firstRow = first.rows.find((row) => row.key === key);
        const secondRow = secondByKey.get(key);
        const template = firstRow ?? secondRow;
        if (!template) continue;
        const metrics: Record<string, number | null | string> = {};
        const comparisonMetrics = [
          'matches',
          'kills',
          'assists',
          'damage',
          'avg_damage',
          'kd',
          'deaths',
          'wins',
          'top10',
          'rank',
          'dbnos',
          'revives',
          'performance_score',
          'chicken_index',
        ] as Metric[];
        const comparisonRatios: Record<string, number | null> = {};
        for (const metric of comparisonMetrics) {
          const firstKnown = metricNullableNumber(firstRow, metric);
          const secondKnown = metricNullableNumber(secondRow, metric);
          metrics[metric] =
            firstKnown === null || secondKnown === null ? null : round(firstKnown - secondKnown);
          comparisonRatios[metric] = ratio(firstKnown, secondKnown);
        }
        deltaRows.push({
          ...template,
          activityStatus:
            firstRow?.activityStatus === 'ACTIVE' || secondRow?.activityStatus === 'ACTIVE'
              ? 'ACTIVE'
              : 'NO_ACTIVITY',
          metrics,
          comparisonRatios,
        });
      }
    }
    const selectedForEvidence = normalizeRecords(
      query.segments.flatMap((segment) =>
        selectBySelector(records, segment.selector, ids, options),
      ),
    );
    return {
      queryId: query.queryId,
      sessionId,
      status: baseStatus,
      data: {
        operation: 'compare',
        groupBy: query.groupBy,
        rows: deltaRows,
        summary: {
          segmentCount: segmentData.length,
          comparisonRatios: Object.fromEntries(
            deltaRows.map((row) => [row.key, row.comparisonRatios ?? {}]),
          ),
        },
        segments: segmentData,
      },
      coverage,
      source,
      evidence: evidence(selectedForEvidence, query),
      diagnostics: {
        selectedMatchCount: selectedForEvidence.length,
        resolvedSegments: query.segments,
        calculation: 'deterministic_query_engine_v3',
      },
    };
  }

  private invalid(
    queryId: string,
    sessionId: string,
    status: DataStatus,
    errors: string[],
    coverage: Coverage,
    source: SourceInfo,
  ): StructuredResult {
    return {
      queryId,
      sessionId,
      status,
      data: { operation: 'report', groupBy: 'player', rows: [], summary: { errors } },
      coverage,
      source,
      evidence: {
        matchIds: [],
        playerIds: [],
        fields: [],
        calculation: 'deterministic_query_engine_v3',
      },
      diagnostics: { errors },
    };
  }
}

export function resultSetFromResult(
  result: StructuredResult,
  query: CanonicalQuery,
  sessionId: string,
  ttlMs = 24 * 60 * 60 * 1000,
): ResultSetRecord {
  const createdAt = new Date();
  return {
    id: `rs_${randomUUID()}`,
    queryId: result.queryId,
    sessionId,
    resolvedQuery: query,
    resolvedSelector: query.selector,
    playerIds: result.evidence.playerIds,
    matchIds: result.evidence.matchIds,
    rows: result.data.rows,
    aggregates: result.data.summary,
    rankings: result.data.rows.filter((row) => row.position !== undefined),
    coverage: result.coverage,
    status: result.status,
    source: result.source,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
  };
}
