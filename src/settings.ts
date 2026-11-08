// Gmail settings: labels, vacation responder, send-as addresses, forwarding. Reads run directly.
// Every change is a plan holding the exact request it will make; execute_plan makes that request
// and nothing else.

import type { Gmail, Label } from './gmail.ts';

export interface SettingsChange {
  method: string;
  path: string;
  cost: number;
  body?: unknown;
  done: string;
}

export interface Planned {
  summary: Record<string, unknown>;
  change: SettingsChange;
}

export interface SendAsFields {
  displayName?: string;
  replyTo?: string;
  signature?: string;
  makeDefault?: boolean;
}

export interface VacationFields {
  enabled: boolean;
  subject?: string;
  body?: string;
  start?: string;
  end?: string;
  contactsOnly?: boolean;
  domainOnly?: boolean;
}

export const FORWARD_DISPOSITIONS = ['leaveInInbox', 'archive', 'trash', 'markRead'] as const;
export type ForwardDisposition = (typeof FORWARD_DISPOSITIONS)[number];

const enc = encodeURIComponent;

// --- labels ---------------------------------------------------------------------------------

// Renaming or recoloring a label changes no message, so it runs directly. Gmail accepts only its
// own palette of colors and rejects any other with an error that names it.
export async function updateLabel(gmail: Gmail, label: Label, name: string | undefined, background: string | undefined, text: string | undefined) {
  if (name === undefined && background === undefined && text === undefined) {
    throw new Error('Give a new name, or both colors');
  }
  if ((background === undefined) !== (text === undefined)) {
    throw new Error('Gmail sets a label color as a pair: give background_color and text_color together');
  }
  const body: Record<string, unknown> = {};
  if (name !== undefined) {
    body['name'] = name;
  }
  if (background !== undefined) {
    body['color'] = { backgroundColor: background, textColor: text };
  }
  const updated = await gmail.request<Label>('PATCH', `/labels/${enc(label.id)}`, 5, { body });
  return { mailbox: gmail.mailbox, id: updated.id, label: updated.name, previous_name: label.name };
}

export async function planDeleteLabel(gmail: Gmail, label: Label): Promise<Planned> {
  if (label.type === 'system') {
    throw new Error(`${label.name} is a system label; Gmail does not let it be deleted`);
  }
  const counts = await gmail.label(label.id);
  return {
    summary: {
      label: label.name,
      messages_with_label: counts.messagesTotal ?? 0,
      note: 'The label goes; its messages stay, without it.',
    },
    change: { method: 'DELETE', path: `/labels/${enc(label.id)}`, cost: 5, done: `deleted label ${label.name}` },
  };
}

// --- vacation responder ---------------------------------------------------------------------

export async function getVacation(gmail: Gmail) {
  const v = await gmail.request<Record<string, unknown>>('GET', '/settings/vacation', 1);
  return { mailbox: gmail.mailbox, ...v };
}

export function planSetVacation(fields: VacationFields): Planned {
  const ms = (iso: string | undefined, key: string) => {
    if (iso === undefined) {
      return undefined;
    }
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
      throw new Error(`${key} must be a date or date-time, like 2026-11-01 or 2026-11-01T09:00:00-05:00`);
    }
    return String(t);
  };
  if (fields.enabled && !fields.body) {
    throw new Error('Turning the responder on needs a body');
  }
  const body: Record<string, unknown> = { enableAutoReply: fields.enabled };
  const optional: Array<[string, unknown]> = [
    ['responseSubject', fields.subject],
    ['responseBodyPlainText', fields.body],
    ['startTime', ms(fields.start, 'start')],
    ['endTime', ms(fields.end, 'end')],
    ['restrictToContacts', fields.contactsOnly],
    ['restrictToDomain', fields.domainOnly],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) {
      body[key] = value;
    }
  }
  return {
    summary: {
      enabled: fields.enabled,
      subject: fields.subject ?? null,
      body: fields.body ?? null,
      start: fields.start ?? null,
      end: fields.end ?? null,
      contacts_only: fields.contactsOnly ?? false,
      domain_only: fields.domainOnly ?? false,
      note: fields.enabled ? 'While on, Gmail replies automatically to incoming mail with this text.' : 'Turns the responder off.',
    },
    change: { method: 'PUT', path: '/settings/vacation', cost: 5, body, done: fields.enabled ? 'vacation responder on' : 'vacation responder off' },
  };
}

// --- send-as --------------------------------------------------------------------------------

export async function listSendAs(gmail: Gmail) {
  const identities = await gmail.sendAs();
  return {
    mailbox: gmail.mailbox,
    send_as: identities.map((s) => ({
      email: s.sendAsEmail,
      display_name: s.displayName ?? '',
      primary: s.isPrimary ?? false,
      default: s.isDefault ?? false,
      verification: s.isPrimary ? 'primary' : s.verificationStatus ?? 'unknown',
      signature: s.signature ?? '',
    })),
  };
}

export function planCreateSendAs(email: string, fields: SendAsFields & { treatAsAlias: boolean }): Planned {
  const body: Record<string, unknown> = { sendAsEmail: email, treatAsAlias: fields.treatAsAlias };
  if (fields.displayName !== undefined) {
    body['displayName'] = fields.displayName;
  }
  if (fields.replyTo !== undefined) {
    body['replyToAddress'] = fields.replyTo;
  }
  if (fields.signature !== undefined) {
    body['signature'] = fields.signature;
  }
  return {
    summary: {
      email,
      display_name: fields.displayName ?? null,
      reply_to: fields.replyTo ?? null,
      signature: fields.signature ?? null,
      treat_as_alias: fields.treatAsAlias,
      note: 'Gmail emails a confirmation to this address; it can be used once someone with access to it clicks that link.',
    },
    change: { method: 'POST', path: '/settings/sendAs', cost: 100, body, done: `added send-as ${email}` },
  };
}

export async function planUpdateSendAs(gmail: Gmail, email: string, fields: SendAsFields): Promise<Planned> {
  const current = (await gmail.sendAs()).find((s) => s.sendAsEmail.toLowerCase() === email.toLowerCase());
  if (!current) {
    throw new Error(`${email} is not a send-as address of ${gmail.mailbox}`);
  }
  const body: Record<string, unknown> = {};
  if (fields.displayName !== undefined) {
    body['displayName'] = fields.displayName;
  }
  if (fields.replyTo !== undefined) {
    body['replyToAddress'] = fields.replyTo;
  }
  if (fields.signature !== undefined) {
    body['signature'] = fields.signature;
  }
  if (fields.makeDefault) {
    body['isDefault'] = true;
  }
  if (Object.keys(body).length === 0) {
    throw new Error('Give at least one of display_name, reply_to, signature, make_default');
  }
  return {
    summary: {
      email: current.sendAsEmail,
      display_name: { from: current.displayName ?? '', to: fields.displayName ?? current.displayName ?? '' },
      signature_changes: fields.signature !== undefined,
      reply_to: fields.replyTo ?? null,
      make_default: fields.makeDefault ?? false,
    },
    change: { method: 'PATCH', path: `/settings/sendAs/${enc(current.sendAsEmail)}`, cost: 100, body, done: `updated send-as ${current.sendAsEmail}` },
  };
}

export async function planDeleteSendAs(gmail: Gmail, email: string): Promise<Planned> {
  const current = (await gmail.sendAs()).find((s) => s.sendAsEmail.toLowerCase() === email.toLowerCase());
  if (!current) {
    throw new Error(`${email} is not a send-as address of ${gmail.mailbox}`);
  }
  if (current.isPrimary) {
    throw new Error(`${email} is the mailbox's own address; it cannot be removed`);
  }
  return {
    summary: { email: current.sendAsEmail, display_name: current.displayName ?? '', note: 'The mailbox can no longer send as this address until it is added and confirmed again.' },
    change: { method: 'DELETE', path: `/settings/sendAs/${enc(current.sendAsEmail)}`, cost: 5, done: `removed send-as ${current.sendAsEmail}` },
  };
}

// --- forwarding -----------------------------------------------------------------------------

export async function forwardingAddresses(gmail: Gmail): Promise<Array<{ forwardingEmail: string; verificationStatus?: string }>> {
  const r = await gmail.request<{ forwardingAddresses?: Array<{ forwardingEmail: string; verificationStatus?: string }> } | undefined>(
    'GET', '/settings/forwardingAddresses', 1,
  );
  return r?.forwardingAddresses ?? [];
}

export async function listForwarding(gmail: Gmail) {
  const [addresses, auto] = await Promise.all([
    forwardingAddresses(gmail),
    gmail.request<Record<string, unknown>>('GET', '/settings/autoForwarding', 1),
  ]);
  return {
    mailbox: gmail.mailbox,
    forwarding_addresses: addresses.map((a) => ({ email: a.forwardingEmail, verification: a.verificationStatus ?? 'unknown' })),
    auto_forward: auto,
  };
}

export function planAddForwardingAddress(email: string): Planned {
  return {
    summary: {
      email,
      note: 'Gmail emails a confirmation to this address; mail can be forwarded there once someone with access to it clicks that link.',
    },
    change: { method: 'POST', path: '/settings/forwardingAddresses', cost: 100, body: { forwardingEmail: email }, done: `added forwarding address ${email}` },
  };
}

// Forwarding every incoming message elsewhere is how a mailbox is quietly copied out, so the plan
// names the destination in full and says what happens to the original.
export async function planSetAutoForward(gmail: Gmail, enabled: boolean, email: string | undefined, disposition: ForwardDisposition | undefined): Promise<Planned> {
  if (enabled) {
    if (!email) {
      throw new Error('Turning auto-forward on needs the address to forward to');
    }
    const address = (await forwardingAddresses(gmail)).find((a) => a.forwardingEmail.toLowerCase() === email.toLowerCase());
    if (!address) {
      throw new Error(`${email} is not a forwarding address of ${gmail.mailbox}; plan_add_forwarding_address adds it`);
    }
    if (address.verificationStatus !== 'accepted') {
      throw new Error(`${email} is not confirmed yet (${address.verificationStatus ?? 'unknown'}); its confirmation email has to be clicked first`);
    }
  }
  const body: Record<string, unknown> = { enabled };
  if (email) {
    body['emailAddress'] = email;
  }
  if (disposition) {
    body['disposition'] = disposition;
  }
  return {
    summary: {
      enabled,
      forward_every_incoming_message_to: enabled ? email : null,
      original_message: disposition ?? 'leaveInInbox',
      note: enabled ? `Every message arriving in ${gmail.mailbox} will also be sent to ${email}.` : 'Turns auto-forward off.',
    },
    change: { method: 'PUT', path: '/settings/autoForwarding', cost: 5, body, done: enabled ? `auto-forward on to ${email}` : 'auto-forward off' },
  };
}
