// One mailbox's Gmail API: its access token, its quota pacing, and retries on throttling.

import type { OAuthClient, TokenStore } from './config.ts';
import { refreshAccessToken, type AccessToken, type Fetch } from './oauth.ts';
import { Pacer } from './pacer.ts';
import type { MessagePart } from './mime.ts';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Quota units per method, from Google's published Gmail usage limits. A project also carries a
// second per-mailbox limit (read from the Service Usage API, 2026-10-21): 6,000 "total query cost"
// a minute, beside the published 15,000 units. It binds, and weighs a metadata fetch at about 20
// rather than 5: measured on a real mailbox, Gmail throttles after about 300 fetches in a minute,
// whatever the pacing. So the pacer bursts at a rate below the published limit and, when Gmail
// throttles, pauses every caller until the window clears. Long runs settle at about 300 messages
// a minute; short ones finish in the burst.
export const COST = {
  profile: 1,
  labels: 1,
  labelGet: 1,
  labelCreate: 5,
  list: 5,
  get: 5,
  trash: 5,
  untrash: 5,
  batchModify: 50,
  send: 100,
  threadGet: 10,
  attachmentGet: 5,
  draftsList: 5,
  draftGet: 5,
  draftCreate: 10,
  draftUpdate: 15,
  draftDelete: 10,
  draftSend: 100,
  sendAsList: 1,
  filtersList: 1,
  filtersCreate: 5,
  filtersDelete: 5,
} as const;
export const UNITS_PER_SECOND = 90;
export const MAX_CONCURRENT = 10;
// Enough backoff to outlast a one-minute quota window.
const MAX_RETRIES = 6;

export interface GmailDeps {
  client: OAuthClient;
  store: TokenStore;
  fetch: Fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface Header {
  name: string;
  value: string;
}

export interface Message {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: MessagePart & { headers?: Header[] };
}

export interface Label {
  id: string;
  name: string;
  type?: string;
  messagesTotal?: number;
  messagesUnread?: number;
}

export interface Filter {
  id: string;
  criteria?: Record<string, unknown>;
  action?: { addLabelIds?: string[]; removeLabelIds?: string[]; forward?: string };
}

export interface Draft {
  id: string;
  message: Message;
}

export interface SendAs {
  sendAsEmail: string;
  displayName?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  verificationStatus?: string;
  signature?: string;
}

const THREAD_HEADERS = ['From', 'To', 'Cc', 'Date', 'Subject', 'Message-ID'];

export class GmailError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(message: string, status: number, reason: string | undefined) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// Gmail signals throttling with 429 and with 403 rateLimitExceeded / userRateLimitExceeded.
export function isRetryable(status: number, reason: string | undefined): boolean {
  if (status === 429) {
    return true;
  }
  if (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')) {
    return true;
  }
  return status >= 500;
}

export function header(message: Message, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

type Query = Record<string, string | number | string[] | undefined>;

export class Gmail {
  readonly mailbox: string;
  private readonly deps: GmailDeps;
  private readonly pacer: Pacer;
  private access: AccessToken | undefined;

  constructor(mailbox: string, deps: GmailDeps) {
    this.mailbox = mailbox;
    this.deps = deps;
    this.pacer = new Pacer({
      unitsPerSecond: UNITS_PER_SECOND,
      burst: Math.max(...Object.values(COST)),
      maxConcurrent: MAX_CONCURRENT,
      now: deps.now,
      sleep: deps.sleep,
    });
  }

  profile(): Promise<{ emailAddress: string; messagesTotal: number }> {
    return this.request('GET', '/profile', COST.profile);
  }

  // Newest first. `truncated` says more matched than `max`.
  async listIds(q: string, max: number): Promise<{ ids: string[]; truncated: boolean; estimate: number }> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    let estimate = 0;
    for (;;) {
      const page = await this.request<{ messages?: Array<{ id: string }>; nextPageToken?: string; resultSizeEstimate?: number }>(
        'GET',
        '/messages',
        COST.list,
        { query: { q, maxResults: Math.min(500, max - ids.length), pageToken } },
      );
      estimate = Math.max(estimate, page.resultSizeEstimate ?? 0);
      for (const m of page.messages ?? []) {
        ids.push(m.id);
      }
      pageToken = page.nextPageToken;
      if (!pageToken) {
        return { ids, truncated: false, estimate };
      }
      if (ids.length >= max) {
        return { ids, truncated: true, estimate };
      }
    }
  }

  metadata(id: string, headers: string[]): Promise<Message> {
    return this.request('GET', `/messages/${encodeURIComponent(id)}`, COST.get, {
      query: { format: 'metadata', metadataHeaders: headers },
    });
  }

  full(id: string): Promise<Message> {
    return this.request('GET', `/messages/${encodeURIComponent(id)}`, COST.get, { query: { format: 'full' } });
  }

  async batchModify(ids: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    await this.request('POST', '/messages/batchModify', COST.batchModify, { body: { ids, addLabelIds, removeLabelIds } });
  }

  async trash(id: string): Promise<void> {
    await this.request('POST', `/messages/${encodeURIComponent(id)}/trash`, COST.trash);
  }

  async untrash(id: string): Promise<void> {
    await this.request('POST', `/messages/${encodeURIComponent(id)}/untrash`, COST.untrash);
  }

  send(raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
    return this.request('POST', '/messages/send', COST.send, { body: threadId ? { raw, threadId } : { raw } });
  }

  thread(id: string, full: boolean): Promise<{ id: string; messages?: Message[] }> {
    const query: Query = full ? { format: 'full' } : { format: 'metadata', metadataHeaders: THREAD_HEADERS };
    return this.request('GET', `/threads/${encodeURIComponent(id)}`, COST.threadGet, { query });
  }

  attachment(messageId: string, attachmentId: string): Promise<{ data: string; size: number }> {
    return this.request('GET', `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, COST.attachmentGet);
  }

  async drafts(max: number): Promise<Array<{ id: string; message: { id: string; threadId: string } }>> {
    const r = await this.request<{ drafts?: Array<{ id: string; message: { id: string; threadId: string } }> } | undefined>(
      'GET', '/drafts', COST.draftsList, { query: { maxResults: max } },
    );
    return r?.drafts ?? [];
  }

  draft(id: string): Promise<Draft> {
    return this.request('GET', `/drafts/${encodeURIComponent(id)}`, COST.draftGet, { query: { format: 'full' } });
  }

  createDraft(raw: string, threadId?: string): Promise<Draft> {
    return this.request('POST', '/drafts', COST.draftCreate, { body: { message: threadId ? { raw, threadId } : { raw } } });
  }

  updateDraft(id: string, raw: string, threadId?: string): Promise<Draft> {
    return this.request('PUT', `/drafts/${encodeURIComponent(id)}`, COST.draftUpdate, {
      body: { id, message: threadId ? { raw, threadId } : { raw } },
    });
  }

  async deleteDraft(id: string): Promise<void> {
    await this.request('DELETE', `/drafts/${encodeURIComponent(id)}`, COST.draftDelete);
  }

  sendDraft(id: string): Promise<{ id: string; threadId: string }> {
    return this.request('POST', '/drafts/send', COST.draftSend, { body: { id } });
  }

  async sendAs(): Promise<SendAs[]> {
    const r = await this.request<{ sendAs?: SendAs[] } | undefined>('GET', '/settings/sendAs', COST.sendAsList);
    return r?.sendAs ?? [];
  }

  async labels(): Promise<Label[]> {
    const r = await this.request<{ labels?: Label[] } | undefined>('GET', '/labels', COST.labels);
    return r?.labels ?? [];
  }

  label(id: string): Promise<Label> {
    return this.request('GET', `/labels/${encodeURIComponent(id)}`, COST.labelGet);
  }

  createLabel(name: string): Promise<Label> {
    return this.request('POST', '/labels', COST.labelCreate, {
      body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
  }

  async filters(): Promise<Filter[]> {
    // A mailbox with no filters answers with an empty body.
    const r = await this.request<{ filter?: Filter[] } | undefined>('GET', '/settings/filters', COST.filtersList);
    return r?.filter ?? [];
  }

  createFilter(filter: Omit<Filter, 'id'>): Promise<Filter> {
    return this.request('POST', '/settings/filters', COST.filtersCreate, { body: filter });
  }

  async deleteFilter(id: string): Promise<void> {
    await this.request('DELETE', `/settings/filters/${encodeURIComponent(id)}`, COST.filtersDelete);
  }

  async request<T>(method: string, path: string, cost: number, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(BASE + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (Array.isArray(value)) {
        value.forEach((v) => url.searchParams.append(key, v));
      } else if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    let reauthorized = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.pacer.run(cost, async () => {
          const token = await this.accessToken();
          return this.deps.fetch(url, {
            method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body,
          });
        });
      } catch (e) {
        if (attempt < MAX_RETRIES && e instanceof TypeError) {
          await this.deps.sleep(backoffMs(attempt, null));
          continue;
        }
        throw e;
      }
      const text = await res.text();
      if (res.ok) {
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const { reason, message } = errorDetail(text);
      // An access token can be revoked before its expiry; one fresh token is worth one retry.
      if (res.status === 401 && !reauthorized) {
        reauthorized = true;
        this.access = undefined;
        continue;
      }
      // Throttling is per mailbox, so every caller waits out the backoff, not just this one.
      if (isRetryable(res.status, reason) && attempt < MAX_RETRIES) {
        this.pacer.pause(backoffMs(attempt, res.headers.get('retry-after')));
        continue;
      }
      // A mailbox connected before a scope was added holds a token without it; it needs one reconnect.
      if (res.status === 403 && (reason === 'insufficientPermissions' || /insufficient authentication scopes/i.test(message))) {
        throw new GmailError(
          `${this.mailbox} has not granted the permission this needs (${method} ${path}). Run connect for ${this.mailbox} and allow every permission.`,
          res.status,
          reason,
        );
      }
      throw new GmailError(`Gmail ${res.status}${reason ? ` ${reason}` : ''} on ${method} ${path}: ${message}`, res.status, reason);
    }
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - 60000 > this.deps.now()) {
      return this.access.token;
    }
    const refreshToken = this.deps.store.get(this.mailbox);
    if (!refreshToken) {
      throw new Error(`Mailbox ${this.mailbox} is not connected. Run connect.`);
    }
    this.access = await refreshAccessToken(this.deps.fetch, this.deps.client, this.mailbox, refreshToken, this.deps.now);
    return this.access.token;
  }
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  return Math.min(60000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

function errorDetail(text: string): { reason: string | undefined; message: string } {
  try {
    const json = JSON.parse(text) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    return { reason: json.error?.errors?.[0]?.reason, message: json.error?.message ?? text };
  } catch {
    return { reason: undefined, message: text.slice(0, 200) };
  }
}
