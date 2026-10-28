// Synthetic PUBG telemetry (no real players): landing, a long-range knock, a revive, a kill, a circle and some gas.
// Same story the Intelligence Lab tests use, so the share page is exercised on identical input.
export const squadIds = ['p1', 'p2', 'p3', 'p4'];

/** A small but complete telemetry story: landing, a long-range knock with no return fire, a revive, a kill, a circle and some gas. */
export function telemetry(startIso: string): unknown[] {
  const start = Date.parse(startIso);
  const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
  const who = (id: string, team: number, extra: Record<string, unknown> = {}) => ({
    accountId: id,
    teamId: team,
    name: id.toUpperCase(),
    type: 'user',
    ...extra,
  });
  const loc = (x: number, y: number) => ({ x: x * 100, y: y * 100, z: 0 });
  const position = (t: number, id: string, x: number, blue = false) => ({
    _T: 'LogPlayerPosition',
    _D: at(t),
    elapsedTime: t,
    common: { isGame: 3 },
    character: who(id, 1, { location: loc(x, 1000), isInBlueZone: blue }),
  });
  return [
    { _T: 'LogMatchStart', _D: at(0), mapName: 'Baltic_Main', common: { isGame: 0 } },
    ...squadIds.map((id) => ({
      _T: 'LogParachuteLanding',
      _D: at(20),
      common: { isGame: 0.1 },
      character: who(id, 1, { location: loc(1000, 1000) }),
    })),
    {
      _T: 'LogGameStatePeriodic',
      _D: at(60),
      common: { isGame: 1 },
      gameState: {
        elapsedTime: 60,
        numStartTeams: 16,
        numAliveTeams: 14,
        numStartPlayers: 60,
        numAlivePlayers: 52,
        safetyZonePosition: loc(4000, 4000),
        safetyZoneRadius: 300000,
        poisonGasWarningPosition: loc(1000, 1000),
        poisonGasWarningRadius: 50000,
      },
    },
    {
      _T: 'LogGameStatePeriodic',
      _D: at(300),
      common: { isGame: 3 },
      gameState: {
        elapsedTime: 300,
        numStartTeams: 16,
        numAliveTeams: 9,
        numStartPlayers: 60,
        numAlivePlayers: 30,
        safetyZonePosition: loc(1000, 1000),
        safetyZoneRadius: 60000,
        poisonGasWarningPosition: loc(1100, 1000),
        poisonGasWarningRadius: 20000,
      },
    },
    ...[60, 70, 80, 90, 100, 110, 120, 130].flatMap((t) =>
      squadIds.map((id, index) => position(t, id, 1000 + index * 10, id === 'p2' && t <= 100)),
    ),
    {
      _T: 'LogPlayerTakeDamage',
      _D: at(100),
      common: { isGame: 3 },
      damage: 6,
      damageTypeCategory: 'Damage_BlueZone',
      attacker: null,
      victim: who('p2', 1),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: at(102),
      common: { isGame: 3 },
      damage: 40,
      damageTypeCategory: 'Damage_Gun',
      damageCauserName: 'WeapKar98k_C',
      attacker: who('e1', 2),
      victim: who('p1', 1),
    },
    {
      _T: 'LogPlayerMakeGroggy',
      _D: at(105),
      common: { isGame: 3 },
      attacker: who('e1', 2),
      victim: who('p1', 1),
      damageCauserName: 'WeapKar98k_C',
      damageTypeCategory: 'Damage_Gun',
      distance: 25000,
    },
    {
      _T: 'LogPlayerRevive',
      _D: at(118),
      common: { isGame: 3 },
      reviver: who('p2', 1),
      victim: who('p1', 1),
    },
    {
      _T: 'LogPlayerTakeDamage',
      _D: at(190),
      common: { isGame: 3 },
      damage: 50,
      damageTypeCategory: 'Damage_Gun',
      damageCauserName: 'WeapM416_C',
      attacker: who('p3', 1),
      victim: who('e2', 3),
    },
    {
      _T: 'LogPlayerMakeGroggy',
      _D: at(195),
      common: { isGame: 3 },
      attacker: who('p3', 1),
      victim: who('e2', 3),
      damageCauserName: 'WeapM416_C',
      damageTypeCategory: 'Damage_Gun',
      distance: 3000,
    },
    {
      _T: 'LogPlayerKillV2',
      _D: at(200),
      common: { isGame: 3 },
      victim: who('e2', 3),
      dBNOMaker: who('p3', 1),
      finisher: who('p3', 1),
      killer: who('p3', 1),
      finishDamageInfo: { damageCauserName: 'WeapM416_C', distance: 3000 },
    },
  ];
}
