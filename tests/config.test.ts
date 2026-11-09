import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadClient,
  loadOwner,
  loadTokenStore,
  parseClient,
  parseTokens,
  secretTokenStore,
  type SecretSlot,
} from '../src/config.ts';

const ID = '123-abc.apps.googleusercontent.com';

test('parseClient accepts a client id and secret', () => {
  assert.deepEqual(parseClient(JSON.stringify({ client_id: ID, client_secret: ' s ' }), 'src'), {
    clientId: ID,
    clientSecret: 's',
  });
});

test('parseClient fails loudly on structural problems', () => {
  assert.throws(() => parseClient('nope', 'src'), /src is not JSON/);
  assert.throws(() => parseClient('{}', 'src'), /needs non-empty client_id and client_secret/);
  assert.throws(
    () => parseClient(JSON.stringify({ client_id: ID, client_secret: '' }), 'src'),
    /non-empty/,
  );
  assert.throws(
    () =>
      parseClient(JSON.stringify({ client_id: 'secret-in-id-slot', client_secret: 's' }), 'src'),
    /not a Google OAuth client id/,
  );
});

const OWNER = 'owner-1';

test('loadOwner requires a non-blank MAIL_OWNER_ID', () => {
  assert.equal(loadOwner({ MAIL_OWNER_ID: ' owner-1 ' }), 'owner-1');
  assert.throws(() => loadOwner({}), /MAIL_OWNER_ID is required/);
  assert.throws(() => loadOwner({ MAIL_OWNER_ID: '  ' }), /MAIL_OWNER_ID is required/);
});

test('parseTokens reads tokens keyed by owner, lowercasing mailboxes and trimming tokens', () => {
  const { tokens, legacy } = parseTokens(
    JSON.stringify({ [OWNER]: { 'User@Example.com': ' rt ' }, other: { 'x@y.z': 'rt2' } }),
    'src',
    OWNER,
  );
  assert.equal(legacy, false);
  assert.deepEqual([...(tokens.get(OWNER) ?? [])], [['user@example.com', 'rt']]);
  assert.deepEqual([...(tokens.get('other') ?? [])], [['x@y.z', 'rt2']]);
});

test('parseTokens gives a flat map from before owners to the given owner', () => {
  const { tokens, legacy } = parseTokens(JSON.stringify({ 'a@b.c': 'rt' }), 'src', OWNER);
  assert.equal(legacy, true);
  assert.deepEqual([...tokens.keys()], [OWNER]);
  assert.equal(tokens.get(OWNER)?.get('a@b.c'), 'rt');
});

test('parseTokens accepts an empty map (no mailbox connected yet)', () => {
  const { tokens, legacy } = parseTokens('{}', 'src', OWNER);
  assert.equal(tokens.size, 0);
  assert.equal(legacy, false);
});

test('parseTokens fails loudly on structural problems', () => {
  assert.throws(() => parseTokens('[]', 'src', OWNER), /not a JSON object/);
  assert.throws(() => parseTokens('x', 'src', OWNER), /not JSON/);
  assert.throws(
    () => parseTokens(JSON.stringify({ [OWNER]: { someone: 'rt' } }), 'src', OWNER),
    /"someone" is not a mailbox address/,
  );
  assert.throws(
    () => parseTokens(JSON.stringify({ [OWNER]: { 'a@b.c': '' } }), 'src', OWNER),
    /has no refresh token/,
  );
  assert.throws(
    () => parseTokens(JSON.stringify({ [OWNER]: 'rt' }), 'src', OWNER),
    /"owner-1" is not a mailbox address/,
  );
  assert.throws(
    () => parseTokens(JSON.stringify({ 'a@b.c': 'rt', [OWNER]: { 'a@b.c': 'rt' } }), 'src', OWNER),
    /owner "a@b.c" is not a map of mailboxes/,
  );
});

test('env MAIL_OAUTH_CLIENT wins and is validated', () => {
  const client = loadClient({
    MAIL_OAUTH_CLIENT: JSON.stringify({ client_id: ID, client_secret: 's' }),
  });
  assert.equal(client.clientId, ID);
  assert.throws(() => loadClient({ MAIL_OAUTH_CLIENT: '' }), /env MAIL_OAUTH_CLIENT is not JSON/);
});

test("env MAIL_TOKENS is read-only and shows only the owner's mailboxes", () => {
  const store = loadTokenStore(OWNER, {
    MAIL_TOKENS: JSON.stringify({ [OWNER]: { 'a@b.c': 'rt' }, other: { 'x@y.z': 'rt2' } }),
  });
  assert.deepEqual(store.mailboxes(), ['a@b.c']);
  assert.equal(store.get('A@B.C'), 'rt');
  assert.equal(store.get('x@y.z'), undefined);
  assert.throws(() => store.set('a@b.c', 'x'), /does not write/);
});

function memorySecret(
  initial: string | null,
): SecretSlot & { value: string | null; writes: number } {
  const slot = {
    value: initial,
    writes: 0,
    read: () => slot.value,
    write: (value: string) => {
      slot.value = value;
      slot.writes += 1;
    },
  };
  return slot;
}

test('a stored flat map is rewritten once under the owner, and its tokens read back', () => {
  const slot = memorySecret(JSON.stringify({ 'a@b.c': 'rt' }));
  const store = secretTokenStore(OWNER, slot);
  assert.deepEqual(store.mailboxes(), ['a@b.c']);
  assert.equal(store.get('a@b.c'), 'rt');
  assert.deepEqual(JSON.parse(slot.value ?? ''), { [OWNER]: { 'a@b.c': 'rt' } });
  assert.equal(slot.writes, 1);
});

test('set writes under the owner and leaves other owners alone', () => {
  const slot = memorySecret(JSON.stringify({ other: { 'x@y.z': 'rt2' } }));
  const store = secretTokenStore(OWNER, slot);
  assert.deepEqual(store.mailboxes(), []);
  store.set('A@B.C', 'rt');
  assert.deepEqual(JSON.parse(slot.value ?? ''), {
    other: { 'x@y.z': 'rt2' },
    [OWNER]: { 'a@b.c': 'rt' },
  });
  assert.deepEqual(store.mailboxes(), ['a@b.c']);
});

test('with nothing stored, no mailbox is connected and nothing is written until a connect', () => {
  const slot = memorySecret(null);
  const store = secretTokenStore(OWNER, slot);
  assert.deepEqual(store.mailboxes(), []);
  assert.equal(slot.writes, 0);
  store.set('a@b.c', 'rt');
  assert.deepEqual(JSON.parse(slot.value ?? ''), { [OWNER]: { 'a@b.c': 'rt' } });
});
