import { createHash } from 'node:crypto';
import type { NormalizedMatch, NormalizedPlayer } from '@rine-kit/pubg-domain';
import type { ResearchIntent } from './intent.js';

export interface ResearchSquad {
  id: string;
  label: string;
  memberIds: string[];
  members: Array<{ id: string; name: string }>;
  matchCount: number;
}

export interface ResearchEvidence {
  id: string;
  matchId: string;
  occurredAt: string | null;
  mapName: string;
  source: 'match_store' | 'telemetry_feature';
  field: string;
  value: string;
  description: string;
}

export interface ResearchPlayerMetric {
  id: string;
  name: string;
  matches: number;
  kills: number;
  damage: number;
  knocks: number;
  revives: number;
  averageDamage: number;
  averageSurvivalTime: number;
  wins: number;
}

export interface ResearchBreakdown {
  label: string;
  matches: number;
  rankedMatches: number;
  total: number;
  average: number;
  wins: number;
  top10: number;
}

export interface ResearchReport {
  status: 'ok' | 'partial' | 'empty';
  action: ResearchIntent['action'];
  metric: ResearchIntent['metric'];
  scope: {
    squadLabel: string;
    from: string | null;
    to: string | null;
    selectedMatches: number;
    availableMatches: number;
  };
  summary: {
    totalKills: number;
    totalDamage: number;
    averageKills: number;
    averageDamage: number;
    averageKnocks: number;
    averageRevives: number;
    wins: number;
    top10: number;
    rankedMatches: number;
    winRate: number | null;
    top10Rate: number | null;
  };
  telemetry: {
    currentCacheMatches: number;
    missingCurrentCacheMatches: number;
    coverageRate: number | null;
  };
  players: ResearchPlayerMetric[];
  breakdown: ResearchBreakdown[];
  evidence: ResearchEvidence[];
  evidenceCount: number;
  answer: string;
}

export interface BuildResearchReportInput {
  matches: readonly NormalizedMatch[];
  squad: Pick<ResearchSquad, 'label' | 'memberIds'>;
  intent: ResearchIntent;
  fromMs?: number;
  toMs?: number;
  telemetryMatchIds?: ReadonlySet<string>;
  selectedMatchId?: string;
}

function dateOf(match: NormalizedMatch): string | null {
  const value =
    match.createdAt ??
    (Number.isFinite(match.timestamp) ? new Date(match.timestamp).toISOString() : null);
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function membersOf(match: NormalizedMatch, ids: ReadonlySet<string>): NormalizedPlayer[] {
  if (ids.size === 0) return match.players;
  return match.players.filter((player) => ids.has(player.accountId));
}

function placementOf(players: readonly NormalizedPlayer[]): number | null {
  const ranks = players
    .map((player) => player.rank)
    .filter((rank): rank is number => rank !== null && rank > 0);
  const distinct = new Set(ranks);
  return distinct.size === 1 ? ranks[0]! : null;
}

function metricFor(
  matchPlayers: readonly NormalizedPlayer[],
  metric: ResearchIntent['metric'],
): number | null {
  switch (metric) {
    case 'kills':
      return matchPlayers.reduce((sum, player) => sum + player.kills, 0);
    case 'knocks':
      return matchPlayers.reduce((sum, player) => sum + player.dbnos, 0);
    case 'revives':
      return matchPlayers.reduce((sum, player) => sum + player.revives, 0);
    case 'wins': {
      const placement = placementOf(matchPlayers);
      return placement === null ? null : placement === 1 ? 1 : 0;
    }
    case 'top10': {
      const placement = placementOf(matchPlayers);
      return placement === null ? null : placement <= 10 ? 1 : 0;
    }
    case 'matches':
      return 1;
    case 'survival_time':
      return matchPlayers.length
        ? matchPlayers.reduce((sum, player) => sum + player.survivalTime, 0) / matchPlayers.length
        : 0;
    case 'damage':
    case null:
      return matchPlayers.reduce((sum, player) => sum + player.damage, 0);
  }
}

function stableWeek(timestamp: number): string {
  const monday = new Date(timestamp);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function metricLabel(metric: ResearchIntent['metric']): string {
  return (
    {
      damage: '伤害',
      kills: '击杀',
      knocks: '倒地',
      revives: '救援',
      wins: '吃鸡',
      top10: '前十',
      matches: '比赛数',
      survival_time: '平均生存时长',
    } as const
  )[metric ?? 'damage'];
}

function fmt(value: number): string {
  return Math.round(value).toLocaleString('zh-CN');
}

function breakdownValue(item: ResearchBreakdown, metric: ResearchIntent['metric']): string {
  if (metric === 'wins' || metric === 'top10')
    return item.rankedMatches ? `${(item.average * 100).toFixed(1)}%` : '排名未知';
  if (metric === 'matches') return `${item.matches} 场`;
  return fmt(item.average);
}

function buildAnswer(report: Omit<ResearchReport, 'answer'>): string {
  if (!report.scope.selectedMatches)
    return '当前小队和时间范围内没有可分析的历史比赛。可以扩大时间范围或选择其他小队。';
  if (report.action === 'telemetry_coverage') {
    const rate =
      report.telemetry.coverageRate === null
        ? '未知'
        : `${(report.telemetry.coverageRate * 100).toFixed(1)}%`;
    return `当前范围有 ${report.scope.selectedMatches} 场比赛，其中 ${report.telemetry.currentCacheMatches} 场有 parser/feature v6 缓存，覆盖率 ${rate}。没有缓存的比赛仍可查看 Match Store 基础战绩；本地研究不会重新下载 Telemetry。`;
  }
  if (report.action === 'trend') {
    if (!report.breakdown.length)
      return `当前范围有 ${report.scope.selectedMatches} 场，但没有足够数据生成${metricLabel(report.metric)}趋势。`;
    const points = report.breakdown
      .map((item) => `${item.label} ${breakdownValue(item, report.metric)}`)
      .join('；');
    return `${metricLabel(report.metric)}逐周趋势（每场平均）：${points}。总计 ${report.scope.selectedMatches} 场，证据可按日期和地图逐场查看。`;
  }
  if (report.action === 'player_comparison') {
    const ordered = [...report.players].sort((left, right) => {
      const metric = report.metric ?? 'damage';
      const value = (player: ResearchPlayerMetric) =>
        metric === 'matches'
          ? player.matches
          : metric === 'wins'
            ? player.wins
            : metric === 'knocks'
              ? player.knocks
              : metric === 'revives'
                ? player.revives
                : metric === 'kills'
                  ? player.kills
                  : metric === 'survival_time'
                    ? player.averageSurvivalTime
                    : player.damage;
      return value(right) - value(left);
    });
    const leaders = ordered
      .slice(0, 4)
      .map(
        (player) =>
          `${player.name} ${fmt(report.metric === 'matches' ? player.matches : report.metric === 'wins' ? player.wins : report.metric === 'knocks' ? player.knocks : report.metric === 'revives' ? player.revives : report.metric === 'kills' ? player.kills : report.metric === 'survival_time' ? player.averageSurvivalTime : player.damage)}`,
      )
      .join('；');
    return `按${metricLabel(report.metric)}比较队员（${report.scope.selectedMatches} 场）：${leaders}。统计只累计所选范围中可见的队员战绩。`;
  }
  if (report.action === 'map_breakdown') {
    const maps = report.breakdown
      .map(
        (item) =>
          `${item.label} ${breakdownValue(item, report.metric)}${report.metric === 'matches' ? '' : ' / 场'}（${item.matches} 场，${item.rankedMatches} 场有排名）`,
      )
      .join('；');
    return `按地图拆分${metricLabel(report.metric)}：${maps || '暂无可用地图分组'}。地图样本数不同，比较时请同时看每组场数。`;
  }
  if (report.action === 'unsupported')
    return '我可以研究小队比赛统计、队员对比、地图表现、时间趋势和 Telemetry 缓存覆盖。请把问题限定在这些 PUBG 数据范围内。';
  const winRate =
    report.summary.winRate === null ? '未知' : `${(report.summary.winRate * 100).toFixed(1)}%`;
  const top10Rate =
    report.summary.top10Rate === null ? '未知' : `${(report.summary.top10Rate * 100).toFixed(1)}%`;
  const rankNote =
    report.summary.rankedMatches < report.scope.selectedMatches
      ? `排名仅 ${report.summary.rankedMatches}/${report.scope.selectedMatches} 场可用，胜率与前十率按有排名场数计算。`
      : '';
  return `当前范围 ${report.scope.selectedMatches} 场：累计 ${fmt(report.summary.totalKills)} 杀，平均每场 ${fmt(report.summary.averageDamage)} 伤害、${fmt(report.summary.averageKnocks)} 倒地、${fmt(report.summary.averageRevives)} 次救援；吃鸡 ${report.summary.wins} 场（${winRate}），前十 ${report.summary.top10} 场（${top10Rate}）。${rankNote}事件级 Telemetry 缓存覆盖 ${report.telemetry.currentCacheMatches}/${report.scope.selectedMatches} 场。`;
}

export function buildResearchReport(input: BuildResearchReportInput): ResearchReport {
  const squadIds = new Set(input.squad.memberIds);
  const available = input.matches
    .filter((match) => {
      const time = Number.isFinite(match.timestamp)
        ? match.timestamp
        : Date.parse(match.createdAt ?? '');
      if (!Number.isFinite(time)) return false;
      if (input.fromMs !== undefined && time < input.fromMs) return false;
      if (input.toMs !== undefined && time >= input.toMs) return false;
      if (input.selectedMatchId && match.matchId !== input.selectedMatchId) return false;
      return squadIds.size === 0 || match.players.some((player) => squadIds.has(player.accountId));
    })
    .sort((a, b) => a.timestamp - b.timestamp || a.matchId.localeCompare(b.matchId));

  const selected = available.flatMap((match) => {
    const players = membersOf(match, squadIds);
    return players.length || squadIds.size === 0
      ? [{ match, players, placement: placementOf(players) }]
      : [];
  });
  const telemetryCount = selected.filter(
    ({ match }) => input.telemetryMatchIds?.has(match.matchId) ?? false,
  ).length;
  const totalDamage = selected.reduce(
    (sum, item) => sum + item.players.reduce((value, player) => value + player.damage, 0),
    0,
  );
  const totalKills = selected.reduce(
    (sum, item) => sum + item.players.reduce((value, player) => value + player.kills, 0),
    0,
  );
  const totalKnocks = selected.reduce(
    (sum, item) => sum + item.players.reduce((value, player) => value + player.dbnos, 0),
    0,
  );
  const totalRevives = selected.reduce(
    (sum, item) => sum + item.players.reduce((value, player) => value + player.revives, 0),
    0,
  );
  const wins = selected.filter((item) => item.placement === 1).length;
  const top10 = selected.filter((item) => item.placement !== null && item.placement <= 10).length;
  const rankedMatches = selected.filter((item) => item.placement !== null).length;
  const count = selected.length;

  const playerMap = new Map<
    string,
    {
      player: NormalizedPlayer;
      matches: number;
      kills: number;
      damage: number;
      knocks: number;
      revives: number;
      survivalTime: number;
      wins: number;
    }
  >();
  for (const { players } of selected) {
    for (const player of players) {
      const current = playerMap.get(player.accountId) ?? {
        player,
        matches: 0,
        kills: 0,
        damage: 0,
        knocks: 0,
        revives: 0,
        survivalTime: 0,
        wins: 0,
      };
      current.matches += 1;
      current.kills += player.kills;
      current.damage += player.damage;
      current.knocks += player.dbnos;
      current.revives += player.revives;
      current.survivalTime += player.survivalTime;
      current.wins += placementOf(players) === 1 && player.rank === 1 ? 1 : 0;
      playerMap.set(player.accountId, current);
    }
  }
  const players = [...playerMap.entries()]
    .map(([id, value]) => ({
      id: createHash('sha256').update(id).digest('hex').slice(0, 12),
      name: value.player.displayName || value.player.playerName,
      matches: value.matches,
      kills: value.kills,
      damage: value.damage,
      knocks: value.knocks,
      revives: value.revives,
      averageDamage: value.matches ? value.damage / value.matches : 0,
      averageSurvivalTime: value.matches ? value.survivalTime / value.matches : 0,
      wins: value.wins,
    }))
    .sort((a, b) => b.damage - a.damage || b.kills - a.kills || a.name.localeCompare(b.name));

  const totalFor = (items: typeof selected, metric: ResearchIntent['metric']): number =>
    items.reduce((sum, item) => sum + (metricFor(item.players, metric) ?? 0), 0);
  const grouped = new Map<string, typeof selected>();
  if (input.intent.action === 'trend') {
    for (const item of selected) {
      const key = stableWeek(item.match.timestamp);
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
  } else if (input.intent.action === 'map_breakdown') {
    for (const item of selected) {
      const key = item.match.mapName || '未知地图';
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
  }
  const breakdown: ResearchBreakdown[] = [...grouped.entries()]
    .map(([label, items]) => {
      const total = totalFor(items, input.intent.metric);
      const groupRankedMatches = items.filter((item) => item.placement !== null).length;
      const groupWins = items.filter((item) => item.placement === 1).length;
      const groupTop10 = items.filter(
        (item) => item.placement !== null && item.placement <= 10,
      ).length;
      return {
        label,
        matches: items.length,
        rankedMatches: groupRankedMatches,
        total,
        average:
          input.intent.metric === 'wins'
            ? groupRankedMatches
              ? groupWins / groupRankedMatches
              : 0
            : input.intent.metric === 'top10'
              ? groupRankedMatches
                ? groupTop10 / groupRankedMatches
                : 0
              : items.length
                ? total / items.length
                : 0,
        wins: groupWins,
        top10: groupTop10,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const evidence = selected
    .slice(-40)
    .reverse()
    .map(({ match, players: matchPlayers }) => {
      const metric = input.intent.metric ?? 'damage';
      const value = metricFor(matchPlayers, metric);
      const at = dateOf(match);
      const matchDamage = matchPlayers.reduce((sum, player) => sum + player.damage, 0);
      const matchKills = matchPlayers.reduce((sum, player) => sum + player.kills, 0);
      const matchPlacement = placementOf(matchPlayers);
      return {
        id: `match-${match.matchId}-${metric}`,
        matchId: match.matchId,
        occurredAt: at,
        mapName: match.mapName || '未知地图',
        source: 'match_store' as const,
        field: metric,
        value: value === null ? '排名未知' : `${fmt(value)} ${metricLabel(metric)}`,
        description: `${matchPlacement ? `排名第 ${matchPlacement} · ` : ''}${fmt(matchKills)} 杀 · ${fmt(matchDamage)} 伤害`,
      };
    });

  const from = input.fromMs === undefined ? null : new Date(input.fromMs).toISOString();
  const to = input.toMs === undefined ? null : new Date(input.toMs - 1).toISOString();
  const base: Omit<ResearchReport, 'answer'> = {
    status: count === 0 ? 'empty' : telemetryCount < count ? 'partial' : 'ok',
    action: input.intent.action,
    metric: input.intent.metric,
    scope: {
      squadLabel: input.squad.label,
      from,
      to,
      selectedMatches: count,
      availableMatches: input.matches.length,
    },
    summary: {
      totalKills,
      totalDamage,
      averageKills: count ? totalKills / count : 0,
      averageDamage: count ? totalDamage / count : 0,
      averageKnocks: count ? totalKnocks / count : 0,
      averageRevives: count ? totalRevives / count : 0,
      wins,
      top10,
      rankedMatches,
      winRate: rankedMatches ? wins / rankedMatches : null,
      top10Rate: rankedMatches ? top10 / rankedMatches : null,
    },
    telemetry: {
      currentCacheMatches: telemetryCount,
      missingCurrentCacheMatches: count - telemetryCount,
      coverageRate: count ? telemetryCount / count : null,
    },
    players,
    breakdown,
    evidence,
    evidenceCount: selected.length,
  };
  return { ...base, answer: buildAnswer(base) };
}

export function buildResearchSquads(matches: readonly NormalizedMatch[]): ResearchSquad[] {
  const pairCounts = new Map<string, number>();
  const names = new Map<string, Map<string, number>>();
  const appearances = new Map<string, number>();
  for (const match of matches) {
    const ids = [...new Set(match.players.map((player) => player.accountId))].sort();
    for (const player of match.players) {
      appearances.set(player.accountId, (appearances.get(player.accountId) ?? 0) + 1);
      const options = names.get(player.accountId) ?? new Map<string, number>();
      const label = player.displayName || player.playerName || '队员';
      options.set(label, (options.get(label) ?? 0) + 1);
      names.set(player.accountId, options);
    }
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const key = `${ids[left]}\u0000${ids[right]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const ids = [...appearances.keys()].sort(
    (a, b) => (appearances.get(b) ?? 0) - (appearances.get(a) ?? 0) || a.localeCompare(b),
  );
  const adjacency = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const [key, count] of pairCounts) {
    if (count < 2) continue;
    const [left, right] = key.split('\u0000');
    adjacency.get(left!)?.add(right!);
    adjacency.get(right!)?.add(left!);
  }
  const groups: string[][] = [];
  const visited = new Set<string>();
  for (const id of ids) {
    if (visited.has(id)) continue;
    const pending = [id];
    const group: string[] = [];
    visited.add(id);
    while (pending.length) {
      const current = pending.pop()!;
      group.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          pending.push(next);
        }
      }
    }
    if (group.length > 1) groups.push(group.sort());
  }
  const profiles = groups
    .map((memberIds, index) => {
      const memberSet = new Set(memberIds);
      const matchCount = matches.filter((match) =>
        match.players.some((player) => memberSet.has(player.accountId)),
      ).length;
      const id = createHash('sha256').update(memberIds.join('\u0000')).digest('hex').slice(0, 12);
      const members = memberIds.map((memberId) => {
        const options = names.get(memberId);
        const name =
          [...(options?.entries() ?? [])].sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
          )[0]?.[0] ?? '队员';
        return { id: createHash('sha256').update(memberId).digest('hex').slice(0, 12), name };
      });
      return {
        id,
        label: `小队 ${String.fromCharCode(65 + index)}`,
        memberIds,
        members,
        matchCount,
      };
    })
    .sort(
      (a, b) =>
        b.matchCount - a.matchCount ||
        b.memberIds.length - a.memberIds.length ||
        a.id.localeCompare(b.id),
    );
  return profiles.map((profile, index) => ({
    ...profile,
    label: `小队 ${String.fromCharCode(65 + index)}`,
  }));
}
