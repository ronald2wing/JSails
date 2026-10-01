/**
 * A scripted MCP server for bridge tests: it answers JSON-RPC on one end of
 * the official client's `InMemoryTransport` pair, so the real `Client` runs
 * its handshake, pagination, and cancellation against it. It serves the
 * given tools in pages, answers `tools/call` from a handler, and records
 * every request and `notifications/cancelled` it receives.
 */

import { Client, InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/client';

/** What a `tools/call` handler returns: a result, or a promise of one. */
export type CallHandler = (
  name: string,
  args: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/** A connected client and what its server saw. */
export interface ScriptedServer {
  readonly client: Client;
  readonly methods: string[];
  readonly cursors: (string | undefined)[];
  readonly cancelled: unknown[];
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Start a server with `tools` split into pages of `pageSize`, and connect a client. */
export async function startScriptedServer(
  tools: readonly object[],
  onCall: CallHandler,
  pageSize = tools.length || 1,
): Promise<ScriptedServer> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const methods: string[] = [];
  const cursors: (string | undefined)[] = [];
  const cancelled: unknown[] = [];

  const reply = (id: unknown, result: unknown): void => {
    void serverSide.send({ jsonrpc: '2.0', id, result } as JSONRPCMessage);
  };

  serverSide.onmessage = (message: JSONRPCMessage): void => {
    const raw = message as unknown as Record<string, unknown>;
    const method = typeof raw.method === 'string' ? raw.method : undefined;
    if (method === undefined) return;
    methods.push(method);
    const params = isRecord(raw.params) ? raw.params : {};
    if (method === 'notifications/cancelled') {
      cancelled.push(params.requestId);
      return;
    }
    if (!('id' in raw)) return;
    const id = raw.id;
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'scripted', version: '1.0.0' },
      });
    } else if (method === 'tools/list') {
      const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
      cursors.push(cursor);
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = tools.slice(start, start + pageSize);
      const next = start + pageSize < tools.length ? String(start + pageSize) : undefined;
      reply(id, { tools: page, ...(next === undefined ? {} : { nextCursor: next }) });
    } else if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      void Promise.resolve(onCall(name, args)).then((result) => reply(id, result));
    } else {
      reply(id, {});
    }
  };
  await serverSide.start();

  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  await client.connect(clientSide);
  return {
    client,
    methods,
    cursors,
    cancelled,
    async close(): Promise<void> {
      await client.close();
    },
  };
}
