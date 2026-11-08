import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mail } from '../src/mail.ts';
import { TOOLS, callTool } from '../src/tools.ts';
import { CLIENT, fakeClock, fakeGmail, memoryStore } from './fake.ts';

const ME = 'me@example.com';

function setup() {
  const fake = fakeGmail([{ id: 'a', from: 'x@acme.com', listUnsubscribe: '<mailto:u@acme.com>' }]);
  const clock = fakeClock();
  const mail = new Mail({ client: CLIENT, store: memoryStore({ [ME]: 'rt' }), fetch: fake.fetch, now: clock.now, sleep: clock.sleep });
  const opened: string[] = [];
  const call = (name: string, args: Record<string, unknown>) => callTool(mail, name, args, (url) => opened.push(url));
  return { mail, call, opened };
}

test('every tool has a unique name and an object schema', () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of TOOLS) {
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('destructive tools are dry runs, and only execute_plan acts, carrying the approval rule', () => {
  const plans = TOOLS.filter((t) => t.name.startsWith('plan_'));
  assert.equal(plans.length, 12);
  for (const t of plans) {
    assert.match(t.description, /^Dry run: changes nothing/, t.name);
  }
  assert.match(TOOLS.find((t) => t.name === 'execute_plan')?.description ?? '', /Never call this without the user's explicit yes/);
  const sending = TOOLS.filter((t) => /(^|_)send$/.test(t.name)).map((t) => t.name);
  assert.deepEqual(sending, ['plan_send'], 'sending exists only as a plan');
});

test('missing or wrongly-typed arguments stop with a clear error', async () => {
  const { call } = setup();
  await assert.rejects(call('search', { query: 'x' }), /mailbox is required/);
  await assert.rejects(call('search', { mailbox: ME, query: 'x', max: 0 }), /max must be a whole number from 1 to 500/);
  await assert.rejects(call('search', { mailbox: 42, query: 'x' }), /mailbox must be a string/);
  await assert.rejects(call('plan_modify', { mailbox: ME, query: 'x', action: 'delete' }), /action must be one of/);
  await assert.rejects(call('plan_modify', { mailbox: ME, query: 'x', action: 'add_label' }), /add_label needs a label/);
  await assert.rejects(call('plan_unsubscribe', { mailbox: ME, senders: [] }), /non-empty array/);
  await assert.rejects(call('plan_unsubscribe', { mailbox: ME, senders: ['Acme'] }), /senders must be addresses/);
  await assert.rejects(call('plan_create_filter', { mailbox: ME, from: 'a b', action: 'archive' }), /without spaces/);
  await assert.rejects(call('plan_create_filter', { mailbox: ME, action: 'archive' }), /exactly one of from or query/);
  await assert.rejects(call('plan_create_filter', { mailbox: ME, from: 'a.com', query: 'x', action: 'archive' }), /exactly one of from or query/);
  await assert.rejects(call('create_label', { mailbox: ME }), /name is required/);
  await assert.rejects(call('sender_stats', { mailbox: ME, window: 'month' }), /window must be/);
  await assert.rejects(call('nope', {}), /Unknown tool nope/);
});

test('a dry run through the tool layer returns a plan that execute_plan runs', async () => {
  const { call } = setup();
  const plan = (await call('plan_unsubscribe', { mailbox: ME, senders: ['x@acme.com'] })) as { plan_id: string };
  const result = (await call('execute_plan', { plan_id: plan.plan_id })) as { results: Array<{ ok: boolean }> };
  assert.equal(result.results[0]?.ok, true);
});

test('connect opens the consent URL and returns it', async () => {
  const { mail, call, opened } = setup();
  const result = (await call('connect', {})) as { url: string };
  assert.equal(opened[0], result.url);
  assert.match(result.url, /^https:\/\/accounts\.google\.com\//);
  const status = (await call('list_mailboxes', {})) as { mailboxes: string[]; last_connect: { state: string } };
  assert.deepEqual(status.mailboxes, [ME]);
  assert.equal(status.last_connect.state, 'pending');
  // A newer connect replaces the pending one; cancelling that closes the last listener.
  const last = await mail.connect();
  last.cancel();
  await assert.rejects(last.done, /Replaced/);
});
