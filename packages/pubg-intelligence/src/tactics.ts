import { createHash } from 'node:crypto';
import type { NormalizedMatch } from '@rine-kit/pubg-domain';
import {
  battlePlayerRef,
  battleTeamRef,
  type BattleGroup,
  type BattleEpisode,
  type BattleReconstructionResult,
  type BattleSourceEvent,
  type BattleTelemetryDocument,
} from './battle.js';

export const TACTICAL_ANALYSIS_SCHEMA_VERSION = 2 as const;
export const TACTICAL_RULE_VERSION = 'tactical-social-rules-v2' as const;
export const TACTICAL_FOLLOW_UP_WINDOW_SECONDS = 30;
export const TACTICAL_RESPONSE_WINDOW_SECONDS = 30;
export const TACTICAL_POSITION_BUCKET_SECONDS = 15;
export const TACTICAL_ISOLATION_DISTANCE_UNITS = 1_000;
export const TACTICAL_CIRCLE_WINDOW_SECONDS = 60;
export const TACTICAL_MOVEMENT_MAX_GAP_SECONDS = 30;
export const TACTICAL_PAIR_MIN_SHARED_MATCHES = 3;
export const TACTICAL_MAX_EVIDENCE_REFS = 8;

export type TacticalCategory = 'combat' | 'coordination' | 'social' | 'rotation';
export type TacticalCandidateStatus =
  'observed' | 'not_observed' | 'incomplete' | 'insufficient_data';
export type TacticalQualityGrade = 'high' | 'moderate' | 'low' | 'insufficient';

export interface TacticalEvidenceRef {
  matchId: string;
  eventId: string | null;
  timeSeconds: number | null;
  kind: string;
  actorRef?: string | null;
  victimRef?: string | null;
}

export interface TacticalMetric {
  numerator: number | null;
  denominator: number | null;
  sampleSize: number;
  value: number | null;
  unit: string;
}

export interface TacticalInsightCandidate {
  id: string;
  ruleId: string;
  ruleVersion: typeof TACTICAL_RULE_VERSION;
  category: TacticalCategory;
  title: string;
  status: TacticalCandidateStatus;
  statement: string;
  metric: TacticalMetric;
  supportEvents: TacticalEvidenceRef[];
  counterexamples: TacticalEvidenceRef[];
  quality: { grade: TacticalQualityGrade; reasons: string[] };
  assumptions: string[];
  pairRefs?: [string, string];
}

export interface TacticalPairObservation {
  pairRef: string;
  pairRefs: [string, string];
  matchId: string;
  eligible: boolean;
  sourceComplete: boolean;
  opportunityCount: number;
  sharedEngagementCount: number;
  supportEvents: TacticalEvidenceRef[];
  counterexamples: TacticalEvidenceRef[];
}

export interface TacticalMatchAnalysis {
  schemaVersion: typeof TACTICAL_ANALYSIS_SCHEMA_VERSION;
  ruleVersion: typeof TACTICAL_RULE_VERSION;
  matchId: string;
  candidates: TacticalInsightCandidate[];
  pairObservations: TacticalPairObservation[];
  diagnostics: {
    trackedPlayerCount: number;
    episodeCount: number;
    battleGroupCount: number;
    multiTeamBattleCount: number;
    advantageWindowCount: number;
    observedRosterOnlyBattleCount: number;
    positionEventCount: number;
    incompleteTeamEventCount: number;
    unknownTimestampEventCount: number;
    unmatchedBattleSourceCount: number;
  };
}

export interface AnalyzeTacticalMatchInput {
  match: NormalizedMatch;
  telemetry: BattleTelemetryDocument;
  reconstruction: BattleReconstructionResult;
  trackedPlayerIds: readonly string[];
}

interface PositionPoint {
  event: BattleSourceEvent;
  playerRef: string;
  teamId: string | null;
  bucket: number;
  x: number;
  y: number;
}

interface DistanceObservation {
  distance: number;
  refs: TacticalEvidenceRef[];
}

function digest(value: string, length = 20): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/** Squad-scoped pseudonymous ref for comparing the same roster across match files. */
export function tacticalPlayerRef(accountId: string): string {
  return `squad-player-${digest(`${TACTICAL_RULE_VERSION}\u001f${accountId}`, 16)}`;
}

function uniqueEvents(events: readonly BattleSourceEvent[]): BattleSourceEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.sourceEventId)) return false;
    seen.add(event.sourceEventId);
    return true;
  });
}

function eventRef(
  matchId: string,
  event: BattleSourceEvent | null | undefined,
  kind?: string,
): TacticalEvidenceRef | null {
  if (!event) return null;
  return {
    matchId,
    eventId: event.sourceEventId,
    timeSeconds: event.timeSeconds,
    kind: kind ?? event.type.toLowerCase(),
    actorRef: event.actorId ? tacticalPlayerRef(event.actorId) : null,
    victimRef: event.victimId ? tacticalPlayerRef(event.victimId) : null,
  };
}

function matchRef(matchId: string, kind: string): TacticalEvidenceRef {
  return { matchId, eventId: null, timeSeconds: null, kind };
}

function uniqueRefs(
  refs: readonly (TacticalEvidenceRef | null)[],
  limit = TACTICAL_MAX_EVIDENCE_REFS,
): TacticalEvidenceRef[] {
  const seen = new Set<string>();
  return refs
    .flatMap((ref) => {
      if (!ref) return [];
      const key = `${ref.matchId}\u001f${ref.eventId ?? ''}\u001f${ref.kind}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [ref];
    })
    .sort(
      (left, right) =>
        (left.timeSeconds ?? Number.POSITIVE_INFINITY) -
          (right.timeSeconds ?? Number.POSITIVE_INFINITY) ||
        left.matchId.localeCompare(right.matchId) ||
        (left.eventId ?? '').localeCompare(right.eventId ?? '') ||
        left.kind.localeCompare(right.kind),
    )
    .slice(0, limit);
}

function trackedEpisode(episode: BattleEpisode): boolean {
  return episode.teams.some((team) => team.tracked && team.teamRef !== null);
}

function episodeContactPlayers(episode: BattleEpisode): Set<string> {
  const players = new Set<string>();
  for (const event of episode.timeline) {
    if (event.type !== 'DAMAGE' && event.type !== 'KNOCK' && event.type !== 'KILL') continue;
    if (event.actorRef) players.add(event.actorRef);
    if (event.victimRef) players.add(event.victimRef);
  }
  return players;
}

function isContact(event: BattleSourceEvent): boolean {
  return event.type === 'DAMAGE' || event.type === 'KNOCK' || event.type === 'KILL';
}

function isEffective(event: BattleSourceEvent): boolean {
  return event.type === 'DAMAGE'
    ? event.hit && event.damage > 0
    : event.type === 'KNOCK' || event.type === 'KILL';
}

function gradeFor(
  sampleSize: number,
  denominator: number | null,
  complete: boolean,
): TacticalQualityGrade {
  if (denominator === null || denominator === 0 || sampleSize === 0) return 'insufficient';
  if (sampleSize >= 10 && complete) return 'high';
  if (sampleSize >= 4 && complete) return 'moderate';
  return 'low';
}

function makeCandidate(input: {
  matchId: string;
  ruleId: string;
  category: TacticalCategory;
  title: string;
  statement: string;
  numerator: number | null;
  denominator: number | null;
  sampleSize?: number;
  value?: number | null;
  unit?: string;
  support: readonly (TacticalEvidenceRef | null)[];
  counterexamples?: readonly (TacticalEvidenceRef | null)[];
  complete?: boolean;
  reasons?: string[] | undefined;
  assumptions?: string[];
  pairRefs?: [string, string];
  statusOverride?: TacticalCandidateStatus;
}): TacticalInsightCandidate {
  const sampleSize = input.sampleSize ?? input.denominator ?? 0;
  const complete = input.complete ?? true;
  const status: TacticalCandidateStatus =
    input.statusOverride ??
    (input.denominator === null
      ? 'insufficient_data'
      : !complete
        ? 'incomplete'
        : input.denominator === 0
          ? 'not_observed'
          : 'observed');
  const reasons = [...(input.reasons ?? [])];
  if (input.denominator === null && !reasons.length)
    reasons.push('缺少可识别的分母数据；未知不按 0 计。');
  else if (input.denominator === 0 && !reasons.length)
    reasons.push('当前快照中没有可评估的机会样本。');
  else if (!complete && !reasons.length) reasons.push('存在缺失/未知字段，结果只覆盖可识别子集。');
  const grade = gradeFor(sampleSize, input.denominator, complete);
  if (grade === 'high') reasons.push('样本量至少 10 且规则所需字段完整。');
  else if (grade === 'moderate') reasons.push('样本量为 4–9 且规则所需字段完整。');
  else if (grade === 'low') reasons.push('样本量为 1–3，或规则所需字段不完整。');
  else reasons.push('没有可评级的有效机会样本。');
  const pairRefs = input.pairRefs;
  const evidenceKey = input.support
    .filter((ref): ref is TacticalEvidenceRef => ref !== null)
    .map((ref) => `${ref.matchId}\u001f${ref.eventId ?? ''}\u001f${ref.kind}`)
    .sort()
    .join('\u001e');
  return {
    id: `insight-${digest(`${TACTICAL_ANALYSIS_SCHEMA_VERSION}\u001f${TACTICAL_RULE_VERSION}\u001f${input.matchId}\u001f${input.ruleId}\u001f${pairRefs?.join('\u001f') ?? ''}\u001f${evidenceKey}`)}`,
    ruleId: input.ruleId,
    ruleVersion: TACTICAL_RULE_VERSION,
    category: input.category,
    title: input.title,
    status,
    statement: input.statement,
    metric: {
      numerator: input.numerator,
      denominator: input.denominator,
      sampleSize,
      value:
        input.value === undefined
          ? input.denominator
            ? (input.numerator ?? 0) / input.denominator
            : null
          : input.value,
      unit: input.unit ?? 'count',
    },
    supportEvents: uniqueRefs(input.support),
    counterexamples: uniqueRefs(input.counterexamples ?? []),
    quality: { grade, reasons },
    assumptions: input.assumptions ?? [],
    ...(pairRefs ? { pairRefs } : {}),
  };
}

function pairId(left: string, right: string): { pairRef: string; pairRefs: [string, string] } {
  const pairRefs = [left, right].sort() as [string, string];
  return { pairRefs, pairRef: `pair-${digest(pairRefs.join('\u001f'), 16)}` };
}

function pointsByBucket(
  matchId: string,
  telemetry: BattleTelemetryDocument,
  trackedPlayerIds: ReadonlySet<string>,
): { points: PositionPoint[]; buckets: Map<number, PositionPoint[]> } {
  const selectedByPlayerBucket = new Map<string, PositionPoint>();
  for (const event of telemetry.events) {
    if (
      event.type !== 'POSITION' ||
      event.phase !== 'in_match' ||
      event.timeSeconds === null ||
      !event.actorId ||
      !trackedPlayerIds.has(event.actorId) ||
      !Number.isFinite(event.location?.x) ||
      !Number.isFinite(event.location?.y)
    )
      continue;
    const point: PositionPoint = {
      event,
      playerRef: battlePlayerRef(matchId, event.actorId),
      teamId: event.actorTeamId,
      bucket: Math.floor(event.timeSeconds / TACTICAL_POSITION_BUCKET_SECONDS),
      x: event.location!.x!,
      y: event.location!.y!,
    };
    const key = `${point.bucket}\u001f${point.playerRef}`;
    const previous = selectedByPlayerBucket.get(key);
    if (!previous || event.timeSeconds < previous.event.timeSeconds!)
      selectedByPlayerBucket.set(key, point);
  }
  const points = [...selectedByPlayerBucket.values()].sort(
    (left, right) =>
      left.bucket - right.bucket ||
      left.playerRef.localeCompare(right.playerRef) ||
      left.event.sourceEventId.localeCompare(right.event.sourceEventId),
  );
  const buckets = new Map<number, PositionPoint[]>();
  for (const point of points)
    buckets.set(point.bucket, [...(buckets.get(point.bucket) ?? []), point]);
  return { points, buckets };
}

function pairDistances(points: readonly PositionPoint[], matchId: string): DistanceObservation[] {
  const sorted = [...points].sort((left, right) => left.playerRef.localeCompare(right.playerRef));
  const distances: DistanceObservation[] = [];
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const left = sorted[leftIndex]!;
      const right = sorted[rightIndex]!;
      if (!left.teamId || left.teamId !== right.teamId) continue;
      const distance = Math.hypot(left.x - right.x, left.y - right.y);
      if (!Number.isFinite(distance)) continue;
      distances.push({
        distance,
        refs: [
          eventRef(matchId, left.event, 'sampled-position'),
          eventRef(matchId, right.event, 'sampled-position'),
        ].filter((ref): ref is TacticalEvidenceRef => ref !== null),
      });
    }
  }
  return distances;
}

function engagementAnchor(
  episode: BattleEpisode,
  eventById: ReadonlyMap<string, BattleSourceEvent>,
): BattleSourceEvent | null {
  const ordered = [...episode.timeline].sort(
    (left, right) =>
      left.timeSeconds - right.timeSeconds || left.sourceEventId.localeCompare(right.sourceEventId),
  );
  return (
    ordered
      .map((item) => eventById.get(item.sourceEventId))
      .find((event): event is BattleSourceEvent => Boolean(event)) ?? null
  );
}

function analyzeFirstKnocks(
  matchId: string,
  episodes: readonly BattleEpisode[],
  trackedPlayerRefs: ReadonlySet<string>,
  eventById: ReadonlyMap<string, BattleSourceEvent>,
  trackedTeamRefs: ReadonlySet<string>,
): TacticalInsightCandidate {
  const trackedEpisodes = episodes.filter((episode) => trackedEpisode(episode));
  const identifiable = trackedEpisodes.flatMap((episode) => {
    if (!episode.firstKnock) return [];
    const source = eventById.get(episode.firstKnock.sourceEventId);
    const actorTeamRef = source?.actorTeamId ? battleTeamRef(matchId, source.actorTeamId) : null;
    const knownAttacker = episode.firstKnock.attackerRef !== null || actorTeamRef !== null;
    if (!knownAttacker) return [];
    return [
      {
        episode,
        source,
        isTracked: Boolean(
          (episode.firstKnock.attackerRef &&
            trackedPlayerRefs.has(episode.firstKnock.attackerRef)) ||
          (actorTeamRef && trackedTeamRefs.has(actorTeamRef)),
        ),
      },
    ];
  });
  const numerator = identifiable.filter((item) => item.isTracked).length;
  const unmatched = trackedEpisodes.filter(
    (episode) =>
      episode.firstKnock &&
      !episode.firstKnock.attackerRef &&
      !eventById.get(episode.firstKnock.sourceEventId)?.actorTeamId,
  ).length;
  return makeCandidate({
    matchId,
    ruleId: 'combat.first-knock-share',
    category: 'combat',
    title: '当前小队首个 knock',
    statement: `在 ${identifiable.length} 个攻击者可识别的当前小队交战中，当前小队先 knock ${numerator} 次。`,
    numerator,
    denominator: identifiable.length,
    support: identifiable
      .filter((item) => item.isTracked)
      .map((item) => eventRef(matchId, item.source, 'first-knock')),
    counterexamples: identifiable
      .filter((item) => !item.isTracked)
      .map((item) => eventRef(matchId, item.source, 'opponent-first-knock')),
    complete: unmatched === 0,
    reasons: unmatched
      ? [`另有 ${unmatched} 个首个 knock 缺少可识别攻击者，未计入分母。`]
      : undefined,
    assumptions: [
      '只统计 R1 重建且首个 knock 攻击者可归属到当前小队或对手的交战；无 knock 的交战不在分母。',
    ],
  });
}

function analyzeBattleDynamics(
  matchId: string,
  battles: readonly BattleGroup[],
  events: readonly BattleSourceEvent[],
  trackedTeamIds: ReadonlySet<string>,
): TacticalInsightCandidate[] {
  const trackedRefs = new Set([...trackedTeamIds].map((teamId) => battleTeamRef(matchId, teamId)));
  const relevant = battles.filter((battle) =>
    battle.teamRefs.some((teamRef) => trackedRefs.has(teamRef)),
  );
  const eventById = new Map(events.map((event) => [event.sourceEventId, event]));
  const firstKnockWindows = relevant.flatMap((battle) => {
    const window = battle.firstKnockAdvantage;
    if (!window) return [];
    return [{ battle, window }];
  });
  const advantageChanges = relevant.flatMap((battle) =>
    battle.advantageChanges.map((change) => ({ battle, change })),
  );
  const reversals = advantageChanges.filter(({ change }) => change.classification === 'reversed');
  const reversalOpportunityCount = advantageChanges.filter(
    ({ change }) => change.previousLeadTeamRef !== null,
  ).length;
  const responseOpportunities = relevant.flatMap((battle) => {
    const first = battle.postKnockResponse.firstKnockEventId
      ? eventById.get(battle.postKnockResponse.firstKnockEventId)
      : undefined;
    if (!first?.actorTeamId || !trackedTeamIds.has(first.actorTeamId)) return [];
    return [
      {
        battle,
        first,
        response: battle.postKnockResponse.responseEventId
          ? eventById.get(battle.postKnockResponse.responseEventId)
          : undefined,
      },
    ];
  });
  const thirdParty = relevant.flatMap((battle) =>
    battle.possibleThirdParty.map((candidate) => ({ battle, candidate })),
  );
  const thirdPartyGroups = relevant.filter((battle) => battle.possibleThirdParty.length > 0);
  const thirdPartyOpportunities = relevant.filter((battle) => battle.teamRefs.length >= 3);
  const firstKnockCandidate = makeCandidate({
    matchId,
    ruleId: 'combat.first-knock-observed-advantage-duration',
    category: 'combat',
    title: '首个 knock 后的观测减员差持续时间',
    statement: firstKnockWindows.length
      ? `${firstKnockWindows.length} 个当前小队相关 battle group 有可计算的首个 knock 观测差；平均持续 ${mean(firstKnockWindows.map((item) => item.window.durationSeconds)).toFixed(1)} 秒。`
      : '没有同时具备首个 knock、双方队伍引用和后续状态证据的 battle group。',
    numerator: firstKnockWindows.length
      ? sum(firstKnockWindows.map((item) => item.window.durationSeconds))
      : null,
    denominator: firstKnockWindows.length || null,
    sampleSize: firstKnockWindows.length,
    value: firstKnockWindows.length
      ? mean(firstKnockWindows.map((item) => item.window.durationSeconds))
      : null,
    unit: '秒 / 首个 knock 观测窗口',
    support: firstKnockWindows.flatMap(({ window }) =>
      window.evidenceEventIds.map((id) =>
        eventRef(matchId, eventById.get(id), 'observed-knock-advantage'),
      ),
    ),
    counterexamples: firstKnockWindows
      .filter(({ window }) => window.durationSeconds === 0)
      .flatMap(({ window }) =>
        window.evidenceEventIds.map((id) =>
          eventRef(matchId, eventById.get(id), 'immediate-equalization'),
        ),
      ),
    complete: false,
    statusOverride: firstKnockWindows.length ? 'incomplete' : 'insufficient_data',
    reasons: [
      '只统计当前事件中可确认的击倒/救援状态；敌队完整名单与全员状态未知，不表示整队人数优势。',
    ],
    assumptions: [
      '优势持续时间描述的是双方已观测成员的 knock 状态差，平局或反向时结束；当前 group 结束仍未平局时按最后交战秒数截断。',
    ],
  });
  const reversalCandidate = makeCandidate({
    matchId,
    ruleId: 'combat.observed-knock-advantage-reversal',
    category: 'combat',
    title: '观测 knock 平衡反转',
    statement: `${reversals.length}/${reversalOpportunityCount} 个当前小队相关 knock 优势窗口，在另一侧已观测击倒数更低时发生反转；这不是整队战力判断。`,
    numerator: reversals.length,
    denominator: reversalOpportunityCount,
    sampleSize: advantageChanges.length,
    support: reversals.map(({ change }) =>
      eventRef(matchId, eventById.get(change.sourceEventId), 'observed-knock-balance-reversal'),
    ),
    counterexamples: advantageChanges
      .filter(({ change }) => change.classification === 'equalized')
      .map(({ change }) =>
        eventRef(matchId, eventById.get(change.sourceEventId), 'observed-knock-balance-equalized'),
      ),
    complete: false,
    statusOverride: advantageChanges.length ? 'incomplete' : 'insufficient_data',
    reasons: ['成员范围只覆盖本场交战中被遥测明确观测到的玩家；未观测成员不按存活或淘汰计算。'],
    assumptions: [
      'KNOCK/KILL 使该名观察成员计为被击倒或淘汰；REVIVE 清除击倒标记；每名成员只计一次。',
    ],
  });
  const responseCandidate = makeCandidate({
    matchId,
    ruleId: 'combat.subsequent-contact-after-first-knock',
    category: 'combat',
    title: '首个 knock 后继续有效接触',
    statement: `${responseOpportunities.filter((item) => item.response).length}/${responseOpportunities.length} 个当前小队先 knock 的 battle group，在 30 秒内对同一对手队观察到有效命中、击倒或淘汰。`,
    numerator: responseOpportunities.filter((item) => item.response).length,
    denominator: responseOpportunities.length,
    sampleSize: responseOpportunities.length,
    support: responseOpportunities
      .filter((item) => item.response)
      .flatMap((item) => [
        eventRef(matchId, item.first, 'first-knock'),
        eventRef(matchId, item.response, 'subsequent-effective-contact'),
      ]),
    counterexamples: responseOpportunities
      .filter((item) => !item.response)
      .map((item) => eventRef(matchId, item.first, 'no-subsequent-effective-contact-in-window')),
    complete:
      responseOpportunities.length > 0 &&
      responseOpportunities.every((item) => item.battle.postKnockResponse.status !== 'incomplete'),
    reasons: responseOpportunities.length
      ? undefined
      : ['当前小队没有队伍归属明确的首个 knock 作为响应机会。'],
    assumptions: [
      '响应须在首个 knock 后 30 秒内由同一攻击队对同一受击队产生有效 DAMAGE、KNOCK 或 KILL；不推断战术意图。',
    ],
  });
  const thirdPartyCandidate = makeCandidate({
    matchId,
    ruleId: 'combat.possible-third-party-contact',
    category: 'combat',
    title: '重叠交战中的可能第三队接触',
    statement: `${thirdPartyGroups.length}/${thirdPartyOpportunities.length} 个当前小队相关多队 battle group 同时出现第三队接触证据；这只标记时间重叠，不证明第三方意图或因果。`,
    numerator: thirdPartyGroups.length,
    denominator: thirdPartyOpportunities.length,
    sampleSize: thirdPartyOpportunities.length,
    support: thirdParty.flatMap(({ candidate }) =>
      candidate.evidenceEventIds.map((id) =>
        eventRef(matchId, eventById.get(id), 'overlapping-third-team-contact'),
      ),
    ),
    counterexamples: relevant
      .filter((battle) => battle.teamRefs.length === 2)
      .flatMap((battle) =>
        battle.bridgeEvidenceEventIds.map((id) =>
          eventRef(matchId, eventById.get(id), 'two-team-overlap'),
        ),
      ),
    complete: relevant.length > 0,
    ...(relevant.length ? {} : { statusOverride: 'insufficient_data' as const }),
    reasons: relevant.length ? undefined : ['没有当前小队参与且队伍关联可识别的 battle group。'],
    assumptions: [
      '仅在 pair episode 时间相交、共享已知队伍引用且各自有接触事件时成组；第三队标签是可能介入，不推断战术行为。',
    ],
  });
  return [firstKnockCandidate, reversalCandidate, responseCandidate, thirdPartyCandidate];
}

function analyzeFollowUps(
  matchId: string,
  episodes: readonly BattleEpisode[],
  events: readonly BattleSourceEvent[],
  trackedPlayerRefs: ReadonlySet<string>,
  trackedPlayerIds: ReadonlySet<string>,
  trackedTeamIds: ReadonlySet<string>,
  eventById: ReadonlyMap<string, BattleSourceEvent>,
): TacticalInsightCandidate {
  const opportunities = episodes.flatMap((episode) => {
    if (!trackedEpisode(episode) || !episode.firstKnock) return [];
    const firstEvent = eventById.get(episode.firstKnock.sourceEventId);
    const trackedFirstKnock = Boolean(
      (episode.firstKnock.attackerRef && trackedPlayerRefs.has(episode.firstKnock.attackerRef)) ||
      (firstEvent?.actorTeamId && trackedTeamIds.has(firstEvent.actorTeamId)),
    );
    if (!trackedFirstKnock || !firstEvent?.victimTeamId) return [];
    const follow = events
      .filter(
        (event) =>
          event.timeSeconds !== null &&
          event.timeSeconds > episode.firstKnock!.timeSeconds &&
          event.timeSeconds <=
            episode.firstKnock!.timeSeconds + TACTICAL_FOLLOW_UP_WINDOW_SECONDS &&
          event.victimTeamId === firstEvent.victimTeamId &&
          ((event.actorId && trackedPlayerIds.has(event.actorId)) ||
            (event.actorTeamId && trackedTeamIds.has(event.actorTeamId))) &&
          (event.type === 'DAMAGE'
            ? event.hit && event.damage > 0
            : event.type === 'KNOCK' || event.type === 'KILL'),
      )
      .sort(
        (left, right) =>
          left.timeSeconds! - right.timeSeconds! ||
          left.sourceEventId.localeCompare(right.sourceEventId),
      );
    return [{ episode, follow }];
  });
  const confirmed = opportunities.filter((item) => item.follow.length > 0);
  const support = confirmed.flatMap((item) => [
    item.episode.firstKnock
      ? eventRef(matchId, eventById.get(item.episode.firstKnock.sourceEventId), 'first-knock')
      : null,
    item.follow[0] ? eventRef(matchId, item.follow[0], 'follow-up-hit') : null,
  ]);
  const counterexamples = opportunities
    .filter((item) => !item.follow.length)
    .map((item) =>
      item.episode.firstKnock
        ? eventRef(
            matchId,
            eventById.get(item.episode.firstKnock.sourceEventId),
            'no-follow-up-within-window',
          )
        : null,
    );
  return makeCandidate({
    matchId,
    ruleId: 'combat.follow-up-hit-window',
    category: 'combat',
    title: '首个 knock 后跟进命中',
    statement: `${confirmed.length}/${opportunities.length} 个当前小队首个 knock 在 ${TACTICAL_FOLLOW_UP_WINDOW_SECONDS} 秒内有后续有效伤害、knock 或 kill 事件。`,
    numerator: confirmed.length,
    denominator: opportunities.length,
    support,
    counterexamples,
    assumptions: [
      `窗口为 ${TACTICAL_FOLLOW_UP_WINDOW_SECONDS} 秒；同一交战内只检查当前小队后续事件，不把 knock 本身重复算作命中。`,
    ],
  });
}

function analyzeAdvantageConversion(
  matchId: string,
  episodes: readonly BattleEpisode[],
  trackedPlayerRefs: ReadonlySet<string>,
): TacticalInsightCandidate {
  const trackedChains = episodes.filter(trackedEpisode).flatMap((episode) =>
    episode.knockChains
      .filter((chain) => episode.firstKnock?.sourceEventId === chain.knockEventId)
      .filter((chain) => chain.attackerRef !== null && trackedPlayerRefs.has(chain.attackerRef))
      .map((chain) => ({ episode, chain })),
  );
  const resolved = trackedChains.filter(
    (item) => item.chain.outcome === 'KILL' || item.chain.outcome === 'REVIVE',
  );
  const kills = resolved.filter((item) => item.chain.outcome === 'KILL');
  const revives = resolved.filter((item) => item.chain.outcome === 'REVIVE');
  const support = kills.flatMap(({ chain }) => [
    {
      matchId,
      eventId: chain.knockEventId,
      timeSeconds: chain.knockAtSeconds,
      kind: 'tracked-first-knock',
    },
    chain.outcomeEventId
      ? {
          matchId,
          eventId: chain.outcomeEventId,
          timeSeconds: chain.outcomeAtSeconds,
          kind: 'kill-conversion',
        }
      : null,
  ]);
  const counterexamples = revives.flatMap(({ chain }) => [
    {
      matchId,
      eventId: chain.knockEventId,
      timeSeconds: chain.knockAtSeconds,
      kind: 'tracked-knock',
    },
    chain.outcomeEventId
      ? {
          matchId,
          eventId: chain.outcomeEventId,
          timeSeconds: chain.outcomeAtSeconds,
          kind: 'revive-before-confirmation',
        }
      : null,
  ]);
  const unresolved = trackedChains.length - resolved.length;
  return makeCandidate({
    matchId,
    ruleId: 'combat.knock-kill-conversion',
    category: 'combat',
    title: '首个 knock → kill 转化（可识别样本）',
    statement: `${kills.length}/${resolved.length} 个有唯一观察结果的当前小队 knock 在窗口内转成 kill；另有 ${unresolved} 个结果未知或未唯一匹配。`,
    numerator: kills.length,
    denominator: resolved.length,
    support,
    counterexamples,
    complete: unresolved === 0,
    reasons: unresolved
      ? [`${unresolved} 个 knock 链未进入转化率分母；缺少结果不当作失败。`]
      : undefined,
    assumptions: [
      '只分析每个交战的首个 knock；仅把 R1 唯一关联的 KILL/REVIVE 纳入已知结果分母，这不是整场胜负转化率。',
    ],
  });
}

function analyzeDistances(
  matchId: string,
  match: NormalizedMatch,
  episodes: readonly BattleEpisode[],
  trackedPlayerIds: ReadonlySet<string>,
  buckets: ReadonlyMap<number, PositionPoint[]>,
  allPositionPoints: readonly PositionPoint[],
  eventById: ReadonlyMap<string, BattleSourceEvent>,
): {
  sampled: TacticalInsightCandidate;
  onset: TacticalInsightCandidate;
  isolation: TacticalInsightCandidate;
} {
  const rosterRefs = match.players
    .filter((player) => trackedPlayerIds.has(player.accountId))
    .map((player) => battlePlayerRef(matchId, player.accountId));
  const distances = [...buckets.values()]
    .flatMap((points) => pairDistances(points, matchId))
    .sort((left, right) => right.distance - left.distance);
  const sampledComplete = allPositionPoints.length > 0 && rosterRefs.length >= 2;
  const sampled = makeCandidate({
    matchId,
    ruleId: 'coordination.sampled-teammate-distance',
    category: 'coordination',
    title: '采样时刻队友间距',
    statement: distances.length
      ? `同一 ${TACTICAL_POSITION_BUCKET_SECONDS} 秒采样桶内，共有 ${distances.length} 个队友位置对；平均平面间距 ${mean(distances.map((item) => item.distance)).toFixed(1)} 遥测坐标单位。`
      : '没有足够的同步队友位置样本计算间距。',
    numerator: distances.length ? sum(distances.map((item) => item.distance)) : null,
    denominator: distances.length ? distances.length : sampledComplete ? 0 : null,
    sampleSize: distances.length,
    value: distances.length ? mean(distances.map((item) => item.distance)) : null,
    unit: '遥测坐标单位 / 队友位置对',
    support: distances.slice(0, TACTICAL_MAX_EVIDENCE_REFS).flatMap((item) => item.refs),
    counterexamples: [...distances]
      .reverse()
      .slice(0, TACTICAL_MAX_EVIDENCE_REFS)
      .flatMap((item) => item.refs),
    complete: sampledComplete && distances.length > 0,
    reasons: !allPositionPoints.length
      ? ['该比赛没有带可用时间和 X/Y 坐标的当前小队 POSITION 事件。']
      : rosterRefs.length < 2
        ? ['当前比赛内可验证的本队队员少于 2 位。']
        : !distances.length
          ? ['存在位置事件，但没有至少两名队员落在同一 15 秒采样桶。']
          : undefined,
    assumptions: [
      '每位队员每 15 秒桶保留最早的有效位置事件；只计算 X/Y 平面欧氏距离，不推断视野。',
    ],
  });

  const onsetObservations = episodes.filter(trackedEpisode).flatMap((episode) => {
    const onset = engagementAnchor(episode, eventById);
    const sameBucket =
      buckets.get(Math.floor(episode.startSeconds / TACTICAL_POSITION_BUCKET_SECONDS)) ?? [];
    const pairValues = pairDistances(sameBucket, matchId);
    if (!pairValues.length) return [];
    return [{ episode, onset, pairs: pairValues }];
  });
  const onsetDistances = onsetObservations.flatMap((item) => item.pairs);
  const onsetValue = onsetDistances.length
    ? mean(onsetDistances.map((item) => item.distance))
    : null;
  const onset = makeCandidate({
    matchId,
    ruleId: 'coordination.combat-onset-separation',
    category: 'coordination',
    title: '开战时队友分离度',
    statement:
      onsetValue === null
        ? '没有交战起始时刻对齐的同步队友位置样本。'
        : `${onsetObservations.length}/${episodes.filter(trackedEpisode).length} 个当前小队交战有起始桶位置；样本平均平面间距 ${onsetValue.toFixed(1)} 坐标单位。`,
    numerator: onsetDistances.length ? sum(onsetDistances.map((item) => item.distance)) : null,
    denominator: onsetDistances.length ? onsetDistances.length : null,
    sampleSize: onsetDistances.length,
    value: onsetValue,
    unit: '遥测坐标单位 / 同步队友位置对',
    support: onsetObservations
      .slice(0, TACTICAL_MAX_EVIDENCE_REFS)
      .flatMap((item) => [
        eventRef(matchId, item.onset, 'engagement-onset'),
        ...item.pairs.flatMap((pair) => pair.refs),
      ]),
    counterexamples: [...onsetObservations]
      .reverse()
      .slice(0, TACTICAL_MAX_EVIDENCE_REFS)
      .flatMap((item) =>
        item.pairs
          .filter((pair) => pair.distance <= TACTICAL_ISOLATION_DISTANCE_UNITS)
          .flatMap((pair) => pair.refs),
      ),
    complete:
      onsetDistances.length > 0 &&
      onsetObservations.length === episodes.filter(trackedEpisode).length,
    reasons:
      onsetObservations.length < episodes.filter(trackedEpisode).length
        ? [
            `${episodes.filter(trackedEpisode).length - onsetObservations.length} 个当前小队交战没有足够的起始桶同步位置。`,
          ]
        : undefined,
    assumptions: [
      `使用 floor(交战起始秒 / ${TACTICAL_POSITION_BUCKET_SECONDS}) 的位置桶；只统计 X/Y 距离，不推断视野或因果。`,
    ],
  });

  const isolationRows = episodes.filter(trackedEpisode).flatMap((episode) => {
    const allTeamMembers = (
      buckets.get(Math.floor(episode.startSeconds / TACTICAL_POSITION_BUCKET_SECONDS)) ?? []
    ).filter((point) => rosterRefs.includes(point.playerRef));
    const contactPlayers = episodeContactPlayers(episode);
    const engagedRefs = rosterRefs.filter((ref) => contactPlayers.has(ref));
    const engagedTeamIds = new Set(
      allTeamMembers
        .filter((point) => engagedRefs.includes(point.playerRef))
        .map((point) => point.teamId)
        .filter((id): id is string => Boolean(id)),
    );
    if (engagedTeamIds.size !== 1) return [];
    const teamMembers = allTeamMembers.filter(
      (point) => point.teamId && engagedTeamIds.has(point.teamId),
    );
    if (teamMembers.length < 2) return [];
    const engaged = engagedRefs;
    if (!engaged.length) return [];
    const anchor = engagementAnchor(episode, eventById);
    if (engaged.length !== 1)
      return [
        {
          isolated: false,
          refs: [
            eventRef(matchId, anchor, 'multi-member-engagement'),
            ...teamMembers.map((point) => eventRef(matchId, point.event, 'sampled-position')),
          ],
        },
      ];
    const engagedPoint = teamMembers.find((point) => point.playerRef === engaged[0]);
    if (!engagedPoint) return [];
    const supportPoints = teamMembers.filter((point) => point.playerRef !== engagedPoint.playerRef);
    if (!supportPoints.length) return [];
    const minDistance = Math.min(
      ...supportPoints.map((point) =>
        Math.hypot(engagedPoint.x - point.x, engagedPoint.y - point.y),
      ),
    );
    return [
      {
        isolated: minDistance > TACTICAL_ISOLATION_DISTANCE_UNITS,
        refs: [
          eventRef(
            matchId,
            anchor,
            minDistance > TACTICAL_ISOLATION_DISTANCE_UNITS
              ? 'single-member-contact'
              : 'nearby-teammate-contact',
          ),
          eventRef(matchId, engagedPoint.event, 'engaged-player-position'),
          ...supportPoints.map((point) => eventRef(matchId, point.event, 'teammate-position')),
        ],
      },
    ];
  });
  const isolatedCount = isolationRows.filter((item) => item.isolated).length;
  const isolation = makeCandidate({
    matchId,
    ruleId: 'coordination.sampled-isolation-candidate',
    category: 'coordination',
    title: '采样分离的单人交战候选',
    statement: `${isolatedCount}/${isolationRows.length} 个可比较交战仅有 1 位当前队员参与，且所有已采样队友距其超过 ${TACTICAL_ISOLATION_DISTANCE_UNITS} 坐标单位。`,
    numerator: isolatedCount,
    denominator: isolationRows.length,
    support: isolationRows.filter((item) => item.isolated).flatMap((item) => item.refs),
    counterexamples: isolationRows.filter((item) => !item.isolated).flatMap((item) => item.refs),
    complete: isolationRows.length > 0,
    reasons: isolationRows.length
      ? undefined
      : ['没有同时观测至少两名队员、且当前队员参与的交战起始采样。'],
    assumptions: [
      `“分离”仅指起始 15 秒桶中单人参与且与所有其他已采样队友相距 >${TACTICAL_ISOLATION_DISTANCE_UNITS} 坐标单位；不推断视野、通信或支援意图。`,
    ],
  });
  return { sampled, onset, isolation };
}

function analyzeResponseWindows(
  matchId: string,
  events: readonly BattleSourceEvent[],
  trackedPlayerIds: ReadonlySet<string>,
  trackedTeamIds: ReadonlySet<string>,
): TacticalInsightCandidate {
  const incomingKnocks = events.filter(
    (event) =>
      event.type === 'KNOCK' &&
      event.phase === 'in_match' &&
      event.timeSeconds !== null &&
      event.actorTeamId &&
      event.victimTeamId &&
      trackedTeamIds.has(event.victimTeamId) &&
      !trackedTeamIds.has(event.actorTeamId) &&
      event.victimId &&
      trackedPlayerIds.has(event.victimId),
  );
  const incompleteKnocks = events.filter(
    (event) =>
      event.type === 'KNOCK' &&
      event.phase === 'in_match' &&
      event.victimId &&
      trackedPlayerIds.has(event.victimId) &&
      (event.timeSeconds === null || !event.actorTeamId || !event.victimTeamId),
  );
  const observations = incomingKnocks.map((knock) => {
    const response = events
      .filter(
        (event) =>
          isContact(event) &&
          event.phase === 'in_match' &&
          event.timeSeconds !== null &&
          event.timeSeconds >= knock.timeSeconds! &&
          event.timeSeconds <= knock.timeSeconds! + TACTICAL_RESPONSE_WINDOW_SECONDS &&
          event.actorId &&
          trackedPlayerIds.has(event.actorId) &&
          event.actorId !== knock.victimId &&
          event.actorTeamId &&
          trackedTeamIds.has(event.actorTeamId) &&
          event.victimTeamId === knock.actorTeamId &&
          isEffective(event),
      )
      .sort(
        (left, right) =>
          left.timeSeconds! - right.timeSeconds! ||
          left.sourceEventId.localeCompare(right.sourceEventId),
      );
    return { knock, response: response[0] ?? null };
  });
  const answered = observations.filter((item) => item.response);
  const intervals = answered.map((item) => item.response!.timeSeconds! - item.knock.timeSeconds!);
  return makeCandidate({
    matchId,
    ruleId: 'coordination.response-after-ally-knock',
    category: 'coordination',
    title: '队友被 knock 后的反应窗口',
    statement: `${answered.length}/${observations.length} 个对手 knock 到当前队员后，${TACTICAL_RESPONSE_WINDOW_SECONDS} 秒内观察到其他队员对同一对手队的有效反击${intervals.length ? `；已观察反应平均 ${mean(intervals).toFixed(1)} 秒` : ''}。`,
    numerator: answered.length,
    denominator: observations.length,
    sampleSize: observations.length,
    value: intervals.length ? mean(intervals) : null,
    unit: '已响应 / knock 机会；反应延迟为秒',
    support: answered.flatMap((item) => [
      eventRef(matchId, item.knock, 'ally-knocked'),
      eventRef(matchId, item.response, 'teammate-response'),
    ]),
    counterexamples: observations
      .filter((item) => !item.response)
      .map((item) => eventRef(matchId, item.knock, 'no-response-observed-in-window')),
    complete: incompleteKnocks.length === 0,
    reasons: incompleteKnocks.length
      ? [`${incompleteKnocks.length} 条本队成员 knock 缺少时间或明确队伍归属，未作为已知响应机会。`]
      : undefined,
    assumptions: [
      `机会单位为对手有时间且队伍已知的每条本队成员 KNOCK；响应须由另一名当前队员在 ${TACTICAL_RESPONSE_WINDOW_SECONDS} 秒内对同一对手队产生有效 DAMAGE/KNOCK/KILL。`,
    ],
  });
}

function trackedTeamIdsFor(
  events: readonly BattleSourceEvent[],
  trackedPlayerIds: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  for (const event of events) {
    if (event.actorId && trackedPlayerIds.has(event.actorId) && event.actorTeamId)
      result.add(event.actorTeamId);
    if (event.victimId && trackedPlayerIds.has(event.victimId) && event.victimTeamId)
      result.add(event.victimTeamId);
  }
  return result;
}

function analyzeSocial(
  matchId: string,
  match: NormalizedMatch,
  events: readonly BattleSourceEvent[],
  episodes: readonly BattleEpisode[],
  trackedPlayerIds: ReadonlySet<string>,
  trackedTeamIds: ReadonlySet<string>,
  sourceComplete: boolean,
): {
  friendlyFire: TacticalInsightCandidate;
  rescue: TacticalInsightCandidate;
  pairs: TacticalInsightCandidate[];
  playful: TacticalInsightCandidate;
  observations: TacticalPairObservation[];
} {
  const teamDamage = events.filter(
    (event) =>
      event.type === 'DAMAGE' &&
      event.phase === 'in_match' &&
      event.actorId &&
      event.victimId &&
      event.actorId !== event.victimId &&
      trackedPlayerIds.has(event.actorId) &&
      trackedPlayerIds.has(event.victimId) &&
      event.actorTeamId &&
      event.actorTeamId === event.victimTeamId &&
      trackedTeamIds.has(event.actorTeamId),
  );
  const uncertainTeamDamage = events.filter(
    (event) =>
      event.type === 'DAMAGE' &&
      event.phase === 'in_match' &&
      event.actorId &&
      event.victimId &&
      event.actorId !== event.victimId &&
      trackedPlayerIds.has(event.actorId) &&
      trackedPlayerIds.has(event.victimId) &&
      (!event.actorTeamId || !event.victimTeamId || event.actorTeamId !== event.victimTeamId),
  );
  const positiveFriendlyDamage = teamDamage.filter((event) => event.hit && event.damage > 0);
  const friendlyFire = makeCandidate({
    matchId,
    ruleId: 'social.directed-friendly-damage',
    category: 'social',
    title: '定向友伤事件',
    statement: `${positiveFriendlyDamage.length} 条有正伤害数值的本队队员→队员 DAMAGE 事件（已识别同队 DAMAGE 记录 ${teamDamage.length} 条）。`,
    numerator: positiveFriendlyDamage.length,
    denominator: teamDamage.length,
    support: positiveFriendlyDamage.map((event) =>
      eventRef(matchId, event, 'directed-friendly-damage'),
    ),
    counterexamples: teamDamage
      .filter((event) => !(event.hit && event.damage > 0))
      .map((event) => eventRef(matchId, event, 'same-team-damage-without-positive-hit')),
    complete: teamDamage.length > 0 && uncertainTeamDamage.length === 0,
    reasons: [
      ...(!teamDamage.length
        ? ['未发现可识别的本队成员间 DAMAGE 记录；这不是“没有友伤”的结论。']
        : []),
      ...(uncertainTeamDamage.length
        ? [
            `另有 ${uncertainTeamDamage.length} 条本队成员间 DAMAGE 的队伍字段缺失或冲突，未计为友伤/反例。`,
          ]
        : []),
    ],
    assumptions: [
      '只有 actor/victim 都属于选中小队、同队 ID 明确且 damage>0/hit=true 的事件计为确认友伤；方向保留 actor → victim。',
    ],
  });

  const reviveEvents = events.filter(
    (event) =>
      event.type === 'REVIVE' &&
      event.phase === 'in_match' &&
      event.actorId &&
      event.victimId &&
      trackedPlayerIds.has(event.actorId) &&
      trackedPlayerIds.has(event.victimId) &&
      event.actorTeamId &&
      event.actorTeamId === event.victimTeamId &&
      trackedTeamIds.has(event.actorTeamId),
  );
  const allKnockedMembers = events.filter(
    (event) =>
      event.type === 'KNOCK' &&
      event.phase === 'in_match' &&
      event.victimId &&
      trackedPlayerIds.has(event.victimId) &&
      event.victimTeamId &&
      trackedTeamIds.has(event.victimTeamId),
  );
  const uncertainRescueEvents = events.filter(
    (event) =>
      (event.type === 'KNOCK' || event.type === 'REVIVE') &&
      event.phase === 'in_match' &&
      ((event.type === 'KNOCK' &&
        event.victimId &&
        trackedPlayerIds.has(event.victimId) &&
        (event.timeSeconds === null || !event.victimTeamId)) ||
        (event.type === 'REVIVE' &&
          event.actorId &&
          event.victimId &&
          trackedPlayerIds.has(event.actorId) &&
          trackedPlayerIds.has(event.victimId) &&
          (!event.actorTeamId || !event.victimTeamId || event.actorTeamId !== event.victimTeamId))),
  );
  const knockedMembers = allKnockedMembers.filter((event) => event.timeSeconds !== null);
  const matchedRescues: Array<{
    revive: BattleSourceEvent;
    knock: BattleSourceEvent;
    elapsed: number;
  }> = [];
  const usedKnocks = new Set<string>();
  for (const revive of [...reviveEvents].sort(
    (left, right) =>
      (left.timeSeconds ?? Number.POSITIVE_INFINITY) -
      (right.timeSeconds ?? Number.POSITIVE_INFINITY),
  )) {
    const knock = knockedMembers
      .filter(
        (candidate) =>
          !usedKnocks.has(candidate.sourceEventId) &&
          candidate.victimId === revive.victimId &&
          candidate.timeSeconds !== null &&
          revive.timeSeconds !== null &&
          candidate.timeSeconds <= revive.timeSeconds &&
          revive.timeSeconds - candidate.timeSeconds <= 120,
      )
      .sort(
        (left, right) =>
          right.timeSeconds! - left.timeSeconds! ||
          left.sourceEventId.localeCompare(right.sourceEventId),
      )[0];
    if (!knock) continue;
    usedKnocks.add(knock.sourceEventId);
    matchedRescues.push({ revive, knock, elapsed: revive.timeSeconds! - knock.timeSeconds! });
  }
  const rescue = makeCandidate({
    matchId,
    ruleId: 'social.directed-rescue',
    category: 'social',
    title: '队内救援',
    statement: `${matchedRescues.length} 条本队 REVIVE 能在 120 秒内与同一被救队员的 knock 对齐；观察到 ${reviveEvents.length} 条本队 REVIVE。`,
    numerator: matchedRescues.length,
    denominator: knockedMembers.length,
    support: matchedRescues.flatMap((item) => [
      eventRef(matchId, item.knock, 'knocked-teammate'),
      eventRef(matchId, item.revive, 'directed-rescue'),
    ]),
    counterexamples: knockedMembers
      .filter(
        (knock) => !matchedRescues.some((item) => item.knock.sourceEventId === knock.sourceEventId),
      )
      .map((event) => eventRef(matchId, event, 'no-matching-rescue-observed')),
    complete:
      knockedMembers.length > 0 &&
      knockedMembers.length === allKnockedMembers.length &&
      uncertainRescueEvents.length === 0,
    reasons: [
      ...(!allKnockedMembers.length ? ['当前队员 knock 事件没有可识别机会样本；救援率未知。'] : []),
      ...(knockedMembers.length < allKnockedMembers.length
        ? [
            `${allKnockedMembers.length - knockedMembers.length} 个队员 knock 缺少时间，未进入分母。`,
          ]
        : []),
      ...(uncertainRescueEvents.length
        ? [`${uncertainRescueEvents.length} 条队内救援/knock 记录有队伍归属缺失或冲突。`]
        : []),
    ],
    assumptions: [
      '救援机会为受 knock 的本队队员；救援只在 120 秒内同一 victim 的队内 REVIVE 事件存在时匹配。',
    ],
  });

  const activeEpisodes = episodes.filter((episode) => episode.teams.some((team) => team.tracked));
  const pairObservations: TacticalPairObservation[] = [];
  const eventById = new Map(events.map((event) => [event.sourceEventId, event]));
  const trackedRoster = match.players
    .filter((player) => trackedPlayerIds.has(player.accountId))
    .map((player) => ({
      matchRef: battlePlayerRef(matchId, player.accountId),
      stableRef: tacticalPlayerRef(player.accountId),
    }))
    .sort((left, right) => left.stableRef.localeCompare(right.stableRef));
  for (let leftIndex = 0; leftIndex < trackedRoster.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < trackedRoster.length; rightIndex += 1) {
      const left = trackedRoster[leftIndex]!;
      const right = trackedRoster[rightIndex]!;
      const pair = pairId(left.stableRef, right.stableRef);
      const matchRefs = [left.matchRef, right.matchRef];
      const eligibleEpisodes = activeEpisodes.filter((episode) =>
        matchRefs.some((ref) => episodeContactPlayers(episode).has(ref)),
      );
      const shared = eligibleEpisodes.filter((episode) =>
        matchRefs.every((ref) => episodeContactPlayers(episode).has(ref)),
      );
      const supportEvents = shared.flatMap((episode) =>
        episode.timeline
          .filter(
            (event) =>
              (event.type === 'DAMAGE' || event.type === 'KNOCK' || event.type === 'KILL') &&
              (matchRefs.includes(event.actorRef ?? '') ||
                matchRefs.includes(event.victimRef ?? '')),
          )
          .map((event) =>
            eventRef(matchId, eventById.get(event.sourceEventId), 'shared-engagement-contact'),
          ),
      );
      const counterexamples = eligibleEpisodes
        .filter((episode) => !matchRefs.every((ref) => episodeContactPlayers(episode).has(ref)))
        .flatMap((episode) =>
          episode.timeline
            .filter(
              (event) =>
                (event.type === 'DAMAGE' || event.type === 'KNOCK' || event.type === 'KILL') &&
                (matchRefs.includes(event.actorRef ?? '') ||
                  matchRefs.includes(event.victimRef ?? '')),
            )
            .map((event) =>
              eventRef(
                matchId,
                eventById.get(event.sourceEventId),
                'only-one-pair-member-in-contact',
              ),
            ),
        );
      pairObservations.push({
        ...pair,
        matchId,
        eligible: events.some((event) => event.phase === 'in_match'),
        sourceComplete,
        opportunityCount: eligibleEpisodes.length,
        sharedEngagementCount: shared.length,
        supportEvents: uniqueRefs(supportEvents),
        counterexamples: uniqueRefs(
          counterexamples.length
            ? counterexamples
            : shared.length === 0
              ? [matchRef(matchId, 'no-joint-engagement-observed')]
              : [],
        ),
      });
    }
  }
  const pairs = pairObservations.map((observation) =>
    makeCandidate({
      matchId,
      ruleId: 'social.shared-engagement-pair',
      category: 'social',
      title: '共同交战关系',
      statement: `${observation.sharedEngagementCount} 个重建交战同时出现这对当前队员。共同出现只描述事件，不代表关系或偏好。`,
      numerator: observation.sharedEngagementCount,
      denominator: observation.opportunityCount,
      sampleSize: observation.opportunityCount,
      support: observation.supportEvents,
      counterexamples: observation.counterexamples,
      complete: activeEpisodes.length > 0 && sourceComplete,
      reasons: activeEpisodes.length ? undefined : ['没有可分析的当前小队交战片段。'],
      assumptions: [
        '每个 R1 episode 计一次；共同出现通过匹配的 episode 参与者引用确认，不推断亲密度或意图。',
      ],
      pairRefs: observation.pairRefs,
    }),
  );

  const playfulMatches = positiveFriendlyDamage.flatMap((damage) => {
    const rescueEvent = reviveEvents
      .filter(
        (revive) =>
          revive.actorId === damage.actorId &&
          revive.victimId === damage.victimId &&
          damage.timeSeconds !== null &&
          revive.timeSeconds !== null &&
          revive.timeSeconds >= damage.timeSeconds &&
          revive.timeSeconds - damage.timeSeconds <= 120,
      )
      .sort((left, right) => left.timeSeconds! - right.timeSeconds!)[0];
    return rescueEvent ? [{ damage, revive: rescueEvent }] : [];
  });
  const playful = makeCandidate({
    matchId,
    ruleId: 'social.friendly-fire-followed-by-rescue',
    category: 'social',
    title: '友伤后由同一队员救援的叙事候选',
    statement: `${playfulMatches.length} 组同一方向的确认友伤 → 120 秒内救援事件；这是可复核事件组合，不代表“开玩笑”或任何动机。`,
    numerator: playfulMatches.length,
    denominator: positiveFriendlyDamage.length,
    support: playfulMatches.flatMap((item) => [
      eventRef(matchId, item.damage, 'directed-friendly-damage'),
      eventRef(matchId, item.revive, 'same-actor-rescue'),
    ]),
    counterexamples: positiveFriendlyDamage
      .filter(
        (damage) =>
          !playfulMatches.some((item) => item.damage.sourceEventId === damage.sourceEventId),
      )
      .map((event) => eventRef(matchId, event, 'friendly-damage-without-following-rescue')),
    complete: positiveFriendlyDamage.length > 0,
    reasons: positiveFriendlyDamage.length
      ? undefined
      : ['没有确认友伤事件，不能构造这个事件组合候选。'],
    assumptions: [
      '同一 actor 对同一 victim 在 120 秒内出现 REVIVE；不推断友好、玩笑、计划或因果。',
    ],
  });
  return { friendlyFire, rescue, pairs, playful, observations: pairObservations };
}

function analyzeCircleWindows(
  matchId: string,
  episodes: readonly BattleEpisode[],
  reconstruction: BattleReconstructionResult,
  eventById: ReadonlyMap<string, BattleSourceEvent>,
): TacticalInsightCandidate {
  const opportunities = episodes.filter(trackedEpisode);
  const transitions = reconstruction.circleTransitions.filter((transition) =>
    transition.changedZones.some(
      (zone) => zone === 'safetyZone' || zone === 'poisonGasWarningZone',
    ),
  );
  const rows = opportunities.map((episode) => {
    const nearby = transitions
      .filter(
        (transition) =>
          Math.abs(transition.timeSeconds - episode.startSeconds) <= TACTICAL_CIRCLE_WINDOW_SECONDS,
      )
      .sort(
        (left, right) =>
          Math.abs(left.timeSeconds - episode.startSeconds) -
          Math.abs(right.timeSeconds - episode.startSeconds),
      );
    return { episode, transition: nearby[0] ?? null };
  });
  const matched = rows.filter((row) => row.transition);
  return makeCandidate({
    matchId,
    ruleId: 'rotation.engagement-near-circle-transition',
    category: 'rotation',
    title: '圈状态窗口内的交战',
    statement: `${matched.length}/${rows.length} 个当前小队交战起点距已观测安全圈/毒圈半径变化不超过 ${TACTICAL_CIRCLE_WINDOW_SECONDS} 秒。`,
    numerator: matched.length,
    denominator: rows.length,
    support: matched.flatMap((row) => [
      eventRef(matchId, engagementAnchor(row.episode, eventById), 'engagement'),
      {
        matchId,
        eventId: row.transition!.fromSourceEventId,
        timeSeconds: row.transition!.timeSeconds,
        kind: 'circle-window-before',
      },
      {
        matchId,
        eventId: row.transition!.toSourceEventId,
        timeSeconds: row.transition!.timeSeconds,
        kind: 'circle-window-after',
      },
    ]),
    counterexamples: rows
      .filter((row) => !row.transition)
      .map((row) =>
        eventRef(matchId, engagementAnchor(row.episode, eventById), 'no-nearby-circle-transition'),
      ),
    complete: transitions.length > 0 && rows.length > 0,
    reasons: !transitions.length
      ? ['Telemetry 未提供可比较的安全圈/毒圈半径变化样本。']
      : !rows.length
        ? ['当前小队没有可关联的重建交战。']
        : undefined,
    assumptions: [
      `只把采样中安全圈或毒圈预警半径变化作为窗口锚点；窗口为 ±${TACTICAL_CIRCLE_WINDOW_SECONDS} 秒，不声称变化导致交战。`,
    ],
  });
}

function analyzeMovement(
  matchId: string,
  points: readonly PositionPoint[],
): TacticalInsightCandidate {
  const byPlayer = new Map<string, PositionPoint[]>();
  for (const point of points)
    byPlayer.set(point.playerRef, [...(byPlayer.get(point.playerRef) ?? []), point]);
  const segments = [...byPlayer.values()]
    .flatMap((playerPoints) => {
      const ordered = [...playerPoints].sort(
        (left, right) =>
          left.event.timeSeconds! - right.event.timeSeconds! ||
          left.event.sourceEventId.localeCompare(right.event.sourceEventId),
      );
      return ordered.slice(1).flatMap((end, index) => {
        const start = ordered[index]!;
        const elapsed = end.event.timeSeconds! - start.event.timeSeconds!;
        if (elapsed <= 0 || elapsed > TACTICAL_MOVEMENT_MAX_GAP_SECONDS) return [];
        const distance = Math.hypot(end.x - start.x, end.y - start.y);
        return Number.isFinite(distance)
          ? [
              {
                distance,
                elapsed,
                refs: [
                  eventRef(matchId, start.event, 'movement-start'),
                  eventRef(matchId, end.event, 'movement-end'),
                ],
              },
            ]
          : [];
      });
    })
    .sort((left, right) => right.distance / right.elapsed - left.distance / left.elapsed);
  const elapsed = sum(segments.map((item) => item.elapsed));
  const distance = sum(segments.map((item) => item.distance));
  return makeCandidate({
    matchId,
    ruleId: 'rotation.sampled-movement',
    category: 'rotation',
    title: '本队遥测位置变化',
    statement: segments.length
      ? `${segments.length} 个有效相邻位置段，累计平面位移 ${distance.toFixed(1)}，累计间隔 ${elapsed.toFixed(1)} 秒。`
      : '没有满足时间和坐标条件的相邻本队位置段。',
    numerator: segments.length ? distance : null,
    denominator: elapsed || null,
    sampleSize: segments.length,
    value: elapsed ? distance / elapsed : null,
    unit: '遥测坐标单位 / 秒',
    support: segments.slice(0, TACTICAL_MAX_EVIDENCE_REFS).flatMap((item) => item.refs),
    counterexamples: [...segments]
      .reverse()
      .slice(0, TACTICAL_MAX_EVIDENCE_REFS)
      .flatMap((item) => item.refs),
    complete: segments.length > 0,
    reasons: segments.length ? undefined : ['缺少连续有效的位置采样；不把缺席解释为静止。'],
    assumptions: [
      `相邻 POSITION 时间差须为 0–${TACTICAL_MOVEMENT_MAX_GAP_SECONDS} 秒，使用 X/Y 平面距离；不外推未采样路径。`,
    ],
  });
}

function analyzeBlueZoneDamage(
  matchId: string,
  events: readonly BattleSourceEvent[],
  trackedPlayerIds: ReadonlySet<string>,
): TacticalInsightCandidate {
  const damageEvents = events.filter(
    (event) =>
      event.type === 'DAMAGE' &&
      event.phase === 'in_match' &&
      event.victimId &&
      trackedPlayerIds.has(event.victimId) &&
      event.damage > 0,
  );
  const withReason = damageEvents.filter((event) => event.damageReason?.trim());
  const blueZone = withReason.filter((event) =>
    /blue\s*zone|bluezone|poison(?:\s*gas|zone)?/iu.test(event.damageReason ?? ''),
  );
  return makeCandidate({
    matchId,
    ruleId: 'rotation.explicit-blue-zone-damage',
    category: 'rotation',
    title: '有明示来源的蓝区伤害',
    statement: withReason.length
      ? `${blueZone.length}/${withReason.length} 条带有 damageReason 的本队受伤事件明确匹配蓝区/毒气原因。`
      : 'damageReason 没有可用于识别蓝区/毒气来源的事件，结果未知。',
    numerator: withReason.length ? blueZone.length : null,
    denominator: withReason.length ? withReason.length : null,
    sampleSize: withReason.length,
    support: blueZone.map((event) => eventRef(matchId, event, 'explicit-blue-zone-damage')),
    counterexamples: withReason
      .filter(
        (event) => !/blue\s*zone|bluezone|poison(?:\s*gas|zone)?/iu.test(event.damageReason ?? ''),
      )
      .map((event) => eventRef(matchId, event, 'explicit-other-damage-reason')),
    complete: damageEvents.length > 0 && withReason.length === damageEvents.length,
    reasons: !damageEvents.length
      ? ['当前队员没有正伤害受击事件作为评估机会。']
      : !withReason.length
        ? ['Domain telemetry 没有提供 damageReason；damage=0/unknown 不计作蓝区伤害。']
        : withReason.length < damageEvents.length
          ? [
              `${damageEvents.length - withReason.length} 条本队受击事件缺少 damageReason，未用于来源分类。`,
            ]
          : undefined,
    assumptions: [
      '只有 domain-normalized damageReason 明确含 BlueZone/Poison 才计为蓝区伤害；isInBlueZone 标志本身不证明伤害来源。',
    ],
  });
}

function mean(values: readonly number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function analyzeTacticalMatch(input: AnalyzeTacticalMatchInput): TacticalMatchAnalysis {
  const matchId = input.match.matchId;
  const trackedPlayerIds = new Set(input.trackedPlayerIds);
  const trackedPlayerRefs = new Set(
    input.match.players
      .filter((player) => trackedPlayerIds.has(player.accountId))
      .map((player) => battlePlayerRef(matchId, player.accountId)),
  );
  const events = uniqueEvents(input.telemetry.events).filter((event) => event.phase === 'in_match');
  const eventById = new Map(events.map((event) => [event.sourceEventId, event]));
  const episodes = input.reconstruction.episodes;
  const positions = pointsByBucket(matchId, input.telemetry, trackedPlayerIds);
  const distances = analyzeDistances(
    matchId,
    input.match,
    episodes,
    trackedPlayerIds,
    positions.buckets,
    positions.points,
    eventById,
  );
  const trackedTeamIds = trackedTeamIdsFor(events, trackedPlayerIds);
  const trackedTeamRefs = new Set(
    [...trackedTeamIds].map((teamId) => battleTeamRef(matchId, teamId)),
  );
  const sourceComplete =
    input.telemetry.diagnostics.unrecognizedDomainEventCount === 0 &&
    input.telemetry.diagnostics.untimedBattleEventCount === 0;
  const social = analyzeSocial(
    matchId,
    input.match,
    events,
    episodes,
    trackedPlayerIds,
    trackedTeamIds,
    sourceComplete,
  );
  const candidates = [
    analyzeFirstKnocks(matchId, episodes, trackedPlayerRefs, eventById, trackedTeamRefs),
    ...analyzeBattleDynamics(matchId, input.reconstruction.battles, events, trackedTeamIds),
    analyzeFollowUps(
      matchId,
      episodes,
      events,
      trackedPlayerRefs,
      trackedPlayerIds,
      trackedTeamIds,
      eventById,
    ),
    analyzeAdvantageConversion(matchId, episodes, trackedPlayerRefs),
    distances.sampled,
    distances.onset,
    distances.isolation,
    analyzeResponseWindows(
      matchId,
      events,
      trackedPlayerIds,
      trackedTeamIdsFor(events, trackedPlayerIds),
    ),
    social.friendlyFire,
    social.rescue,
    ...social.pairs,
    social.playful,
    analyzeCircleWindows(matchId, episodes, input.reconstruction, eventById),
    analyzeMovement(matchId, positions.points),
    analyzeBlueZoneDamage(matchId, events, trackedPlayerIds),
  ];
  const incompleteTeamEventCount = events.filter(
    (event) =>
      (event.actorId && trackedPlayerIds.has(event.actorId) && !event.actorTeamId) ||
      (event.victimId && trackedPlayerIds.has(event.victimId) && !event.victimTeamId),
  ).length;
  return {
    schemaVersion: TACTICAL_ANALYSIS_SCHEMA_VERSION,
    ruleVersion: TACTICAL_RULE_VERSION,
    matchId,
    candidates,
    pairObservations: social.observations,
    diagnostics: {
      trackedPlayerCount: trackedPlayerIds.size,
      episodeCount: episodes.length,
      battleGroupCount: input.reconstruction.battles.length,
      multiTeamBattleCount: input.reconstruction.battles.filter(
        (battle) => battle.teamRefs.length >= 3,
      ).length,
      advantageWindowCount: input.reconstruction.battles.reduce(
        (sum, battle) => sum + battle.advantageWindows.length,
        0,
      ),
      observedRosterOnlyBattleCount: input.reconstruction.battles.length,
      positionEventCount: positions.points.length,
      incompleteTeamEventCount,
      unknownTimestampEventCount: input.telemetry.events.filter(
        (event) => event.phase === 'in_match' && event.timeSeconds === null,
      ).length,
      unmatchedBattleSourceCount: input.telemetry.diagnostics.unrecognizedDomainEventCount,
    },
  };
}

export function buildFrequentPairCandidates(
  analyses: readonly TacticalMatchAnalysis[],
): TacticalInsightCandidate[] {
  const byPair = new Map<string, TacticalPairObservation[]>();
  for (const analysis of analyses) {
    for (const observation of analysis.pairObservations) {
      if (!observation.eligible) continue;
      byPair.set(observation.pairRef, [...(byPair.get(observation.pairRef) ?? []), observation]);
    }
  }
  return [...byPair.values()]
    .map((observations) => {
      const first = observations[0]!;
      const sharedMatches = observations.filter(
        (observation) => observation.sharedEngagementCount > 0,
      );
      const support = sharedMatches.flatMap((observation) => observation.supportEvents);
      const counterexamples = observations.flatMap((observation) => observation.counterexamples);
      const enoughMatches = sharedMatches.length >= TACTICAL_PAIR_MIN_SHARED_MATCHES;
      const incompleteSourceMatches = observations.filter(
        (observation) => !observation.sourceComplete,
      ).length;
      return makeCandidate({
        matchId: `dataset-${digest(
          observations
            .map((item) => item.matchId)
            .sort()
            .join('\u001f'),
          16,
        )}`,
        ruleId: 'social.recurrent-shared-engagement-pair',
        category: 'social',
        title: '常搭对候选（重复共同交战）',
        statement: `${sharedMatches.length}/${observations.length} 场可分析比赛观察到这对成员共同参与至少一个交战；${enoughMatches ? '达到重复候选门槛' : `不足 ${TACTICAL_PAIR_MIN_SHARED_MATCHES} 场，不形成常搭候选`}。这不表示偏好或关系。`,
        numerator: sharedMatches.length,
        denominator: observations.length,
        sampleSize: observations.length,
        support,
        counterexamples,
        complete: incompleteSourceMatches === 0,
        statusOverride:
          observations.length < TACTICAL_PAIR_MIN_SHARED_MATCHES
            ? 'insufficient_data'
            : enoughMatches
              ? 'observed'
              : 'not_observed',
        reasons: [
          ...(observations.length < TACTICAL_PAIR_MIN_SHARED_MATCHES
            ? [
                `只有 ${observations.length} 场 eligible match，低于规则最低 ${TACTICAL_PAIR_MIN_SHARED_MATCHES} 场；不评级为常搭对。`,
              ]
            : []),
          ...(incompleteSourceMatches
            ? [
                `${incompleteSourceMatches}/${observations.length} 场原始事件存在未识别或无时间行，候选质量降级。`,
              ]
            : []),
        ],
        assumptions: [
          `只有同一对 roster 成员同时出现在同一 R1 episode 才计共同交战；至少 ${TACTICAL_PAIR_MIN_SHARED_MATCHES} 场不同比赛有支持事件才形成候选。`,
        ],
        pairRefs: first.pairRefs,
      });
    })
    .sort(
      (left, right) =>
        (right.metric.numerator ?? 0) - (left.metric.numerator ?? 0) ||
        left.id.localeCompare(right.id),
    );
}
