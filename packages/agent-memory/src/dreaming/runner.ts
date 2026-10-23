import type { DreamingReport } from '../contracts.js';

export type MemoryDreamingWorkStatus = 'processed' | 'skipped' | 'retry' | 'dead' | 'timed_out';

export interface MemoryDreamingStageWorker {
  processNext(stage: 'light' | 'rem', signal: AbortSignal): Promise<MemoryDreamingWorkStatus>;
  processDeep(
    signal: AbortSignal,
  ): Promise<{ status: MemoryDreamingWorkStatus; processed: number }>;
}

export interface MemoryDreamingRunOptions {
  maxLightBatches?: number;
  maxRemBatches?: number;
  now?: () => Date;
}

function failed(status: MemoryDreamingWorkStatus): boolean {
  return status === 'retry' || status === 'dead' || status === 'timed_out';
}

async function drain(
  worker: MemoryDreamingStageWorker,
  stage: 'light' | 'rem',
  maxBatches: number,
  signal: AbortSignal,
): Promise<number> {
  let processed = 0;
  for (let batch = 0; batch < maxBatches && !signal.aborted; batch += 1) {
    const status = await worker.processNext(stage, signal);
    if (status === 'skipped') break;
    if (failed(status)) throw new Error(`memory_dreaming_${stage}_failed`);
    processed += 1;
  }
  if (signal.aborted) throw new Error('memory_dreaming_aborted');
  return processed;
}

/** Generic bounded Light -> REM -> Deep orchestration over host-owned workers. */
export async function runMemoryDreamingStages(
  worker: MemoryDreamingStageWorker,
  signal: AbortSignal,
  options: MemoryDreamingRunOptions = {},
): Promise<DreamingReport> {
  const maxLightBatches = options.maxLightBatches ?? 8;
  const maxRemBatches = options.maxRemBatches ?? 8;
  if (
    !Number.isSafeInteger(maxLightBatches) ||
    maxLightBatches < 1 ||
    maxLightBatches > 32 ||
    !Number.isSafeInteger(maxRemBatches) ||
    maxRemBatches < 1 ||
    maxRemBatches > 32
  ) {
    throw new Error('memory_dreaming_limits_invalid');
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const light = await drain(worker, 'light', maxLightBatches, signal);
  const rem = await drain(worker, 'rem', maxRemBatches, signal);
  if (signal.aborted) throw new Error('memory_dreaming_aborted');
  const deep = await worker.processDeep(signal);
  if (signal.aborted) throw new Error('memory_dreaming_aborted');
  if (failed(deep.status)) throw new Error('memory_dreaming_deep_failed');
  return {
    startedAt,
    completedAt: now().toISOString(),
    stages: [
      { stage: 'light', status: light ? 'completed' : 'skipped', processed: light },
      { stage: 'rem', status: rem ? 'completed' : 'skipped', processed: rem },
      {
        stage: 'deep',
        status: deep.status === 'processed' ? 'completed' : 'skipped',
        processed: deep.status === 'processed' ? deep.processed : 0,
      },
    ],
  };
}
