import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mail } from '../src/mail.ts';
import { splitAddresses } from '../src/messages.ts';
import { CLIENT, SEND_AS, fakeClock, fakeGmail, json, memoryStore, type Call, type FakeMessage } from './fake.ts';

const ME = 'me@example.com';

const ORIGINAL: FakeMessage = {
  id: 'o1',
  threadId: 'th1',
  from: 'Ann <ann@acme.com>',
  to: 'Me <me@example.com>, "Doe, Bo" <bo@acme.com>',
  cc: 'cy@acme.com, alias@example.com',
  subject: 'Quarterly numbers',
  messageId: '<orig@acme.com>',
  references: '<earlier@acme.com>',
  text: 'Here are the numbers.',
  attachments: [{ filename: 'q3.pdf', mimeType: 'application/pdf', content: 'PDFDATA' }],
  date: 1,
};

function mailWith(messages: FakeMessage[] = [ORIGINAL], extra?: (call: Call) => Response | undefined) {
  const fake = fakeGmail(messages, extra);
  const clock = fakeClock();
  const mail = new Mail({ client: CLIENT, store: memoryStore({ [ME]: 'rt' }), fetch: fake.fetch, now: clock.now, sleep: clock.sleep });
  return { mail, calls: fake.calls };
}

const sendAsWith = (extraIdentities: unknown[]) => (call: Call) =>
  (call.url.pathname.endsWith('/settings/sendAs') ? json(200, { sendAs: [...SEND_AS, ...extraIdentities] }) : undefined);

function rawOf(call: Call | undefined): string {
  const body = JSON.parse(call?.body ?? '{}');
  return Buffer.from(body.raw ?? body.message?.raw ?? '', 'base64url').toString('utf8');
}

function headerOf(raw: string, name: string): string | undefined {
  const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
  return head.split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();
}

const gmailCall = (calls: Call[], method: string, suffix: string) =>
  calls.filter((c) => c.url.host === 'gmail.googleapis.com' && c.method === method && c.url.pathname.endsWith(suffix));

test('splitAddresses keeps quoted commas inside one address', () => {
  assert.deepEqual(splitAddresses('Me <me@example.com>, "Doe, Bo" <bo@acme.com>, cy@acme.com'), [
    'Me <me@example.com>', '"Doe, Bo" <bo@acme.com>', 'cy@acme.com',
  ]);
});

test('a new draft needs recipients and a subject, and is sent from the default identity', async () => {
  const { mail, calls } = mailWith();
  await assert.rejects(mail.createDraft(ME, { body: 'hi', subject: 's' }), /to is required/);
  await assert.rejects(mail.createDraft(ME, { body: 'hi', to: ['x@y.com'] }), /subject is required/);
  await assert.rejects(mail.createDraft(ME, { body: 'hi', to: ['not-an-address'], subject: 's' }), /not an email address/);
  const draft = await mail.createDraft(ME, { body: 'hello', to: ['x@y.com'], cc: ['c@y.com'], subject: 'Hi' });
  assert.equal(draft.draft_id, 'd1');
  const raw = rawOf(gmailCall(calls, 'POST', '/drafts')[0]);
  assert.equal(headerOf(raw, 'From'), 'Me <me@example.com>');
  assert.equal(headerOf(raw, 'To'), 'x@y.com');
  assert.equal(headerOf(raw, 'Cc'), 'c@y.com');
  assert.equal(headerOf(raw, 'Subject'), 'Hi');
});

test('a reply answers the sender in the same thread, with Re: and threading headers', async () => {
  const { mail, calls } = mailWith();
  const draft = await mail.createDraft(ME, { body: 'Thanks', replyTo: 'o1' });
  assert.equal(draft.thread_id, 'th1');
  assert.deepEqual(draft.to, ['Ann <ann@acme.com>']);
  const post = gmailCall(calls, 'POST', '/drafts')[0];
  assert.equal(JSON.parse(post?.body ?? '{}').message.threadId, 'th1');
  const raw = rawOf(post);
  assert.equal(headerOf(raw, 'Subject'), 'Re: Quarterly numbers');
  assert.equal(headerOf(raw, 'In-Reply-To'), '<orig@acme.com>');
  assert.equal(headerOf(raw, 'References'), '<earlier@acme.com> <orig@acme.com>');
});

test('reply_all copies the other recipients but never the mailbox or its send-as addresses', async () => {
  const { mail } = mailWith([ORIGINAL], sendAsWith([{ sendAsEmail: 'alias@example.com', verificationStatus: 'accepted' }]));
  const draft = await mail.createDraft(ME, { body: 'All', replyTo: 'o1', replyAll: true });
  assert.deepEqual(draft.to, ['Ann <ann@acme.com>']);
  assert.deepEqual(draft.cc, ['"Doe, Bo" <bo@acme.com>', 'cy@acme.com']);
});

test('a reply prefers Reply-To over From', async () => {
  const { mail } = mailWith([{ ...ORIGINAL, replyTo: 'list@acme.com' }]);
  const draft = await mail.createDraft(ME, { body: 'x', replyTo: 'o1' });
  assert.deepEqual(draft.to, ['list@acme.com']);
});

test('a forward carries the original text and attachments, with Fwd:', async () => {
  const { mail, calls } = mailWith();
  await assert.rejects(mail.createDraft(ME, { body: 'fyi', forward: 'o1' }), /to is required/);
  const draft = await mail.createDraft(ME, { body: 'fyi', forward: 'o1', to: ['boss@acme.com'] });
  assert.deepEqual(draft.attachments, ['q3.pdf']);
  const raw = rawOf(gmailCall(calls, 'POST', '/drafts')[0]);
  assert.equal(headerOf(raw, 'Subject'), 'Fwd: Quarterly numbers');
  assert.match(raw, /filename="q3.pdf"/);
  assert.match(raw, new RegExp(Buffer.from('PDFDATA').toString('base64')));
  assert.match(draft.body, /---------- Forwarded message ---------\nFrom: Ann <ann@acme.com>[\s\S]*Here are the numbers\./);
});

test('reply_to and forward together, or reply_all alone, are refused', async () => {
  const { mail } = mailWith();
  await assert.rejects(mail.createDraft(ME, { body: 'x', replyTo: 'o1', forward: 'o1', to: ['a@b.c'] }), /not both/);
  await assert.rejects(mail.createDraft(ME, { body: 'x', replyAll: true, to: ['a@b.c'], subject: 's' }), /reply_all needs reply_to/);
});

test('from must be a verified send-as address of the mailbox', async () => {
  const { mail, calls } = mailWith([ORIGINAL], sendAsWith([
    { sendAsEmail: 'support@acme.com', displayName: 'acme', verificationStatus: 'accepted' },
    { sendAsEmail: 'pending@acme.com', verificationStatus: 'pending' },
  ]));
  await assert.rejects(mail.createDraft(ME, { body: 'x', to: ['a@b.c'], subject: 's', from: 'nobody@acme.com' }), /not a send-as address/);
  await assert.rejects(mail.createDraft(ME, { body: 'x', to: ['a@b.c'], subject: 's', from: 'pending@acme.com' }), /not verified yet/);
  await mail.createDraft(ME, { body: 'x', to: ['a@b.c'], subject: 's', from: 'Support@Acme.com' });
  assert.equal(headerOf(rawOf(gmailCall(calls, 'POST', '/drafts')[0]), 'From'), 'acme <support@acme.com>');
});

test('a header value from the original cannot add a recipient', async () => {
  const { mail, calls } = mailWith([{ ...ORIGINAL, subject: 'hi\r\nBcc: evil@x.com' }]);
  await mail.createDraft(ME, { body: 'x', replyTo: 'o1' });
  const raw = rawOf(gmailCall(calls, 'POST', '/drafts')[0]);
  assert.equal(headerOf(raw, 'Bcc'), undefined);
});

test('get_thread returns the conversation oldest first, with bodies and attachment names on request', async () => {
  const reply: FakeMessage = { id: 'o2', threadId: 'th1', from: 'me@example.com', subject: 'Re: Quarterly numbers', text: 'Got it', date: 2 };
  const { mail } = mailWith([ORIGINAL, reply]);
  const headers = await mail.getThread(ME, 'th1', false);
  assert.deepEqual(headers.messages.map((m) => m['id']), ['o1', 'o2']);
  assert.equal(headers.messages[0]?.['body'], undefined);
  const full = await mail.getThread(ME, 'th1', true);
  assert.equal(full.messages[0]?.['body'], 'Here are the numbers.');
  assert.deepEqual(full.messages[0]?.['attachments'], [{ filename: 'q3.pdf', mime_type: 'application/pdf', size: 7 }]);
});

test('save_attachments writes files without overwriting, reduces names to a bare file name, and needs an absolute dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-att-'));
  writeFileSync(join(dir, 'q3.pdf'), 'existing');
  const { mail } = mailWith([{
    ...ORIGINAL,
    attachments: [...(ORIGINAL.attachments ?? []), { filename: '../../evil.sh', mimeType: 'text/plain', content: 'x' }],
  }]);
  await assert.rejects(mail.saveAttachments(ME, 'o1', 'relative/dir', undefined), /absolute path/);
  const result = await mail.saveAttachments(ME, 'o1', dir, undefined);
  assert.deepEqual(result.saved.map((s) => s.path), [join(dir, 'q3 (2).pdf'), join(dir, 'evil.sh')]);
  assert.equal(readFileSync(join(dir, 'q3 (2).pdf'), 'utf8'), 'PDFDATA');
  assert.equal(readFileSync(join(dir, 'q3.pdf'), 'utf8'), 'existing');
  const only = await mail.saveAttachments(ME, 'o1', join(dir, 'sub'), ['q3.pdf']);
  assert.equal(only.saved.length, 1);
  assert.equal(existsSync(join(dir, 'sub', 'q3.pdf')), true);
});

test('drafts list back; plan_send shows the exact draft and only execute_plan sends it', async () => {
  const { mail, calls } = mailWith();
  const draft = await mail.createDraft(ME, { body: 'Body text', to: ['x@y.com'], subject: 'Hi' });
  const listed = await mail.listDrafts(ME, 25);
  assert.deepEqual(listed.drafts.map((d) => [d.draft_id, d.to, d.subject]), [['d1', 'x@y.com', 'Hi']]);
  const plan = await mail.planSend(ME, draft.draft_id, undefined);
  assert.equal(plan['to'], 'x@y.com');
  assert.equal(plan['body'], 'Body text');
  assert.equal(gmailCall(calls, 'POST', '/drafts/send').length, 0, 'the dry run sends nothing');
  const sent = (await mail.executePlan(String(plan['plan_id']))) as { sent: boolean };
  assert.equal(sent.sent, true);
  assert.equal(JSON.parse(gmailCall(calls, 'POST', '/drafts/send')[0]?.body ?? '{}').id, 'd1');
});

test('plan_send can send a reply given directly, in its thread', async () => {
  const { mail, calls } = mailWith();
  const plan = await mail.planSend(ME, undefined, { body: 'Sure', replyTo: 'o1' });
  assert.equal(plan['subject'], 'Re: Quarterly numbers');
  await mail.executePlan(String(plan['plan_id']));
  const send = gmailCall(calls, 'POST', '/messages/send')[0];
  assert.equal(JSON.parse(send?.body ?? '{}').threadId, 'th1');
  assert.equal(headerOf(rawOf(send), 'To'), 'Ann <ann@acme.com>');
});

test('plan_delete_draft deletes only on execute', async () => {
  const { mail, calls } = mailWith();
  const draft = await mail.createDraft(ME, { body: 'x', to: ['x@y.com'], subject: 'Gone' });
  const plan = await mail.planDeleteDraft(ME, draft.draft_id);
  assert.equal(plan.subject, 'Gone');
  assert.equal(calls.some((c) => c.method === 'DELETE'), false);
  await mail.executePlan(plan.plan_id);
  assert.equal(gmailCall(calls, 'DELETE', '/drafts/d1').length, 1);
});

test('message actions map to the right label changes, and untrash goes message by message', async () => {
  const cases: Array<[string, string[], string[]]> = [
    ['star', ['STARRED'], []],
    ['unstar', [], ['STARRED']],
    ['mark_unread', ['UNREAD'], []],
    ['mark_important', ['IMPORTANT'], []],
    ['mark_unimportant', [], ['IMPORTANT']],
    ['spam', ['SPAM'], ['INBOX']],
    ['not_spam', ['INBOX'], ['SPAM']],
  ];
  for (const [action, add, remove] of cases) {
    const { mail, calls } = mailWith();
    const plan = await mail.planModify(ME, 'from:acme.com', action as never, undefined, 100);
    await mail.executePlan(plan.plan_id ?? '');
    const body = JSON.parse(gmailCall(calls, 'POST', '/batchModify')[0]?.body ?? '{}');
    assert.deepEqual([body.addLabelIds, body.removeLabelIds], [add, remove], action);
  }
  const { mail, calls } = mailWith();
  const plan = await mail.planModify(ME, 'in:trash from:acme.com', 'untrash', undefined, 100);
  await mail.executePlan(plan.plan_id ?? '');
  assert.equal(gmailCall(calls, 'POST', '/untrash').length, 1);
});
