import type { NormalizedMatch } from '@rine-kit/pubg-domain';

export const highlightMemberIds = ['a', 'b'];
export const highlightStart = '2026-10-19T15:00:00.000Z';
export function highlightMatch(
  matchId = 'highlight-match',
  createdAt = highlightStart,
): NormalizedMatch {
  return {
    schemaVersion: 3,
    shard: 'steam',
    matchId,
    timestamp: Date.parse(createdAt),
    createdAt,
    matchType: 'competitive',
    isCompetitive: true,
    gameMode: 'squad',
    mapName: 'Baltic_Main',
    duration: 1000,
    patchVersion: 'fixture',
    players: highlightMemberIds.map((accountId) => ({
      accountId,
      playerName: accountId.toUpperCase(),
      displayName: accountId.toUpperCase(),
      rank: 3,
      kills: 2,
      assists: 1,
      damage: 300,
      dbnos: 2,
      revives: 1,
      headshotKills: 0,
      survivalTime: 1000,
      longestKill: 50,
      deaths: 1,
      deathSemantics: 'placement_proxy',
    })),
  };
}
export function highlightTelemetry(start = highlightStart): Record<string, unknown>[] {
  const at = (seconds: number) => new Date(Date.parse(start) + seconds * 1000).toISOString();
  const who = (id: string, teamId: number) => ({
    accountId: id,
    teamId,
    name: id.toUpperCase(),
    location: { x: 100000, y: 100000, z: 0 },
  });
  const event = (type: string, seconds: number, fields: Record<string, unknown>) => ({
    _T: type,
    _D: at(seconds),
    common: { isGame: 2 },
    ...fields,
  });
  return [
    event('LogMatchStart', 0, { mapName: 'Baltic_Main', common: { isGame: 0 } }),
    ...[
      ['a', 1],
      ['b', 1],
      ['e1', 2],
      ['e2', 2],
    ].map(([id, team]) =>
      event('LogParachuteLanding', 20, {
        character: who(String(id), Number(team)),
        common: { isGame: 0.1 },
      }),
    ),
    event('LogPlayerMakeGroggy', 100, { attacker: who('e1', 2), victim: who('a', 1) }),
    event('LogPlayerMakeGroggy', 110, { attacker: who('b', 1), victim: who('e1', 2) }),
    event('LogPlayerMakeGroggy', 120, { attacker: who('b', 1), victim: who('e2', 2) }),
    event('LogPlayerKillV2', 124, {
      victim: who('e1', 2),
      dBNOMaker: who('b', 1),
      killer: who('b', 1),
      finisher: who('b', 1),
    }),
    event('LogPlayerKillV2', 125, {
      victim: who('e2', 2),
      dBNOMaker: who('b', 1),
      killer: who('b', 1),
      finisher: who('b', 1),
    }),
    event('LogPlayerRevive', 130, { reviver: who('b', 1), victim: who('a', 1) }),
  ];
}
