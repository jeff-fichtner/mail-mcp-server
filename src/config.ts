// Where the OAuth client and the per-mailbox refresh tokens live, and whose tokens they are.
//
// Both are JSON in one macOS Keychain entry each (services `mail_oauth_client` and `mail_tokens`),
// or in env MAIL_OAUTH_CLIENT / MAIL_TOKENS elsewhere. Tokens are keyed by owner, then mailbox; a
// server runs for the one owner named by env MAIL_OWNER_ID and sees only that owner's mailboxes.
// The token store is pluggable: a hosted consumer of the library supplies its own.

import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface TokenStore {
  mailboxes(): string[];
  get(mailbox: string): string | undefined;
  set(mailbox: string, refreshToken: string): void;
}

export const CLIENT_SERVICE = 'mail_oauth_client';
export const TOKENS_SERVICE = 'mail_tokens';
const CLIENT_HELP = `Keychain service '${CLIENT_SERVICE}' or env MAIL_OAUTH_CLIENT, holding JSON {"client_id":"….apps.googleusercontent.com","client_secret":"…"}`;
const TOKENS_HELP = `Keychain service '${TOKENS_SERVICE}' or env MAIL_TOKENS, holding JSON {"<owner id>":{"<email>":"<refresh token>", …}, …}`;

// owner id → mailbox → refresh token
export type TokenMap = Map<string, Map<string, string>>;

export function loadOwner(env: NodeJS.ProcessEnv = process.env): string {
  const owner = env['MAIL_OWNER_ID']?.trim();
  if (!owner) {
    throw new Error('MAIL_OWNER_ID is required: the id of the person whose mailboxes this server reaches');
  }
  return owner;
}

// Structural problems are errors; the values themselves are not second-guessed (a wrong one
// fails at Google with an error that names it).
export function parseClient(raw: string, source: string): OAuthClient {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not JSON. Expected ${CLIENT_HELP}`);
  }
  const obj = asRecord(value);
  const clientId = obj?.['client_id'];
  const clientSecret = obj?.['client_secret'];
  if (typeof clientId !== 'string' || !clientId.trim() || typeof clientSecret !== 'string' || !clientSecret.trim()) {
    throw new Error(`${source} needs non-empty client_id and client_secret. Expected ${CLIENT_HELP}`);
  }
  if (!clientId.trim().endsWith('.apps.googleusercontent.com')) {
    throw new Error(`${source}: client_id is not a Google OAuth client id (….apps.googleusercontent.com)`);
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

// A flat {"<email>":"<refresh token>"} map is the shape from before owners; it belongs to `owner`,
// and `legacy` says the stored value should be rewritten in the keyed shape.
export function parseTokens(raw: string, source: string, owner: string): { tokens: TokenMap; legacy: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not JSON. Expected ${TOKENS_HELP}`);
  }
  const obj = asRecord(value);
  if (!obj) {
    throw new Error(`${source} is not a JSON object. Expected ${TOKENS_HELP}`);
  }
  const entries = Object.entries(obj);
  if (entries.length > 0 && entries.every(([, v]) => typeof v === 'string')) {
    return { tokens: new Map([[owner, parseMailboxes(obj, source)]]), legacy: true };
  }
  const tokens: TokenMap = new Map();
  for (const [key, mailboxes] of entries) {
    const map = asRecord(mailboxes);
    if (!map) {
      throw new Error(`${source}: owner "${key}" is not a map of mailboxes. Expected ${TOKENS_HELP}`);
    }
    tokens.set(key, parseMailboxes(map, source));
  }
  return { tokens, legacy: false };
}

function parseMailboxes(obj: Record<string, unknown>, source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [mailbox, token] of Object.entries(obj)) {
    if (!mailbox.includes('@')) {
      throw new Error(`${source}: key "${mailbox}" is not a mailbox address`);
    }
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error(`${source}: mailbox ${mailbox} has no refresh token`);
    }
    out.set(mailbox.toLowerCase(), token.trim());
  }
  return out;
}

function serializeTokens(tokens: TokenMap): string {
  return JSON.stringify(Object.fromEntries([...tokens].map(([owner, mailboxes]) => [owner, Object.fromEntries(mailboxes)])));
}

export function loadClient(env: NodeJS.ProcessEnv = process.env): OAuthClient {
  const fromEnv = env['MAIL_OAUTH_CLIENT'];
  if (fromEnv !== undefined) {
    return parseClient(fromEnv, 'env MAIL_OAUTH_CLIENT');
  }
  const raw = keychainRead(CLIENT_SERVICE);
  if (raw === null) {
    throw new Error(`No OAuth client found. Set ${CLIENT_HELP}`);
  }
  return parseClient(raw, `Keychain service '${CLIENT_SERVICE}'`);
}

// Env MAIL_TOKENS is read-only: whoever set it owns it. With neither set, no mailbox is
// connected yet, which is a real state (connect creates the Keychain entry), not an error.
export function loadTokenStore(owner: string, env: NodeJS.ProcessEnv = process.env): TokenStore {
  const fromEnv = env['MAIL_TOKENS'];
  if (fromEnv !== undefined) {
    const tokens = parseTokens(fromEnv, 'env MAIL_TOKENS', owner).tokens.get(owner) ?? new Map<string, string>();
    return {
      mailboxes: () => [...tokens.keys()],
      get: (mailbox) => tokens.get(mailbox.toLowerCase()),
      set: () => {
        throw new Error('Mailbox tokens come from env MAIL_TOKENS, which this server does not write. Add the token there.');
      },
    };
  }
  return secretTokenStore(owner, {
    read: () => keychainRead(TOKENS_SERVICE),
    write: (value) => keychainWrite(TOKENS_SERVICE, value),
  });
}

// One stored secret value: null when nothing is stored yet.
export interface SecretSlot {
  read(): string | null;
  write(value: string): void;
}

// Every read goes back to the slot, so a connect made by another process (the CLI, the other
// server) shows up without a restart. A flat map from before owners is rewritten on first read.
export function secretTokenStore(owner: string, slot: SecretSlot): TokenStore {
  const source = `Keychain service '${TOKENS_SERVICE}'`;
  const read = (): TokenMap => {
    const raw = slot.read();
    if (raw === null) {
      return new Map();
    }
    const { tokens, legacy } = parseTokens(raw, source, owner);
    if (legacy) {
      slot.write(serializeTokens(tokens));
    }
    return tokens;
  };
  const own = () => read().get(owner) ?? new Map<string, string>();
  return {
    mailboxes: () => [...own().keys()],
    get: (mailbox) => own().get(mailbox.toLowerCase()),
    set: (mailbox, refreshToken) => {
      const tokens = read();
      const mine = tokens.get(owner) ?? new Map<string, string>();
      mine.set(mailbox.toLowerCase(), refreshToken);
      tokens.set(owner, mine);
      slot.write(serializeTokens(tokens));
    },
  };
}

// `security` exits 44 when the item does not exist; anything else is a real failure.
function keychainRead(service: string): string | null {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    if ((e as { status?: number }).status === 44) {
      return null;
    }
    throw new Error(`Reading Keychain service '${service}' failed: ${(e as Error).message}`);
  }
}

// The value passes through argv, briefly visible to this user's processes, which can read the
// Keychain entry anyway. execFile avoids a shell, so the JSON needs no quoting.
function keychainWrite(service: string, value: string): void {
  execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', userInfo().username, '-w', value], {
    stdio: 'ignore',
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
