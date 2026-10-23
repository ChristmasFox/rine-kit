export type MemorySourceKind = 'trusted_ingress' | 'user_confirmed' | 'system_verified' | 'unknown';

export interface MemoryEntry {
  key: string;
  content: string;
  revision: number;
  updatedAt: string;
  sourceEventId: string;
  sourceKind: MemorySourceKind;
  sourceReliability: number;
  validUntil: string | null;
  semanticSimilarity?: number;
}

export interface MemoryDraft {
  key: string;
  content: string;
}

export interface MemoryWriteMetadata {
  sourceKind?: MemorySourceKind;
  sourceReliability?: number;
  validUntil?: string | null;
}

export interface MemoryWriteState extends MemoryEntry {
  revoked: boolean;
}

export type MemorySearchMode = 'semantic' | 'lexical_only';
export type MemorySearchReason =
  | 'semantic_unconfigured'
  | 'vector_index_unavailable'
  | 'semantic_unavailable'
  | 'semantic_timeout'
  | 'embedding_budget_exhausted'
  | 'embedding_budget_unavailable'
  | null;

export interface MemorySearchResult {
  entries: MemoryEntry[];
  mode: MemorySearchMode;
  reason: MemorySearchReason;
}

export interface MemorySearchMetric {
  durationMs: number;
  mode: MemorySearchMode;
  reason: MemorySearchReason;
}

export interface MemorySemanticSearchResult {
  matches: MemoryEntry[];
  reason: MemorySearchReason;
}

export type MemoryRetrievalMode = 'hybrid' | 'lexical_only' | 'disabled';
export type MemoryRetrievalReason =
  | MemorySearchReason
  | 'memory_scope_unavailable'
  | 'memory_store_unavailable'
  | 'memory_candidate_source_unavailable'
  | 'disabled_by_operator';

export interface MemoryRetrievedCandidate {
  canonicalKey: string;
  key: string;
  content: string;
  revision: number;
  updatedAt: string;
  sourceEventId: string;
  sourceKind: MemorySourceKind;
  score: number;
  sources: Array<'exact' | 'lexical' | 'semantic'>;
  reasons: string[];
}

export interface MemoryRetrievalMetric {
  mode: MemoryRetrievalMode;
  reason: MemoryRetrievalReason;
  durationMs: number;
  candidateCount: number;
  exactCount: number;
  lexicalCount: number;
  semanticCount: number;
}

export interface MemoryRecallResult {
  mode: MemoryRetrievalMode;
  reason: MemoryRetrievalReason;
  candidates: MemoryRetrievedCandidate[];
  context: string | null;
}

/** Content-free signal linking a trusted recalled entry to one request. */
export interface MemoryUsageSignal {
  key: string;
  revision: number;
  sourceEventId: string;
  queryFingerprint: string;
}

export type MemoryUsageSignalKind = 'recalled' | 'used';

export interface MemoryRecallPolicyOptions {
  topK: number;
  semanticSimilarityThreshold: number;
  minimumScore: number;
}

export interface MemoryEvidence {
  id: string;
  observedAt: string;
  source: 'conversation' | 'user_confirmed' | 'system_verified';
}

export interface MemoryObservation {
  content: string;
  observedAt: string;
  evidence: readonly MemoryEvidence[];
}

export interface MemoryRecallRequest {
  query: string;
  limit?: number;
}

export interface ExplicitMemoryWrite extends MemoryDraft {
  operation: 'remember' | 'correct';
  expectedRevision?: number;
  validUntil?: string | null;
}

export interface MemoryForgetRequest {
  key: string;
  expectedRevision?: number;
}

export type MemoryWriteResult = {
  status: 'created' | 'revised' | 'forgotten' | 'already_present' | 'not_found';
};

export type DreamingStage = 'light' | 'rem' | 'deep';
export type MemoryCandidateSubject = 'self' | 'third_party' | 'unknown';
export type MemoryCandidateKind = 'stable_preference' | 'verifiable_fact' | 'episodic_checkpoint';
export type MemoryCandidateValidity = 'stable' | '7_days' | '30_days' | '90_days' | 'unknown';

export interface MemoryCandidateDraft extends MemoryDraft {
  confidence: 'high' | 'medium';
  subject: MemoryCandidateSubject;
  kind: MemoryCandidateKind;
  evidence: string;
  validity: MemoryCandidateValidity;
}

export interface MemoryPlanningRequest {
  stage: DreamingStage;
  messages: readonly { content: string; createdAt: string }[];
}

export interface DreamingStageResult {
  stage: DreamingStage;
  status: 'completed' | 'skipped' | 'failed';
  processed: number;
}

export interface DreamingReport {
  startedAt: string;
  completedAt: string | null;
  stages: readonly DreamingStageResult[];
}

export interface MemoryHealth {
  status: 'ready' | 'degraded';
  lastDreamingAt: string | null;
  reason: string | null;
}

export interface MemoryFeatureFlags {
  read: boolean;
  write: boolean;
  autoLearn: boolean;
}

export const MEMORY_FEATURE_DEFAULTS: Readonly<MemoryFeatureFlags> = {
  read: true,
  write: true,
  autoLearn: true,
} as const;

export interface MemoryEmbeddingContract {
  providerId: string;
  modelId: string;
  dimensions: number;
  normalization: 'l2_unit';
  indexVersion: number;
}

export interface MemoryEmbeddingBatch {
  contract: MemoryEmbeddingContract;
  vectors: number[][];
  contentHashes: string[];
  inputTokens: number | null;
}
