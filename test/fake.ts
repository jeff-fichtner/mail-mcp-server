// A fake Google for tests: records every request and answers token, Gmail and unsubscribe calls.

import type { OAuthClient, TokenStore } from '../src/config.ts';

export const CLIENT: OAuthClient = { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret' };

export interface Call {
  method: string;
  url: URL;
  body: string | undefined;
  headers: Record<string, string>;
}

export interface FakeMessage {
  id: string;
  from: string;
  subject?: string;
  date?: number;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  to?: string;
  cc?: string;
  replyTo?: string;
  messageId?: string;
  references?: string;
  threadId?: string;
  text?: string;
  attachments?: Array<{ filename: string; mimeType: string; content: string }>;
}

export const SEND_AS = [{ sendAsEmail: 'me@example.com', displayName: 'Me', isPrimary: true, isDefault: true }];

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const threadOf = (m: FakeMessage) => m.threadId ?? `t${m.id}`;

function headersOf(m: FakeMessage) {
  const h = [
    { name: 'From', value: m.from },
    { name: 'Subject', value: m.subject ?? '' },
  ];
  const optional: Array<[string, string | undefined]> = [
    ['List-Unsubscribe', m.listUnsubscribe],
    ['List-Unsubscribe-Post', m.listUnsubscribePost],
    ['To', m.to],
    ['Cc', m.cc],
    ['Reply-To', m.replyTo],
    ['Message-ID', m.messageId],
    ['References', m.references],
  ];
  for (const [name, value] of optional) {
    if (value !== undefined) {
      h.push({ name, value });
    }
  }
  return h;
}

function messageJson(m: FakeMessage, full: boolean) {
  const headers = headersOf(m);
  const payload = full
    ? {
      mimeType: 'multipart/mixed',
      headers,
      parts: [
        { partId: '0', mimeType: 'text/plain', filename: '', body: { data: b64url(m.text ?? '') } },
        ...(m.attachments ?? []).map((a, i) => ({
          partId: String(i + 1),
          mimeType: a.mimeType,
          filename: a.filename,
          body: { attachmentId: `att-${i}`, size: a.content.length },
        })),
      ],
    }
    : { headers };
  return { id: m.id, threadId: threadOf(m), labelIds: ['INBOX'], internalDate: String(m.date ?? 0), payload };
}

// A draft is read back from the raw message it was saved with (single-part only).
function draftMessage(id: string, raw: string, threadId: string) {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const split = text.indexOf('\r\n\r\n');
  const headers = text.slice(0, split).split('\r\n').map((line) => {
    const colon = line.indexOf(':');
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  });
  const body = Buffer.from(text.slice(split + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
  return { id: `dm-${id}`, threadId, payload: { mimeType: 'text/plain', headers, body: { data: b64url(body) } } };
}

// Gmail's labels.list carries no counts; labels.get does.
const LABELS = [
  { id: 'INBOX', name: 'INBOX', type: 'system', messagesTotal: 100, messagesUnread: 40 },
  { id: 'UNREAD', name: 'UNREAD', type: 'system', messagesTotal: 45, messagesUnread: 45 },
  { id: 'CATEGORY_PERSONAL', name: 'CATEGORY_PERSONAL', type: 'system', messagesTotal: 20, messagesUnread: 5 },
  { id: 'CATEGORY_PROMOTIONS', name: 'CATEGORY_PROMOTIONS', type: 'system', messagesTotal: 70, messagesUnread: 35 },
  { id: 'SPAM', name: 'SPAM', type: 'system', messagesTotal: 3, messagesUnread: 3 },
  { id: 'TRASH', name: 'TRASH', type: 'system', messagesTotal: 0, messagesUnread: 0 },
  { id: 'Label_7', name: 'Receipts', type: 'user', messagesTotal: 12, messagesUnread: 0 },
  { id: 'Label_8', name: 'Notes', type: 'user', messagesTotal: 30, messagesUnread: 2 },
];

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function memoryStore(initial: Record<string, string> = {}): TokenStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    mailboxes: () => [...data.keys()],
    get: (mailbox) => data.get(mailbox.toLowerCase()),
    set: (mailbox, token) => {
      data.set(mailbox.toLowerCase(), token);
    },
  };
}

// Messages are listed newest first, like Gmail. A `from:` term filters by sender address and a
// `subject:"…"` term by subject; anything else in a query matches everything. Extra routes run
// first and can override any answer.
export function fakeGmail(messages: FakeMessage[], extra?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const sorted = [...messages].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  const drafts = new Map<string, { raw: string; threadId: string }>();
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = { method: init?.method ?? 'GET', url, body: init?.body === undefined || init.body === null ? undefined : String(init.body), headers };
    calls.push(call);
    const override = extra?.(call);
    if (override) {
      return override;
    }
    if (url.host === 'oauth2.googleapis.com') {
      return json(200, { access_token: 'at', expires_in: 3600 });
    }
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (call.method === 'GET' && path === '/messages') {
      const q = url.searchParams.get('q') ?? '';
      const from = /(?:^|\s)from:([^\s()]+)/.exec(q)?.[1];
      const subject = /subject:"([^"]+)"/.exec(q)?.[1];
      const matching = sorted.filter((m) => (!from || m.from.toLowerCase().includes(from.toLowerCase()))
        && (!subject || (m.subject ?? '').toLowerCase().includes(subject.toLowerCase())));
      const max = Number(url.searchParams.get('maxResults') ?? 100);
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = matching.slice(start, start + max);
      const next = start + max < matching.length ? String(start + max) : undefined;
      return json(200, { messages: page.map((m) => ({ id: m.id, threadId: threadOf(m) })), nextPageToken: next, resultSizeEstimate: matching.length });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    if (call.method === 'GET' && one) {
      const m = sorted.find((x) => x.id === one[1]);
      if (!m) {
        return json(404, { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } });
      }
      return json(200, messageJson(m, url.searchParams.get('format') === 'full'));
    }
    const attachment = /^\/messages\/([^/]+)\/attachments\/att-(\d+)$/.exec(path);
    if (call.method === 'GET' && attachment) {
      const a = sorted.find((x) => x.id === attachment[1])?.attachments?.[Number(attachment[2])];
      return a ? json(200, { data: b64url(a.content), size: a.content.length }) : json(404, { error: { message: 'Not Found' } });
    }
    const thread = /^\/threads\/([^/]+)$/.exec(path);
    if (call.method === 'GET' && thread) {
      const inThread = sorted.filter((m) => threadOf(m) === thread[1]).reverse();
      const full = url.searchParams.get('format') === 'full';
      return json(200, { id: thread[1], messages: inThread.map((m) => messageJson(m, full)) });
    }
    if (call.method === 'GET' && path === '/settings/sendAs') {
      return json(200, { sendAs: SEND_AS });
    }
    if (call.method === 'POST' && path === '/drafts') {
      const id = `d${drafts.size + 1}`;
      const message = JSON.parse(call.body ?? '{}').message;
      drafts.set(id, { raw: message.raw, threadId: message.threadId ?? 'tnew' });
      return json(200, { id, message: { id: `dm-${id}`, threadId: message.threadId ?? 'tnew' } });
    }
    const draft = /^\/drafts\/([^/]+)$/.exec(path);
    if (call.method === 'PUT' && draft) {
      const message = JSON.parse(call.body ?? '{}').message;
      drafts.set(draft[1] ?? '', { raw: message.raw, threadId: message.threadId ?? 'tnew' });
      return json(200, { id: draft[1], message: { id: `dm-${draft[1]}`, threadId: message.threadId ?? 'tnew' } });
    }
    if (call.method === 'GET' && path === '/drafts') {
      return json(200, { drafts: [...drafts].map(([id, d]) => ({ id, message: { id: `dm-${id}`, threadId: d.threadId } })) });
    }
    if (call.method === 'GET' && draft) {
      const d = drafts.get(draft[1] ?? '');
      return d ? json(200, { id: draft[1], message: draftMessage(draft[1] ?? '', d.raw, d.threadId) }) : json(404, { error: { message: 'Not Found' } });
    }
    if (call.method === 'POST' && path === '/drafts/send') {
      const id = JSON.parse(call.body ?? '{}').id;
      return json(200, { id: 'sent-d', threadId: drafts.get(id)?.threadId ?? 'tnew' });
    }
    if (call.method === 'GET' && path === '/labels') {
      return json(200, { labels: LABELS.map(({ id, name, type }) => ({ id, name, type })) });
    }
    const oneLabel = /^\/labels\/([^/]+)$/.exec(path);
    if (call.method === 'GET' && oneLabel) {
      const label = LABELS.find((l) => l.id === decodeURIComponent(oneLabel[1] ?? ''));
      return label ? json(200, label) : json(404, { error: { message: 'Not Found', errors: [{ reason: 'notFound' }] } });
    }
    if (call.method === 'POST' && path === '/labels') {
      return json(200, { id: 'Label_new', ...JSON.parse(call.body ?? '{}') });
    }
    if (call.method === 'GET' && path === '/profile') {
      return json(200, { emailAddress: 'me@example.com', messagesTotal: 120 });
    }
    if (call.method === 'GET' && path === '/settings/filters') {
      return json(200, { filter: [{ id: 'f1', criteria: { from: 'x@y.com' }, action: { addLabelIds: ['Label_7'], removeLabelIds: ['INBOX'] } }] });
    }
    if (call.method === 'POST' && path === '/settings/filters') {
      return json(200, { id: 'f-new', ...JSON.parse(call.body ?? '{}') });
    }
    if (call.method === 'POST' && path === '/messages/send') {
      return json(200, { id: 'sent-1', threadId: JSON.parse(call.body ?? '{}').threadId ?? 'tnew' });
    }
    if ((call.method === 'POST' && (path === '/messages/batchModify' || /\/trash$/.test(path))) || call.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (call.method === 'POST' && url.protocol === 'https:') {
      return new Response('ok', { status: 200 });
    }
    return json(500, { error: { message: `fake has no route for ${call.method} ${url}` } });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

export const noSleep = async () => undefined;

// Sleeping advances this clock instantly, so pacing is exercised without waiting in real time.
export function fakeClock() {
  let now = Date.UTC(2026, 9, 21);
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}
