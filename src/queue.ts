export interface QueueOptions<Job> {
  onError?: (error: Error, job: Job) => void;
}

export class SerialDedupeQueue<Job extends { key: string }> {
  private readonly handler: (job: Job) => Promise<unknown>;
  private readonly onError: (error: Error, job: Job) => void;
  private readonly pending = new Map<string, Job>();
  private readonly order: string[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private running = false;

  constructor(handler: (job: Job) => Promise<unknown>, { onError }: QueueOptions<Job> = {}) {
    this.handler = handler;
    this.onError = onError ?? ((error) => console.error(error));
  }

  enqueue(job: Job): void {
    if (!this.pending.has(job.key)) this.order.push(job.key);
    this.pending.set(job.key, job);
    if (!this.running) queueMicrotask(() => this.drain());
  }

  get size(): number {
    return this.pending.size + (this.running ? 1 : 0);
  }

  onIdle(): Promise<void> {
    if (!this.running && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.order.length > 0) {
        const key = this.order.shift();
        if (key === undefined) continue;
        const job = this.pending.get(key);
        this.pending.delete(key);
        if (!job) continue;
        try {
          await this.handler(job);
        } catch (error) {
          this.onError(error, job);
        }
      }
    } finally {
      this.running = false;
      if (this.pending.size > 0) {
        queueMicrotask(() => this.drain());
      } else {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }
}
