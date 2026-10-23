import assert from 'node:assert/strict';
import test from 'node:test';
import {
  startWorkerHealthServer,
  startWorkerMetricsServer,
  stopWorkerHealthServer,
  stopWorkerMetricsServer,
} from '../src/worker-health-server.js';

test('worker health endpoint binds loopback and returns a non-cacheable liveness response', async () => {
  const server = await startWorkerHealthServer(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), 'ok\n');
  } finally {
    await stopWorkerHealthServer(server);
  }
});

test('worker health endpoint exposes no other path or method', async () => {
  const server = await startWorkerHealthServer(0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/metrics`)).status, 404);
    assert.equal((await fetch(`${base}/healthz`, { method: 'POST' })).status, 404);
  } finally {
    await stopWorkerHealthServer(server);
  }
});

test('worker metrics endpoint serves uncached Prometheus text on its container listener', async () => {
  const server = await startWorkerMetricsServer(() => 'pubg_saas_worker_up 1\n', 0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '0.0.0.0');
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type') ?? '', /text\/plain; version=0\.0\.4/u);
    assert.equal(await response.text(), 'pubg_saas_worker_up 1\n');
  } finally {
    await stopWorkerMetricsServer(server);
  }
});

test('worker metrics endpoint exposes no other path or method and fails closed on render errors', async () => {
  const server = await startWorkerMetricsServer(() => { throw new Error('private details'); }, 0);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/metrics`)).status, 503);
    assert.equal(await (await fetch(`${base}/metrics`)).text(), 'metrics_unavailable\n');
    assert.equal((await fetch(`${base}/other`)).status, 404);
    assert.equal((await fetch(`${base}/metrics`, { method: 'POST' })).status, 404);
  } finally {
    await stopWorkerMetricsServer(server);
  }
});
