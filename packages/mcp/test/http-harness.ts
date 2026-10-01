/**
 * An HTTP harness for endpoint tests: a real `node:http` listener in front of
 * an endpoint's `handle` (streaming responses, aborting the request when the
 * client goes away), a raw JSON-RPC poster that builds the 2026-07-28
 * envelope and standard headers, and a connector for the official client in
 * the modern, legacy, or auto mode.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export type ClientMode = 'modern' | 'legacy' | 'auto';
export const CLIENT_MODES: readonly ClientMode[] = ['modern', 'legacy', 'auto'];

/** A listening server. */
export interface Listener {
  readonly origin: string;
  readonly url: string;
  close(): Promise<void>;
}

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), {
    method,
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  });
}

async function write(response: Response, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const headers = Object.fromEntries(response.headers);
  // A response sent before the request body was read (413, 401) must not
  // leave the unread bytes on a socket the client pools for its next request.
  res.writeHead(response.status, req.complete ? headers : { ...headers, connection: 'close' });
  if (response.body === null) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      res.write(value);
    }
  } finally {
    res.end();
  }
}

/** Serve `handle` at `path` (and anything else at `fallback`) on an ephemeral port. */
export async function listen(
  handle: (request: Request) => Promise<Response> | Response,
  path = '/mcp',
  fallback?: (request: Request) => Promise<Response> | Response,
): Promise<Listener> {
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        controller.abort();
      }
    });
    const request = toRequest(req, controller.signal);
    const route = new URL(request.url).pathname === path ? handle : fallback;
    void (async () => {
      const response =
        route === undefined ? new Response(null, { status: 404 }) : await route(request);
      await write(response, req, res);
    })().catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: `${origin}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The reserved envelope keys of a 2026-07-28 request. */
export function envelope(capabilities: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': capabilities,
  };
}

/** A raw exchange: status, headers, and the parsed JSON body (or the text). */
export interface RawExchange {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: Record<string, unknown> | undefined;
}

/** POST one modern JSON-RPC request (or notification, without `id`) with the standard headers. */
export async function post(
  url: string,
  message: { id?: number; method: string; params?: Record<string, unknown> },
  headers: Record<string, string> = {},
): Promise<RawExchange> {
  const params: Record<string, unknown> = {
    ...message.params,
    _meta: { ...envelope(), ...(message.params?._meta as object) },
  };
  const name =
    typeof params.name === 'string'
      ? params.name
      : typeof params.uri === 'string'
        ? params.uri
        : undefined;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': message.method,
      ...(name === undefined ? {} : { 'mcp-name': name }),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(message.id === undefined ? {} : { id: message.id }),
      method: message.method,
      params,
    }),
  });
  return exchangeOf(response);
}

/** Read a response into a {@link RawExchange}; an SSE body yields its last JSON-RPC message. */
export async function exchangeOf(response: Response): Promise<RawExchange> {
  const text = await response.text();
  let json: Record<string, unknown> | undefined;
  const source = response.headers.get('content-type')?.startsWith('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .at(-1)
    : text;
  try {
    json =
      source === undefined || source === ''
        ? undefined
        : (JSON.parse(source) as Record<string, unknown>);
  } catch (_notJson) {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** Options for {@link connect}. */
export interface ConnectOptions {
  readonly token?: string;
  readonly capabilities?: ConstructorParameters<typeof Client>[1];
}

/** Connect the official client in `mode`, optionally sending a bearer token. */
export async function connect(
  url: string,
  mode: ClientMode,
  options: ConnectOptions = {},
): Promise<Client> {
  const client = new Client(
    { name: 'harness-client', version: '3.0.0' },
    {
      ...options.capabilities,
      versionNegotiation: {
        mode: mode === 'modern' ? { pin: '2026-07-28' } : mode === 'legacy' ? 'legacy' : 'auto',
      },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      ...(options.token === undefined
        ? {}
        : { requestInit: { headers: { authorization: `Bearer ${options.token}` } } }),
    }),
  );
  return client;
}
