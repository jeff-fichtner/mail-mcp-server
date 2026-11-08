// Parsing for the headers this server acts on: who sent a message, and how to unsubscribe from it.

export interface Sender {
  address: string;
  name: string;
}

export type UnsubscribeMethod = 'one-click' | 'mailto' | 'link-only' | 'none';

export interface Mailto {
  to: string[];
  subject: string;
  body: string;
}

export interface Unsubscribe {
  method: UnsubscribeMethod;
  // The http(s) link from the header, when there is one. Only a one-click link is ever POSTed to;
  // any other link is reported for a person to open, never fetched.
  url?: string;
  mailto?: Mailto;
}

// Senders are grouped by address, lowercased; the display name is kept for people to read.
export function parseSender(from: string): Sender {
  const angle = /<([^<>]+)>\s*$/.exec(from);
  if (angle) {
    const name = from
      .slice(0, angle.index)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    return { address: (angle[1] ?? '').trim().toLowerCase(), name };
  }
  return { address: from.trim().toLowerCase(), name: '' };
}

// RFC 2369 List-Unsubscribe, with RFC 8058 one-click when List-Unsubscribe-Post says so.
// Entries are <...> delimited; senders that omit the brackets are read as comma-separated.
// Header folding can leave whitespace inside an entry, and URIs hold none, so it is removed.
export function parseUnsubscribe(listUnsubscribe: string | undefined, listUnsubscribePost: string | undefined): Unsubscribe {
  if (!listUnsubscribe || !listUnsubscribe.trim()) {
    return { method: 'none' };
  }
  const bracketed = [...listUnsubscribe.matchAll(/<([^>]*)>/g)].map((m) => m[1] ?? '');
  const entries = (bracketed.length > 0 ? bracketed : listUnsubscribe.split(','))
    .map((e) => e.replace(/\s+/g, ''))
    .filter((e) => e.length > 0);

  const link = entries.find((e) => /^https?:\/\//i.test(e));
  const mailto = entries.map(parseMailto).find((m) => m !== undefined);
  const oneClick = link !== undefined
    && /^https:\/\//i.test(link)
    && /^\s*List-Unsubscribe=One-Click\s*$/i.test(listUnsubscribePost ?? '');

  if (oneClick) {
    return withOptional({ method: 'one-click', url: link }, mailto);
  }
  if (mailto) {
    return withOptional({ method: 'mailto', mailto }, undefined, link);
  }
  if (link) {
    return { method: 'link-only', url: link };
  }
  return { method: 'none' };
}

function withOptional(base: Unsubscribe, mailto?: Mailto, url?: string): Unsubscribe {
  const out: Unsubscribe = { ...base };
  if (mailto) {
    out.mailto = mailto;
  }
  if (url) {
    out.url = url;
  }
  return out;
}

function parseMailto(entry: string): Mailto | undefined {
  if (!/^mailto:/i.test(entry)) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(entry);
  } catch {
    return undefined;
  }
  const to = decodeURIComponent(parsed.pathname)
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.includes('@'));
  if (to.length === 0) {
    return undefined;
  }
  // A mailto without subject or body is common; "unsubscribe" is what list servers expect then.
  return {
    to,
    subject: parsed.searchParams.get('subject') ?? 'unsubscribe',
    body: parsed.searchParams.get('body') ?? 'unsubscribe',
  };
}
