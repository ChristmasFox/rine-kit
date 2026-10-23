import { parseTelemetryPayload } from '@rine-kit/pubg-domain';
import { wilsonInterval, type RateEstimate } from './analytics.js';

export const STREAK_SCHEMA_VERSION = 1 as const;
/** Two takedowns by the same player at most this far apart belong to one streak (one engagement). */
export const STREAK_GAP_SECONDS = 60;
/** Takedowns of one team at most this far apart belong to the same final push. */
export const WIPE_GAP_SECONDS = 60;
export const STREAK_MIN_MATCHES = 10;

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function idOf(value: unknown): string | null {
  const accountId = obj(value).accountId;
  return typeof accountId === 'string' && accountId ? accountId : null;
}

function teamOf(value: unknown): string | null {
  const teamId = obj(value).teamId;
  return teamId === undefined || teamId === null ? null : String(teamId);
}

/** One enemy player taken out (knocked, or killed without a knock) by a tracked member. */
interface Takedown {
  time: number;
  victim: string;
  eventId: string;
}

/** Exact source events for a detected chain/wipe; absolute seconds are converted to replay time by the caller. */
export interface StreakMoment {
  kind: 'streak' | 'wipe';
  playerIds: string[];
  start: number;
  end: number;
  eventIds: string[];
  count: number;
  observedTeamSize: number | null;
}

/** Multi-kill counts for one member in one match; a streak of n distinct victims lands in bucket min(n, 4). */
export interface PlayerStreakMatch {
  takedowns: number;
  streaks: { two: number; three: number; fourPlus: number };
  /** Takedowns that were part of a streak of two or more. */
  chainedTakedowns: number;
  longest: number;
  /** Members of wiped enemy teams this player took down, and wipes where this player took down every member. */
  wipeTakedowns: number;
  soloWipes: number;
}

export interface TeamWipe {
  /** Members taken down in the final push and how many players the team had. */
  wiped: number;
  teamSize: number;
  /** Tracked member who took down the most of them, and how many. */
  lead: string;
  leadCount: number;
  solo: boolean;
  phase: number | null;
  durationSeconds: number;
}

export interface SquadWipedRecord {
  /** Squad members taken down in our own final push. */
  wiped: number;
  /** True when every one of them was taken down by the same enemy team, or by one enemy player. */
  singleTeam: boolean;
  singlePlayer: boolean;
}

export interface StreakMatchStats {
  players: Record<string, PlayerStreakMatch>;
  wipes: TeamWipe[];
  /** Null when the squad was not eliminated (won, or the end is not observed). */
  squadWiped: SquadWipedRecord | null;
  moments?: StreakMoment[];
}

function emptyPlayer(): PlayerStreakMatch {
  return {
    takedowns: 0,
    streaks: { two: 0, three: 0, fourPlus: 0 },
    chainedTakedowns: 0,
    longest: 0,
    wipeTakedowns: 0,
    soloWipes: 0,
  };
}

interface DeathInfo {
  time: number;
  /** Who took the player out: the last knocker, else the killer or finisher. */
  creditId: string | null;
  creditTeam: string | null;
  /** When the player was taken out: the last knock, else the death. */
  takedownTime: number;
  phase: number | null;
  eventIds: string[];
}

/**
 * Multi-kill streaks and team wipes from one raw payload. A takedown is a knock, or a kill without a prior knock;
 * a team wipe is an enemy team whose final push (takedowns at most WIPE_GAP_SECONDS apart up to its last death)
 * was taken down entirely by the tracked squad. Team kills and self-inflicted deaths are ignored.
 */
export function analyzeStreaks(
  payload: unknown,
  trackedIds: ReadonlySet<string>,
): StreakMatchStats {
  const takedowns = new Map<string, Takedown[]>();
  const teams = new Map<string, Set<string>>();
  const lastKnock = new Map<
    string,
    { time: number; attacker: string; team: string | null; eventId?: string }
  >();
  const deaths = new Map<string, DeathInfo>();
  const playerTeam = new Map<string, string>();
  const note = (character: unknown) => {
    const id = idOf(character);
    const team = teamOf(character);
    if (!id || team === null) return;
    playerTeam.set(id, team);
    const members = teams.get(team) ?? new Set<string>();
    members.add(id);
    teams.set(team, members);
  };

  const moments: StreakMoment[] = [];
  for (const [index, raw] of parseTelemetryPayload(payload).entries()) {
    const eventId = `telemetry-${index + 1}`;
    const event = obj(raw);
    const type = event._T;
    const time = typeof event._D === 'string' ? Date.parse(event._D) / 1000 : NaN;
    if (!Number.isFinite(time)) continue;
    const isGame = obj(event.common).isGame;
    const phase = typeof isGame === 'number' && isGame >= 1 ? Math.floor(isGame) : null;
    if (type === 'LogParachuteLanding' || type === 'LogPlayerPosition') {
      note(event.character);
    } else if (type === 'LogPlayerMakeGroggy') {
      note(event.attacker);
      note(event.victim);
      const attacker = idOf(event.attacker);
      const victim = idOf(event.victim);
      if (
        !attacker ||
        !victim ||
        attacker === victim ||
        teamOf(event.attacker) === teamOf(event.victim)
      )
        continue;
      lastKnock.set(victim, { time, attacker, team: teamOf(event.attacker), eventId });
      if (trackedIds.has(attacker))
        takedowns.set(attacker, [...(takedowns.get(attacker) ?? []), { time, victim, eventId }]);
    } else if (type === 'LogPlayerKillV2' || type === 'LogPlayerKill') {
      note(event.victim);
      const victim = idOf(event.victim);
      if (!victim || deaths.has(victim)) continue;
      const knock = lastKnock.get(victim);
      const killerRef = idOf(event.finisher)
        ? event.finisher
        : idOf(event.killer)
          ? event.killer
          : null;
      const killer = idOf(killerRef);
      const enemyKiller =
        killer && killer !== victim && teamOf(killerRef) !== teamOf(event.victim) ? killer : null;
      // A knock only counts when it is the knock this death followed from; a revived player may die to someone else.
      const knocked =
        knock && idOf(event.dBNOMaker) === knock.attacker
          ? knock
          : idOf(event.dBNOMaker)
            ? { time, attacker: idOf(event.dBNOMaker)!, team: teamOf(event.dBNOMaker) }
            : null;
      const credit =
        knocked && knocked.team !== teamOf(event.victim) ? knocked.attacker : enemyKiller;
      const creditTeam =
        knocked && knocked.team !== teamOf(event.victim)
          ? knocked.team
          : enemyKiller
            ? teamOf(killerRef)
            : null;
      deaths.set(victim, {
        time,
        creditId: credit,
        creditTeam,
        takedownTime: knocked?.time ?? time,
        phase,
        eventIds: [...(knocked?.eventId ? [knocked.eventId] : []), eventId],
      });
      if (!knocked && enemyKiller && trackedIds.has(enemyKiller))
        takedowns.set(enemyKiller, [
          ...(takedowns.get(enemyKiller) ?? []),
          { time, victim, eventId },
        ]);
    } else if (type === 'LogPlayerRevive') {
      const victim = idOf(event.victim);
      if (victim) lastKnock.delete(victim);
    }
  }

  const players: Record<string, PlayerStreakMatch> = {};
  for (const id of trackedIds) players[id] = emptyPlayer();
  for (const [id, list] of takedowns) {
    const entry = players[id]!;
    const sorted = [...list].sort((left, right) => left.time - right.time);
    entry.takedowns = sorted.length;
    let chain = new Set<string>();
    let chainCount = 0;
    let chainEvents: Takedown[] = [];
    let previous = -Infinity;
    const close = () => {
      const size = chain.size;
      if (size >= 2) {
        moments.push({
          kind: 'streak',
          playerIds: [id],
          start: chainEvents[0]!.time,
          end: chainEvents.at(-1)!.time,
          eventIds: chainEvents.map((item) => item.eventId),
          count: size,
          observedTeamSize: null,
        });
        entry.chainedTakedowns += chainCount;
        if (size === 2) entry.streaks.two += 1;
        else if (size === 3) entry.streaks.three += 1;
        else entry.streaks.fourPlus += 1;
      }
      entry.longest = Math.max(entry.longest, size);
    };
    for (const takedown of sorted) {
      if (takedown.time - previous > STREAK_GAP_SECONDS) {
        close();
        chain = new Set();
        chainCount = 0;
        chainEvents = [];
      }
      chain.add(takedown.victim);
      chainCount += 1;
      chainEvents.push(takedown);
      previous = takedown.time;
    }
    close();
  }

  const finalPush = (members: readonly string[]) => {
    if (!members.length || members.some((member) => !deaths.has(member))) return null;
    const ordered = members
      .map((member) => ({ member, ...deaths.get(member)! }))
      .sort((left, right) => left.takedownTime - right.takedownTime);
    const push = [ordered.at(-1)!];
    for (let index = ordered.length - 2; index >= 0; index -= 1) {
      if (push[0]!.takedownTime - ordered[index]!.takedownTime > WIPE_GAP_SECONDS) break;
      push.unshift(ordered[index]!);
    }
    return push;
  };

  const trackedTeams = new Set(
    [...trackedIds]
      .map((id) => playerTeam.get(id))
      .filter((team): team is string => team !== undefined),
  );
  const wipes: TeamWipe[] = [];
  for (const [team, memberSet] of teams) {
    if (trackedTeams.has(team)) continue;
    const push = finalPush([...memberSet]);
    if (
      !push ||
      push.length < 2 ||
      !push.every((item) => item.creditId !== null && trackedIds.has(item.creditId))
    )
      continue;
    const counts = new Map<string, number>();
    for (const item of push) counts.set(item.creditId!, (counts.get(item.creditId!) ?? 0) + 1);
    const [lead, leadCount] = [...counts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]!;
    for (const [id, count] of counts) players[id]!.wipeTakedowns += count;
    const solo = counts.size === 1;
    if (solo) players[lead]!.soloWipes += 1;
    wipes.push({
      wiped: push.length,
      teamSize: memberSet.size,
      lead,
      leadCount,
      solo,
      phase: push.at(-1)!.phase,
      durationSeconds: push.at(-1)!.takedownTime - push[0]!.takedownTime,
    });
    moments.push({
      kind: 'wipe',
      playerIds: [...counts.keys()].sort(),
      start: push[0]!.takedownTime,
      end: Math.max(...push.map((item) => item.time)),
      eventIds: [...new Set([...memberSet].flatMap((member) => deaths.get(member)!.eventIds))],
      count: push.length,
      observedTeamSize: memberSet.size,
    });
  }

  let squadWiped: SquadWipedRecord | null = null;
  const squadMembers = [...trackedTeams].flatMap((team) => [...(teams.get(team) ?? [])]);
  const ownPush = trackedTeams.size === 1 ? finalPush(squadMembers) : null;
  if (ownPush && ownPush.every((item) => item.creditId !== null)) {
    squadWiped = {
      wiped: ownPush.length,
      singleTeam: new Set(ownPush.map((item) => item.creditTeam)).size === 1,
      singlePlayer: new Set(ownPush.map((item) => item.creditId)).size === 1 && ownPush.length >= 2,
    };
  }
  return { players, wipes, squadWiped, moments };
}

export interface StreakPlayerSummary {
  accountId: string;
  name: string;
  matches: number;
  takedowns: number;
  two: number;
  three: number;
  fourPlus: number;
  longest: number;
  /** Share of takedowns that came inside a streak; how often one takedown leads straight into the next. */
  chainedShare: RateEstimate | null;
  /** Multi-kills (streaks of two or more) per ten matches. */
  multiPerTen: number | null;
  wipeTakedowns: number;
  soloWipes: number;
}

export interface StreakSummary {
  schemaVersion: typeof STREAK_SCHEMA_VERSION;
  matches: number;
  players: StreakPlayerSummary[];
  wipes: {
    total: number;
    perMatch: number | null;
    /** Matches with at least one wipe. */
    matchShare: RateEstimate | null;
    fullTeam: number;
    solo: number;
    bySize: Array<{ wiped: number; count: number }>;
    byStage: Array<{ stage: 'early' | 'mid' | 'late'; count: number }>;
    medianSeconds: number | null;
    /** Who took down the most players across wipes, and who led them. */
    leaders: Array<{
      accountId: string;
      name: string;
      wipeTakedowns: number;
      led: number;
      solo: number;
    }>;
  };
  wiped: {
    observed: number;
    singleTeam: RateEstimate | null;
    singlePlayer: number;
  };
  highlights: string[];
  notes: string[];
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeStreaks(
  items: readonly StreakMatchStats[],
  names: ReadonlyMap<string, string>,
): StreakSummary {
  const perPlayer = new Map<string, { matches: number; stats: PlayerStreakMatch }>();
  for (const item of items) {
    for (const [id, stats] of Object.entries(item.players)) {
      const current = perPlayer.get(id) ?? { matches: 0, stats: emptyPlayer() };
      current.matches += 1;
      current.stats.takedowns += stats.takedowns;
      current.stats.streaks.two += stats.streaks.two;
      current.stats.streaks.three += stats.streaks.three;
      current.stats.streaks.fourPlus += stats.streaks.fourPlus;
      current.stats.chainedTakedowns += stats.chainedTakedowns;
      current.stats.longest = Math.max(current.stats.longest, stats.longest);
      current.stats.wipeTakedowns += stats.wipeTakedowns;
      current.stats.soloWipes += stats.soloWipes;
      perPlayer.set(id, current);
    }
  }
  const players: StreakPlayerSummary[] = [...perPlayer.entries()]
    .map(([accountId, { matches, stats }]) => {
      const multis = stats.streaks.two + stats.streaks.three + stats.streaks.fourPlus;
      return {
        accountId,
        name: names.get(accountId) ?? '未知',
        matches,
        takedowns: stats.takedowns,
        two: stats.streaks.two,
        three: stats.streaks.three,
        fourPlus: stats.streaks.fourPlus,
        longest: stats.longest,
        chainedShare:
          stats.takedowns > 0 ? wilsonInterval(stats.chainedTakedowns, stats.takedowns) : null,
        multiPerTen: matches > 0 ? (multis / matches) * 10 : null,
        wipeTakedowns: stats.wipeTakedowns,
        soloWipes: stats.soloWipes,
      };
    })
    .sort(
      (left, right) =>
        (right.multiPerTen ?? -1) - (left.multiPerTen ?? -1) || left.name.localeCompare(right.name),
    );

  const wipes = items.flatMap((item) => item.wipes);
  const sizeCounts = new Map<number, number>();
  for (const wipe of wipes)
    sizeCounts.set(Math.min(wipe.wiped, 4), (sizeCounts.get(Math.min(wipe.wiped, 4)) ?? 0) + 1);
  const stageOf = (phase: number | null): 'early' | 'mid' | 'late' =>
    phase === null || phase < 3 ? 'early' : phase < 5 ? 'mid' : 'late';
  const leaders = new Map<string, { wipeTakedowns: number; led: number; solo: number }>();
  for (const player of players)
    leaders.set(player.accountId, {
      wipeTakedowns: player.wipeTakedowns,
      led: 0,
      solo: player.soloWipes,
    });
  for (const wipe of wipes) {
    const entry = leaders.get(wipe.lead);
    if (entry) entry.led += 1;
  }
  const wipedRecords = items
    .map((item) => item.squadWiped)
    .filter((record): record is SquadWipedRecord => record !== null);
  const multiWipes = wipedRecords.filter((record) => record.wiped >= 2);

  const enough = items.length >= STREAK_MIN_MATCHES;
  const highlights: string[] = [];
  if (enough && wipes.length) {
    const fullTeam = wipes.filter((wipe) => wipe.wiped >= 4).length;
    highlights.push(
      `${items.length} 场里灭队 ${wipes.length} 次（平均每场 ${(wipes.length / items.length).toFixed(2)} 次），其中一波打倒 4 人的满编灭队 ${fullTeam} 次。`,
    );
    const solos = wipes.filter((wipe) => wipe.solo);
    if (solos.length) {
      const byLead = new Map<string, number>();
      for (const wipe of solos) byLead.set(wipe.lead, (byLead.get(wipe.lead) ?? 0) + 1);
      const text = [...byLead.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([id, count]) => `${names.get(id) ?? '未知'} ${count} 次`)
        .join('、');
      highlights.push(`单人灭队（一人打倒这一波的全部敌人）${solos.length} 次：${text}。`);
    }
  }
  const topStreak = [...players].sort((left, right) => right.longest - left.longest)[0];
  if (enough && topStreak && topStreak.longest >= 3)
    highlights.push(
      `最长连杀：${topStreak.name} 在 ${STREAK_GAP_SECONDS} 秒节奏内连续放倒 ${topStreak.longest} 人。`,
    );
  if (enough && multiWipes.length >= 10) {
    const single = multiWipes.filter((record) => record.singleTeam).length;
    highlights.push(
      `小队被淘汰的 ${multiWipes.length} 次里，${((single / multiWipes.length) * 100).toFixed(0)}% 是最后一波被同一支队伍全部放倒${multiWipes.some((record) => record.singlePlayer) ? `，其中 ${multiWipes.filter((record) => record.singlePlayer).length} 次是被敌方一人灭队` : ''}。`,
    );
  }

  return {
    schemaVersion: STREAK_SCHEMA_VERSION,
    matches: items.length,
    players,
    wipes: {
      total: wipes.length,
      perMatch: items.length ? wipes.length / items.length : null,
      matchShare: items.length
        ? wilsonInterval(items.filter((item) => item.wipes.length > 0).length, items.length)
        : null,
      fullTeam: wipes.filter((wipe) => wipe.wiped >= 4).length,
      solo: wipes.filter((wipe) => wipe.solo).length,
      bySize: [2, 3, 4].map((wiped) => ({ wiped, count: sizeCounts.get(wiped) ?? 0 })),
      byStage: (['early', 'mid', 'late'] as const).map((stage) => ({
        stage,
        count: wipes.filter((wipe) => stageOf(wipe.phase) === stage).length,
      })),
      medianSeconds: median(wipes.map((wipe) => wipe.durationSeconds)),
      leaders: [...leaders.entries()]
        .map(([accountId, entry]) => ({
          accountId,
          name: names.get(accountId) ?? '未知',
          ...entry,
        }))
        .sort(
          (left, right) =>
            right.wipeTakedowns - left.wipeTakedowns || left.name.localeCompare(right.name),
        ),
    },
    wiped: {
      observed: multiWipes.length,
      singleTeam: multiWipes.length
        ? wilsonInterval(multiWipes.filter((record) => record.singleTeam).length, multiWipes.length)
        : null,
      singlePlayer: multiWipes.filter((record) => record.singlePlayer).length,
    },
    highlights,
    notes: [
      `击倒或未经击倒的直接击杀都算一次放倒；同一人相邻两次放倒不同敌人相隔不超过 ${STREAK_GAP_SECONDS} 秒算同一波连杀，按 2 / 3 / 4+ 人分档。`,
      `灭队 = 敌队最后一波倒下的成员（相邻放倒相隔不超过 ${WIPE_GAP_SECONDS} 秒）全部由本小队放倒，且至少 2 人；成员记在击倒者名下，未被击倒直接死亡的记在击杀者名下。更早已被别人淘汰的成员不计入这一波。`,
      '连杀占比 = 落在连杀里的放倒 ÷ 全部放倒，衡量「打倒一个之后能否马上接下一个」，和总击倒数无关。灭队次数受存活时间和交战机会影响，是描述而非能力评分。',
    ],
  };
}
