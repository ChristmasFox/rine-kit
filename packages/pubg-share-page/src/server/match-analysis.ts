import { parseTelemetryPayload, type NormalizedMatch } from '@rine-kit/pubg-domain';
import {
  analyzeCombatQuality,
  analyzeDeaths,
  analyzeFieldTelemetry,
  analyzeFights,
  analyzeLobby,
  analyzeMatchStory,
  analyzeStreaks,
  identifyMatchHighlights,
  type MatchHighlight,
  analyzeStyleTelemetry,
  emptyFights,
  extractLandings,
  landingPlayerRef,
  normalizeBattleTelemetry,
  reconstructBattleEpisodes,
  type CombatQualityMatchStats,
  type DeathRecord,
  type FieldMatchStats,
  type FightMatchStats,
  type LandingSample,
  type LobbyMatchStats,
  type MatchRotation,
  type PlayerStyleMatch,
  type StoryDown,
  type StreakMatchStats,
} from '@rine-kit/pubg-intelligence';

export interface MatchTelemetryAnalysis {
  highlights: MatchHighlight[];
  quality: CombatQualityMatchStats;
  deaths: DeathRecord[];
  landings: LandingSample[];
  field: FieldMatchStats;
  fights: FightMatchStats;
  style: Record<string, PlayerStyleMatch>;
  lobby: Record<string, LobbyMatchStats>;
  streaks: StreakMatchStats;
  /** Why each squad knock-down happened, and how the squad moved with the circle. */
  downs: StoryDown[];
  rotation: MatchRotation;
}

/** Every per-match derivation for a squad from one raw payload. Pure and CPU-bound, so it runs on a worker thread. */
export function computeMatchAnalysis(
  raw: Uint8Array,
  match: NormalizedMatch,
  memberIds: readonly string[],
): MatchTelemetryAnalysis {
  // Decompress and parse once: every analyser accepts the parsed event list, and re-parsing a 25 MB file for each of
  // them was most of the cost.
  const payload = parseTelemetryPayload(raw);
  const members = new Set(memberIds);
  const memberRefs = new Set(memberIds.map(landingPlayerRef));
  const telemetry = normalizeBattleTelemetry(payload, match);
  const landings = extractLandings(
    payload,
    match,
    new Set(match.players.map((player) => player.accountId)),
  );
  const trackedPlayerIds = match.players
    .filter((player) => members.has(player.accountId))
    .map((player) => player.accountId);
  const reconstruction = reconstructBattleEpisodes({ match, telemetry, trackedPlayerIds });
  const fightStats = analyzeFights(reconstruction, match.matchId, trackedPlayerIds);
  const rawStyle = analyzeStyleTelemetry(payload, new Set(trackedPlayerIds));
  const style: Record<string, PlayerStyleMatch> = {};
  for (const player of match.players) {
    const raw = rawStyle[player.accountId];
    if (!raw || !members.has(player.accountId)) continue;
    style[player.accountId] = {
      ...raw,
      minutes: Math.max(0, player.survivalTime) / 60,
      fights: fightStats.roles[player.accountId] ?? emptyFights(),
    };
  }
  const story = analyzeMatchStory(payload, new Set(trackedPlayerIds));
  const streaks = analyzeStreaks(payload, new Set(trackedPlayerIds));
  return {
    highlights: identifyMatchHighlights({
      payload,
      match,
      memberIds: trackedPlayerIds,
      story,
      streaks,
      telemetry,
    }),
    quality: analyzeCombatQuality(reconstruction),
    deaths: analyzeDeaths(telemetry, trackedPlayerIds),
    landings: landings.filter((landing) => memberRefs.has(landing.playerRef)),
    field: analyzeFieldTelemetry(payload, new Set(trackedPlayerIds)),
    fights: fightStats,
    style,
    lobby: analyzeLobby(payload, new Set(trackedPlayerIds)),
    streaks,
    downs: story.downs,
    rotation: story.rotation,
  };
}
