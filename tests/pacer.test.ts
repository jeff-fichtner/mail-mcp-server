import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pacer } from '../src/pacer.ts';

// A fake clock: sleeping advances time instantly, so the tests measure budget, not wall time.
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    elapsed: () => now,
  };
}

test('calls within the per-second budget do not wait', async () => {
  const clock = fakeClock();
  const pacer = new Pacer({
    unitsPerSecond: 100,
    maxConcurrent: 10,
    now: clock.now,
    sleep: clock.sleep,
  });
  await Promise.all(Array.from({ length: 20 }, () => pacer.run(5, async () => 'ok')));
  assert.equal(clock.elapsed(), 0);
});

test('spending past the budget waits for the bucket to refill', async () => {
  const clock = fakeClock();
  const pacer = new Pacer({
    unitsPerSecond: 100,
    maxConcurrent: 10,
    now: clock.now,
    sleep: clock.sleep,
  });
  // 40 calls at 5 units = 200 units: the first 100 are free, the next 100 take one second.
  await Promise.all(Array.from({ length: 40 }, () => pacer.run(5, async () => 'ok')));
  assert.ok(clock.elapsed() >= 1000 && clock.elapsed() <= 1100, `elapsed ${clock.elapsed()}`);
});

test('no more than maxConcurrent calls are in flight', async () => {
  const pacer = new Pacer({ unitsPerSecond: 1000, maxConcurrent: 3 });
  let inFlight = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      pacer.run(1, async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      }),
    ),
  );
  assert.equal(peak, 3);
});

test('a failing call releases its slot', async () => {
  const pacer = new Pacer({ unitsPerSecond: 1000, maxConcurrent: 1 });
  await assert.rejects(
    pacer.run(1, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await pacer.run(1, async () => 'next'), 'next');
});

test('a call costing more than the bucket is refused; burst makes room for it', async () => {
  const clock = fakeClock();
  const pacer = new Pacer({
    unitsPerSecond: 50,
    maxConcurrent: 1,
    now: clock.now,
    sleep: clock.sleep,
  });
  await assert.rejects(
    pacer.run(100, async () => 'x'),
    /can never fit a bucket of 50 units/,
  );
  const roomy = new Pacer({
    unitsPerSecond: 50,
    burst: 100,
    maxConcurrent: 1,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(await roomy.run(100, async () => 'sent'), 'sent');
});

test('pause holds every caller until it ends', async () => {
  const clock = fakeClock();
  const pacer = new Pacer({
    unitsPerSecond: 1000,
    maxConcurrent: 10,
    now: clock.now,
    sleep: clock.sleep,
  });
  pacer.pause(5000);
  await Promise.all([pacer.run(1, async () => 'a'), pacer.run(1, async () => 'b')]);
  assert.equal(clock.elapsed(), 5000);
});
