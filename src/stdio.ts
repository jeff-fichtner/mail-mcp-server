// The MCP stdio loop: JSON-RPC lines in, JSON-RPC lines out. Tool failures come back as tool
// results marked isError, so the model reads the message; unknown methods are JSON-RPC errors.

import { createInterface } from 'node:readline';

export interface ServerInfo {
  name: string;
  version: string;
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export function serveStdio(info: ServerInfo, tools: unknown[], callTool: CallTool): void {
  const send = (message: unknown) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const handleCall = async (
    id: unknown,
    params: { name?: string; arguments?: Record<string, unknown> } | undefined,
  ) => {
    try {
      const result = await callTool(params?.name ?? '', params?.arguments ?? {});
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      });
    } catch (e) {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: (e as Error).message }], isError: true },
      });
    }
  };

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = message;
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params?.['protocolVersion'] as string | undefined) ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: info,
        },
      });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools } });
    } else if (method === 'tools/call') {
      void handleCall(id, params as { name?: string; arguments?: Record<string, unknown> });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (id !== undefined && !method?.startsWith('notifications/')) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  });
}
