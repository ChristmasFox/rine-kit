import { type NormalizedMatch } from '@rine-kit/pubg-domain';
import {
  DOWN_CAUSES,
  mapDisplayName,
  mapSizeKm,
  type ResearchSquad,
} from '@rine-kit/pubg-intelligence';
import type { StoryContext } from './context.js';
import type { MatchTelemetryAnalysis } from './match-analysis.js';
import { safePlayerName } from './names.js';

/**
 * Analyse one archived match for a squad. The result is looked up in memory, then on disk, and only computed (on a
 * worker thread, so the server stays responsive) when neither has it. Returns 'missing' when the archive has no entry
 * (the CDN keeps telemetry for about 14 days) and 'failed' when it cannot be parsed.
 */
export function analyzeMatchTelemetry(
  context: StoryContext,
  squad: ResearchSquad,
  match: NormalizedMatch,
): Promise<MatchTelemetryAnalysis | 'missing' | 'failed'> {
  const key = `${squad.id}|${match.matchId}`;
  const cached = context.telemetry.get(key);
  if (cached) return cached;
  const request = (async (): Promise<MatchTelemetryAnalysis | 'missing' | 'failed'> => {
    const stored = context.cache.read<MatchTelemetryAnalysis>(squad.id, match.matchId);
    if (stored) return stored;
    try {
      const result = await context.pool.run<MatchTelemetryAnalysis | 'missing'>({
        kind: 'analysis',
        archiveDirectory: context.archiveDirectory,
        match,
        memberIds: [...squad.memberIds],
      });
      if (result !== 'missing') context.cache.write(squad.id, match.matchId, result);
      return result;
    } catch {
      return 'failed';
    }
  })();
  context.telemetry.set(key, request);
  return request;
}

/** Plain-language story of one match: lifelines, fights, route and circle, plus each member's numbers. */
export async function computeMatchStory(
  context: StoryContext,
  squad: ResearchSquad,
  match: NormalizedMatch,
) {
  const members = squad.memberIds.length
    ? match.players.filter((player) => squad.memberIds.includes(player.accountId))
    : match.players.slice(0, 4);
  const trackedIds = new Set(members.map((player) => player.accountId));
  const names: Record<string, string> = {};
  members.forEach((player, index) => {
    names[player.accountId] = safePlayerName(player.displayName || player.playerName, index);
  });
  const base = {
    matchId: match.matchId,
    mapName: match.mapName || null,
    mapLabel: mapDisplayName(match.mapName || '未知地图'),
    mapSizeKm: mapSizeKm(match.mapName || ''),
    gameMode: match.gameMode,
    durationSeconds: match.duration,
    createdAt: match.createdAt ?? null,
    names,
    downCauses: DOWN_CAUSES,
  };
  const archived = await context.archivedIds();
  const rows = members.map((player) => ({
    accountId: player.accountId,
    name: names[player.accountId]!,
    damage: player.damage,
    kills: player.kills,
    knocks: player.dbnos,
    assists: player.assists,
    revives: player.revives,
    survivalSeconds: Math.max(0, player.survivalTime),
    rank: player.rank,
    hitRate: null as number | null,
    damagePerMinute: null as number | null,
    timesDowned: null as number | null,
    heals: null as number | null,
    throwables: null as number | null,
    rides: null as number | null,
    footKm: null as number | null,
    longestStreak: null as number | null,
  }));
  if (!archived.has(match.matchId))
    return { ...base, available: false, reason: 'no_archive', players: rows, story: null };
  try {
    const story = await context.pool.run<Parameters<typeof JSON.stringify>[0] | 'missing'>({
      kind: 'story',
      archiveDirectory: context.archiveDirectory,
      match,
      memberIds: [...trackedIds],
    });
    if (story === 'missing')
      return { ...base, available: false, reason: 'no_archive', players: rows, story: null };
    const analysis = await analyzeMatchTelemetry(
      context,
      squad.memberIds.length ? squad : { ...squad, memberIds: [...trackedIds] },
      match,
    );
    if (typeof analysis !== 'string') {
      for (const row of rows) {
        const style = analysis.style[row.accountId];
        const streak = analysis.streaks.players[row.accountId];
        if (style) {
          const shots = style.shots;
          const hits = style.hits;
          row.hitRate = shots >= 30 ? hits / shots : null;
          row.damagePerMinute =
            style.minutes >= 1 ? (style.gunDamage + style.explosiveDamage) / style.minutes : null;
          row.heals = style.healUses + style.boostUses;
          row.throwables =
            style.throwables.frag +
            style.throwables.smoke +
            style.throwables.flash +
            style.throwables.fire;
          row.rides = style.rides;
          row.footKm = style.footMeters / 1000;
        }
        row.timesDowned = analysis.fights.roles[row.accountId]?.timesDowned ?? null;
        row.longestStreak = streak?.longest ?? null;
      }
    }
    return { ...base, available: true, reason: null, players: rows, story };
  } catch {
    return { ...base, available: false, reason: 'unreadable', players: rows, story: null };
  }
}
