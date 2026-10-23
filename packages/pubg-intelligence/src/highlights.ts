import { createHash } from 'node:crypto';
import { parseTelemetryPayload, type NormalizedMatch } from '@rine-kit/pubg-domain';
import {
  normalizeBattleTelemetry,
  type BattleSourceEvent,
  type BattleTelemetryDocument,
} from './battle.js';
import { analyzeMatchStory, type MatchStory } from './match-story.js';
import { analyzeStreaks, type StreakMatchStats } from './streaks.js';
import { mapDisplayName } from './analytics.js';

export const HIGHLIGHT_RULE_VERSION = 'cross-match-highlights-v1' as const;
export type HighlightKind = 'streak' | 'wipe' | 'comeback' | 'rescue';
export const HIGHLIGHT_LABELS: Record<HighlightKind, string> = {
  streak: '连续击倒',
  wipe: '观测灭队',
  comeback: '逆风反击',
  rescue: '队友救援',
};

export interface MatchHighlight {
  id: string;
  ruleVersion: typeof HIGHLIGHT_RULE_VERSION;
  kind: HighlightKind;
  title: string;
  summary: string;
  matchId: string;
  createdAt: string | null;
  mapLabel: string;
  startSeconds: number;
  endSeconds: number;
  fightIndex: number | null;
  players: Array<{ id: string; name: string }>;
  count: number;
  evidence: Array<{
    matchId: string;
    eventId: string;
    timeSeconds: number;
    type: string;
    description: string;
  }>;
  notes: string[];
}

/** Reuses the streak detector and story fights; evidence IDs are the original telemetry array ordinals. */
export function identifyMatchHighlights(input: {
  payload: unknown;
  match: NormalizedMatch;
  memberIds: readonly string[];
  streaks?: StreakMatchStats;
  story?: MatchStory;
  telemetry?: BattleTelemetryDocument;
}): MatchHighlight[] {
  const payload = parseTelemetryPayload(input.payload);
  const raw = payload.map((event) =>
    event && typeof event === 'object' ? (event as Record<string, unknown>) : {},
  );
  const startEvent = raw.find((event) => event._T === 'LogMatchStart');
  const startValue =
    startEvent?._D ??
    raw.find((event) => typeof event._D === 'string' && Number.isFinite(Date.parse(event._D)))?._D;
  const startMs = typeof startValue === 'string' ? Date.parse(startValue) : NaN;
  if (!Number.isFinite(startMs)) return [];
  const members = new Set(input.memberIds);
  const story = input.story ?? analyzeMatchStory(payload, members);
  const streaks = input.streaks ?? analyzeStreaks(payload, members);
  const telemetry = input.telemetry ?? normalizeBattleTelemetry(payload, input.match);
  const time = (event: BattleSourceEvent): number | null => {
    const original = raw[Number(event.sourceEventId.replace('telemetry-', '')) - 1];
    const timestamp = typeof original?._D === 'string' ? Date.parse(original._D) : NaN;
    return Number.isFinite(timestamp) && timestamp >= startMs ? (timestamp - startMs) / 1000 : null;
  };
  const seen = new Set<string>();
  const events = telemetry.events
    .filter(
      (event) =>
        event.phase === 'in_match' &&
        ['KNOCK', 'KILL', 'REVIVE'].includes(event.type) &&
        time(event) !== null,
    )
    .filter((event) => {
      if (seen.has(event.semanticKey)) return false;
      seen.add(event.semanticKey);
      return true;
    });
  const byId = new Map(events.map((event) => [event.sourceEventId, event]));
  const names = new Map(
    input.match.players
      .filter((player) => members.has(player.accountId))
      .map((player) => [player.accountId, player.displayName || player.playerName || '队员']),
  );
  const name = (id: string | null) =>
    id && names.has(id) ? names.get(id)! : id ? '范围外队员' : '来源未知';
  const enemy = (event: BattleSourceEvent) =>
    Boolean(
      event.actorId &&
      event.victimId &&
      event.actorId !== event.victimId &&
      event.actorTeamId &&
      event.victimTeamId &&
      event.actorTeamId !== event.victimTeamId,
    );
  const highlights: MatchHighlight[] = [];
  const add = (
    kind: HighlightKind,
    source: BattleSourceEvent[],
    playerIds: string[],
    count: number,
    summary: string,
    notes: string[] = [],
    replayWindow?: [number, number],
  ) => {
    const refs = [...new Map(source.map((event) => [event.sourceEventId, event])).values()].sort(
      (a, b) => time(a)! - time(b)! || a.sourceEventId.localeCompare(b.sourceEventId),
    );
    if (!refs.length) return;
    const startSeconds = replayWindow?.[0] ?? time(refs[0]!)!;
    const endSeconds = replayWindow?.[1] ?? time(refs.at(-1)!)!;
    const fight = story.fights.find(
      (fight) => startSeconds >= fight.start - 1 && startSeconds <= fight.end + 1,
    );
    const id = createHash('sha256')
      .update(
        `${HIGHLIGHT_RULE_VERSION}|${input.match.matchId}|${kind}|${refs.map((event) => event.sourceEventId).join(',')}`,
      )
      .digest('hex')
      .slice(0, 24);
    highlights.push({
      id,
      ruleVersion: HIGHLIGHT_RULE_VERSION,
      kind,
      title: kind === 'streak' ? `${count} 人连续击倒` : HIGHLIGHT_LABELS[kind],
      summary,
      matchId: input.match.matchId,
      createdAt: input.match.createdAt ?? null,
      mapLabel: mapDisplayName(input.match.mapName),
      startSeconds,
      endSeconds,
      fightIndex: fight?.index ?? null,
      players: [...new Set(playerIds)]
        .filter((id) => members.has(id))
        .map((id) => ({ id, name: name(id) })),
      count,
      evidence: refs.map((event) => ({
        matchId: input.match.matchId,
        eventId: event.sourceEventId,
        timeSeconds: time(event)!,
        type: event.type,
        description: `${name(event.actorId)} → ${name(event.victimId)}`,
      })),
      notes,
    });
  };
  for (const moment of streaks.moments ?? []) {
    const source = moment.eventIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    // A chain containing unknown teams, untimed events or duplicated source contacts cannot support a highlight.
    if (source.length !== moment.eventIds.length || source.some((event) => !enemy(event))) continue;
    if (moment.kind === 'streak') {
      add(
        'streak',
        source,
        moment.playerIds,
        moment.count,
        `${name(moment.playerIds[0]!)} 连续压制 ${moment.count} 名不同敌人，历时 ${Math.round(moment.end - moment.start)} 秒。`,
        ['计数为击倒，或无前序击倒的直接淘汰；不等同于最终击杀数。'],
      );
    } else {
      add(
        'wipe',
        source,
        moment.playerIds,
        moment.count,
        `最后一轮推进击倒 ${moment.count} 人；该敌队已观测的 ${moment.observedTeamSize} 名成员均已淘汰。`,
        ['只说明遥测已观测名单被清空；不推断未观测成员或完整四人编制。'],
        [moment.start - startMs / 1000, moment.end - startMs / 1000],
      );
    }
  }
  for (const revive of events.filter(
    (event) =>
      event.type === 'REVIVE' &&
      event.actorId &&
      event.victimId &&
      members.has(event.actorId) &&
      members.has(event.victimId) &&
      event.actorId !== event.victimId &&
      event.actorTeamId &&
      event.actorTeamId === event.victimTeamId,
  )) {
    const preceding = events
      .filter(
        (event) =>
          event.victimId === revive.victimId &&
          time(event)! < time(revive)! &&
          ['KNOCK', 'KILL', 'REVIVE'].includes(event.type),
      )
      .at(-1);
    const knock = preceding?.type === 'KNOCK' ? preceding : undefined;
    const delay = knock ? Math.round(time(revive)! - time(knock)!) : null;
    add(
      'rescue',
      [...(knock ? [knock] : []), revive],
      [revive.actorId!, revive.victimId!],
      1,
      `${name(revive.actorId)} 扶起 ${name(revive.victimId)}${delay === null ? '。' : `，距已记录倒地 ${delay} 秒。`}`,
      delay === null ? ['未找到对应倒地事件，倒地至救援时长未知。'] : [],
    );
  }
  // "Comeback" is strictly a recorded knock-balance reversal in one story fight, not an inferred match victory.
  for (const fight of story.fights.filter((fight) => fight.outcome === 'win')) {
    const contacts = events.filter(
      (event) =>
        ['KNOCK', 'KILL'].includes(event.type) &&
        enemy(event) &&
        time(event)! >= fight.start &&
        time(event)! <= fight.end &&
        (members.has(event.actorId!) || members.has(event.victimId!)),
    );
    const first = contacts[0];
    if (!first || !members.has(first.victimId!) || first.type !== 'KNOCK') continue;
    const counters = contacts.filter(
      (event) =>
        event.type === 'KNOCK' && members.has(event.actorId!) && time(event)! > time(first)!,
    );
    const enemyCount = new Set(counters.map((event) => event.victimId)).size;
    const ownCount = new Set(
      contacts
        .filter((event) => event.type === 'KNOCK' && members.has(event.victimId!))
        .map((event) => event.victimId),
    ).size;
    if (enemyCount < 2 || enemyCount <= ownCount) continue;
    add(
      'comeback',
      contacts,
      [...contacts.flatMap((event) => [event.actorId!, event.victimId!])],
      enemyCount,
      `本次交战先有队员倒地，随后反击；记录到击倒 ${enemyCount} 名不同敌人、本队 ${ownCount} 人倒地。`,
      ['逆风反击按同一交战的击倒记录判定，不代表最终吃鸡或因果结论。'],
    );
  }
  return rankCrossMatchHighlights(highlights);
}

/** Stronger moments first, then newer matches and event time; input order never breaks a tie. */
export function rankCrossMatchHighlights(items: readonly MatchHighlight[]): MatchHighlight[] {
  const priority: Record<HighlightKind, number> = { wipe: 4, comeback: 3, streak: 2, rescue: 1 };
  return [...new Map(items.map((item) => [item.id, item])).values()].sort(
    (a, b) =>
      priority[b.kind] - priority[a.kind] ||
      b.count - a.count ||
      (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0) ||
      a.matchId.localeCompare(b.matchId) ||
      a.startSeconds - b.startSeconds ||
      a.id.localeCompare(b.id),
  );
}
