import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SCOPES, startConnect } from '../src/oauth.ts';
import { CLIENT, json, memoryStore, type Call } from '../src/testing.ts';

// Google's side of the flow: the token endpoint and the profile call.
function fakeGoogle(tokenResponse: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? String(init.body) : undefined,
      headers: {},
    });
    if (url.host === 'oauth2.googleapis.com') {
      return json(200, tokenResponse);
    }
    return json(200, { emailAddress: 'User@Example.com', messagesTotal: 1 });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

const GRANT = {
  access_token: 'at',
  refresh_token: 'rt-new',
  expires_in: 3600,
  scope: SCOPES.join(' '),
};

// The browser's half: follow Google's redirect back to the loopback listener.
async function redirect(authUrl: string, params: Record<string, string>): Promise<number> {
  const redirectUri = new URL(authUrl).searchParams.get('redirect_uri') ?? '';
  const res = await fetch(`${redirectUri}/?${new URLSearchParams(params)}`);
  await res.text();
  return res.status;
}

test('the consent URL asks for offline access to both scopes with PKCE on a loopback redirect', async () => {
  const google = fakeGoogle(GRANT);
  const pending = await startConnect({
    client: CLIENT,
    store: memoryStore(),
    fetch: google.fetch,
    timeoutMs: 60000,
    loginHint: 'user@example.com',
  });
  const url = new URL(pending.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('login_hint'), 'user@example.com');
  assert.match(url.searchParams.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
  pending.cancel();
  await assert.rejects(pending.done, /Replaced/);
});

test('consent stores the refresh token under the address Gmail reports, verified by PKCE', async () => {
  const google = fakeGoogle(GRANT);
  const store = memoryStore();
  const pending = await startConnect({
    client: CLIENT,
    store,
    fetch: google.fetch,
    timeoutMs: 60000,
    loginHint: 'someone-else@example.com',
  });
  const state = new URL(pending.url).searchParams.get('state') ?? '';
  assert.equal(await redirect(pending.url, { code: 'the-code', state }), 200);
  assert.deepEqual(await pending.done, { mailbox: 'user@example.com' });
  assert.deepEqual([...store.data], [['user@example.com', 'rt-new']]);

  const exchange = new URLSearchParams(google.calls[0]?.body);
  assert.equal(exchange.get('code'), 'the-code');
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  const challenge = createHash('sha256')
    .update(exchange.get('code_verifier') ?? '')
    .digest('base64url');
  assert.equal(challenge, new URL(pending.url).searchParams.get('code_challenge'));
});

test('a redirect without our state is refused and the flow keeps waiting', async () => {
  const store = memoryStore();
  const pending = await startConnect({
    client: CLIENT,
    store,
    fetch: fakeGoogle(GRANT).fetch,
    timeoutMs: 60000,
  });
  const state = new URL(pending.url).searchParams.get('state') ?? '';
  assert.equal(await redirect(pending.url, { code: 'forged', state: 'wrong' }), 400);
  assert.equal(store.data.size, 0);
  assert.equal(await redirect(pending.url, { code: 'real', state }), 200);
  assert.deepEqual(await pending.done, { mailbox: 'user@example.com' });
});

test('declined consent fails the flow', async () => {
  const pending = await startConnect({
    client: CLIENT,
    store: memoryStore(),
    fetch: fakeGoogle(GRANT).fetch,
    timeoutMs: 60000,
  });
  const state = new URL(pending.url).searchParams.get('state') ?? '';
  await redirect(pending.url, { error: 'access_denied', state });
  await assert.rejects(pending.done, /Consent was not given \(access_denied\)/);
});

test('a grant missing a scope fails loudly and stores nothing', async () => {
  const store = memoryStore();
  const google = fakeGoogle({ ...GRANT, scope: SCOPES[0] });
  const pending = await startConnect({
    client: CLIENT,
    store,
    fetch: google.fetch,
    timeoutMs: 60000,
  });
  const state = new URL(pending.url).searchParams.get('state') ?? '';
  await redirect(pending.url, { code: 'c', state });
  await assert.rejects(
    pending.done,
    /did not grant .*gmail\.settings\.basic.*allow every permission/,
  );
  assert.equal(store.data.size, 0);
});

test('no consent before the timeout fails the flow', async () => {
  const pending = await startConnect({
    client: CLIENT,
    store: memoryStore(),
    fetch: fakeGoogle(GRANT).fetch,
    timeoutMs: 20,
  });
  await assert.rejects(pending.done, /No consent within/);
});

// Browsers open speculative connections that never send a request; one left open would hold the
// listener, and with it a CLI connect, open after consent.
test("the listener drops a browser's silent preconnect once consent arrives", async () => {
  const pending = await startConnect({
    client: CLIENT,
    store: memoryStore(),
    fetch: fakeGoogle(GRANT).fetch,
    timeoutMs: 60000,
  });
  const redirect = new URL(new URL(pending.url).searchParams.get('redirect_uri') ?? '');
  const state = new URL(pending.url).searchParams.get('state') ?? '';
  const { connect } = await import('node:net');
  const preconnect = connect(Number(redirect.port), redirect.hostname);
  await new Promise((resolve) => preconnect.once('connect', resolve));
  await fetch(`${redirect.origin}/?code=c&state=${state}`).then((r) => r.text());
  await pending.done;
  const closed = await Promise.race([
    new Promise<boolean>((resolve) => preconnect.once('close', () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);
  preconnect.destroy();
  assert.equal(closed, true, 'the silent preconnect is still open');
});
