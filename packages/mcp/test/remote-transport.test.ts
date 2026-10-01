/**
 * The client transport layer on its own: transport descriptions are checked
 * and copied; the guarded `fetch` merges the caller's headers, asks a headers
 * provider per request, cuts off a JSON body past the limit (telling which
 * request it answered), reports an SSE answer as streamed, counts an SSE
 * body per event (however many data lines it spans, with any line ending),
 * and leaves error and redirect responses alone; the connect-time reply recorder sees every handler the
 * SDK swaps in and puts the plain one back; the message guard replaces an oversized result,
 * drops an oversized notification, refuses an oversized server request, and
 * recognizes only the errors it made itself; reconnection waits are clamped,
 * and a call whose response stream the server closes mid-call is resumed on
 * a GET carrying Last-Event-ID; cancelling a 2025 call against a stateless
 * server, by its signal or its deadline, sends `notifications/cancelled` and
 * closes the call's exchange at once, whether that is the POST's stream, the
 * GET resuming it, or a POST not yet answered, without resuming it again.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';

import { McpClientError } from '../src/errors.js';
import {
  BodyLimitError,
  checkTransport,
  ConnectReplies,
  CredentialsError,
  guardedFetch,
  type ExchangeEvents,
  MessageGuard,
  scheduleReconnection,
} from '../src/remote-transport.js';
import { connectMcp } from '../src/remote-client.js';
import { within } from './fixtures.js';
import { listen } from './http-harness.js';
import { IN_PROCESS_CONCURRENCY } from './spawn-concurrency.js';

const URL_OK = 'https://mcp.example.com/mcp';

function body(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.subarray(offset, offset + 7));
      }
      controller.close();
    },
  });
}

function respond(text: string, init: ResponseInit & { type?: string } = {}) {
  return (_url: string | URL, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(body(text), {
        status: init.status ?? 200,
        headers: { 'content-type': init.type ?? 'application/json' },
      }),
    );
}

/** Exchange events, recorded as `streamed 42` and `overflowed 42`. */
function recorder(): { readonly events: ExchangeEvents; readonly heard: string[] } {
  const heard: string[] = [];
  return {
    heard,
    events: {
      streamed: (id) => void heard.push(`streamed ${id}`),
      overflowed: (id) => void heard.push(`overflowed ${id}`),
    },
  };
}

const IGNORED = recorder().events;

const POST: RequestInit = {
  method: 'POST',
  body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call' }),
};

describe('checkTransport', () => {
  it('copies and freezes an http description, normalizing the URL', () => {
    const provider = () => ({ authorization: 'Bearer x' });
    const checked = checkTransport({
      kind: 'http',
      url: 'HTTPS://MCP.example.com/mcp',
      headers: provider,
    });
    assert.deepEqual(
      { ...checked, headers: undefined },
      { kind: 'http', url: 'https://mcp.example.com/mcp', headers: undefined },
    );
    assert.ok(checked.kind === 'http' && checked.headers === provider);
    assert.ok(Object.isFrozen(checked));
    for (const url of ['http://localhost:3000/mcp', 'http://127.0.0.2/mcp', 'http://[::1]:8/mcp']) {
      assert.equal(checkTransport({ kind: 'http', url }).kind, 'http');
    }
  });

  it('copies a stdio description with defaults', () => {
    const args = ['server.js'];
    const checked = checkTransport({ kind: 'stdio', command: 'node', args, env: { TOKEN: 'x' } });
    assert.deepEqual(checked, {
      kind: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'x' },
      stderr: 'inherit',
    });
    args.push('--evil');
    assert.ok(checked.kind === 'stdio' && checked.args?.length === 1);
  });

  it('refuses with invalid_option', () => {
    for (const value of [
      null,
      { kind: 'http', url: 'http://10.0.0.1/mcp' },
      { kind: 'stdio', command: 'a\0b' },
    ]) {
      assert.throws(
        () => checkTransport(value),
        (error) => error instanceof McpClientError && error.code === 'invalid_option',
      );
    }
  });
});

describe('guardedFetch', () => {
  it('merges headers and asks the provider before every request', async () => {
    const seen: (string | null)[] = [];
    let count = 0;
    const fetchLike = guardedFetch(
      {
        kind: 'http',
        url: URL_OK,
        headers: () => ({ authorization: `Bearer t${(count += 1)}` }),
        fetch: (_url, init) => {
          const headers = new Headers(init?.headers);
          seen.push(headers.get('authorization'), headers.get('mcp-method'));
          return Promise.resolve(new Response('{}', { status: 200 }));
        },
      },
      1_000,
      IGNORED,
    );
    await fetchLike(URL_OK, { ...POST, headers: { 'mcp-method': 'tools/call' } });
    await fetchLike(URL_OK, POST);
    assert.deepEqual(seen, ['Bearer t1', 'tools/call', 'Bearer t2', null]);
  });

  it('wraps a provider failure or a refused header in CredentialsError', async () => {
    for (const headers of [
      () => {
        throw new Error('secret');
      },
      () => ({ host: 'evil' }),
      () => ({ 'mcp-param-region': 'x' }),
    ]) {
      const fetchLike = guardedFetch(
        { kind: 'http', url: URL_OK, headers, fetch: respond('{}') },
        1_000,
        IGNORED,
      );
      await assert.rejects(fetchLike(URL_OK, POST), CredentialsError);
    }
  });

  it('cuts off a JSON body past the limit and names the request it answered', async () => {
    const { events, heard } = recorder();
    const fetchLike = guardedFetch(
      { kind: 'http', url: URL_OK, fetch: respond('x'.repeat(200)) },
      100,
      events,
    );
    const response = await fetchLike(URL_OK, POST);
    await assert.rejects(response.text(), BodyLimitError);
    assert.deepEqual(heard, ['overflowed 42']);
    const small = await guardedFetch(
      { kind: 'http', url: URL_OK, fetch: respond('x'.repeat(100)) },
      100,
      IGNORED,
    )(URL_OK, POST);
    assert.equal((await small.text()).length, 100);
  });

  it('reports an SSE answer as streamed and counts its body per event, whatever its line endings', async () => {
    for (const end of ['\n', '\r\n', '\r']) {
      const stream = Array.from(
        { length: 50 },
        () => `data: ${'y'.repeat(30)}${end}data: ${'y'.repeat(30)}${end}${end}`,
      ).join('');
      const { events, heard } = recorder();
      const many = await guardedFetch(
        { kind: 'http', url: URL_OK, fetch: respond(stream, { type: 'text/event-stream' }) },
        100,
        events,
      )(URL_OK, POST);
      assert.equal(await many.text(), stream);
      assert.deepEqual(heard, ['streamed 42']);
    }
    for (const end of ['\n', '\r\n', '\r']) {
      // One event split into many short data lines: every line fits, the event does not.
      const split = `${Array.from({ length: 200 }, () => `data: ${'s'.repeat(10)}${end}`).join('')}${end}`;
      const { events, heard } = recorder();
      const cut = await guardedFetch(
        { kind: 'http', url: URL_OK, fetch: respond(split, { type: 'text/event-stream' }) },
        100,
        events,
      )(URL_OK, POST);
      await assert.rejects(cut.text(), BodyLimitError);
      assert.deepEqual(heard, ['streamed 42', 'overflowed 42']);
    }
    const { events, heard } = recorder();
    const long = await guardedFetch(
      {
        kind: 'http',
        url: URL_OK,
        fetch: respond(`data: short\n\ndata: ${'z'.repeat(300)}\n\n`, {
          type: 'text/event-stream',
        }),
      },
      100,
      events,
    )(URL_OK, POST);
    await assert.rejects(long.text(), BodyLimitError);
    assert.deepEqual(heard, ['streamed 42', 'overflowed 42']);
  });

  it('bounds error bodies without failing a request, and passes redirects through', async () => {
    const { events, heard } = recorder();
    const failing = await guardedFetch(
      { kind: 'http', url: URL_OK, fetch: respond('e'.repeat(500), { status: 500 }) },
      100,
      events,
    )(URL_OK, POST);
    await assert.rejects(failing.text(), BodyLimitError);
    assert.deepEqual(heard, []);
    const redirect = new Response('moved', { status: 307, headers: { location: '/elsewhere' } });
    const passed = await guardedFetch(
      { kind: 'http', url: URL_OK, fetch: () => Promise.resolve(redirect) },
      1,
      IGNORED,
    )(URL_OK, POST);
    assert.equal(passed, redirect);
  });
});

/** A transport stub whose handler records what reaches it. */
function stubTransport(): {
  readonly transport: Transport;
  readonly delivered: JSONRPCMessage[];
  readonly sent: JSONRPCMessage[];
} {
  const delivered: JSONRPCMessage[] = [];
  const sent: JSONRPCMessage[] = [];
  const transport: Transport = {
    start: () => Promise.resolve(),
    close: () => Promise.resolve(),
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
    onmessage: (message) => {
      delivered.push(message);
    },
  };
  return { transport, delivered, sent };
}

describe('MessageGuard', () => {
  it('passes small messages and replaces an oversized result with its own error', () => {
    const guard = new MessageGuard(50);
    const { transport, delivered } = stubTransport();
    guard.install(transport);
    const small: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: { ok: true } };
    transport.onmessage?.(small);
    transport.onmessage?.({ jsonrpc: '2.0', id: 2, result: { text: 'x'.repeat(100) } });
    assert.equal(delivered[0], small);
    const replaced = delivered[1] as { id: number; error: { code: number; data: unknown } };
    assert.equal(replaced.id, 2);
    assert.equal(replaced.error.code, -32603);
    assert.ok(guard.isTooLarge(replaced.error.data));
  });

  it('drops an oversized notification and refuses an oversized server request', () => {
    const guard = new MessageGuard(50);
    const { transport, delivered, sent } = stubTransport();
    guard.install(transport);
    transport.onmessage?.({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { message: 'm'.repeat(100) },
    });
    transport.onmessage?.({
      jsonrpc: '2.0',
      id: 'srv-1',
      method: 'elicitation/create',
      params: { message: 'm'.repeat(100) },
    });
    assert.deepEqual(delivered, []);
    assert.deepEqual(sent, [
      { jsonrpc: '2.0', id: 'srv-1', error: { code: -32600, message: 'Request too large' } },
    ]);
  });

  it('fails a request on overflow and recognizes only its own marker', () => {
    const guard = new MessageGuard(50);
    const other = new MessageGuard(50);
    const { transport, delivered } = stubTransport();
    guard.install(transport);
    guard.overflow(7);
    const made = delivered[0] as { id: number; error: { data: unknown } };
    assert.equal(made.id, 7);
    assert.ok(guard.isTooLarge(made.error.data));
    assert.ok(!other.isTooLarge(made.error.data));
    assert.ok(!guard.isTooLarge({ 'io.jsails.mcp/client': 'guess' }));
    assert.ok(!guard.isTooLarge(undefined));
  });
});

describe('scheduleReconnection', () => {
  it('clamps the wait to between 250 ms and 30 s, and cancels', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const fired: number[] = [];
      for (const [delay, label] of [
        [0, 1],
        [500, 2],
        [3_600_000, 3],
        [Number.NaN, 4],
      ] as const) {
        scheduleReconnection(() => fired.push(label), delay);
      }
      const cancelled = scheduleReconnection(() => fired.push(5), 400);
      cancelled();
      mock.timers.tick(249);
      assert.deepEqual(fired, []);
      mock.timers.tick(1);
      assert.deepEqual(fired, [1]);
      mock.timers.tick(250);
      assert.deepEqual(fired, [1, 2]);
      mock.timers.tick(30_000);
      assert.deepEqual(fired, [1, 2, 3, 4]);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('stream resumption', () => {
  it('resumes a call whose response stream closes mid-call, after the clamped retry', async () => {
    let pending: number | string | undefined;
    let closedAt = 0;
    const resumed: { lastEventId: string | null; after: number }[] = [];
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const sse = (text: string): Response =>
      new Response(text, { headers: { 'content-type': 'text/event-stream' } });
    const listener = await listen(async (request) => {
      if (request.method === 'GET') {
        if (pending === undefined) {
          return new Response(null, { status: 405 });
        }
        resumed.push({
          lastEventId: request.headers.get('last-event-id'),
          after: performance.now() - closedAt,
        });
        const answer = {
          jsonrpc: '2.0',
          id: pending,
          result: { content: [{ type: 'text', text: 'resumed' }] },
        };
        pending = undefined;
        return sse(`event: message\nid: e2\ndata: ${JSON.stringify(answer)}\n\n`);
      }
      const message = (await request.json()) as { id?: number | string; method: string };
      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }
      if (message.method === 'initialize') {
        return json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'polling', version: '1.0.0' },
          },
        });
      }
      if (message.method === 'tools/list') {
        return json({
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: [{ name: 'poll', inputSchema: { type: 'object' } }] },
        });
      }
      // A priming event with an id and a zero retry, then the stream ends unanswered.
      pending = message.id;
      closedAt = performance.now();
      return sse('id: e1\nretry: 0\ndata: \n\n');
    });
    try {
      const remote = await connectMcp({
        transport: { kind: 'http', url: listener.url },
        protocol: 'legacy',
        timeoutMs: 5_000,
      });
      try {
        await remote.listTools();
        const outcome = await remote.callTool('poll', {});
        assert.equal(outcome.status, 'ok');
        assert.deepEqual(outcome.status === 'ok' ? outcome.content : [], [
          { type: 'text', text: 'resumed' },
        ]);
        assert.equal(resumed.length, 1);
        assert.equal(resumed[0]?.lastEventId, 'e1');
        assert.ok((resumed[0]?.after ?? 0) >= 240, `resumed after ${resumed[0]?.after} ms`);
      } finally {
        await remote.close();
      }
    } finally {
      await listener.close();
    }
  });
});

/**
 * Where a stateless 2025 server holds its never-answered `wait` call: on the
 * POST's event stream (`stream`); on the GET resuming it, after the POST's
 * stream ends with a priming event (`resumed`); or before any response at all,
 * as a server answering with JSON does while the call runs (`unanswered`).
 */
type Held = 'stream' | 'resumed' | 'unanswered';

const HELD: Readonly<Record<Held, string>> = {
  stream: 'its POST stream',
  resumed: 'the GET resuming its stream',
  unanswered: 'its unanswered POST',
};

/** A stateless 2025 server that holds its `wait` call where `held` says until the client closes it. */
async function waitingServer(held: Held) {
  const cancelled: unknown[] = [];
  const resumed: (string | null)[] = [];
  let opened: () => void = () => undefined;
  let closed: () => void = () => undefined;
  let notified: () => void = () => undefined;
  const streamOpened = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const streamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const cancellation = new Promise<void>((resolve) => {
    notified = resolve;
  });
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const sse = (body: BodyInit): Response =>
    new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  const hold = (request: Request): Response => {
    opened();
    return sse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': waiting\n\n'));
          request.signal.addEventListener(
            'abort',
            () => {
              closed();
              controller.close();
            },
            { once: true },
          );
        },
      }),
    );
  };
  let calls = 0;
  const listener = await listen(async (request) => {
    if (request.method === 'GET') {
      const lastEventId = request.headers.get('last-event-id');
      if (lastEventId === null) {
        return new Response(null, { status: 405 });
      }
      resumed.push(lastEventId);
      return hold(request);
    }
    const message = (await request.json()) as {
      id?: number | string;
      method: string;
      params?: Record<string, unknown>;
    };
    if (message.id === undefined) {
      if (message.method === 'notifications/cancelled') {
        cancelled.push(message.params?.requestId);
        notified();
      }
      return new Response(null, { status: 202 });
    }
    if (message.method === 'initialize') {
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'waiting', version: '1.0.0' },
        },
      });
    }
    if (message.method === 'tools/list') {
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'wait', inputSchema: { type: 'object' } },
            { name: 'echo', inputSchema: { type: 'object' } },
          ],
        },
      });
    }
    if (message.params?.name === 'echo') {
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'echo' }] },
      });
    }
    calls += 1;
    if (held === 'resumed') {
      return sse('id: e1\nretry: 0\ndata: \n\n');
    }
    if (held === 'stream') {
      return hold(request);
    }
    opened();
    await new Promise<void>((resolve) => {
      request.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    closed();
    return new Response(null, { status: 204 });
  });
  return {
    listener,
    cancelled,
    resumed,
    streamOpened,
    streamClosed,
    cancellation,
    calls: () => calls,
  };
}

// Each test scripts its own server.
describe('cancelling a 2025 call over HTTP', { concurrency: IN_PROCESS_CONCURRENCY }, () => {
  const cases = (['stream', 'resumed', 'unanswered'] as const).flatMap((held) =>
    (['signal', 'deadline'] as const).map((by) => ({ held, by })),
  );
  for (const { held, by } of cases) {
    const where = HELD[held];
    it(`sends notifications/cancelled and closes ${where} at once when the ${by} ends the call`, async () => {
      const server = await waitingServer(held);
      try {
        const remote = await connectMcp({
          transport: { kind: 'http', url: server.listener.url },
          protocol: 'legacy',
          timeoutMs: 30_000,
        });
        try {
          await remote.listTools();
          const controller = new AbortController();
          const failure = remote
            .callTool(
              'wait',
              {},
              // Past the clamped 250 ms wait before the resuming GET.
              by === 'signal' ? { signal: controller.signal } : { timeoutMs: 1_000 },
            )
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          await within(server.streamOpened, `${where} opening`);
          if (by === 'signal') {
            controller.abort();
          }
          await within(server.streamClosed, `the server seeing ${where} close`);
          await within(server.cancellation, 'the cancellation notification');
          const error = await failure;
          assert.ok(error instanceof McpClientError);
          assert.equal(error.code, by === 'signal' ? 'aborted' : 'timeout');
          assert.equal(server.cancelled.length, 1);
          assert.equal(typeof server.cancelled[0], 'number');
          const resumed = held === 'resumed' ? ['e1'] : [];
          assert.deepEqual(server.resumed, resumed);
          // The connection stays usable, and nothing resumed the closed stream.
          assert.equal((await remote.callTool('echo', {})).status, 'ok');
          assert.equal(server.calls(), 1);
          assert.deepEqual(server.resumed, resumed);
        } finally {
          await remote.close();
        }
      } finally {
        await server.listener.close();
      }
    });
  }
});

describe('ConnectReplies', () => {
  function fakeTransport(): Transport {
    return {
      onmessage: undefined,
      start: () => Promise.resolve(),
      send: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
  }

  it('records internal-error replies through every handler swap, then puts the plain handler back', () => {
    const transport = fakeTransport();
    const replies = new ConnectReplies(transport);
    const seen: string[] = [];
    const sdk = (_message: JSONRPCMessage) => void seen.push('sdk');
    const probe = (_message: JSONRPCMessage) => void seen.push('probe');
    transport.onmessage = sdk;
    // A probe window saves the current handler, installs its own, and restores the saved one.
    const saved = transport.onmessage;
    transport.onmessage = probe;
    transport.onmessage({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } });
    assert.equal(replies.serverFailed(), false);
    transport.onmessage({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'x' } });
    assert.equal(replies.serverFailed(), true);
    transport.onmessage = saved;
    transport.onmessage?.({ jsonrpc: '2.0', id: 3, result: {} });
    assert.deepEqual(seen, ['probe', 'probe', 'sdk']);
    replies.release();
    assert.equal(transport.onmessage, sdk);
    const plain = (_message: JSONRPCMessage) => undefined;
    transport.onmessage = plain;
    assert.equal(transport.onmessage, plain);
  });
});
