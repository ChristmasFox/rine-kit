import { randomUUID } from 'node:crypto';
import type { TeamConfig } from '../config/team.js';
import type { NormalizedMatch, QueryRow, ResultSetRecord } from '../data/model.js';
import type { CanonicalQuery, MatchSelector } from '../schema/query.js';
import { resolveSelector } from '../time/selector-resolver.js';
import type { Coverage, SourceInfo } from '../schema/status.js';
import type { MatchPickerCandidate } from './types.js';

function subjectIds(query: CanonicalQuery, team: TeamConfig): Set<string> {
  if (
    query.subject.type === 'team' &&
    (query.subject.ids.length === 0 || query.subject.ids.includes(team.id))
  )
    return new Set(team.players.map((player) => player.id));
  return new Set(query.subject.ids);
}

function selectedPlayers(match: NormalizedMatch, ids: Set<string>) {
  return match.players.filter((player) => ids.has(player.accountId));
}

function metricValue(match: NormalizedMatch, ids: Set<string>, metric: string): number {
  const players = selectedPlayers(match, ids);
  if (metric === 'placement' || metric === 'rank')
    return (
      players
        .map((player) => player.rank)
        .filter((rank): rank is number => rank !== null)
        .sort((left, right) => left - right)[0] ?? Number.POSITIVE_INFINITY
    );
  if (metric === 'duration') return match.duration;
  if (metric === 'teamDamage' || metric === 'damage')
    return players.reduce((sum, player) => sum + player.damage, 0);
  if (metric === 'teamKills' || metric === 'kills')
    return players.reduce((sum, player) => sum + player.kills, 0);
  if (metric === 'teamAssists' || metric === 'assists')
    return players.reduce((sum, player) => sum + player.assists, 0);
  return 0;
}

function rowForMatch(match: NormalizedMatch, ids: Set<string>): QueryRow {
  const players = selectedPlayers(match, ids);
  const kills = players.reduce((sum, player) => sum + player.kills, 0);
  const assists = players.reduce((sum, player) => sum + player.assists, 0);
  const damage = players.reduce((sum, player) => sum + player.damage, 0);
  const dbnos = players.reduce((sum, player) => sum + player.dbnos, 0);
  const revives = players.reduce((sum, player) => sum + player.revives, 0);
  const rank =
    players
      .map((player) => player.rank)
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right)[0] ?? null;
  return {
    key: match.matchId,
    label: match.matchId,
    groupBy: 'match',
    matchId: match.matchId,
    timestamp: match.timestamp,
    createdAt: match.createdAt,
    mapName: match.mapName,
    gameMode: match.gameMode,
    duration: match.duration,
    players,
    metrics: {
      matches: 1,
      kills,
      assists,
      damage,
      teamDamage: damage,
      teamKills: kills,
      teamAssists: assists,
      avg_damage: damage,
      dbnos,
      revives,
      rank,
      wins: rank === 1 ? 1 : 0,
      top10: rank !== null && rank <= 10 ? 1 : 0,
    },
    activityStatus: 'ACTIVE',
    bestRank: rank,
  };
}

function inSelector(
  match: NormalizedMatch,
  query: CanonicalQuery,
  ids: Set<string>,
  now: Date,
): boolean {
  if (query.selector.type === 'result_set') {
    const rawMatchIds = (query.reference as Record<string, unknown>).matchIds;
    if (!Array.isArray(rawMatchIds)) return false;
    const selectedIds = new Set(rawMatchIds.map(String));
    return selectedIds.has(match.matchId);
  }
  if (query.selector.type === 'last_n_matches') return true;
  const resolverOptions =
    query.selector.type === 'time_range'
      ? {
          now,
          timezone: query.selector.timezone,
          businessDayStart: query.selector.businessDayStart,
        }
      : { now };
  const resolved = resolveSelector(query.selector, resolverOptions);
  const start = Date.parse(resolved.start);
  const end = Date.parse(resolved.end);
  return (
    match.timestamp >= start && match.timestamp < end && selectedPlayers(match, ids).length > 0
  );
}

function baseCandidates(
  records: NormalizedMatch[],
  query: CanonicalQuery,
  team: TeamConfig,
  now: Date,
): MatchPickerCandidate[] {
  const ids = subjectIds(query, team);
  const directMatchId =
    query.matchSelector?.type === 'match_id' ? query.matchSelector.matchId : null;
  let matches = records.filter(
    (match) =>
      match.isCompetitive !== false &&
      selectedPlayers(match, ids).length > 0 &&
      // An explicit Match ID is authoritative and must not be narrowed away by
      // the tool boundary's default time selector.
      (directMatchId ? match.matchId === directMatchId : inSelector(match, query, ids, now)),
  );
  if (query.selector.type === 'last_n_matches') {
    const orderedNewest = [...matches].sort(
      (left, right) =>
        right.timestamp - left.timestamp || right.matchId.localeCompare(left.matchId),
    );
    matches = orderedNewest.slice(
      query.selector.offset,
      query.selector.offset + query.selector.count,
    );
  }
  matches.sort(
    (left, right) => left.timestamp - right.timestamp || left.matchId.localeCompare(right.matchId),
  );
  return matches.map((match, index) => ({
    ordinal: index + 1,
    match,
    row: rowForMatch(match, ids),
  }));
}

function filterCandidates(
  candidates: MatchPickerCandidate[],
  filters: Record<string, unknown>,
): MatchPickerCandidate[] {
  return candidates.filter((candidate) =>
    Object.entries(filters).every(([key, expected]) => {
      if (key === 'matchId' || key === 'map' || key === 'mapName')
        return (
          String(
            key === 'matchId' ? candidate.match.matchId : candidate.match.mapName,
          ).toLowerCase() === String(expected).toLowerCase()
        );
      const actual =
        key === 'placement' || key === 'rank'
          ? candidate.row.metrics.rank
          : (candidate.row.metrics[key] ?? candidate.match[key as keyof NormalizedMatch]);
      return Number.isFinite(Number(expected))
        ? Number(actual) === Number(expected)
        : String(actual).toLowerCase() === String(expected).toLowerCase();
    }),
  );
}

export interface MatchResolution {
  candidates: MatchPickerCandidate[];
  selected: MatchPickerCandidate[];
  selectionRequired: boolean;
  selector: MatchSelector | null;
}

export interface MatchSelectionContext {
  activeMatchId?: string | null;
  activeMatchOrdinal?: number | null;
  references?: Record<string, unknown>;
}

export function resolveMatchCandidates(
  records: NormalizedMatch[],
  query: CanonicalQuery,
  team: TeamConfig,
  now: Date,
  context: MatchSelectionContext | null = null,
): MatchResolution {
  let candidates = baseCandidates(records, query, team, now);
  const selector = query.matchSelector ?? null;
  if (!selector)
    return { candidates, selected: candidates, selectionRequired: candidates.length > 1, selector };

  if (selector.type === 'match_id') {
    const selected = candidates.filter((candidate) => candidate.match.matchId === selector.matchId);
    return { candidates, selected, selectionRequired: false, selector };
  }

  if (selector.type === 'active_match') {
    const active = candidates.find(
      (candidate) => candidate.match.matchId === context?.activeMatchId,
    );
    return { candidates, selected: active ? [active] : [], selectionRequired: false, selector };
  }
  if (selector.type === 'previous' || selector.type === 'next') {
    const foundIndex = candidates.findIndex(
      (candidate) => candidate.match.matchId === context?.activeMatchId,
    );
    const activeIndex = context?.activeMatchId
      ? foundIndex
      : context?.activeMatchOrdinal
        ? context.activeMatchOrdinal - 1
        : -1;
    const targetIndex = activeIndex + (selector.type === 'previous' ? -1 : 1);
    const target = targetIndex >= 0 ? candidates[targetIndex] : undefined;
    return { candidates, selected: target ? [target] : [], selectionRequired: false, selector };
  }
  if (selector.type === 'latest') {
    const target = candidates.at(-1);
    return { candidates, selected: target ? [target] : [], selectionRequired: false, selector };
  }
  if (selector.type === 'earliest') {
    const target = candidates[0];
    return { candidates, selected: target ? [target] : [], selectionRequired: false, selector };
  }
  if (selector.type === 'ordinal') {
    const target = candidates[selector.ordinal - 1];
    return { candidates, selected: target ? [target] : [], selectionRequired: false, selector };
  }
  if (selector.type === 'ordinal_from_end') {
    const target = candidates[candidates.length - selector.ordinal];
    return { candidates, selected: target ? [target] : [], selectionRequired: false, selector };
  }
  if (selector.type === 'filtered') {
    const selected = filterCandidates(candidates, selector.filters);
    return { candidates, selected, selectionRequired: selected.length > 1, selector };
  }
  const ranked = [...candidates].sort((left, right) => {
    const delta =
      metricValue(right.match, subjectIds(query, team), selector.metric) -
      metricValue(left.match, subjectIds(query, team), selector.metric);
    const directed = selector.direction === 'asc' ? -delta : delta;
    return directed || left.ordinal - right.ordinal;
  });
  const first = ranked[0];
  const selected = first
    ? ranked.filter(
        (candidate) =>
          metricValue(candidate.match, subjectIds(query, team), selector.metric) ===
          metricValue(first.match, subjectIds(query, team), selector.metric),
      )
    : [];
  return { candidates, selected, selectionRequired: selected.length > 1, selector };
}

export function resultSetForMatchCandidates(
  query: CanonicalQuery,
  sessionId: string,
  candidates: MatchPickerCandidate[],
  coverage: Coverage,
  source: SourceInfo,
  ttlMs = 24 * 60 * 60 * 1000,
): ResultSetRecord {
  const createdAt = new Date();
  return {
    id: `mrs_${randomUUID()}`,
    queryId: query.queryId,
    sessionId,
    resolvedQuery: query,
    resolvedSelector: query.selector,
    playerIds: [
      ...new Set(
        candidates.flatMap(
          (candidate) => candidate.row.players?.map((player) => player.accountId) ?? [],
        ),
      ),
    ],
    matchIds: candidates.map((candidate) => candidate.match.matchId),
    rows: candidates.map((candidate) => candidate.row),
    aggregates: { candidateCount: candidates.length, order: 'startedAt ASC' },
    rankings: [],
    coverage,
    status: 'MATCH_SELECTION_REQUIRED',
    source,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
  };
}
