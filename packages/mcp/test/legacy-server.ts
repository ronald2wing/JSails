/**
 * A legacy-only server for client tests, wired the 2025 way on the SDK's
 * low-level `Server` (no era entry, no `server/discover`): it answers exactly
 * what a test scripts, including what a conforming server never sends (an
 * endless cursor, a malformed tool, output that breaks its schema, an
 * oversized or malformed result). Served statelessly over Streamable HTTP, a
 * fresh server per request.
 */

import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

/** What the scripted server answers. */
export interface LegacyScript {
  /** The tools on each `tools/list` page, in order. */
  readonly pages: readonly (readonly Record<string, unknown>[])[];
  /** The cursor each page names as next; default: the next page's index, none after the last. */
  readonly cursors?: readonly (string | undefined)[];
  /** The `tools/call` result for a name and arguments; a throw becomes a JSON-RPC error. */
  readonly call?: (
    name: string,
    args: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

function legacyServer(script: LegacyScript): Server {
  const server = new Server(
    { name: 'legacy-only', version: '0.9.0' },
    { capabilities: { tools: {} }, instructions: 'A 2025 server.' },
  );
  server.setRequestHandler('tools/list', (request) => {
    const cursor = request.params?.cursor;
    const page = cursor === undefined ? 0 : Number(cursor.replace('page-', ''));
    const next =
      script.cursors === undefined
        ? page + 1 < script.pages.length
          ? `page-${page + 1}`
          : undefined
        : script.cursors[page];
    return {
      tools: (script.pages[page] ?? []) as never,
      ...(next === undefined ? {} : { nextCursor: next }),
    };
  });
  server.setRequestHandler('tools/call', async (request) => {
    if (script.call === undefined) {
      throw new Error('no tools/call in this script');
    }
    return (await script.call(request.params.name, request.params.arguments ?? {})) as never;
  });
  return server;
}

/** Serve the script statelessly over Streamable HTTP. */
export function legacyHttpHandler(script: LegacyScript): (request: Request) => Promise<Response> {
  return async (request) => {
    const server = legacyServer(script);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
