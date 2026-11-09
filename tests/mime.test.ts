import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRawMessage, extractText } from '../src/mime.ts';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const decodeRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

test('buildRawMessage writes a plain-text message', () => {
  const text = decodeRaw(
    buildRawMessage({
      from: 'me@example.com',
      to: ['u@list.com'],
      subject: 'unsubscribe',
      body: 'bye',
    }),
  );
  const [head, body] = text.split('\r\n\r\n');
  assert.match(head ?? '', /^From: me@example.com\r\nTo: u@list.com\r\nSubject: unsubscribe\r\n/);
  assert.equal(Buffer.from(body ?? '', 'base64').toString('utf8'), 'bye');
});

test('line breaks in sender-controlled values cannot add headers', () => {
  const text = decodeRaw(
    buildRawMessage({
      from: 'me@example.com',
      to: ['u@list.com'],
      subject: 'x\r\nBcc: evil@x.com',
      body: 'b',
    }),
  );
  assert.doesNotMatch(text, /\r\nBcc:/);
  assert.match(text, /Subject: x Bcc: evil@x.com\r\n/);
});

test('a non-ASCII subject is encoded', () => {
  const text = decodeRaw(
    buildRawMessage({ from: 'a@b.c', to: ['d@e.f'], subject: 'désabonner', body: '' }),
  );
  assert.match(text, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
});

test('extractText prefers text/plain in a nested multipart', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', body: { data: b64url('<p>html</p>') } },
          { mimeType: 'text/plain', body: { data: b64url('plain text') } },
        ],
      },
    ],
  };
  assert.deepEqual(extractText(payload, 100), { text: 'plain text', truncated: false });
});

test('extractText strips html when there is no plain part', () => {
  const html = '<style>p{}</style><p>Hello&nbsp;<b>there</b></p>';
  const payload = { mimeType: 'text/html', body: { data: b64url(html) } };
  assert.equal(extractText(payload, 100).text, 'Hello there');
});

test('extractText truncates and says so', () => {
  const payload = { mimeType: 'text/plain', body: { data: b64url('abcdef') } };
  assert.deepEqual(extractText(payload, 3), { text: 'abc', truncated: true });
});

test('extractText returns empty for a message with no text part', () => {
  assert.deepEqual(extractText({ mimeType: 'image/png', body: { data: 'xx' } }, 10), {
    text: '',
    truncated: false,
  });
});
