/**
 * The Streamable HTTP endpoint over a real `node:http` listener.
 *
 * Spec vectors (2026-07-28, basic/transports and basic/authorization) are
 * replayed as raw HTTP: standard-header rules and `-32020`, the `Mcp-Param-*`
 * Base64 sentinel, `-32022`, `404`/`-32601`, `202` notifications, `405`,
 * session headers, Origin and Host `403`, `resultType` and cache fields,
 * `-32602` for unknown tools and resources, the body cap, the Protected
 * Resource Metadata document, and every `401`/`403` challenge. The official
 * client then runs in the modern, legacy, and auto modes, including the
 * multi-round-trip flows (answers, sealed state, confirmation, a forged
 * confirmation answer on either era, tampering and replay), progress over SSE,
 * cancellation by closing the request's stream, and the logging posture (no
 * logging capability, `logging/setLevel` unknown, no log messages sent).
 *
 * The body cap's wire behaviour is checked behind the framework's own HTTP
 * server (`createHttpServer`), not the harness listener: an early `413`
 * leaves the upload unread, and only a server that reads the rest before
 * closing spares the client a reset (which on Windows discards the `413`).
 * So is cancellation by disconnect, on either era, since only the
 * framework's adapter decides whether a disconnect aborts the request: the
 * handler sees it promptly, and a 2025 `notifications/cancelled` is
 * acknowledged without being routed to a request.
 */

import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';

import type { Client } from '@modelcontextprotocol/client';
import { createHttpServer } from 'jsails/app';

import { publicAccess, type McpAuthorize } from '../src/access.js';
import {
  defineMcpResource,
  defineMcpServer,
  defineMcpTool,
  type McpServerDefinition,
} from '../src/definitions.js';
import { McpDefinitionError } from '../src/errors.js';
import {
  createMcpHttpEndpoint,
  type McpAuthentication,
  type McpHttpEndpoint,
  type McpHttpOptions,
} from '../src/http-endpoint.js';
import { inputRequired } from '../src/input-required.js';
import { errorSink, rejection, within } from './fixtures.js';
import {
  CLIENT_MODES,
  connect,
  envelope,
  exchangeOf,
  listen,
  post,
  type Listener,
} from './http-harness.js';

const open = publicAccess('test fixture');
/** The endpoint's documented default `maxRequestBytes`. */
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const WRITE = { scope: 'notes:write' };
const HIDDEN = { deny: true };

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((block) => block.text ?? '').join('');
}

/** The `slow` tool's cancellations, by the `tag` its call carried. */
const cancellations = new Map<string, () => void>();

/** Resolves when the handler of the `slow` call tagged `tag` sees its signal abort. */
function cancellationOf(tag: string): {
  readonly seen: Promise<void>;
  readonly done: () => boolean;
} {
  let done = false;
  const seen = new Promise<void>((resolve) => {
    cancellations.set(tag, () => {
      done = true;
      resolve();
    });
  });
  return { seen, done: () => done };
}

function fixtureServer(): McpServerDefinition {
  return defineMcpServer({
    name: 'fixture',
    version: '1.0.0',
    tools: [
      defineMcpTool({
        name: 'echo',
        description: 'Echo the region.',
        input: z.object({ region: z.string().meta({ 'x-mcp-header': 'Region' }) }),
        access: open,
        handler: ({ region }) => region,
      }),
      defineMcpTool({
        name: 'count',
        description: 'Echo a count.',
        input: z.object({ n: z.number().int().meta({ 'x-mcp-header': 'Count' }) }),
        access: open,
        handler: ({ n }) => String(n),
      }),
      defineMcpTool({
        name: 'ask',
        description: 'Ask for a name.',
        input: z.object({ greeting: z.string() }),
        access: open,
        handler: async ({ greeting }, ctx) => {
          const answer = await ctx.answer('name', z.object({ name: z.string() }));
          if (answer === undefined) {
            return inputRequired({
              requests: {
                name: {
                  mode: 'form',
                  message: 'Your name?',
                  schema: z.object({ name: z.string() }),
                },
              },
              state: { round: 1 },
            });
          }
          if (answer.action !== 'accept') {
            return `${answer.action}`;
          }
          return `${greeting} ${answer.content.name} (state ${JSON.stringify(ctx.state())})`;
        },
      }),
      defineMcpTool({
        name: 'deploy',
        description: 'Deploy.',
        input: z.object({ env: z.string() }),
        annotations: { destructive: true },
        access: open,
        confirm: ({ env }) => `Deploy to ${env}?`,
        handler: ({ env }) => `deployed ${env}`,
      }),
      defineMcpTool({
        name: 'twostep',
        description: 'Confirm, then ask.',
        access: open,
        confirm: () => 'Proceed?',
        handler: async (_input, ctx) => {
          const answer = await ctx.answer('detail');
          if (answer === undefined) {
            return inputRequired({
              requests: {
                detail: { mode: 'form', message: 'Detail?', schema: z.object({ d: z.string() }) },
              },
            });
          }
          return answer.action === 'accept' ? `done ${String(answer.content.d)}` : 'stopped';
        },
      }),
      defineMcpTool({
        name: 'slow',
        description: 'Report progress, then wait for cancellation or finish.',
        input: z.object({ wait: z.boolean(), tag: z.string().optional() }),
        access: open,
        handler: async ({ wait, tag }, ctx) => {
          ctx.progress(1, 3, 'one');
          ctx.progress(2, 3, 'two');
          if (wait) {
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            cancellations.get(tag ?? '')?.();
          }
          return 'finished';
        },
      }),
      defineMcpTool({
        name: 'admin_tool',
        description: 'Needs notes:write.',
        access: WRITE,
        handler: () => 'admin',
      }),
      defineMcpTool({
        name: 'secret_tool',
        description: 'Never visible.',
        access: HIDDEN,
        handler: () => 'secret',
      }),
    ],
    resources: [
      defineMcpResource({
        uri: 'notes://readme',
        name: 'readme',
        access: open,
        cache: { ttlMs: 5000, scope: 'public' },
        read: () => [{ text: 'hello' }],
      }),
    ],
  });
}

const authorize: McpAuthorize = (item, actor) => {
  if (item.access === HIDDEN) {
    return 'hidden';
  }
  const scopes = actor.scopes === '*' ? ['notes:write'] : actor.scopes;
  return scopes.includes('notes:write') ? 'allow' : { challenge: ['notes:write'] };
};

function tokens(resource: string): (request: Request) => McpAuthentication {
  const hour = () => Math.floor(Date.now() / 1000) + 3600;
  const user = (
    id: string,
    scopes: string[],
    credential: string,
    audience = resource,
    expiresAt = hour(),
  ) =>
    ({
      kind: 'authenticated',
      actor: { kind: 'user', id, scopes },
      credential: { id: credential, audience, expiresAt },
    }) as const;
  return (request) => {
    const header = request.headers.get('authorization');
    switch (header) {
      case null:
        return { kind: 'anonymous' };
      case 'Bearer reader':
        return user('alice', ['notes:read'], 'tok-1');
      case 'Bearer writer':
        return user('alice', ['notes:read', 'notes:write'], 'tok-2');
      case 'Bearer bob':
        return user('bob', ['notes:read', 'notes:write'], 'tok-3');
      case 'Bearer foreign':
        return user('alice', ['notes:read'], 'tok-4', 'https://other.example/mcp');
      case 'Bearer listed':
        return user('alice', ['notes:read'], 'tok-5', 'https://other.example/mcp');
      case 'Bearer expired':
        return user('alice', ['notes:read'], 'tok-6', resource, Math.floor(Date.now() / 1000) - 5);
      case 'Bearer boom':
        throw new Error('directory password=hunter2 unreachable');
      case 'Bearer weird':
        return {
          kind: 'authenticated',
          actor: { kind: 'developer', scopes: '*' },
          credential: { id: 'x', audience: resource },
        } as unknown as McpAuthentication;
      default:
        return { kind: 'rejected', reason: 'invalid' };
    }
  };
}

interface Served {
  readonly listener: Listener;
  readonly endpoint: McpHttpEndpoint;
  readonly errors: ReturnType<typeof errorSink>['errors'];
  close(): Promise<void>;
}

async function serve(options: Partial<McpHttpOptions> = {}): Promise<Served> {
  const sink = errorSink();
  let endpoint: McpHttpEndpoint | undefined;
  const listener = await listen(
    (request) => endpoint!.handle(request),
    '/mcp',
    (request) =>
      new URL(request.url).pathname === endpoint!.protectedResource?.path
        ? endpoint!.protectedResource.respond(request)
        : new Response(null, { status: 404 }),
  );
  endpoint = createMcpHttpEndpoint(fixtureServer(), {
    resource: listener.url,
    authenticate: tokens(listener.url),
    authorize,
    authorizationServers: ['https://auth.example.com'],
    scopesSupported: ['notes:read', 'notes:write'],
    onError: sink.onError,
    ...options,
  });
  return {
    listener,
    endpoint,
    errors: sink.errors,
    async close() {
      await endpoint.close();
      await listener.close();
    },
  };
}

/** POST through `node:http` directly, so headers fetch forbids (Host) can be forged. */
function rawPost(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end('{}');
  });
}

/** A POST whose body is produced chunk by chunk by `pull`, only when it is read. */
function streamedRequest(
  url: string,
  headers: Record<string, string>,
  pull: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
): Request {
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers,
    body: new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }),
    duplex: 'half',
  };
  return new Request(url, init);
}

function errorOf(exchange: { json: Record<string, unknown> | undefined }): {
  code: unknown;
  message: unknown;
  data: unknown;
} {
  const error = exchange.json?.error as
    { code: unknown; message: unknown; data?: unknown } | undefined;
  assert.ok(error, 'expected a JSON-RPC error');
  return { code: error.code, message: error.message, data: error.data };
}

function resultOf(exchange: {
  json: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const result = exchange.json?.result as Record<string, unknown> | undefined;
  assert.ok(result, `expected a JSON-RPC result, got ${JSON.stringify(exchange.json)}`);
  return result;
}

describe('spec vectors over node:http', () => {
  let served: Served;
  let url: string;
  before(async () => {
    served = await serve();
    url = served.listener.url;
  });
  after(() => served.close());

  it('rejects a request missing a standard header with 400 and -32020', async () => {
    const call = {
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: { region: 'x' } },
    };
    for (const omitted of ['mcp-protocol-version', 'mcp-method', 'mcp-name']) {
      const response = await fetch(url, {
        method: 'POST',
        headers: Object.fromEntries(
          Object.entries({
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'tools/call',
            'mcp-name': 'echo',
            'mcp-param-region': 'x',
          }).filter(([name]) => name !== omitted),
        ),
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...call,
          params: { ...call.params, _meta: envelope() },
        }),
      });
      assert.equal(response.status, 400, omitted);
      const body = (await response.json()) as { error: { code: number } };
      assert.equal(body.error.code, -32020, omitted);
    }
  });

  it('rejects a header that disagrees with the body with -32020', async () => {
    const mismatch = await post(
      url,
      { id: 2, method: 'tools/call', params: { name: 'echo', arguments: { region: 'x' } } },
      { 'mcp-name': 'other', 'mcp-param-region': 'x' },
    );
    assert.equal(mismatch.status, 400);
    assert.equal(errorOf(mismatch).code, -32020);
    const method = await post(
      url,
      { id: 3, method: 'tools/list' },
      { 'mcp-method': 'prompts/list' },
    );
    assert.equal(errorOf(method).code, -32020);
  });

  it('decodes the Base64 sentinel on Mcp-Param headers and sends plain ASCII as is', async () => {
    const sentinel = (value: string) =>
      `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
    for (const value of ['Hello, 世界', ' padded ', 'line1\nline2', '=?base64?SGk=?=']) {
      const exchange = await post(
        url,
        { id: 4, method: 'tools/call', params: { name: 'echo', arguments: { region: value } } },
        { 'mcp-param-region': sentinel(value) },
      );
      assert.equal(exchange.status, 200, JSON.stringify(value));
      assert.equal(textOf(resultOf(exchange)), value);
    }
    const plain = await post(
      url,
      { id: 5, method: 'tools/call', params: { name: 'echo', arguments: { region: 'us-east-1' } } },
      { 'mcp-param-region': 'us-east-1' },
    );
    assert.equal(textOf(resultOf(plain)), 'us-east-1');
    const missing = await post(url, {
      id: 6,
      method: 'tools/call',
      params: { name: 'echo', arguments: { region: 'us-east-1' } },
    });
    assert.equal(errorOf(missing).code, -32020);
    const wrong = await post(
      url,
      { id: 7, method: 'tools/call', params: { name: 'echo', arguments: { region: 'a' } } },
      { 'mcp-param-region': 'b' },
    );
    assert.equal(errorOf(wrong).code, -32020);
  });

  it('compares numeric Mcp-Param values by value', async () => {
    const exact = await post(
      url,
      { id: 8, method: 'tools/call', params: { name: 'count', arguments: { n: 42 } } },
      { 'mcp-param-count': '42' },
    );
    assert.equal(textOf(resultOf(exact)), '42');
    const other = await post(
      url,
      { id: 9, method: 'tools/call', params: { name: 'count', arguments: { n: 42 } } },
      { 'mcp-param-count': '43' },
    );
    assert.equal(errorOf(other).code, -32020);
  });

  it('answers an unknown protocol version with 400 and -32022 naming supported and requested', async () => {
    const exchange = await post(
      url,
      {
        id: 10,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } },
      },
      { 'mcp-protocol-version': '2099-01-01' },
    );
    assert.equal(exchange.status, 400);
    const error = errorOf(exchange);
    assert.equal(error.code, -32022);
    assert.deepEqual(error.data, { supported: ['2026-07-28'], requested: '2099-01-01' });
  });

  it('answers an unknown method with 404 and -32601', async () => {
    const exchange = await post(url, { id: 11, method: 'nope/nothing' });
    assert.equal(exchange.status, 404);
    assert.equal(errorOf(exchange).code, -32601);
  });

  it('acknowledges a notification with 202 and an empty body', async () => {
    const exchange = await post(url, {
      method: 'notifications/cancelled',
      params: { requestId: 99 },
    });
    assert.equal(exchange.status, 202);
    assert.equal(exchange.text, '');
  });

  it('answers GET and DELETE with 405, holds no session, and ignores Last-Event-ID', async () => {
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const response = await fetch(url, { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'POST');
    }
    const exchange = await post(
      url,
      { id: 12, method: 'tools/list' },
      { 'mcp-session-id': 'abc', 'last-event-id': '7' },
    );
    assert.equal(exchange.status, 200);
    assert.equal(exchange.headers.get('mcp-session-id'), null);
  });

  it('refuses a foreign Origin or Host with 403 without echoing it', async () => {
    for (const origin of ['https://evil.example', 'null']) {
      const exchange = await post(url, { id: 13, method: 'tools/list' }, { origin });
      assert.equal(exchange.status, 403, origin);
      assert.ok(!exchange.text.includes('evil'));
    }
    const forged = await rawPost(url, { host: 'evil.example' });
    assert.equal(forged.status, 403);
    assert.ok(!forged.body.includes('evil'));
    const allowed = await post(
      url,
      { id: 14, method: 'tools/list' },
      { origin: served.listener.origin },
    );
    assert.equal(allowed.status, 200);
  });

  it('sends no log message even to a request that asks for them', async () => {
    const response = await post(
      url,
      {
        id: 31,
        method: 'tools/call',
        params: {
          name: 'slow',
          arguments: { wait: false },
          _meta: { progressToken: 'p', 'io.modelcontextprotocol/logLevel': 'debug' },
        },
      },
      { authorization: 'Bearer writer' },
    );
    assert.equal(response.status, 200);
    assert.ok(response.text.includes('notifications/progress'));
    assert.ok(!response.text.includes('notifications/message'));
  });

  it('marks every result complete and carries cache fields on cacheable results', async () => {
    const list = resultOf(await post(url, { id: 15, method: 'tools/list' }));
    assert.equal(list.resultType, 'complete');
    assert.equal(list.cacheScope, 'private');
    assert.equal(list.ttlMs, 0);
    const read = resultOf(
      await post(url, { id: 16, method: 'resources/read', params: { uri: 'notes://readme' } }),
    );
    assert.deepEqual([read.resultType, read.ttlMs, read.cacheScope], ['complete', 5000, 'public']);
    const discover = resultOf(await post(url, { id: 17, method: 'server/discover' }));
    assert.equal(discover.resultType, 'complete');
    assert.deepEqual(discover.supportedVersions, ['2026-07-28']);
    const call = resultOf(
      await post(
        url,
        { id: 18, method: 'tools/call', params: { name: 'echo', arguments: { region: 'r' } } },
        { 'mcp-param-region': 'r' },
      ),
    );
    assert.equal(call.resultType, 'complete');
  });

  it('answers unknown tools and resources with -32602, and hidden tools exactly like unknown ones', async () => {
    const read = await post(url, {
      id: 19,
      method: 'resources/read',
      params: { uri: 'notes://none' },
    });
    assert.equal(errorOf(read).code, -32602);
    const unknown = await post(url, {
      id: 20,
      method: 'tools/call',
      params: { name: 'never_defined', arguments: {} },
    });
    const hidden = await post(
      url,
      { id: 20, method: 'tools/call', params: { name: 'secret_tool', arguments: {} } },
      { authorization: 'Bearer writer' },
    );
    assert.equal(errorOf(unknown).code, -32602);
    assert.equal(hidden.status, unknown.status);
    assert.equal(
      hidden.text.replace('secret_tool', 'X'),
      unknown.text.replace('never_defined', 'X'),
    );
  });

  it('caps the request body with 413, without waiting for a declared oversize, and refuses other media types with 415', async () => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    // A body that never yields: reading it would hang, so a 413 here was
    // decided from Content-Length alone.
    const declared = await served.endpoint.handle(
      streamedRequest(
        url,
        { ...headers, 'content-length': String(DEFAULT_MAX_REQUEST_BYTES + 1) },
        () => undefined,
      ),
    );
    assert.equal(declared.status, 413);

    const chunk = new Uint8Array(65_536).fill(0x20);
    let streamed = 0;
    const undeclared = await served.endpoint.handle(
      streamedRequest(url, headers, (controller) => {
        streamed += chunk.byteLength;
        controller.enqueue(chunk);
      }),
    );
    assert.equal(undeclared.status, 413);
    assert.ok(streamed <= DEFAULT_MAX_REQUEST_BYTES + 2 * chunk.byteLength, `read ${streamed}`);

    const text = await served.endpoint.handle(
      new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }),
    );
    assert.equal(text.status, 415);
  });

  it('serves the RFC 9728 document at the path-inserted well-known URL', async () => {
    const metadata = served.endpoint.protectedResource;
    assert.ok(metadata);
    assert.equal(metadata.path, '/.well-known/oauth-protected-resource/mcp');
    assert.equal(
      metadata.url,
      `${served.listener.origin}/.well-known/oauth-protected-resource/mcp`,
    );
    const response = await fetch(metadata.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), {
      resource: url,
      authorization_servers: ['https://auth.example.com/'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['notes:read', 'notes:write'],
    });
    assert.equal((await fetch(metadata.url, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(metadata.url, { method: 'OPTIONS' })).status, 204);
    const refused = await fetch(metadata.url, { method: 'POST' });
    assert.equal(refused.status, 405);
    assert.equal(refused.headers.get('allow'), 'GET, HEAD, OPTIONS');
  });
});

describe('authentication and challenges', () => {
  let served: Served;
  let url: string;
  let metadataUrl: string;
  before(async () => {
    served = await serve();
    url = served.listener.url;
    metadataUrl = served.endpoint.protectedResource!.url;
  });
  after(() => served.close());

  const list = (headers: Record<string, string>) =>
    post(url, { id: 1, method: 'tools/list' }, headers);

  it('answers a rejected token with 401 invalid_token naming the metadata document', async () => {
    const exchange = await list({ authorization: 'Bearer nonsense' });
    assert.equal(exchange.status, 401);
    const challenge = exchange.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /^Bearer error="invalid_token"/);
    assert.ok(challenge.includes(`resource_metadata="${metadataUrl}"`));
  });

  it('answers a token for another resource, or an expired one, with 401', async () => {
    for (const token of ['foreign', 'listed', 'expired']) {
      const exchange = await list({ authorization: `Bearer ${token}` });
      assert.equal(exchange.status, 401, token);
      assert.match(exchange.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
    }
  });

  it('lists challenged items and answers a credential without the scope with 403 insufficient_scope', async () => {
    const client = await connect(url, 'modern', { token: 'reader' });
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'admin_tool'));
    await client.close();
    const exchange = await post(
      url,
      { id: 2, method: 'tools/call', params: { name: 'admin_tool', arguments: {} } },
      { authorization: 'Bearer reader' },
    );
    assert.equal(exchange.status, 403);
    const challenge = exchange.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /error="insufficient_scope"/);
    assert.ok(challenge.includes('scope="notes:write"'));
    assert.ok(challenge.includes(`resource_metadata="${metadataUrl}"`));
    const allowed = await post(
      url,
      { id: 3, method: 'tools/call', params: { name: 'admin_tool', arguments: {} } },
      { authorization: 'Bearer writer' },
    );
    assert.equal(textOf(resultOf(allowed)), 'admin');
  });

  it('answers an anonymous caller of a challenged item with 401 and the scopes, without an error code', async () => {
    const exchange = await post(url, {
      id: 4,
      method: 'tools/call',
      params: { name: 'admin_tool', arguments: {} },
    });
    assert.equal(exchange.status, 401);
    assert.equal(
      exchange.headers.get('www-authenticate'),
      `Bearer resource_metadata="${metadataUrl}", scope="notes:write"`,
    );
  });

  it('reports a throwing or malformed authenticator and answers 500 without detail', async () => {
    const before = served.errors.length;
    const thrown = await list({ authorization: 'Bearer boom' });
    const malformed = await list({ authorization: 'Bearer weird' });
    assert.deepEqual([thrown.status, malformed.status], [500, 500]);
    assert.ok(!thrown.text.includes('hunter2'));
    assert.deepEqual(
      served.errors.slice(before).map((error) => error.code),
      ['authentication_failed', 'invalid_authentication'],
    );
  });

  it('requires a credential, and the required scopes, when requiredScopes is set', async () => {
    const strict = await serve({ requiredScopes: ['notes:read', 'notes:write'] });
    const anonymous = await post(strict.listener.url, { id: 5, method: 'tools/list' });
    assert.equal(anonymous.status, 401);
    const challenge = anonymous.headers.get('www-authenticate') ?? '';
    assert.ok(!challenge.includes('error='));
    assert.ok(challenge.includes('scope="notes:read notes:write"'));
    const reader = await post(
      strict.listener.url,
      { id: 6, method: 'tools/list' },
      { authorization: 'Bearer reader' },
    );
    assert.equal(reader.status, 403);
    assert.match(
      reader.headers.get('www-authenticate') ?? '',
      /error="insufficient_scope".*scope="notes:read notes:write"/,
    );
    const writer = await post(
      strict.listener.url,
      { id: 7, method: 'tools/list' },
      { authorization: 'Bearer writer' },
    );
    assert.equal(writer.status, 200);
    await strict.close();
  });

  it('omits resource_metadata when no authorization server is configured', async () => {
    const bare = await serve({ authorizationServers: undefined });
    assert.equal(bare.endpoint.protectedResource, undefined);
    const exchange = await post(
      bare.listener.url,
      { id: 8, method: 'tools/list' },
      { authorization: 'Bearer nonsense' },
    );
    assert.equal(exchange.status, 401);
    assert.ok(!(exchange.headers.get('www-authenticate') ?? '').includes('resource_metadata'));
    await bare.close();
  });

  it('answers 503 after close', async () => {
    const closing = await serve();
    await closing.endpoint.close();
    const response = await closing.endpoint.handle(
      new Request(closing.listener.url, { method: 'POST' }),
    );
    assert.equal(response.status, 503);
    await closing.listener.close();
  });
});

describe('createMcpHttpEndpoint options', () => {
  it('rejects malformed options', () => {
    const server = defineMcpServer({ name: 's', version: '1' });
    const base = {
      resource: 'https://mcp.example.com/mcp',
      authenticate: () => ({ kind: 'anonymous' }) as const,
    };
    const cases: Record<string, unknown>[] = [
      { resource: 'ftp://mcp.example.com/mcp' },
      { resource: 'http://mcp.example.com/mcp' },
      { resource: 'https://mcp.example.com/mcp#frag' },
      { resource: 'https://user:pw@mcp.example.com/mcp' },
      { authenticate: undefined },
      { authorizationServers: [] },
      { authorizationServers: ['http://auth.example.com'] },
      { authorizationServers: ['https://auth.example.com/?tenant=1'] },
      { scopesSupported: ['a b'] },
      { scopesSupported: ['a'], requiredScopes: ['b'] },
      { allowedHosts: ['evil.example:80'] },
      { allowedOrigins: [] },
      { legacy: 'sometimes' },
      { maxRequestBytes: 0 },
      { requestStateKey: new Uint8Array(8) },
      { requestStateTtlSeconds: 0 },
    ];
    for (const overrides of cases) {
      assert.throws(
        () => createMcpHttpEndpoint(server, { ...base, ...overrides }),
        (error: unknown) => error instanceof McpDefinitionError && error.code === 'invalid_option',
        JSON.stringify(overrides, (_key, value: unknown) =>
          value instanceof Uint8Array ? 'bytes' : value,
        ),
      );
    }
    const endpoint = createMcpHttpEndpoint(server, {
      ...base,
      resource: 'http://localhost:3000/mcp',
      authorizationServers: ['http://localhost:9000'],
    });
    assert.equal(endpoint.resource, 'http://localhost:3000/mcp');
  });
});

describe('the official client', () => {
  let served: Served;
  let url: string;
  before(async () => {
    served = await serve();
    url = served.listener.url;
  });
  after(() => served.close());

  for (const mode of CLIENT_MODES) {
    it(`lists, calls with header parameters, and reads in ${mode} mode`, async () => {
      const client = await connect(url, mode, { token: 'writer' });
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.deepEqual(names, ['admin_tool', 'ask', 'count', 'deploy', 'echo', 'slow', 'twostep']);
      assert.equal(
        textOf(await client.callTool({ name: 'echo', arguments: { region: 'Hello, 世界' } })),
        'Hello, 世界',
      );
      const read = await client.readResource({ uri: 'notes://readme' });
      assert.deepEqual(read.contents, [{ uri: 'notes://readme', text: 'hello' }]);
      const failure = await rejection(client.readResource({ uri: 'notes://none' }));
      assert.equal(failure.code, -32602);
      assert.equal(
        client.getNegotiatedProtocolVersion(),
        mode === 'legacy' ? '2025-11-25' : '2026-07-28',
      );
      await client.close();
    });
  }

  for (const mode of CLIENT_MODES) {
    it(`advertises no logging and sends no log messages in ${mode} mode`, async () => {
      const client = await connect(url, mode, { token: 'writer' });
      const logged: unknown[] = [];
      client.setNotificationHandler('notifications/message', (notification) => {
        logged.push(notification);
      });
      assert.equal(client.getServerCapabilities()?.logging, undefined);
      // A 2025 server answers the unknown method; on 2026-07-28 the method does not exist at all.
      const refused = await rejection(client.setLoggingLevel('debug'));
      if (client.getNegotiatedProtocolVersion() === '2025-11-25') {
        assert.equal(refused.code, -32601);
      }
      const finished = await client.callTool(
        { name: 'slow', arguments: { wait: false } },
        { onprogress: () => undefined },
      );
      assert.equal(textOf(finished), 'finished');
      assert.deepEqual(logged, []);
      await client.close();
    });
  }

  type Elicited =
    | { action: 'accept'; content: Record<string, string | number | boolean> }
    | { action: 'decline' | 'cancel' };

  function elicitingClient(
    mode: 'modern' | 'legacy',
    answer: (params: { message: string }) => Elicited,
    asked: string[] = [],
  ): Promise<Client> {
    return connect(url, mode, {
      token: 'writer',
      capabilities: { capabilities: { elicitation: { form: {} } } },
    }).then((client) => {
      client.setRequestHandler('elicitation/create', (request) => {
        const params = request.params as { message: string };
        asked.push(params.message);
        return answer(params);
      });
      return client;
    });
  }

  it('runs the multi-round-trip flow: answers, then the sealed state, in the next round', async () => {
    const client = await elicitingClient('modern', () => ({
      action: 'accept',
      content: { name: 'Ada' },
    }));
    const result = await client.callTool({ name: 'ask', arguments: { greeting: 'Hello' } });
    assert.equal(textOf(result), 'Hello Ada (state {"round":1})');
    await client.close();
    const declining = await elicitingClient('modern', () => ({ action: 'decline' }));
    assert.equal(
      textOf(await declining.callTool({ name: 'ask', arguments: { greeting: 'Hi' } })),
      'decline',
    );
    await declining.close();
  });

  it('confirms before running, refuses a declined confirmation, and asks only once across rounds', async () => {
    const asked: string[] = [];
    const accepting = await elicitingClient(
      'modern',
      (params): Elicited =>
        params.message === 'Detail?'
          ? { action: 'accept', content: { d: 'x' } }
          : { action: 'accept', content: { confirm: true } },
      asked,
    );
    assert.equal(
      textOf(await accepting.callTool({ name: 'deploy', arguments: { env: 'prod' } })),
      'deployed prod',
    );
    assert.deepEqual(asked, ['Deploy to prod?']);
    asked.length = 0;
    assert.equal(textOf(await accepting.callTool({ name: 'twostep', arguments: {} })), 'done x');
    assert.deepEqual(asked, ['Proceed?', 'Detail?']);
    await accepting.close();
    const refusing = await elicitingClient('modern', () => ({
      action: 'accept',
      content: { confirm: false },
    }));
    const refused = await refusing.callTool({ name: 'deploy', arguments: { env: 'prod' } });
    assert.equal(refused.isError, true);
    assert.equal((refused.structuredContent as { code: string }).code, 'not_confirmed');
    await refusing.close();
    const unable = await connect(url, 'modern', { token: 'writer' });
    const unavailable = await unable.callTool({ name: 'deploy', arguments: { env: 'prod' } });
    assert.equal(
      (unavailable.structuredContent as { code: string }).code,
      'confirmation_unavailable',
    );
    await unable.close();
  });

  it('fails input requests cleanly on stateless legacy HTTP', async () => {
    const client = await elicitingClient('legacy', () => ({
      action: 'accept',
      content: { name: 'Ada' },
    }));
    const asked = await client.callTool({ name: 'ask', arguments: { greeting: 'Hello' } });
    assert.equal(asked.isError, true);
    assert.equal((asked.structuredContent as { code: string }).code, 'input_unavailable');
    const confirm = await client.callTool({ name: 'deploy', arguments: { env: 'prod' } });
    assert.equal((confirm.structuredContent as { code: string }).code, 'confirmation_unavailable');
    await client.close();
  });

  it('refuses tampered, replayed, foreign, and re-targeted request state with the frozen -32602', async () => {
    const capabilities = { elicitation: { form: {} } };
    const first = await post(
      url,
      {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ask',
          arguments: { greeting: 'Hi' },
          _meta: { 'io.modelcontextprotocol/clientCapabilities': capabilities },
        },
      },
      { authorization: 'Bearer writer' },
    );
    const asked = resultOf(first);
    assert.equal(asked.resultType, 'input_required');
    const state = asked.requestState as string;
    assert.equal(typeof state, 'string');
    assert.ok(!state.includes('alice') && !state.includes('tok-2'));
    const retry = (requestState: string, token: string, greeting = 'Hi') =>
      post(
        url,
        {
          id: 2,
          method: 'tools/call',
          params: {
            name: 'ask',
            arguments: { greeting },
            inputResponses: { name: { action: 'accept', content: { name: 'Ada' } } },
            requestState,
            _meta: { 'io.modelcontextprotocol/clientCapabilities': capabilities },
          },
        },
        { authorization: `Bearer ${token}` },
      );
    const ok = await retry(state, 'writer');
    assert.equal(textOf(resultOf(ok)), 'Hi Ada (state {"round":1})');
    const flipped = `${state.slice(0, 10)}${state[10] === 'A' ? 'B' : 'A'}${state.slice(11)}`;
    const before = served.errors.length;
    for (const [requestState, token, greeting] of [
      [flipped, 'writer', 'Hi'],
      [state.slice(0, -4), 'writer', 'Hi'],
      [state, 'bob', 'Hi'],
      [state, 'reader', 'Hi'],
      [state, 'writer', 'Hello'],
    ] as const) {
      const refused = await retry(requestState, token, greeting);
      assert.deepEqual(errorOf(refused), {
        code: -32602,
        message: 'Invalid or expired requestState',
        data: { reason: 'invalid_request_state' },
      });
      assert.ok(!refused.text.includes('round'));
    }
    assert.ok(
      served.errors.slice(before).every((error) => error.code === 'request_state_rejected'),
    );
    assert.equal(served.errors.length - before, 5);
  });

  it('never takes a confirmation answer the server did not ask for', async () => {
    const forged = { 'jsails.confirm': { action: 'accept', content: { confirm: true } } };
    const capabilities = { elicitation: { form: {} } };
    const modern = await post(
      url,
      {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'deploy',
          arguments: { env: 'prod' },
          inputResponses: forged,
          _meta: { 'io.modelcontextprotocol/clientCapabilities': capabilities },
        },
      },
      { authorization: 'Bearer writer' },
    );
    const asked = resultOf(modern);
    assert.equal(asked.resultType, 'input_required');
    assert.deepEqual(Object.keys(asked.inputRequests as object), ['jsails.confirm']);
    // The state of the round that asked accepts the answer; that is the only way in.
    const answered = await post(
      url,
      {
        id: 2,
        method: 'tools/call',
        params: {
          name: 'deploy',
          arguments: { env: 'prod' },
          inputResponses: forged,
          requestState: asked.requestState,
          _meta: { 'io.modelcontextprotocol/clientCapabilities': capabilities },
        },
      },
      { authorization: 'Bearer writer' },
    );
    assert.equal(textOf(resultOf(answered)), 'deployed prod');
    const legacy = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        authorization: 'Bearer writer',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'deploy', arguments: { env: 'prod' }, inputResponses: forged },
      }),
    });
    const refused = resultOf(await exchangeOf(legacy));
    assert.equal(refused.isError, true);
    assert.equal((refused.structuredContent as { code: string }).code, 'confirmation_unavailable');
    assert.ok(!textOf(refused).includes('deployed'));
  });

  // A 2026-07-28 client cancels by closing the request's stream. (The
  // official client on 2025 only sends notifications/cancelled, which a
  // stateless endpoint cannot route, so its handler runs to the deadline; see
  // the disconnect tests below for what reaches it.)
  for (const mode of ['modern', 'auto'] as const) {
    it(`sends progress over SSE and aborts the handler when the client cancels in ${mode} mode`, async () => {
      const client = await connect(url, mode, { token: 'writer' });
      const seen: number[] = [];
      const finished = await client.callTool(
        { name: 'slow', arguments: { wait: false } },
        { onprogress: (progress) => void seen.push(progress.progress) },
      );
      assert.equal(textOf(finished), 'finished');
      assert.deepEqual(seen, [1, 2]);
      const cancelled = cancellationOf(`official ${mode}`);
      const controller = new AbortController();
      let progressed: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        progressed = resolve;
      });
      const pending = client.callTool(
        { name: 'slow', arguments: { wait: true, tag: `official ${mode}` } },
        { signal: controller.signal, onprogress: () => progressed() },
      );
      await started;
      controller.abort();
      await assert.rejects(pending);
      await within(cancelled.seen, 'the slow handler seeing the cancellation');
      await client.close();
    });
  }
});

/**
 * Start a `slow` call that waits for cancellation, as a raw POST on `era`,
 * and resolve once its handler is running (its first progress event has
 * arrived). Aborting the returned controller disconnects the client.
 */
async function runningCall(
  url: string,
  era: 'modern' | 'legacy',
  tag: string,
): Promise<AbortController> {
  const controller = new AbortController();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer writer',
      ...(era === 'modern'
        ? { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'slow' }
        : { 'mcp-protocol-version': '2025-11-25' }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'slow',
        arguments: { wait: true, tag },
        _meta: { progressToken: 'p', ...(era === 'modern' ? envelope() : {}) },
      },
    }),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  while (!text.includes('notifications/progress')) {
    const { value, done } = await reader.read();
    assert.ok(!done, `the stream ended before any progress: ${text}`);
    text += value;
  }
  return controller;
}

/**
 * One upload of `size` declared bytes over a raw socket that stays half-open:
 * it sends the headers and a first chunk, and only once the response head
 * arrives sends the rest, as a client still uploading does. A server that
 * closes the socket with the body unread resets the connection; on Windows
 * that reset also discards the response the client had not read yet.
 */
function lateUpload(origin: string, size: number): Promise<{ head: string }> {
  const target = new URL(origin);
  const first = 65_536;
  return new Promise((resolve) => {
    const socket = new Socket({ allowHalfOpen: true });
    let received = '';
    let rest = false;
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (!rest && received.includes('\r\n\r\n')) {
        rest = true;
        socket.end(Buffer.alloc(size - first, 0x20));
      }
    });
    // A reset after the response is allowed; the close below still settles.
    socket.on('error', () => {});
    socket.on('close', () => {
      resolve({ head: received.split('\r\n')[0] ?? '' });
    });
    socket.connect(Number(target.port), target.hostname, () => {
      socket.write(
        `POST /mcp HTTP/1.1\r\nhost: ${target.host}\r\ncontent-type: application/json\r\n` +
          `accept: application/json, text/event-stream\r\ncontent-length: ${size}\r\n\r\n`,
      );
      socket.write(Buffer.alloc(first, 0x20));
    });
  });
}

describe("over the framework's HTTP server", () => {
  let server: Server;
  let endpoint: McpHttpEndpoint;
  let origin: string;
  before(async () => {
    // `createHttpServer` adapts only the app's `fetch`, which is how the
    // endpoint is mounted in an application.
    server = createHttpServer({
      fetch: (request: Request) => endpoint.handle(request),
    } as unknown as Parameters<typeof createHttpServer>[0]);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    endpoint = createMcpHttpEndpoint(fixtureServer(), {
      resource: `${origin}/mcp`,
      authenticate: tokens(`${origin}/mcp`),
      authorize,
      onError: errorSink().onError,
    });
  });
  after(async () => {
    await endpoint.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Closing the request's stream is the 2026-07-28 cancellation. A stateless
  // 2025 request has no session, and its id names no request across clients,
  // so the disconnect is the only cancellation that can reach its handler.
  // These run before the 413 tests, whose half-read uploads leave the pooled
  // connection to be closed by the server.
  for (const era of ['modern', 'legacy'] as const) {
    it(`aborts the handler when the client disconnects on the ${era} era`, async () => {
      const cancelled = cancellationOf(`disconnect ${era}`);
      const call = await runningCall(`${origin}/mcp`, era, `disconnect ${era}`);
      call.abort();
      await within(cancelled.seen, 'the slow handler seeing the disconnect');
    });
  }

  it('acknowledges a 2025 notifications/cancelled without routing it to another request', async () => {
    const cancelled = cancellationOf('unrouted');
    const call = await runningCall(`${origin}/mcp`, 'legacy', 'unrouted');
    const notice = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer writer',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 1 },
      }),
    });
    assert.equal(notice.status, 202);
    await notice.body?.cancel();
    // A routed cancellation would have aborted the handler before the 202.
    assert.equal(cancelled.done(), false);
    call.abort();
    await within(cancelled.seen, 'the slow handler seeing the disconnect');
  });

  it('answers an oversized upload with a 413 the client reads, and 415 for another media type', async () => {
    const huge = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: `{"pad":"${'x'.repeat(1_100_000)}"}`,
    });
    assert.equal(huge.status, 413);
    await huge.body?.cancel();
    const text = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(text.status, 415);
    await text.body?.cancel();
  });

  it('delivers the 413 to a client that keeps uploading after it', async () => {
    const answered = await lateUpload(origin, 1_100_000);
    // Only the response is asserted. The adapter reads the unread body for at
    // most 500 ms before it closes, and whether the upload finishes first is a
    // race on every platform: when it does not, the close resets the
    // connection after the 413 was delivered, which HTTP allows (RFC 9112,
    // section 9.6).
    assert.equal(answered.head, 'HTTP/1.1 413 Payload Too Large');
  });
});
