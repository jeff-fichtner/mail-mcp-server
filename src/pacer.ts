// Gmail meters each mailbox in quota units (a list or get costs 5, a batch modify 50, a send 100),
// not in requests, and also limits concurrent requests per mailbox. The pacer holds both: a bucket
// of units that refills continuously, and a cap on calls in flight. When Gmail throttles anyway,
// pause() stops every caller at once, so retries do not keep the quota window full.
// Acquisition is first-come, first-served.

export interface PacerOptions {
  unitsPerSecond: number;
  // The bucket's size: the most units spendable at once. Defaults to one second's worth.
  burst?: number;
  maxConcurrent: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class Pacer {
  private readonly rate: number;
  private readonly capacity: number;
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private units: number;
  private refilledAt: number;
  private active = 0;
  private pausedUntil = 0;
  private slotWaiters: Array<() => void> = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(options: PacerOptions) {
    this.rate = options.unitsPerSecond;
    this.capacity = options.burst ?? options.unitsPerSecond;
    this.maxConcurrent = options.maxConcurrent;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.units = this.capacity;
    this.refilledAt = this.now();
  }

  async run<T>(cost: number, fn: () => Promise<T>): Promise<T> {
    if (cost > this.capacity) {
      throw new Error(
        `A call costing ${cost} units can never fit a bucket of ${this.capacity} units`,
      );
    }
    const turn = this.queue.then(() => this.acquire(cost));
    this.queue = turn.catch(() => undefined);
    await turn;
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  private async acquire(cost: number): Promise<void> {
    for (;;) {
      const paused = this.pausedUntil - this.now();
      if (paused > 0) {
        await this.sleep(paused);
        continue;
      }
      if (this.active >= this.maxConcurrent) {
        await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
        continue;
      }
      this.refill();
      if (this.units >= cost) {
        this.units -= cost;
        this.active += 1;
        return;
      }
      await this.sleep(Math.ceil(((cost - this.units) / this.rate) * 1000));
    }
  }

  private release(): void {
    this.active -= 1;
    this.slotWaiters.shift()?.();
  }

  private refill(): void {
    const now = this.now();
    this.units = Math.min(this.capacity, this.units + ((now - this.refilledAt) / 1000) * this.rate);
    this.refilledAt = now;
  }
}
