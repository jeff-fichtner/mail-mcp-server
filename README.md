# mail-mcp-server

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant such as Claude Code work
in your Gmail: search and read, count mail by sender, unsubscribe, label, archive, trash, and manage
filters and settings. One server reaches every mailbox you connect, with one OAuth refresh token per
mailbox.

- **No runtime dependencies.** Node built-ins only, so there is no third-party code to trust with
  your mail.
- **Node 22.18 or newer.** In a clone, Node runs the TypeScript source directly; the npm package
  ships it compiled to JavaScript.
- **Nothing changes without a plan you can see.** Every change to mail is a dry run first (below).
- **No general send.** It sends only what you approve as a plan.

## The safety model: plan, then execute

Every tool that changes mail or settings comes in two steps.

1. A `plan_*` tool changes nothing. It returns a summary of what would happen (how many messages,
   the top senders, sample subjects, unsubscribe targets) and a `plan_id`.
2. `execute_plan` carries out that plan and nothing else: the exact message ids, senders or filter
   the dry run found, never a fresh run of the query. Plans are single-use and expire after 10
   minutes.

Since `execute_plan` is the only tool that changes mail, one Claude Code permission rule makes every
change wait for your approval:

```json
{ "permissions": { "ask": ["mcp__mail__execute_plan"] } }
```

The assistant can then search, count and propose freely. Nothing is archived, trashed, unsubscribed
or sent until you have seen the summary and said yes.

Reads, drafts, creating or renaming a label, and deleting a filter run directly.

## Tools

| Area | Tools |
|---|---|
| Mailboxes | `list_mailboxes`, `connect`, `mailbox_overview` |
| Reading | `search`, `get_message`, `get_thread`, `save_attachments`, `sender_stats` |
| Writing | `create_draft`, `update_draft`, `list_drafts`; `plan_send`, `plan_delete_draft` |
| Message state | `plan_modify`: archive, trash, untrash, read/unread, star, important, spam/not spam, add/remove a label |
| Unsubscribe | `plan_unsubscribe` |
| Labels | `create_label`, `update_label` (rename, recolor); `plan_delete_label` |
| Filters | `list_filters`, `delete_filter`; `plan_create_filter` with any of archive, trash, label, never_spam, mark_read, star, important, never_important, categorize, forward |
| Settings | `get_vacation`, `plan_set_vacation`; `list_send_as`, `plan_create_send_as`, `plan_update_send_as`, `plan_delete_send_as`; `list_forwarding`, `plan_add_forwarding_address`, `plan_set_auto_forward` |
| Acting | `execute_plan` |

The Gmail API can't reach these, so they aren't here: inbox type and tabs, snooze, mute, and
delegation (which needs a service account).

### Unsubscribe

Per sender, using its newest message that carries `List-Unsubscribe`:

- **one-click** (RFC 8058: an https link plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`):
  a POST of `List-Unsubscribe=One-Click` to that link.
- **mailto**: a plain-text message from the mailbox to the header's address only.
- **link-only** and **none**: skipped, and the link is reported for you to open yourself. The server
  never fetches an unsubscribe link with GET.

For senders that can't be unsubscribed, `plan_create_filter` keeps their future mail out of the
inbox.

## Setup

You bring your own Google OAuth client. Your tokens never leave your machine.

1. **Create an OAuth client.** In a Google Cloud project, enable the Gmail API. Configure the OAuth
   consent screen (External; while it is in Testing, add your mailboxes as test users). Then create
   an OAuth client of type **Desktop app**.
2. **Give the server the client.** On macOS, store it in the Keychain under service
   `mail_oauth_client` as JSON, `{"client_id":"….apps.googleusercontent.com","client_secret":"…"}`.
   This command asks for the value, so the secret stays out of your shell history:

   ```sh
   security add-generic-password -U -s mail_oauth_client -a "$USER" -w
   ```

   On other systems, set env `MAIL_OAUTH_CLIENT` to the same JSON. If the client is missing or
   malformed, the server says so at startup on stderr and on every call.
3. **Pick an owner id.** Env `MAIL_OWNER_ID` is required and has no default. It names the person
   whose mailboxes this server reaches. Tokens are stored under it, and the server sees only that
   owner's mailboxes. Any stable string works, for example a UUID.
4. **Register the server with Claude Code:**

   ```sh
   claude mcp add --scope user mail -e MAIL_OWNER_ID=YOUR_OWNER_ID -- npx -y mail-mcp-server@0.1.0
   ```

   Pinning the version means an update arrives only when you change it. To run from a clone
   instead, use `node /path/to/clone/src/bin.ts` as the command.

5. **Connect each mailbox.** Ask Claude to call `connect`, or run
   `MAIL_OWNER_ID=YOUR_OWNER_ID npx -y mail-mcp-server@0.1.0 connect [address]`. Google's consent
   page opens in your browser. The refresh token is stored in the Keychain service `mail_tokens` as JSON
   `{"<owner id>":{"<address>":"<refresh token>"}}`. A flat `{"<address>":"<refresh token>"}` map is
   read as the server's owner's and rewritten in the keyed shape. If env `MAIL_TOKENS` is set (same
   keyed shape), the server reads tokens from it instead and never writes.

Scopes requested: `gmail.modify` (read, label, archive, trash, drafts, send), `gmail.settings.basic`
(filters, vacation, signatures) and `gmail.settings.sharing` (send-as addresses, forwarding). It does
not request `mail.google.com`, which would add permanent delete. If a mailbox was connected before a
scope was added, a call that needs that scope tells you to run `connect` again.

An app left in Testing mode gets refresh tokens that expire after 7 days. Publishing the app
(verified or not) lifts that. When a token expires or is revoked, calls for that mailbox say to run
`connect` again.

## Limits and pacing

Gmail's published limit is 15,000 quota units a minute per mailbox (a list or get costs 5, a batch
modify 50, a send 100). Projects also carry a second limit, 6,000 "total query cost" a minute per
mailbox, and that is the one that binds. Measured on a real mailbox, Gmail throttles after about 300
message fetches a minute, however they are paced. So reading headers runs at about 300 messages a
minute per mailbox, and `sender_stats` over a month of a busy mailbox takes several minutes.

The server sends bursts of up to 90 units a second, with up to 10 requests in flight. On a 429, a
403 `rateLimitExceeded` / `userRateLimitExceeded`, or a 5xx, it pauses every request for that
mailbox and retries with backoff long enough to outlast a one-minute window, honouring
`Retry-After`.

## Development

```sh
npm install
npm run check
```

`check` runs `tsc` (type check only) and `node --test`. The tests run against a fake Google and touch
neither the network nor the Keychain. `npm run build` compiles to `dist/`, which is what the npm
package ships; `npm publish` runs the check and the build first.

### Using it as a library

The package also exports its building blocks for other servers built on the same token store:
`mail-mcp-server/config` (OAuth client and token store), `mail-mcp-server/gmail` (the paced Gmail
client), `mail-mcp-server/stdio` (the MCP stdio loop) and `mail-mcp-server/testing` (a fake Google
for tests).

## License

MIT
