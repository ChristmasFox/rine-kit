import type {
  ExplicitMemoryWrite,
  MemoryEmbeddingBatch,
  MemoryEmbeddingContract,
  MemoryEntry,
  MemoryForgetRequest,
  MemoryObservation,
  MemoryPlanningRequest,
  MemorySearchReason,
  MemoryUsageSignal,
  MemoryUsageSignalKind,
  MemoryWriteResult,
} from '../contracts.js';

export interface MemorySearchSources {
  exact(query: string, limit?: number): Promise<MemoryEntry[]>;
  lexical(query: string, limit?: number): Promise<MemoryEntry[]>;
  semantic(
    query: string,
    limit?: number,
  ): Promise<{ matches: MemoryEntry[]; reason: MemorySearchReason }>;
}

/** The caller keeps its identity/authorization token opaque to this package. */
export interface MemoryStoragePort<TAuthorization = unknown> {
  withAuthorizedSearch<T>(
    authorization: TAuthorization,
    work: (sources: MemorySearchSources) => Promise<T>,
  ): Promise<T>;
  observe(authorization: TAuthorization, observation: MemoryObservation): Promise<void>;
  recordUsageSignals(
    authorization: TAuthorization,
    kind: MemoryUsageSignalKind,
    signals: readonly MemoryUsageSignal[],
  ): Promise<void>;
  remember(authorization: TAuthorization, write: ExplicitMemoryWrite): Promise<MemoryWriteResult>;
  forget(authorization: TAuthorization, request: MemoryForgetRequest): Promise<MemoryWriteResult>;
}

export interface MemoryModelPort {
  plan(request: MemoryPlanningRequest, signal: AbortSignal): Promise<readonly unknown[]>;
}

export interface MemoryEmbeddingPort {
  embedMany(values: readonly string[], signal?: AbortSignal): Promise<MemoryEmbeddingBatch>;
}

export interface MemoryEmbeddingClient extends MemoryEmbeddingPort {
  readonly contract: MemoryEmbeddingContract;
  readonly dailyTokenBudget: number;
  readonly dailyRequestBudget: number;
}

export function estimateMemoryEmbeddingTokens(values: readonly string[]): number {
  return values.reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
}

export interface MemoryClockPort {
  now(): Date;
  sleepUntil(deadline: Date, signal: AbortSignal): Promise<void>;
}

export interface MemoryLogEvent {
  event: string;
  fields?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MemoryLogPort {
  info(event: MemoryLogEvent): void;
  warn(event: MemoryLogEvent): void;
  error(event: MemoryLogEvent): void;
}
