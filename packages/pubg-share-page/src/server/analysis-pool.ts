import { Worker } from 'node:worker_threads';

type Task = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  message: Record<string, unknown>;
};

/**
 * A small pool of worker threads for CPU-bound telemetry work. Parsing a 25 MB telemetry file and analysing it takes
 * seconds; doing that on the server's own thread froze every request (the page was unreachable for about 90 seconds
 * after each restart), so it runs here and the server thread stays free.
 */
export class WorkerPool {
  private readonly idle: Worker[] = [];
  private readonly queue: Task[] = [];
  private readonly workers = new Set<Worker>();
  private readonly active = new Map<Worker, Task>();
  private closed = false;

  constructor(
    private readonly script: URL,
    private readonly size: number,
    /** Extra node flags for the worker (a TypeScript loader when the host does not already run one); replaces the inherited flags, which a worker may refuse. */
    private readonly execArgv: string[] = [],
  ) {}

  run<T>(message: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('worker_pool_closed'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ resolve: resolve as (value: unknown) => void, reject, message });
      this.pump();
    });
  }

  private spawn(): Worker {
    const worker = new Worker(
      this.script,
      this.execArgv.length > 0 ? { execArgv: this.execArgv } : {},
    );
    this.workers.add(worker);
    worker.on('message', (value: { ok: boolean; result?: unknown; error?: string }) => {
      const task = this.active.get(worker);
      this.active.delete(worker);
      this.idle.push(worker);
      if (task) {
        if (value.ok) task.resolve(value.result);
        else task.reject(new Error(value.error ?? 'worker_task_failed'));
      }
      this.pump();
    });
    const drop = (error: unknown) => {
      const task = this.active.get(worker);
      this.active.delete(worker);
      this.workers.delete(worker);
      const index = this.idle.indexOf(worker);
      if (index >= 0) this.idle.splice(index, 1);
      task?.reject(error instanceof Error ? error : new Error('worker_crashed'));
      this.pump();
    };
    worker.on('error', drop);
    worker.on('exit', () => {
      if (this.workers.has(worker)) drop(new Error('worker_exited'));
    });
    return worker;
  }

  private pump(): void {
    while (this.queue.length > 0 && !this.closed) {
      let worker = this.idle.pop();
      if (!worker && this.workers.size < this.size) worker = this.spawn();
      if (!worker) return;
      const task = this.queue.shift()!;
      this.active.set(worker, task);
      worker.postMessage(task.message);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.queue.splice(0)) task.reject(new Error('worker_pool_closed'));
    await Promise.all([...this.workers].map((worker) => worker.terminate()));
    this.workers.clear();
  }
}
