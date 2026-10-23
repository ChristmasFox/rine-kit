import { parseTelemetryPayload } from '@rine-kit/pubg-domain';
import {
  EXPLOSIVE_DAMAGE,
  mulberry32,
  percentile,
  STYLE_BOOTSTRAP_RESAMPLES,
  STYLE_BOOTSTRAP_SEED,
} from './style.js';

export const LOBBY_SCHEMA_VERSION = 1 as const;
/** Players who left the ground for less than this are dropped from the lobby so early drops do not skew percentiles. */
export const LOBBY_MIN_ALIVE_MINUTES = 2;
export const LOBBY_MIN_MATCHES = 20;
export const LOBBY_EVEN_BAND = 0.03;

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface LobbyPlayer {
  team: string;
  user: boolean;
  landed: number;
  seen: number;
  end: number | null;
  damage: number;
  knocks: number;
}

export interface LobbyMatchStats {
  aliveMinutes: number;
  damagePerMinute: number;
  knocksPerMinute: number;
  /** Position of the player's rate among every eligible player in the match, 0 (lowest) to 1 (highest). */
  damagePercentile: number | null;
  knockPercentile: number | null;
  lobbySize: number;
}

function midrankPercentile(values: readonly number[], value: number): number {
  const less = values.filter((other) => other < value).length;
  const equal = values.filter((other) => other === value).length;
  return (less + 0.5 * equal) / values.length;
}

/**
 * Rebuilds the whole lobby from one raw payload (damage dealt to other teams, knocks and time on the ground for every
 * player) and places each tracked member among them on damage and knocks per minute alive.
 */
export function analyzeLobby(
  payload: unknown,
  trackedIds: ReadonlySet<string>,
): Record<string, LobbyMatchStats> {
  const players = new Map<string, LobbyPlayer>();
  for (const raw of parseTelemetryPayload(payload)) {
    const event = obj(raw);
    const type = event._T;
    const time = typeof event._D === 'string' ? Date.parse(event._D) : NaN;
    if (!Number.isFinite(time)) continue;
    const phase = num(obj(event.common).isGame);

    if (type === 'LogParachuteLanding') {
      const character = obj(event.character);
      const id = typeof character.accountId === 'string' ? character.accountId : null;
      if (id && !players.has(id))
        players.set(id, {
          team: String(character.teamId ?? ''),
          user: character.type === 'user',
          landed: time,
          seen: time,
          end: null,
          damage: 0,
          knocks: 0,
        });
    } else if (type === 'LogPlayerPosition') {
      const id =
        typeof obj(event.character).accountId === 'string'
          ? (obj(event.character).accountId as string)
          : null;
      const entry = id ? players.get(id) : undefined;
      if (entry && time > entry.seen) entry.seen = time;
    } else if (type === 'LogPlayerTakeDamage') {
      const category = typeof event.damageTypeCategory === 'string' ? event.damageTypeCategory : '';
      if (
        phase === null ||
        phase < 1 ||
        (category !== 'Damage_Gun' && !EXPLOSIVE_DAMAGE.has(category))
      )
        continue;
      const damage = num(event.damage);
      const attacker = obj(event.attacker);
      const victim = obj(event.victim);
      const id = typeof attacker.accountId === 'string' ? attacker.accountId : null;
      const entry = id ? players.get(id) : undefined;
      if (
        entry &&
        damage !== null &&
        damage > 0 &&
        String(attacker.teamId ?? '') !== String(victim.teamId ?? '')
      )
        entry.damage += damage;
    } else if (type === 'LogPlayerMakeGroggy') {
      const attacker = obj(event.attacker);
      const victim = obj(event.victim);
      const id = typeof attacker.accountId === 'string' ? attacker.accountId : null;
      const entry = id ? players.get(id) : undefined;
      if (entry && String(attacker.teamId ?? '') !== String(victim.teamId ?? '')) entry.knocks += 1;
    } else if (type === 'LogPlayerKill' || type === 'LogPlayerKillV2') {
      const id =
        typeof obj(event.victim).accountId === 'string'
          ? (obj(event.victim).accountId as string)
          : null;
      const entry = id ? players.get(id) : undefined;
      if (entry && entry.end === null) entry.end = time;
    }
  }

  const rows = [...players.entries()].map(([id, entry]) => {
    const endAt = entry.end ?? entry.seen;
    const aliveMinutes = Math.max(0, (endAt - entry.landed) / 60000);
    return {
      id,
      aliveMinutes,
      dpm: aliveMinutes > 0 ? entry.damage / aliveMinutes : 0,
      kpm: aliveMinutes > 0 ? entry.knocks / aliveMinutes : 0,
      eligible: entry.user && aliveMinutes >= LOBBY_MIN_ALIVE_MINUTES,
    };
  });
  const lobby = rows.filter((row) => row.eligible);
  const result: Record<string, LobbyMatchStats> = {};
  for (const row of rows) {
    if (!trackedIds.has(row.id)) continue;
    result[row.id] = {
      aliveMinutes: row.aliveMinutes,
      damagePerMinute: row.dpm,
      knocksPerMinute: row.kpm,
      damagePercentile:
        row.eligible && lobby.length >= 10
          ? midrankPercentile(
              lobby.map((other) => other.dpm),
              row.dpm,
            )
          : null,
      knockPercentile:
        row.eligible && lobby.length >= 10
          ? midrankPercentile(
              lobby.map((other) => other.kpm),
              row.kpm,
            )
          : null,
      lobbySize: lobby.length,
    };
  }
  return result;
}

export interface LobbyInterval {
  mean: number | null;
  low: number | null;
  high: number | null;
}

export type LobbyTier = 'above' | 'below' | 'even' | 'unknown';

export interface LobbyEntry {
  accountId: string;
  name: string;
  matches: number;
  rank: number;
  damage: LobbyInterval;
  knocks: LobbyInterval;
  /** Mean of the two percentiles per match. */
  composite: LobbyInterval;
  /** Against the lobby median (0.5): above or below only when the interval clears it by a margin. */
  tier: LobbyTier;
  medianDamagePerMinute: number | null;
}

export interface LobbyCombat {
  schemaVersion: typeof LOBBY_SCHEMA_VERSION;
  matches: number;
  entries: LobbyEntry[];
  /** Mean lobby size of the analysed matches. */
  lobbySize: number | null;
  verdict: string;
  notes: string[];
}

function bootstrapMean(values: readonly number[], seed: number): LobbyInterval {
  if (values.length === 0) return { mean: null, low: null, high: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < LOBBY_MIN_MATCHES) return { mean, low: null, high: null };
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let round = 0; round < STYLE_BOOTSTRAP_RESAMPLES; round += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1)
      total += values[Math.floor(rng() * values.length)]!;
    means.push(total / values.length);
  }
  means.sort((left, right) => left - right);
  return { mean, low: percentile(means, 0.025), high: percentile(means, 0.975) };
}

function medianOf(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeLobby(
  items: ReadonlyArray<Record<string, LobbyMatchStats>>,
  names: ReadonlyMap<string, string>,
): LobbyCombat {
  const perPlayer = new Map<string, LobbyMatchStats[]>();
  const sizes: number[] = [];
  for (const item of items) {
    for (const [id, stats] of Object.entries(item)) {
      if (stats.damagePercentile === null || stats.knockPercentile === null) continue;
      perPlayer.set(id, [...(perPlayer.get(id) ?? []), stats]);
      sizes.push(stats.lobbySize);
    }
  }
  const entries: LobbyEntry[] = [...perPlayer.entries()]
    .map(([accountId, rows], index) => {
      const damage = bootstrapMean(
        rows.map((row) => row.damagePercentile!),
        STYLE_BOOTSTRAP_SEED + 11 + index,
      );
      const knocks = bootstrapMean(
        rows.map((row) => row.knockPercentile!),
        STYLE_BOOTSTRAP_SEED + 31 + index,
      );
      const composite = bootstrapMean(
        rows.map((row) => (row.damagePercentile! + row.knockPercentile!) / 2),
        STYLE_BOOTSTRAP_SEED + 53 + index,
      );
      const tier: LobbyTier =
        composite.mean === null || composite.low === null || composite.high === null
          ? 'unknown'
          : composite.low > 0.5 + LOBBY_EVEN_BAND
            ? 'above'
            : composite.high < 0.5 - LOBBY_EVEN_BAND
              ? 'below'
              : 'even';
      return {
        accountId,
        name: names.get(accountId) ?? '未知',
        matches: rows.length,
        rank: 0,
        damage,
        knocks,
        composite,
        tier,
        medianDamagePerMinute: medianOf(rows.map((row) => row.damagePerMinute)),
      };
    })
    .sort(
      (left, right) =>
        (right.composite.mean ?? -1) - (left.composite.mean ?? -1) ||
        left.name.localeCompare(right.name),
    );
  entries.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  const leader = entries[0];
  const second = entries[1];
  const separated =
    leader &&
    second &&
    leader.composite.low !== null &&
    second.composite.high !== null &&
    leader.composite.low > second.composite.high;
  const verdict =
    !leader || leader.composite.mean === null || items.length < LOBBY_MIN_MATCHES
      ? `有可用全场数据的比赛不足 ${LOBBY_MIN_MATCHES} 场，暂不比较。`
      : separated
        ? `在全场约 ${Math.round(sizes.reduce((sum, value) => sum + value, 0) / Math.max(1, sizes.length))} 名玩家里，${leader.name} 的输出分位明显高于其他队友（${(leader.composite.mean * 100).toFixed(0)} 对 ${(second!.composite.mean! * 100).toFixed(0)}，区间不重叠）。`
        : `在全场玩家里，四人的输出分位差距在抽样误差内（最高 ${leader.name} ${(leader.composite.mean * 100).toFixed(0)}，最低 ${entries.at(-1)!.name} ${((entries.at(-1)!.composite.mean ?? 0) * 100).toFixed(0)}），不能断定谁更强。`;
  return {
    schemaVersion: LOBBY_SCHEMA_VERSION,
    matches: items.length,
    entries,
    lobbySize: sizes.length ? sizes.reduce((sum, value) => sum + value, 0) / sizes.length : null,
    verdict,
    notes: [
      `分位 = 该队员每存活分钟的枪械伤害（或击倒）在本场所有真人玩家里的位置，0.50 即全场中位数；只统计落地后至少 ${LOBBY_MIN_ALIVE_MINUTES} 分钟的玩家，避免开局就被淘汰的人把分布拉偏。`,
      '综合 = 伤害分位与击倒分位的平均；区间由按场次重抽样得到。分位以每分钟速率计算，对存活时间长短的偏差已做归一，但同一场里活得更久的人面对的对手更强，所以不要把它当作绝对水平。',
    ],
  };
}
