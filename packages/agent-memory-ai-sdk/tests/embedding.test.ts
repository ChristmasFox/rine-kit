import assert from 'node:assert/strict';
import test from 'node:test';
import { MockEmbeddingModelV4 } from 'ai/test';
import { estimateMemoryEmbeddingTokens } from '@rine-kit/agent-memory';
import {
  MemoryEmbeddingProvider,
  createMemoryEmbeddingProvider,
  readMemoryEmbeddingConfig,
} from '../src/index.js';

function enabledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AI_MEMORY_EMBEDDING_BASE_URL: 'https://embeddings.example.test/v1',
    AI_MEMORY_EMBEDDING_MODEL_ID: 'fixture-embedding-v1',
    AI_MEMORY_EMBEDDING_API_KEY: 'fixture-key',
    AI_MEMORY_EMBEDDING_DIMENSIONS: '3',
    AI_MEMORY_EMBEDDING_INDEX_VERSION: '1',
    AI_MEMORY_EMBEDDING_DAILY_TOKEN_BUDGET: '10000',
    ...overrides,
  };
}

test('Embedding auto-enables only from a complete dedicated config and ignores chat credentials', () => {
  assert.equal(
    readMemoryEmbeddingConfig({
      MODEL_BASE_URL: 'https://chat.example.test/v1',
      MODEL_ID: 'chat',
      MODEL_API_KEY: 'chat-key',
      AI_MEMORY_EMBEDDING_API_KEY: 'must-not-be-used',
    }),
    null,
  );
  assert.equal(
    createMemoryEmbeddingProvider({
      env: {
        MODEL_BASE_URL: 'https://chat.example.test/v1',
        MODEL_ID: 'chat',
        MODEL_API_KEY: 'chat-key',
      },
    }),
    null,
  );
  assert.throws(
    () =>
      readMemoryEmbeddingConfig(enabledEnv({ AI_MEMORY_EMBEDDING_DAILY_TOKEN_BUDGET: undefined })),
    /agent_memory_embedding_config_incomplete/u,
  );
});

test('embedding config requires secure routing, its own key and bounded dimensions/budgets', () => {
  assert.ok(readMemoryEmbeddingConfig(enabledEnv()));
  assert.throws(
    () =>
      readMemoryEmbeddingConfig(
        enabledEnv({
          AI_MEMORY_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
        }),
      ),
    /agent_memory_embedding_config_invalid/u,
  );
  assert.throws(
    () =>
      readMemoryEmbeddingConfig(
        enabledEnv({
          AI_MEMORY_EMBEDDING_BASE_URL: 'http://embedding-internal:9000/v1',
        }),
      ),
    /agent_memory_embedding_config_invalid/u,
  );
  const internal = readMemoryEmbeddingConfig(
    enabledEnv({
      AI_MEMORY_EMBEDDING_BASE_URL: 'http://embedding-internal:9000/v1',
      AI_MEMORY_EMBEDDING_ALLOWED_INTERNAL_HOSTS: 'embedding-internal:9000',
    }),
  );
  assert.equal(internal?.allowedInternalHosts[0], 'embedding-internal:9000');
  assert.throws(
    () => readMemoryEmbeddingConfig(enabledEnv({ AI_MEMORY_EMBEDDING_DIMENSIONS: '16001' })),
    /agent_memory_embedding_config_invalid/u,
  );
  assert.throws(
    () => readMemoryEmbeddingConfig(enabledEnv({ AI_MEMORY_EMBEDDING_DAILY_REQUEST_BUDGET: '0' })),
    /agent_memory_embedding_config_invalid/u,
  );
  assert.equal(
    readMemoryEmbeddingConfig(enabledEnv({ AI_MEMORY_EMBEDDING_INDEX_VERSION: '1000000' }))
      ?.indexVersion,
    1_000_000,
  );
  assert.throws(
    () => readMemoryEmbeddingConfig(enabledEnv({ AI_MEMORY_EMBEDDING_INDEX_VERSION: '1000001' })),
    /agent_memory_embedding_config_invalid/u,
  );
  assert.equal(
    estimateMemoryEmbeddingTokens(['a', '艾伦格']),
    10,
    'the byte-level token ceiling safely accounts for multibyte text',
  );
});

test('AI SDK embedding batch is bounded, normalized and tagged with a content hash', async () => {
  const config = readMemoryEmbeddingConfig(enabledEnv({ AI_MEMORY_EMBEDDING_MAX_BATCH_SIZE: '2' }));
  assert.ok(config);
  const model = new MockEmbeddingModelV4({
    modelId: config.modelId,
    maxEmbeddingsPerCall: 2,
    doEmbed: async ({ values }) => ({
      embeddings: values.map(() => [3, 4, 0]),
      usage: { tokens: 7 },
      warnings: [],
    }),
  });
  const provider = new MemoryEmbeddingProvider(config, model);
  const result = await provider.embedMany(['艾伦格偏好', 'Miramar preference']);
  assert.deepEqual(result.vectors, [
    [0.6, 0.8, 0],
    [0.6, 0.8, 0],
  ]);
  assert.equal(result.contract.providerId, 'openai-compatible');
  assert.equal(result.contract.modelId, 'fixture-embedding-v1');
  assert.equal(result.contract.dimensions, 3);
  assert.equal(result.contract.normalization, 'l2_unit');
  assert.equal(result.contract.indexVersion, 1);
  assert.equal(result.inputTokens, 7);
  assert.equal(result.contentHashes.length, 2);
  assert.ok(result.contentHashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)));
  assert.equal(model.doEmbedCalls.length, 1);
  await assert.rejects(
    provider.embedMany(['one', 'two', 'three']),
    /agent_memory_embedding_batch_limit/u,
  );
  assert.equal(model.doEmbedCalls.length, 1, 'over-budget input never reaches the model');
  let providerAttempts = 0;
  const failingProvider = new MemoryEmbeddingProvider(
    config,
    new MockEmbeddingModelV4({
      doEmbed: async () => {
        providerAttempts += 1;
        throw new Error('private provider error');
      },
    }),
  );
  await assert.rejects(
    failingProvider.embedMany(['query']),
    /agent_memory_embedding_provider_failed/u,
  );
  assert.equal(providerAttempts, 1, 'provider failures are not retried and do not expose details');
});

test('dimension drift, NaN and zero vectors fail closed', async () => {
  const config = readMemoryEmbeddingConfig(enabledEnv());
  assert.ok(config);
  for (const vector of [
    [1, 0],
    [Number.NaN, 1, 0],
    [0, 0, 0],
  ]) {
    const provider = new MemoryEmbeddingProvider(
      config,
      new MockEmbeddingModelV4({
        maxEmbeddingsPerCall: 1,
        doEmbed: async () => ({ embeddings: [vector], usage: { tokens: 1 }, warnings: [] }),
      }),
    );
    await assert.rejects(provider.embedMany(['query']), /agent_memory_embedding_vector_invalid/u);
  }
});

test('embedding provider aborts a stalled fixture at its configured timeout', async () => {
  const config = readMemoryEmbeddingConfig(enabledEnv({ AI_MEMORY_EMBEDDING_TIMEOUT_MS: '100' }));
  assert.ok(config);
  const model = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 1,
    doEmbed: async ({ abortSignal }) =>
      await new Promise((_, reject) => {
        if (!abortSignal) return reject(new Error('fixture_abort_signal_missing'));
        // AbortSignal.timeout() uses an unref'd timer. A bare Promise + abort listener does not
        // keep node:test's event loop alive, so under CI concurrency the runner cancels this
        // test with "Promise resolution is still pending but the event loop has already resolved"
        // before the 100ms abort fires. Keep a ref'd stall timer until abort (or fail closed).
        const stall = setTimeout(() => reject(new Error('fixture_not_aborted')), 5_000);
        abortSignal.addEventListener(
          'abort',
          () => {
            clearTimeout(stall);
            reject(new Error('fixture_cancelled'));
          },
          { once: true },
        );
      }),
  });
  const provider = new MemoryEmbeddingProvider(config, model);
  await assert.rejects(provider.embedMany(['query']), /agent_memory_embedding_timeout/u);
});

test('the same configuration works under another host prefix and can be switched off', () => {
  const env = {
    GATE_MEMORY_EMBEDDING_BASE_URL: 'https://embeddings.example.test/v1',
    GATE_MEMORY_EMBEDDING_MODEL_ID: 'm',
    GATE_MEMORY_EMBEDDING_API_KEY: 'k',
    GATE_MEMORY_EMBEDDING_DAILY_TOKEN_BUDGET: '100',
  };
  assert.equal(readMemoryEmbeddingConfig(env), null); // default prefix sees nothing
  assert.equal(readMemoryEmbeddingConfig(env, 'GATE_MEMORY_EMBEDDING')?.modelId, 'm');
  assert.equal(
    readMemoryEmbeddingConfig(
      { ...env, GATE_MEMORY_EMBEDDING_ENABLED: '0' },
      'GATE_MEMORY_EMBEDDING',
    ),
    null,
  );
});
