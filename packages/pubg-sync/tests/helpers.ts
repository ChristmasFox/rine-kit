import type { Pool } from 'pg';

export const DATABASE_URL = process.env.PUBG_POSTGRES_TEST_DATABASE_URL ?? process.env.MEMORY_TEST_DATABASE_URL;

/** What a host's team management writes: a tenant, a team, its roster and the members' PUBG names. */
export async function createTeam(
  pool: Pool,
  team: {
    tenantId: string;
    teamId: string;
    label: string;
    shard: string;
    members: { accountId: string; displayName: string }[];
  },
): Promise<void> {
  await pool.query('INSERT INTO pubg_tenants(tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [team.tenantId]);
  await pool.query('INSERT INTO pubg_teams(tenant_id,team_id,label,pubg_shard) VALUES ($1,$2,$3,$4)', [
    team.tenantId,
    team.teamId,
    team.label,
    team.shard,
  ]);
  for (const member of team.members) {
    await pool.query("INSERT INTO pubg_team_members(tenant_id,team_id,pubg_account_id,added_by) VALUES ($1,$2,$3,'fixture')", [
      team.tenantId,
      team.teamId,
      member.accountId,
    ]);
    await pool.query(
      `INSERT INTO pubg_account_names(shard,account_id,display_name) VALUES ($1,$2,$3)
       ON CONFLICT (shard,account_id) DO UPDATE SET display_name=EXCLUDED.display_name`,
      [team.shard, member.accountId, member.displayName],
    );
  }
}
