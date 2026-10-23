import { ProxyAgent, setGlobalDispatcher } from 'undici';

const proxyKey = 'PUBG_SAAS_EGRESS_PROXY';

export function parsePublicEgressProxy(value: string | undefined): URL | null {
  if (value === undefined || value.trim() === '') return null;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('pubg_saas_egress_proxy_invalid'); }
  if (url.protocol !== 'http:' || !url.hostname || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !url.port
    || !/^[a-z0-9.-]+$/u.test(url.hostname) || url.hostname.startsWith('.')
    || url.hostname.endsWith('.') || url.hostname.includes('..')) {
    throw new Error('pubg_saas_egress_proxy_invalid');
  }
  return url;
}

/** Install one process-wide egress proxy for Node fetch, the AI SDK and the
 * Node WebSocket implementation. Compose keeps application containers on
 * internal networks and points this dispatcher at the guarded proxy service. */
export function configurePublicEgress(env: NodeJS.ProcessEnv = process.env): boolean {
  const proxy = parsePublicEgressProxy(env[proxyKey]);
  if (!proxy) {
    if (env.PUBG_SAAS_EGRESS_PROXY_REQUIRED === '1') {
      throw new Error('pubg_saas_egress_proxy_required');
    }
    return false;
  }
  setGlobalDispatcher(new ProxyAgent(proxy.toString()));
  return true;
}
