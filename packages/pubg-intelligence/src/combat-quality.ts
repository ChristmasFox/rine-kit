import { median, normalizeWeaponName, wilsonInterval, type RateEstimate } from './analytics.js';
import type { BattleReconstructionResult, BattleTelemetryDocument } from './battle.js';

export const COMBAT_QUALITY_SCHEMA_VERSION = 1 as const;

/** Counts for one match; every field is additive so matches merge by summation. */
export interface CombatQualityMatchStats {
  groups: number;
  firstKnockFor: number;
  firstKnockAgainst: number;
  leadHeld: number;
  leadLost: number;
  followUpObserved: number;
  followUpMissed: number;
  followUpSeconds: number[];
  knockedChains: number;
  knockedRevived: number;
  knockedKilled: number;
  reviveSeconds: number[];
  downedChains: number;
  downedFinished: number;
  finishSeconds: number[];
  thirdPartyAgainstUs: number;
  thirdPartyByUs: number;
}

export function emptyCombatQuality(): CombatQualityMatchStats {
  return {
    groups: 0,
    firstKnockFor: 0,
    firstKnockAgainst: 0,
    leadHeld: 0,
    leadLost: 0,
    followUpObserved: 0,
    followUpMissed: 0,
    followUpSeconds: [],
    knockedChains: 0,
    knockedRevived: 0,
    knockedKilled: 0,
    reviveSeconds: [],
    downedChains: 0,
    downedFinished: 0,
    finishSeconds: [],
    thirdPartyAgainstUs: 0,
    thirdPartyByUs: 0,
  };
}

export function analyzeCombatQuality(result: BattleReconstructionResult): CombatQualityMatchStats {
  const stats = emptyCombatQuality();
  const trackedTeams = new Set<string>();
  const trackedPlayers = new Set<string>();
  for (const episode of result.episodes) {
    for (const team of episode.teams) {
      if (!team.tracked || !team.teamRef) continue;
      trackedTeams.add(team.teamRef);
      for (const ref of team.memberRefs) trackedPlayers.add(ref);
    }
  }
  if (!trackedTeams.size) return stats;

  const seenChains = new Set<string>();
  for (const episode of result.episodes) {
    for (const chain of episode.knockChains) {
      if (seenChains.has(chain.knockEventId)) continue;
      seenChains.add(chain.knockEventId);
      const victimOurs =
        chain.knockedPlayerRef !== null && trackedPlayers.has(chain.knockedPlayerRef);
      const attackerOurs = chain.attackerRef !== null && trackedPlayers.has(chain.attackerRef);
      if (victimOurs && !attackerOurs) {
        stats.knockedChains += 1;
        if (chain.outcome === 'REVIVE') {
          stats.knockedRevived += 1;
          if (chain.elapsedSeconds !== null) stats.reviveSeconds.push(chain.elapsedSeconds);
        } else if (chain.outcome === 'KILL') stats.knockedKilled += 1;
      } else if (attackerOurs && !victimOurs) {
        stats.downedChains += 1;
        if (chain.outcome === 'KILL') {
          stats.downedFinished += 1;
          if (chain.elapsedSeconds !== null) stats.finishSeconds.push(chain.elapsedSeconds);
        }
      }
    }
  }

  for (const group of result.battles) {
    if (!group.teamRefs.some((ref) => trackedTeams.has(ref))) continue;
    stats.groups += 1;
    const firstId = group.postKnockResponse.firstKnockEventId;
    const first = firstId
      ? group.timeline.find((event) => event.sourceEventId === firstId)
      : undefined;
    const weFirst = first?.actorTeamRef ? trackedTeams.has(first.actorTeamRef) : false;
    const theyFirst = first?.victimTeamRef ? trackedTeams.has(first.victimTeamRef) : false;
    if (weFirst) {
      stats.firstKnockFor += 1;
      const resolution = group.firstKnockAdvantage?.resolution;
      if (resolution === 'ongoing') stats.leadHeld += 1;
      else if (resolution === 'equalized' || resolution === 'reversed') stats.leadLost += 1;
      if (group.postKnockResponse.status === 'observed') {
        stats.followUpObserved += 1;
        if (group.postKnockResponse.elapsedSeconds !== null)
          stats.followUpSeconds.push(group.postKnockResponse.elapsedSeconds);
      } else if (group.postKnockResponse.status === 'not_observed_in_window')
        stats.followUpMissed += 1;
    } else if (theyFirst) {
      stats.firstKnockAgainst += 1;
    }
    for (const party of group.possibleThirdParty) {
      if (trackedTeams.has(party.teamRef)) stats.thirdPartyByUs += 1;
      else stats.thirdPartyAgainstUs += 1;
    }
  }
  return stats;
}

export interface CombatQualitySummary {
  schemaVersion: typeof COMBAT_QUALITY_SCHEMA_VERSION;
  matches: number;
  groups: number;
  firstKnock: { forUs: number; againstUs: number; ourRate: RateEstimate };
  leadConversion: { held: number; lost: number; heldRate: RateEstimate };
  followUp: { observed: number; missed: number; medianSeconds: number | null };
  revive: {
    knocked: number;
    revived: number;
    killed: number;
    unresolved: number;
    reviveRate: RateEstimate;
    medianSeconds: number | null;
  };
  finish: {
    downed: number;
    finished: number;
    finishRate: RateEstimate;
    medianSeconds: number | null;
  };
  thirdParty: { againstUs: number; byUs: number; againstRate: RateEstimate };
  notes: string[];
}

export function summarizeCombatQuality(
  items: readonly CombatQualityMatchStats[],
): CombatQualitySummary {
  const sum = (pick: (item: CombatQualityMatchStats) => number) =>
    items.reduce((total, item) => total + pick(item), 0);
  const all = (pick: (item: CombatQualityMatchStats) => number[]) => items.flatMap(pick);
  const firstFor = sum((item) => item.firstKnockFor);
  const firstAgainst = sum((item) => item.firstKnockAgainst);
  const held = sum((item) => item.leadHeld);
  const lost = sum((item) => item.leadLost);
  const knocked = sum((item) => item.knockedChains);
  const revived = sum((item) => item.knockedRevived);
  const killed = sum((item) => item.knockedKilled);
  const downed = sum((item) => item.downedChains);
  const finished = sum((item) => item.downedFinished);
  const groups = sum((item) => item.groups);
  const againstUs = sum((item) => item.thirdPartyAgainstUs);
  return {
    schemaVersion: COMBAT_QUALITY_SCHEMA_VERSION,
    matches: items.length,
    groups,
    firstKnock: {
      forUs: firstFor,
      againstUs: firstAgainst,
      ourRate: wilsonInterval(firstFor, firstFor + firstAgainst),
    },
    leadConversion: { held, lost, heldRate: wilsonInterval(held, held + lost) },
    followUp: {
      observed: sum((item) => item.followUpObserved),
      missed: sum((item) => item.followUpMissed),
      medianSeconds: median(all((item) => item.followUpSeconds)),
    },
    revive: {
      knocked,
      revived,
      killed,
      unresolved: knocked - revived - killed,
      reviveRate: wilsonInterval(revived, knocked),
      medianSeconds: median(all((item) => item.reviveSeconds)),
    },
    finish: {
      downed,
      finished,
      finishRate: wilsonInterval(finished, downed),
      medianSeconds: median(all((item) => item.finishSeconds)),
    },
    thirdParty: {
      againstUs,
      byUs: sum((item) => item.thirdPartyByUs),
      againstRate: wilsonInterval(againstUs, groups),
    },
    notes: [
      '只统计已归档遥测中观察到的交战；队伍成员按观察到的事件识别，不推断完整花名册。',
      '「第三方介入」是时间重叠的候选，不代表对方意图；「首倒优势保持」按观察到的倒地数平衡计算。',
      '未解决的倒地链表示窗口内没有观察到救起或击杀。',
    ],
  };
}

export const DEATH_STAGES = ['开局', '中期', '后期', '决赛圈'] as const;
export type DeathStage = (typeof DEATH_STAGES)[number] | '未知';

/** Stage from the number of teams still alive when a squad member died. */
export function deathStageOf(aliveTeams: number | null): DeathStage {
  if (aliveTeams === null) return '未知';
  if (aliveTeams >= 20) return '开局';
  if (aliveTeams >= 10) return '中期';
  if (aliveTeams >= 5) return '后期';
  return '决赛圈';
}

export interface DeathRecord {
  stage: DeathStage;
  weapon: string | null;
  /** Killed while already knocked, i.e. a finishing blow after a knock. */
  afterKnock: boolean;
  /** The whole observed squad was dead after this death. */
  squadWipe: boolean;
}

export function analyzeDeaths(
  telemetry: Pick<BattleTelemetryDocument, 'events' | 'circleSamples'>,
  trackedPlayerIds: readonly string[],
): DeathRecord[] {
  const tracked = new Set(trackedPlayerIds);
  if (!tracked.size) return [];
  const samples = telemetry.circleSamples
    .filter(
      (sample) =>
        sample.phase === 'in_match' && sample.timeSeconds !== null && sample.aliveTeams !== null,
    )
    .sort((left, right) => left.timeSeconds! - right.timeSeconds!);
  const aliveTeamsAt = (time: number | null): number | null => {
    if (time === null) return null;
    let found: number | null = null;
    for (const sample of samples) {
      if (sample.timeSeconds! > time) break;
      found = sample.aliveTeams;
    }
    return found;
  };
  const knocked = new Set(
    telemetry.events
      .filter((event) => event.type === 'KNOCK' && event.victimId && tracked.has(event.victimId))
      .map((event) => `${event.victimId}:${event.dbnoId ?? ''}`),
  );
  const seen = new Set<string>();
  const kills = telemetry.events
    .filter(
      (event) =>
        event.type === 'KILL' &&
        event.victimId !== null &&
        tracked.has(event.victimId) &&
        event.phase !== 'pre_match',
    )
    .sort((left, right) => (left.timeSeconds ?? Infinity) - (right.timeSeconds ?? Infinity));
  const records: DeathRecord[] = [];
  for (const event of kills) {
    if (seen.has(event.victimId!)) continue;
    seen.add(event.victimId!);
    const weapon = event.weaponId ? normalizeWeaponName(event.weaponId) : null;
    records.push({
      stage: deathStageOf(aliveTeamsAt(event.timeSeconds)),
      weapon,
      afterKnock: event.dbnoId !== null && knocked.has(`${event.victimId}:${event.dbnoId}`),
      squadWipe: false,
    });
  }
  if (records.length && records.length >= tracked.size)
    records[records.length - 1]!.squadWipe = true;
  return records;
}

export interface DeathSummary {
  deaths: number;
  afterKnock: { count: number; rate: RateEstimate };
  stages: Array<{ stage: DeathStage; deaths: number; share: number }>;
  wipeStages: Array<{ stage: DeathStage; wipes: number }>;
  weapons: Array<{ weapon: string; deaths: number }>;
  unknownWeapon: number;
}

export function summarizeDeaths(records: readonly DeathRecord[]): DeathSummary {
  const stages = new Map<DeathStage, number>();
  const wipes = new Map<DeathStage, number>();
  const weapons = new Map<string, number>();
  let unknownWeapon = 0;
  for (const record of records) {
    stages.set(record.stage, (stages.get(record.stage) ?? 0) + 1);
    if (record.squadWipe) wipes.set(record.stage, (wipes.get(record.stage) ?? 0) + 1);
    if (record.weapon) weapons.set(record.weapon, (weapons.get(record.weapon) ?? 0) + 1);
    else unknownWeapon += 1;
  }
  const order: DeathStage[] = [...DEATH_STAGES, '未知'];
  const afterKnock = records.filter((record) => record.afterKnock).length;
  return {
    deaths: records.length,
    afterKnock: { count: afterKnock, rate: wilsonInterval(afterKnock, records.length) },
    stages: order
      .filter((stage) => stages.has(stage))
      .map((stage) => ({
        stage,
        deaths: stages.get(stage)!,
        share: stages.get(stage)! / records.length,
      })),
    wipeStages: order
      .filter((stage) => wipes.has(stage))
      .map((stage) => ({ stage, wipes: wipes.get(stage)! })),
    weapons: [...weapons.entries()]
      .map(([weapon, deaths]) => ({ weapon, deaths }))
      .sort((left, right) => right.deaths - left.deaths || left.weapon.localeCompare(right.weapon))
      .slice(0, 8),
    unknownWeapon,
  };
}
