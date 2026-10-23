import { isIP } from 'node:net';

export interface MemoryEmbeddingConfig {
  baseURL: string;
  modelId: string;
  apiKey: string;
  allowedInternalHosts: readonly string[];
  dimensions: number;
  indexVersion: number;
  timeoutMs: number;
  maxBatchSize: number;
  maxInputTokensPerRequest: number;
  dailyTokenBudget: number;
  dailyRequestBudget: number;
}

/** The environment variable names for one host; Gate used GATE_MEMORY_EMBEDDING_*, RINE uses AI_MEMORY_EMBEDDING_*. */
export function embeddingEnvKeys(prefix: string) {
  return {
    enabled: `${prefix}_ENABLED`,
    baseURL: `${prefix}_BASE_URL`,
    modelId: `${prefix}_MODEL_ID`,
    apiKey: `${prefix}_API_KEY`,
    internalHosts: `${prefix}_ALLOWED_INTERNAL_HOSTS`,
    dimensions: `${prefix}_DIMENSIONS`,
    indexVersion: `${prefix}_INDEX_VERSION`,
    timeoutMs: `${prefix}_TIMEOUT_MS`,
    maxBatchSize: `${prefix}_MAX_BATCH_SIZE`,
    maxInputTokensPerRequest: `${prefix}_MAX_INPUT_TOKENS_PER_REQUEST`,
    dailyTokenBudget: `${prefix}_DAILY_TOKEN_BUDGET`,
    dailyRequestBudget: `${prefix}_DAILY_REQUEST_BUDGET`,
  } as const;
}

export const DEFAULT_EMBEDDING_ENV_PREFIX = 'AI_MEMORY_EMBEDDING';

function clean(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = clean(value);
  if (!raw) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error('agent_memory_embedding_config_invalid');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error('agent_memory_embedding_config_invalid');
  }
  return parsed;
}

function parseAllowedInternalHosts(value: string | undefined): string[] {
  const raw = clean(value);
  if (!raw) return [];
  const hosts = raw.split(',').map((entry) => entry.trim());
  if (hosts.some((host) => !host) || new Set(hosts).size !== hosts.length) {
    throw new Error('agent_memory_embedding_config_invalid');
  }
  return hosts.map((host) => {
    const match =
      /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*):([1-9][0-9]{0,4})$/iu.exec(
        host,
      );
    if (!match || match[1]!.length > 253 || isIP(match[1]!) !== 0) {
      throw new Error('agent_memory_embedding_config_invalid');
    }
    const port = Number(match[2]);
    if (port > 65535) throw new Error('agent_memory_embedding_config_invalid');
    return `${match[1]!.toLowerCase()}:${port}`;
  });
}

function validBaseURL(value: string, allowedInternalHosts: readonly string[]): boolean {
  if (value.length > 500) return false;
  try {
    const url = new URL(value);
    const explicitlyAllowedHttp =
      url.protocol === 'http:' && allowedInternalHosts.includes(url.host.toLowerCase());
    return (
      (url.protocol === 'https:' || explicitlyAllowedHttp) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Auto-enable when fully configured. Missing config means lexical fallback; =0 is a kill switch. */
export function readMemoryEmbeddingConfig(
  env: NodeJS.ProcessEnv,
  prefix = DEFAULT_EMBEDDING_ENV_PREFIX,
): MemoryEmbeddingConfig | null {
  const keys = embeddingEnvKeys(prefix);
  const enable = clean(env[keys.enabled]);
  if (enable === '0') return null;
  if (enable && enable !== '1') throw new Error('agent_memory_embedding_config_invalid');
  const baseURL = clean(env[keys.baseURL]);
  const modelId = clean(env[keys.modelId]);
  const apiKey = clean(env[keys.apiKey]);
  const dailyTokenBudget = clean(env[keys.dailyTokenBudget]);
  // A stray secret alone is not configuration. Endpoint/model presence declares intent.
  if (!baseURL && !modelId) {
    if (enable === '1') throw new Error('agent_memory_embedding_config_incomplete');
    return null;
  }
  if (!baseURL || !modelId || !apiKey || !dailyTokenBudget) {
    throw new Error('agent_memory_embedding_config_incomplete');
  }
  const allowedInternalHosts = parseAllowedInternalHosts(env[keys.internalHosts]);
  /* eslint-disable no-control-regex -- rejecting control characters is the point */
  if (
    !validBaseURL(baseURL, allowedInternalHosts) ||
    modelId.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(modelId) ||
    apiKey.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(apiKey)
  ) {
    /* eslint-enable no-control-regex */
    throw new Error('agent_memory_embedding_config_invalid');
  }
  return {
    baseURL,
    modelId,
    apiKey,
    allowedInternalHosts,
    dimensions: boundedInteger(env[keys.dimensions], 1, 1, 16_000),
    indexVersion: boundedInteger(env[keys.indexVersion], 1, 1, 1_000_000),
    timeoutMs: boundedInteger(env[keys.timeoutMs], 10_000, 100, 30_000),
    maxBatchSize: boundedInteger(env[keys.maxBatchSize], 8, 1, 16),
    maxInputTokensPerRequest: boundedInteger(env[keys.maxInputTokensPerRequest], 4_096, 1, 16_384),
    dailyTokenBudget: boundedInteger(env[keys.dailyTokenBudget], 1, 1, 1_000_000),
    dailyRequestBudget: boundedInteger(env[keys.dailyRequestBudget], 100, 1, 10_000),
  };
}
