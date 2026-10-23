import { wilsonInterval, type RateEstimate } from './analytics.js';
import type {
  LifeSegment,
  MatchStory,
  StoryCirclePoint,
  StoryEvent,
  StoryFight,
  StoryPlayer,
} from './match-story.js';

export const MATCH_INSIGHT_SCHEMA_VERSION = 1 as const;
/** How far back a down looks for the fire that caused it. */
export const DOWN_LOOKBACK_SECONDS = 20;
/** A shot taken from at least this far is a long-range pick. */
export const DOWN_FAR_METERS = 150;
/** A member this far from every teammate is on their own. */
export const DOWN_ALONE_METERS = 150;
/** Opposing players within this distance count as nearby. */
export const DOWN_NEARBY_METERS = 300;

/** One contact between the squad and an opposing team, as collected while reading the telemetry. */
export interface StoryContact {
  t: number;
  kind: 'dealt' | 'taken' | 'knock' | 'downed' | 'kill' | 'revive';
  member: string;
  enemyTeam: string | null;
  amount: number;
  victim: string | null;
  weapon?: string | null;
}

export interface BlueDamage {
  t: number;
  member: string;
  amount: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Why each knock-down happened

export type DownCause =
  | 'ambush_far'
  | 'ambush_close'
  | 'crossfire'
  | 'isolated'
  | 'lost_duel'
  | 'bluezone'
  | 'environment';

export const DOWN_CAUSES: ReadonlyArray<{ key: DownCause; label: string; advice: string }> = [
  {
    key: 'ambush_far',
    label: '被远程先手打倒',
    advice:
      '没来得及还手就被 150 米外的火力打倒：过空地、开阔地时分散并先找掩体，听到枪声先卧倒再判断方向。',
  },
  {
    key: 'ambush_close',
    label: '被近距离偷袭',
    advice: '近距离突然被打倒且没还手：进房、过拐角前先架枪或扔雷，别几个人一起挤过门。',
  },
  {
    key: 'crossfire',
    label: '多队混战',
    advice:
      '20 秒内被两支以上队伍打到：遇到枪声别硬凑，先判断是谁和谁在打，必要时撤出去等他们消耗。',
  },
  {
    key: 'isolated',
    label: '落单被击倒',
    advice: '还了手但身边没有队友（150 米内无人）：保持队形，落单的人先向队友靠拢再交战。',
  },
  {
    key: 'lost_duel',
    label: '正面交战落败',
    advice: '双方互有输出但这边先倒：这是正常对枪的结果，可看火力配置、掩体和人数是否占优。',
  },
  {
    key: 'bluezone',
    label: '被毒圈击倒',
    advice: '倒在毒里：转圈太晚，提前出发或用载具，别等到圈刷新才开始跑。',
  },
  { key: 'environment', label: '环境击倒', advice: '被坠落、爆炸、载具等击倒。' },
];

export interface StoryDown {
  t: number;
  member: string;
  cause: DownCause;
  attackerTeam: string | null;
  weapon: string | null;
  meters: number | null;
  /** Damage the squad dealt to the attacking team in the lookback window (0 = no return fire). */
  returnDamage: number;
  /** Damage the squad took from opposing teams in the lookback window. */
  takenDamage: number;
  /** Distinct opposing teams that damaged the squad in the lookback window. */
  teamsHitting: number;
  nearestTeammate: number | null;
  alone: boolean | null;
  /** Opposing teams with a player within DOWN_NEARBY_METERS when the down happened. */
  teamsNearby: number | null;
  phase: number | null;
  outcome: 'revived' | 'died' | 'unknown';
  /** Seconds from the down to the revive or the death. */
  afterSeconds: number | null;
}

type Route = Array<{ t: number; x: number; y: number }>;

function positionAt(route: Route, t: number, maxGap: number): { x: number; y: number } | null {
  if (!route.length) return null;
  if (t < route[0]!.t - maxGap) return null;
  for (let index = 1; index < route.length; index += 1) {
    const next = route[index]!;
    if (t <= next.t) {
      const prev = route[index - 1]!;
      if (next.t - prev.t > maxGap * 3)
        return Math.abs(t - prev.t) <= maxGap ? prev : Math.abs(next.t - t) <= maxGap ? next : null;
      const f = next.t === prev.t ? 1 : (t - prev.t) / (next.t - prev.t);
      return { x: prev.x + (next.x - prev.x) * f, y: prev.y + (next.y - prev.y) * f };
    }
  }
  const last = route.at(-1)!;
  return t - last.t <= maxGap ? last : null;
}

function aliveAt(player: StoryPlayer, t: number): boolean {
  return (
    player.lifeline.some(
      (segment: LifeSegment) => t >= segment.from && t <= segment.to && segment.state !== 'dead',
    ) ||
    (player.diedAt === null && player.route.length > 0 && t >= (player.landing?.t ?? 0))
  );
}

export function buildDowns(
  story: MatchStory,
  contacts: readonly StoryContact[],
  blueDamage: readonly BlueDamage[],
): StoryDown[] {
  const downs: StoryDown[] = [];
  const stateAt = (t: number): StoryCirclePoint | null => {
    let found: StoryCirclePoint | null = null;
    for (const point of story.circle) {
      if (point.t > t) break;
      found = point;
    }
    return found;
  };
  for (const event of story.events) {
    if (event.kind !== 'downed') continue;
    const t = event.t;
    const downContact = contacts.find(
      (item) => item.kind === 'downed' && item.member === event.member && Math.abs(item.t - t) < 1,
    );
    const attackerTeam = downContact?.enemyTeam ?? null;
    const window = contacts.filter((item) => item.t >= t - DOWN_LOOKBACK_SECONDS && item.t <= t);
    const takenBy = window.filter((item) => item.kind === 'taken');
    const teamsHitting = new Set(
      takenBy.map((item) => item.enemyTeam).filter((team): team is string => team !== null),
    );
    const returnDamage =
      attackerTeam === null
        ? 0
        : window
            .filter((item) => item.kind === 'dealt' && item.enemyTeam === attackerTeam)
            .reduce((sum, item) => sum + item.amount, 0);
    const takenDamage = takenBy.reduce((sum, item) => sum + item.amount, 0);

    const me = story.players.find((player) => player.member === event.member);
    const here = me ? positionAt(me.route, t, 15) : null;
    let nearest: number | null = null;
    if (here) {
      for (const mate of story.players) {
        if (mate.member === event.member || !aliveAt(mate, t)) continue;
        const there = positionAt(mate.route, t, 15);
        if (there) {
          const distance = Math.hypot(here.x - there.x, here.y - there.y);
          nearest = nearest === null ? distance : Math.min(nearest, distance);
        }
      }
    }
    let teamsNearby: number | null = null;
    if (here && story.enemies.length) {
      const teams = new Set<string>();
      for (const enemy of story.enemies) {
        const there = positionAt(
          enemy.route.map(([time, x, y]) => ({ t: time, x, y })),
          t,
          25,
        );
        if (
          there &&
          Math.hypot(here.x - there.x, here.y - there.y) <= DOWN_NEARBY_METERS &&
          (enemy.diedAt === null || enemy.diedAt >= t)
        )
          teams.add(enemy.team);
      }
      teamsNearby = teams.size;
    }

    const inBlue = blueDamage.some(
      (item) => item.member === event.member && item.t >= t - 12 && item.t <= t + 1,
    );
    let cause: DownCause;
    if (!event.byPlayer || attackerTeam === null) cause = inBlue ? 'bluezone' : 'environment';
    else if (teamsHitting.size >= 2) cause = 'crossfire';
    else if (returnDamage === 0)
      cause = (event.meters ?? 0) >= DOWN_FAR_METERS ? 'ambush_far' : 'ambush_close';
    else if (nearest !== null && nearest > DOWN_ALONE_METERS) cause = 'isolated';
    else cause = 'lost_duel';

    const later = story.events.find(
      (item) =>
        item.t > t &&
        ((item.kind === 'death' && item.member === event.member) ||
          (item.kind === 'revive' && item.other === event.member)),
    );
    downs.push({
      t: Math.round(t),
      member: event.member,
      cause,
      attackerTeam,
      weapon: event.weapon,
      meters: event.meters,
      returnDamage: Math.round(returnDamage),
      takenDamage: Math.round(takenDamage),
      teamsHitting: teamsHitting.size,
      nearestTeammate: nearest === null ? null : Math.round(nearest),
      alone: nearest === null ? null : nearest > DOWN_ALONE_METERS,
      teamsNearby,
      phase: stateAt(t)?.phase ?? null,
      outcome: !later ? 'unknown' : later.kind === 'revive' ? 'revived' : 'died',
      afterSeconds: later ? Math.round(later.t - t) : null,
    });
  }
  return downs;
}

// ---------------------------------------------------------------------------------------------------------------
// Turning points of one match

export interface TurningPoint {
  kind: 'first_loss' | 'collapse' | 'costly' | 'decisive' | 'final_fight';
  t: number;
  fight: number | null;
  member: string | null;
  /** Consecutive fights in a collapse, or the down/takedown balance of a single fight. */
  count: number;
}

export function buildTurningPoints(story: MatchStory): TurningPoint[] {
  const points: TurningPoint[] = [];
  const firstDeath = story.events.find((event) => event.kind === 'death');
  if (firstDeath) {
    const fight =
      [...story.fights].reverse().find((item) => item.start <= firstDeath.t + 5) ?? null;
    points.push({
      kind: 'first_loss',
      t: Math.round(firstDeath.t),
      fight: fight?.index ?? null,
      member: firstDeath.member,
      count: 0,
    });
  }
  if (story.squadOutAt !== null) {
    const before = story.fights.filter((fight) => fight.start <= story.squadOutAt!);
    let streak = 0;
    for (let index = before.length - 1; index >= 0; index -= 1) {
      if (before[index]!.outcome === 'lose') streak += 1;
      else if (before[index]!.outcome === 'win') break;
      else if (streak === 0) continue;
    }
    const last = before.at(-1);
    if (streak >= 2) {
      const first = before[before.length - streak]!;
      points.push({
        kind: 'collapse',
        t: first.start,
        fight: first.index,
        member: null,
        count: streak,
      });
    } else if (last) {
      points.push({
        kind: 'final_fight',
        t: last.start,
        fight: last.index,
        member: null,
        count: last.ourDowns - last.enemyDowns,
      });
    }
  }
  const costly = [...story.fights].sort(
    (left, right) =>
      right.ourDowns - right.enemyDowns - (left.ourDowns - left.enemyDowns) ||
      right.ourDowns - left.ourDowns,
  )[0];
  if (
    costly &&
    costly.ourDowns >= 2 &&
    costly.ourDowns > costly.enemyDowns &&
    !points.some((point) => point.fight === costly.index && point.kind !== 'first_loss')
  ) {
    points.push({
      kind: 'costly',
      t: costly.start,
      fight: costly.index,
      member: null,
      count: costly.ourDowns - costly.enemyDowns,
    });
  }
  const decisive = [...story.fights].sort(
    (left, right) =>
      right.enemyDowns - right.ourDowns - (left.enemyDowns - left.ourDowns) ||
      right.enemyDowns - left.enemyDowns,
  )[0];
  if (decisive && decisive.enemyDowns >= 2 && decisive.enemyDowns > decisive.ourDowns) {
    points.push({
      kind: 'decisive',
      t: decisive.start,
      fight: decisive.index,
      member: null,
      count: decisive.enemyDowns - decisive.ourDowns,
    });
  }
  return points.sort((left, right) => left.t - right.t);
}

// ---------------------------------------------------------------------------------------------------------------
// Rotating with the circle

const GRID_SECONDS = 10;
/**
 * In the telemetry `poisonGasWarning*` is the NEXT safe circle (the white circle, fixed for a whole phase) and
 * `safetyZone*` is the gas wall closing in on it (the blue circle, shrinking once the phase starts to close).
 * A squad is late into a circle when it is not inside the white circle by the time the blue wall starts to move.
 */

export interface RotationEpoch {
  phase: number | null;
  start: number;
  end: number;
  radius: number;
  /** How far outside the new safe circle the squad stood when it appeared (0 = already inside). */
  outsideAtStart: number;
  /** Seconds from the circle appearing to the squad being inside it; null when it never got in. */
  enteredAfter: number | null;
  /** Seconds from the circle appearing to the gas wall starting to close; null in the final phases that never close. */
  shrinkAfter: number | null;
  /** Seconds the squad was inside before the wall moved (negative = the wall caught it); null when either is unknown. */
  margin: number | null;
  blueSeconds: number;
  blueDamage: number;
  distance: number;
  vehicleShare: number | null;
}

export interface MatchRotation {
  epochs: RotationEpoch[];
  blueSeconds: number;
  blueDamage: number;
  distance: number;
  vehicleShare: number | null;
  /** Seconds from the first landing to the first fight. */
  landingToFight: number | null;
  /** Circles from phase 3 on that the squad had not reached when the wall started to close (or never reached). */
  lateEntries: number;
  circlesChecked: number;
}

/** Not inside the white circle when the wall started to close, or never inside. */
function isLate(epoch: RotationEpoch): boolean {
  return (
    epoch.enteredAfter === null ||
    (epoch.shrinkAfter !== null && epoch.enteredAfter > epoch.shrinkAfter)
  );
}

export function buildRotation(story: MatchStory, blueDamage: readonly BlueDamage[]): MatchRotation {
  const empty: MatchRotation = {
    epochs: [],
    blueSeconds: 0,
    blueDamage: 0,
    distance: 0,
    vehicleShare: null,
    landingToFight: null,
    lateEntries: 0,
    circlesChecked: 0,
  };
  if (!story.players.length || !story.circle.length) return empty;
  const routes = story.players.map((player) => ({
    player,
    route: player.route.map((point) => ({
      t: point.t,
      x: point.x,
      y: point.y,
      vehicle: point.vehicle,
      blue: point.blue === true,
    })),
  }));
  const centroidAt = (t: number): { x: number; y: number; members: number } | null => {
    const spots = routes
      .filter(({ player }) => aliveAt(player, t))
      .map(({ route }) => positionAt(route, t, GRID_SECONDS * 2))
      .filter((spot): spot is { x: number; y: number } => spot !== null);
    if (!spots.length) return null;
    return {
      x: spots.reduce((sum, spot) => sum + spot.x, 0) / spots.length,
      y: spots.reduce((sum, spot) => sum + spot.y, 0) / spots.length,
      members: spots.length,
    };
  };
  const flagsAt = (t: number) => {
    let inBlue = false;
    let samples = 0;
    let vehicle = 0;
    for (const { player, route } of routes) {
      if (!aliveAt(player, t)) continue;
      const near = route.filter((point) => Math.abs(point.t - t) <= GRID_SECONDS / 2 + 0.01);
      if (!near.length) continue;
      samples += 1;
      if (near.some((point) => point.blue)) inBlue = true;
      if (near.some((point) => point.vehicle)) vehicle += 1;
    }
    return { inBlue, samples, vehicle };
  };

  const epochs: Array<{
    phase: number | null;
    start: number;
    zone: { x: number; y: number; r: number };
  }> = [];
  for (const point of story.circle) {
    if (!point.warn || (point.phase ?? 0) < 1) continue;
    const previous = epochs.at(-1);
    if (
      !previous ||
      Math.abs(previous.zone.x - point.warn.x) > 1 ||
      Math.abs(previous.zone.y - point.warn.y) > 1 ||
      Math.abs(previous.zone.r - point.warn.r) > 1
    )
      epochs.push({ phase: point.phase, start: point.t, zone: point.warn });
  }
  const horizon = story.squadOutAt ?? story.durationSeconds;
  const result: RotationEpoch[] = [];
  let totalVehicle = 0;
  let totalSamples = 0;
  for (let index = 0; index < epochs.length; index += 1) {
    const epoch = epochs[index]!;
    const end = Math.min(epochs[index + 1]?.start ?? story.durationSeconds, horizon);
    if (epoch.start >= horizon) break;
    const first = centroidAt(epoch.start);
    if (!first) continue;
    const outsideAtStart = Math.max(
      0,
      Math.hypot(first.x - epoch.zone.x, first.y - epoch.zone.y) - epoch.zone.r,
    );
    let enteredAfter: number | null = outsideAtStart === 0 ? 0 : null;
    // The wall starts to close at the first circle sample whose gas radius is smaller than the one before it.
    let shrinkAfter: number | null = null;
    let lastWall: number | null = null;
    for (const point of story.circle) {
      if (point.t < epoch.start || point.t >= end || !point.zone) continue;
      if (lastWall !== null && point.zone.r < lastWall - 1) {
        shrinkAfter = Math.round(point.t - epoch.start);
        break;
      }
      lastWall = point.zone.r;
    }
    let blueSeconds = 0;
    let distance = 0;
    let vehicle = 0;
    let samples = 0;
    let previous: { x: number; y: number } | null = null;
    for (let t = epoch.start; t < end; t += GRID_SECONDS) {
      const spot = centroidAt(t);
      if (!spot) continue;
      if (
        enteredAfter === null &&
        Math.hypot(spot.x - epoch.zone.x, spot.y - epoch.zone.y) <= epoch.zone.r
      )
        enteredAfter = Math.round(t - epoch.start);
      const flags = flagsAt(t);
      if (flags.inBlue) blueSeconds += GRID_SECONDS;
      vehicle += flags.vehicle;
      samples += flags.samples;
      if (previous) distance += Math.hypot(spot.x - previous.x, spot.y - previous.y);
      previous = spot;
    }
    totalVehicle += vehicle;
    totalSamples += samples;
    result.push({
      phase: epoch.phase,
      start: epoch.start,
      end,
      radius: Math.round(epoch.zone.r),
      outsideAtStart: Math.round(outsideAtStart),
      enteredAfter,
      shrinkAfter,
      margin: shrinkAfter !== null && enteredAfter !== null ? shrinkAfter - enteredAfter : null,
      blueSeconds,
      blueDamage: Math.round(
        blueDamage
          .filter((item) => item.t >= epoch.start && item.t < end)
          .reduce((sum, item) => sum + item.amount, 0),
      ),
      distance: Math.round(distance),
      vehicleShare: samples ? vehicle / samples : null,
    });
  }
  const checked = result.filter((item) => (item.phase ?? 0) >= 3 && item.end - item.start >= 30);
  const landing = story.players
    .map((player) => player.landing?.t)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)[0];
  const firstFight = story.fights[0];
  return {
    epochs: result,
    blueSeconds: result.reduce((sum, item) => sum + item.blueSeconds, 0),
    blueDamage: Math.round(
      blueDamage.filter((item) => item.t <= horizon).reduce((sum, item) => sum + item.amount, 0),
    ),
    distance: result.reduce((sum, item) => sum + item.distance, 0),
    vehicleShare: totalSamples ? totalVehicle / totalSamples : null,
    landingToFight:
      landing !== undefined && firstFight
        ? Math.max(0, Math.round(firstFight.start - landing))
        : null,
    lateEntries: checked.filter(isLate).length,
    circlesChecked: checked.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Across matches

export interface DownSummary {
  matches: number;
  downs: number;
  byCause: Array<{
    cause: DownCause;
    label: string;
    advice: string;
    count: number;
    share: number;
    died: number;
  }>;
  alone: RateEstimate;
  /** Downs from which the member was brought back. */
  revived: RateEstimate;
  noReturnFire: RateEstimate;
  byMember: Array<{
    member: string;
    downs: number;
    causes: Array<{ cause: DownCause; count: number }>;
  }>;
  byStage: Array<{ stage: 'early' | 'mid' | 'late'; downs: number; noReturnFire: number }>;
  insights: string[];
}

export function summarizeDowns(
  items: ReadonlyArray<{ downs: StoryDown[] }>,
  names: ReadonlyMap<string, string>,
): DownSummary {
  const all = items.flatMap((item) => item.downs);
  const counts = new Map<DownCause, { count: number; died: number }>();
  for (const down of all) {
    const entry = counts.get(down.cause) ?? { count: 0, died: 0 };
    entry.count += 1;
    if (down.outcome === 'died') entry.died += 1;
    counts.set(down.cause, entry);
  }
  const known = all.filter((down) => down.alone !== null);
  const decided = all.filter((down) => down.outcome !== 'unknown');
  const playerDowns = all.filter(
    (down) => down.cause !== 'environment' && down.cause !== 'bluezone',
  );
  const members = new Map<string, Map<DownCause, number>>();
  for (const down of all) {
    const bucket = members.get(down.member) ?? new Map<DownCause, number>();
    bucket.set(down.cause, (bucket.get(down.cause) ?? 0) + 1);
    members.set(down.member, bucket);
  }
  const stageOf = (phase: number | null) =>
    (phase === null || phase < 3 ? 'early' : phase < 5 ? 'mid' : 'late') as
      'early' | 'mid' | 'late';
  const byStage = (['early', 'mid', 'late'] as const).map((stage) => {
    const group = playerDowns.filter((down) => stageOf(down.phase) === stage);
    return {
      stage,
      downs: group.length,
      noReturnFire: group.filter((down) => down.returnDamage === 0).length,
    };
  });
  const byCause = DOWN_CAUSES.map((cause) => ({
    cause: cause.key,
    label: cause.label,
    advice: cause.advice,
    count: counts.get(cause.key)?.count ?? 0,
    share: all.length ? (counts.get(cause.key)?.count ?? 0) / all.length : 0,
    died: counts.get(cause.key)?.died ?? 0,
  }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count);

  const insights: string[] = [];
  if (all.length >= 20) {
    const noReturn = playerDowns.filter((down) => down.returnDamage === 0);
    if (playerDowns.length >= 15)
      insights.push(
        `被玩家击倒的 ${playerDowns.length} 次里，${((noReturn.length / playerDowns.length) * 100).toFixed(0)}% 在倒地前 ${DOWN_LOOKBACK_SECONDS} 秒内没有任何还手——大多数倒地发生在先手被打的一刻，而不是对枪输了。`,
      );
    const top = byCause[0];
    if (top && top.share >= 0.25)
      insights.push(
        `最常见的倒地原因是「${top.label}」（${(top.share * 100).toFixed(0)}%）。${top.advice}`,
      );
    const aloneKnown = known.filter(
      (down) => down.cause !== 'environment' && down.cause !== 'bluezone',
    );
    const alone = aloneKnown.filter((down) => down.alone === true);
    if (aloneKnown.length >= 15 && alone.length / aloneKnown.length >= 0.2)
      insights.push(
        `${((alone.length / aloneKnown.length) * 100).toFixed(0)}% 的倒地发生时身边 ${DOWN_ALONE_METERS} 米内没有队友，落单是明显的风险。`,
      );
    if (decided.length >= 15) {
      const revived = decided.filter((down) => down.outcome === 'revived').length;
      insights.push(
        `倒地后 ${((revived / decided.length) * 100).toFixed(0)}% 被救起，其余被淘汰。`,
      );
    }
    const alonePlayers = [...members.entries()]
      .map(([member, bucket]) => ({
        member,
        total: [...bucket.values()].reduce((sum, value) => sum + value, 0),
        isolated: bucket.get('isolated') ?? 0,
      }))
      .filter((entry) => entry.total >= 10 && entry.isolated / entry.total >= 0.25);
    for (const entry of alonePlayers)
      insights.push(
        `${names.get(entry.member) ?? '某队员'} 有 ${((entry.isolated / entry.total) * 100).toFixed(0)}% 的倒地是落单造成的。`,
      );
  }
  return {
    matches: items.length,
    downs: all.length,
    byCause,
    alone: wilsonInterval(known.filter((down) => down.alone === true).length, known.length),
    revived: wilsonInterval(
      decided.filter((down) => down.outcome === 'revived').length,
      decided.length,
    ),
    noReturnFire: wilsonInterval(
      playerDowns.filter((down) => down.returnDamage === 0).length,
      playerDowns.length,
    ),
    byMember: [...members.entries()]
      .map(([member, bucket]) => ({
        member,
        downs: [...bucket.values()].reduce((sum, value) => sum + value, 0),
        causes: [...bucket.entries()]
          .map(([cause, count]) => ({ cause, count }))
          .sort((left, right) => right.count - left.count),
      }))
      .sort((left, right) => right.downs - left.downs),
    byStage,
    insights,
  };
}

export interface RotationSummary {
  matches: number;
  /** Matches in which the squad took any damage from the circle. */
  bluePenaltyRate: RateEstimate;
  averageBlueDamage: number | null;
  averageBlueSeconds: number | null;
  averageDistanceKm: number | null;
  vehicleShare: number | null;
  averageLandingToFight: number | null;
  lateEntry: RateEstimate;
  /** Average seconds the squad was inside before the wall moved (negative = caught by it). */
  averageMargin: number | null;
  byPhase: Array<{
    phase: number;
    circles: number;
    lateRate: number | null;
    medianEnter: number | null;
    averageMargin: number | null;
    averageOutside: number | null;
    averageDistance: number | null;
  }>;
  insights: string[];
}

/**
 * Descriptive only. Comparing placement between matches with much and little gas damage would be misleading: a squad
 * that survives longer goes through more circles and so takes more gas, which makes the gas look good for placement.
 */
export function summarizeRotation(
  items: ReadonlyArray<{ rotation: MatchRotation }>,
): RotationSummary {
  const rotations = items.map((item) => item.rotation).filter((item) => item.epochs.length > 0);
  const avg = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };
  const phases = new Map<number, RotationEpoch[]>();
  for (const rotation of rotations)
    for (const epoch of rotation.epochs)
      if (epoch.phase !== null)
        phases.set(epoch.phase, [...(phases.get(epoch.phase) ?? []), epoch]);
  const lateTotals = rotations.reduce(
    (sum, item) => ({
      late: sum.late + item.lateEntries,
      checked: sum.checked + item.circlesChecked,
    }),
    { late: 0, checked: 0 },
  );
  const blueHurt = rotations.filter((item) => item.blueDamage > 0).length;
  const summary: RotationSummary = {
    matches: rotations.length,
    bluePenaltyRate: wilsonInterval(blueHurt, rotations.length),
    averageBlueDamage: avg(rotations.map((item) => item.blueDamage)),
    averageBlueSeconds: avg(rotations.map((item) => item.blueSeconds)),
    averageDistanceKm: avg(rotations.map((item) => item.distance / 1000)),
    vehicleShare: avg(
      rotations.map((item) => item.vehicleShare).filter((value): value is number => value !== null),
    ),
    averageLandingToFight: avg(
      rotations
        .map((item) => item.landingToFight)
        .filter((value): value is number => value !== null),
    ),
    lateEntry: wilsonInterval(lateTotals.late, lateTotals.checked),
    averageMargin: avg(
      rotations.flatMap((item) =>
        item.epochs
          .filter((epoch) => (epoch.phase ?? 0) >= 3)
          .map((epoch) => epoch.margin)
          .filter((value): value is number => value !== null),
      ),
    ),
    byPhase: [...phases.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([phase, list]) => {
        const entered = list
          .map((item) => item.enteredAfter)
          .filter((value): value is number => value !== null);
        return {
          phase,
          circles: list.length,
          lateRate: list.length ? list.filter(isLate).length / list.length : null,
          medianEnter: median(entered),
          averageMargin: avg(
            list.map((item) => item.margin).filter((value): value is number => value !== null),
          ),
          averageOutside: avg(list.map((item) => item.outsideAtStart)),
          averageDistance: avg(list.map((item) => item.distance)),
        };
      }),
    insights: [],
  };
  if (rotations.length >= 20) {
    if (summary.lateEntry.rate !== null && summary.lateEntry.trials >= 40)
      summary.insights.push(
        `第 3 圈起，${(summary.lateEntry.rate * 100).toFixed(0)}% 的圈是在毒圈开始收缩之后才进到白圈里的（或始终没进去）；平均提前 ${Math.round(summary.averageMargin ?? 0)} 秒到位。`,
      );
    if (summary.bluePenaltyRate.rate !== null)
      summary.insights.push(
        `${(summary.bluePenaltyRate.rate * 100).toFixed(0)}% 的对局小队吃到过毒圈伤害，场均 ${(summary.averageBlueDamage ?? 0).toFixed(0)} 点。`,
      );
    const worst = summary.byPhase
      .filter((item) => item.circles >= 15 && item.lateRate !== null)
      .sort((left, right) => right.lateRate! - left.lateRate!)[0];
    if (worst && worst.lateRate! >= 0.3)
      summary.insights.push(
        `最容易转晚的是第 ${worst.phase} 圈：${(worst.lateRate! * 100).toFixed(0)}% 的对局在毒圈开始收缩时还没进到白圈。`,
      );
    if (summary.averageLandingToFight !== null)
      summary.insights.push(
        `落地后平均 ${Math.round(summary.averageLandingToFight)} 秒打响第一场交战。`,
      );
  }
  return summary;
}

export function downCauseLabel(cause: DownCause): string {
  return DOWN_CAUSES.find((item) => item.key === cause)?.label ?? cause;
}

export type { StoryEvent, StoryFight };
