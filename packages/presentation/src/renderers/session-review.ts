import type {
  SessionReviewMember,
  SessionReviewPresentation,
} from '../contracts/session-review.js';
import { assertValid } from '../validation/validate.js';
import { validateSessionReviewPresentation } from '../validation/session-review.js';

/** Target size for a group-chat message: about one and a half phone screens. */
export const SESSION_REVIEW_MAX_CHARS = 1000;
const STRIP_MAX = 12;

const MAP_NAMES: Readonly<Record<string, string>> = {
  Baltic_Main: '艾伦格',
  Erangel_Main: '艾伦格',
  Desert_Main: '米拉玛',
  Tiger_Main: '泰戈',
  Neon_Main: '荣都',
  Kiki_Main: '帝斯顿',
  Savage_Main: '萨诺',
  DihorOtok_Main: '维寒迪',
  Chimera_Main: '帕拉莫',
  Summerland_Main: '卡拉金',
  Heaven_Main: '哈文',
};

export function sessionMapName(mapName: string): string {
  return MAP_NAMES[mapName] ?? (mapName.replace(/_Main$/u, '') || '未知地图');
}

export interface SessionReviewRenderOptions {
  maxChars?: number;
}

function clock(value: string, timezone: string): { date: string; time: string } {
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
  return { date: `${parts.month}/${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function placement(rank: number | null): string {
  if (rank === null) return '#?';
  return rank === 1 ? '🏆' : `#${rank}`;
}

export { placement as sessionPlacement, strip as sessionPlacementStrip };

function strip(placements: Array<number | null>): string {
  if (placements.length <= STRIP_MAX) return placements.map(placement).join(' ');
  const half = STRIP_MAX / 2;
  return [
    ...placements.slice(0, half).map(placement),
    '…',
    ...placements.slice(-half).map(placement),
  ].join(' ');
}

function one(value: number | null): string {
  return value === null ? '?' : value.toFixed(1);
}

function memberLine(member: SessionReviewMember, showMatches: boolean, withTags: boolean): string {
  const tags = withTags
    ? member.tags
        .slice(0, 2)
        .map((tag) =>
          tag === 'top_damage'
            ? ' ⭐'
            : tag === 'early_outs'
              ? ` ⚠ 早出局 ${member.earlyOuts} 次`
              : ` 🩹 救援 ${member.revives}`,
        )
        .join('')
    : '';
  const games = showMatches ? ` · ${member.matches} 场` : '';
  return `${member.name} 击倒 ${member.knocks} · 淘汰 ${member.kills} · 伤害 ${Math.round(member.damagePerMatch)}/场${games}${tags}`;
}

function minute(seconds: number): string {
  return `第 ${Math.max(1, Math.ceil(seconds / 60))} 分钟`;
}

/**
 * Renders the review as WhatsApp text. When it is too long, whole sections are dropped from the least important up;
 * the title, verdict, placements and the link always stay and nothing is cut mid-sentence.
 */
export function renderSessionReview(
  presentation: SessionReviewPresentation,
  options: SessionReviewRenderOptions = {},
): string {
  const review = assertValid(validateSessionReviewPresentation(presentation));
  const maxChars = options.maxChars ?? SESSION_REVIEW_MAX_CHARS;
  const start = clock(review.startAt, review.timezone);
  const end = clock(review.endAt, review.timezone);
  const window =
    start.date === end.date
      ? `${start.date} ${start.time}–${end.time}`
      : `${start.date} ${start.time}–${end.date} ${end.time}`;
  const single = review.matchCount === 1;
  const sameMatchCounts = new Set(review.members.map((member) => member.matches)).size <= 1;
  const maps = review.maps
    .map((map) =>
      map.count > 1 ? `${sessionMapName(map.mapName)}×${map.count}` : sessionMapName(map.mapName),
    )
    .join(' ');

  // Ordered sections; `drop` gives the trimming order (1 is dropped first), undefined never drops.
  type Section = { lines: string[]; drop?: number };
  const build = (
    dropped: ReadonlySet<number>,
    findingLimit: number,
    memberTags: boolean,
  ): string => {
    const sections: Section[] = [];
    sections.push({
      lines: [
        single ? `*🎮 单局复盘 · ${window}*` : `*🎮 时段复盘 · ${window}*`,
        `${review.matchCount} 场排位 · ${maps}`,
      ],
    });
    sections.push({ lines: [`*一句话:${review.headline}*`] });
    if (single) {
      const rank = review.placements[0] ?? null;
      sections.push({
        lines: [
          `*名次* ${placement(rank)} · 击倒 ${review.summary.teamKnocks} · 团队伤害 ${Math.round(review.summary.avgTeamDamage)}`,
        ],
      });
      if (review.timeline?.length)
        sections.push({
          drop: 3,
          lines: [
            '*过程*',
            ...review.timeline.slice(0, 3).map((item) => `${minute(item.atSeconds)} ${item.text}`),
          ],
        });
    } else {
      const baseline =
        review.summary.baselineAvgPlacement === null
          ? ''
          : `(你们平时 ${one(review.summary.baselineAvgPlacement)})`;
      sections.push({
        lines: [
          `*名次* ${strip(review.placements)}`,
          `场均名次 ${one(review.summary.avgPlacement)}${baseline}`,
          `击倒 ${review.summary.teamKnocks} · 场均团队伤害 ${Math.round(review.summary.avgTeamDamage)} · 吃鸡 ${review.summary.wins} · 前十 ${review.summary.top10}`,
        ],
      });
    }
    const findings = review.findings.slice(0, single ? Math.min(1, findingLimit) : findingLimit);
    sections.push({
      lines: findings.length
        ? [
            '*结论*',
            ...findings.map((finding, index) =>
              single ? finding.text : `${index + 1}. ${finding.text}`,
            ),
          ]
        : ['*结论*', '各项都在你们平时的正常波动范围内,没有值得单独拎出来的问题。'],
    });
    if (!single && review.members.length) {
      sections.push({
        drop: 4,
        lines: [
          '*队员*',
          ...review.members.map((member) => memberLine(member, !sameMatchCounts, memberTags)),
        ],
      });
    }
    if (!single && review.bestMatch)
      sections.push({
        drop: 2,
        lines: [
          `*最好一局* ${placement(review.bestMatch.rank)} ${sessionMapName(review.bestMatch.mapName)} · ${review.bestMatch.text}`,
        ],
      });
    if (!single && review.worstMatch)
      sections.push({
        drop: 1,
        lines: [
          `*最差一局* ${placement(review.worstMatch.rank)} ${sessionMapName(review.worstMatch.mapName)} · ${review.worstMatch.text}`,
        ],
      });
    if (review.suggestion) sections.push({ drop: 5, lines: [`*下次试试* ${review.suggestion}`] });
    const coverage =
      review.coverage.telemetry === review.coverage.total
        ? `📎 ${review.coverage.total}/${review.coverage.total} 场有完整遥测`
        : `📎 ${review.coverage.telemetry}/${review.coverage.total} 场有完整遥测,其余只按基础战绩`;
    sections.push({ lines: review.link ? [coverage, `🔗 ${review.link}`] : [coverage] });
    return sections
      .filter((section) => section.drop === undefined || !dropped.has(section.drop))
      .map((section) => section.lines.join('\n'))
      .join('\n\n');
  };

  // Trimming ladder: worst match → best match → member tags → findings down to two → timeline → members → suggestion.
  const steps: Array<{ dropped: number[]; findings: number; tags: boolean }> = [
    { dropped: [], findings: 3, tags: true },
    { dropped: [1], findings: 3, tags: true },
    { dropped: [1, 2], findings: 3, tags: true },
    { dropped: [1, 2], findings: 3, tags: false },
    { dropped: [1, 2], findings: 2, tags: false },
    { dropped: [1, 2, 3], findings: 2, tags: false },
    { dropped: [1, 2, 3, 4], findings: 2, tags: false },
    { dropped: [1, 2, 3, 4, 5], findings: 2, tags: false },
    { dropped: [1, 2, 3, 4, 5], findings: 1, tags: false },
  ];
  let rendered = '';
  for (const step of steps) {
    rendered = build(new Set(step.dropped), step.findings, step.tags);
    if (rendered.length <= maxChars) return rendered;
  }
  return rendered;
}
