// MCP server for Gmail over stdio (Node built-ins only).
// Configuration and registering with Claude Code are described in the README.

import { readFileSync } from 'node:fs';
import { openInBrowser } from './browser.ts';
import { loadClient, loadOwner, loadTokenStore } from './config.ts';
import { Mail } from './mail.ts';
import { serveStdio } from './stdio.ts';
import { TOOLS, callTool } from './tools.ts';

// package.json sits one level above both src/ and dist/.
const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// A missing owner id, or a missing or malformed OAuth client, is reported at startup on stderr and on every call, rather
// than letting calls go out without one.
let mail: Mail | undefined;
let startupError: string | undefined;
try {
  mail = new Mail({ client: loadClient(), store: loadTokenStore(loadOwner()) });
} catch (e) {
  startupError = (e as Error).message;
  process.stderr.write(`ERROR: ${startupError}\n`);
}

serveStdio({ name: 'mail-mcp-server', version: VERSION }, TOOLS, async (name, args) => {
  if (!mail) {
    throw new Error(startupError ?? 'The server did not start');
  }
  return callTool(mail, name, args, openInBrowser);
});
