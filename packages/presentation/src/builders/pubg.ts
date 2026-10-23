import { containsInternalTimeTerms } from '../time/format.js';
import type {
  PresentationTextItem,
  PubgComparisonPresentation,
  PubgComparisonSegment,
  PubgMatchDetailPresentation,
  PubgMatchListPresentation,
  PubgMatchReviewPresentation,
  PubgMetricRow,
  PubgPeriodReviewPresentation,
  PubgPresentation,
  PubgPresentationScalar,
  PubgPresentationStatus,
  PubgSourceRange,
  PubgStatsPresentation,
  PubgStatusPresentation,
  PubgTeamDamageLedger,
  PubgTeamDamagePresentation,
  PubgTeamDamageSlice,
  PubgPresentationCoverage,
} from '../contracts/pubg.js';
import { sessionMapName } from '../renderers/session-review.js';
import {
  assertValid,
  validatePubgComparisonPresentation,
  validatePubgMatchDetailPresentation,
  validatePubgMatchListPresentation,
  validatePubgMatchReviewPresentation,
  validatePubgPeriodReviewPresentation,
  validatePubgStatsPresentation,
  validatePubgStatusPresentation,
  validatePubgTeamDamagePresentation,
} from '../validation/validate.js';

export interface PubgToolPresentationInput {
  toolName?: string;
  status?: PubgPresentationStatus;
  data: unknown;
  dataUpdatedAt: string;
  sourceRange?: PubgSourceRange;
  coverage?: PubgPresentationCoverage;
  queryResolved?: Record<string, unknown>;
  evidenceRefs?: {
    matchIds?: string[];
    playerIds?: string[];
    fields?: string[];
  };
  error?: { code?: string; reason?: string };
  teamDamage?: {
    aggregateByActor?: boolean;
    actorPlayerId?: string;
    victimPlayerId?: string;
  };
  presentationStyle?: 'public_agent';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate || containsInternalTimeTerms(candidate)) return fallback;
  return candidate;
}

function scalar(value: unknown): PubgPresentationScalar {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function sourceRange(input: PubgToolPresentationInput): PubgSourceRange | undefined {
  const range = input.sourceRange;
  if (!range) return undefined;
  const segments = range.segments?.filter((segment) => segment.label.trim()) ?? [];
  if (range.from === null && range.to === null && segments.length === 0) return undefined;
  return { from: range.from, to: range.to, ...(segments.length ? { segments } : {}) };
}

function evidencePool(input: PubgToolPresentationInput, extra: string[] = []): Set<string> {
  return new Set([
    ...(input.evidenceRefs?.matchIds ?? []),
    ...(input.evidenceRefs?.playerIds ?? []),
    ...(input.evidenceRefs?.fields ?? []),
    ...extra,
  ]);
}

function evidenceFor(value: unknown, known: ReadonlySet<string>): string[] {
  const row = record(value);
  const raw = Array.isArray(row.evidenceRefs)
    ? row.evidenceRefs
    : Array.isArray(row.evidenceIds)
      ? row.evidenceIds
      : [];
  return raw.filter((item): item is string => typeof item === 'string' && known.has(item));
}

function textItems(value: unknown, fallbackEvidence: string[] = []): PresentationTextItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    const rawText =
      typeof row.text === 'string' && row.text.trim()
        ? row.text
        : typeof row.title === 'string'
          ? `${row.title}${typeof row.text === 'string' && row.text ? `：${row.text}` : ''}`
          : '';
    if (!rawText.trim()) return [];
    const refs = Array.isArray(row.evidenceIds)
      ? row.evidenceIds.filter((id): id is string => typeof id === 'string')
      : Array.isArray(row.evidenceRefs)
        ? row.evidenceRefs.filter((id): id is string => typeof id === 'string')
        : fallbackEvidence;
    return [{ text: rawText.trim(), evidenceRefs: refs }];
  });
}

function values(value: unknown): Record<string, PubgPresentationScalar> {
  const source = record(value);
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, scalar(item)]));
}

function metricRows(value: unknown, known: ReadonlySet<string>): PubgMetricRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    const label = text(row.label ?? row.key, '未知对象');
    const position = row.position === null ? null : numberOrNull(row.position);
    const rowEvidence = evidenceFor(row, known);
    return [
      {
        label,
        values: values(row.metrics ?? row.values),
        ...(row.position !== undefined ? { position } : {}),
        evidenceRefs: rowEvidence,
      },
    ];
  });
}

function queryLabel(input: PubgToolPresentationInput, fallback: string): string {
  const query = record(input.queryResolved);
  const selector = record(query.resolvedSelector ?? query.selector);
  return text(selector.label ?? record(query.summary).periodLabel, fallback);
}

function publicPeriodLabel(input: PubgToolPresentationInput, fallback: string): string {
  let label = queryLabel(input, '');
  if (!label) {
    const query = record(input.queryResolved);
    const selector = record(query.resolvedSelector ?? query.selector);
    const value = stringOrNull(selector.value);
    label = value
      ? ((
          {
            today: '今日',
            yesterday: '昨天',
            last_night: '昨晚',
            last_7_days: '最近七天',
            previous_7_days: '此前七天',
            this_week: '本周',
            last_week: '上周',
          } as Record<string, string>
        )[value] ?? value)
      : fallback;
  }
  return label === '今天' ? '今日' : label;
}

const METRIC_LABELS: Record<string, string> = {
  matches: '场次',
  kills: '击杀',
  assists: '助攻',
  damage: '伤害',
  avg_damage: '场均伤害',
  kd: 'KD',
  deaths: '死亡',
  wins: '胜利',
  top10: '前十',
  rank: '排名',
  dbnos: '倒地',
  revives: '救援',
  headshot_kills: '爆头击杀',
  survival_time: '生存时间',
  longest_kill: '最远击杀',
  avg_kills: '场均击杀',
  avg_rank: '场均排名',
  top10_rate: '前十率',
  denominatorZero: '零死亡场次',
  performance_score: '表现分',
  chicken_index: '吃鸡指数',
};

function statusMessage(status: PubgPresentationStatus): string {
  if (status === 'partial') return '结果不完整，缺失事实保持为未知。';
  if (status === 'no_matches') return '没有找到符合条件的比赛。';
  if (status === 'error') return '当前数据源无法完成这次查询，没有使用旧聊天数据代替。';
  return '';
}

function base(input: PubgToolPresentationInput): {
  status: PubgPresentationStatus;
  dataUpdatedAt: string;
  sourceRange?: PubgSourceRange;
  coverage?: PubgPresentationCoverage;
} {
  const status = input.status ?? 'ok';
  const range = sourceRange(input);
  return {
    status,
    dataUpdatedAt: input.dataUpdatedAt,
    ...(range ? { sourceRange: range } : {}),
    ...(input.coverage ? { coverage: input.coverage } : {}),
  };
}

function knownFor(input: PubgToolPresentationInput, extra: string[] = []): Set<string> {
  const known = evidencePool(input, extra);
  for (const item of extra) known.add(item);
  return known;
}

export function buildPubgStatusPresentation(
  input: PubgToolPresentationInput,
): PubgStatusPresentation {
  const status = input.status ?? 'error';
  const toolName = input.toolName ?? 'pubg';
  const title =
    toolName === 'pubg_resolve_players'
      ? 'PUBG 玩家查询'
      : toolName === 'pubg_prefetch_telemetry'
        ? 'PUBG Telemetry 同步'
        : toolName === 'pubg_telemetry_sync_report'
          ? 'PUBG Telemetry D-mail'
          : 'PUBG 查询状态';
  const errorCode = stringOrNull(input.error?.code);
  const message =
    status === 'error' && input.error?.reason
      ? `查询失败：${text(input.error.reason, '数据源返回错误。')}`
      : statusMessage(status) || '查询完成。';
  const presentation: PubgStatusPresentation = {
    ...base(input),
    type: 'pubg_status',
    headline: title,
    message,
    ...(errorCode ? { errorCode } : {}),
    evidenceRefs: input.evidenceRefs?.matchIds ?? [],
  };
  return assertValid(validatePubgStatusPresentation(presentation, evidencePool(input)));
}

export function buildPubgStatsPresentation(
  input: PubgToolPresentationInput,
): PubgStatsPresentation {
  const data = record(input.data);
  const known = knownFor(input);
  const summary = record(data.summary);
  const rows = metricRows(data.rows, known);
  const matchCount = numberOrNull(summary.uniqueMatchCount);
  const summaryText =
    typeof data.summary === 'string'
      ? text(data.summary, '战绩已生成。')
      : matchCount === null
        ? '战绩已生成。'
        : `共 ${matchCount} 场。`;
  const query = record(input.queryResolved);
  const reference = record(query.reference);
  const orderBy = record(query.orderBy);
  const requestedMetrics = Array.isArray(query.metrics) ? query.metrics : [];
  const subjectLabel = reference.subjectExplicit === true ? '玩家' : '队伍';
  const operation = text(data.operation ?? query.operation, 'report');
  const requestedMetric = stringOrNull(orderBy.metric) ?? stringOrNull(requestedMetrics[0]);
  const publicHeadline =
    operation === 'rank'
      ? `${publicPeriodLabel(input, 'PUBG')}${requestedMetric ? (METRIC_LABELS[requestedMetric] ?? requestedMetric) : ''}榜`
      : `${publicPeriodLabel(input, 'PUBG')}${subjectLabel}战绩`;
  const presentation: PubgStatsPresentation = {
    ...base(input),
    type: 'pubg_stats',
    headline:
      input.presentationStyle === 'public_agent' ? publicHeadline : queryLabel(input, 'PUBG 战绩'),
    operation,
    groupBy: text(data.groupBy ?? query.groupBy, 'player'),
    summary: `${statusMessage(input.status ?? 'ok')}${statusMessage(input.status ?? 'ok') ? '\n' : ''}${summaryText}`,
    rows,
    evidenceRefs: input.evidenceRefs?.matchIds ?? [],
  };
  return assertValid(validatePubgStatsPresentation(presentation, known));
}

export function buildPubgMatchListPresentation(
  input: PubgToolPresentationInput,
): PubgMatchListPresentation {
  const data = record(input.data);
  const known = knownFor(input);
  const matches = Array.isArray(data.matches)
    ? data.matches.flatMap((item) => {
        const row = record(item);
        const matchId = stringOrNull(row.matchId);
        if (!matchId) return [];
        const players = Array.isArray(row.players)
          ? row.players
              .map((player) => {
                const value = record(player);
                return `${text(value.name ?? value.playerName, '未知玩家')} 击杀${scalar(value.kills) ?? '未知'} 伤害${scalar(value.damage) ?? '未知'}`;
              })
              .join('；')
          : '';
        return [
          {
            matchId,
            startedAt: stringOrNull(row.startedAt),
            mapName: text(row.mapName, '未知地图'),
            gameMode: text(row.gameMode, '未知模式'),
            placement: numberOrNull(row.placement),
            summary: players || '玩家事实未知',
            evidenceRefs: evidenceFor(row, known),
          },
        ];
      })
    : [];
  const total = numberOrNull(data.total);
  const summary =
    total === null
      ? `返回 ${matches.length} 场比赛。`
      : `共 ${total} 场比赛，当前返回 ${matches.length} 场。`;
  const presentation: PubgMatchListPresentation = {
    ...base(input),
    type: 'pubg_match_list',
    headline: queryLabel(input, 'PUBG 比赛列表'),
    summary: `${statusMessage(input.status ?? 'ok')}${statusMessage(input.status ?? 'ok') ? '\n' : ''}${summary}`,
    matches,
    evidenceRefs: input.evidenceRefs?.matchIds ?? [],
  };
  return assertValid(validatePubgMatchListPresentation(presentation, known));
}

function comparisonSegmentRange(
  input: PubgToolPresentationInput,
  index: number,
): PubgSourceRange | undefined {
  const segment = input.sourceRange?.segments?.[index];
  if (!segment) return undefined;
  return { from: segment.from, to: segment.to };
}

export function buildPubgComparisonPresentation(
  input: PubgToolPresentationInput,
): PubgComparisonPresentation {
  const data = record(input.data);
  const known = knownFor(input);
  const segments: PubgComparisonSegment[] = Array.isArray(data.segments)
    ? data.segments.map((item, index) => {
        const segment = record(item);
        const range = comparisonSegmentRange(input, index);
        return {
          label: text(segment.label, `区间 ${index + 1}`),
          ...(range ? { sourceRange: range } : {}),
          rows: metricRows(segment.rows, known),
        };
      })
    : [];
  const presentation: PubgComparisonPresentation = {
    ...base(input),
    type: 'pubg_comparison',
    headline: 'PUBG 对比',
    summary: `${statusMessage(input.status ?? 'ok')}${statusMessage(input.status ?? 'ok') ? '\n' : ''}已保留两个区间的独立来源范围。`,
    rows: metricRows(data.rows, known),
    segments,
    evidenceRefs: input.evidenceRefs?.matchIds ?? [],
  };
  return assertValid(validatePubgComparisonPresentation(presentation, known));
}

export function buildPubgMatchDetailPresentation(
  input: PubgToolPresentationInput,
): PubgMatchDetailPresentation {
  const data = record(input.data);
  const match = record(data.match);
  const known = knownFor(input);
  const matchId = stringOrNull(match.matchId) ?? '未知对局';
  const players = Array.isArray(match.players)
    ? match.players.flatMap((item) => {
        const player = record(item);
        const label = text(player.displayName ?? player.playerName ?? player.accountId, '未知玩家');
        return [
          {
            label,
            values: values({
              kills: player.kills,
              assists: player.assists,
              damage: player.damage,
              dbnos: player.dbnos,
              rank: player.rank,
            }),
            evidenceRefs: evidenceFor(player, known),
          },
        ];
      })
    : [];
  const presentation: PubgMatchDetailPresentation = {
    ...base(input),
    type: 'pubg_match_detail',
    headline: `${text(match.mapName, '未知地图')} · ${matchId}`,
    matchId,
    startedAt: stringOrNull(match.createdAt ?? match.startedAt),
    mapName: text(match.mapName, '未知地图'),
    gameMode: text(match.gameMode, '未知模式'),
    duration: numberOrNull(match.duration),
    players,
    evidenceRefs: input.evidenceRefs?.matchIds ?? [],
  };
  return assertValid(validatePubgMatchDetailPresentation(presentation, known));
}

export function buildPubgMatchReviewPresentation(
  input: PubgToolPresentationInput,
): PubgMatchReviewPresentation {
  const data = record(input.data);
  const facts = record(data.facts);
  const match = record(facts.match);
  const squad = record(facts.squad);
  const analysis = record(data.derivedAnalysis);
  const evidence = Array.isArray(facts.evidence)
    ? facts.evidence.flatMap((item) => {
        const id = record(item).id;
        return typeof id === 'string' ? [id] : [];
      })
    : [];
  const known = new Set([
    ...(input.evidenceRefs?.matchIds ?? []),
    ...(input.evidenceRefs?.playerIds ?? []),
    ...evidence,
  ]);
  const keyMoments = textItems(analysis.turningPoints, evidence);
  const highlights = textItems(analysis.awards, evidence);
  const improvements = textItems(analysis.actionPlan ?? analysis.improvements);
  const summary =
    typeof analysis.summary === 'string' && analysis.summary.trim()
      ? analysis.summary
      : '本场复盘事实已生成。';
  const mapName = typeof match.mapName === 'string' ? match.mapName : '未知地图';
  const ordinal = numberOrNull(match.ordinal);
  const candidate: PubgMatchReviewPresentation = {
    ...base(input),
    type: 'pubg_match_review',
    headline: `${ordinal === null ? '' : `第${ordinal}局 · `}${mapName}`,
    overview: {
      placement: numberOrNull(squad.placement),
      kills: numberOrNull(squad.kills),
      assists: numberOrNull(squad.assists),
      damage: numberOrNull(squad.damage),
      dbnos: numberOrNull(squad.knocks),
      revives: numberOrNull(squad.revives),
    },
    keyMoments,
    highlights,
    improvements,
    analysis: summary,
    evidenceRefs: evidence,
  };
  return assertValid(validatePubgMatchReviewPresentation(candidate, known));
}

export function buildPubgPeriodReviewPresentation(
  input: PubgToolPresentationInput,
): PubgPeriodReviewPresentation {
  const data = record(input.data);
  const rawReviews = Array.isArray(data.reviews) ? data.reviews : [];
  const reviewEvidence = rawReviews.flatMap((item) => {
    const wrapper = record(item);
    const facts = record(record(wrapper.data ?? wrapper).facts);
    return Array.isArray(facts.evidence)
      ? facts.evidence.flatMap((evidence) => {
          const id = record(evidence).id;
          return typeof id === 'string' && id.trim() ? [id] : [];
        })
      : [];
  });
  const known = knownFor(input, reviewEvidence);
  const orderedMatches = rawReviews.flatMap((item, index) => {
    const wrapper = record(item);
    const reviewData = record(wrapper.data ?? wrapper);
    const facts = record(reviewData.facts);
    const match = record(facts.match ?? wrapper.match);
    const squad = record(facts.squad);
    const matchId = stringOrNull(wrapper.matchId ?? match.matchId);
    if (!matchId) return [];
    return [
      {
        matchId,
        label: `${index + 1}. ${text(match.mapName, '未知地图')}`,
        startedAt: stringOrNull(match.createdAt ?? match.startedAt),
        placement: numberOrNull(squad.placement ?? match.placement),
      },
    ];
  });
  const matches = orderedMatches.length
    ? orderedMatches
    : Array.isArray(data.matches)
      ? data.matches.flatMap((item, index) => {
          const match = record(item);
          const matchId = stringOrNull(match.matchId);
          return matchId
            ? [
                {
                  matchId,
                  label: `${index + 1}. ${text(match.mapName, '未知地图')}`,
                  startedAt: stringOrNull(match.startedAt),
                  placement: numberOrNull(match.placement),
                },
              ]
            : [];
        })
      : [];
  const reviewItems = rawReviews.flatMap((item) => {
    const wrapper = record(item);
    return textItems(record(record(wrapper.data ?? wrapper).derivedAnalysis).awards, [...known]);
  });
  const summaryValue = data.summary;
  const summary =
    typeof summaryValue === 'string' && summaryValue.trim()
      ? summaryValue
      : `${matches.length} 场对局${input.status === 'partial' ? '，部分 Telemetry 暂不可用' : ''}。`;
  const period = record(data.period);
  const label = text(period.label ?? queryLabel(input, 'PUBG 周期复盘'), 'PUBG 周期复盘');
  const candidate: PubgPeriodReviewPresentation = {
    ...base(input),
    type: 'pubg_period_review',
    period: {
      label,
      ...(stringOrNull(period.displayDate)
        ? { displayDate: stringOrNull(period.displayDate)! }
        : {}),
    },
    summary,
    orderedMatches: matches,
    highlights: textItems(data.highlights, [...known, ...(input.evidenceRefs?.matchIds ?? [])])
      .concat(reviewItems)
      .slice(0, 12),
    patterns: textItems(data.patterns, [...known]).slice(0, 12),
    analysis: text(
      data.analysis,
      input.status === 'partial'
        ? '周期结果存在覆盖缺口，未知事实未被补成确定值。'
        : '周期复盘事实已按 Domain 返回顺序整理。',
    ),
    evidenceRefs: input.evidenceRefs?.matchIds ?? [],
  };
  return assertValid(validatePubgPeriodReviewPresentation(candidate, known));
}

function playerName(value: unknown): string {
  const row = record(value);
  return text(row.name ?? row.displayName ?? row.playerId, '未知玩家');
}

const VEHICLE_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/PonyCoupe/u, '小轿车'],
  [/Dacia|Sedan/u, '轿车'],
  [/Blanc/u, 'Blanc 跑车'],
  [/Mirado/u, 'Mirado 跑车'],
  [/PickupTruck/u, '皮卡'],
  [/Uaz/iu, '吉普'],
  [/Motorbike|Dirtbike|Scooter/u, '摩托'],
  [/Buggy/u, '蹦蹦车'],
  [/Rony/u, '小巴'],
  [/Boat|AquaRail/u, '船'],
  [/Bus|Van/u, '巴士'],
];

/** 飞踢 / 重拳 / 皮卡撞击 / Beryl M762 走火: what one team-damage event was, in the squad's words. */
function teamHitKind(event: Record<string, unknown>): string {
  const source = text(event.source, '');
  const weapon = text(event.weapon, '');
  if (source === 'MELEE')
    return event.meleeKind === 'KICK' ? '飞踢' : event.meleeKind === 'PUNCH' ? '重拳' : '近战';
  if (source === 'VEHICLE')
    return `${VEHICLE_NAMES.find(([pattern]) => pattern.test(weapon))?.[1] ?? '载具'}撞击`;
  if (source === 'GUN')
    return `${
      weapon
        .replace(/^Weap/u, '')
        .replace(/_C$/u, '')
        .replace(/([a-z])([A-Z0-9])/gu, '$1 $2') || '枪械'
    } 走火`;
  if (source === 'EXPLOSIVE') return '爆炸物';
  return '其他伤害';
}

function addSlice(
  slices: Map<string, PubgTeamDamageSlice>,
  label: string,
  hitCount: number,
  damage: number,
): void {
  const slice = slices.get(label) ?? { label, hitCount: 0, damage: 0 };
  slice.hitCount += hitCount;
  slice.damage += damage;
  slices.set(label, slice);
}

function sortedSlices(slices: Map<string, PubgTeamDamageSlice>): PubgTeamDamageSlice[] {
  return [...slices.values()]
    .map((slice) => ({ ...slice, damage: Math.round(slice.damage * 100) / 100 }))
    .sort((a, b) => b.hitCount - a.hitCount || b.damage - a.damage);
}

/** Reads the per-match events behind the direction totals; undefined when the result carried none. */
function teamDamageLedger(
  data: Record<string, unknown>,
  directions: Array<{
    actor: string;
    victim: string;
    actorId: string | null;
    victimId: string | null;
  }>,
): PubgTeamDamageLedger | undefined {
  const matches = Array.isArray(data.matches) ? data.matches.map(record) : [];
  const directionIndex = new Map(
    directions.map((direction, index) => [`${direction.actorId}:${direction.victimId}`, index]),
  );
  const names = new Map<string, string>();
  for (const direction of directions) {
    if (direction.actorId) names.set(direction.actorId, direction.actor);
    if (direction.victimId) names.set(direction.victimId, direction.victim);
  }
  const sources = new Map<string, PubgTeamDamageSlice>();
  const perDirection = directions.map(() => new Map<string, PubgTeamDamageSlice>());
  const perMatch: PubgTeamDamageLedger['highlights'] = [];
  let events = 0;
  matches.forEach((match, ordinal) => {
    const pairs = new Map<
      string,
      { actor: string; victim: string; hitCount: number; damage: number }
    >();
    for (const raw of Array.isArray(match.teamDamage) ? match.teamDamage : []) {
      const event = record(raw);
      const index = directionIndex.get(
        `${stringOrNull(event.actorPlayerId)}:${stringOrNull(event.victimPlayerId)}`,
      );
      if (index === undefined) continue; // a direction the query filtered out
      const hitCount = numberOrNull(event.hitCount) ?? 0;
      const damage = numberOrNull(event.damage) ?? 0;
      const kind = teamHitKind(event);
      events += 1;
      addSlice(sources, kind, hitCount, damage);
      addSlice(perDirection[index]!, kind, hitCount, damage);
      const direction = directions[index]!;
      const pair = pairs.get(`${index}`) ?? {
        actor: direction.actor,
        victim: direction.victim,
        hitCount: 0,
        damage: 0,
      };
      pair.hitCount += hitCount;
      pair.damage += damage;
      pairs.set(`${index}`, pair);
    }
    if (!pairs.size) return;
    const list = [...pairs.values()]
      .map((pair) => ({ ...pair, damage: Math.round(pair.damage * 100) / 100 }))
      .sort((a, b) => b.damage - a.damage);
    const placement = numberOrNull(match.placement);
    const map = sessionMapName(text(match.mapName, ''));
    const at = stringOrNull(match.startedAtLocal);
    perMatch.push({
      label: `第 ${ordinal + 1} 局（${map}${placement === null ? '' : ` #${placement}`}${at ? `，${at}` : ''}）`,
      hitCount: list.reduce((total, pair) => total + pair.hitCount, 0),
      damage: Math.round(list.reduce((total, pair) => total + pair.damage, 0) * 100) / 100,
      pairs: list,
    });
  });
  if (!events) return undefined;
  const actors = new Set(directions.map((direction) => direction.actor));
  return {
    sources: sortedSlices(sources),
    directionSources: perDirection.map(sortedSlices),
    highlights: perMatch.sort((a, b) => b.damage - a.damage).slice(0, 2),
    quiet: [...new Set(directions.map((direction) => direction.victim))].filter(
      (victim) => !actors.has(victim),
    ),
  };
}

export function buildPubgTeamDamagePresentation(
  input: PubgToolPresentationInput,
): PubgTeamDamagePresentation {
  const data = record(input.data);
  const known = knownFor(input);
  const rawDirections = Array.isArray(data.directions)
    ? data.directions.flatMap((item) => {
        const row = record(item);
        const actorId = stringOrNull(record(row.actor).playerId);
        const victimId = stringOrNull(record(row.victim).playerId);
        if (input.teamDamage?.actorPlayerId && actorId !== input.teamDamage.actorPlayerId)
          return [];
        if (input.teamDamage?.victimPlayerId && victimId !== input.teamDamage.victimPlayerId)
          return [];
        const actor = playerName(row.actor);
        const victim = playerName(row.victim);
        return [
          {
            actor,
            victim,
            actorId,
            victimId,
            hitCount: numberOrNull(row.hitCount),
            damage: numberOrNull(row.damage),
            knownHitCount: numberOrNull(row.knownHitCount) ?? numberOrNull(row.hitCount) ?? 0,
            knownDamage: numberOrNull(row.knownDamage) ?? numberOrNull(row.damage) ?? 0,
            complete: row.complete === true,
            evidenceRefs: evidenceFor(row, known),
          },
        ];
      })
    : [];
  const completeCoverage = input.coverage?.complete ?? data.complete === true;
  let actorTotals: PubgTeamDamagePresentation['actorTotals'];
  let rankingBasis: PubgTeamDamagePresentation['rankingBasis'];
  if (input.teamDamage?.aggregateByActor) {
    const totals = [
      ...rawDirections
        .reduce((aggregates, row) => {
          const key = row.actorId ?? row.actor;
          const total = aggregates.get(key) ?? {
            actor: row.actor,
            damage: 0,
            hitCount: 0,
            knownDamage: 0,
            knownHitCount: 0,
            complete: completeCoverage,
            evidenceRefs: new Set<string>(),
          };
          total.knownDamage += row.knownDamage;
          total.knownHitCount += row.knownHitCount;
          if (row.damage === null || row.hitCount === null || !row.complete) total.complete = false;
          else {
            total.damage += row.damage;
            total.hitCount += row.hitCount;
          }
          for (const ref of row.evidenceRefs) total.evidenceRefs.add(ref);
          aggregates.set(key, total);
          return aggregates;
        }, new Map<string, { actor: string; damage: number; hitCount: number; knownDamage: number; knownHitCount: number; complete: boolean; evidenceRefs: Set<string> }>())
        .values(),
    ].map((total) => ({
      ...total,
      damage: completeCoverage && total.complete ? total.damage : null,
      hitCount: completeCoverage && total.complete ? total.hitCount : null,
      complete: completeCoverage && total.complete,
      evidenceRefs: [...total.evidenceRefs],
    }));
    const rankByCompleteDamage = completeCoverage && totals.every((total) => total.complete);
    rankingBasis = rankByCompleteDamage ? 'damage' : 'knownDamage';
    totals.sort(
      (left, right) =>
        (rankByCompleteDamage ? (right.damage ?? 0) : right.knownDamage) -
          (rankByCompleteDamage ? (left.damage ?? 0) : left.knownDamage) ||
        left.actor.localeCompare(right.actor),
    );
    actorTotals = totals.map((total, index) => ({ ...total, position: index + 1 }));
  }
  const ledger = teamDamageLedger(data, rawDirections);
  const directions = rawDirections.map(
    ({ actorId: _actorId, victimId: _victimId, knownDamage, knownHitCount, ...direction }) => ({
      ...direction,
      ...(input.presentationStyle === 'public_agent' ? { knownDamage, knownHitCount } : {}),
    }),
  );
  const source = stringOrNull(data.source);
  const meleeKind = stringOrNull(data.meleeKind);
  const direction = text(
    data.direction,
    directions.length
      ? directions.map((item) => `${item.actor} → ${item.victim}`).join('、')
      : 'all directions',
  );
  const publicDamageAction =
    meleeKind === 'KICK'
      ? '队友踢击'
      : meleeKind === 'PUNCH'
        ? '队友拳击'
        : meleeKind === 'OTHER'
          ? '队友近战'
          : '队友伤害';
  const publicHeadline = `${publicPeriodLabel(input, '')}${publicDamageAction}`;
  const totalHitCount = numberOrNull(data.totalHitCount);
  const totalDamage = numberOrNull(data.totalDamage);
  const summary =
    input.status === 'partial' || !completeCoverage
      ? input.presentationStyle === 'public_agent' && !directions.length
        ? '队友伤害资料不可用或覆盖不完整，不能据此认定为 0。'
        : '部分 Telemetry 暂不可用，未知数量没有被当作 0。'
      : actorTotals
        ? `队友伤害按已覆盖资料汇总，共 ${actorTotals.length} 名有记录队员。`
        : directions.length
          ? `共 ${directions.length} 个方向。`
          : statusMessage(input.status ?? 'ok') || '未发现队友动作。';
  const candidate: PubgTeamDamagePresentation = {
    ...base(input),
    type: 'pubg_team_damage',
    headline: input.presentationStyle === 'public_agent' ? publicHeadline : 'PUBG 队友动作/误伤',
    direction,
    source,
    meleeKind,
    totalHitCount,
    totalDamage,
    directions,
    ...(ledger ? { ledger } : {}),
    ...(actorTotals ? { actorTotals, ...(rankingBasis ? { rankingBasis } : {}) } : {}),
    summary,
    evidenceRefs: input.evidenceRefs?.matchIds ?? [],
  };
  return assertValid(validatePubgTeamDamagePresentation(candidate, known));
}

/** Build one validated presentation for any registered native PUBG tool. */
export function buildPubgPresentation(input: PubgToolPresentationInput): PubgPresentation {
  switch (input.toolName) {
    case 'pubg_query_stats':
      return buildPubgStatsPresentation(input);
    case 'pubg_search_matches':
      return buildPubgMatchListPresentation(input);
    case 'pubg_compare_stats':
      return buildPubgComparisonPresentation(input);
    case 'pubg_get_match':
      return buildPubgMatchDetailPresentation(input);
    case 'pubg_get_review_facts':
      if (input.status === 'error' || input.status === 'no_matches')
        return buildPubgStatusPresentation(input);
      return buildPubgMatchReviewPresentation(input);
    case 'pubg_get_period_review':
      if (input.status === 'error') return buildPubgStatusPresentation(input);
      return buildPubgPeriodReviewPresentation(input);
    case 'pubg_query_team_damage':
      return buildPubgTeamDamagePresentation(input);
    case 'pubg_resolve_players':
    case 'pubg_prefetch_telemetry':
    case 'pubg_telemetry_sync_report':
    default:
      return buildPubgStatusPresentation(input);
  }
}
