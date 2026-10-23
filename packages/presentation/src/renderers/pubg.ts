import type {
  PubgComparisonPresentation,
  PubgMatchDetailPresentation,
  PubgMatchListPresentation,
  PubgMatchReviewPresentation,
  PubgMetricRow,
  PubgPeriodReviewPresentation,
  PubgPresentationBase,
  PubgSourceRange,
  PubgStatsPresentation,
  PubgStatusPresentation,
  PubgTeamDamagePresentation,
  PubgTeamDamageSlice,
} from '../contracts/pubg.js';
import { formatDisplayRange, formatDisplayTime } from '../time/format.js';
import { sessionMapName } from './session-review.js';
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

export interface PubgRenderOptions {
  timezone?: string;
  now?: Date | string;
  includeCoverage?: boolean;
  localizedMetrics?: boolean;
  /** Chat-reply style (implies localized): **bold** names, titles and totals, and no filler metrics. */
  chatEmphasis?: boolean;
}

function timeOptions(options: PubgRenderOptions, extra: { forceDate?: boolean } = {}) {
  return {
    ...extra,
    ...(options.timezone ? { timezone: options.timezone } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
}

function userText(value: string): string {
  return value
    .replace(/Asia\/Shanghai/gu, '北京时间')
    .replace(/UTC\+?08(?::00)?/gu, '北京时间')
    .replace(/自然日|业务日/gu, '日期');
}

function value(value: string | number | null): string {
  return value === null ? '未知' : userText(String(value));
}

function statusLine(status: PubgPresentationBase['status']): string | null {
  if (status === 'partial') return '结果不完整：缺失事实保持为未知。';
  if (status === 'no_matches') return '没有找到符合条件的比赛。';
  if (status === 'error') return '当前数据源无法完成这次查询，没有使用旧聊天数据代替。';
  return null;
}

function sourceRangeLines(
  range: PubgSourceRange | undefined,
  options: PubgRenderOptions,
): string[] {
  if (!range) return [];
  const segments = range.segments ?? [];
  if (segments.length > 1) {
    return [
      '数据范围：',
      ...segments.map(
        (segment) =>
          `- ${userText(segment.label)}：${formatDisplayRange(segment.from, segment.to, timeOptions(options))}`,
      ),
    ];
  }
  return [`数据范围：${formatDisplayRange(range.from, range.to, timeOptions(options))}`];
}

function footer(presentation: PubgPresentationBase, options: PubgRenderOptions): string[] {
  const updated = formatDisplayTime(presentation.dataUpdatedAt, timeOptions(options)) ?? '未知';
  const coverage =
    options.includeCoverage && presentation.coverage
      ? [
          `数据覆盖：${presentation.coverage.complete ? '完整' : '不完整'}（${presentation.coverage.status}）`,
          `数据新鲜度：${presentation.coverage.freshness === 'fresh' ? '较新' : presentation.coverage.freshness === 'stale' ? '可能过期' : '未知'}`,
        ]
      : [];
  return [
    '',
    ...sourceRangeLines(presentation.sourceRange, options),
    ...coverage,
    `数据更新时间：${updated}`,
  ];
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

/** Keys that are internal bookkeeping and should not appear in user-facing 战绩 lines. */
const HIDDEN_USER_METRICS = new Set(['denominatorZero', 'performance_score', 'chicken_index']);

/** Prefer this order when composing a localized player line. */
const RICH_METRIC_ORDER = [
  'matches',
  'kills',
  'assists',
  'damage',
  'dbnos',
  'revives',
  'headshot_kills',
  'top10',
  'wins',
  'kd',
  'avg_damage',
  'longest_kill',
  'deaths',
  'avg_kills',
  'avg_rank',
  'top10_rate',
  'rank',
  'survival_time',
] as const;

const TITLE_RULES: ReadonlyArray<{ key: string; title: string }> = [
  { key: 'assists', title: '全队助攻王' },
  { key: 'damage', title: '全队伤害第一' },
  { key: 'dbnos', title: '破点王' },
  { key: 'revives', title: '全队救援王' },
];

function numericMetric(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

/** Round floats for chat/share display; integers stay integers. */
export function formatMetricNumber(key: string, raw: string | number | null): string {
  if (raw === null) return '未知';
  if (typeof raw === 'string') return userText(raw);
  if (!Number.isFinite(raw)) return '未知';
  if (Number.isInteger(raw)) return String(raw);
  if (
    key === 'kd' ||
    key === 'avg_kills' ||
    key === 'top10_rate' ||
    key === 'avg_rank' ||
    key === 'rank'
  ) {
    return (Math.round(raw * 100) / 100).toFixed(2);
  }
  // damage / avg_damage / longest_kill → one decimal
  return (Math.round(raw * 10) / 10).toFixed(1);
}

function formatKd(raw: string | number | null): string {
  if (raw === null) return '未知';
  if (typeof raw === 'string') return userText(raw);
  if (!Number.isFinite(raw)) return '未知';
  return (Math.round(raw * 100) / 100).toFixed(2);
}

/** Deterministic honorary titles for clear team leaders (strict max, ties broken by row order). */
export function assignStatTitles(rows: readonly PubgMetricRow[]): Map<number, string[]> {
  const titles = new Map<number, string[]>();
  if (rows.length < 2) return titles;
  for (const rule of TITLE_RULES) {
    let bestIndex = -1;
    let bestValue = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const amount = numericMetric(rows[index]!.values[rule.key] ?? null);
      if (amount === null || amount <= 0) continue;
      if (bestIndex < 0 || amount > bestValue) {
        bestIndex = index;
        bestValue = amount;
      }
    }
    if (bestIndex < 0) continue;
    const list = titles.get(bestIndex) ?? [];
    list.push(rule.title);
    titles.set(bestIndex, list);
  }
  return titles;
}

function richMetricFragment(
  key: string,
  raw: string | number | null,
  title?: string,
): string | null {
  if (raw === null) return null;
  const titleSuffix = title ? `（${title}）` : '';
  switch (key) {
    case 'matches':
      return `${formatMetricNumber(key, raw)} 场`;
    case 'kills':
      return `${formatMetricNumber(key, raw)} 杀`;
    case 'assists':
      return `${formatMetricNumber(key, raw)} 助攻${titleSuffix}`;
    case 'damage':
      return `${formatMetricNumber(key, raw)} 伤害${titleSuffix}`;
    case 'dbnos':
      return `${formatMetricNumber(key, raw)} 击倒${titleSuffix}`;
    case 'revives':
      return `${formatMetricNumber(key, raw)} 救援${titleSuffix}`;
    case 'headshot_kills':
      return `${formatMetricNumber(key, raw)} 爆头`;
    case 'top10':
      return `${formatMetricNumber(key, raw)} 次前十`;
    case 'wins':
      return Number(raw) > 0 ? `${formatMetricNumber(key, raw)} 吃鸡` : null;
    case 'kd':
      return `KD ${formatKd(raw)}`;
    case 'avg_damage':
      return `场均伤害 ${formatMetricNumber(key, raw)}`;
    case 'longest_kill':
      return `最远击杀 ${formatMetricNumber(key, raw)}m`;
    case 'deaths':
      return `${formatMetricNumber(key, raw)} 死`;
    case 'avg_kills':
      return `场均击杀 ${formatMetricNumber(key, raw)}`;
    case 'avg_rank':
      return `场均排名 ${formatMetricNumber(key, raw)}`;
    case 'top10_rate':
      return `前十率 ${formatMetricNumber(key, raw)}`;
    case 'rank':
      return `排名 ${formatMetricNumber(key, raw)}`;
    case 'survival_time':
      return `生存 ${formatMetricNumber(key, raw)}s`;
    default: {
      if (HIDDEN_USER_METRICS.has(key)) return null;
      return `${METRIC_LABELS[key] ?? userText(key)} ${formatMetricNumber(key, raw)}`;
    }
  }
}

const CHAT_FILLER_METRICS = new Set([
  'avg_kills',
  'avg_rank',
  'top10_rate',
  'rank',
  'survival_time',
]);

function metricRow(
  row: PubgMetricRow,
  localizedMetrics: boolean,
  titles: string[] = [],
  emphasis = false,
): string {
  if (!localizedMetrics) {
    const entries = Object.entries(row.values)
      .filter(([key]) => !HIDDEN_USER_METRICS.has(key))
      .map(
        ([key, item]) =>
          `${userText(key)}=${typeof item === 'number' ? formatMetricNumber(key, item) : value(item)}`,
      );
    const rank = row.position === undefined ? '' : `（序号：${value(row.position)}）`;
    return `- ${userText(row.label)}${rank}${entries.length ? `：${entries.join('，')}` : ''}`;
  }
  const titleByKey = new Map<string, string>();
  for (const title of titles) {
    const rule = TITLE_RULES.find((item) => item.title === title);
    if (rule) titleByKey.set(rule.key, title);
  }
  const seen = new Set<string>();
  const fragments: string[] = [];
  for (const key of RICH_METRIC_ORDER) {
    if (!(key in row.values) || HIDDEN_USER_METRICS.has(key)) continue;
    seen.add(key);
    if (emphasis && CHAT_FILLER_METRICS.has(key)) continue;
    const fragment = richMetricFragment(key, row.values[key] ?? null, titleByKey.get(key));
    if (fragment)
      fragments.push(
        emphasis && (titleByKey.has(key) || key === 'wins' || key === 'kills' || key === 'kd')
          ? `**${fragment}**`
          : fragment,
      );
  }
  for (const [key, item] of Object.entries(row.values)) {
    if (seen.has(key) || HIDDEN_USER_METRICS.has(key) || (emphasis && CHAT_FILLER_METRICS.has(key)))
      continue;
    const fragment = richMetricFragment(key, item, titleByKey.get(key));
    if (fragment) fragments.push(fragment);
  }
  // Leftover titles (should not happen) still get shown after the name.
  const orphanTitles = titles.filter(
    (title) =>
      !TITLE_RULES.some((rule) => rule.title === title && titleByKey.get(rule.key) === title),
  );
  const titlePrefix = orphanTitles.length
    ? orphanTitles.map((title) => `（${title}）`).join('')
    : '';
  const name = emphasis ? `**${userText(row.label)}**` : userText(row.label);
  return `- ${name}${titlePrefix}${fragments.length ? `：${fragments.join('，')}` : ''}`;
}

/** "10月19日星期一" for a range covering one business day; null for anything else. */
function dayLabel(range: PubgSourceRange | undefined, options: PubgRenderOptions): string | null {
  if (!range?.from || !range.to) return null;
  const from = new Date(range.from);
  const hours = (new Date(range.to).getTime() - from.getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 23 || hours > 25) return null;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: options.timezone ?? 'Asia/Shanghai',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    }).format(from);
  } catch {
    return null;
  }
}

/** A model-built time_range arrives labelled 指定时间; a one-business-day range reads better as its date. */
function chatHeadline(
  headline: string,
  range: PubgSourceRange | undefined,
  options: PubgRenderOptions,
): string {
  const text = userText(headline);
  const day = text === '指定时间' ? dayLabel(range, options) : null;
  return day ? `${day} 全天战报` : text;
}

function slicesText(slices: readonly PubgTeamDamageSlice[]): string {
  return slices.map((slice) => `${slice.label} ${slice.hitCount} 次`).join('、');
}

/** The 队内误伤账本 a chat reply retells: totals by kind, every direction, the worst matches, and who stayed clean. */
function renderTeamDamageLedger(
  presentation: PubgTeamDamagePresentation,
  options: PubgRenderOptions,
): string {
  const day = dayLabel(presentation.sourceRange, options);
  const ledger = presentation.ledger;
  const lines = [`🥊 ${day ? `${day} ` : ''}队内误伤账本`, ''];
  const status = statusLine(presentation.status);
  if (status) lines.push(status, '');
  if (!presentation.directions.length) {
    lines.push(userText(presentation.summary));
    return lines.concat(footer(presentation, options)).join('\n');
  }
  const total =
    presentation.totalDamage === null
      ? '未知'
      : formatMetricNumber('damage', presentation.totalDamage);
  lines.push(`• 总误伤：**${total} 点**`);
  lines.push(
    `• 总命中：**${value(presentation.totalHitCount)} 次**${ledger?.sources.length ? `（${slicesText(ledger.sources)}）` : ''}`,
  );
  if (presentation.actorTotals?.length) {
    const basis = presentation.rankingBasis === 'knownDamage' ? '（按已知伤害下限排序）' : '';
    lines.push(
      '',
      `**队员误伤输出排名${basis}：**`,
      ...presentation.actorTotals.map((total) => {
        const damage = total.complete ? total.damage : total.knownDamage;
        const hits = total.complete ? total.hitCount : total.knownHitCount;
        return `${total.position}. ${userText(total.actor)}：${total.complete ? '' : '已知至少 '}${damage === null ? '未知' : formatMetricNumber('damage', damage)} 伤害 / ${value(hits)} 次`;
      }),
    );
  }
  lines.push('', '───', '', `**互相伤害明细（共 ${presentation.directions.length} 个方向）：**`);
  presentation.directions.forEach((direction, index) => {
    const damage =
      direction.damage === null ? '未知' : formatMetricNumber('damage', direction.damage);
    const kinds = ledger?.directionSources[index] ?? [];
    lines.push(
      `${index + 1}. **${userText(direction.actor)} ➡️ ${userText(direction.victim)}**`,
      `  • 总输出：**${value(direction.hitCount)} 次命中，造成 ${damage} 伤害**${kinds.length ? `（${slicesText(kinds)}）` : ''}${direction.complete ? '' : '（不完整）'}`,
    );
  });
  if (ledger?.highlights.length) {
    lines.push('', '───', '', '**名场面：**');
    for (const highlight of ledger.highlights) {
      const pairs = highlight.pairs
        .map(
          (pair) =>
            `${userText(pair.actor)} ➡️ ${userText(pair.victim)} ${pair.hitCount} 次 ${formatMetricNumber('damage', pair.damage)} 点`,
        )
        .join('；');
      lines.push(
        `• ${highlight.label}：单局 **${formatMetricNumber('damage', highlight.damage)} 点（${highlight.hitCount} 次命中）**：${pairs}`,
      );
    }
  }
  if (ledger?.quiet.length)
    lines.push('', `清白名单：${ledger.quiet.map(userText).join('、')}（0 次主动队内输出）`);
  return lines.concat(footer(presentation, options)).join('\n');
}

const CHAT_MEDALS = ['🥇', '🥈', '🥉'] as const;
const CHAT_VOLUME_KEYS = [
  'kills',
  'assists',
  'damage',
  'dbnos',
  'revives',
  'headshot_kills',
  'top10',
  'wins',
] as const;
const CHAT_PERSONAL_KEYS = ['kd', 'avg_damage', 'longest_kill', 'deaths'] as const;

/** Chat card: medal + bold name, then a 出战 line (volume) and a 个人数据 line (rates), like the squad's 战报. */
function chatPlayerBlock(row: PubgMetricRow, index: number, titles: string[]): string[] {
  const titleByKey = new Map<string, string>();
  for (const title of titles) {
    const rule = TITLE_RULES.find((item) => item.title === title);
    if (rule) titleByKey.set(rule.key, title);
  }
  const emphasize = (key: string) =>
    titleByKey.has(key) || key === 'wins' || key === 'kills' || key === 'kd';
  const fragments = (keys: readonly string[]) =>
    keys.flatMap((key) => {
      if (!(key in row.values)) return [];
      const fragment = richMetricFragment(key, row.values[key] ?? null, titleByKey.get(key));
      return fragment ? [emphasize(key) ? `**${fragment}**` : fragment] : [];
    });
  const matches =
    row.values.matches === undefined
      ? null
      : richMetricFragment('matches', row.values.matches ?? null);
  const volume = fragments(CHAT_VOLUME_KEYS);
  const personal = fragments(CHAT_PERSONAL_KEYS);
  const lines = [`${CHAT_MEDALS[index] ?? '🎖️'} **${userText(row.label)}**`];
  if (matches || volume.length)
    lines.push(
      `• **${matches ? `出战 ${matches.replace(/ 场$/u, '')} 局` : '数据'}**${volume.length ? `：${volume.join('，')}` : ''}`,
    );
  if (personal.length) lines.push(`• 个人数据：${personal.join('，')}`);
  return lines;
}

function teamTotalsLine(rows: readonly PubgMetricRow[], emphasis = false): string | null {
  if (rows.length < 2) return null;
  const sum = (key: string) =>
    rows.reduce((total, row) => total + (numericMetric(row.values[key] ?? null) ?? 0), 0);
  const max = (key: string) =>
    rows.reduce((best, row) => {
      const amount = numericMetric(row.values[key] ?? null);
      return amount === null ? best : Math.max(best, amount);
    }, 0);
  const kills = sum('kills');
  const damage = sum('damage');
  const dbnos = sum('dbnos');
  const assists = sum('assists');
  const revives = sum('revives');
  // Squad chicken dinners are credited to every member of the winning match; max avoids double-counting.
  const wins = max('wins');
  const deaths = sum('deaths');
  const kdPart = deaths > 0 ? `，团队 KD ${formatKd(kills / deaths)}` : '';
  const line = `团队合计：${kills} 杀，${formatMetricNumber('damage', damage)} 伤害，${dbnos} 击倒，${assists} 助攻，${revives} 救援${kdPart}${wins > 0 ? `，吃鸡 ${wins}` : ''}`;
  return emphasis ? `**${line}**` : line;
}

export function renderPubgStatus(
  presentation: PubgStatusPresentation,
  options: PubgRenderOptions = {},
): string {
  const validated = assertValid(validatePubgStatusPresentation(presentation));
  const lines = [userText(validated.headline), ''];
  const status = statusLine(validated.status);
  if (status) lines.push(status, '');
  lines.push(userText(validated.message));
  return lines.concat(footer(validated, options)).join('\n');
}

export function renderPubgStats(
  presentation: PubgStatsPresentation,
  options: PubgRenderOptions = {},
): string {
  const validated = assertValid(validatePubgStatsPresentation(presentation));
  const emphasis = options.chatEmphasis === true;
  const localized = options.localizedMetrics === true || emphasis;
  const titles = localized ? assignStatTitles(validated.rows) : new Map<number, string[]>();
  const lines = [
    emphasis
      ? `🏆 ${chatHeadline(validated.headline, validated.sourceRange, options)}`
      : userText(validated.headline),
    '',
    userText(validated.summary),
  ];
  if (validated.rows.length) {
    if (emphasis) {
      // Medals rank by K/D (ties: kills, then damage), whatever order the query asked for.
      const metric = (row: PubgMetricRow, key: string) =>
        numericMetric(row.values[key] ?? null) ?? -1;
      const ranked = validated.rows
        .map((row, index) => ({
          row,
          titles: titles.get(index) ?? [],
          kd: metric(row, 'kd'),
          kills: metric(row, 'kills'),
          damage: metric(row, 'damage'),
        }))
        .sort((a, b) => b.kd - a.kd || b.kills - a.kills || b.damage - a.damage);
      ranked.forEach((entry, place) =>
        lines.push('', ...chatPlayerBlock(entry.row, place, entry.titles)),
      );
    } else {
      lines.push(
        '',
        ...validated.rows.map((row, index) =>
          metricRow(row, localized, titles.get(index) ?? [], false),
        ),
      );
    }
    if (localized) {
      const totals = teamTotalsLine(validated.rows, emphasis);
      if (totals) lines.push('', totals);
    }
  }
  return lines.concat(footer(validated, options)).join('\n');
}

const MODE_NAMES: Readonly<Record<string, string>> = {
  squad: '四排',
  'squad-fpp': '四排第一人称',
  duo: '双排',
  'duo-fpp': '双排第一人称',
  solo: '单排',
  'solo-fpp': '单排第一人称',
};

/** "SG_LabmemNo004 击杀0 伤害27.903175" → "SG_LabmemNo004 0 杀 27.9 伤害". */
function chatMatchSummary(summary: string): string {
  return userText(summary).replace(
    /击杀(\d+)\s*伤害(\d+(?:\.\d+)?)/gu,
    (_all, kills: string, damage: string) =>
      `${kills} 杀 ${formatMetricNumber('damage', Number(damage))} 伤害`,
  );
}

function renderChatMatchList(
  presentation: PubgMatchListPresentation,
  options: PubgRenderOptions,
): string {
  const day = dayLabel(presentation.sourceRange, options);
  const modes = new Set(
    presentation.matches.map((match) => MODE_NAMES[match.gameMode] ?? match.gameMode),
  );
  const mode = modes.size === 1 ? [...modes][0]! : '';
  const lines = [`🗂️ ${day ? `${day} ` : ''}${mode ? `${mode}` : ''}对局列表`, ''];
  const status = statusLine(presentation.status);
  if (status) lines.push(status, '');
  lines.push(userText(presentation.summary));
  presentation.matches.forEach((match, index) => {
    const at = match.startedAt
      ? formatDisplayTime(match.startedAt, timeOptions(options))
      : '时间未知';
    const placement =
      match.placement === null
        ? '名次未知'
        : match.placement === 1
          ? '**🏆 吃鸡**'
          : `**#${match.placement}**`;
    lines.push(
      '',
      `${index + 1}. ${at}｜${sessionMapName(match.mapName)}${mode ? '' : `｜${MODE_NAMES[match.gameMode] ?? userText(match.gameMode)}`}｜${placement}`,
      `  • ${chatMatchSummary(match.summary)}`,
    );
  });
  return lines.concat(footer(presentation, options)).join('\n');
}

export function renderPubgMatchList(
  presentation: PubgMatchListPresentation,
  options: PubgRenderOptions = {},
): string {
  const validated = assertValid(validatePubgMatchListPresentation(presentation));
  if (options.chatEmphasis) return renderChatMatchList(validated, options);
  const lines = [userText(validated.headline), '', userText(validated.summary)];
  if (validated.matches.length) {
    lines.push(
      '',
      '对局列表：',
      ...validated.matches.map((match) => {
        const startedAt = match.startedAt
          ? formatDisplayTime(match.startedAt, timeOptions(options, { forceDate: true }))
          : '未知';
        return `- ${startedAt}｜${userText(match.mapName)}｜${userText(match.gameMode)}｜第${value(match.placement)}名｜${userText(match.summary)}`;
      }),
    );
  }
  return lines.concat(footer(validated, options)).join('\n');
}

export function renderPubgComparison(
  presentation: PubgComparisonPresentation,
  options: PubgRenderOptions = {},
): string {
  const validated = assertValid(validatePubgComparisonPresentation(presentation));
  const lines = [userText(validated.headline), '', userText(validated.summary)];
  if (validated.rows.length)
    lines.push(
      '',
      '差值（前段 - 后段）：',
      ...validated.rows.map((row) => metricRow(row, options.localizedMetrics === true)),
    );
  for (const segment of validated.segments) {
    lines.push('', `区间：${userText(segment.label)}`);
    if (segment.sourceRange) lines.push(...sourceRangeLines(segment.sourceRange, options));
    if (segment.rows.length)
      lines.push(...segment.rows.map((row) => metricRow(row, options.localizedMetrics === true)));
  }
  return lines.concat(footer(validated, options)).join('\n');
}

export function renderPubgMatchDetail(
  presentation: PubgMatchDetailPresentation,
  options: PubgRenderOptions = {},
): string {
  const validated = assertValid(validatePubgMatchDetailPresentation(presentation));
  const startedAt = validated.startedAt
    ? formatDisplayTime(validated.startedAt, timeOptions(options, { forceDate: true }))
    : '未知';
  const lines = [
    userText(validated.headline),
    '',
    `对局：${userText(validated.matchId)}`,
    `开始：${startedAt}`,
    `地图：${userText(validated.mapName)}｜模式：${userText(validated.gameMode)}`,
    `时长：${value(validated.duration)}`,
  ];
  if (validated.players.length)
    lines.push(
      '',
      '玩家：',
      ...validated.players.map((player) => {
        const entries = Object.entries(player.values).map(
          ([key, item]) => `${userText(key)}=${value(item)}`,
        );
        return `- ${userText(player.label)}${entries.length ? `：${entries.join('，')}` : ''}`;
      }),
    );
  return lines.concat(footer(validated, options)).join('\n');
}

export function renderPubgMatchReview(
  presentation: PubgMatchReviewPresentation,
  options: PubgRenderOptions = {},
): string {
  const validated = assertValid(validatePubgMatchReviewPresentation(presentation));
  const lines = [userText(validated.headline), ''];
  const status = statusLine(validated.status);
  if (status) lines.push(status, '');
  lines.push(
    `排名：${value(validated.overview.placement)}｜击杀：${value(validated.overview.kills)}｜助攻：${value(validated.overview.assists)}`,
    `伤害：${value(validated.overview.damage)}｜倒地：${value(validated.overview.dbnos)}｜救援：${value(validated.overview.revives)}`,
  );
  if (validated.keyMoments.length)
    lines.push('', '关键时刻：', ...validated.keyMoments.map((item) => `- ${userText(item.text)}`));
  if (validated.highlights.length)
    lines.push('', '亮点：', ...validated.highlights.map((item) => `- ${userText(item.text)}`));
  if (validated.improvements.length)
    lines.push('', '改进：', ...validated.improvements.map((item) => `- ${userText(item.text)}`));
  lines.push('', userText(validated.analysis));
  return lines.concat(footer(validated, options)).join('\n');
}

export function renderPubgPeriodReview(
  presentation: PubgPeriodReviewPresentation,
  options: PubgRenderOptions = {},
): string {
  const validated = assertValid(validatePubgPeriodReviewPresentation(presentation));
  const lines = [
    validated.period.displayDate
      ? `${userText(validated.period.label)}（${userText(validated.period.displayDate)}）`
      : userText(validated.period.label),
    '',
  ];
  const status = statusLine(validated.status);
  if (status) lines.push(status, '');
  lines.push(userText(validated.summary));
  if (validated.orderedMatches.length) {
    lines.push(
      '',
      '对局顺序：',
      ...validated.orderedMatches.map(
        (match) =>
          `- ${userText(match.label)} ${match.startedAt ? `（${formatDisplayTime(match.startedAt, timeOptions(options, { forceDate: true }))}）` : ''}：第${value(match.placement)}名`,
      ),
    );
  }
  if (validated.highlights.length)
    lines.push('', '亮点：', ...validated.highlights.map((item) => `- ${userText(item.text)}`));
  if (validated.patterns.length)
    lines.push('', '模式：', ...validated.patterns.map((item) => `- ${userText(item.text)}`));
  lines.push('', userText(validated.analysis));
  return lines.concat(footer(validated, options)).join('\n');
}

export function renderPubgTeamDamage(
  presentation: PubgTeamDamagePresentation,
  options: PubgRenderOptions = {},
): string {
  const validated = assertValid(validatePubgTeamDamagePresentation(presentation));
  if (options.chatEmphasis) return renderTeamDamageLedger(validated, options);
  const lines = [userText(validated.headline), '', `方向：${userText(validated.direction)}`];
  const status = statusLine(validated.status);
  if (status) lines.push(status);
  if (validated.source || validated.meleeKind)
    lines.push(
      `筛选：${userText(validated.source ?? '全部')}${validated.meleeKind ? ` / ${userText(validated.meleeKind)}` : ''}`,
    );
  lines.push(
    `总次数：${value(validated.totalHitCount)}｜总伤害：${value(validated.totalDamage)}`,
    '',
    userText(validated.summary),
  );
  if (validated.actorTotals?.length) {
    const ranking = validated.rankingBasis === 'knownDamage' ? '已知伤害下限' : '完整伤害';
    lines.push(
      '',
      `队员汇总（按${ranking}排序）：`,
      ...validated.actorTotals.map((total) => {
        const damage = total.complete ? total.damage : total.knownDamage;
        const hitCount = total.complete ? total.hitCount : total.knownHitCount;
        return `- ${userText(total.actor)}：${total.complete ? '' : '已知至少 '}${value(damage)} 伤害 / ${value(hitCount)} 次`;
      }),
    );
  }
  if (validated.directions.length)
    lines.push(
      '',
      '方向明细：',
      ...validated.directions.map((direction) => {
        if (options.localizedMetrics) {
          const damage = direction.complete
            ? direction.damage
            : (direction.knownDamage ?? direction.damage);
          const hitCount = direction.complete
            ? direction.hitCount
            : (direction.knownHitCount ?? direction.hitCount);
          return `- ${userText(direction.actor)} → ${userText(direction.victim)}：${direction.complete ? '' : '已知至少 '}${value(damage)} 伤害 / ${value(hitCount)} 次${direction.complete ? '' : '（不完整）'}`;
        }
        return `- ${userText(direction.actor)} → ${userText(direction.victim)}：${value(direction.hitCount)} 次，${value(direction.damage)} 伤害${direction.complete ? '' : '（不完整）'}`;
      }),
    );
  return lines.concat(footer(validated, options)).join('\n');
}

export function formatPubgSourceRange(
  from: string | null,
  to: string | null,
  options: PubgRenderOptions = {},
): string {
  return `数据范围：${formatDisplayRange(from, to, timeOptions(options))}`;
}
