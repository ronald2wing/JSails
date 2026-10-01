/**
 * `fromMcpClient`: the official client fits `OfficialMcpClientLike` (checked
 * at compile time) and lists a multi-page server completely in one
 * cursor-less call (the client pages itself); a structural client's cursors
 * are walked, bounded by `maxPages`, with the signal forwarded; a repeated cursor,
 * too many pages or tools, a malformed page, and a failing server are
 * value-free `mcp_failed` errors (the server error kept as `cause`); an
 * aborted listing is `aborted`; `callTool` forwards name, arguments, and
 * signal; bad clients and options are rejected.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { fromMcpClient, type OfficialMcpClientLike } from '../../src/mcp/mcp-source.js';
import { startScriptedServer } from './scripted-mcp-server.js';

function tool(name: string): Record<string, unknown> {
  return { name, description: `Tool ${name}.`, inputSchema: { type: 'object' } };
}

interface PageCall {
  readonly cursor: string | undefined;
  readonly signal: AbortSignal | undefined;
}

function pagedClient(
  pages: readonly { tools: readonly unknown[]; nextCursor?: unknown }[],
  calls: PageCall[] = [],
): OfficialMcpClientLike {
  return {
    listTools(params, options) {
      calls.push({ cursor: params?.cursor, signal: options?.signal });
      const page = pages[calls.length - 1] ?? { tools: [] };
      return Promise.resolve(page as { tools: readonly unknown[]; nextCursor?: string });
    },
    callTool() {
      return Promise.resolve({ content: [] });
    },
  };
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  reason?: string,
): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, code);
    if (reason !== undefined) assert.equal(error.context.reason, reason);
    assert.ok(!error.message.includes('CANARY'));
    return true;
  });
}

describe('fromMcpClient', () => {
  it('lists a multi-page server in one cursor-less call, the official client paging itself', async () => {
    const server = await startScriptedServer(
      [tool('a'), tool('b'), tool('c'), tool('d'), tool('e')],
      () => ({ content: [] }),
      2,
    );
    try {
      const official: OfficialMcpClientLike = server.client;
      const bridgeCalls: (string | undefined)[] = [];
      const counted: OfficialMcpClientLike = {
        listTools: (params, options) => {
          bridgeCalls.push(params?.cursor);
          return official.listTools(params, options);
        },
        callTool: (params, options) => official.callTool(params, options),
      };
      // maxPages bounds only nextCursor paging; the official client's own listMaxPages bounds this.
      const listed = await fromMcpClient(counted, { maxPages: 1 }).listTools({});
      assert.deepEqual(
        listed.map((entry) => entry.name),
        ['a', 'b', 'c', 'd', 'e'],
      );
      assert.deepEqual(bridgeCalls, [undefined]);
      assert.deepEqual(server.cursors, [undefined, '2', '4']);
    } finally {
      await server.close();
    }
  });

  it('bounds a structural client’s nextCursor paging by maxPages', async () => {
    const calls: PageCall[] = [];
    const client = pagedClient(
      [
        { tools: [tool('a')], nextCursor: 'p2' },
        { tools: [tool('b')], nextCursor: null },
      ],
      calls,
    );
    await rejectsWith(
      fromMcpClient(client, { maxPages: 1 }).listTools({}),
      'mcp_failed',
      'page_limit',
    );
    assert.equal(calls.length, 1);
    const listed = await fromMcpClient(
      pagedClient([
        { tools: [tool('a')], nextCursor: 'p2' },
        { tools: [tool('b')], nextCursor: null },
      ]),
      { maxPages: 2 },
    ).listTools({});
    assert.equal(listed.length, 2);
  });

  it('walks a structural client’s cursors and forwards the signal', async () => {
    const calls: PageCall[] = [];
    const signal = new AbortController().signal;
    const listed = await fromMcpClient(
      pagedClient(
        [
          { tools: [tool('a')], nextCursor: 'p2' },
          { tools: [tool('b')], nextCursor: 'p3' },
          { tools: [tool('c')], nextCursor: null },
        ],
        calls,
      ),
    ).listTools({ signal });
    assert.equal(listed.length, 3);
    assert.deepEqual(
      calls.map((call) => call.cursor),
      [undefined, 'p2', 'p3'],
    );
    assert.ok(calls.every((call) => call.signal === signal));
    assert.ok(Object.isFrozen(listed));
  });

  it('fails a repeated cursor, too many pages or tools, and a malformed page', async () => {
    await rejectsWith(
      fromMcpClient(
        pagedClient([
          { tools: [], nextCursor: 'x' },
          { tools: [], nextCursor: 'x' },
        ]),
      ).listTools({}),
      'mcp_failed',
      'pagination_loop',
    );
    await rejectsWith(
      fromMcpClient(pagedClient([{ tools: [], nextCursor: 5 }])).listTools({}),
      'mcp_failed',
      'pagination_loop',
    );
    const endless: OfficialMcpClientLike = {
      listTools: (params) =>
        Promise.resolve({ tools: [], nextCursor: `${Number(params?.cursor ?? 0) + 1}` }),
      callTool: () => Promise.resolve({}),
    };
    await rejectsWith(
      fromMcpClient(endless, { maxPages: 3 }).listTools({}),
      'mcp_failed',
      'page_limit',
    );
    await rejectsWith(
      fromMcpClient(pagedClient([{ tools: [tool('a'), tool('b')] }]), { maxTools: 1 }).listTools(
        {},
      ),
      'mcp_failed',
      'tool_limit',
    );
    await rejectsWith(
      fromMcpClient(pagedClient([{ tools: 'CANARY' as unknown as unknown[] }])).listTools({}),
      'mcp_failed',
      'malformed_list',
    );
  });

  it('wraps a failing server, keeping its error only as the cause', async () => {
    const cause = new Error('CANARY: connection refused');
    const failing: OfficialMcpClientLike = {
      listTools: () => Promise.reject(cause),
      callTool: () => Promise.resolve({}),
    };
    await assert.rejects(fromMcpClient(failing).listTools({}), (error) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'mcp_failed');
      assert.equal(error.context.reason, 'list_failed');
      assert.equal(error.cause, cause);
      assert.ok(!error.message.includes('CANARY'));
      return true;
    });
  });

  it('reports an aborted listing as aborted', async () => {
    const controller = new AbortController();
    const slow: OfficialMcpClientLike = {
      listTools: (_params, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('CANARY')));
        }),
      callTool: () => Promise.resolve({}),
    };
    const listing = fromMcpClient(slow).listTools({ signal: controller.signal });
    controller.abort();
    await rejectsWith(listing, 'aborted');
    await rejectsWith(fromMcpClient(slow).listTools({ signal: AbortSignal.abort() }), 'aborted');
  });

  it('forwards name, arguments, and signal on callTool', async () => {
    const seen: unknown[] = [];
    const client: OfficialMcpClientLike = {
      listTools: () => Promise.resolve({ tools: [] }),
      callTool: (params, options) => {
        seen.push(params, options?.signal);
        return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
      },
    };
    const signal = new AbortController().signal;
    const result = await fromMcpClient(client).callTool('search', { q: 'x' }, { signal });
    assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] });
    assert.deepEqual(seen, [{ name: 'search', arguments: { q: 'x' } }, signal]);
  });

  it('rejects a bad client and bad bounds', () => {
    assert.throws(
      () => fromMcpClient({} as OfficialMcpClientLike),
      (error) => error instanceof AiError && error.code === 'invalid_options',
    );
    for (const options of [{ maxPages: 0 }, { maxTools: 1.5 }]) {
      assert.throws(
        () => fromMcpClient(pagedClient([]), options),
        (error) => error instanceof AiError && error.code === 'invalid_options',
      );
    }
  });
});
