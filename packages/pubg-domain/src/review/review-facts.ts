import type { TeamConfig } from '../config/team.js';
import type { NormalizedMatch } from '../data/model.js';
import { detectFights } from './fight-detector.js';
import {
  dedupeRelevantCombatEvents,
  isOpponentOffensiveEvent,
  isOpponentReviveEvent,
  isTrackedOffensiveEvent,
  isTrackedReviveEvent,
} from './combat-scope.js';
import { validateFightIntegrity } from './fight-integrity-validator.js';
import { extractHeavyWeaponStats, extractWeaponStats } from './heavy-weapon-intelligence.js';
import { detectKeyOperations } from './key-operation-detector.js';
import { detectSpecialEvents } from './special-events.js';
import { extractVehicleStats } from './vehicle-intelligence.js';
import {
  extractFlashStats,
  extractTeamDamageFacts,
  extractTeamVehicleEvents,
} from './team-damage.js';
import {
  extractArmorBreakFacts,
  extractEnvironmentStats,
  extractLootActivityStats,
  extractLootStats,
  extractRecoveryStats,
  extractStunGunStats,
  extractVehicleImpactFacts,
  extractVehicleTrunkTransfers,
} from './supplemental-intelligence.js';
import type {
  MatchReviewFacts,
  ReviewEvidence,
  ReviewPlayerFacts,
  ReviewSquadSummary,
} from './types.js';
import { normalizeTelemetryEvents, type NormalizedTelemetryEvent } from './telemetry-events.js';

function canonicalId(value: string | null, team: TeamConfig): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  const player = team.players.find(
    (item) =>
      item.id.toLowerCase() === normalized ||
      item.name.toLowerCase() === normalized ||
      item.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
  return player?.id ?? value;
}

function canonicalEvents(
  events: NormalizedTelemetryEvent[],
  team: TeamConfig,
): NormalizedTelemetryEvent[] {
  return events.map((event) => ({
    ...event,
    actorId: canonicalId(event.actorId, team),
    victimId: canonicalId(event.victimId, team),
  }));
}

function matchSummary(match: NormalizedMatch, ordinal: number) {
  return {
    matchId: match.matchId,
    ordinal,
    startedAt: match.createdAt,
    mapName: match.mapName,
    gameMode: match.gameMode,
    duration: match.duration,
    placement:
      match.players
        .map((player) => player.rank)
        .filter((rank): rank is number => rank !== null)
        .sort((left, right) => left - right)[0] ?? null,
    patchVersion: match.patchVersion,
  };
}

function squadSummary(match: NormalizedMatch, team: TeamConfig): ReviewSquadSummary {
  const ids = new Set(team.players.map((player) => player.id));
  const players = match.players.filter((player) => ids.has(player.accountId));
  return {
    playerIds: team.players.map((player) => player.id),
    kills: players.reduce((sum, player) => sum + player.kills, 0),
    assists: players.reduce((sum, player) => sum + player.assists, 0),
    damage: players.reduce((sum, player) => sum + player.damage, 0),
    knocks: players.reduce((sum, player) => sum + player.dbnos, 0),
    revives: players.reduce((sum, player) => sum + player.revives, 0),
    placement:
      players
        .map((player) => player.rank)
        .filter((rank): rank is number => rank !== null)
        .sort((left, right) => left - right)[0] ?? null,
  };
}

function eventDescription(event: NormalizedTelemetryEvent): string {
  if (event.type === 'DAMAGE') return `造成${Math.round(event.damage)}伤害`;
  if (event.type === 'KNOCK') return '造成一次倒地';
  if (event.type === 'KILL') return '完成一次击杀';
  if (event.type === 'REVIVE') return '完成一次救援';
  if (event.type === 'VEHICLE_DESTROY') return '摧毁载具';
  return event.rawType || event.type;
}

function factsForPlayer(match: NormalizedMatch, team: TeamConfig): ReviewPlayerFacts[] {
  const byId = new Map(match.players.map((player) => [player.accountId, player]));
  return team.players.map((configured) => {
    const player = byId.get(configured.id);
    return {
      playerId: configured.id,
      playerName: configured.name,
      matchPresence: player ? 'recorded' : 'not_recorded',
      rank: player?.rank ?? null,
      kills: player?.kills ?? 0,
      assists: player?.assists ?? 0,
      damage: player?.damage ?? 0,
      dbnos: player?.dbnos ?? 0,
      revives: player?.revives ?? 0,
      roleConfidence: 'none',
      keyOperations: [],
      heavyWeapons: [],
    };
  });
}

function playerSummaryEvidence(match: NormalizedMatch, player: ReviewPlayerFacts): ReviewEvidence {
  return {
    id: `player-summary-${match.matchId}-${player.playerId}`,
    kind: 'FACT',
    source: 'match_store',
    eventIds: [],
    description:
      player.matchPresence === 'not_recorded'
        ? `${player.playerName} 未出现在本场 Match Store participant 记录中`
        : `${player.playerName} 的 Match Store 基础战绩：${player.kills}杀、${player.assists}助、${Math.round(player.damage)}伤害、${player.dbnos}倒地、${player.revives}救援`,
  };
}

function evidenceForEvents(events: NormalizedTelemetryEvent[]): ReviewEvidence[] {
  return events.map((event) => ({
    id: `evidence-${event.id}`,
    kind: 'FACT',
    source: 'telemetry',
    eventIds: [event.id],
    description: eventDescription(event),
  }));
}

export function extractMatchReviewFacts(
  match: NormalizedMatch,
  rawTelemetry: unknown,
  team: TeamConfig,
  ordinal = 1,
): MatchReviewFacts {
  const events = canonicalEvents(normalizeTelemetryEvents(rawTelemetry, match), team);
  const teamIds = new Set(team.players.map((player) => player.id));
  const fights = detectFights(events, teamIds);
  const vehicles = extractVehicleStats(events, teamIds);
  const heavyWeapons = extractHeavyWeaponStats(events, teamIds);
  const weapons = extractWeaponStats(events, teamIds);
  const teamDamage = extractTeamDamageFacts(events, teamIds);
  const teamVehicleEvents = extractTeamVehicleEvents(events, teamIds);
  const flash = extractFlashStats(events, teamIds);
  const stunGuns = extractStunGunStats(events, teamIds);
  const recovery = extractRecoveryStats(events, teamIds);
  const loot = extractLootStats(events, teamIds);
  const lootActivity = extractLootActivityStats(events, teamIds);
  const vehicleTrunk = extractVehicleTrunkTransfers(events, teamIds);
  const environment = extractEnvironmentStats(events, teamIds);
  const armorBreaks = extractArmorBreakFacts(events, teamIds);
  const vehicleImpacts = extractVehicleImpactFacts(events, teamIds);
  const players = factsForPlayer(match, team);
  const squad = squadSummary(match, team);
  const combatEvents = dedupeRelevantCombatEvents(events, teamIds);
  const teamCombatEvents = combatEvents.filter(
    (event) => isTrackedOffensiveEvent(event, teamIds) || isTrackedReviveEvent(event, teamIds),
  );
  const opponentCombatEvents = combatEvents.filter(
    (event) => isOpponentOffensiveEvent(event, teamIds) || isOpponentReviveEvent(event, teamIds),
  );
  const combat = {
    eventCount: combatEvents.length,
    damage: teamCombatEvents
      .filter((event) => event.type === 'DAMAGE')
      .reduce((sum, event) => sum + event.damage, 0),
    knocks: teamCombatEvents.filter((event) => event.type === 'KNOCK').length,
    kills: teamCombatEvents.filter((event) => event.type === 'KILL').length,
    revives: teamCombatEvents.filter((event) => event.type === 'REVIVE').length,
    opponentDamage: opponentCombatEvents
      .filter((event) => event.type === 'DAMAGE')
      .reduce((sum, event) => sum + event.damage, 0),
    opponentKnocks: opponentCombatEvents.filter((event) => event.type === 'KNOCK').length,
    opponentKills: opponentCombatEvents.filter((event) => event.type === 'KILL').length,
    opponentRevives: opponentCombatEvents.filter((event) => event.type === 'REVIVE').length,
    events,
  };
  const facts: MatchReviewFacts = {
    schemaVersion: 1,
    match: matchSummary(match, ordinal),
    squad,
    players,
    combat,
    fights,
    fightIntegrity: validateFightIntegrity({
      fights,
      events,
      teamIds,
      players,
      matchTeamKills: squad.kills,
      matchTeamDamage: squad.damage,
      matchTeamDBNOs: squad.knocks,
    }),
    weapons,
    vehicles,
    heavyWeapons,
    specialEvents: [],
    teamDamage,
    teamVehicleEvents,
    flash,
    stunGuns,
    recovery,
    loot,
    lootActivity,
    vehicleTrunk,
    environment,
    armorBreaks,
    vehicleImpacts,
    evidence: [
      {
        id: `match-summary-${match.matchId}`,
        kind: 'FACT',
        source: 'match_store',
        eventIds: [],
        description: 'Match Store 基础战绩',
      },
      ...players.map((player) => playerSummaryEvidence(match, player)),
      ...evidenceForEvents(events),
    ],
  };
  const operations = detectKeyOperations(facts);
  const roleForOperation = (
    type: string,
  ): { role: string; confidence: ReviewPlayerFacts['roleConfidence'] } => {
    if (type === 'ENTRY') return { role: '开团/信息', confidence: 'high' };
    if (['MULTI_KNOCK', 'CLUTCH'].includes(type)) return { role: '主攻/终结', confidence: 'high' };
    if (['REVIVE', 'SUPPORT'].includes(type)) return { role: '支援/救援', confidence: 'medium' };
    if (type === 'HEAVY_WEAPON') return { role: '重火力', confidence: 'medium' };
    if (type === 'VEHICLE') return { role: '载具作战', confidence: 'medium' };
    return { role: '火力输出', confidence: 'medium' };
  };
  for (const player of facts.players) {
    player.keyOperations = operations.filter((operation) => operation.playerId === player.playerId);
    const playerVehicle = vehicles.find((vehicle) => vehicle.playerId === player.playerId);
    if (playerVehicle) player.vehicle = playerVehicle;
    player.heavyWeapons = heavyWeapons.filter((weapon) => weapon.playerId === player.playerId);
    const roleOperation =
      player.keyOperations.find((operation) =>
        ['ENTRY', 'MULTI_KNOCK', 'CLUTCH'].includes(operation.type),
      ) ??
      player.keyOperations.find((operation) =>
        ['DAMAGE', 'TRADE', 'SUPPORT', 'REVIVE'].includes(operation.type),
      ) ??
      player.keyOperations.find((operation) =>
        ['HEAVY_WEAPON', 'VEHICLE'].includes(operation.type),
      );
    if (roleOperation) {
      const role = roleForOperation(roleOperation.type);
      player.matchRole = role.role;
      player.roleConfidence = role.confidence;
    }
  }
  facts.specialEvents = detectSpecialEvents(
    events,
    fights,
    heavyWeapons,
    vehicles,
    teamIds,
    facts.fightIntegrity.pass,
  );
  facts.evidence.push(
    ...fights.map((fight) => ({
      id: `evidence-${fight.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fight.evidenceIds,
      description: '聚合团战',
    })),
    ...operations.map((operation) => ({
      id: `evidence-${operation.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: operation.evidenceIds,
      description: operation.impact,
    })),
    ...facts.specialEvents.map((event) => ({
      id: `evidence-${event.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: event.evidenceIds,
      description: event.impact,
    })),
    ...teamDamage.map((fact) => ({
      id: `evidence-${fact.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.actorPlayerId} 对 ${fact.victimPlayerId} 造成${Math.round(fact.damage)}点队友伤害（${fact.source}）`,
    })),
    ...teamVehicleEvents.map((fact) => ({
      id: `evidence-${fact.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.actorPlayerId} 对 ${fact.victimPlayerId} 造成车辆${fact.type}事实`,
    })),
    ...flash.map((fact) => ({
      id: `evidence-flash-${fact.playerId}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.playerId} 使用闪光弹${fact.uses}次`,
    })),
    ...stunGuns.map((fact) => ({
      id: `evidence-${fact.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.playerId} 的电击枪统计`,
    })),
    ...recovery.map((fact) => ({
      id: `evidence-${fact.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.playerId} 的恢复和能量物品使用统计`,
    })),
    ...loot.map((fact) => ({
      id: `evidence-${fact.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.playerId} 的死亡盒搜包统计`,
    })),
    ...lootActivity.map((fact) => ({
      id: `evidence-${fact.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.playerId} 的物资拾取与丢弃统计`,
    })),
    ...vehicleTrunk.map((fact) => ({
      id: `evidence-${fact.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.playerId} 的载具仓库${fact.direction === 'PUT' ? '存入' : '取出'}记录`,
    })),
    ...environment.map((fact) => ({
      id: `evidence-${fact.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.playerId} 的环境互动统计`,
    })),
    ...armorBreaks.map((fact) => ({
      id: `evidence-${fact.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.actorPlayerId} 的护甲破坏记录`,
    })),
    ...vehicleImpacts.map((fact) => ({
      id: `evidence-${fact.id}`,
      kind: 'DERIVED' as const,
      source: 'telemetry' as const,
      eventIds: fact.evidenceIds,
      description: `${fact.playerId} 的载具攻击组合记录`,
    })),
  );
  return facts;
}

function filterPlayerFacts<T extends { playerId: string }>(
  values: T[] | undefined,
  playerIds: Set<string>,
): T[] | undefined {
  return values?.filter((value) => playerIds.has(value.playerId));
}

function filterActorVictimFacts<T extends { actorPlayerId: string; victimPlayerId: string | null }>(
  values: T[] | undefined,
  playerIds: Set<string>,
): T[] | undefined {
  return values?.filter(
    (value) =>
      playerIds.has(value.actorPlayerId) ||
      (value.victimPlayerId !== null && playerIds.has(value.victimPlayerId)),
  );
}

/**
 * Keep a person-specific review from silently expanding back to the full
 * configured squad after identity_resolve has already selected a PUBG account.
 * The durable Telemetry feature cache remains squad-scoped; this is a bounded
 * presentation/analysis view over those cached facts.
 */
export function scopeMatchReviewFacts(
  facts: MatchReviewFacts,
  playerIds: string[],
): MatchReviewFacts {
  const requested = new Set(playerIds.map((value) => value.trim()).filter(Boolean));
  if (!requested.size) return facts;

  const players = facts.players.filter((player) => requested.has(player.playerId));
  const scopedIds = new Set(players.map((player) => player.playerId));
  const vehicles = filterPlayerFacts(facts.vehicles, scopedIds) ?? [];
  const heavyWeapons = filterPlayerFacts(facts.heavyWeapons, scopedIds) ?? [];
  const scopedPlayers = players.map((player) => ({
    ...player,
    keyOperations: player.keyOperations.filter((operation) => scopedIds.has(operation.playerId)),
    ...(player.vehicle && scopedIds.has(player.vehicle.playerId)
      ? { vehicle: player.vehicle }
      : {}),
    heavyWeapons: heavyWeapons.filter((weapon) => weapon.playerId === player.playerId),
  }));
  const fights = facts.fights.filter(
    (fight) =>
      fight.participants.some((id) => scopedIds.has(id)) ||
      fight.keyPlayers.some((id) => scopedIds.has(id)),
  );
  const combatEvents = facts.combat.events.filter(
    (event) => scopedIds.has(event.actorId ?? '') || scopedIds.has(event.victimId ?? ''),
  );
  const relevantCombat = dedupeRelevantCombatEvents(combatEvents, scopedIds);
  const trackedCombat = relevantCombat.filter(
    (event) => isTrackedOffensiveEvent(event, scopedIds) || isTrackedReviveEvent(event, scopedIds),
  );
  const opponentCombat = relevantCombat.filter(
    (event) =>
      isOpponentOffensiveEvent(event, scopedIds) || isOpponentReviveEvent(event, scopedIds),
  );
  const combat =
    facts.combat.events.length === 0
      ? facts.combat
      : {
          ...facts.combat,
          eventCount: relevantCombat.length,
          damage: trackedCombat
            .filter((event) => event.type === 'DAMAGE')
            .reduce((sum, event) => sum + event.damage, 0),
          knocks: trackedCombat.filter((event) => event.type === 'KNOCK').length,
          kills: trackedCombat.filter((event) => event.type === 'KILL').length,
          revives: trackedCombat.filter((event) => event.type === 'REVIVE').length,
          opponentDamage: opponentCombat
            .filter((event) => event.type === 'DAMAGE')
            .reduce((sum, event) => sum + event.damage, 0),
          opponentKnocks: opponentCombat.filter((event) => event.type === 'KNOCK').length,
          opponentKills: opponentCombat.filter((event) => event.type === 'KILL').length,
          opponentRevives: opponentCombat.filter((event) => event.type === 'REVIVE').length,
          events: combatEvents,
        };
  const teamDamage = filterActorVictimFacts(facts.teamDamage, scopedIds);
  const teamVehicleEvents = filterActorVictimFacts(facts.teamVehicleEvents, scopedIds);
  const flash = filterPlayerFacts(facts.flash, scopedIds);
  const stunGuns = filterPlayerFacts(facts.stunGuns, scopedIds);
  const recovery = filterPlayerFacts(facts.recovery, scopedIds);
  const loot = filterPlayerFacts(facts.loot, scopedIds);
  const lootActivity = filterPlayerFacts(facts.lootActivity, scopedIds);
  const vehicleTrunk = filterPlayerFacts(facts.vehicleTrunk, scopedIds);
  const environment = filterPlayerFacts(facts.environment, scopedIds);
  const vehicleImpacts = filterPlayerFacts(facts.vehicleImpacts, scopedIds);
  const armorBreaks = facts.armorBreaks?.filter(
    (fact) =>
      scopedIds.has(fact.actorPlayerId) ||
      (fact.victimPlayerId !== null && scopedIds.has(fact.victimPlayerId)),
  );
  const specialEvents = facts.specialEvents.filter(
    (event) => !event.playerId || scopedIds.has(event.playerId),
  );
  const squad: ReviewSquadSummary = {
    ...facts.squad,
    playerIds: scopedPlayers.map((player) => player.playerId),
    kills: scopedPlayers.reduce((sum, player) => sum + player.kills, 0),
    assists: scopedPlayers.reduce((sum, player) => sum + player.assists, 0),
    damage: scopedPlayers.reduce((sum, player) => sum + player.damage, 0),
    knocks: scopedPlayers.reduce((sum, player) => sum + player.dbnos, 0),
    revives: scopedPlayers.reduce((sum, player) => sum + player.revives, 0),
  };
  const scopedEvidenceIds = new Set<string>([
    `match-summary-${facts.match.matchId}`,
    ...scopedPlayers.map((player) => `player-summary-${facts.match.matchId}-${player.playerId}`),
  ]);
  const addEvidenceIds = (values: Array<{ evidenceIds: string[] }> | undefined): void => {
    for (const value of values ?? [])
      for (const evidenceId of value.evidenceIds) scopedEvidenceIds.add(evidenceId);
  };
  addEvidenceIds(scopedPlayers.flatMap((player) => player.keyOperations));
  addEvidenceIds(fights);
  addEvidenceIds(vehicles);
  addEvidenceIds(heavyWeapons);
  addEvidenceIds(teamDamage);
  addEvidenceIds(teamVehicleEvents);
  addEvidenceIds(flash);
  addEvidenceIds(stunGuns);
  addEvidenceIds(recovery);
  addEvidenceIds(loot);
  addEvidenceIds(lootActivity);
  addEvidenceIds(vehicleTrunk);
  addEvidenceIds(environment);
  addEvidenceIds(armorBreaks);
  addEvidenceIds(vehicleImpacts);
  addEvidenceIds(specialEvents);
  const relevantEventIds = new Set(combatEvents.map((event) => event.id));
  return {
    ...facts,
    squad,
    players: scopedPlayers,
    combat,
    fights,
    weapons: filterPlayerFacts(facts.weapons, scopedIds) ?? [],
    vehicles,
    heavyWeapons,
    specialEvents,
    ...(teamDamage === undefined ? {} : { teamDamage }),
    ...(teamVehicleEvents === undefined ? {} : { teamVehicleEvents }),
    ...(flash === undefined ? {} : { flash }),
    ...(stunGuns === undefined ? {} : { stunGuns }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(loot === undefined ? {} : { loot }),
    ...(lootActivity === undefined ? {} : { lootActivity }),
    ...(vehicleTrunk === undefined ? {} : { vehicleTrunk }),
    ...(environment === undefined ? {} : { environment }),
    ...(armorBreaks === undefined ? {} : { armorBreaks }),
    ...(vehicleImpacts === undefined ? {} : { vehicleImpacts }),
    evidence: facts.evidence.filter(
      (item) =>
        scopedEvidenceIds.has(item.id) ||
        item.eventIds.some((eventId) => relevantEventIds.has(eventId)),
    ),
  };
}

function normalizedReviewCategory(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function categoryRequested(categories: Set<string>, ...names: string[]): boolean {
  return categories.has('all') || names.some((name) => categories.has(name));
}

/**
 * Keep the match/player summary stable while allowing callers to bound the
 * expensive Telemetry fact groups returned by the review tool.
 */
export function selectMatchReviewFactCategories(
  facts: MatchReviewFacts,
  categories?: string[],
): MatchReviewFacts {
  if (!categories?.length) return facts;
  const requested = new Set(categories.map(normalizedReviewCategory).filter(Boolean));
  const combat = categoryRequested(requested, 'combat', 'events')
    ? facts.combat
    : {
        ...facts.combat,
        eventCount: 0,
        damage: 0,
        knocks: 0,
        kills: 0,
        revives: 0,
        opponentDamage: 0,
        opponentKnocks: 0,
        opponentKills: 0,
        opponentRevives: 0,
        events: [],
      };
  const includeVehicles = categoryRequested(requested, 'vehicles', 'vehicle');
  const includeHeavyWeapons = categoryRequested(
    requested,
    'heavy_weapons',
    'heavy_weapon',
    'heavy',
  );
  return {
    ...facts,
    players: facts.players.map((player) => {
      const { vehicle, heavyWeapons, ...summary } = player;
      return {
        ...summary,
        ...(includeVehicles && vehicle ? { vehicle } : {}),
        heavyWeapons: includeHeavyWeapons ? heavyWeapons : [],
      };
    }),
    combat,
    fights: categoryRequested(requested, 'fights', 'fight') ? facts.fights : [],
    weapons: categoryRequested(requested, 'weapons', 'weapon') ? facts.weapons : [],
    vehicles: includeVehicles ? facts.vehicles : [],
    heavyWeapons: includeHeavyWeapons ? facts.heavyWeapons : [],
    specialEvents: categoryRequested(requested, 'special_events', 'special_event', 'highlights')
      ? facts.specialEvents
      : [],
    evidence: categoryRequested(requested, 'evidence', 'sources') ? facts.evidence : [],
    ...(facts.teamDamage !== undefined
      ? {
          teamDamage: categoryRequested(requested, 'team_damage', 'friendly_fire')
            ? facts.teamDamage
            : [],
        }
      : {}),
    ...(facts.teamVehicleEvents !== undefined
      ? {
          teamVehicleEvents: categoryRequested(
            requested,
            'team_vehicle_events',
            'vehicle_collisions',
          )
            ? facts.teamVehicleEvents
            : [],
        }
      : {}),
    ...(facts.flash !== undefined
      ? { flash: categoryRequested(requested, 'flash', 'flashbang') ? facts.flash : [] }
      : {}),
    ...(facts.stunGuns !== undefined
      ? {
          stunGuns: categoryRequested(requested, 'stun_guns', 'stun_gun', 'taser')
            ? facts.stunGuns
            : [],
        }
      : {}),
    ...(facts.recovery !== undefined
      ? { recovery: categoryRequested(requested, 'recovery', 'healing') ? facts.recovery : [] }
      : {}),
    ...(facts.loot !== undefined
      ? { loot: categoryRequested(requested, 'loot', 'loot_boxes') ? facts.loot : [] }
      : {}),
    ...(facts.lootActivity !== undefined
      ? {
          lootActivity: categoryRequested(requested, 'loot_activity', 'items')
            ? facts.lootActivity
            : [],
        }
      : {}),
    ...(facts.vehicleTrunk !== undefined
      ? {
          vehicleTrunk: categoryRequested(requested, 'vehicle_trunk', 'trunk')
            ? facts.vehicleTrunk
            : [],
        }
      : {}),
    ...(facts.environment !== undefined
      ? {
          environment: categoryRequested(requested, 'environment', 'interactions')
            ? facts.environment
            : [],
        }
      : {}),
    ...(facts.armorBreaks !== undefined
      ? {
          armorBreaks: categoryRequested(requested, 'armor_breaks', 'armor')
            ? facts.armorBreaks
            : [],
        }
      : {}),
    ...(facts.vehicleImpacts !== undefined
      ? {
          vehicleImpacts: categoryRequested(requested, 'vehicle_impacts')
            ? facts.vehicleImpacts
            : [],
        }
      : {}),
  };
}

export function emptyMatchReviewFacts(
  match: NormalizedMatch,
  team: TeamConfig,
  ordinal = 1,
): MatchReviewFacts {
  return extractMatchReviewFacts(match, [], team, ordinal);
}
