// NEW in this package (not extracted from Gate): the smallest team/roster management a host needs when a
// team is "whoever claimed an account here" (RINE: one room = one team). Gate's equivalent is
// team-admin-service, which is built around KOOK confirmation cards and is not carried over.
import type { Pool, PoolClient } from 'pg';
import { createTeamContext, type TeamContext } from '@rine-kit/pubg-domain/core';
import { MAX_TEAM_ROSTER_SIZE } from './contracts/team-roster.js';
import { requeueTeamJob } from './sync-queue.js';

export interface PubgClaim {
  actorId: string;
  accountId: string;
  shard: string;
  displayName: string;
  status: 'self_declared' | 'verified';
  claimedAt: string;
}

export interface ClaimInput {
  tenantId: string;
  teamId: string;
  /** The team's display label, used the first time the team is created. */
  teamLabel: string;
  actorId: string;
  shard: string;
  accountId: string;
  displayName: string;
}

const SHARDS = new Set(['steam', 'kakao', 'psn', 'xbox']);

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Claims and rosters for teams made of claimed PUBG accounts. Every method is scoped by tenant and team. */
export class PostgresPubgRosterStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Declares `accountId` as the actor's account in the team, creating the team on the first claim. A second
   * claim by the same actor replaces the first. Throws `pubg_team_shard_conflict` when the team already has
   * members on another shard, `pubg_account_taken` when someone else claimed the account, and
   * `pubg_team_full` beyond MAX_TEAM_ROSTER_SIZE. The team's next sync is scheduled at once.
   */
  async claim(input: ClaimInput): Promise<void> {
    if (!SHARDS.has(input.shard)) throw new Error('pubg_shard_invalid');
    await transaction(this.pool, async (client) => {
      await client.query('INSERT INTO pubg_tenants(tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [
        input.tenantId,
      ]);
      await client.query(
        'INSERT INTO pubg_teams(tenant_id,team_id,label,pubg_shard) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [input.tenantId, input.teamId, input.teamLabel, input.shard],
      );
      const team = await client.query(
        'SELECT pubg_shard FROM pubg_teams WHERE tenant_id=$1 AND team_id=$2 FOR UPDATE',
        [input.tenantId, input.teamId],
      );
      const others = await client.query(
        'SELECT count(*)::int AS n FROM pubg_account_claims WHERE tenant_id=$1 AND team_id=$2 AND actor_id<>$3',
        [input.tenantId, input.teamId, input.actorId],
      );
      const otherCount = Number(others.rows[0]?.n ?? 0);
      if (team.rows[0]?.pubg_shard !== input.shard) {
        // An empty team may still change shard (its only member is re-claiming on another one).
        if (otherCount > 0) throw new Error('pubg_team_shard_conflict');
        await client.query('UPDATE pubg_teams SET pubg_shard=$3 WHERE tenant_id=$1 AND team_id=$2', [
          input.tenantId,
          input.teamId,
          input.shard,
        ]);
      }
      if (otherCount >= MAX_TEAM_ROSTER_SIZE) throw new Error('pubg_team_full');
      const taken = await client.query(
        `SELECT 1 FROM pubg_account_claims WHERE tenant_id=$1 AND team_id=$2
           AND pubg_account_id=$3 AND actor_id<>$4`,
        [input.tenantId, input.teamId, input.accountId, input.actorId],
      );
      if (taken.rowCount) throw new Error('pubg_account_taken');
      await this.dropMember(client, input.tenantId, input.teamId, input.actorId);
      await client.query(
        `INSERT INTO pubg_account_names(shard,account_id,display_name) VALUES ($1,$2,$3)
         ON CONFLICT (shard,account_id) DO UPDATE SET display_name=EXCLUDED.display_name, last_resolved_at=now()`,
        [input.shard, input.accountId, input.displayName],
      );
      await client.query(
        `INSERT INTO pubg_team_members(tenant_id,team_id,pubg_account_id,added_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [input.tenantId, input.teamId, input.accountId, input.actorId],
      );
      await client.query(
        `INSERT INTO pubg_account_claims(tenant_id,team_id,actor_id,pubg_shard,pubg_account_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.tenantId, input.teamId, input.actorId, input.shard, input.accountId],
      );
      await requeueTeamJob(client, input.tenantId, input.teamId);
    });
  }

  /** Removes the actor's claim and roster entry; the team disappears with its last member. */
  async release(tenantId: string, teamId: string, actorId: string): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const removed = await this.dropMember(client, tenantId, teamId, actorId);
      const left = await client.query(
        'SELECT 1 FROM pubg_account_claims WHERE tenant_id=$1 AND team_id=$2 LIMIT 1',
        [tenantId, teamId],
      );
      if (!left.rowCount) {
        await client.query('DELETE FROM pubg_teams WHERE tenant_id=$1 AND team_id=$2', [tenantId, teamId]);
      }
      return removed;
    });
  }

  private async dropMember(
    client: PoolClient,
    tenantId: string,
    teamId: string,
    actorId: string,
  ): Promise<boolean> {
    const previous = await client.query(
      `DELETE FROM pubg_account_claims WHERE tenant_id=$1 AND team_id=$2 AND actor_id=$3
       RETURNING pubg_account_id`,
      [tenantId, teamId, actorId],
    );
    const accountId = previous.rows[0]?.pubg_account_id as string | undefined;
    if (accountId) {
      await client.query(
        'DELETE FROM pubg_team_members WHERE tenant_id=$1 AND team_id=$2 AND pubg_account_id=$3',
        [tenantId, teamId, accountId],
      );
    }
    return Boolean(accountId);
  }

  /** Forgets a whole team (its room was closed): roster, claims, sync job and cached team data. */
  async deleteTeam(tenantId: string, teamId: string): Promise<void> {
    await this.pool.query('DELETE FROM pubg_teams WHERE tenant_id=$1 AND team_id=$2', [tenantId, teamId]);
  }

  async listClaims(tenantId: string, teamId: string): Promise<PubgClaim[]> {
    const result = await this.pool.query(
      `SELECT claim.actor_id, claim.pubg_account_id, claim.pubg_shard, claim.claim_status, claim.claimed_at,
              COALESCE(name.display_name, claim.pubg_account_id) AS display_name
         FROM pubg_account_claims claim
         LEFT JOIN pubg_account_names name
           ON name.shard=claim.pubg_shard AND name.account_id=claim.pubg_account_id
        WHERE claim.tenant_id=$1 AND claim.team_id=$2 ORDER BY claim.claimed_at, claim.actor_id`,
      [tenantId, teamId],
    );
    return result.rows.map((row) => ({
      actorId: String(row.actor_id),
      accountId: String(row.pubg_account_id),
      shard: String(row.pubg_shard),
      displayName: String(row.display_name),
      status: row.claim_status as PubgClaim['status'],
      claimedAt: new Date(row.claimed_at).toISOString(),
    }));
  }

  /** The actor's own account in this team, or null. */
  async getClaim(tenantId: string, teamId: string, actorId: string): Promise<PubgClaim | null> {
    return (await this.listClaims(tenantId, teamId)).find((claim) => claim.actorId === actorId) ?? null;
  }

  /** The team as the Domain wants it (roster with in-game names), or null when nobody has claimed yet. */
  async getTeamContext(tenantId: string, teamId: string): Promise<TeamContext | null> {
    const team = await this.pool.query(
      'SELECT label, pubg_shard FROM pubg_teams WHERE tenant_id=$1 AND team_id=$2',
      [tenantId, teamId],
    );
    const claims = await this.listClaims(tenantId, teamId);
    const row = team.rows[0];
    if (!row || claims.length === 0) return null;
    return createTeamContext(tenantId, {
      id: teamId,
      label: String(row.label),
      platform: String(row.pubg_shard),
      players: claims.map((claim) => ({ id: claim.accountId, name: claim.displayName, aliases: [] })),
    });
  }
}
