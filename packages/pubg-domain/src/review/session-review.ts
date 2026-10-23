import type {
  SessionMemberTag,
  SessionReviewFinding,
  SessionReviewMatchNote,
  SessionReviewMember,
  SessionReviewPresentation,
  SessionReviewTimelineItem,
} from '@rine-kit/presentation';
import type { NormalizedMatch, NormalizedPlayer } from '../data/model.js';
import type { Fight, MatchReviewFacts } from './types.js';

export const SESSION_BASELINE_MS = 30 * 24 * 60 * 60_000;
export const SESSION_MIN_MEMBERS = 2;
/** Out within this much match time (plane included): roughly "lost someone right after landing". */
export const SESSION_EARLY_OUT_SECONDS = 420;
export const SESSION_BOOTSTRAP = 2000;
const SESSION_BOOTSTRAP_SEED = 20261018;
const MIN_SESSION_FOR_CLEAR = 3;
const MIN_BASELINE = 10;
const OBSERVATION_EFFECT = 0.5;
const OBSERVATION_WEIGHT = 0.35;
const MAX_FINDINGS = 3;

export interface SessionTeam {
  id: string;
  label: string;
  memberIds: readonly string[];
}

/** A ranked match in which at least two squad members played on the same team. */
export interface SquadMatch {
  match: NormalizedMatch;
  members: NormalizedPlayer[];
  teamRank: number | null;
  endMs: number;
}

export interface SquadSession {
  key: string;
  matches: SquadMatch[];
  startMs: number;
  lastEndMs: number;
}

export function squadMatches(
  matches: readonly NormalizedMatch[],
  memberIds: readonly string[],
  minMembers = SESSION_MIN_MEMBERS,
): SquadMatch[] {
  const members = new Set(memberIds);
  const result: SquadMatch[] = [];
  for (const match of matches) {
    if (!match.isCompetitive || !Number.isFinite(match.timestamp)) continue;
    // Members on the same team share the team placement; pick the largest such group.
    const teams = new Map<string, NormalizedPlayer[]>();
    for (const player of match.players) {
      if (!members.has(player.accountId)) continue;
      const team = String(player.rank ?? 'unknown');
      teams.set(team, [...(teams.get(team) ?? []), player]);
    }
    const team = [...teams.values()].sort((left, right) => right.length - left.length)[0] ?? [];
    if (team.length < minMembers) continue;
    result.push({
      match,
      members: team,
      teamRank: team[0]?.rank ?? null,
      endMs: match.timestamp + Math.max(0, match.duration) * 1000,
    });
  }
  return result.sort((left, right) => left.match.timestamp - right.match.timestamp);
}

export function dailyReviewKey(teamId: string, businessDay: string): string {
  return `pubg-daily:${teamId}:${businessDay}`;
}

/**
 * The squad's ranked matches that started inside one business day ([startMs, endMs), 06:00 to 06:00 local), as one
 * review session; null when the squad did not play together that day.
 */
export function dailySquadSession(
  matches: readonly NormalizedMatch[],
  team: SessionTeam,
  window: { businessDay: string; startMs: number; endMs: number },
): SquadSession | null {
  const day = squadMatches(matches, team.memberIds).filter(
    (item) => item.match.timestamp >= window.startMs && item.match.timestamp < window.endMs,
  );
  if (!day.length) return null;
  return {
    key: dailyReviewKey(team.id, window.businessDay),
    matches: day,
    startMs: day[0]!.match.timestamp,
    lastEndMs: Math.max(...day.map((item) => item.endMs)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Ledger

export type SessionReviewStatus = 'sent' | 'dry_run' | 'pending_delivery' | 'blocked' | 'skipped';

export interface SessionReviewRecord {
  squadId: string;
  sessionKey: string;
  matchIds: string[];
  lastMatchEndMs: number;
  status: SessionReviewStatus;
  detail: string | null;
  message: string | null;
  attempts: number;
  updatedAt: string;
}

/** Private Lab storage for the review ledger; deliberately not part of the tenant-aware repository port. */
export interface SessionReviewLedger {
  getSessionReview(squadId: string, sessionKey: string): SessionReviewRecord | null;
  putSessionReview(record: SessionReviewRecord): void;
  getSessionReviewMeta(key: string): string | null;
  setSessionReviewMeta(key: string, value: string): void;
  latestPrefetchFinishedMs(): number | null;
}

/** The squad's own ranked history in the 30 days before the session, used as "平时". */
export function sessionBaseline(
  matches: readonly NormalizedMatch[],
  team: SessionTeam,
  session: SquadSession,
): SquadMatch[] {
  return squadMatches(matches, team.memberIds).filter(
    (item) =>
      item.endMs < session.startMs && item.match.timestamp >= session.startMs - SESSION_BASELINE_MS,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Statistics

interface MatchMetrics {
  rank: number | null;
  top10: number;
  win: number;
  knocks: number;
  kills: number;
  damage: number;
  /** Per member present: the tracked roster size varies between matches, so totals alone would mislead. */
  memberKnocks: number;
  memberDamage: number;
  earlyOut: number;
  fightWins: number;
  fightLosses: number;
  hasFights: boolean;
}

function earlyOut(player: NormalizedPlayer): boolean {
  return player.survivalTime > 0 && player.survivalTime < SESSION_EARLY_OUT_SECONDS;
}

function metricsFor(item: SquadMatch, facts: MatchReviewFacts | null): MatchMetrics {
  const fights = facts?.fights ?? [];
  const present = Math.max(1, item.members.length);
  const knocks = item.members.reduce((sum, player) => sum + player.dbnos, 0);
  const damage = item.members.reduce((sum, player) => sum + player.damage, 0);
  return {
    rank: item.teamRank,
    top10: item.teamRank !== null && item.teamRank <= 10 ? 1 : 0,
    win: item.teamRank === 1 ? 1 : 0,
    knocks,
    kills: item.members.reduce((sum, player) => sum + player.kills, 0),
    damage,
    memberKnocks: knocks / present,
    memberDamage: damage / present,
    earlyOut: item.members.some((player) => earlyOut(player)) ? 1 : 0,
    fightWins: fights.filter((fight) => fight.result === 'WIN').length,
    fightLosses: fights.filter((fight) => fight.result === 'LOSS').length,
    hasFights: facts !== null,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type Statistic = (rows: readonly MatchMetrics[]) => number | null;

const mean =
  (pick: (row: MatchMetrics) => number | null): Statistic =>
  (rows) => {
    const values = rows.map(pick).filter((value): value is number => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };

const fightRate: Statistic = (rows) => {
  const withFights = rows.filter((row) => row.hasFights);
  const wins = withFights.reduce((sum, row) => sum + row.fightWins, 0);
  const decided = wins + withFights.reduce((sum, row) => sum + row.fightLosses, 0);
  return decided ? wins / decided : null;
};

/** Percentile interval of (session − baseline), resampling whole matches on both sides. */
function differenceInterval(
  session: readonly MatchMetrics[],
  baseline: readonly MatchMetrics[],
  statistic: Statistic,
): [number, number] | null {
  const random = mulberry32(SESSION_BOOTSTRAP_SEED);
  const resample = (rows: readonly MatchMetrics[]) =>
    Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]!);
  const differences: number[] = [];
  for (let index = 0; index < SESSION_BOOTSTRAP; index += 1) {
    const left = statistic(resample(session));
    const right = statistic(resample(baseline));
    if (left !== null && right !== null) differences.push(left - right);
  }
  if (differences.length < SESSION_BOOTSTRAP / 2) return null;
  differences.sort((left, right) => left - right);
  return [
    differences[Math.floor(differences.length * 0.025)]!,
    differences[Math.min(differences.length - 1, Math.floor(differences.length * 0.975))]!,
  ];
}

function spread(
  rows: readonly MatchMetrics[],
  statistic: Statistic,
  pick?: (row: MatchMetrics) => number | null,
): number | null {
  if (pick) {
    const values = rows.map(pick).filter((value): value is number => value !== null);
    if (values.length < 2) return null;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance) || null;
  }
  const rate = statistic(rows);
  return rate === null ? null : Math.sqrt(rate * (1 - rate)) || null;
}

interface Candidate {
  metric: string;
  better: 'higher' | 'lower';
  statistic: Statistic;
  /** Continuous metrics use the baseline standard deviation as scale; rates use sqrt(p(1-p)). */
  pick?: (row: MatchMetrics) => number | null;
  ready: (session: readonly MatchMetrics[], baseline: readonly MatchMetrics[]) => boolean;
  describe: (value: { session: number; baseline: number; rows: readonly MatchMetrics[] }) => string;
}

const decidedFights = (rows: readonly MatchMetrics[]) =>
  rows.reduce((sum, row) => sum + row.fightWins + row.fightLosses, 0);
const enough = (session: readonly MatchMetrics[]) => session.length >= 2;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const fixed = (value: number) => value.toFixed(1);

const CANDIDATES: readonly Candidate[] = [
  {
    metric: 'placement',
    better: 'lower',
    statistic: mean((row) => row.rank),
    pick: (row) => row.rank,
    ready: enough,
    describe: ({ session, baseline }) => `场均名次 ${fixed(session)},平时 ${fixed(baseline)}。`,
  },
  {
    metric: 'top10',
    better: 'higher',
    statistic: mean((row) => row.top10),
    ready: enough,
    describe: ({ rows, baseline }) =>
      `${rows.length} 场里进前十 ${rows.filter((row) => row.top10).length} 场,平时约 ${percent(baseline)}。`,
  },
  {
    metric: 'early_out',
    better: 'lower',
    statistic: mean((row) => row.earlyOut),
    ready: enough,
    describe: ({ rows, baseline }) => {
      const early = rows.filter((row) => row.earlyOut).length;
      return early
        ? `${rows.length} 场里 ${early} 场开局 7 分钟内就有人出局,平时约 ${Math.round(baseline * 10)}/10。`
        : `${rows.length} 场没有一次开局 7 分钟内减员,平时约 ${Math.round(baseline * 10)}/10 会。`;
    },
  },
  {
    metric: 'damage',
    better: 'higher',
    statistic: mean((row) => row.memberDamage),
    pick: (row) => row.memberDamage,
    ready: enough,
    describe: ({ session, baseline }) =>
      `人均伤害 ${Math.round(session)}/场,平时 ${Math.round(baseline)}。`,
  },
  {
    metric: 'knocks',
    better: 'higher',
    statistic: mean((row) => row.memberKnocks),
    pick: (row) => row.memberKnocks,
    ready: enough,
    describe: ({ session, baseline }) => `人均击倒 ${fixed(session)}/场,平时 ${fixed(baseline)}。`,
  },
  {
    metric: 'fights',
    better: 'higher',
    statistic: fightRate,
    ready: (session, baseline) => decidedFights(session) >= 5 && decidedFights(baseline) >= 20,
    describe: ({ rows, session, baseline }) => {
      const wins = rows.reduce((sum, row) => sum + row.fightWins, 0);
      const losses = rows.reduce((sum, row) => sum + row.fightLosses, 0);
      return `交战 ${wins} 胜 ${losses} 负(胜率 ${percent(session)}),平时 ${percent(baseline)}。`;
    },
  },
];

interface ScoredFinding extends SessionReviewFinding {
  score: number;
}

const GOOD_PHRASE: Record<string, string> = {
  placement: '名次比平时好',
  top10: '进前十稳',
  early_out: '开局很稳',
  damage: '火力足',
  knocks: '击倒多',
  fights: '交战赢得多',
};
const BAD_PHRASE: Record<string, string> = {
  placement: '名次比平时差',
  top10: '进前十少',
  early_out: '开局减员太多',
  damage: '火力不足',
  knocks: '击倒少',
  fights: '交战输得多',
  tilt: '早出局后容易上头',
};
const SUGGESTIONS: Record<string, string> = {
  early_out: '前期先求稳:换个人少的落点,落地先集合再搜。',
  fights: '接战前先把人拉到同一侧,集火同一个目标再打。',
  placement: '中后期提前进圈占位置,少在圈边被夹。',
  top10: '中后期提前进圈占位置,少在圈边被夹。',
  damage: '多找架枪位主动拉枪线,别只等对面来。',
  knocks: '多找架枪位主动拉枪线,别只等对面来。',
  tilt: '连着早出局时可以歇一局再开。',
};

function scoredFindings(
  session: readonly MatchMetrics[],
  baseline: readonly MatchMetrics[],
): ScoredFinding[] {
  const findings: ScoredFinding[] = [];
  for (const candidate of CANDIDATES) {
    if (!candidate.ready(session, baseline) || baseline.length < MIN_BASELINE) continue;
    const sessionValue = candidate.statistic(session);
    const baselineValue = candidate.statistic(baseline);
    const scale = spread(baseline, candidate.statistic, candidate.pick);
    if (sessionValue === null || baselineValue === null || !scale) continue;
    const orientation = candidate.better === 'higher' ? 1 : -1;
    const effect = ((sessionValue - baselineValue) / scale) * orientation;
    const interval =
      session.length >= MIN_SESSION_FOR_CLEAR
        ? differenceInterval(session, baseline, candidate.statistic)
        : null;
    const clear = interval !== null && (interval[0] > 0 || interval[1] < 0);
    if (!clear && Math.abs(effect) < OBSERVATION_EFFECT) continue;
    const text = candidate.describe({
      session: sessionValue,
      baseline: baselineValue,
      rows: session,
    });
    findings.push({
      metric: candidate.metric,
      tone: effect > 0 ? 'good' : 'bad',
      confidence: clear ? 'clear' : 'observation',
      text: `${text.replace(/。$/u, '')}${clear ? (effect > 0 ? ',明显更好' : ',明显更差') : '(仅本时段观察)'}。`,
      score: Math.abs(effect) * (clear ? 1 : OBSERVATION_WEIGHT),
    });
  }
  // Tilt: matches right after an early exit, compared with the rest of this same session. Never more than an observation.
  const after = session
    .filter((_, index) => index > 0 && session[index - 1]!.earlyOut === 1)
    .map((row) => row.rank)
    .filter((rank): rank is number => rank !== null);
  const rest = session
    .filter((_, index) => !(index > 0 && session[index - 1]!.earlyOut === 1))
    .map((row) => row.rank)
    .filter((rank): rank is number => rank !== null);
  if (after.length >= 2 && rest.length >= 2) {
    const afterMean = after.reduce((sum, rank) => sum + rank, 0) / after.length;
    const restMean = rest.reduce((sum, rank) => sum + rank, 0) / rest.length;
    if (afterMean - restMean >= 5) {
      findings.push({
        metric: 'tilt',
        tone: 'bad',
        confidence: 'observation',
        score: 0.3,
        text: `早出局后的下一局平均 #${Math.round(afterMean)},其余场次 #${Math.round(restMean)}(仅本时段观察)。`,
      });
    }
  }
  return findings.sort((left, right) => right.score - left.score);
}

/** Top findings by strength, keeping at least one thing done well when there is one. */
function selectFindings(findings: readonly ScoredFinding[]): ScoredFinding[] {
  const chosen = findings.slice(0, MAX_FINDINGS);
  if (!chosen.some((finding) => finding.tone === 'good')) {
    const good = findings.find((finding) => finding.tone === 'good');
    if (good) chosen.splice(Math.min(chosen.length, MAX_FINDINGS - 1), 1, good);
  }
  return chosen;
}

function headlineFor(
  findings: readonly ScoredFinding[],
  single: SquadMatch | null,
  singleEarlyOut: boolean,
): string {
  if (single) {
    if (single.teamRank === 1) return '吃鸡!';
    if (single.teamRank === null) return '这局名次未知。';
    if (single.teamRank <= 10) return `第 ${single.teamRank} 名,进了前十。`;
    return `第 ${single.teamRank} 名,${singleEarlyOut ? '开局就减员了' : '没能进前十'}。`;
  }
  const goods = findings.filter(
    (finding) => finding.tone === 'good' && finding.confidence === 'clear',
  );
  const bads = findings.filter(
    (finding) => finding.tone === 'bad' && finding.confidence === 'clear',
  );
  const [good, secondGood] = goods;
  const [bad, secondBad] = bads;
  if (good && bad) return `${GOOD_PHRASE[good.metric]},但${BAD_PHRASE[bad.metric]}。`;
  if (bad && secondBad) return `${BAD_PHRASE[bad.metric]},${BAD_PHRASE[secondBad.metric]}。`;
  if (bad) return `${BAD_PHRASE[bad.metric]},其他正常。`;
  if (good && secondGood) return `${GOOD_PHRASE[good.metric]},${GOOD_PHRASE[secondGood.metric]}。`;
  if (good) return `${GOOD_PHRASE[good.metric]},其他正常。`;
  return findings.length ? '和平时差不多,有些苗头还要多打几把看。' : '发挥正常,和平时差不多。';
}

// ---------------------------------------------------------------------------------------------------------------
// Review assembly

/** "第 N 分钟" counts the minute the moment falls in. */
function minuteOf(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

function fightText(fight: Fight): string {
  const outcome =
    fight.result === 'WIN' ? '交战获胜' : fight.result === 'LOSS' ? '交战失利' : '交战互有伤亡';
  const taken = fight.receivedKnocks ? `,被击倒 ${fight.receivedKnocks}` : '';
  return `${outcome},击倒 ${fight.teamKnocks} 人${taken}`;
}

function membersFor(
  session: SquadSession,
  playerNames: ReadonlyMap<string, string>,
): SessionReviewMember[] {
  const totals = new Map<string, SessionReviewMember>();
  for (const item of session.matches) {
    for (const player of item.members) {
      const entry = totals.get(player.accountId) ?? {
        name: playerNames.get(player.accountId) ?? player.playerName,
        matches: 0,
        kills: 0,
        knocks: 0,
        damagePerMatch: 0,
        earlyOuts: 0,
        revives: 0,
        tags: [],
      };
      entry.matches += 1;
      entry.kills += player.kills;
      entry.knocks += player.dbnos;
      entry.damagePerMatch += player.damage;
      entry.revives += player.revives;
      if (earlyOut(player)) entry.earlyOuts += 1;
      totals.set(player.accountId, entry);
    }
  }
  const members = [...totals.values()].map((member) => ({
    ...member,
    damagePerMatch: Math.round(member.damagePerMatch / member.matches),
  }));
  const byDamage = [...members].sort((left, right) => right.damagePerMatch - left.damagePerMatch);
  const topRevives = Math.max(0, ...members.map((member) => member.revives));
  for (const member of members) {
    const tags: SessionMemberTag[] = [];
    if (
      members.length >= 2 &&
      member === byDamage[0] &&
      member.damagePerMatch > (byDamage[1]?.damagePerMatch ?? 0)
    )
      tags.push('top_damage');
    if (member.earlyOuts >= Math.max(2, Math.ceil(member.matches / 2))) tags.push('early_outs');
    if (member.revives >= 3 && member.revives === topRevives) tags.push('medic');
    member.tags = tags.slice(0, 2);
  }
  return members.sort(
    (left, right) => right.knocks - left.knocks || right.damagePerMatch - left.damagePerMatch,
  );
}

function teamTotals(item: SquadMatch): { knocks: number; damage: number } {
  return {
    knocks: item.members.reduce((sum, player) => sum + player.dbnos, 0),
    damage: Math.round(item.members.reduce((sum, player) => sum + player.damage, 0)),
  };
}

function matchNotes(
  session: SquadSession,
  facts: ReadonlyMap<string, MatchReviewFacts | null>,
): { best?: SessionReviewMatchNote; worst?: SessionReviewMatchNote } {
  const ranked = session.matches.filter((item) => item.teamRank !== null);
  if (!ranked.length) return {};
  const order = [...ranked].sort(
    (left, right) =>
      left.teamRank! - right.teamRank! || teamTotals(right).knocks - teamTotals(left).knocks,
  );
  const bestItem = order[0]!;
  const totals = teamTotals(bestItem);
  const winFight = (facts.get(bestItem.match.matchId)?.fights ?? [])
    .filter((fight) => fight.result === 'WIN' && fight.teamKnocks >= 2)
    .sort((left, right) => right.teamKnocks - left.teamKnocks)[0];
  const best: SessionReviewMatchNote = {
    matchId: bestItem.match.matchId,
    rank: bestItem.teamRank,
    mapName: bestItem.match.mapName,
    text: `击倒 ${totals.knocks} · 团队伤害 ${totals.damage}${winFight ? ` · 第 ${minuteOf(winFight.start)} 分钟赢下交战击倒 ${winFight.teamKnocks} 人` : ''}`,
  };
  if (session.matches.length < 3) return { best };
  const worstItem = order.at(-1)!;
  if (worstItem === bestItem) return { best };
  const lastOut = Math.max(...worstItem.members.map((player) => player.survivalTime));
  const worstTotals = teamTotals(worstItem);
  const lostFight = (facts.get(worstItem.match.matchId)?.fights ?? [])
    .filter((fight) => fight.result === 'LOSS')
    .sort((left, right) => right.receivedKnocks - left.receivedKnocks)[0];
  const text =
    lastOut > 0 && lastOut < 600
      ? `全队在第 ${Math.ceil(lastOut / 60)} 分钟前出局`
      : `击倒 ${worstTotals.knocks} · 团队伤害 ${worstTotals.damage}${lostFight ? ` · 第 ${minuteOf(lostFight.start)} 分钟交战失利` : ''}`;
  return {
    best,
    worst: {
      matchId: worstItem.match.matchId,
      rank: worstItem.teamRank,
      mapName: worstItem.match.mapName,
      text,
    },
  };
}

function timelineFor(
  item: SquadMatch,
  facts: MatchReviewFacts | null,
): SessionReviewTimelineItem[] {
  const fights = [...(facts?.fights ?? [])].sort((left, right) => left.start - right.start);
  const moments: SessionReviewTimelineItem[] = [];
  const first = fights[0];
  if (first) moments.push({ atSeconds: first.start, text: `第一次${fightText(first)}` });
  const key = fights
    .slice(1)
    .sort((left, right) => right.importanceScore - left.importanceScore)[0];
  if (key) moments.push({ atSeconds: key.start, text: `关键${fightText(key)}` });
  const lastOut = Math.max(...item.members.map((player) => player.survivalTime));
  moments.push({
    atSeconds: lastOut,
    text: item.teamRank === 1 ? '吃鸡' : `全队出局,第 ${item.teamRank ?? '?'} 名`,
  });
  return moments.sort((left, right) => left.atSeconds - right.atSeconds).slice(0, 3);
}

export interface BuildSessionReviewInput {
  session: SquadSession;
  baseline: readonly SquadMatch[];
  team: SessionTeam;
  /** Compact review facts per match id; null when telemetry is missing. */
  facts: ReadonlyMap<string, MatchReviewFacts | null>;
  playerNames?: ReadonlyMap<string, string>;
  timezone: string;
  /** Link shown at the end of the review; the delivery layer decides what it points to. */
  link?: string;
  now: Date;
}

export function buildSessionReview(input: BuildSessionReviewInput): SessionReviewPresentation {
  const { session } = input;
  const factsFor = (item: SquadMatch) => input.facts.get(item.match.matchId) ?? null;
  const sessionRows = session.matches.map((item) => metricsFor(item, factsFor(item)));
  const baselineRows = input.baseline.map((item) => metricsFor(item, factsFor(item)));
  const scored = scoredFindings(sessionRows, baselineRows);
  const findings = selectFindings(scored);
  const single = session.matches.length === 1 ? session.matches[0]! : null;
  const ranks = session.matches.map((item) => item.teamRank);
  const knownRanks = ranks.filter((rank): rank is number => rank !== null);
  const baselineRanks = input.baseline
    .map((item) => item.teamRank)
    .filter((rank): rank is number => rank !== null);
  const average = (values: number[]) =>
    values.length
      ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
      : null;
  const maps = new Map<string, number>();
  for (const item of session.matches)
    maps.set(item.match.mapName, (maps.get(item.match.mapName) ?? 0) + 1);
  const notes = matchNotes(session, input.facts);
  const topBad = findings.find((finding) => finding.tone === 'bad');
  const review: SessionReviewPresentation = {
    type: 'pubg_session_review',
    version: 1,
    sessionKey: session.key,
    squadLabel: input.team.label,
    timezone: input.timezone,
    startAt: new Date(session.startMs).toISOString(),
    endAt: new Date(session.lastEndMs).toISOString(),
    matchCount: session.matches.length,
    maps: [...maps]
      .map(([mapName, count]) => ({ mapName, count }))
      .sort((left, right) => right.count - left.count),
    headline: headlineFor(scored, single, single ? sessionRows[0]!.earlyOut === 1 : false),
    placements: ranks,
    summary: {
      avgPlacement: average(knownRanks),
      baselineAvgPlacement: baselineRanks.length >= MIN_BASELINE ? average(baselineRanks) : null,
      wins: sessionRows.reduce((sum, row) => sum + row.win, 0),
      top10: sessionRows.reduce((sum, row) => sum + row.top10, 0),
      teamKnocks: sessionRows.reduce((sum, row) => sum + row.knocks, 0),
      avgTeamDamage: Math.round(
        sessionRows.reduce((sum, row) => sum + row.damage, 0) / sessionRows.length,
      ),
    },
    findings: findings.map(({ score: _score, ...finding }) => finding),
    members: membersFor(session, input.playerNames ?? new Map()),
    coverage: {
      telemetry: session.matches.filter((item) => factsFor(item) !== null).length,
      total: session.matches.length,
    },
    generatedAt: input.now.toISOString(),
  };
  if (notes.best) review.bestMatch = notes.best;
  if (notes.worst) review.worstMatch = notes.worst;
  if (single) review.timeline = timelineFor(single, factsFor(single));
  if (topBad && SUGGESTIONS[topBad.metric]) review.suggestion = SUGGESTIONS[topBad.metric]!;
  if (input.link) review.link = input.link;
  return review;
}
