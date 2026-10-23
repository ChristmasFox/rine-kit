import { createHash } from 'node:crypto';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embedMany, type EmbeddingModel } from 'ai';
import { estimateMemoryEmbeddingTokens } from '@rine-kit/agent-memory';
import type {
  MemoryEmbeddingBatch,
  MemoryEmbeddingClient,
  MemoryEmbeddingContract,
} from '@rine-kit/agent-memory';
import type { MemoryEmbeddingConfig } from './embedding-config.js';
import { DEFAULT_EMBEDDING_ENV_PREFIX, readMemoryEmbeddingConfig } from './embedding-config.js';

function normalizedText(value: string): string {
  if (typeof value !== 'string') throw new Error('agent_memory_embedding_input_invalid');
  const text = value.normalize('NFC').trim();
  if (
    !text ||
    Array.from(text).length > 1_000 ||
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
  ) {
    throw new Error('agent_memory_embedding_input_invalid');
  }
  return text;
}

function hashContent(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeVector(value: readonly number[], dimensions: number): number[] {
  if (value.length !== dimensions || value.some((item) => !Number.isFinite(item))) {
    throw new Error('agent_memory_embedding_vector_invalid');
  }
  const norm = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('agent_memory_embedding_vector_invalid');
  const normalized = value.map((item) => item / norm);
  if (normalized.some((item) => !Number.isFinite(item)))
    throw new Error('agent_memory_embedding_vector_invalid');
  return normalized;
}

export class MemoryEmbeddingProvider implements MemoryEmbeddingClient {
  readonly contract: MemoryEmbeddingContract;
  readonly dailyTokenBudget: number;
  readonly dailyRequestBudget: number;

  constructor(
    private readonly config: MemoryEmbeddingConfig,
    private readonly model: EmbeddingModel,
  ) {
    this.contract = {
      providerId: 'openai-compatible',
      modelId: config.modelId,
      dimensions: config.dimensions,
      normalization: 'l2_unit',
      indexVersion: config.indexVersion,
    };
    this.dailyTokenBudget = config.dailyTokenBudget;
    this.dailyRequestBudget = config.dailyRequestBudget;
  }

  async embedMany(
    rawValues: readonly string[],
    signal?: AbortSignal,
  ): Promise<MemoryEmbeddingBatch> {
    if (
      !Array.isArray(rawValues) ||
      rawValues.length < 1 ||
      rawValues.length > this.config.maxBatchSize
    ) {
      throw new Error('agent_memory_embedding_batch_limit');
    }
    const values = rawValues.map(normalizedText);
    const estimatedTokens = estimateMemoryEmbeddingTokens(values);
    if (estimatedTokens > this.config.maxInputTokensPerRequest)
      throw new Error('agent_memory_embedding_request_budget');
    if (signal?.aborted) throw new Error('agent_memory_embedding_aborted');

    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let result: Awaited<ReturnType<typeof embedMany>>;
    try {
      result = await embedMany({
        model: this.model,
        values,
        maxParallelCalls: 1,
        maxRetries: 0,
        abortSignal,
      });
    } catch {
      if (signal?.aborted) throw new Error('agent_memory_embedding_aborted');
      if (timeout.aborted) throw new Error('agent_memory_embedding_timeout');
      throw new Error('agent_memory_embedding_provider_failed');
    }
    if (result.embeddings.length !== values.length)
      throw new Error('agent_memory_embedding_vector_invalid');
    return {
      contract: this.contract,
      vectors: result.embeddings.map((vector) => normalizeVector(vector, this.config.dimensions)),
      contentHashes: values.map(hashContent),
      inputTokens:
        Number.isSafeInteger(result.usage.tokens) && result.usage.tokens >= 0
          ? result.usage.tokens
          : null,
    };
  }
}

export interface CreateMemoryEmbeddingProviderOptions {
  env?: NodeJS.ProcessEnv;
  /** Prefix of the host's configuration variables (default AI_MEMORY_EMBEDDING). */
  envPrefix?: string;
  /** How requests leave the process; Gate routed them through its egress guard. */
  fetch?: typeof fetch;
}

/** No secret or provider client is created until the configuration is complete and not switched off. */
export function createMemoryEmbeddingProvider(
  options: CreateMemoryEmbeddingProviderOptions = {},
): MemoryEmbeddingProvider | null {
  const config = readMemoryEmbeddingConfig(
    options.env ?? process.env,
    options.envPrefix ?? DEFAULT_EMBEDDING_ENV_PREFIX,
  );
  if (!config) return null;
  const provider = createOpenAICompatible({
    name: 'agent-memory-embedding',
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return new MemoryEmbeddingProvider(config, provider.embeddingModel(config.modelId));
}
