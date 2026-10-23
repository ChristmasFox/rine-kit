import assert from 'node:assert/strict';
import test from 'node:test';
import { configurePublicEgress, parsePublicEgressProxy } from '../src/index.js';

test('public egress dispatcher URL rejects unsafe proxy URLs and enforces required configuration', () => {
  assert.equal(parsePublicEgressProxy(undefined), null);
  assert.equal(parsePublicEgressProxy(' http://egress-proxy:8080 ' )?.href, 'http://egress-proxy:8080/');
  for (const value of [
    'https://egress-proxy:8080', 'http://user:pass@egress-proxy:8080',
    'http://egress-proxy:8080/path', 'http://egress-proxy:8080/?x=1',
    'http://egress-proxy', 'not a URL',
  ]) assert.throws(() => parsePublicEgressProxy(value), /pubg_saas_egress_proxy_invalid/u);
  assert.throws(() => configurePublicEgress({ PUBG_SAAS_EGRESS_PROXY_REQUIRED: '1' }), /pubg_saas_egress_proxy_required/u);
});
