import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gmail, GmailError, isRetryable } from '../src/gmail.ts';
import {
  CLIENT,
  fakeClock,
  fakeGmail,
  json,
  memoryStore,
  noSleep,
  type Call,
} from '../src/testing.ts';

const MAILBOX = 'me@example.com';

function gmailWith(extra: (call: Call) => Response | undefined, sleeps: number[] = []) {
  const fake = fakeGmail([{ id: '1', from: 'a@x.com' }], extra);
  const clock = fakeClock();
  const gmail = new Gmail(MAILBOX, {
    client: CLIENT,
    store: memoryStore({ [MAILBOX]: 'rt' }),
    fetch: fake.fetch,
    now: clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      await clock.sleep(ms);
    },
  });
  return { gmail, calls: fake.calls };
}

const tokenCalls = (calls: Call[]) => calls.filter((c) => c.url.host === 'oauth2.googleapis.com');

test('isRetryable covers 429, the 403 rate-limit reasons and 5xx only', () => {
  assert.equal(isRetryable(429, undefined), true);
  assert.equal(isRetryable(403, 'rateLimitExceeded'), true);
  assert.equal(isRetryable(403, 'userRateLimitExceeded'), true);
  assert.equal(isRetryable(403, 'insufficientPermissions'), false);
  assert.equal(isRetryable(503, undefined), true);
  assert.equal(isRetryable(404, undefined), false);
});

test('an access token is refreshed once and reused, with the client and refresh token', async () => {
  const { gmail, calls } = gmailWith(() => undefined);
  await gmail.labels();
  await gmail.labels();
  const tokens = tokenCalls(calls);
  assert.equal(tokens.length, 1);
  const body = new URLSearchParams(tokens[0]?.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'rt');
  assert.equal(body.get('client_id'), CLIENT.clientId);
  assert.equal(calls.at(-1)?.headers['authorization'], 'Bearer at');
});

test('a 401 gets one fresh token and one retry', async () => {
  let failed = false;
  const { gmail, calls } = gmailWith((call) => {
    if (call.url.pathname.endsWith('/labels') && !failed) {
      failed = true;
      return json(401, { error: { message: 'Invalid Credentials' } });
    }
    return undefined;
  });
  assert.ok((await gmail.labels()).length > 0);
  assert.equal(tokenCalls(calls).length, 2);
});

test('throttling is retried, honouring Retry-After', async () => {
  let n = 0;
  const sleeps: number[] = [];
  const { gmail } = gmailWith((call) => {
    if (call.url.pathname.endsWith('/labels') && n++ < 2) {
      return n === 1
        ? json(429, { error: { message: 'slow down' } }, { 'Retry-After': '3' })
        : json(403, { error: { message: 'quota', errors: [{ reason: 'userRateLimitExceeded' }] } });
    }
    return undefined;
  }, sleeps);
  assert.ok((await gmail.labels()).length > 0);
  assert.equal(sleeps[0], 3000);
  assert.equal(sleeps.length, 2);
});

test('a 403 that is not throttling fails at once with its status and reason', async () => {
  const { gmail } = gmailWith((call) =>
    call.url.pathname.endsWith('/labels')
      ? json(403, { error: { message: 'no', errors: [{ reason: 'insufficientPermissions' }] } })
      : undefined,
  );
  await assert.rejects(
    gmail.labels(),
    (e: unknown) =>
      e instanceof GmailError && e.status === 403 && e.reason === 'insufficientPermissions',
  );
});

test('persistent 5xx gives up after the retry limit', async () => {
  const sleeps: number[] = [];
  const { gmail } = gmailWith(
    (call) =>
      call.url.pathname.endsWith('/labels') ? json(503, { error: { message: 'down' } }) : undefined,
    sleeps,
  );
  await assert.rejects(gmail.labels(), /Gmail 503/);
  assert.equal(sleeps.length, 6);
  assert.ok(
    sleeps.reduce((a, b) => a + b, 0) >= 60000,
    'the backoff outlasts a one-minute quota window',
  );
});

test('an expired refresh token says to run connect', async () => {
  const { gmail } = gmailWith((call) =>
    call.url.host === 'oauth2.googleapis.com' ? json(400, { error: 'invalid_grant' }) : undefined,
  );
  await assert.rejects(gmail.labels(), /me@example.com has expired or been revoked.*Run connect/);
});

test('a mailbox with no token is not connected', async () => {
  const fake = fakeGmail([]);
  const gmail = new Gmail('other@example.com', {
    client: CLIENT,
    store: memoryStore(),
    fetch: fake.fetch,
    now: Date.now,
    sleep: noSleep,
  });
  await assert.rejects(gmail.labels(), /other@example.com is not connected/);
});

test('listIds pages until max and reports truncation', async () => {
  const messages = Array.from({ length: 7 }, (_, i) => ({
    id: String(i),
    from: 'a@x.com',
    date: i,
  }));
  const fake = fakeGmail(messages);
  const gmail = new Gmail(MAILBOX, {
    client: CLIENT,
    store: memoryStore({ [MAILBOX]: 'rt' }),
    fetch: fake.fetch,
    now: Date.now,
    sleep: noSleep,
  });
  assert.deepEqual(await gmail.listIds('', 100), {
    ids: ['6', '5', '4', '3', '2', '1', '0'],
    truncated: false,
    estimate: 7,
  });
  const capped = await gmail.listIds('', 3);
  assert.deepEqual(capped.ids, ['6', '5', '4']);
  assert.equal(capped.truncated, true);
});
