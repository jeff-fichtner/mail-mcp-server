// Plans make every destructive action two-step. A dry run stores exactly what it showed (the
// message ids, the senders, the filter) under a short-lived id; execute_plan acts on that and
// nothing else, never re-running the query. A plan is single-use.

import { randomBytes } from 'node:crypto';

export interface Plan<P> {
  id: string;
  kind: string;
  mailbox: string;
  expiresAt: number;
  payload: P;
}

export class PlanStore {
  readonly ttlMs: number;
  private readonly now: () => number;
  private readonly plans = new Map<string, Plan<unknown>>();

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  create<P>(kind: string, mailbox: string, payload: P): Plan<P> {
    this.sweep();
    const plan: Plan<P> = {
      id: randomBytes(6).toString('hex'),
      kind,
      mailbox,
      expiresAt: this.now() + this.ttlMs,
      payload,
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  take(id: string): Plan<unknown> {
    const plan = this.plans.get(id);
    this.plans.delete(id);
    const minutes = Math.round(this.ttlMs / 60000);
    if (!plan) {
      throw new Error(`No plan ${id}. Plans are single-use and expire after ${minutes} minutes; run the dry run again.`);
    }
    if (plan.expiresAt <= this.now()) {
      throw new Error(`Plan ${id} expired (plans last ${minutes} minutes); run the dry run again.`);
    }
    return plan;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, plan] of this.plans) {
      if (plan.expiresAt <= now) {
        this.plans.delete(id);
      }
    }
  }
}
