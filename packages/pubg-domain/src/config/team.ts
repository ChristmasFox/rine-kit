import { readFileSync } from 'node:fs';
import defaultTeam from '../../config/default-team.json' with { type: 'json' };

export interface TeamPlayer {
  id: string;
  name: string;
  aliases: string[];
}

export interface TeamConfig {
  id: string;
  label: string;
  platform: string;
  players: TeamPlayer[];
}

export function assertTeamConfig(value: unknown): TeamConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_team_config');
  const candidate = value as Record<string, unknown>;
  const players = Array.isArray(candidate.players) ? candidate.players : [];
  if (!candidate.id || !candidate.label || !candidate.platform || players.length === 0)
    throw new Error('invalid_team_config');
  const normalized = players.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('invalid_team_player');
    const player = item as Record<string, unknown>;
    const id = String(player.id ?? '').trim();
    const name = String(player.name ?? '').trim();
    const aliases = Array.isArray(player.aliases)
      ? player.aliases
          .map(String)
          .map((alias) => alias.trim())
          .filter(Boolean)
      : [];
    if (!id || !name) throw new Error('invalid_team_player');
    return { id, name, aliases };
  });
  const ids = new Set<string>();
  for (const player of normalized) {
    if (ids.has(player.id)) throw new Error('duplicate_team_player');
    ids.add(player.id);
  }
  return {
    id: String(candidate.id),
    label: String(candidate.label),
    platform: String(candidate.platform),
    players: normalized,
  };
}

/** Checked-in data is a test fixture; production should load an external file. */
export const DEFAULT_TEAM = assertTeamConfig(defaultTeam);
export const DEFAULT_TEAM_PLAYER_IDS = DEFAULT_TEAM.players.map((player) => player.id);

export interface TeamConfigLoadOptions {
  path?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  required?: boolean;
}

export function loadTeamConfig(options: TeamConfigLoadOptions = {}): TeamConfig {
  const environment = options.environment ?? process.env;
  const filePath = options.path ?? environment.PUBG_TEAM_CONFIG_FILE?.trim();
  if (!filePath) {
    if (options.required) throw new Error('team_config_file_required');
    return DEFAULT_TEAM;
  }
  try {
    return assertTeamConfig(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid_')) throw error;
    throw new Error('team_config_unreadable:' + filePath, { cause: error });
  }
}

export function playerAliasMap(team: TeamConfig = DEFAULT_TEAM): Map<string, TeamPlayer> {
  const aliases = new Map<string, TeamPlayer>();
  for (const player of team.players) {
    aliases.set(player.id.toLowerCase(), player);
    aliases.set(player.name.toLowerCase(), player);
    for (const alias of player.aliases) aliases.set(alias.toLowerCase(), player);
  }
  return aliases;
}
