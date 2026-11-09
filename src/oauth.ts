// Google OAuth for an installed (Desktop) client: a one-time consent per mailbox through a loopback
// redirect with PKCE, then access tokens refreshed from the stored refresh token.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthClient, TokenStore } from './config.ts';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

export type Fetch = typeof fetch;

export interface AccessToken {
  token: string;
  expiresAt: number;
}

export async function refreshAccessToken(
  fetchFn: Fetch,
  client: OAuthClient,
  mailbox: string,
  refreshToken: string,
  now: () => number,
): Promise<AccessToken> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (json['error'] === 'invalid_grant') {
      throw new Error(
        `The refresh token for ${mailbox} has expired or been revoked (an app in Testing mode issues tokens that last 7 days). Run connect for ${mailbox} again.`,
      );
    }
    throw new Error(
      `Token refresh for ${mailbox} failed: HTTP ${res.status} ${String(json['error'] ?? '')} ${String(json['error_description'] ?? '')}`.trim(),
    );
  }
  const token = json['access_token'];
  const expiresIn = json['expires_in'];
  if (typeof token !== 'string' || typeof expiresIn !== 'number') {
    throw new Error(`Token refresh for ${mailbox} returned no access token`);
  }
  return { token, expiresAt: now() + expiresIn * 1000 };
}

export interface ConnectOptions {
  client: OAuthClient;
  store: TokenStore;
  fetch: Fetch;
  timeoutMs: number;
  loginHint?: string;
}

export interface PendingConnect {
  url: string;
  done: Promise<{ mailbox: string }>;
  cancel: () => void;
}

// Listens on 127.0.0.1 at a free port, which Google allows for Desktop clients. The mailbox is
// whatever account the person consents with, as Gmail reports it, so a token can never be filed
// under the wrong address.
export async function startConnect(options: ConnectOptions): Promise<PendingConnect> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  let settle: { resolve: (code: string) => void; reject: (e: Error) => void } | undefined;
  const codeArrived = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    // A request without our state was not started by this flow; it is refused and ignored.
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Unexpected request.');
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
      res
        .writeHead(400, { 'Content-Type': 'text/plain' })
        .end(`Not connected: ${error ?? 'no code'}. You can close this tab.`);
      settle?.reject(new Error(`Consent was not given (${error ?? 'no code returned'}).`));
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' })
      .end('Connected. You can close this tab.');
    settle?.resolve(code);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const params = new URLSearchParams({
    client_id: options.client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  if (options.loginHint) {
    params.set('login_hint', options.loginHint);
  }

  const timer = setTimeout(() => {
    settle?.reject(
      new Error(
        `No consent within ${Math.round(options.timeoutMs / 60000)} minutes; run connect again.`,
      ),
    );
  }, options.timeoutMs);

  const done = (async () => {
    try {
      const code = await codeArrived;
      return await finishConnect(options, code, verifier, redirectUri);
    } finally {
      // A browser keeps its connection alive, which would hold the listener (and a CLI) open.
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    }
  })();
  // The flow can fail before a caller awaits it (a declined consent); callers still see the failure.
  done.catch(() => undefined);

  return {
    url: `${AUTH_URL}?${params}`,
    done,
    cancel: () => settle?.reject(new Error('Replaced by a newer connect.')),
  };
}

async function finishConnect(
  options: ConnectOptions,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<{ mailbox: string }> {
  const res = await options.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Exchanging the consent code failed: HTTP ${res.status} ${String(json['error'] ?? '')} ${String(json['error_description'] ?? '')}`.trim(),
    );
  }
  const accessToken = json['access_token'];
  const refreshToken = json['refresh_token'];
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new Error('Google returned no refresh token; run connect again.');
  }
  // Google's consent screen lets a person untick permissions; a token without them is useless here.
  const granted = new Set(String(json['scope'] ?? '').split(' '));
  const missing = SCOPES.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    throw new Error(
      `Consent did not grant ${missing.join(', ')}. Run connect again and allow every permission.`,
    );
  }

  const profile = await options.fetch(PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const profileJson = (await profile.json().catch(() => ({}))) as Record<string, unknown>;
  const mailbox = profileJson['emailAddress'];
  if (!profile.ok || typeof mailbox !== 'string') {
    throw new Error(`Reading the connected mailbox's address failed: HTTP ${profile.status}`);
  }
  options.store.set(mailbox, refreshToken);
  return { mailbox: mailbox.toLowerCase() };
}
