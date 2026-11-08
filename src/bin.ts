#!/usr/bin/env node
// `mail-mcp-server` serves MCP over stdio; `mail-mcp-server connect [address]` connects a mailbox
// from a terminal.

if (process.argv[2] === undefined) {
  await import('./server.ts');
} else {
  await import('./cli.ts');
}
