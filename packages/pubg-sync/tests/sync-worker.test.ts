import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { DEFAULT_REVIEW_FEATURE_VERSION, DEFAULT_TELEMETRY_PARSER_VERSION, PubgDomainService } from '@rine-kit/pubg-domain';
import { migratePubgDatabase, PostgresPubgRepository } from '@rine-kit/pubg-postgres';
import { createPublicSyncFetch, PublicSyncWorker, type PublicPubgAdmission } from '../src/index.js';
import { createTeam, DATABASE_URL } from './helpers.js';

const databaseUrl = DATABASE_URL;

class AdmissionFixture implements PublicPubgAdmission {
  acquired = 0;
  observed = 0;
  async acquire() { this.acquired += 1; }
  async observe() { this.observed += 1; }
}

function damageEvent(actor: string, victim: string, damage: number) {
  return {
    _T: 'LogPlayerTakeDamage',
    attacker: { accountId: actor },
    victim: { accountId: victim },
    damage,
    damageTypeCategory: 'Damage_Bullet',
    damageCauserName: 'WeapAK47_C',
    timeSeconds: 30,
    common: { isGame: true },
  };
}

test('public sync HTTP boundary allows only official API and telemetry GETs and never forwards API credentials to the CDN', async () => {
  const admission = new AdmissionFixture();
  const requests: Array<{ url: string; authorization: string | null; redirect: 'error' | 'follow' | 'manual' | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    return new Response('[]', { status: 200 });
  };
  const guarded = createPublicSyncFetch(admission, fetcher);
  await guarded('https://api.pubg.com/shards/steam/players?filter%5BplayerIds%5D=account.test', {
    headers: { authorization: 'Bearer fixture-only' },
  });
  await guarded('https://api.pubg.com/shards/steam/matches/fixture', {
    headers: { authorization: 'Bearer fixture-only' },
  });
  await guarded('https://telemetry-cdn.pubg.com/test/match-telemetry.json');
  await assert.rejects(guarded('https://example.com/test-telemetry.json'), /public_sync_endpoint_invalid/u);
  await assert.rejects(guarded('https://telemetry-cdn.pubg.com/test/match-telemetry.json', {
    headers: { authorization: 'Bearer fixture-only' },
  }), /public_sync_telemetry_auth_forbidden/u);
  await assert.rejects(guarded('https://api.pubg.com/shards/steam/matches/fixture', { method: 'POST' }), /public_sync_method_invalid/u);
  assert.equal(admission.acquired, 1, 'only rate-limited player discovery uses public API admission');
  assert.equal(admission.observed, 1, 'only player discovery quota headers are observed');
  assert.ok(requests.every((request) => request.redirect === 'error'));
  assert.equal(requests[0]?.authorization, 'Bearer fixture-only');
  assert.equal(requests[1]?.authorization, 'Bearer fixture-only');
  assert.equal(requests[2]?.authorization, null);
});

test('public worker syncs persisted rosters, stores match and friendly-fire telemetry in each tenant scope', { skip: !databaseUrl }, async () => {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const schema = `public_sync_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
  const suffix = randomUUID().replaceAll('-', '');
  const accountA1 = `account.a1_${suffix}`;
  const accountShared = `account.shared_${suffix}`;
  const accountB2 = `account.b2_${suffix}`;
  const matchA = `worker-match-a-${suffix}`;
  const players = new Map([
    [accountA1, { name: 'Alice', matchId: matchA }],
    [accountShared, { name: 'Avery', matchId: matchA }],
    [accountB2, { name: 'Bryn', matchId: matchA }],
  ]);
  const matchOwners = new Map([[matchA, [accountA1, accountShared, accountB2]]]);
  const admission = new AdmissionFixture();
  let apiRequests = 0;
  let playerDiscoveryRequests = 0;
  let matchDetailRequests = 0;
  const cdnAuthorizations: Array<string | null> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://api.pubg.com') {
      apiRequests++;
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-only');
      if (url.pathname.endsWith('/players')) {
        playerDiscoveryRequests++;
        const ids = (url.searchParams.get('filter[playerIds]') ?? '').split(',').filter(Boolean);
        return Response.json({ data: ids.flatMap((id) => {
          const player = players.get(id);
          return player ? [{
            type: 'player',
            id,
            attributes: { name: player.name },
            relationships: { matches: { data: [{ type: 'match', id: player.matchId }] } },
          }] : [];
        }) });
      }
      matchDetailRequests++;
      const matchId = url.pathname.split('/').at(-1) ?? '';
      const ownerIds = matchOwners.get(matchId) ?? [];
      const match = {
        data: {
          type: 'match',
          id: matchId,
          attributes: {
            createdAt: '2026-10-12T10:00:00.000Z',
            matchType: 'competitive',
            gameMode: 'squad-fpp',
            mapName: 'Baltic_Main',
            duration: 1200,
            patchVersion: 'fixture',
          },
          relationships: { assets: { data: [{ type: 'asset', id: `asset-${matchId}` }] } },
        },
        included: [
          { type: 'asset', id: `asset-${matchId}`, attributes: { URL: `https://telemetry-cdn.pubg.com/fixture/${matchId}-telemetry.json` } },
          ...ownerIds.map((accountId, index) => ({
            type: 'participant',
            id: `participant-${index}`,
            attributes: { stats: { playerId: accountId, kills: index + 1, assists: 0, damageDealt: 200, DBNOs: 0, revives: 0, headshotKills: 0, timeSurvived: 900, longestKill: 0, winPlace: 3 } },
          })),
        ],
      };
      return Response.json(match);
    }
    assert.equal(url.origin, 'https://telemetry-cdn.pubg.com');
    cdnAuthorizations.push(new Headers(init?.headers).get('authorization'));
    const matchId = url.pathname.split('/').at(-1)?.replace(/-telemetry\.json$/u, '') ?? '';
    const ownerIds = matchOwners.get(matchId) ?? [];
    return Response.json({ events: [damageEvent(ownerIds[0]!, ownerIds[1]!, 15)] });
  };

  try {
    await migratePubgDatabase(pool);
    const teamA = { tenantId: `tenant-a-${suffix}`, teamId: `team-a-${suffix}` };
    const teamB = { tenantId: `tenant-b-${suffix}`, teamId: `team-b-${suffix}` };
    await createTeam(pool, { ...teamA, label: 'Fixture A', shard: 'steam', members: [
      { accountId: accountA1, displayName: 'Alice' }, { accountId: accountShared, displayName: 'Avery' }] });
    await createTeam(pool, { ...teamB, label: 'Fixture B', shard: 'steam', members: [
      { accountId: accountShared, displayName: 'Avery' }, { accountId: accountB2, displayName: 'Bryn' }] });

    const archived: string[] = [];
    const archive = {
      read: async () => null,
      write: async () => undefined,
      refresh: async (_id: string, fetchRaw: () => Promise<Uint8Array>) => fetchRaw(),
      getOrFetch: async (id: string, fetchRaw: () => Promise<Uint8Array>) => {
        archived.push(id);
        return fetchRaw();
      },
    };
    const worker = new PublicSyncWorker(pool, {
      apiKey: 'fixture-only',
      admission,
      rawTelemetryArchive: archive,
      fetchImpl: fetcher,
      now: () => new Date('2026-10-13T04:00:00.000Z'),
      maxTelemetryFetches: 4,
    });
    const result = await worker.runOnce();
    assert.deepEqual(result, {
      teamsDiscovered: 2,
      teamsAttempted: 2,
      teamsCompleted: 2,
      teamsFailed: 0,
      matchesDiscovered: 2,
      telemetryFetched: 2,
      telemetryUnavailable: 0,
    });
    assert.equal(archived.length, 2, 'every downloaded telemetry file goes through the raw archive');
    assert.equal(matchDetailRequests, 2);
    assert.equal(apiRequests, playerDiscoveryRequests + matchDetailRequests);
    assert.equal(admission.acquired, playerDiscoveryRequests,
      'only rate-limited player discovery uses public admission');
    assert.equal(admission.observed, playerDiscoveryRequests,
      'only player discovery responses consume shared rate-limit headers');
    assert.deepEqual(cdnAuthorizations, [null, null]);

    const contextA = {
      tenantId: teamA.tenantId,
      teamId: teamA.teamId,
      team: { id: teamA.teamId, label: 'Fixture A', platform: 'steam', players: [
        { id: accountA1, name: 'Alice', aliases: [] }, { id: accountShared, name: 'Avery', aliases: [] },
      ] },
    };
    const contextB = {
      tenantId: teamB.tenantId,
      teamId: teamB.teamId,
      team: { id: teamB.teamId, label: 'Fixture B', platform: 'steam', players: [
        { id: accountShared, name: 'Avery', aliases: [] }, { id: accountB2, name: 'Bryn', aliases: [] },
      ] },
    };
    const repositoryA = new PostgresPubgRepository(pool, contextA);
    const repositoryB = new PostgresPubgRepository(pool, contextB);
    assert.deepEqual((await repositoryA.listMatches()).map((match) => [match.matchId, match.players.map((player) => player.accountId)]), [[matchA, [accountA1, accountShared]]]);
    assert.deepEqual((await repositoryB.listMatches()).map((match) => [match.matchId, match.players.map((player) => player.accountId)]), [[matchA, [accountB2, accountShared]]]);
    for (const team of [teamA, teamB]) {
      const row = await pool.query('SELECT state_json FROM pubg_sync_state WHERE tenant_id=$1 AND team_id=$2 AND state_key=$3', [team.tenantId, team.teamId, `team:${team.teamId}`]);
      assert.equal(row.rowCount, 1);
      assert.deepEqual((row.rows[0]?.state_json as { discoveredMatchIds: string[] }).discoveredMatchIds, [matchA]);
    }

    const domainA = new PubgDomainService({ teamContext: contextA, repository: repositoryA, now: () => new Date('2026-10-13T04:00:00.000Z') });
    const damage = await domainA.queryTeamDamage({
      sessionId: `worker-session-${suffix}`,
      selector: { type: 'time_range', from: '2026-10-12T00:00:00.000Z', to: '2026-10-13T00:00:00.000Z' },
      refresh: false,
    });
    assert.equal(damage.status, 'ok');
    assert.equal((damage.data as { totalDamage: number }).totalDamage, 15);
    assert.deepEqual(damage.evidenceRefs.matchIds, [matchA]);
    const feature = await repositoryA.get({
      matchId: matchA,
      parserVersion: DEFAULT_TELEMETRY_PARSER_VERSION,
      featureVersion: DEFAULT_REVIEW_FEATURE_VERSION,
    });
    assert.equal(feature?.facts.teamDamage?.[0]?.damage, 15);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
