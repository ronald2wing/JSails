/**
 * AI transport tests: the fetch-based HTTP transport and the MCP client
 * adapter, including rejection of malformed backend replies.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createHttpTransport,
  createMcpTransport,
  AiError,
  type McpLikeClient,
} from '../src/index.js';

describe('createHttpTransport', () => {
  it('POSTs messages and returns the assistant reply', async () => {
    const requests: { url: string; body: unknown }[] = [];
    const transport = createHttpTransport({
      endpoint: 'https://example.test/chat',
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({ message: { role: 'assistant', content: 'hi back' } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });
    const reply = await transport.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    assert.deepEqual(reply.message, { role: 'assistant', content: 'hi back' });
    assert.equal(requests[0]?.url, 'https://example.test/chat');
  });

  it('rejects a malformed tool call in the reply without echoing it', async () => {
    const transport = createHttpTransport({
      endpoint: 'https://example.test/chat',
      fetch: async () =>
        new Response(
          JSON.stringify({
            message: { role: 'assistant', content: '' },
            toolCalls: [{ id: 't1', name: 'leak_me', arguments: 'not-an-object' }],
          }),
          { status: 200 },
        ),
    });
    await assert.rejects(
      transport.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      (e: unknown) =>
        e instanceof AiError && e.code === 'transport_failed' && !e.message.includes('leak_me'),
    );
  });

  it('rejects a non-JSON reply body', async () => {
    const transport = createHttpTransport({
      endpoint: 'https://example.test/chat',
      fetch: async () => new Response('<html>', { status: 200 }),
    });
    await assert.rejects(
      transport.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      (e: unknown) => e instanceof AiError && e.code === 'transport_failed',
    );
  });

  it('throws transport_failed on a non-2xx response', async () => {
    const transport = createHttpTransport({
      endpoint: 'https://example.test/chat',
      fetch: async () => new Response('no', { status: 500 }),
    });
    await assert.rejects(
      transport.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      (e: unknown) => e instanceof AiError && e.code === 'transport_failed',
    );
  });
});

describe('createMcpTransport', () => {
  it('routes chat through the configured chat tool and unwraps text', async () => {
    const client: McpLikeClient = {
      async callTool(name) {
        assert.equal(name, 'chat');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: { role: 'assistant', content: 'yo' },
                toolCalls: [],
              }),
            },
          ],
        };
      },
    };
    const transport = createMcpTransport({ client });
    const reply = await transport.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    assert.deepEqual(reply.message, { role: 'assistant', content: 'yo' });
  });

  it('treats plain-text chat output as an assistant message', async () => {
    const client: McpLikeClient = {
      async callTool() {
        return { content: [{ type: 'text', text: 'plain reply' }] };
      },
    };
    const transport = createMcpTransport({ client });
    const reply = await transport.complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    assert.deepEqual(reply.message, { role: 'assistant', content: 'plain reply' });
  });

  it('throws transport_failed when the chat tool returns no text', async () => {
    const client: McpLikeClient = {
      async callTool() {
        return { content: [{ type: 'image' }] };
      },
    };
    const transport = createMcpTransport({ client });
    await assert.rejects(
      transport.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
      (e: unknown) => e instanceof AiError && e.code === 'transport_failed',
    );
  });
});

describe('transport hardening', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];
  const ok = (): Response =>
    new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' } }), {
      status: 200,
    });

  it('sends temperature, model, extra body fields, and tool schemas over HTTP', async () => {
    let sent: Record<string, unknown> = {};
    const transport = createHttpTransport({
      endpoint: 'https://example.test/chat',
      model: 'm-1',
      body: { max_tokens: 10, messages: 'ignored' },
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return ok();
      },
    });
    await transport.complete({
      messages,
      tools: [{ name: 'lookup', description: 'd', call: () => null }],
      temperature: 0.3,
    });
    assert.equal(sent['temperature'], 0.3);
    assert.equal(sent['model'], 'm-1');
    assert.equal(sent['max_tokens'], 10);
    assert.deepEqual(sent['messages'], messages);
    assert.deepEqual(sent['tools'], [{ name: 'lookup', description: 'd' }]);
  });

  it('wraps a network failure value-free, never the raw fetch error', async () => {
    const transport = createHttpTransport({
      endpoint: 'https://internal-host.test/chat',
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect 10.0.0.5:443') });
      },
    });
    await assert.rejects(transport.complete({ messages, tools: [] }), (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'transport_failed');
      assert.equal(error.message.includes('10.0.0.5'), false);
      assert.equal('cause' in error && error.cause !== undefined, false);
      return true;
    });
  });

  it('times out a stalled backend with timed_out', async () => {
    const transport = createHttpTransport({
      endpoint: 'https://example.test/chat',
      timeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await assert.rejects(
      transport.complete({ messages, tools: [] }),
      (error: unknown) => error instanceof AiError && error.code === 'timed_out',
    );
  });

  it('aborts with the caller signal', async () => {
    const controller = new AbortController();
    const transport = createHttpTransport({
      endpoint: 'https://example.test/chat',
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          controller.abort();
        }),
    });
    await assert.rejects(
      transport.complete({ messages, tools: [], signal: controller.signal }),
      (error: unknown) => error instanceof AiError && error.code === 'aborted',
    );
  });

  it('refuses a reply body over maxResponseBytes', async () => {
    const transport = createHttpTransport({
      endpoint: 'https://example.test/chat',
      maxResponseBytes: 64,
      fetch: async () => new Response('x'.repeat(1000), { status: 200 }),
    });
    await assert.rejects(
      transport.complete({ messages, tools: [] }),
      (error: unknown) =>
        error instanceof AiError &&
        error.code === 'transport_failed' &&
        error.message.includes('too large'),
    );
  });

  it('sends tools and temperature to the MCP chat tool', async () => {
    let received: Record<string, unknown> = {};
    const client: McpLikeClient = {
      async callTool(_name, args) {
        received = args;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    await createMcpTransport({ client }).complete({
      messages,
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' }, call: () => 1 }],
      temperature: 0.5,
    });
    assert.deepEqual(received['tools'], [
      { name: 'lookup', description: 'd', parameters: { type: 'object' } },
    ]);
    assert.equal(received['temperature'], 0.5);
  });

  it('wraps an MCP client rejection value-free', async () => {
    const client: McpLikeClient = {
      async callTool() {
        throw new Error('upstream secret detail');
      },
    };
    await assert.rejects(
      createMcpTransport({ client }).complete({ messages, tools: [] }),
      (error: unknown) =>
        error instanceof AiError &&
        error.code === 'transport_failed' &&
        !error.message.includes('secret'),
    );
  });

  it('times out a stalled MCP call', async () => {
    const client: McpLikeClient = { callTool: () => new Promise(() => undefined) };
    await assert.rejects(
      createMcpTransport({ client, timeoutMs: 10 }).complete({ messages, tools: [] }),
      (error: unknown) => error instanceof AiError && error.code === 'timed_out',
    );
  });
});
