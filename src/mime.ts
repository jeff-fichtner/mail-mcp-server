// MIME: build the messages this server sends or drafts, and read text and attachments out of a
// fetched message.

import { randomBytes } from 'node:crypto';

export interface Attachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface ComposedMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Attachment[];
}

export interface OutgoingMessage {
  from: string;
  to: string[];
  subject: string;
  body: string;
}

export interface MessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MessagePart[];
}

export interface AttachmentRef {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  data?: string;
}

// Header values can come from elsewhere (a List-Unsubscribe header, a message being replied to), so
// line breaks are removed: they would otherwise let that source add headers, such as another
// recipient, to mail sent as the user.
const clean = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

export function buildMessage(message: ComposedMessage): string {
  const headers = [
    `From: ${clean(message.from)}`,
    `To: ${message.to.map(clean).join(', ')}`,
  ];
  if (message.cc && message.cc.length > 0) {
    headers.push(`Cc: ${message.cc.map(clean).join(', ')}`);
  }
  if (message.bcc && message.bcc.length > 0) {
    headers.push(`Bcc: ${message.bcc.map(clean).join(', ')}`);
  }
  headers.push(`Subject: ${encodeHeader(clean(message.subject))}`);
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${clean(message.inReplyTo)}`);
  }
  if (message.references) {
    headers.push(`References: ${clean(message.references)}`);
  }
  headers.push('MIME-Version: 1.0');

  const text = [
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(message.body, 'utf8').toString('base64')),
  ];
  let lines: string[];
  if (!message.attachments || message.attachments.length === 0) {
    lines = [...headers, ...text];
  } else {
    const boundary = `mail-${randomBytes(12).toString('hex')}`;
    lines = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...text];
    for (const attachment of message.attachments) {
      lines.push(
        `--${boundary}`,
        `Content-Type: ${clean(attachment.mimeType)}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; ${filenameParam(attachment.filename)}`,
        '',
        wrap(attachment.data.toString('base64')),
      );
    }
    lines.push(`--${boundary}--`);
  }
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

// The plain-text message a mailto unsubscribe sends.
export function buildRawMessage(message: OutgoingMessage): string {
  return buildMessage(message);
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function filenameParam(filename: string): string {
  const name = clean(filename).replace(/"/g, '');
  if (/^[\x20-\x7e]*$/.test(name)) {
    return `filename="${name}"`;
  }
  return `filename*=UTF-8''${encodeURIComponent(name)}`;
}

function wrap(base64: string): string {
  return base64.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

// Prefers text/plain; falls back to text/html with the tags stripped.
export function extractText(payload: MessagePart | undefined, maxChars: number): { text: string; truncated: boolean } {
  const plain = findPart(payload, 'text/plain');
  const html = plain ? undefined : findPart(payload, 'text/html');
  let text = '';
  if (plain) {
    text = decode(plain);
  } else if (html) {
    text = decode(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim();
  }
  if (text.length > maxChars) {
    return { text: text.slice(0, maxChars), truncated: true };
  }
  return { text, truncated: false };
}

// Every part with a filename is an attachment; its bytes are either inline (small parts) or behind
// an attachment id.
export function listAttachments(payload: MessagePart | undefined): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const walk = (part: MessagePart | undefined) => {
    if (!part) {
      return;
    }
    if (part.filename && (part.body?.attachmentId || part.body?.data)) {
      const ref: AttachmentRef = {
        partId: part.partId ?? '',
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body?.size ?? 0,
      };
      if (part.body?.attachmentId) {
        ref.attachmentId = part.body.attachmentId;
      } else if (part.body?.data) {
        ref.data = part.body.data;
      }
      out.push(ref);
    }
    for (const child of part.parts ?? []) {
      walk(child);
    }
  };
  walk(payload);
  return out;
}

function findPart(part: MessagePart | undefined, mimeType: string): MessagePart | undefined {
  if (!part) {
    return undefined;
  }
  if (part.mimeType === mimeType && part.body?.data && !part.filename) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function decode(part: MessagePart): string {
  return Buffer.from(part.body?.data ?? '', 'base64url').toString('utf8');
}
