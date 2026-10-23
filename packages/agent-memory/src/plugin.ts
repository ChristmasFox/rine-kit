import type {
  DreamingReport,
  ExplicitMemoryWrite,
  MemoryForgetRequest,
  MemoryHealth,
  MemoryObservation,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRetrievedCandidate,
  MemoryWriteResult,
} from './contracts.js';

/** Authorization stays opaque to the generic package and is supplied by the host for each request. */
export interface AgentMemoryPlugin<TAuthorization = unknown> {
  observe(authorization: TAuthorization, turn: MemoryObservation): Promise<void>;
  recall(authorization: TAuthorization, request: MemoryRecallRequest): Promise<MemoryRecallResult>;
  remember(authorization: TAuthorization, write: ExplicitMemoryWrite): Promise<MemoryWriteResult>;
  forget(authorization: TAuthorization, request: MemoryForgetRequest): Promise<MemoryWriteResult>;
  recordUsed(
    authorization: TAuthorization,
    query: string,
    candidates: readonly MemoryRetrievedCandidate[],
  ): Promise<void>;
  runDreaming(signal?: AbortSignal): Promise<DreamingReport>;
  health(): Promise<MemoryHealth>;
}
