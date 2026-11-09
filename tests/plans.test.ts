import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanStore } from '../src/plans.ts';

test('a plan is returned once with its payload, then is gone', () => {
  const store = new PlanStore(600000);
  const plan = store.create('modify', 'a@example.com', { ids: ['1', '2'] });
  const taken = store.take(plan.id);
  assert.equal(taken.kind, 'modify');
  assert.equal(taken.mailbox, 'a@example.com');
  assert.deepEqual(taken.payload, { ids: ['1', '2'] });
  assert.throws(() => store.take(plan.id), /No plan .* single-use/);
});

test('an expired plan is refused', () => {
  let now = 1000;
  const store = new PlanStore(60000, () => now);
  const plan = store.create('modify', 'a@example.com', {});
  now += 60000;
  assert.throws(() => store.take(plan.id), /expired/);
});

test('an unknown id is refused', () => {
  const store = new PlanStore(60000);
  assert.throws(() => store.take('nope'), /No plan nope/);
});

test('ids are distinct', () => {
  const store = new PlanStore(60000);
  const ids = new Set(Array.from({ length: 50 }, () => store.create('k', 'm', {}).id));
  assert.equal(ids.size, 50);
});
