export class SerialDedupeQueue {
  constructor(handler, { onError = (error) => console.error(error), onReplace } = {}) {
    this.handler = handler;
    this.onError = onError;
    this.onReplace = onReplace;
    this.pending = new Map();
    this.order = [];
    this.running = false;
    this.idleWaiters = [];
  }

  enqueue(job) {
    const previous = this.pending.get(job.key);
    if (!this.pending.has(job.key)) this.order.push(job.key);
    this.pending.set(job.key, job);
    if (previous && this.onReplace) {
      queueMicrotask(() => this.onReplace(previous, job));
    }
    if (!this.running) queueMicrotask(() => this.drain());
  }

  get size() {
    return this.pending.size + (this.running ? 1 : 0);
  }

  onIdle() {
    if (!this.running && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.order.length > 0) {
        const key = this.order.shift();
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
