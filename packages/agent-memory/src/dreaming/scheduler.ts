import { memoryDreamingLocalDateAt, nextMemoryDreamingAt } from './schedule.js';
import type { DreamingReport } from '../contracts.js';

export interface MemoryDreamingSchedulePoint {
  timezone: string;
  localDate: string;
  scheduledAt: Date;
}

export interface MemoryDreamingRunStore<TIdentity> {
  claim(identity: TIdentity): Promise<string | null>;
  finish(identity: TIdentity, runId: string, status: 'succeeded' | 'failed'): Promise<void>;
}

export interface MemoryDreamingSchedulerOptions<TIdentity> {
  timezone?: string;
  fallbackTimezone: string;
  identity(point: MemoryDreamingSchedulePoint): TIdentity;
  now?: () => number;
  sleepUntil?: (timestamp: number, signal: AbortSignal) => Promise<void>;
}

export interface MemoryDreamingRunner {
  runDreaming(signal?: AbortSignal): Promise<DreamingReport>;
}

async function defaultSleepUntil(timestamp: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const delay = Math.max(0, timestamp - Date.now());
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Single host-process scheduler: one local 03:00 run, durable claim, and next-date retry. */
export async function runMemoryDreamingScheduler<TIdentity>(
  runner: MemoryDreamingRunner,
  store: MemoryDreamingRunStore<TIdentity>,
  signal: AbortSignal,
  onRun: (value: Record<string, unknown>) => void,
  options: MemoryDreamingSchedulerOptions<TIdentity>,
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleepUntil = options.sleepUntil ?? defaultSleepUntil;
  const requestedTimezone = options.timezone?.trim() || options.fallbackTimezone;
  try {
    nextMemoryDreamingAt(now(), requestedTimezone);
  } catch {
    onRun({ event: 'dreaming_timezone_fallback', timezone: options.fallbackTimezone });
  }
  const effectiveTimezone = (() => {
    try {
      nextMemoryDreamingAt(now(), requestedTimezone);
      return requestedTimezone;
    } catch {
      return options.fallbackTimezone;
    }
  })();

  while (!signal.aborted) {
    let scheduledAt: number;
    try {
      scheduledAt = nextMemoryDreamingAt(now(), effectiveTimezone);
    } catch {
      onRun({ event: 'dreaming_schedule_failed', status: 'failed' });
      return;
    }
    try {
      while (!signal.aborted && now() < scheduledAt) await sleepUntil(scheduledAt, signal);
    } catch {
      onRun({ event: 'dreaming_schedule_failed', status: 'failed' });
      return;
    }
    if (signal.aborted) return;

    const identity = options.identity({
      timezone: effectiveTimezone,
      localDate: memoryDreamingLocalDateAt(scheduledAt, effectiveTimezone),
      scheduledAt: new Date(scheduledAt),
    });
    let runId: string | null;
    try {
      runId = await store.claim(identity);
    } catch {
      onRun({ event: 'dreaming_run_failed', status: 'failed', errorCode: 'dreaming_claim_failed' });
      continue;
    }
    if (!runId) {
      onRun({
        event: 'dreaming_run_skipped',
        status: 'duplicate',
        localDate: memoryDreamingLocalDateAt(scheduledAt, effectiveTimezone),
      });
      continue;
    }

    try {
      const report = await runner.runDreaming(signal);
      await store.finish(identity, runId, 'succeeded');
      onRun({
        event: 'dreaming_run_completed',
        status: 'succeeded',
        localDate: memoryDreamingLocalDateAt(scheduledAt, effectiveTimezone),
        report,
      });
    } catch {
      await store.finish(identity, runId, 'failed').catch(() => undefined);
      onRun({
        event: 'dreaming_run_failed',
        status: 'failed',
        localDate: memoryDreamingLocalDateAt(scheduledAt, effectiveTimezone),
        errorCode: 'dreaming_run_failed',
      });
    }
  }
}
