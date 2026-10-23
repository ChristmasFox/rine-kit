import type { TeamConfig } from '../config/team.js';
import { assertTeamConfig } from '../config/team.js';

/**
 * Trusted scope resolved by the calling application before entering PUBG
 * Domain. Public callers must derive it from verified platform event data and
 * persisted ownership; model/tool arguments are never a source for this value.
 */
export interface TeamContext {
  tenantId: string;
  teamId: string;
  team: TeamConfig;
}

export function parseTeamContext(value: unknown): TeamContext {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_team_context');
  const candidate = value as Record<string, unknown>;
  const tenantId = typeof candidate.tenantId === 'string' ? candidate.tenantId.trim() : '';
  const teamId = typeof candidate.teamId === 'string' ? candidate.teamId.trim() : '';
  const team = assertTeamConfig(candidate.team);
  if (!tenantId || !teamId || teamId !== team.id) throw new Error('invalid_team_context');
  return { tenantId, teamId, team };
}

export function createTeamContext(tenantId: string, team: TeamConfig): TeamContext {
  return parseTeamContext({ tenantId, teamId: team.id, team });
}
