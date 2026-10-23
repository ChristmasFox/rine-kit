export const TEAM_LEADERBOARD_METRICS = ['damage', 'kills', 'kd', 'matches', 'avg_damage'] as const;

export type TeamLeaderboardMetric = typeof TEAM_LEADERBOARD_METRICS[number];

export function parseTeamLeaderboardMetric(value: unknown): TeamLeaderboardMetric | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if ((TEAM_LEADERBOARD_METRICS as readonly string[]).includes(normalized)) return normalized as TeamLeaderboardMetric;
  if (['伤害', '伤害榜'].includes(normalized)) return 'damage';
  if (['kill', '击杀', '击杀榜'].includes(normalized)) return 'kills';
  if (normalized === 'kd') return 'kd';
  if (['match', '场次', '场次榜'].includes(normalized)) return 'matches';
  if (['场均伤害', '场均伤害榜'].includes(normalized)) return 'avg_damage';
  return null;
}

export function parseStoredTeamLeaderboardMetric(value: unknown): TeamLeaderboardMetric | null {
  let preference = value;
  if (typeof preference === 'string') {
    try { preference = JSON.parse(preference) as unknown; } catch { return null; }
  }
  if (!preference || typeof preference !== 'object' || Array.isArray(preference)) return null;
  return parseTeamLeaderboardMetric((preference as Record<string, unknown>).metric);
}

export function teamLeaderboardMetricLabel(metric: TeamLeaderboardMetric): string {
  return ({ damage: '伤害榜', kills: '击杀榜', kd: 'KD 榜', matches: '场次榜', avg_damage: '场均伤害榜' } as const)[metric];
}
