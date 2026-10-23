import { MEMORY_FEATURE_DEFAULTS } from './contracts.js';
import type {
  DreamingReport,
  ExplicitMemoryWrite,
  MemoryFeatureFlags,
  MemoryForgetRequest,
  MemoryHealth,
  MemoryObservation,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRetrievedCandidate,
  MemoryWriteResult,
} from './contracts.js';
import type { AgentMemoryPlugin } from './plugin.js';

export interface MemoryRuntimeRecallPort<TAuthorization> {
  recall(authorization: TAuthorization, request: MemoryRecallRequest): Promise<MemoryRecallResult>;
  recordUsed(
    authorization: TAuthorization,
    query: string,
    candidates: readonly MemoryRetrievedCandidate[],
  ): Promise<void>;
}

export interface MemoryRuntimeWritePort<TAuthorization> {
  remember(authorization: TAuthorization, write: ExplicitMemoryWrite): Promise<MemoryWriteResult>;
  forget(authorization: TAuthorization, request: MemoryForgetRequest): Promise<MemoryWriteResult>;
}

export interface MemoryRuntimeAdapters<TAuthorization> {
  observe:
    ((authorization: TAuthorization, observation: MemoryObservation) => Promise<void>) | null;
  recall: MemoryRuntimeRecallPort<TAuthorization> | null;
  writes: MemoryRuntimeWritePort<TAuthorization> | null;
  runDreaming: ((signal: AbortSignal) => Promise<DreamingReport>) | null;
}

export interface AgentMemoryRuntimeOptions<TAuthorization> {
  features?: Partial<MemoryFeatureFlags>;
  adapters: MemoryRuntimeAdapters<TAuthorization>;
  now?: () => Date;
}

function skippedReport(now: Date): DreamingReport {
  return {
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    stages: [
      { stage: 'light', status: 'skipped', processed: 0 },
      { stage: 'rem', status: 'skipped', processed: 0 },
      { stage: 'deep', status: 'skipped', processed: 0 },
    ],
  };
}

/** Generic feature-gated memory runtime; all identity and persistence remain in host adapters. */
export class AgentMemoryRuntime<TAuthorization> implements AgentMemoryPlugin<TAuthorization> {
  readonly features: Readonly<MemoryFeatureFlags>;
  private lastDreamingAt: string | null = null;
  private lastFailureCode: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: AgentMemoryRuntimeOptions<TAuthorization>) {
    this.features = Object.freeze({ ...MEMORY_FEATURE_DEFAULTS, ...options.features });
    this.now = options.now ?? (() => new Date());
  }

  get autoLearnEnabled(): boolean {
    return this.features.autoLearn;
  }

  async observe(authorization: TAuthorization, observation: MemoryObservation): Promise<void> {
    if (!this.features.autoLearn || !this.options.adapters.observe) return;
    await this.options.adapters.observe(authorization, observation);
  }

  async recall(
    authorization: TAuthorization,
    request: MemoryRecallRequest,
  ): Promise<MemoryRecallResult> {
    if (!this.features.read) {
      return { mode: 'disabled', reason: 'disabled_by_operator', candidates: [], context: null };
    }
    if (!this.options.adapters.recall) {
      return {
        mode: 'disabled',
        reason: 'memory_store_unavailable',
        candidates: [],
        context: null,
      };
    }
    return this.options.adapters.recall.recall(authorization, request);
  }

  async remember(
    authorization: TAuthorization,
    write: ExplicitMemoryWrite,
  ): Promise<MemoryWriteResult> {
    if (!this.features.write || !this.options.adapters.writes) return { status: 'not_found' };
    return this.options.adapters.writes.remember(authorization, write);
  }

  async forget(
    authorization: TAuthorization,
    request: MemoryForgetRequest,
  ): Promise<MemoryWriteResult> {
    if (!this.features.write || !this.options.adapters.writes) return { status: 'not_found' };
    return this.options.adapters.writes.forget(authorization, request);
  }

  async recordUsed(
    authorization: TAuthorization,
    query: string,
    candidates: readonly MemoryRetrievedCandidate[],
  ): Promise<void> {
    if (!this.features.read || !this.options.adapters.recall || !candidates.length) return;
    await this.options.adapters.recall.recordUsed(authorization, query, candidates);
  }

  async runDreaming(signal?: AbortSignal): Promise<DreamingReport> {
    if (!this.features.autoLearn) return skippedReport(this.now());
    if (!this.options.adapters.runDreaming) throw new Error('memory_dreaming_adapter_unavailable');
    try {
      const report = await this.options.adapters.runDreaming(
        signal ?? new AbortController().signal,
      );
      this.lastDreamingAt = report.completedAt;
      this.lastFailureCode = null;
      return report;
    } catch {
      this.lastFailureCode = 'dreaming_run_failed';
      throw new Error('memory_dreaming_run_failed');
    }
  }

  async health(): Promise<MemoryHealth> {
    const missingAdapter =
      (this.features.read && !this.options.adapters.recall) ||
      (this.features.write && !this.options.adapters.writes) ||
      (this.features.autoLearn &&
        (!this.options.adapters.observe || !this.options.adapters.runDreaming));
    const reason = this.lastFailureCode ?? (missingAdapter ? 'memory_adapter_unavailable' : null);
    return { status: reason ? 'degraded' : 'ready', lastDreamingAt: this.lastDreamingAt, reason };
  }
}
