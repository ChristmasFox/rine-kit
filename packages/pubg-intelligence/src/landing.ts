import { createHash } from 'node:crypto';
import {
  parseTelemetryPayload,
  type NormalizedMatch,
  type NormalizedPlayer,
} from '@rine-kit/pubg-domain';
import {
  mapDisplayName,
  mapSizeKm,
  median,
  newcombeDifference,
  wilsonInterval,
  type DifferenceEstimate,
  type RateEstimate,
} from './analytics.js';
import { CONTEST_MIN_MATCHES } from './field.js';

export const LANDING_SCHEMA_VERSION = 1 as const;
export const LANDING_EARLY_WIPE_SECONDS = 420;
export const LANDING_CELL_KM = 1;

export interface LandingSample {
  playerRef: string;
  xMeters: number;
  yMeters: number;
  /** One-kilometre grid label such as C5 (column from west, row from north); null on maps of unknown size. */
  cell: string | null;
}

export function landingPlayerRef(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 12);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function gridCell(xMeters: number, yMeters: number, mapName: string): string | null {
  const size = mapSizeKm(mapName);
  if (size === null) return null;
  const col = Math.floor(xMeters / 1000 / LANDING_CELL_KM);
  const row = Math.floor(yMeters / 1000 / LANDING_CELL_KM);
  if (col < 0 || row < 0 || col >= size || row >= size) return null;
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

/** Reads LogParachuteLanding for the tracked squad; coordinates in telemetry are centimetres. */
export function extractLandings(
  payload: unknown,
  match: Pick<NormalizedMatch, 'mapName'>,
  memberIds: ReadonlySet<string>,
): LandingSample[] {
  const seen = new Set<string>();
  const landings: LandingSample[] = [];
  for (const raw of parseTelemetryPayload(payload)) {
    const event = objectValue(raw);
    if (event._T !== 'LogParachuteLanding') continue;
    const character = objectValue(event.character);
    const accountId = typeof character.accountId === 'string' ? character.accountId : null;
    if (!accountId || !memberIds.has(accountId) || seen.has(accountId)) continue;
    const location = objectValue(character.location);
    const x = finite(location.x);
    const y = finite(location.y);
    if (x === null || y === null) continue;
    seen.add(accountId);
    const xMeters = x / 100;
    const yMeters = y / 100;
    landings.push({
      playerRef: landingPlayerRef(accountId),
      xMeters,
      yMeters,
      cell: gridCell(xMeters, yMeters, match.mapName),
    });
  }
  return landings;
}

export interface LandingMatchInput {
  match: NormalizedMatch;
  landings: readonly LandingSample[];
  memberIds: ReadonlySet<string>;
  /** Other teams that landed within the contest radius of the squad; null when unknown. */
  contestedTeams?: number | null;
  /** Named map area reported after landing. */
  region?: string | null;
}

export interface LandingCellStats {
  cell: string;
  /** Most common named area for matches that used this cell. */
  region: string | null;
  matches: number;
  share: number;
  top10: RateEstimate;
  medianPlacement: number | null;
  earlyWipeRate: number | null;
  averageDamage: number;
}

export interface LandingMapPreference {
  mapName: string;
  label: string;
  sizeKm: number | null;
  matches: number;
  matchesWithLanding: number;
  cells: LandingCellStats[];
  /** Share of matches where the squad's main cell equals its most frequent main cell. */
  topCellRepeatRate: number | null;
  /** Median distance (m) between a member's landing and the squad centre. */
  medianSpreadMeters: number | null;
  points: Array<{ x: number; y: number }>;
}

export interface ContestBucket {
  key: string;
  label: string;
  matches: number;
  top10: RateEstimate;
  earlyWipe: RateEstimate;
  medianPlacement: number | null;
}

export interface LandingContest {
  matches: number;
  buckets: ContestBucket[];
  /** Early-wipe rate with at least one contesting team minus the rate with none. */
  earlyWipeEdge: DifferenceEstimate;
  top10Edge: DifferenceEstimate;
}

export interface LandingPreference {
  schemaVersion: typeof LANDING_SCHEMA_VERSION;
  maps: LandingMapPreference[];
  contest: LandingContest;
  notes: string[];
}

function modalCell(landings: readonly LandingSample[]): string | null {
  const counts = new Map<string, number>();
  for (const landing of landings)
    if (landing.cell) counts.set(landing.cell, (counts.get(landing.cell) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [cell, count] of [...counts.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (count > bestCount) {
      best = cell;
      bestCount = count;
    }
  }
  return best;
}

function placementOf(players: readonly NormalizedPlayer[]): number | null {
  const ranks = new Set(
    players
      .map((player) => player.rank)
      .filter((rank): rank is number => rank !== null && rank > 0),
  );
  return ranks.size === 1 ? [...ranks][0]! : null;
}

export function buildLandingPreference(inputs: readonly LandingMatchInput[]): LandingPreference {
  const byMap = new Map<string, LandingMatchInput[]>();
  for (const input of inputs)
    byMap.set(input.match.mapName || '未知地图', [
      ...(byMap.get(input.match.mapName || '未知地图') ?? []),
      input,
    ]);
  const maps: LandingMapPreference[] = [...byMap.entries()]
    .map(([mapName, items]) => {
      const withLanding = items.filter((item) => item.landings.length > 0);
      const perMatch = withLanding.map((item) => {
        const players = item.match.players.filter((player) => item.memberIds.has(player.accountId));
        return {
          cell: modalCell(item.landings),
          region: item.region ?? null,
          placement: placementOf(players),
          earlyWipe:
            players.length > 0 &&
            Math.max(...players.map((player) => player.survivalTime)) < LANDING_EARLY_WIPE_SECONDS,
          damage: players.length
            ? players.reduce((sum, player) => sum + player.damage, 0) / players.length
            : 0,
        };
      });
      const cells = new Map<string, typeof perMatch>();
      for (const row of perMatch)
        if (row.cell) cells.set(row.cell, [...(cells.get(row.cell) ?? []), row]);
      const cellStats: LandingCellStats[] = [...cells.entries()]
        .map(([cell, rows]) => {
          const ranked = rows.filter((row) => row.placement !== null);
          const regions = new Map<string, number>();
          for (const row of rows)
            if (row.region) regions.set(row.region, (regions.get(row.region) ?? 0) + 1);
          return {
            cell,
            region:
              [...regions.entries()].sort(
                (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
              )[0]?.[0] ?? null,
            matches: rows.length,
            share: rows.length / perMatch.length,
            top10: wilsonInterval(
              ranked.filter((row) => row.placement! <= 10).length,
              ranked.length,
            ),
            medianPlacement: median(ranked.map((row) => row.placement!)),
            earlyWipeRate: rows.length
              ? rows.filter((row) => row.earlyWipe).length / rows.length
              : null,
            averageDamage: rows.reduce((sum, row) => sum + row.damage, 0) / rows.length,
          };
        })
        .sort((left, right) => right.matches - left.matches || left.cell.localeCompare(right.cell));
      const spreads = withLanding.flatMap((item) => {
        if (item.landings.length < 2) return [];
        const cx =
          item.landings.reduce((sum, landing) => sum + landing.xMeters, 0) / item.landings.length;
        const cy =
          item.landings.reduce((sum, landing) => sum + landing.yMeters, 0) / item.landings.length;
        return item.landings.map((landing) =>
          Math.hypot(landing.xMeters - cx, landing.yMeters - cy),
        );
      });
      return {
        mapName,
        label: mapDisplayName(mapName),
        sizeKm: mapSizeKm(mapName),
        matches: items.length,
        matchesWithLanding: withLanding.length,
        cells: cellStats,
        topCellRepeatRate: cellStats.length ? cellStats[0]!.matches / perMatch.length : null,
        medianSpreadMeters: median(spreads),
        points: withLanding.flatMap((item) =>
          item.landings.map((landing) => ({
            x: Math.round(landing.xMeters),
            y: Math.round(landing.yMeters),
          })),
        ),
      };
    })
    .sort(
      (left, right) => right.matches - left.matches || left.mapName.localeCompare(right.mapName),
    );
  const contestRows = inputs
    .filter(
      (input) =>
        input.landings.length > 0 &&
        input.contestedTeams !== null &&
        input.contestedTeams !== undefined,
    )
    .map((input) => {
      const players = input.match.players.filter((player) => input.memberIds.has(player.accountId));
      return {
        contested: input.contestedTeams!,
        placement: placementOf(players),
        earlyWipe:
          players.length > 0 &&
          Math.max(...players.map((player) => player.survivalTime)) < LANDING_EARLY_WIPE_SECONDS,
      };
    });
  const bucketOf = (key: string, label: string, rows: typeof contestRows): ContestBucket => {
    const ranked = rows.filter((row) => row.placement !== null);
    return {
      key,
      label,
      matches: rows.length,
      top10: wilsonInterval(ranked.filter((row) => row.placement! <= 10).length, ranked.length),
      earlyWipe: wilsonInterval(rows.filter((row) => row.earlyWipe).length, rows.length),
      medianPlacement: median(ranked.map((row) => row.placement!)),
    };
  };
  const calm = bucketOf(
    'calm',
    '无队伍争抢',
    contestRows.filter((row) => row.contested === 0),
  );
  const crowded = bucketOf(
    'crowded',
    '有队伍争抢',
    contestRows.filter((row) => row.contested >= 1),
  );
  const enough = calm.matches >= CONTEST_MIN_MATCHES && crowded.matches >= CONTEST_MIN_MATCHES;
  const none = newcombeDifference(wilsonInterval(0, 0), wilsonInterval(0, 0));
  const contest: LandingContest = {
    matches: contestRows.length,
    buckets: [
      calm,
      bucketOf(
        'one',
        '1 队争抢',
        contestRows.filter((row) => row.contested === 1),
      ),
      bucketOf(
        'many',
        '2 队及以上争抢',
        contestRows.filter((row) => row.contested >= 2),
      ),
    ],
    earlyWipeEdge: enough ? newcombeDifference(crowded.earlyWipe, calm.earlyWipe) : none,
    top10Edge: enough ? newcombeDifference(crowded.top10, calm.top10) : none,
  };
  const notes: string[] = [];
  const missing = inputs.length - inputs.filter((item) => item.landings.length > 0).length;
  if (missing > 0) notes.push(`${missing} 场没有可读的落地事件，未计入落点统计。`);
  notes.push(
    `落点按 ${LANDING_CELL_KM}km 方格归类；早崩 = 全队最长生存时间不足 ${LANDING_EARLY_WIPE_SECONDS / 60} 分钟。落点与名次只是相关性，不说明因果。`,
  );
  return { schemaVersion: LANDING_SCHEMA_VERSION, maps, contest, notes };
}
