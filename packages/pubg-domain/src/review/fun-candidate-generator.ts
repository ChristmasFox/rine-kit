import type {
  FunCandidate,
  FunCandidateType,
  FunEvent,
  MatchReviewFacts,
  ReviewPlayerFacts,
  SpecialEvent,
  VehicleStats,
} from './types.js';
import { generateBaseFunEvents } from './fun-event-generator.js';

const SUMMARY_EVIDENCE_PREFIX = 'match-summary-';
const RIDE_THRESHOLD_METERS = 1_000;

function integer(value: number): string {
  return Math.round(value).toLocaleString('zh-CN');
}

function kilometers(value: number): string {
  return `${(value / 1_000).toFixed(1)}km`;
}

function playerName(facts: MatchReviewFacts, playerId: string): string {
  return facts.players.find((player) => player.playerId === playerId)?.playerName ?? playerId;
}

function summaryEvidence(facts: MatchReviewFacts): string {
  return `${SUMMARY_EVIDENCE_PREFIX}${facts.match.matchId}`;
}

/** Convert internal event/derived references into durable ReviewEvidence IDs. */
function evidenceReferences(facts: MatchReviewFacts, ids: string[]): string[] {
  const available = new Map(facts.evidence.map((item) => [item.id, item]));
  const byEventId = new Map<string, string[]>();
  for (const evidence of facts.evidence) {
    for (const eventId of evidence.eventIds) {
      const references = byEventId.get(eventId) ?? [];
      references.push(evidence.id);
      byEventId.set(eventId, references);
    }
  }
  const resolved: string[] = [];
  for (const id of ids) {
    if (available.has(id)) {
      resolved.push(id);
      continue;
    }
    const eventEvidenceId = `evidence-${id}`;
    if (available.has(eventEvidenceId)) {
      resolved.push(eventEvidenceId);
      continue;
    }
    resolved.push(...(byEventId.get(id) ?? []));
  }
  return [...new Set(resolved)];
}

function playerEvidence(
  facts: MatchReviewFacts,
  player: ReviewPlayerFacts | null,
  extra: string[] = [],
): string[] {
  const evidence = [
    summaryEvidence(facts),
    ...(player ? [`player-summary-${facts.match.matchId}-${player.playerId}`] : []),
    ...(player?.keyOperations.flatMap((operation) => operation.evidenceIds) ?? []),
    ...(player && facts.fightIntegrity.pass
      ? facts.fights
          .filter((fight) => fight.keyPlayers.includes(player.playerId))
          .flatMap((fight) => fight.evidenceIds)
      : []),
    ...(player?.vehicle?.evidenceIds ?? []),
    ...(player?.heavyWeapons.flatMap((weapon) => weapon.evidenceIds) ?? []),
    ...extra,
  ];
  return evidenceReferences(facts, evidence);
}

function candidate(
  id: string,
  type: FunCandidateType,
  title: string,
  text: string,
  impactScore: number,
  facts: FunCandidate['facts'],
  evidenceIds: string[],
  playerId?: string,
): FunCandidate | null {
  const evidence = [...new Set(evidenceIds)].filter(Boolean);
  if (!evidence.length) return null;
  return {
    id,
    type,
    title,
    text,
    impactScore,
    facts,
    evidenceIds: evidence,
    ...(playerId ? { playerId } : {}),
  };
}

function specialCandidate(facts: MatchReviewFacts, event: SpecialEvent): FunCandidate | null {
  if (!event.playerId) return null;
  const name = playerName(facts, event.playerId);
  const values = event.facts;
  const pickupEvents = Number(values.pickupEvents ?? 0);
  const shots = Number(values.shots ?? 0);
  const hits = Number(values.hits ?? 0);
  const kills = Number(values.kills ?? 0);
  const typeMap: Partial<
    Record<
      SpecialEvent['type'],
      { type: FunCandidateType; title: string; text: string; score: number }
    >
  > = {
    ROCKET_UNUSED: {
      type: 'ROCKET_UNUSED',
      title: '🎒 军火收藏家',
      text: `${name}\n火箭筒拾取${pickupEvents}次 · 发射0`,
      score: 420,
    },
    ROCKET_MISS: {
      type: 'ROCKET_MISS',
      title: '🎯 火箭筒放空',
      text: `${name}\n火箭筒发射${shots}次 · 未检测到命中`,
      score: 330,
    },
    ROCKET_MULTI_KILL: {
      type: 'ROCKET_MULTI_KILL',
      title: '💥 一炮多响',
      text: `${name}\n一发火箭筒关联${kills}次击杀`,
      score: 760 + kills * 40,
    },
    ROCKET_VEHICLE_MULTI_KILL: {
      type: 'ROCKET_VEHICLE_MULTI_KILL',
      title: `☢️ 一炮${kills}响`,
      text: `${name}\nPanzerfaust摧毁载具 · ${kills}杀`,
      score: 1_000 + kills * 60,
    },
    ROCKET_HIT: {
      type: 'SPECIAL_EVENT',
      title: '🚀 火箭筒开张',
      text: `${name}\n火箭筒${shots}发 · ${hits}次命中记录`,
      score: 480 + hits * 30,
    },
    MULTI_KNOCK: {
      type: 'SPECIAL_EVENT',
      title: '⚡ 倒地制造机',
      text: `${name}\n一波团战造成${Number(values.knocks ?? 0)}次倒地`,
      score: 520,
    },
    CLUTCH: {
      type: 'SPECIAL_EVENT',
      title: '🏆 收割现场',
      text: `${name}\n团战内完成${kills}次击杀`,
      score: 580,
    },
    REVIVE_CHAIN: {
      type: 'SPECIAL_EVENT',
      title: '❤️ 急救站站长',
      text: `${name}\n连续完成${Number(values.revives ?? 0)}次救援`,
      score: 360,
    },
    VEHICLE_DESTROY: {
      type: 'SPECIAL_EVENT',
      title: '🚙 车库拆迁队',
      text: `${name}\n摧毁${Number(values.vehiclesDestroyed ?? 0)}辆载具`,
      score: 520,
    },
  };
  const descriptor = typeMap[event.type];
  if (!descriptor) return null;
  return candidate(
    `fun-${event.id}`,
    descriptor.type,
    descriptor.title,
    `${descriptor.title}\n${descriptor.text}`,
    Math.max(descriptor.score, event.impactScore),
    event.facts,
    evidenceReferences(facts, event.evidenceIds),
    event.playerId,
  );
}

function vehicleCandidates(facts: MatchReviewFacts): FunCandidate[] {
  const vehicles = facts.vehicles.filter((vehicle) => vehicle.evidenceIds.length > 0);
  const result: FunCandidate[] = [];
  const drivers = vehicles.filter(
    (vehicle) => vehicle.driverConfirmed && vehicle.driveDistance > 0,
  );
  const topDriver = [...drivers].sort(
    (left, right) =>
      right.driveDistance - left.driveDistance || left.playerId.localeCompare(right.playerId),
  )[0];
  if (topDriver) {
    const player = facts.players.find((item) => item.playerId === topDriver.playerId);
    const item = candidate(
      `fun-top-driver-${topDriver.playerId}`,
      'TOP_DRIVER',
      '🚗 车队车神',
      `🚗 车队车神\n${player?.playerName ?? topDriver.playerId}\n驾驶${kilometers(topDriver.driveDistance)} · 最高${Math.round(topDriver.maxSpeed)}km/h`,
      500 + Math.min(280, topDriver.driveDistance / 100),
      {
        driveDistance: Math.round(topDriver.driveDistance),
        maxSpeed: Math.round(topDriver.maxSpeed),
      },
      playerEvidence(facts, player ?? null, topDriver.evidenceIds),
      topDriver.playerId,
    );
    if (item) result.push(item);
  }

  const passengers = vehicles.filter(
    (vehicle) => vehicle.passengerConfirmed && vehicle.rideDistance > 0,
  );
  const topPassenger = [...passengers].sort(
    (left, right) =>
      right.rideDistance - left.rideDistance || left.playerId.localeCompare(right.playerId),
  )[0];
  if (topPassenger) {
    const player = facts.players.find((item) => item.playerId === topPassenger.playerId);
    const item = candidate(
      `fun-top-passenger-${topPassenger.playerId}`,
      'TOP_PASSENGER',
      '🚕 尊贵乘客',
      `🚕 尊贵乘客\n${player?.playerName ?? topPassenger.playerId}\n乘车${kilometers(topPassenger.rideDistance)}`,
      420 + Math.min(220, topPassenger.rideDistance / 100),
      {
        rideDistance: Math.round(topPassenger.rideDistance),
        driveDistance: Math.round(topPassenger.driveDistance),
        passengerConfirmed: true,
      },
      playerEvidence(facts, player ?? null, topPassenger.evidenceIds),
      topPassenger.playerId,
    );
    if (item) result.push(item);
  }

  const longest = [...vehicles]
    .filter((vehicle) => vehicle.rideDistance >= RIDE_THRESHOLD_METERS)
    .sort(
      (left, right) =>
        right.rideDistance - left.rideDistance || left.playerId.localeCompare(right.playerId),
    )[0];
  if (longest) {
    const player = facts.players.find((item) => item.playerId === longest.playerId);
    const item = candidate(
      `fun-longest-ride-${longest.playerId}`,
      'LONGEST_RIDE',
      '🛣️ 公路旅行家',
      `🛣️ 公路旅行家\n${player?.playerName ?? longest.playerId}\n乘车${kilometers(longest.rideDistance)}`,
      300 + Math.min(180, longest.rideDistance / 200),
      { rideDistance: Math.round(longest.rideDistance) },
      playerEvidence(facts, player ?? null, longest.evidenceIds),
      longest.playerId,
    );
    if (item) result.push(item);
  }
  return result;
}

function playerCandidates(facts: MatchReviewFacts): FunCandidate[] {
  const result: FunCandidate[] = [];
  const players = facts.players.filter((player) => player.matchPresence !== 'not_recorded');
  const teamDamage = facts.squad.damage;
  const topDamage = [...players].sort(
    (left, right) => right.damage - left.damage || left.playerId.localeCompare(right.playerId),
  )[0];
  if (topDamage && topDamage.damage >= Math.max(300, teamDamage * 0.4)) {
    const item = candidate(
      `fun-high-damage-${topDamage.playerId}`,
      'HIGH_DAMAGE',
      '💥 火力压制',
      `💥 火力压制\n${topDamage.playerName}\n${integer(topDamage.damage)}伤害`,
      380 + Math.min(260, topDamage.damage / 4),
      { damage: Math.round(topDamage.damage) },
      playerEvidence(facts, topDamage),
      topDamage.playerId,
    );
    if (item) result.push(item);
  }

  const lowestDamage = [...players]
    .filter(
      (player) =>
        player.damage > 0 &&
        teamDamage >= 300 &&
        player.damage <= teamDamage * 0.12 &&
        !(player.kills === 0 && player.assists === 0 && player.dbnos === 0 && player.revives === 0),
    )
    .sort(
      (left, right) => left.damage - right.damage || left.playerId.localeCompare(right.playerId),
    )[0];
  if (lowestDamage) {
    const item = candidate(
      `fun-low-damage-${lowestDamage.playerId}`,
      'LOW_DAMAGE',
      '🫥 输出掉线',
      `🫥 输出掉线\n${lowestDamage.playerName}\n${integer(lowestDamage.damage)}伤害`,
      250 + Math.max(0, 120 - lowestDamage.damage / 4),
      { damage: Math.round(lowestDamage.damage) },
      playerEvidence(facts, lowestDamage),
      lowestDamage.playerId,
    );
    if (item) result.push(item);
  }

  const knockCandidates = players
    .filter((player) => player.dbnos >= 3 && player.kills / player.dbnos <= 0.4)
    .sort(
      (left, right) =>
        right.dbnos - left.dbnos ||
        left.kills - right.kills ||
        left.playerId.localeCompare(right.playerId),
    );
  const knockPlayer = knockCandidates[0];
  if (knockPlayer) {
    const item = candidate(
      `fun-knock-conversion-${knockPlayer.playerId}`,
      'HIGH_KNOCK_LOW_CONVERSION',
      '🫠 白打王',
      `🫠 白打王\n${knockPlayer.playerName}\n${knockPlayer.dbnos}倒地 · ${knockPlayer.kills}杀`,
      430 + knockPlayer.dbnos * 30,
      { dbnos: knockPlayer.dbnos, kills: knockPlayer.kills },
      playerEvidence(facts, knockPlayer),
      knockPlayer.playerId,
    );
    if (item) result.push(item);
  }

  const noCombat = players
    .filter(
      (player) =>
        player.kills === 0 &&
        player.assists === 0 &&
        player.dbnos === 0 &&
        player.revives === 0 &&
        player.damage === 0 &&
        player.keyOperations.length === 0,
    )
    .sort((left, right) => left.playerId.localeCompare(right.playerId))[0];
  if (noCombat) {
    const item = candidate(
      `fun-no-combat-${noCombat.playerId}`,
      'NO_COMBAT_PRESENCE',
      '👻 全场隐身',
      `👻 全场隐身\n${noCombat.playerName}\n0杀 · 0助 · 0倒地 · 0救援 · 0伤害`,
      410,
      { kills: 0, assists: 0, dbnos: 0, revives: 0, damage: 0 },
      playerEvidence(facts, noCombat),
      noCombat.playerId,
    );
    if (item) result.push(item);
  }

  const topRevives = [...players].sort(
    (left, right) => right.revives - left.revives || left.playerId.localeCompare(right.playerId),
  )[0];
  if (topRevives && topRevives.revives >= 2) {
    const item = candidate(
      `fun-most-revives-${topRevives.playerId}`,
      'MOST_REVIVES',
      '❤️ 移动急救站',
      `❤️ 移动急救站\n${topRevives.playerName}\n${topRevives.revives}救援`,
      350 + topRevives.revives * 40,
      { revives: topRevives.revives },
      playerEvidence(facts, topRevives),
      topRevives.playerId,
    );
    if (item) result.push(item);
  }

  const topAssists = [...players].sort(
    (left, right) => right.assists - left.assists || left.playerId.localeCompare(right.playerId),
  )[0];
  const secondAssists = [...players].sort(
    (left, right) => right.assists - left.assists || left.playerId.localeCompare(right.playerId),
  )[1];
  if (topAssists && topAssists.assists >= 2 && topAssists.assists > (secondAssists?.assists ?? 0)) {
    const item = candidate(
      `fun-most-assists-${topAssists.playerId}`,
      'MOST_ASSISTS',
      '🤝 助攻发动机',
      `🤝 助攻发动机\n${topAssists.playerName}\n${topAssists.assists}助攻`,
      330 + topAssists.assists * 35,
      { assists: topAssists.assists },
      playerEvidence(facts, topAssists),
      topAssists.playerId,
    );
    if (item) result.push(item);
  }
  return result;
}

function sortCandidates(left: FunCandidate, right: FunCandidate): number {
  return (
    right.impactScore - left.impactScore ||
    left.type.localeCompare(right.type) ||
    (left.playerId ?? '').localeCompare(right.playerId ?? '') ||
    left.id.localeCompare(right.id)
  );
}

export class FunCandidateGenerator {
  constructor(private readonly limit = 5) {}

  generate(facts: MatchReviewFacts): FunCandidate[] {
    const candidates = [
      ...facts.specialEvents.map((event) => specialCandidate(facts, event)),
      ...vehicleCandidates(facts),
      ...playerCandidates(facts),
    ].filter((item): item is FunCandidate => item !== null && item.evidenceIds.length > 0);
    return candidates.sort(sortCandidates).slice(0, Math.max(0, this.limit));
  }

  /** V3.3 structured branch; the legacy generate() API remains unchanged. */
  generateEvents(facts: MatchReviewFacts): FunEvent[] {
    return generateBaseFunEvents(facts);
  }
}

export function generateFunCandidates(facts: MatchReviewFacts, limit = 5): FunCandidate[] {
  return new FunCandidateGenerator(limit).generate(facts);
}
