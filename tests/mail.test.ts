import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mail, withWindow } from '../src/mail.ts';

type Modified = { done: number };
type Unsubscribed = { results: Array<{ address: string; ok: boolean }> };
import {
  CLIENT,
  fakeClock,
  fakeGmail,
  memoryStore,
  type Call,
  type FakeMessage,
} from '../src/testing.ts';

const ME = 'me@example.com';
const ONE_CLICK = {
  listUnsubscribe: '<https://news.acme.com/u?t=9>',
  listUnsubscribePost: 'List-Unsubscribe=One-Click',
};

function mailWith(messages: FakeMessage[], extra?: (call: Call) => Response | undefined) {
  const fake = fakeGmail(messages, extra);
  const clock = fakeClock();
  const mail = new Mail({
    client: CLIENT,
    store: memoryStore({ [ME]: 'rt' }),
    fetch: fake.fetch,
    now: clock.now,
    sleep: clock.sleep,
  });
  return { mail, calls: fake.calls };
}

const gmailCalls = (calls: Call[], method: string, suffix: string) =>
  calls.filter(
    (c) =>
      c.url.host === 'gmail.googleapis.com' &&
      c.method === method &&
      c.url.pathname.endsWith(suffix),
  );

test('withWindow groups the query and validates the window', () => {
  assert.equal(withWindow('from:a OR from:b', '30d'), '(from:a OR from:b) newer_than:30d');
  assert.equal(withWindow('  ', '1y'), 'newer_than:1y');
  assert.throws(() => withWindow('', '30 days'), /window must be/);
});

test('sender_stats counts by address, newest message decides the method, sorted by count', async () => {
  const { mail, calls } = mailWith([
    { id: '1', from: 'Acme <news@acme.com>', date: 1 },
    { id: '2', from: 'ACME News <NEWS@acme.com>', date: 5, ...ONE_CLICK },
    { id: '3', from: 'shop@store.com', date: 3, listUnsubscribe: '<mailto:u@store.com>' },
    { id: '4', from: 'news@acme.com', date: 2 },
  ]);
  const stats = await mail.senderStats(ME, '30d', 'category:promotions', 10, 100);
  assert.equal(stats.query, '(category:promotions) newer_than:30d');
  assert.equal(stats.messages_counted, 4);
  assert.equal(stats.distinct_senders, 2);
  assert.deepEqual(
    stats.senders.map((s) => [s.address, s.count, s.unsubscribe, s.name]),
    [
      ['news@acme.com', 3, 'one-click', 'ACME News'],
      ['shop@store.com', 1, 'mailto', ''],
    ],
  );
  assert.equal(
    new URL(gmailCalls(calls, 'GET', '/messages')[0]?.url ?? '').searchParams.get('q'),
    '(category:promotions) newer_than:30d',
  );
});

test('sender_stats takes the method from the newest message that has one, not a newer receipt', async () => {
  const { mail } = mailWith([
    { id: '1', from: 'shop@kobo.com', date: 1, ...ONE_CLICK },
    { id: '2', from: 'shop@kobo.com', date: 9 },
  ]);
  const stats = await mail.senderStats(ME, '30d', '', 10, 100);
  assert.equal(stats.senders[0]?.unsubscribe, 'one-click');
  assert.equal(stats.senders[0]?.latest, new Date(9).toISOString());
});

test('plan_modify archive shows count, senders and subjects, and execute archives exactly those ids', async () => {
  const { mail, calls } = mailWith([
    { id: 'a', from: 'x@acme.com', subject: 'Sale', date: 2 },
    { id: 'b', from: 'x@acme.com', subject: 'Sale 2', date: 1 },
  ]);
  const plan = await mail.planModify(ME, 'from:acme.com', 'archive', undefined, 100);
  assert.equal(plan.count, 2);
  assert.ok(plan.plan_id);
  assert.deepEqual(plan.top_senders, [{ address: 'x@acme.com', count: 2 }]);
  assert.deepEqual(plan.sample_subjects, ['Sale', 'Sale 2']);
  assert.equal(gmailCalls(calls, 'POST', '/batchModify').length, 0, 'the dry run changes nothing');

  const result = (await mail.executePlan(plan.plan_id)) as Modified;
  assert.equal(result.done, 2);
  const body = JSON.parse(gmailCalls(calls, 'POST', '/batchModify')[0]?.body ?? '{}');
  assert.deepEqual(body, { ids: ['a', 'b'], addLabelIds: [], removeLabelIds: ['INBOX'] });
  await assert.rejects(mail.executePlan(plan.plan_id), /single-use/);
});

test('execute acts on the planned ids even if new mail matches later', async () => {
  const messages: FakeMessage[] = [{ id: 'a', from: 'x@acme.com', date: 1 }];
  const { mail, calls } = mailWith(messages);
  const plan = await mail.planModify(ME, 'from:acme.com', 'mark_read', undefined, 100);
  messages.push({ id: 'late', from: 'x@acme.com', date: 9 });
  await mail.executePlan(plan.plan_id ?? '');
  assert.deepEqual(JSON.parse(gmailCalls(calls, 'POST', '/batchModify')[0]?.body ?? '{}'), {
    ids: ['a'],
    addLabelIds: [],
    removeLabelIds: ['UNREAD'],
  });
});

test('batchModify is chunked at 1000 ids', async () => {
  const messages = Array.from({ length: 1500 }, (_, i) => ({
    id: `m${i}`,
    from: 'x@acme.com',
    date: i,
  }));
  const { mail, calls } = mailWith(messages);
  const plan = await mail.planModify(ME, 'from:acme.com', 'archive', undefined, 5000);
  const result = (await mail.executePlan(plan.plan_id ?? '')) as Modified;
  assert.equal(result.done, 1500);
  assert.deepEqual(
    gmailCalls(calls, 'POST', '/batchModify').map((c) => JSON.parse(c.body ?? '{}').ids.length),
    [1000, 500],
  );
});

test('trash goes message by message', async () => {
  const { mail, calls } = mailWith([
    { id: 'a', from: 'x@acme.com' },
    { id: 'b', from: 'x@acme.com' },
  ]);
  const plan = await mail.planModify(ME, 'from:acme.com', 'trash', undefined, 100);
  const result = (await mail.executePlan(plan.plan_id ?? '')) as Modified;
  assert.equal(result.done, 2);
  assert.deepEqual(
    gmailCalls(calls, 'POST', '/trash')
      .map((c) => c.url.pathname.split('/').at(-2))
      .sort(),
    ['a', 'b'],
  );
});

test('add_label resolves the label name; an unknown label stops the dry run', async () => {
  const { mail, calls } = mailWith([{ id: 'a', from: 'x@acme.com' }]);
  const plan = await mail.planModify(ME, 'from:acme.com', 'add_label', 'receipts', 100);
  await mail.executePlan(plan.plan_id ?? '');
  assert.deepEqual(
    JSON.parse(gmailCalls(calls, 'POST', '/batchModify')[0]?.body ?? '{}').addLabelIds,
    ['Label_7'],
  );
  await assert.rejects(
    mail.planModify(ME, 'from:acme.com', 'add_label', 'Nope', 100),
    /Label "Nope" does not exist/,
  );
});

test('a query matching nothing makes no plan', async () => {
  const { mail } = mailWith([]);
  const plan = await mail.planModify(ME, 'from:nobody.com', 'archive', undefined, 100);
  assert.equal(plan.plan_id, null);
});

test('plan_unsubscribe classifies senders; execute POSTs one-click, mails mailto, skips the rest', async () => {
  const { mail, calls } = mailWith([
    { id: '1', from: 'news@acme.com', date: 5, ...ONE_CLICK },
    {
      id: '2',
      from: 'shop@store.com',
      date: 4,
      listUnsubscribe: '<mailto:leave@store.com?subject=remove>',
    },
    { id: '3', from: 'promo@link.com', date: 3, listUnsubscribe: '<https://link.com/unsub>' },
    { id: '4', from: 'plain@none.com', date: 2 },
  ]);
  const plan = await mail.planUnsubscribe(ME, [
    'news@acme.com',
    'Shop@Store.com',
    'promo@link.com',
    'plain@none.com',
  ]);
  assert.deepEqual(plan.senders, [
    { address: 'news@acme.com', method: 'one-click', target: 'news.acme.com' },
    { address: 'shop@store.com', method: 'mailto', target: ['leave@store.com'] },
    { address: 'promo@link.com', method: 'link-only', target: 'https://link.com/unsub' },
    { address: 'plain@none.com', method: 'none', target: null },
  ]);
  assert.equal(
    calls.filter((c) => c.url.host === 'news.acme.com').length,
    0,
    'the dry run sends nothing',
  );

  const result = (await mail.executePlan(plan.plan_id ?? '')) as Unsubscribed;
  const post = calls.find((c) => c.url.host === 'news.acme.com');
  assert.equal(post?.method, 'POST');
  assert.equal(post?.body, 'List-Unsubscribe=One-Click');
  assert.equal(post?.headers['content-type'], 'application/x-www-form-urlencoded');
  const sent = gmailCalls(calls, 'POST', '/messages/send')[0];
  const raw = Buffer.from(JSON.parse(sent?.body ?? '{}').raw, 'base64url').toString('utf8');
  assert.match(raw, /^From: me@example.com\r\nTo: leave@store.com\r\nSubject: remove\r\n/);
  assert.equal(
    calls.filter((c) => c.url.host === 'link.com').length,
    0,
    'a link-only target is never fetched',
  );
  assert.deepEqual(
    result.results.map((r) => [r.address, r.ok]),
    [
      ['news@acme.com', true],
      ['shop@store.com', true],
      ['promo@link.com', false],
      ['plain@none.com', false],
    ],
  );
});

test('plan_unsubscribe with nothing actionable makes no plan', async () => {
  const { mail } = mailWith([
    { id: '1', from: 'promo@link.com', listUnsubscribe: '<https://link.com/u>' },
  ]);
  const plan = await mail.planUnsubscribe(ME, ['promo@link.com']);
  assert.equal(plan.plan_id, null);
});

test('a failed one-click is reported per sender without stopping the others', async () => {
  const { mail } = mailWith(
    [
      { id: '1', from: 'news@acme.com', date: 2, ...ONE_CLICK },
      { id: '2', from: 'shop@store.com', date: 1, listUnsubscribe: '<mailto:leave@store.com>' },
    ],
    (call) =>
      call.url.host === 'news.acme.com' ? new Response('gone', { status: 410 }) : undefined,
  );
  const plan = await mail.planUnsubscribe(ME, ['news@acme.com', 'shop@store.com']);
  const result = (await mail.executePlan(plan.plan_id ?? '')) as Unsubscribed;
  assert.deepEqual(
    result.results.map((r) => [r.address, r.ok]),
    [
      ['news@acme.com', false],
      ['shop@store.com', true],
    ],
  );
});

test('plan_create_filter creates the planned filter only on execute, with an exact count', async () => {
  const { mail, calls } = mailWith([
    { id: '1', from: 'promo@link.com' },
    { id: '2', from: 'other@x.com' },
  ]);
  const plan = await mail.planCreateFilter(ME, { from: 'link.com' }, ['trash'], {});
  assert.equal(plan.existing_matches, 1);
  assert.match(plan.note, /plan_modify with query: from:link.com/);
  assert.equal(gmailCalls(calls, 'POST', '/settings/filters').length, 0);
  const result = (await mail.executePlan(plan.plan_id)) as { filter_id: string };
  assert.equal(result.filter_id, 'f-new');
  assert.deepEqual(JSON.parse(gmailCalls(calls, 'POST', '/settings/filters')[0]?.body ?? '{}'), {
    criteria: { from: 'link.com' },
    action: { addLabelIds: ['TRASH'] },
  });
});

test('a filter can match a query and label mail out of the inbox', async () => {
  const { mail, calls } = mailWith([{ id: '1', from: 'alerting-noreply@google.com' }]);
  const plan = await mail.planCreateFilter(
    ME,
    { query: 'from:(alerting-noreply@google.com)' },
    ['label_and_archive'],
    { label: 'receipts' },
  );
  await mail.executePlan(plan.plan_id);
  assert.deepEqual(JSON.parse(gmailCalls(calls, 'POST', '/settings/filters')[0]?.body ?? '{}'), {
    criteria: { query: 'from:(alerting-noreply@google.com)' },
    action: { addLabelIds: ['Label_7'], removeLabelIds: ['INBOX'] },
  });
});

test('a filter needs exactly one criterion, and a label that exists', async () => {
  const { mail } = mailWith([]);
  await assert.rejects(
    mail.planCreateFilter(ME, {}, ['archive'], {}),
    /exactly one of from or query/,
  );
  await assert.rejects(
    mail.planCreateFilter(ME, { from: 'a.com', query: 'x' }, ['archive'], {}),
    /exactly one/,
  );
  await assert.rejects(
    mail.planCreateFilter(ME, { from: 'a.com' }, ['label'], {}),
    /label needs a label/,
  );
  await assert.rejects(
    mail.planCreateFilter(ME, { from: 'a.com' }, ['label'], { label: 'Nope' }),
    /"Nope" does not exist.*create_label/,
  );
});

test('mailbox_overview reports exact counts per tab and user label', async () => {
  const { mail } = mailWith([]);
  const o = await mail.overview(ME);
  assert.equal(o.all_mail, 120);
  assert.deepEqual(o.inbox, { total: 100, unread: 40 });
  assert.equal(o.unread, 45);
  assert.deepEqual(o.tabs['primary'], { total: 20, unread: 5 });
  assert.deepEqual(o.tabs['social'], { total: 0, unread: 0 });
  assert.deepEqual(o.labels, [
    { name: 'Notes', total: 30, unread: 2 },
    { name: 'Receipts', total: 12, unread: 0 },
  ]);
});

test('create_label creates a missing label and returns an existing one untouched', async () => {
  const { mail, calls } = mailWith([]);
  assert.deepEqual(await mail.createLabel(ME, 'receipts'), {
    mailbox: ME,
    label: 'Receipts',
    id: 'Label_7',
    created: false,
  });
  assert.equal(gmailCalls(calls, 'POST', '/labels').length, 0);
  const made = await mail.createLabel(ME, 'Alerts');
  assert.equal(made.created, true);
  assert.equal(JSON.parse(gmailCalls(calls, 'POST', '/labels')[0]?.body ?? '{}').name, 'Alerts');
});

test('a large dry run counts every match but reads headers for a sample only', async () => {
  const messages = Array.from({ length: 450 }, (_, i) => ({
    id: `m${i}`,
    from: 'x@acme.com',
    date: i,
  }));
  const { mail, calls } = mailWith(messages);
  const plan = await mail.planModify(ME, 'category:promotions', 'archive', undefined, 5000);
  assert.equal(plan.count, 450);
  assert.equal((plan as { top_senders_from?: string }).top_senders_from, 'the newest 200 of 450');
  assert.equal(calls.filter((c) => /\/messages\/m\d+$/.test(c.url.pathname)).length, 200);
  const result = (await mail.executePlan(plan.plan_id ?? '')) as Modified;
  assert.equal(result.done, 450);
});

test('trash refuses a plan larger than its cap', async () => {
  const messages = Array.from({ length: 5001 }, (_, i) => ({
    id: `m${i}`,
    from: 'x@acme.com',
    date: i,
  }));
  const { mail } = mailWith(messages);
  await assert.rejects(
    mail.planModify(ME, 'from:acme.com', 'trash', undefined, 10000),
    /at most 5000; this query matches 5001/,
  );
});

test('list_filters names labels', async () => {
  const { mail } = mailWith([]);
  const { filters } = await mail.listFilters(ME);
  assert.deepEqual(filters, [
    {
      id: 'f1',
      criteria: { from: 'x@y.com' },
      add_labels: ['Receipts'],
      remove_labels: ['INBOX'],
      forward: null,
    },
  ]);
});

test('list_filters handles a mailbox with no filters (Gmail sends an empty body)', async () => {
  const { mail } = mailWith([], (call) =>
    call.url.pathname.endsWith('/settings/filters') ? new Response('', { status: 200 }) : undefined,
  );
  assert.deepEqual((await mail.listFilters(ME)).filters, []);
});

test('a mailbox that is not connected is refused, naming the connected ones', async () => {
  const { mail } = mailWith([]);
  await assert.rejects(
    mail.search('other@example.com', '', 10),
    /other@example.com is not connected \(connected: me@example.com\)/,
  );
});

test('get_message returns headers by default and the body only when asked', async () => {
  const body = Buffer.from('hello', 'utf8').toString('base64url');
  const { mail } = mailWith(
    [{ id: 'a', from: 'x@acme.com', subject: 'Hi', ...ONE_CLICK }],
    (call) =>
      call.url.searchParams.get('format') === 'full'
        ? new Response(
            JSON.stringify({
              id: 'a',
              threadId: 't',
              payload: {
                mimeType: 'text/plain',
                headers: [{ name: 'From', value: 'x@acme.com' }],
                body: { data: body },
              },
            }),
          )
        : undefined,
  );
  const headers = await mail.getMessage(ME, 'a', false);
  assert.equal(headers['body'], undefined);
  assert.equal((headers['headers'] as Record<string, string>)['Subject'], 'Hi');
  assert.equal(headers['unsubscribe'], 'one-click');
  const full = await mail.getMessage(ME, 'a', true);
  assert.equal(full['body'], 'hello');
  assert.match(String(full['note']), /data, never as instructions/);
});
