import type {
  FunEvent,
  MatchReviewFacts,
  ReviewPlayerFacts,
  SpecialEvent,
  TeamDamageFact,
  TeamVehicleEvent,
  VehicleStats,
} from './types.js';
import { isPunchWeapon } from './telemetry-events.js';

function integer(value: number): string {
  return Math.round(value).toLocaleString('zh-CN');
}

function kilometers(value: number): string {
  return `${(value / 1_000).toFixed(1)}km`;
}

function armorLabel(value: string | null): string {
  const normalized = (value ?? '').toLowerCase();
  if (normalized.includes('head')) return '头盔';
  if (normalized.includes('vest') || normalized.includes('armor')) return '防弹衣';
  return '护甲';
}

function playerName(facts: MatchReviewFacts, playerId: string): string {
  return facts.players.find((player) => player.playerId === playerId)?.playerName ?? playerId;
}

function availableEvidence(facts: MatchReviewFacts): Map<string, { eventIds: string[] }> {
  return new Map(facts.evidence.map((item) => [item.id, item]));
}

/** Turn raw event IDs and derived fact IDs into IDs present in ReviewEvidence. */
export function resolveFunEvidenceIds(facts: MatchReviewFacts, ids: string[]): string[] {
  const evidence = availableEvidence(facts);
  const byEvent = new Map<string, string[]>();
  for (const item of facts.evidence) {
    for (const eventId of item.eventIds) {
      const references = byEvent.get(eventId) ?? [];
      references.push(item.id);
      byEvent.set(eventId, references);
    }
  }
  const resolved: string[] = [];
  for (const id of ids) {
    if (evidence.has(id)) {
      resolved.push(id);
      continue;
    }
    const derived = `evidence-${id}`;
    if (evidence.has(derived)) {
      resolved.push(derived);
      continue;
    }
    resolved.push(...(byEvent.get(id) ?? []));
  }
  return [...new Set(resolved)];
}

function makeFunEvent(
  facts: MatchReviewFacts,
  input: Omit<FunEvent, 'evidenceIds' | 'type'> & { evidenceIds: string[]; type?: string },
): FunEvent | null {
  const factIds = [...new Set(input.factIds.filter(Boolean))];
  const evidenceIds = resolveFunEvidenceIds(facts, input.evidenceIds);
  if (!factIds.length || !evidenceIds.length) return null;
  return {
    ...input,
    type: input.type ?? 'FUN_EVENT',
    factIds,
    evidenceIds,
    funScore: Math.max(0, Math.min(100, Math.round(input.funScore))),
    targetPlayerIds: [...new Set(input.targetPlayerIds)],
    tags: [...new Set(input.tags)],
  };
}

function specialEvent(facts: MatchReviewFacts, event: SpecialEvent): FunEvent | null {
  if (!event.playerId) return null;
  const name = playerName(facts, event.playerId);
  const values = event.facts;
  const pickupEvents = Number(values.pickupEvents ?? 0);
  const shots = Number(values.shots ?? 0);
  const hits = Number(values.hits ?? 0);
  const kills = Number(values.kills ?? 0);
  const descriptors: Partial<
    Record<
      SpecialEvent['type'],
      { type: string; title: string; text: string; score: number; category: string }
    >
  > = {
    ROCKET_UNUSED: {
      type: 'ROCKET_UNUSED',
      title: '🎒 军火收藏家',
      text: `${name}\n火箭筒拾取${pickupEvents}次 · 发射0`,
      score: 72,
      category: 'heavy_weapon',
    },
    ROCKET_MISS: {
      type: 'ROCKET_ALL_MISS',
      title: '🎯 火力支援（理论上）',
      text: `${name}\n火箭筒发射${shots}次 · 未检测到命中`,
      score: 64,
      category: 'heavy_weapon',
    },
    ROCKET_ALL_MISS: {
      type: 'ROCKET_ALL_MISS',
      title: '🎯 火力支援（理论上）',
      text: `${name}\n火箭筒发射${shots}次 · 未检测到命中`,
      score: 64,
      category: 'heavy_weapon',
    },
    ROCKET_MULTI_KILL: {
      type: 'ROCKET_MULTI_KILL',
      title: '💥 一炮多响',
      text: `${name}\n一发火箭筒关联${kills}次击杀`,
      score: Math.min(99, 82 + kills * 4),
      category: 'heavy_weapon',
    },
    ROCKET_VEHICLE_MULTI_KILL: {
      type: 'ROCKET_VEHICLE_MULTI_KILL',
      title: `☢️ 一炮${kills}响`,
      text: `${name}\nPanzerfaust摧毁载具 · ${kills}杀`,
      score: 100,
      category: 'heavy_weapon',
    },
    ROCKET_VEHICLE_DESTROY: {
      type: 'ROCKET_VEHICLE_DESTROY',
      title: '🚙 火箭筒拆车',
      text: `${name}\nPanzerfaust摧毁${Number(values.vehiclesDestroyed ?? 0)}辆载具`,
      score: 78,
      category: 'heavy_weapon',
    },
    ROCKET_HIT: {
      type: 'ROCKET_HIT',
      title: '🚀 火箭筒开张',
      text: `${name}\n火箭筒${shots}发 · ${hits}次命中记录`,
      score: Math.min(90, 65 + hits * 5),
      category: 'heavy_weapon',
    },
    MULTI_KNOCK: {
      type: 'MULTI_KNOCK',
      title: '⚡ 倒地制造机',
      text: `${name}\n一波团战造成${Number(values.knocks ?? 0)}次倒地`,
      score: Math.min(92, 70 + Number(values.knocks ?? 0) * 5),
      category: 'combat',
    },
    CLUTCH: {
      type: 'CLUTCH',
      title: '🏆 收割现场',
      text: `${name}\n团战内完成${kills}次击杀`,
      score: Math.min(94, 76 + kills * 5),
      category: 'combat',
    },
    REVIVE_CHAIN: {
      type: 'REVIVE_CHAIN',
      title: '❤️ 急救站站长',
      text: `${name}\n连续完成${Number(values.revives ?? 0)}次救援`,
      score: Math.min(86, 55 + Number(values.revives ?? 0) * 6),
      category: 'support',
    },
    VEHICLE_DESTROY: {
      type: 'VEHICLE_DESTROY',
      title: '🚙 车库拆迁队',
      text: `${name}\n摧毁${Number(values.vehiclesDestroyed ?? 0)}辆载具`,
      score: Math.min(90, 64 + Number(values.vehiclesDestroyed ?? 0) * 8),
      category: 'vehicle',
    },
  };
  const descriptor = descriptors[event.type];
  if (!descriptor) return null;
  return makeFunEvent(facts, {
    id: `fun-event-${event.id}`,
    type: descriptor.type,
    ...(event.playerId ? { actorPlayerId: event.playerId } : {}),
    targetPlayerIds: [],
    factIds: [event.id],
    evidenceIds: [`evidence-${event.id}`, ...event.evidenceIds],
    confidence: 'DERIVED',
    funScore: descriptor.score,
    category: descriptor.category,
    title: descriptor.title,
    text: descriptor.text,
    facts: event.facts,
    tags: ['special_event', descriptor.category],
    dedupGroup: `special:${event.type}`,
  });
}

function vehicleEvent(
  facts: MatchReviewFacts,
  vehicle: VehicleStats,
  type: string,
  title: string,
  text: string,
  score: number,
  tags: string[],
): FunEvent | null {
  const factId = vehicle.id ?? `vehicle-${vehicle.playerId}`;
  return makeFunEvent(facts, {
    id: `fun-event-vehicle-${type}-${vehicle.playerId}`,
    actorPlayerId: vehicle.playerId,
    targetPlayerIds: [],
    factIds: [factId],
    evidenceIds: vehicle.evidenceIds,
    confidence: 'DERIVED',
    funScore: score,
    category: 'vehicle',
    title,
    text,
    facts: {
      rideDistance: Math.round(vehicle.rideDistance),
      driveDistance: Math.round(vehicle.driveDistance),
      maxSpeed: Math.round(vehicle.maxSpeed),
    },
    tags: ['vehicle', ...tags],
    dedupGroup: 'vehicle-travel',
  });
}

function aggregateTeamDamage(
  facts: MatchReviewFacts,
  source: TeamDamageFact['source'],
): FunEvent[] {
  const byActor = new Map<string, TeamDamageFact[]>();
  for (const fact of facts.teamDamage ?? []) {
    if (fact.source !== source) continue;
    const bucket = byActor.get(fact.actorPlayerId) ?? [];
    bucket.push(fact);
    byActor.set(fact.actorPlayerId, bucket);
  }
  const events: FunEvent[] = [];
  for (const [actorId, actorFacts] of byActor) {
    // A melee bucket can contain punches and weapon strikes. Generate the
    // punch event from confirmed fist hits only, so a pan hit is never shown
    // as another punch.
    const factGroups =
      source === 'MELEE'
        ? [
            actorFacts.filter((fact) =>
              isPunchWeapon(fact.weapon ?? null, fact.damageTypeCategory ?? null),
            ),
            actorFacts.filter(
              (fact) => !isPunchWeapon(fact.weapon ?? null, fact.damageTypeCategory ?? null),
            ),
          ]
        : [actorFacts];
    for (const factsForEvent of factGroups) {
      const totalHits = factsForEvent.reduce((sum, fact) => sum + fact.hitCount, 0);
      const totalDamage = factsForEvent.reduce((sum, fact) => sum + fact.damage, 0);
      if (totalHits <= 0) continue;
      const isPunching =
        source === 'MELEE' &&
        factsForEvent.every((fact) =>
          isPunchWeapon(fact.weapon ?? null, fact.damageTypeCategory ?? null),
        );
      const targetText = factsForEvent
        .slice()
        .sort(
          (left, right) =>
            right.hitCount - left.hitCount ||
            left.victimPlayerId.localeCompare(right.victimPlayerId),
        )
        .map(
          (fact) =>
            `${playerName(facts, fact.victimPlayerId)} ${fact.hitCount}${isPunching ? '拳' : '次'}`,
        )
        .join(' · ');
      const phase = factsForEvent[0]?.phase;
      const phasePrefix = phase === 'pre_match' ? '赛前' : phase === 'in_match' ? '正赛' : '';
      const descriptor =
        source === 'MELEE'
          ? isPunching
            ? {
                type: 'TEAMMATE_PUNCHING',
                title: '🥊 队内拳王',
                text: `${playerName(facts, actorId)}\n${phasePrefix}给${targetText}`,
                score: Math.min(78, 28 + totalHits * 8),
                category: 'teammate',
              }
            : {
                type: 'TEAM_MELEE_DAMAGE',
                title: '🥊 队内近战',
                text: `${playerName(facts, actorId)}\n对队友造成${integer(totalDamage)}点近战伤害`,
                score: Math.min(64, 24 + totalDamage / 10),
                category: 'teammate',
              }
          : source === 'GUN'
            ? {
                type: 'TEAM_GUN_DAMAGE',
                title: '🔫 队友误伤',
                text: `${playerName(facts, actorId)}\n对队友造成${integer(totalDamage)}点枪械伤害`,
                score: Math.min(70, 25 + totalDamage / 10),
                category: 'teammate',
              }
            : source === 'EXPLOSIVE'
              ? {
                  type: 'TEAM_EXPLOSIVE_DAMAGE',
                  title: '💣 队内爆破',
                  text: `${playerName(facts, actorId)}\n对队友造成${integer(totalDamage)}点爆炸伤害`,
                  score: Math.min(76, 30 + totalDamage / 8),
                  category: 'teammate',
                }
              : {
                  type: 'TEAM_VEHICLE_DAMAGE',
                  title: '🚗 车辆误伤',
                  text: `对队友造成${integer(totalDamage)}点车辆伤害`,
                  score: Math.min(68, 28 + totalDamage / 10),
                  category: 'vehicle',
                };
      const confirmedDriver =
        source !== 'VEHICLE' ||
        (facts.teamVehicleEvents ?? []).some(
          (item) =>
            item.actorPlayerId === actorId &&
            item.driverConfirmed &&
            factsForEvent.some(
              (fact) => !fact.vehicleId || !item.vehicleId || fact.vehicleId === item.vehicleId,
            ),
        );
      const event = makeFunEvent(facts, {
        id: `fun-event-team-damage-${source}-${actorId}-${isPunching ? 'punch' : 'other'}`,
        type: descriptor.type,
        ...(source === 'VEHICLE' && !confirmedDriver ? {} : { actorPlayerId: actorId }),
        targetPlayerIds: factsForEvent.map((fact) => fact.victimPlayerId),
        factIds: factsForEvent.map((fact) => fact.id),
        evidenceIds: factsForEvent.flatMap((fact) => [`evidence-${fact.id}`, ...fact.evidenceIds]),
        confidence: 'CONFIRMED',
        funScore: descriptor.score,
        category: descriptor.category,
        title: descriptor.title,
        text: descriptor.text,
        facts: {
          hitCount: totalHits,
          damage: Math.round(totalDamage),
          source,
          ...(phase ? { phase } : {}),
          ...(source === 'VEHICLE' ? { driverConfirmed: confirmedDriver } : {}),
        },
        tags: ['team_damage', source.toLowerCase(), ...(isPunching ? ['punching'] : [])],
        dedupGroup: `team-damage:${source}:${isPunching ? 'punch' : 'other'}:${actorId}`,
      });
      if (event) events.push(event);
    }
  }
  return events;
}

function teamVehicleEvents(facts: MatchReviewFacts): FunEvent[] {
  const grouped = new Map<string, TeamVehicleEvent[]>();
  for (const item of facts.teamVehicleEvents ?? []) {
    const key = `${item.driverConfirmed ? item.actorPlayerId : 'unknown'}:${item.type}:${item.phase ?? 'unknown'}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }
  const result: FunEvent[] = [];
  for (const [key, items] of grouped) {
    const actorId = items[0]?.actorPlayerId;
    const driverConfirmed = items.every((item) => item.driverConfirmed);
    const hits = items.filter((item) => item.type === 'HIT');
    const knocks = items.filter((item) => item.type === 'KNOCK');
    const kills = items.filter((item) => item.type === 'KILL');
    const targetIds = [...new Set(items.map((item) => item.victimPlayerId))];
    const semanticType = items[0]?.type ?? 'HIT';
    const count = items.length;
    const detailText = items
      .slice()
      .sort((left, right) => left.victimPlayerId.localeCompare(right.victimPlayerId))
      .map((item) => playerName(facts, item.victimPlayerId))
      .join('、');
    const confirmedText =
      semanticType === 'HIT'
        ? `开车蹭到${detailText || '队友'} ${count}次`
        : semanticType === 'KNOCK'
          ? `开车撞倒${detailText || '队友'} ${count}人`
          : `开车撞死${detailText || '队友'} ${count}人`;
    const uncertainText =
      semanticType === 'HIT'
        ? `车辆对${detailText || '队友'}造成 ${count} 次碰撞伤害`
        : semanticType === 'KNOCK'
          ? `车辆撞倒队友${detailText || ''} ${count}人`
          : `车辆撞死队友${detailText || ''} ${count}人`;
    const title = driverConfirmed
      ? '🚗 肇事司机'
      : semanticType === 'HIT'
        ? '🚗 车辆误伤'
        : '🚗 车辆事故';
    const event = makeFunEvent(facts, {
      id: `fun-event-vehicle-team-${key.replace(/[^a-z0-9:_-]/giu, '_')}`,
      type: `VEHICLE_TEAM_${semanticType}`,
      ...(driverConfirmed && actorId ? { actorPlayerId: actorId } : {}),
      targetPlayerIds: targetIds,
      factIds: items.map((item) => item.id),
      evidenceIds: items.flatMap((item) => [`evidence-${item.id}`, ...item.evidenceIds]),
      confidence: 'CONFIRMED',
      funScore: Math.min(100, 58 + knocks.length * 14 + kills.length * 24 + hits.length * 4),
      category: 'vehicle',
      title,
      text:
        driverConfirmed && actorId
          ? `${playerName(facts, actorId)}\n${confirmedText}`
          : uncertainText,
      facts: {
        hits: hits.length,
        knocks: knocks.length,
        kills: kills.length,
        driverConfirmed,
        ...(items[0]?.phase ? { phase: items[0].phase } : {}),
      },
      tags: [
        'vehicle',
        'team_damage',
        ...(driverConfirmed ? ['driver_confirmed'] : ['driver_unconfirmed']),
      ],
      dedupGroup: `vehicle-team:${semanticType}:${driverConfirmed ? (actorId ?? 'unknown') : 'unknown'}`,
      suppresses: ['TEAM_VEHICLE_DAMAGE'],
    });
    if (event) result.push(event);
  }
  return result;
}

function flashEvents(facts: MatchReviewFacts): FunEvent[] {
  return (facts.flash ?? [])
    .filter((item) => item.uses > 0)
    .map((item) =>
      makeFunEvent(facts, {
        id: `fun-event-flash-${item.playerId}`,
        type: 'FLASH_USED',
        actorPlayerId: item.playerId,
        targetPlayerIds: [],
        factIds: [item.id ?? `flash-${item.playerId}`],
        evidenceIds: [`evidence-flash-${item.playerId}`, ...item.evidenceIds],
        confidence: 'CONFIRMED',
        funScore: Math.min(80, 35 + item.uses * 7),
        category: 'utility',
        title: '💡 灯光师',
        text: `${playerName(facts, item.playerId)}\n本局使用${item.uses}颗闪光弹`,
        facts: { uses: item.uses },
        tags: ['flash', 'utility'],
        dedupGroup: `flash-use:${item.playerId}`,
      }),
    )
    .filter((item): item is FunEvent => item !== null);
}

function stunGunEvents(facts: MatchReviewFacts): FunEvent[] {
  return (facts.stunGuns ?? [])
    .filter((item) => item.pickups > 0 || item.shots > 0)
    .map((item) =>
      makeFunEvent(facts, {
        id: `fun-event-stun-gun-${item.playerId}`,
        type: 'STUN_GUN_USED',
        actorPlayerId: item.playerId,
        targetPlayerIds: [],
        factIds: [item.id],
        evidenceIds: [`evidence-${item.id}`, ...item.evidenceIds],
        confidence: 'CONFIRMED',
        funScore: Math.min(80, 40 + item.shots * 12 + item.confirmedHits * 12),
        category: 'utility',
        title: '⚡ 电击枪出场',
        text: `${playerName(facts, item.playerId)}\n拾取${item.pickups}次 · 开火${item.shots}次 · ${item.confirmedHits > 0 ? `确认命中${item.confirmedHits}次` : '未确认命中对象'}`,
        facts: {
          pickups: item.pickups,
          shots: item.shots,
          confirmedHits: item.confirmedHits,
          teammateHits: item.teammateHits,
          enemyHits: item.enemyHits,
          unknownOutcomes: item.unknownOutcomes,
        },
        tags: ['stun_gun', 'utility'],
        dedupGroup: `stun-gun:${item.playerId}`,
      }),
    )
    .filter((item): item is FunEvent => item !== null);
}

function vehicleImpactEvents(facts: MatchReviewFacts): FunEvent[] {
  return (facts.vehicleImpacts ?? [])
    .filter((item) => item.wheelsDestroyed >= 3 || item.vehicleDestroyed > 0)
    .map((item) =>
      makeFunEvent(facts, {
        id: `fun-event-vehicle-impact-${item.id}`,
        type: item.wheelsDestroyed >= 4 ? 'VEHICLE_FOUR_WHEELS' : 'VEHICLE_IMPACT_CHAIN',
        actorPlayerId: item.playerId,
        targetPlayerIds: [],
        factIds: [item.id],
        evidenceIds: [`evidence-${item.id}`, ...item.evidenceIds],
        confidence: 'CONFIRMED',
        funScore: Math.min(
          100,
          70 + item.wheelsDestroyed * 5 + item.vehicleDestroyed * 8 + item.knocks * 4,
        ),
        category: 'vehicle',
        title: item.wheelsDestroyed >= 4 ? '☢️ 一炮四轮' : '🚗 拆车连招',
        text: `${playerName(facts, item.playerId)}\n${item.wheelsDestroyed > 0 ? `摧毁${item.wheelsDestroyed}个轮胎` : ''}${item.vehicleDamage > 0 ? ` · ${Math.round(item.vehicleDamage)}载具伤害` : ''}${item.playerDamage > 0 ? ` · ${Math.round(item.playerDamage)}人体伤害` : ''}${item.knocks > 0 ? ` · ${item.knocks}倒地` : ''}${item.vehicleDestroyed > 0 ? ' · 载具被摧毁' : ''}`,
        facts: {
          wheelsDestroyed: item.wheelsDestroyed,
          vehicleDamage: Math.round(item.vehicleDamage),
          playerDamage: Math.round(item.playerDamage),
          knocks: item.knocks,
          kills: item.kills,
          vehicleDestroyed: item.vehicleDestroyed,
        },
        tags: ['vehicle', 'impact_chain', ...(item.wheelsDestroyed >= 4 ? ['four_wheels'] : [])],
        dedupGroup: 'vehicle-impact-chain',
      }),
    )
    .filter((item): item is FunEvent => item !== null);
}

function armorBreakEvents(facts: MatchReviewFacts): FunEvent[] {
  return (facts.armorBreaks ?? [])
    .filter((item) => item.followUp !== null)
    .map((item) =>
      makeFunEvent(facts, {
        id: `fun-event-armor-break-${item.id}`,
        type: 'ARMOR_BREAK_FOLLOW_UP',
        actorPlayerId: item.actorPlayerId,
        targetPlayerIds: item.victimPlayerId ? [item.victimPlayerId] : [],
        factIds: [item.id],
        evidenceIds: [`evidence-${item.id}`, ...item.evidenceIds],
        confidence: 'CONFIRMED',
        funScore: item.followUp === 'KILL' ? 88 : 76,
        category: 'combat',
        title:
          item.followUp === 'KILL'
            ? `🎯 破${armorLabel(item.armorSlot)}后击杀`
            : `🎯 破${armorLabel(item.armorSlot)}后击倒`,
        text: `${playerName(facts, item.actorPlayerId)}\n${item.weapon ?? '攻击'}破${armorLabel(item.armorSlot)}后${item.followUp === 'KILL' ? '完成击杀' : '造成倒地'}`,
        facts: {
          armorItem: item.armorItem,
          armorSlot: item.armorSlot,
          weapon: item.weapon,
          followUp: item.followUp,
          distanceMeters: item.distanceMeters,
        },
        tags: ['armor_break', 'follow_up'],
        dedupGroup: `armor-break-follow-up:${item.actorPlayerId}`,
      }),
    )
    .filter((item): item is FunEvent => item !== null);
}

function vehicleEvents(facts: MatchReviewFacts): FunEvent[] {
  const vehicles = facts.vehicles.filter((item) => item.evidenceIds.length > 0);
  const result: FunEvent[] = [];
  const drivers = vehicles
    .filter((item) => item.driverConfirmed && item.driveDistance > 0)
    .sort(
      (left, right) =>
        right.driveDistance - left.driveDistance || left.playerId.localeCompare(right.playerId),
    );
  const driver = drivers[0];
  if (driver) {
    const event = vehicleEvent(
      facts,
      driver,
      'top-driver',
      '🚕 滴滴司机',
      `${playerName(facts, driver.playerId)}\n驾驶${kilometers(driver.driveDistance)} · 最高${Math.round(driver.maxSpeed)}km/h`,
      Math.min(82, 45 + driver.driveDistance / 1_000),
      ['driver'],
    );
    if (event) result.push({ ...event, type: 'TOP_DRIVER', dedupGroup: 'vehicle-travel' });
  }
  const passengers = vehicles
    .filter((item) => item.passengerConfirmed && item.rideDistance > 0)
    .sort(
      (left, right) =>
        right.rideDistance - left.rideDistance || left.playerId.localeCompare(right.playerId),
    );
  const passenger = passengers[0];
  if (passenger) {
    const event = vehicleEvent(
      facts,
      passenger,
      'top-passenger',
      '🛋 尊贵乘客',
      `${playerName(facts, passenger.playerId)}\n乘车${kilometers(passenger.rideDistance)}`,
      Math.min(76, 40 + passenger.rideDistance / 1_000),
      ['passenger'],
    );
    if (event) result.push({ ...event, type: 'TOP_PASSENGER' });
  }
  const longest = [...vehicles]
    .filter((item) => item.rideDistance >= 1_000)
    .sort(
      (left, right) =>
        right.rideDistance - left.rideDistance || left.playerId.localeCompare(right.playerId),
    )[0];
  if (longest) {
    const event = vehicleEvent(
      facts,
      longest,
      'longest-ride',
      '🚌 公路旅行家',
      `${playerName(facts, longest.playerId)}\n乘车${kilometers(longest.rideDistance)}`,
      Math.min(68, 30 + longest.rideDistance / 2_000),
      ['ride'],
    );
    if (event) result.push({ ...event, type: 'LONGEST_RIDE' });
  }
  return result;
}

function playerEvents(facts: MatchReviewFacts): FunEvent[] {
  const players = facts.players.filter((player) => player.matchPresence !== 'not_recorded');
  const result: FunEvent[] = [];
  const teamDamage = facts.squad.damage;
  const summaryEvidence = (player: ReviewPlayerFacts): string[] => [
    `player-summary-${facts.match.matchId}-${player.playerId}`,
  ];
  const topDamage = [...players].sort(
    (left, right) => right.damage - left.damage || left.playerId.localeCompare(right.playerId),
  )[0];
  if (topDamage && topDamage.damage >= Math.max(300, teamDamage * 0.4)) {
    const event = makeFunEvent(facts, {
      id: `fun-event-high-damage-${topDamage.playerId}`,
      type: 'HIGH_DAMAGE',
      actorPlayerId: topDamage.playerId,
      targetPlayerIds: [],
      factIds: [`player-summary-${facts.match.matchId}-${topDamage.playerId}`],
      evidenceIds: summaryEvidence(topDamage),
      confidence: 'DERIVED',
      funScore: Math.min(75, 40 + topDamage.damage / 50),
      category: 'combat',
      title: '💥 火力压制',
      text: `${topDamage.playerName}\n${integer(topDamage.damage)}伤害`,
      facts: { damage: Math.round(topDamage.damage) },
      tags: ['combat', 'damage'],
      dedupGroup: `damage-output:${topDamage.playerId}`,
    });
    if (event) result.push(event);
  }
  for (const player of players) {
    if (player.damage >= 500 && player.kills <= 1) {
      const event = makeFunEvent(facts, {
        id: `fun-event-high-damage-low-kills-${player.playerId}`,
        type: 'HIGH_DAMAGE_LOW_KILLS',
        actorPlayerId: player.playerId,
        targetPlayerIds: [],
        factIds: [`player-summary-${facts.match.matchId}-${player.playerId}`],
        evidenceIds: summaryEvidence(player),
        confidence: 'DERIVED',
        funScore: Math.min(88, 65 + player.damage / 100),
        category: 'combat',
        title: '📈 数据刷子',
        text: `${player.playerName}\n${integer(player.damage)}伤害 · ${player.kills}杀`,
        facts: { damage: Math.round(player.damage), kills: player.kills },
        tags: ['combat', 'damage', 'low_kills'],
        dedupGroup: `damage-output:${player.playerId}`,
        suppresses: ['HIGH_DAMAGE'],
      });
      if (event) result.push(event);
    }
    if (player.kills >= 2 && player.damage <= Math.max(250, teamDamage * 0.18)) {
      const event = makeFunEvent(facts, {
        id: `fun-event-low-damage-high-kills-${player.playerId}`,
        type: 'LOW_DAMAGE_HIGH_KILLS',
        actorPlayerId: player.playerId,
        targetPlayerIds: [],
        factIds: [`player-summary-${facts.match.matchId}-${player.playerId}`],
        evidenceIds: summaryEvidence(player),
        confidence: 'DERIVED',
        funScore: Math.min(88, 70 + player.kills * 4),
        category: 'combat',
        title: '🧹 收割机',
        text: `${player.playerName}\n${integer(player.damage)}伤害 · ${player.kills}杀`,
        facts: { damage: Math.round(player.damage), kills: player.kills },
        tags: ['combat', 'low_damage', 'kills'],
        dedupGroup: `damage-output:${player.playerId}`,
      });
      if (event) result.push(event);
    }
    if (player.dbnos >= 3 && player.kills / player.dbnos <= 0.4) {
      const event = makeFunEvent(facts, {
        id: `fun-event-knock-conversion-${player.playerId}`,
        type: 'HIGH_KNOCK_LOW_KILL_CONVERSION',
        actorPlayerId: player.playerId,
        targetPlayerIds: [],
        factIds: [`player-summary-${facts.match.matchId}-${player.playerId}`],
        evidenceIds: summaryEvidence(player),
        confidence: 'DERIVED',
        funScore: Math.min(86, 52 + player.dbnos * 5),
        category: 'combat',
        title: '🫠 白打王',
        text: `${player.playerName}\n${player.dbnos}倒地 · ${player.kills}杀`,
        facts: { dbnos: player.dbnos, kills: player.kills },
        tags: ['combat', 'knocks', 'conversion'],
        dedupGroup: `knock-conversion:${player.playerId}`,
      });
      if (event) result.push(event);
    }
    if (
      player.kills === 0 &&
      player.assists === 0 &&
      player.dbnos === 0 &&
      player.revives === 0 &&
      player.damage === 0 &&
      player.keyOperations.length === 0
    ) {
      const event = makeFunEvent(facts, {
        id: `fun-event-no-combat-${player.playerId}`,
        type: 'NO_COMBAT_PRESENCE',
        actorPlayerId: player.playerId,
        targetPlayerIds: [],
        factIds: [`player-summary-${facts.match.matchId}-${player.playerId}`],
        evidenceIds: summaryEvidence(player),
        confidence: 'DERIVED',
        funScore: 58,
        category: 'combat',
        title: '👻 全场隐身',
        text: `${player.playerName}\n0杀 · 0助 · 0倒地 · 0救援 · 0伤害`,
        facts: { kills: 0, assists: 0, dbnos: 0, revives: 0, damage: 0 },
        tags: ['combat', 'no_presence'],
        dedupGroup: `combat-presence:${player.playerId}`,
      });
      if (event) result.push(event);
    }
  }
  const topRevives = [...players].sort(
    (left, right) => right.revives - left.revives || left.playerId.localeCompare(right.playerId),
  )[0];
  const secondRevives = [...players].sort(
    (left, right) => right.revives - left.revives || left.playerId.localeCompare(right.playerId),
  )[1];
  if (topRevives && topRevives.revives >= 2 && topRevives.revives > (secondRevives?.revives ?? 0)) {
    const event = makeFunEvent(facts, {
      id: `fun-event-most-revives-${topRevives.playerId}`,
      type: 'MOST_REVIVES',
      actorPlayerId: topRevives.playerId,
      targetPlayerIds: [],
      factIds: [`player-summary-${facts.match.matchId}-${topRevives.playerId}`],
      evidenceIds: summaryEvidence(topRevives),
      confidence: 'DERIVED',
      funScore: Math.min(82, 48 + topRevives.revives * 7),
      category: 'support',
      title: '🩺 战地医生',
      text: `${topRevives.playerName}\n${topRevives.revives}次救援`,
      facts: { revives: topRevives.revives },
      tags: ['support', 'revive'],
      dedupGroup: `support-ranking:revives:${topRevives.playerId}`,
    });
    if (event) result.push(event);
  }
  const topAssists = [...players].sort(
    (left, right) => right.assists - left.assists || left.playerId.localeCompare(right.playerId),
  )[0];
  const secondAssists = [...players].sort(
    (left, right) => right.assists - left.assists || left.playerId.localeCompare(right.playerId),
  )[1];
  if (topAssists && topAssists.assists >= 2 && topAssists.assists > (secondAssists?.assists ?? 0)) {
    const event = makeFunEvent(facts, {
      id: `fun-event-most-assists-${topAssists.playerId}`,
      type: 'MOST_ASSISTS',
      actorPlayerId: topAssists.playerId,
      targetPlayerIds: [],
      factIds: [`player-summary-${facts.match.matchId}-${topAssists.playerId}`],
      evidenceIds: summaryEvidence(topAssists),
      confidence: 'DERIVED',
      funScore: Math.min(78, 44 + topAssists.assists * 6),
      category: 'support',
      title: '🤝 真兄弟',
      text: `${topAssists.playerName}\n${topAssists.assists}次助攻`,
      facts: { assists: topAssists.assists },
      tags: ['support', 'assist'],
      dedupGroup: `support-ranking:assists:${topAssists.playerId}`,
    });
    if (event) result.push(event);
  }
  return result;
}

function keyOperationEvents(facts: MatchReviewFacts): FunEvent[] {
  const specialEvents = facts.specialEvents;
  const descriptors: Partial<Record<string, { title: string; category: string; score: number }>> = {
    ENTRY: { title: '🔥 开团发动机', category: 'combat', score: 62 },
    MULTI_KNOCK: { title: '⚡ 倒地制造机', category: 'combat', score: 82 },
    CLUTCH: { title: '🏆 收割现场', category: 'combat', score: 84 },
    TRADE: { title: '🔁 补枪及时', category: 'combat', score: 70 },
    SUPPORT: { title: '🛡️ 火力支援', category: 'support', score: 62 },
    REVIVE: { title: '❤️ 救援及时', category: 'support', score: 70 },
    DAMAGE: { title: '💥 输出担当', category: 'combat', score: 68 },
    VEHICLE: { title: '🚗 载具作战', category: 'vehicle', score: 70 },
    HEAVY_WEAPON: { title: '🚀 重火力出场', category: 'heavy_weapon', score: 74 },
  };
  const result: FunEvent[] = [];
  for (const player of facts.players) {
    for (const operation of player.keyOperations) {
      const descriptor = descriptors[operation.type];
      if (!descriptor) continue;
      const fightId = operation.facts.fightId;
      const coveredBySpecial = specialEvents.some(
        (event) =>
          event.playerId === player.playerId &&
          event.type === operation.type &&
          (fightId === undefined || event.facts.fightId === fightId),
      );
      if (coveredBySpecial) continue;
      const event = makeFunEvent(facts, {
        id: `fun-event-operation-${operation.id}`,
        type: `KEY_OPERATION_${operation.type}`,
        actorPlayerId: player.playerId,
        targetPlayerIds: [],
        factIds: [operation.id],
        evidenceIds: [`evidence-${operation.id}`, ...operation.evidenceIds],
        confidence: 'DERIVED',
        funScore: descriptor.score,
        category: descriptor.category,
        title: descriptor.title,
        text: `${player.playerName}\n${operation.impact}`,
        facts: operation.facts,
        tags: ['key_operation', descriptor.category],
        dedupGroup: `key-operation:${operation.type}:${player.playerId}`,
      });
      if (event) result.push(event);
    }
  }
  return result;
}

/** Generate one structured event per reliable fact pattern; combos are added later. */
export function generateBaseFunEvents(facts: MatchReviewFacts): FunEvent[] {
  return [
    ...facts.specialEvents.map((event) => specialEvent(facts, event)),
    ...aggregateTeamDamage(facts, 'MELEE'),
    ...aggregateTeamDamage(facts, 'GUN'),
    ...aggregateTeamDamage(facts, 'VEHICLE'),
    ...aggregateTeamDamage(facts, 'EXPLOSIVE'),
    ...teamVehicleEvents(facts),
    ...flashEvents(facts),
    ...stunGunEvents(facts),
    ...vehicleImpactEvents(facts),
    ...armorBreakEvents(facts),
    ...vehicleEvents(facts),
    ...playerEvents(facts),
    ...keyOperationEvents(facts),
  ].filter((event): event is FunEvent => event !== null && event.evidenceIds.length > 0);
}

export class FunEventCandidateGenerator {
  generate(facts: MatchReviewFacts): FunEvent[] {
    return generateBaseFunEvents(facts);
  }
}
