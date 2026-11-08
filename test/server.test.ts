// The stdio server as Claude Code runs it: a child process speaking JSON-RPC lines. Config comes
// from env, so the Keychain is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const CLIENT_JSON = JSON.stringify({ client_id: 'id.apps.googleusercontent.com', client_secret: 's' });
const OWNER = 'owner-1';

async function session(env: Record<string, string>, requests: unknown[]): Promise<{ responses: Array<Record<string, any>>; stderr: string }> {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const expected = requests.filter((r) => (r as { id?: unknown }).id !== undefined).length;
  for (const r of requests) {
    child.stdin.write(`${JSON.stringify(r)}\n`);
  }
  const deadline = Date.now() + 10000;
  while (stdout.split('\n').filter(Boolean).length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill();
  return { responses: stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)), stderr };
}

test('initialize, tools/list and a tool call over stdio', async () => {
  const { responses, stderr } = await session({ MAIL_OWNER_ID: OWNER, MAIL_OAUTH_CLIENT: CLIENT_JSON, MAIL_TOKENS: JSON.stringify({ other: { 'x@y.z': 'rt' } }) }, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_mailboxes', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: { mailbox: 'a@b.c', query: 'x' } } },
    { jsonrpc: '2.0', id: 5, method: 'nope' },
  ]);
  const byId = new Map(responses.map((r) => [r['id'], r]));
  assert.equal(stderr, '');
  assert.equal(byId.get(1)?.['result'].protocolVersion, '2025-06-18');
  assert.equal(byId.get(1)?.['result'].serverInfo.name, 'mail-mcp-server');
  assert.equal(byId.get(2)?.['result'].tools.length, 31);
  assert.deepEqual(JSON.parse(byId.get(3)?.['result'].content[0].text), { mailboxes: [] });
  assert.equal(byId.get(4)?.['result'].isError, true);
  assert.match(byId.get(4)?.['result'].content[0].text, /a@b.c is not connected \(connected: none\)/);
  assert.equal(byId.get(5)?.['error'].code, -32601);
});

test('a malformed OAuth client is reported at startup and on every call', async () => {
  const { responses, stderr } = await session({ MAIL_OWNER_ID: OWNER, MAIL_OAUTH_CLIENT: '', MAIL_TOKENS: '{}' }, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_mailboxes', arguments: {} } },
  ]);
  assert.match(stderr, /ERROR: env MAIL_OAUTH_CLIENT is not JSON/);
  assert.equal(responses[0]?.['result'].isError, true);
  assert.match(responses[0]?.['result'].content[0].text, /MAIL_OAUTH_CLIENT is not JSON/);
});

test('a missing owner id is reported at startup and on every call', async () => {
  const { responses, stderr } = await session({ MAIL_OAUTH_CLIENT: CLIENT_JSON, MAIL_TOKENS: '{}' }, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_mailboxes', arguments: {} } },
  ]);
  assert.match(stderr, /ERROR: MAIL_OWNER_ID is required/);
  assert.equal(responses[0]?.['result'].isError, true);
  assert.match(responses[0]?.['result'].content[0].text, /MAIL_OWNER_ID is required/);
});
