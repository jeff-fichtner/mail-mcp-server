// The library: the token store, the paced Gmail client, the mail operations behind the MCP
// tools, and the MCP stdio loop. The `mail-mcp-server` command serves them over stdio.

export * from './config.ts';
export * from './gmail.ts';
export { Mail, type MailDeps } from './mail.ts';
export * from './stdio.ts';
