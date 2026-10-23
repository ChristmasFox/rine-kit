import type { PubgMetricRow, PubgStatsPresentation } from '../contracts/pubg.js';
import type { SessionReviewPresentation } from '../contracts/session-review.js';
import { assertValid } from '../validation/validate.js';
import { validateSessionReviewPresentation } from '../validation/session-review.js';
import { renderPubgStats, type PubgRenderOptions } from './pubg.js';
import { sessionMapName, sessionPlacement, sessionPlacementStrip } from './session-review.js';

/**
 * The once-a-day group message for one business day (06:00 to 06:00): the same rich 战绩 card a 昨日战绩 query gets,
 * then the day's trend and conclusions from the session review, in Kurisu's voice, ending with the share link.
 * Everything is deterministic; the voice lines are picked from the numbers.
 *
 * The text is Markdown: OpenClaw's WhatsApp send path parses it and re-renders it as WhatsApp formatting, where
 * `**bold**` becomes WhatsApp *bold* and a single `*x*` would become _italic_. So bold is always `**…**`, and the
 * WhatsApp client's own limits are respected on top of that: emoji stay outside the markers, a bold span is followed
 * by a space, a newline or the end (a colon at most), and only the key facts are bold.
 */
export interface DailyReviewInput {
  review: SessionReviewPresentation;
  /** The pubg_query_stats presentation for the same business day; null leaves the card out. */
  stats: PubgStatsPresentation | null;
  /** Share page link; required, the daily review is never sent without one. */
  link: string;
  timezone: string;
  now: Date;
}

function localDay(value: string | number, timezone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(value));
}

function clock(value: number, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * The 战绩 card as the chat renders it, thinned for the daily message: names, the card title, the team totals and each
 * player's K/D stay bold; the volume line and the rest of the personal line are plain, titles included.
 */
function thinCard(card: string): string {
  return card
    .split('\n')
    .map((line) => {
      if (line.startsWith('• 个人数据：')) {
        const plain = line.replace(/\*\*/gu, '').replace(/KD (\d+(?:\.\d+)?)/u, '**KD $1**');
        return plain
          .replace('• 个人数据：', '• 个人数据： ')
          .replace(/，/gu, ' · ')
          .replace(/： (\*\*KD [\d.]+\*\*) · /u, '： $1 · ');
      }
      if (line.startsWith('• ')) return line.replace(/\*\*/gu, '');
      return line;
    })
    .join('\n');
}

function one(value: number | null): string {
  return value === null ? '?' : value.toFixed(1);
}

function opener(review: SessionReviewPresentation): string {
  const { wins, avgPlacement, baselineAvgPlacement } = review.summary;
  if (wins >= 2) return `**昨天吃了 ${wins} 次鸡** —— 哼,我承认,这个数据确实不坏。`;
  if (wins === 1) return '**昨天吃到 1 次鸡** —— 别急着庆祝,先看看其他几局是怎么回事。';
  if (
    avgPlacement !== null &&
    baselineAvgPlacement !== null &&
    avgPlacement <= baselineAvgPlacement - 2
  )
    return `**场均名次 ${one(avgPlacement)}** —— 比你们平时的 ${one(baselineAvgPlacement)} 好。看来偶尔也会把我的话听进去嘛。`;
  if (
    avgPlacement !== null &&
    baselineAvgPlacement !== null &&
    avgPlacement >= baselineAvgPlacement + 2
  )
    return `**场均名次 ${one(avgPlacement)}** —— 比平时的 ${one(baselineAvgPlacement)} 差。不是运气问题,数据在下面,自己看。`;
  return `**昨天一共 ${review.matchCount} 场排位** —— 数据我整理好了。别找借口,先看数字。`;
}

function metric(row: PubgMetricRow, key: string): number | null {
  const raw = row.values[key];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

/** One line for the best and one for the weakest K/D of the day; nothing when fewer than two players have one. */
function remarks(stats: PubgStatsPresentation | null): string[] {
  const rows = (stats?.rows ?? [])
    .map((row) => ({ row, kd: metric(row, 'kd'), damage: metric(row, 'damage') }))
    .filter((entry) => entry.kd !== null);
  if (rows.length < 2) return [];
  rows.sort((left, right) => right.kd! - left.kd! || (right.damage ?? 0) - (left.damage ?? 0));
  const best = rows[0]!;
  const worst = rows.at(-1)!;
  if (best.kd === worst.kd) return [];
  return [
    `**${best.row.label}** · K/D ${best.kd!.toFixed(2)} 全队最高——这次算你有点实力。`,
    `**${worst.row.label}** · K/D ${worst.kd!.toFixed(2)} 垫底……下次冲之前先想清楚,别把队友当垫背。`,
  ];
}

export function renderDailyReview(input: DailyReviewInput): string {
  const review = assertValid(validateSessionReviewPresentation(input.review));
  if (!/^https?:\/\/\S+$/u.test(input.link)) throw new Error('daily review needs a share link');
  const { timezone } = input;
  const maps = review.maps
    .map((map) =>
      map.count > 1 ? `${sessionMapName(map.mapName)}×${map.count}` : sessionMapName(map.mapName),
    )
    .join(' ');
  const windowStart = input.stats?.sourceRange?.from
    ? Date.parse(input.stats.sourceRange.from)
    : Date.parse(review.startAt);
  const windowEnd = input.stats?.sourceRange?.to
    ? Date.parse(input.stats.sourceRange.to)
    : Date.parse(review.endAt);
  const sections: string[][] = [
    [
      `🌅 **每日复盘 · ${localDay(windowStart, timezone)}**`,
      `_${clock(windowStart, timezone)} → ${clock(windowEnd, timezone)} · ${review.matchCount} 场排位 · ${maps}_`,
    ],
    [opener(review)],
  ];
  if (input.stats) {
    const options: PubgRenderOptions = {
      timezone,
      now: input.now.toISOString(),
      chatEmphasis: true,
    };
    sections.push([
      thinCard(renderPubgStats(input.stats, options)).replace(/^🏆 (.+)$/mu, '🏆 **$1**'),
    ]);
  }
  const lines = remarks(input.stats);
  if (lines.length) sections.push(['🗣️ **红莉栖点评**', ...lines]);
  const baseline =
    review.summary.baselineAvgPlacement === null
      ? ''
      : ` (你们平时 ${one(review.summary.baselineAvgPlacement)})`;
  sections.push([
    '🎮 **全天走势**',
    `名次 ${sessionPlacementStrip(review.placements)}`,
    `场均名次 **${one(review.summary.avgPlacement)}**${baseline} · **吃鸡 ${review.summary.wins}** · 前十 ${review.summary.top10} · 击倒 ${review.summary.teamKnocks}`,
  ]);
  sections.push([`**一句话：${review.headline}**`]);
  sections.push(
    review.findings.length
      ? ['**结论**', ...review.findings.map((finding, index) => `${index + 1}. ${finding.text}`)]
      : ['**结论**', '各项都在你们平时的正常波动范围内,没有值得单独拎出来的问题。'],
  );
  if (review.matchCount > 1 && review.bestMatch)
    sections.push([
      `**最好一局** ${sessionPlacement(review.bestMatch.rank)} ${sessionMapName(review.bestMatch.mapName)} · ${review.bestMatch.text}`,
    ]);
  if (review.matchCount > 1 && review.worstMatch)
    sections.push([
      `**最差一局** ${sessionPlacement(review.worstMatch.rank)} ${sessionMapName(review.worstMatch.mapName)} · ${review.worstMatch.text}`,
    ]);
  if (review.suggestion) sections.push([`**下次试试** ${review.suggestion}`]);
  const coverage =
    review.coverage.telemetry === review.coverage.total
      ? `📎 ${review.coverage.total}/${review.coverage.total} 场有完整遥测`
      : `📎 ${review.coverage.telemetry}/${review.coverage.total} 场有完整遥测,其余只按基础战绩`;
  sections.push([coverage, '—— 红莉栖 · 每天 09:30 的业务日复盘', `🔗 ${input.link}`]);
  return sections.map((section) => section.join('\n')).join('\n\n');
}
