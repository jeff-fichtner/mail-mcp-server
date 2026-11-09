import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSender, parseUnsubscribe } from '../src/headers.ts';

test('parseSender reads name and address, lowercasing the address', () => {
  assert.deepEqual(parseSender('"Acme, Inc" <News@Acme.COM>'), {
    address: 'news@acme.com',
    name: 'Acme, Inc',
  });
  assert.deepEqual(parseSender('Acme <news@acme.com>'), { address: 'news@acme.com', name: 'Acme' });
  assert.deepEqual(parseSender('<news@acme.com>'), { address: 'news@acme.com', name: '' });
  assert.deepEqual(parseSender('news@acme.com'), { address: 'news@acme.com', name: '' });
});

test('one-click needs an https link and the RFC 8058 Post header', () => {
  const header = '<mailto:u@list.acme.com?subject=stop>, <https://acme.com/u?t=1>';
  const r = parseUnsubscribe(header, 'List-Unsubscribe=One-Click');
  assert.equal(r.method, 'one-click');
  assert.equal(r.url, 'https://acme.com/u?t=1');
  assert.deepEqual(r.mailto, { to: ['u@list.acme.com'], subject: 'stop', body: 'unsubscribe' });
});

test('the Post header is matched case-insensitively and with surrounding space', () => {
  assert.equal(
    parseUnsubscribe('<https://acme.com/u>', '  list-unsubscribe=one-click ').method,
    'one-click',
  );
});

test('an http link is never one-click', () => {
  const r = parseUnsubscribe('<http://acme.com/u>', 'List-Unsubscribe=One-Click');
  assert.deepEqual(r, { method: 'link-only', url: 'http://acme.com/u' });
});

test('without the Post header, mailto wins over a bare link and the link is kept', () => {
  const r = parseUnsubscribe('<https://acme.com/u>, <mailto:u@acme.com>', undefined);
  assert.equal(r.method, 'mailto');
  assert.deepEqual(r.mailto, { to: ['u@acme.com'], subject: 'unsubscribe', body: 'unsubscribe' });
  assert.equal(r.url, 'https://acme.com/u');
});

test('a link alone is link-only', () => {
  assert.deepEqual(parseUnsubscribe('<https://acme.com/u>', undefined), {
    method: 'link-only',
    url: 'https://acme.com/u',
  });
});

test('no header, or an empty one, is none', () => {
  assert.deepEqual(parseUnsubscribe(undefined, undefined), { method: 'none' });
  assert.deepEqual(parseUnsubscribe('   ', 'List-Unsubscribe=One-Click'), { method: 'none' });
});

test('folded whitespace inside an entry is removed', () => {
  const r = parseUnsubscribe('<https://acme.com/u?\r\n t=1>', 'List-Unsubscribe=One-Click');
  assert.equal(r.url, 'https://acme.com/u?t=1');
});

test('entries without angle brackets are read as comma-separated', () => {
  const r = parseUnsubscribe('mailto:u@acme.com, https://acme.com/u', 'List-Unsubscribe=One-Click');
  assert.equal(r.method, 'one-click');
  assert.equal(r.url, 'https://acme.com/u');
});

test('mailto keeps subject and body, decodes them, and splits multiple recipients', () => {
  const r = parseUnsubscribe(
    '<mailto:a@acme.com,b@acme.com?subject=Remove%20me&body=bye>',
    undefined,
  );
  assert.deepEqual(r.mailto, {
    to: ['a@acme.com', 'b@acme.com'],
    subject: 'Remove me',
    body: 'bye',
  });
});

test('a mailto with no address is ignored', () => {
  assert.deepEqual(parseUnsubscribe('<mailto:?subject=x>', undefined), { method: 'none' });
});
