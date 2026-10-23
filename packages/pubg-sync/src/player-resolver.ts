import { PubgApiClient, PubgApiError } from '@rine-kit/pubg-domain/core';
import type { PublicPubgAdmission } from './request-limiter.js';
import { MAX_TEAM_ROSTER_SIZE } from '@rine-kit/pubg-postgres';

export interface ResolvedPubgPlayer { accountId: string; name: string; }
export interface PubgNameResolution {
  players: ResolvedPubgPlayer[];
  missingNames: string[];
  ambiguousNames: string[];
}
export interface PublicPubgPlayerResolverPort {
  resolveNames(shard: string, names: string[], signal?: AbortSignal): Promise<PubgNameResolution>;
}

const ACCEPTANCE_PLAYERS: ReadonlyMap<string, ResolvedPubgPlayer> = new Map([
  ['p3syntheticalpha', { accountId: 'account.p3synthetic_alpha', name: 'P3SyntheticAlpha' }],
  ['p3syntheticbravo', { accountId: 'account.p3synthetic_bravo', name: 'P3SyntheticBravo' }],
  ['p3syntheticcharlie', { accountId: 'account.p3synthetic_charlie', name: 'P3SyntheticCharlie' }],
  ['p3syntheticdelta', { accountId: 'account.p3synthetic_delta', name: 'P3SyntheticDelta' }],
]);

export function validatePublicPubgShard(shard: string): string {
  if (!['steam', 'kakao', 'psn', 'xbox'].includes(shard)) throw new Error('public_pubg_shard_invalid');
  return shard;
}

class AcceptanceSyntheticPlayerResolver implements PublicPubgPlayerResolverPort {
  async resolveNames(shard: string, names: string[]): Promise<PubgNameResolution> {
    validatePublicPubgShard(shard);
    if (!Array.isArray(names) || names.length < 1 || names.length > MAX_TEAM_ROSTER_SIZE
      || names.some(name => typeof name !== 'string' || !name.trim() || name.length > 100 || /[,\u0000-\u001f]/u.test(name))
      || new Set(names.map(name => name.trim().toLowerCase())).size !== names.length) throw new Error('public_pubg_names_invalid');
    const requested = names.map(name => name.trim());
    const players = shard === 'steam'
      ? requested.flatMap(name => {
        const player = ACCEPTANCE_PLAYERS.get(name.toLowerCase());
        return player ? [player] : [];
      })
      : [];
    const resolvedNames = new Set(players.map(player => player.name.toLowerCase()));
    return {
      players,
      missingNames: requested.filter(name => !resolvedNames.has(name.toLowerCase())),
      ambiguousNames: [],
    };
  }
}

/** Synthetic identities are intentionally available only to isolated acceptance
 * runs. Unknown names never fall through to the real PUBG API. */
export function createConfiguredPublicPubgPlayerResolver(options: {
  env: NodeJS.ProcessEnv;
  apiKey?: string;
  admission: PublicPubgAdmission;
}): { resolver: PublicPubgPlayerResolverPort; synthetic: boolean } {
  const acceptanceRequested = options.env.PUBG_SAAS_ACCEPTANCE_MODE !== undefined
    || options.env.PUBG_SAAS_SYNTHETIC_PUBG_PLAYERS !== undefined;
  if (acceptanceRequested) {
    if (options.env.PUBG_SAAS_ACCEPTANCE_MODE !== 'isolated'
      || options.env.PUBG_SAAS_SYNTHETIC_PUBG_PLAYERS !== '1'
      || options.env.NODE_ENV === 'production') throw new Error('pubg_saas_synthetic_resolver_forbidden');
    return { resolver: new AcceptanceSyntheticPlayerResolver(), synthetic: true };
  }
  if (!options.apiKey?.trim()) throw new Error('public_pubg_api_key_missing');
  return { resolver: new PublicPubgPlayerResolver({ apiKey: options.apiKey, admission: options.admission }), synthetic: false };
}

/** Uses the shared API implementation with independent public credentials and
 * a mandatory public admission controller. No private team/plugin is loaded. */
export class PublicPubgPlayerResolver implements PublicPubgPlayerResolverPort {
  private readonly client: PubgApiClient;
  constructor(options: { apiKey: string; admission: PublicPubgAdmission; fetcher?: typeof fetch }) {
    if (!options.apiKey.trim()) throw new Error('public_pubg_api_key_missing');
    const fetcher = options.fetcher ?? fetch;
    this.client = new PubgApiClient({
      apiKey: options.apiKey, baseUrl: 'https://api.pubg.com',
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== 'https://api.pubg.com' || !/^\/shards\/(steam|kakao|psn|xbox)\/players$/u.test(url.pathname)) throw new Error('public_pubg_endpoint_invalid');
        try { await options.admission.acquire(init?.signal ?? undefined); }
        catch (error) {
          if (error instanceof Error && error.message === 'public_pubg_lookup_rate_limited') throw new PubgApiError('rate_limited', 'Public PUBG admission busy', false);
          throw error;
        }
        const response = await fetcher(url, { ...init, redirect: 'error' });
        await options.admission.observe(response.headers, response.status);
        return response;
      },
    });
  }

  async resolveNames(shard: string, names: string[], signal?: AbortSignal): Promise<PubgNameResolution> {
    validatePublicPubgShard(shard);
    if (!Array.isArray(names) || names.length < 1 || names.length > MAX_TEAM_ROSTER_SIZE
      || names.some(name => typeof name !== 'string' || !name.trim() || name.length > 100 || /[,\u0000-\u001f]/u.test(name))
      || new Set(names.map(name => name.trim().toLowerCase())).size !== names.length) throw new Error('public_pubg_names_invalid');
    const requested = names.map(name => name.trim());
    let entries: Array<Record<string, unknown>>;
    try { entries = await this.client.discoverPlayers(shard, [], requested, signal); }
    catch (error) {
      if (error instanceof PubgApiError && error.code === 'not_found') return { players: [], missingNames: requested, ambiguousNames: [] };
      if (error instanceof PubgApiError && error.code === 'rate_limited') throw new Error('public_pubg_lookup_rate_limited');
      if (error instanceof Error && error.message === 'public_pubg_lookup_rate_limited') throw error;
      // Shared client may normalize fetch/admission failures into PubgApiError;
      // never pass upstream details or credential values to user messages.
      throw new Error('public_pubg_lookup_unavailable');
    }
    const players: ResolvedPubgPlayer[] = [], missingNames: string[] = [], ambiguousNames: string[] = [];
    for (const name of requested) {
      const matches = entries.filter(entry => entry.type === 'player' && entry.attributes && typeof entry.attributes === 'object'
        && typeof (entry.attributes as { name?: unknown }).name === 'string'
        && ((entry.attributes as { name: string }).name).toLowerCase() === name.toLowerCase());
      const unique = new Map<string, ResolvedPubgPlayer>();
      for (const entry of matches) {
        if (typeof entry.id !== 'string' || !/^account\.[A-Za-z0-9_-]{1,128}$/u.test(entry.id)) throw new Error('public_pubg_lookup_invalid_response');
        const apiName = (entry.attributes as { name: string }).name;
        if (!apiName.trim() || apiName.length > 100) throw new Error('public_pubg_lookup_invalid_response');
        unique.set(entry.id, { accountId: entry.id, name: apiName });
      }
      if (!unique.size) missingNames.push(name);
      else if (unique.size > 1) ambiguousNames.push(name);
      else players.push([...unique.values()][0]!);
    }
    if (new Set(players.map(player => player.accountId)).size !== players.length) throw new Error('public_pubg_lookup_invalid_response');
    return { players, missingNames, ambiguousNames };
  }
}
