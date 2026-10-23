import { createMemoryUsageSignals } from '../signals.js';
import { fuseMemoryCandidates } from './fusion.js';
import type {
  MemoryRecallPolicyOptions,
  MemoryRecallResult,
  MemoryRetrievedCandidate,
  MemoryRetrievalMetric,
  MemoryRetrievalReason,
  MemoryUsageSignal,
  MemoryUsageSignalKind,
} from '../contracts.js';
import type { MemorySearchSources } from '../ports/index.js';

export interface MemoryRecallStoragePort<TAuthorization> {
  withAuthorizedSearch<T>(
    authorization: TAuthorization,
    work: (sources: MemorySearchSources) => Promise<T>,
  ): Promise<T>;
  recordUsageSignals(
    authorization: TAuthorization,
    kind: MemoryUsageSignalKind,
    signals: readonly MemoryUsageSignal[],
  ): Promise<void>;
}

export interface MemoryRecallServiceOptions extends Partial<MemoryRecallPolicyOptions> {
  candidateLimit?: number;
  now?: () => number;
  renderContext?: (candidates: readonly MemoryRetrievedCandidate[]) => string | null;
  onMetric?: (metric: MemoryRetrievalMetric) => void;
}

const DEFAULT_TOP_K = 6;
const DEFAULT_CANDIDATE_LIMIT = 20;
const DEFAULT_SEMANTIC_THRESHOLD = 0.72;
const DEFAULT_MINIMUM_SCORE = 0.005;

function fallbackContext(candidates: readonly MemoryRetrievedCandidate[]): string | null {
  if (!candidates.length) return null;
  return JSON.stringify(
    candidates.map((candidate) => ({
      key: candidate.key,
      content: candidate.content,
      recordedAt: candidate.updatedAt,
      source: candidate.sourceKind,
      revision: candidate.revision,
    })),
  );
}

function settled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function candidateSourcesFailed(
  exactFailed: boolean,
  lexicalFailed: boolean,
  semanticFailed: boolean,
  semanticReason: MemoryRetrievalReason,
): boolean {
  return exactFailed && lexicalFailed && (semanticFailed || semanticReason !== null);
}

/** Generic authorization-fenced recall orchestration; the host supplies scoped storage and rendering. */
export class MemoryRecallService<TAuthorization> {
  private readonly topK: number;
  private readonly candidateLimit: number;
  private readonly semanticSimilarityThreshold: number;
  private readonly minimumScore: number;
  private readonly now: () => number;

  constructor(
    private readonly storage: MemoryRecallStoragePort<TAuthorization>,
    private readonly options: MemoryRecallServiceOptions = {},
  ) {
    this.topK = options.topK ?? DEFAULT_TOP_K;
    this.candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
    this.semanticSimilarityThreshold =
      options.semanticSimilarityThreshold ?? DEFAULT_SEMANTIC_THRESHOLD;
    this.minimumScore = options.minimumScore ?? DEFAULT_MINIMUM_SCORE;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.topK) ||
      this.topK < 5 ||
      this.topK > 8 ||
      !Number.isSafeInteger(this.candidateLimit) ||
      this.candidateLimit < this.topK ||
      this.candidateLimit > 24 ||
      !Number.isFinite(this.semanticSimilarityThreshold) ||
      this.semanticSimilarityThreshold < -1 ||
      this.semanticSimilarityThreshold > 1 ||
      !Number.isFinite(this.minimumScore) ||
      this.minimumScore < 0 ||
      this.minimumScore > 1
    ) {
      throw new Error('memory_retrieval_limits_invalid');
    }
  }

  private report(
    startedAt: number,
    result: MemoryRecallResult,
    counts: {
      exact: number;
      lexical: number;
      semantic: number;
    },
  ): MemoryRecallResult {
    try {
      this.options.onMetric?.({
        mode: result.mode,
        reason: result.reason,
        durationMs: Math.max(0, this.now() - startedAt),
        candidateCount: result.candidates.length,
        exactCount: counts.exact,
        lexicalCount: counts.lexical,
        semanticCount: counts.semantic,
      });
    } catch {
      /* metrics never change recall */
    }
    return result;
  }

  async recall(
    authorization: TAuthorization,
    query: string,
    limit = this.candidateLimit,
  ): Promise<MemoryRecallResult> {
    const startedAt = this.now();
    const counts = { exact: 0, lexical: 0, semantic: 0 };
    if (typeof query !== 'string' || !query.trim()) {
      return this.report(
        startedAt,
        { mode: 'disabled', reason: 'memory_store_unavailable', candidates: [], context: null },
        counts,
      );
    }
    if (!Number.isSafeInteger(limit) || limit < this.topK || limit > 24) {
      return this.report(
        startedAt,
        { mode: 'disabled', reason: 'memory_store_unavailable', candidates: [], context: null },
        counts,
      );
    }
    try {
      return await this.storage.withAuthorizedSearch(authorization, async (searches) => {
        const results = await Promise.allSettled([
          searches.exact(query, limit),
          searches.lexical(query, limit),
          searches.semantic(query, limit),
        ] as const);
        const exactResult = results[0]!;
        const lexicalResult = results[1]!;
        const semanticResult = results[2]!;
        const exact = settled(exactResult, []);
        const lexical = settled(lexicalResult, []);
        const semantic = settled(semanticResult, {
          matches: [],
          reason: 'semantic_unavailable' as const,
        });
        counts.exact = exact.length;
        counts.lexical = lexical.length;
        counts.semantic = semantic.matches.length;
        const candidates = fuseMemoryCandidates(query, exact, lexical, semantic.matches, {
          topK: this.topK,
          semanticSimilarityThreshold: this.semanticSimilarityThreshold,
          minimumScore: this.minimumScore,
        });
        const allSourcesFailed = candidateSourcesFailed(
          exactResult.status === 'rejected',
          lexicalResult.status === 'rejected',
          semanticResult.status === 'rejected',
          semantic.reason,
        );
        const eitherCandidateSourceFailed =
          exactResult.status === 'rejected' || lexicalResult.status === 'rejected';
        const mode = allSourcesFailed
          ? 'disabled'
          : semantic.reason === null
            ? 'hybrid'
            : 'lexical_only';
        const reason: MemoryRetrievalReason = allSourcesFailed
          ? 'memory_store_unavailable'
          : eitherCandidateSourceFailed
            ? 'memory_candidate_source_unavailable'
            : semantic.reason;
        const visible = mode === 'disabled' ? [] : candidates;
        const result: MemoryRecallResult = {
          mode,
          reason,
          candidates: visible,
          context: visible.length ? (this.options.renderContext ?? fallbackContext)(visible) : null,
        };
        if (result.candidates.length) {
          try {
            const signals = createMemoryUsageSignals(query, result.candidates);
            await this.storage.recordUsageSignals(authorization, 'recalled', signals);
          } catch {
            /* usage evidence must never change recall */
          }
        }
        return this.report(startedAt, result, counts);
      });
    } catch {
      return this.report(
        startedAt,
        { mode: 'disabled', reason: 'memory_scope_unavailable', candidates: [], context: null },
        counts,
      );
    }
  }

  async recordUsed(
    authorization: TAuthorization,
    query: string,
    candidates: readonly MemoryRetrievedCandidate[],
  ): Promise<void> {
    const signals = createMemoryUsageSignals(query, candidates);
    await this.storage.recordUsageSignals(authorization, 'used', signals);
  }
}
