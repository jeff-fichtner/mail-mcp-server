import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mail } from '../src/mail.ts';
import { TOOLS, callTool } from '../src/tools.ts';
import {
  CLIENT,
  SEND_AS,
  fakeClock,
  fakeGmail,
  json,
  memoryStore,
  type Call,
} from '../src/testing.ts';

const ME = 'me@example.com';

// Settings endpoints the shared fake does not answer.
function settingsRoutes(
  forwarding: Array<{ forwardingEmail: string; verificationStatus: string }>,
) {
  return (call: Call): Response | undefined => {
    const path = call.url.pathname.replace('/gmail/v1/users/me', '');
    if (call.method === 'GET' && path === '/settings/sendAs') {
      return json(200, {
        sendAs: [
          ...SEND_AS,
          {
            sendAsEmail: 'support@example.com',
            displayName: 'Old',
            verificationStatus: 'accepted',
          },
        ],
      });
    }
    if (call.method === 'GET' && path === '/settings/forwardingAddresses') {
      return json(200, { forwardingAddresses: forwarding });
    }
    if (call.method === 'GET' && path === '/settings/autoForwarding') {
      return json(200, { enabled: false });
    }
    if (call.method === 'GET' && path === '/settings/vacation') {
      return json(200, { enableAutoReply: false });
    }
    if (call.method === 'PATCH' && path.startsWith('/labels/')) {
      return json(200, { id: 'Label_7', ...JSON.parse(call.body ?? '{}') });
    }
    if (
      ['PUT', 'PATCH'].includes(call.method) ||
      (call.method === 'POST' && path.startsWith('/settings/'))
    ) {
      return json(200, JSON.parse(call.body ?? '{}'));
    }
    return undefined;
  };
}

function mailWith(forwarding: Array<{ forwardingEmail: string; verificationStatus: string }> = []) {
  const fake = fakeGmail([{ id: 'm1', from: 'x@acme.com' }], settingsRoutes(forwarding));
  const clock = fakeClock();
  const mail = new Mail({
    client: CLIENT,
    store: memoryStore({ [ME]: 'rt' }),
    fetch: fake.fetch,
    now: clock.now,
    sleep: clock.sleep,
  });
  return {
    mail,
    calls: fake.calls,
    call: (name: string, args: Record<string, unknown>) =>
      callTool(mail, name, args, () => undefined),
  };
}

const gmailCall = (calls: Call[], method: string, suffix: string) =>
  calls.filter(
    (c) =>
      c.url.host === 'gmail.googleapis.com' &&
      c.method === method &&
      decodeURIComponent(c.url.pathname).endsWith(suffix),
  );
const bodyOf = (call: Call | undefined) => JSON.parse(call?.body ?? '{}');

test("filter actions combine as in Gmail's dialog", async () => {
  const { mail, calls } = mailWith();
  const plan = await mail.planCreateFilter(
    ME,
    { from: 'shop.com' },
    ['label', 'never_spam', 'mark_read', 'archive'],
    { label: 'Receipts' },
  );
  await mail.executePlan(plan.plan_id);
  assert.deepEqual(bodyOf(gmailCall(calls, 'POST', '/settings/filters')[0]).action, {
    addLabelIds: ['Label_7'],
    removeLabelIds: ['SPAM', 'UNREAD', 'INBOX'],
  });
});

test('never_spam keeps group mail out of Spam', async () => {
  const { mail, calls } = mailWith();
  const query = 'to:(support@example.com OR privacy@example.com OR security@example.com)';
  const plan = await mail.planCreateFilter(ME, { query }, ['never_spam'], {});
  await mail.executePlan(plan.plan_id);
  assert.deepEqual(bodyOf(gmailCall(calls, 'POST', '/settings/filters')[0]), {
    criteria: { query },
    action: { removeLabelIds: ['SPAM'] },
  });
});

test('categorize needs a tab; star and importance map to their labels', async () => {
  const { mail, calls } = mailWith();
  await assert.rejects(
    mail.planCreateFilter(ME, { from: 'a.com' }, ['categorize'], {}),
    /categorize needs a category/,
  );
  const plan = await mail.planCreateFilter(
    ME,
    { from: 'a.com' },
    ['categorize', 'star', 'never_important'],
    { category: 'promotions' },
  );
  await mail.executePlan(plan.plan_id);
  assert.deepEqual(bodyOf(gmailCall(calls, 'POST', '/settings/filters')[0]).action, {
    addLabelIds: ['CATEGORY_PROMOTIONS', 'STARRED'],
    removeLabelIds: ['IMPORTANT'],
  });
});

test('a forwarding filter needs a confirmed forwarding address', async () => {
  await assert.rejects(
    mailWith().mail.planCreateFilter(ME, { from: 'a.com' }, ['forward'], {}),
    /forward needs forward_to/,
  );
  await assert.rejects(
    mailWith().mail.planCreateFilter(ME, { from: 'a.com' }, ['forward'], { forwardTo: 'b@x.com' }),
    /not a forwarding address/,
  );
  const pending = mailWith([{ forwardingEmail: 'b@x.com', verificationStatus: 'pending' }]);
  await assert.rejects(
    pending.mail.planCreateFilter(ME, { from: 'a.com' }, ['forward'], { forwardTo: 'b@x.com' }),
    /not confirmed yet/,
  );
  const ok = mailWith([{ forwardingEmail: 'b@x.com', verificationStatus: 'accepted' }]);
  const plan = await ok.mail.planCreateFilter(ME, { from: 'a.com' }, ['forward'], {
    forwardTo: 'B@x.com',
  });
  assert.equal(plan.forward_to, 'b@x.com');
  await ok.mail.executePlan(plan.plan_id);
  assert.deepEqual(bodyOf(gmailCall(ok.calls, 'POST', '/settings/filters')[0]).action, {
    forward: 'b@x.com',
  });
});

test('update_label renames directly; colors come as a pair', async () => {
  const { mail, calls } = mailWith();
  await assert.rejects(
    mail.updateLabel(ME, 'Receipts', undefined, '#000000', undefined),
    /as a pair/,
  );
  await assert.rejects(mail.updateLabel(ME, 'Nope', 'x', undefined, undefined), /does not exist/);
  const result = await mail.updateLabel(ME, 'receipts', 'Invoices', '#16a766', '#ffffff');
  assert.equal(result.previous_name, 'Receipts');
  assert.deepEqual(bodyOf(gmailCall(calls, 'PATCH', '/labels/Label_7')[0]), {
    name: 'Invoices',
    color: { backgroundColor: '#16a766', textColor: '#ffffff' },
  });
});

test('deleting a label is a plan; system labels are refused', async () => {
  const { mail, calls } = mailWith();
  await assert.rejects(mail.planDeleteLabel(ME, 'INBOX'), /system label/);
  const plan = await mail.planDeleteLabel(ME, 'Receipts');
  assert.equal(plan['messages_with_label'], 12);
  assert.equal(gmailCall(calls, 'DELETE', '/labels/Label_7').length, 0);
  await mail.executePlan(String(plan['plan_id']));
  assert.equal(gmailCall(calls, 'DELETE', '/labels/Label_7').length, 1);
});

test('the vacation responder is a plan; on needs a body and real dates', async () => {
  const { mail, calls } = mailWith();
  await assert.rejects(mail.planSetVacation(ME, { enabled: true }), /needs a body/);
  await assert.rejects(
    mail.planSetVacation(ME, { enabled: true, body: 'away', start: 'next week' }),
    /start must be a date/,
  );
  const plan = await mail.planSetVacation(ME, {
    enabled: true,
    subject: 'Away',
    body: 'Back Monday',
    start: '2026-11-01T00:00:00Z',
  });
  assert.equal(gmailCall(calls, 'PUT', '/settings/vacation').length, 0);
  await mail.executePlan(String(plan['plan_id']));
  assert.deepEqual(bodyOf(gmailCall(calls, 'PUT', '/settings/vacation')[0]), {
    enableAutoReply: true,
    responseSubject: 'Away',
    responseBodyPlainText: 'Back Monday',
    startTime: String(Date.parse('2026-11-01T00:00:00Z')),
  });
});

test('send-as addresses are added, updated and removed through plans', async () => {
  const { mail, calls } = mailWith();
  const create = await mail.planCreateSendAs(ME, 'privacy@example.com', {
    displayName: 'brand',
    treatAsAlias: true,
  });
  await mail.executePlan(String(create['plan_id']));
  assert.deepEqual(bodyOf(gmailCall(calls, 'POST', '/settings/sendAs')[0]), {
    sendAsEmail: 'privacy@example.com',
    treatAsAlias: true,
    displayName: 'brand',
  });

  await assert.rejects(
    mail.planUpdateSendAs(ME, 'nobody@example.com', { displayName: 'x' }),
    /not a send-as address/,
  );
  await assert.rejects(mail.planUpdateSendAs(ME, 'support@example.com', {}), /at least one/);
  const update = await mail.planUpdateSendAs(ME, 'Support@Example.com', { displayName: 'brand' });
  assert.deepEqual(update['display_name'], { from: 'Old', to: 'brand' });
  await mail.executePlan(String(update['plan_id']));
  assert.deepEqual(bodyOf(gmailCall(calls, 'PATCH', '/settings/sendAs/support@example.com')[0]), {
    displayName: 'brand',
  });

  await assert.rejects(mail.planDeleteSendAs(ME, 'me@example.com'), /cannot be removed/);
  const remove = await mail.planDeleteSendAs(ME, 'support@example.com');
  await mail.executePlan(String(remove['plan_id']));
  assert.equal(gmailCall(calls, 'DELETE', '/settings/sendAs/support@example.com').length, 1);
});

test('auto-forward names its destination and needs a confirmed address', async () => {
  const pending = mailWith([{ forwardingEmail: 'b@x.com', verificationStatus: 'pending' }]);
  await assert.rejects(
    pending.mail.planSetAutoForward(ME, true, undefined, undefined),
    /needs the address/,
  );
  await assert.rejects(
    pending.mail.planSetAutoForward(ME, true, 'b@x.com', undefined),
    /not confirmed yet/,
  );
  const ok = mailWith([{ forwardingEmail: 'b@x.com', verificationStatus: 'accepted' }]);
  const plan = await ok.mail.planSetAutoForward(ME, true, 'b@x.com', 'archive');
  assert.equal(plan['forward_every_incoming_message_to'], 'b@x.com');
  await ok.mail.executePlan(String(plan['plan_id']));
  assert.deepEqual(bodyOf(gmailCall(ok.calls, 'PUT', '/settings/autoForwarding')[0]), {
    enabled: true,
    emailAddress: 'b@x.com',
    disposition: 'archive',
  });

  const add = await ok.mail.planAddForwardingAddress(ME, 'c@x.com');
  await ok.mail.executePlan(String(add['plan_id']));
  assert.deepEqual(bodyOf(gmailCall(ok.calls, 'POST', '/settings/forwardingAddresses')[0]), {
    forwardingEmail: 'c@x.com',
  });
});

test('a token without the new scope gets a reconnect message, not a raw 403', async () => {
  const fake = fakeGmail([], (call) =>
    call.url.pathname.endsWith('/settings/forwardingAddresses')
      ? json(403, {
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            errors: [{ reason: 'insufficientPermissions' }],
          },
        })
      : undefined,
  );
  const clock = fakeClock();
  const mail = new Mail({
    client: CLIENT,
    store: memoryStore({ [ME]: 'rt' }),
    fetch: fake.fetch,
    now: clock.now,
    sleep: clock.sleep,
  });
  await assert.rejects(
    mail.listForwarding(ME),
    /me@example.com has not granted the permission this needs.*Run connect/,
  );
});

test('the tool layer takes one action or several, never both', async () => {
  const { call } = mailWith();
  await assert.rejects(
    call('plan_create_filter', { mailbox: ME, from: 'a.com' }),
    /Give action or actions/,
  );
  await assert.rejects(
    call('plan_create_filter', {
      mailbox: ME,
      from: 'a.com',
      action: 'archive',
      actions: ['star'],
    }),
    /Give action or actions/,
  );
  await assert.rejects(
    call('plan_create_filter', { mailbox: ME, from: 'a.com', actions: ['explode'] }),
    /action must be one of/,
  );
  await assert.rejects(call('plan_set_vacation', { mailbox: ME }), /enabled is required/);
  const plan = (await call('plan_create_filter', {
    mailbox: ME,
    from: 'a.com',
    actions: ['archive', 'mark_read'],
  })) as { actions: string[] };
  assert.deepEqual(plan.actions, ['archive', 'mark_read']);
  assert.equal(TOOLS.length, 31);
});
