import type { Pool } from 'pg';
import type { ConversationAuthorizer } from '../src/index.js';

export const DATABASE_URL = process.env.PUBG_POSTGRES_TEST_DATABASE_URL ?? process.env.MEMORY_TEST_DATABASE_URL;

/** Test-only stand-ins for what a host keeps: which room (channel) is bound to which team, and who may
 * ask about a team directly. The repository only asks the host's authorize() callback. */
export async function createHostTables(pool: Pool): Promise<void> {
  // Test files run in parallel against one database: two CREATE TABLE IF NOT EXISTS can race (pg_type unique violation).
  for (let attempt = 0; ; attempt++) {
    try {
      return await createHostTablesOnce(pool);
    } catch (error) {
      if (attempt >= 3 || (error as { code?: string }).code !== '23505') throw error;
    }
  }
}

async function createHostTablesOnce(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS test_bindings (
    tenant_id TEXT NOT NULL, team_id TEXT NOT NULL, channel_id TEXT NOT NULL PRIMARY KEY)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS test_access (
    tenant_id TEXT NOT NULL, team_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, team_id, actor_id))`);
}

export const authorize: ConversationAuthorizer = async (client, { tenantId, teamId, conversation }) => {
  if (conversation.kind === 'room') {
    const bound = await client.query(
      'SELECT 1 FROM test_bindings WHERE tenant_id=$1 AND team_id=$2 AND channel_id=$3 FOR SHARE',
      [tenantId, teamId, conversation.channelId],
    );
    if (!bound.rowCount) throw new Error('conversation_channel_not_bound');
  } else {
    const grant = await client.query(
      'SELECT 1 FROM test_access WHERE tenant_id=$1 AND team_id=$2 AND actor_id=$3 FOR SHARE',
      [tenantId, teamId, conversation.actorId],
    );
    if (!grant.rowCount) throw new Error('direct_team_access_denied');
  }
};
