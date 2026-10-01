/**
 * `connectMcp` over real transports.
 *
 * Over Streamable HTTP against the package's own endpoint (a `node:http`
 * listener), in the modern, legacy, and auto modes: listing, structured
 * output, `Mcp-Param-*` mirroring, multi-round-trip input on the modern era
 * and its clean failure on stateless legacy HTTP, progress over SSE, abort
 * with the server's handler seeing it promptly (on legacy HTTP too, where only
 * closing the request's stream reaches a stateless server), the result cap
 * on JSON and SSE bodies,
 * credentials from a headers provider (rotation, a throwing or malformed
 * provider), `401`/`403` as `unauthorized`/`forbidden`, and transport option
 * checks.
 *
 * Against a scripted legacy-only server: the auto fallback and the modern
 * refusal, pagination (and a cursor that never ends), the tools a client must
 * leave out, output that breaks its schema, malformed content, a remote error
 * message that never surfaces, and an oversized body.
 *
 * Over stdio against a spawned child, in the three modes: calling, input
 * through the handler (sealed state on the modern era, real elicitation on
 * 2025), abort reaching the child's handler, and a command that cannot be
 * spawned.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { McpClientError } from '../src/errors.js';
import { createMcpHttpEndpoint, type McpAuthentication } from '../src/http-endpoint.js';
import {
  connectMcp,
  type McpClientOptions,
  type McpElicitation,
  type McpRemoteServer,
  type McpToolExclusion,
  withDefaults,
} from '../src/remote-client.js';
import { authorize, demoServer, signalLog, type SignalLog } from './demo-server.js';
import { within } from './fixtures.js';
import { listen, type Listener } from './http-harness.js';
import { legacyHttpHandler, type LegacyScript } from './legacy-server.js';
import { IN_PROCESS_CONCURRENCY, SPAWN_CONCURRENCY } from './spawn-concurrency.js';

type Mode = 'modern' | 'legacy' | 'auto';
const MODES: readonly Mode[] = ['modern', 'legacy', 'auto'];
const CHILD = fileURLToPath(new URL('./stdio-child.js', import.meta.url));
// A stdio child gets only a minimal environment, which leaves out the runner's
// compile cache; passing it on spares every child (and the SDK's probe sibling)
// a cold compile of the modules it loads.
const CHILD_ENV: Record<string, string> =
  process.env.NODE_COMPILE_CACHE === undefined
    ? {}
    : { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE };

function textOf(outcome: { status: string; content?: readonly { type: string }[] }): string {
  return (outcome.content ?? [])
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

async function clientError(call: Promise<unknown>): Promise<McpClientError> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof McpClientError, `expected McpClientError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to reject');
}

function authenticate(request: Request, resource: string): McpAuthentication {
  const credential = (id: string) => ({
    id,
    audience: resource,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  switch (request.headers.get('authorization')) {
    case null:
      return { kind: 'anonymous' };
    case 'Bearer reader':
    case 'Bearer reader-2':
      return {
        kind: 'authenticated',
        actor: { kind: 'user', id: 'ann', scopes: ['notes:read'] },
        credential: credential('tok-r'),
      };
    case 'Bearer writer':
      return {
        kind: 'authenticated',
        actor: { kind: 'user', id: 'ann', scopes: ['notes:read', 'notes:write'] },
        credential: credential('tok-w'),
      };
    default:
      return { kind: 'rejected', reason: 'invalid' };
  }
}

interface Served {
  readonly listener: Listener;
  readonly log: SignalLog;
  close(): Promise<void>;
}

async function serveDemo(): Promise<Served> {
  const log = signalLog();
  let handle: (request: Request) => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 503 }));
  const listener = await listen((request) => handle(request));
  const endpoint = createMcpHttpEndpoint(demoServer(log), {
    resource: listener.url,
    authenticate: (request) => authenticate(request, listener.url),
    authorize,
    onError: () => undefined,
  });
  handle = (request) => endpoint.handle(request);
  return {
    listener,
    log,
    async close() {
      await endpoint.close();
      await listener.close();
    },
  };
}

function connectDemo(
  served: Served,
  mode: Mode,
  options: Partial<McpClientOptions> = {},
): Promise<McpRemoteServer> {
  return connectMcp({
    transport: {
      kind: 'http',
      url: served.listener.url,
      headers: { authorization: 'Bearer reader' },
    },
    protocol: mode,
    ...options,
  });
}

// The tests here overlap (the mode suites inherit the concurrency), each
// mode against its own endpoint: the progress test waits for the next
// cancellation in its endpoint's log, which another mode's abort must not
// satisfy. Within a mode it is the only test that cancels a call.
describe(
  'connectMcp over HTTP to the package endpoint',
  { concurrency: IN_PROCESS_CONCURRENCY },
  () => {
    let shared: Served;
    before(async () => {
      shared = await serveDemo();
    });
    after(async () => {
      await shared.close();
    });

    for (const mode of MODES) {
      describe(mode, () => {
        let served: Served;
        before(async () => {
          served = await serveDemo();
        });
        after(async () => {
          await served.close();
        });
        const connect = (options: Partial<McpClientOptions> = {}): Promise<McpRemoteServer> =>
          connectDemo(served, mode, options);

        it('lists, calls with structured output, and mirrors x-mcp-header arguments', async () => {
          const remote = await connect();
          try {
            assert.equal(remote.info.era, mode === 'legacy' ? 'legacy' : 'modern');
            assert.equal(remote.info.name, 'demo');
            const names = (await remote.listTools()).map((tool) => tool.name);
            assert.ok(names.includes('region') && names.includes('write_note'));
            assert.ok(!names.includes('secret'));
            const added = await remote.callTool('add', { a: 4, b: 5 });
            assert.ok(added.status === 'ok');
            assert.deepEqual(added.structured, { sum: 9 });
            assert.equal(
              textOf(await remote.callTool('region', { region: 'eu-west' })),
              'region eu-west',
            );
            assert.equal(
              textOf(await remote.callTool('region', { region: 'Zürich 世界' })),
              'region Zürich 世界',
            );
          } finally {
            await remote.close();
          }
        });

        it('answers input on the modern era and fails cleanly on stateless legacy HTTP', async () => {
          const seen: McpElicitation[] = [];
          const remote = await connect({
            elicit: (request) => {
              seen.push(request);
              return { action: 'accept', content: { name: 'Ada' } };
            },
          });
          try {
            const outcome = await remote.callTool('ask', { greeting: 'Hello' });
            if (mode === 'legacy') {
              // The server answers input_unavailable; the client reports the input_required outcome.
              assert.deepEqual(outcome, { status: 'input_required' });
              assert.equal(seen.length, 0);
            } else {
              assert.equal(textOf(outcome), 'Hello Ada');
              assert.equal(seen[0]?.key, 'name');
            }
          } finally {
            await remote.close();
          }
        });

        it('streams progress, then aborts and the server handler sees it', async () => {
          const remote = await connect();
          try {
            const progress: number[] = [];
            const finished = await remote.callTool(
              'slow',
              { wait: false },
              { onProgress: (done) => void progress.push(done) },
            );
            assert.equal(textOf(finished), 'finished');
            assert.deepEqual(progress, [1, 2]);
            const controller = new AbortController();
            const cancelled = served.log.next();
            const call = remote.callTool(
              'slow',
              { wait: true },
              { signal: controller.signal, onProgress: (done) => done === 2 && controller.abort() },
            );
            assert.equal((await clientError(call)).code, 'aborted');
            await within(cancelled, 'the slow handler seeing the cancellation');
            assert.equal((await remote.callTool('add', { a: 1, b: 1 })).status, 'ok');
          } finally {
            await remote.close();
          }
        });

        it('refuses oversized JSON and SSE results and stays usable', async () => {
          const remote = await connect({ maxResultBytes: 50_000 });
          try {
            for (const progress of [false, true]) {
              for (const size of [60_000, 200_000]) {
                const failure = await clientError(remote.callTool('big', { size, progress }));
                assert.equal(failure.code, 'result_too_large', `size ${size} progress ${progress}`);
              }
            }
            const fine = await remote.callTool('big', { size: 1_000, progress: true });
            assert.equal(textOf(fine).length, 1_000);
          } finally {
            await remote.close();
          }
        });

        it('maps 401 and 403 to unauthorized and forbidden', async () => {
          const anonymous = await connectMcp({
            transport: { kind: 'http', url: served.listener.url },
            protocol: mode,
          });
          try {
            const failure = await clientError(anonymous.callTool('write_note'));
            assert.equal(failure.code, 'unauthorized');
            assert.equal(failure.status, 401);
          } finally {
            await anonymous.close();
          }
          const reader = await connect();
          try {
            const failure = await clientError(reader.callTool('write_note'));
            assert.equal(failure.code, 'forbidden');
            assert.deepEqual(failure.scopes, ['notes:write']);
          } finally {
            await reader.close();
          }
          const writer = await connect({
            transport: {
              kind: 'http',
              url: served.listener.url,
              headers: { authorization: 'Bearer writer' },
            },
          });
          try {
            assert.equal(textOf(await writer.callTool('write_note')), 'written');
          } finally {
            await writer.close();
          }
          const rejected = await clientError(
            connect({
              transport: {
                kind: 'http',
                url: served.listener.url,
                headers: { authorization: 'Bearer forged' },
              },
            }),
          );
          assert.equal(rejected.code, 'unauthorized');
        });
      });
    }

    it('asks a headers provider before every request, so a token can rotate', async () => {
      const tokens = ['reader', 'reader-2', 'writer'];
      let asked = 0;
      const remote = await connectDemo(shared, 'modern', {
        transport: {
          kind: 'http',
          url: shared.listener.url,
          headers: () => {
            const token = tokens[Math.min(asked, tokens.length - 1)] ?? 'reader';
            asked += 1;
            return { authorization: `Bearer ${token}` };
          },
        },
      });
      try {
        await remote.listTools();
        while (asked < 2) {
          await remote.listTools();
        }
        assert.equal(textOf(await remote.callTool('write_note')), 'written');
        assert.ok(asked >= 3);
      } finally {
        await remote.close();
      }
    });

    it('reports a throwing or malformed headers provider as credentials_failed', async () => {
      const secret = new Error('vault password');
      for (const headers of [
        () => {
          throw secret;
        },
        () => ({ 'mcp-method': 'tools/list' }),
        () => ({ authorization: 'Bearer a\r\nx-evil: 1' }),
        () => 'nope' as never,
      ]) {
        const failure = await clientError(
          connectMcp({
            transport: { kind: 'http', url: shared.listener.url, headers },
            protocol: 'auto',
          }),
        );
        assert.equal(failure.code, 'credentials_failed');
        assert.ok(!failure.message.includes('vault'));
      }
    });
  },
);

describe('connectMcp transport options', () => {
  it('refuses malformed transports', async () => {
    const bad: unknown[] = [
      undefined,
      { kind: 'ftp' },
      { kind: 'http' },
      { kind: 'http', url: 'not a url' },
      { kind: 'http', url: 'http://example.com/mcp' },
      { kind: 'http', url: 'https://user:pass@example.com/mcp' },
      { kind: 'http', url: 'https://example.com/mcp#frag' },
      { kind: 'http', url: 'https://example.com/mcp', headers: { 'content-type': 'x' } },
      { kind: 'http', url: 'https://example.com/mcp', headers: { 'Mcp-Name': 'x' } },
      { kind: 'http', url: 'https://example.com/mcp', headers: { 'bad name': 'x' } },
      { kind: 'http', url: 'https://example.com/mcp', headers: { a: 'x\ny' } },
      { kind: 'http', url: 'https://example.com/mcp', fetch: 'yes' },
      { kind: 'http', url: 'https://example.com/mcp', extra: true },
      { kind: 'stdio', command: '' },
      { kind: 'stdio', command: 'node', args: [1] },
      { kind: 'stdio', command: 'node', env: { A: 1 } },
      { kind: 'stdio', command: 'node', env: { 'A=B': 'x' } },
      { kind: 'stdio', command: 'node', cwd: '' },
      { kind: 'stdio', command: 'node', stderr: 'pipe' },
      { kind: 'stdio', command: 'node', shell: true },
    ];
    for (const transport of bad) {
      const failure = await clientError(
        connectMcp({ transport: transport as McpClientOptions['transport'] }),
      );
      assert.equal(failure.code, 'invalid_option', JSON.stringify(transport));
    }
  });

  it('accepts http on loopback hosts and fails to connect to a closed port', async () => {
    const listener = await listen(() => new Response(null, { status: 404 }));
    const url = listener.url;
    await listener.close();
    for (const host of ['127.0.0.1', 'localhost']) {
      const failure = await clientError(
        connectMcp({
          transport: { kind: 'http', url: url.replace('127.0.0.1', host) },
          timeoutMs: 5_000,
        }),
      );
      assert.equal(failure.code, 'connect_failed');
    }
  });
});

// Each test scripts its own listener. Only the exclusion test connects without
// an `onToolExcluded` hook, so the process warnings it counts are its own.
describe('connectMcp against a legacy-only server', { concurrency: IN_PROCESS_CONCURRENCY }, () => {
  const tool = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    inputSchema: { type: 'object' },
    ...extra,
  });
  const outputSchema = {
    type: 'object',
    properties: { n: { type: 'number' } },
    required: ['n'],
  };

  async function withScript(
    script: LegacyScript,
    check: (url: string) => Promise<void>,
  ): Promise<void> {
    const listener = await listen(legacyHttpHandler(script));
    try {
      await check(listener.url);
    } finally {
      await listener.close();
    }
  }

  function connectTo(
    url: string,
    options: Partial<McpClientOptions> = {},
  ): Promise<McpRemoteServer> {
    return connectMcp({
      transport: { kind: 'http', url },
      onToolExcluded: () => undefined,
      ...options,
    });
  }

  it('falls back to the 2025 handshake in auto mode and refuses modern-only', async () => {
    await withScript({ pages: [[tool('a')]] }, async (url) => {
      const remote = await connectTo(url);
      try {
        assert.equal(remote.info.era, 'legacy');
        assert.equal(remote.info.protocolVersion, '2025-11-25');
        assert.equal(remote.info.name, 'legacy-only');
        assert.equal(remote.info.instructions, 'A 2025 server.');
        assert.deepEqual(
          (await remote.listTools()).map((entry) => entry.name),
          ['a'],
        );
        assert.deepEqual(await remote.listResources(), []);
        assert.deepEqual(await remote.listPrompts(), []);
      } finally {
        await remote.close();
      }
      assert.equal(
        (await clientError(connectTo(url, { protocol: 'modern' }))).code,
        'unsupported_protocol',
      );
    });
  });

  it('walks every page, and refuses a repeated or endless cursor', async () => {
    await withScript({ pages: [[tool('a')], [tool('b')], [tool('c')]] }, async (url) => {
      const remote = await connectTo(url);
      try {
        assert.deepEqual(
          (await remote.listTools()).map((entry) => entry.name),
          ['a', 'b', 'c'],
        );
      } finally {
        await remote.close();
      }
    });
    await withScript(
      { pages: [[tool('a')], [tool('b')]], cursors: ['page-1', 'page-1'] },
      async (url) => {
        const remote = await connectTo(url);
        try {
          assert.equal((await clientError(remote.listTools())).code, 'invalid_result');
        } finally {
          await remote.close();
        }
      },
    );
    const endless = Array.from({ length: 70 }, (_, index) => [tool(`t${index}`)]);
    await withScript(
      { pages: endless, cursors: endless.map((_, index) => `page-${index + 1}`) },
      async (url) => {
        const remote = await connectTo(url);
        try {
          assert.equal((await clientError(remote.listTools())).code, 'invalid_result');
        } finally {
          await remote.close();
        }
      },
    );
  });

  it('leaves out tools a conforming client must not offer, and reports each', async () => {
    const crlf = {
      type: 'object',
      properties: { r: { type: 'string', 'x-mcp-header': 'Bad\r\nX' } },
    };
    const nested = {
      type: 'object',
      properties: { r: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } } },
    };
    const script: LegacyScript = {
      pages: [
        [
          tool('ok'),
          tool('bad name!'),
          tool('ok'),
          tool('crlf', { inputSchema: crlf }),
          tool('nested', { inputSchema: nested }),
          tool('badregex', {
            outputSchema: { type: 'object', properties: { a: { type: 'string', pattern: '[' } } },
          }),
          tool('first_id', {
            outputSchema: { $id: 'https://example.com/shared.json', ...outputSchema },
          }),
          tool('second_id', {
            outputSchema: { $id: 'https://example.com/shared.json', type: 'object' },
          }),
        ],
      ],
      call: () => ({ content: [{ type: 'text', text: 'ran' }] }),
    };
    await withScript(script, async (url) => {
      const excluded: McpToolExclusion[] = [];
      const remote = await connectTo(url, { onToolExcluded: (entry) => void excluded.push(entry) });
      try {
        assert.deepEqual(
          (await remote.listTools()).map((entry) => entry.name),
          ['ok', 'first_id'],
        );
        assert.deepEqual(excluded, [
          { name: 'bad name!', reason: 'invalid_name' },
          { name: 'ok', reason: 'duplicate_name' },
          { name: 'crlf', reason: 'invalid_header_declaration' },
          { name: 'nested', reason: 'invalid_header_declaration' },
          { name: 'badregex', reason: 'invalid_output_schema' },
          { name: 'second_id', reason: 'invalid_output_schema' },
        ]);
        assert.equal((await clientError(remote.callTool('crlf', { r: 'x' }))).code, 'unknown_tool');
        assert.equal(textOf(await remote.callTool('ok')), 'ran');
      } finally {
        await remote.close();
      }
      const warnings: Error[] = [];
      const onWarning = (warning: Error): void => {
        warnings.push(warning);
      };
      process.on('warning', onWarning);
      const defaults = await connectMcp({ transport: { kind: 'http', url } });
      try {
        await defaults.listTools();
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.off('warning', onWarning);
        await defaults.close();
      }
      const codes = warnings.map((warning) => (warning as { code?: string }).code);
      assert.equal(codes.filter((code) => code === 'JSAILS_MCP_TOOL_EXCLUDED').length, 6);
      assert.ok(warnings.every((warning) => !warning.message.includes('bad name!')));
    });
  });

  it('checks structured output against the output schema, but not on a tool error', async () => {
    const script: LegacyScript = {
      pages: [[tool('out', { outputSchema }), tool('plain')]],
      call: (name, args) => {
        switch (args.mode) {
          case 'valid':
            return { content: [], structuredContent: { n: 1 } };
          case 'wrong':
            return { content: [], structuredContent: { n: 'one' } };
          case 'missing':
            return { content: [{ type: 'text', text: 'no structure' }] };
          case 'error':
            return {
              content: [{ type: 'text', text: 'bad' }],
              structuredContent: { anything: true },
              isError: true,
            };
          case 'relative-link':
            return { content: [{ type: 'resource_link', uri: 'notes/1', name: 'note' }] };
          case 'audio-as-image':
            return { content: [{ type: 'image', data: 'AAAA', mimeType: 'audio/wav' }] };
          default:
            return { content: [{ type: 'text', text: name }] };
        }
      },
    };
    await withScript(script, async (url) => {
      const remote = await connectTo(url);
      try {
        const valid = await remote.callTool('out', { mode: 'valid' });
        assert.ok(valid.status === 'ok');
        assert.deepEqual(valid.structured, { n: 1 });
        assert.equal(
          (await clientError(remote.callTool('out', { mode: 'wrong' }))).code,
          'invalid_result',
        );
        assert.equal(
          (await clientError(remote.callTool('out', { mode: 'missing' }))).code,
          'invalid_result',
        );
        const failed = await remote.callTool('out', { mode: 'error' });
        assert.ok(failed.status === 'tool_error');
        assert.deepEqual(failed.structured, { anything: true });
        assert.equal(
          (await clientError(remote.callTool('plain', { mode: 'relative-link' }))).code,
          'invalid_result',
        );
        assert.equal(
          (await clientError(remote.callTool('plain', { mode: 'audio-as-image' }))).code,
          'invalid_result',
        );
      } finally {
        await remote.close();
      }
    });
  });

  it('lists again once when asked to call a tool it has not seen', async () => {
    const page: Record<string, unknown>[] = [tool('a')];
    let listings = 0;
    const script: LegacyScript = {
      get pages() {
        listings += 1;
        return [page];
      },
      call: (name) => ({ content: [{ type: 'text', text: `ran ${name}` }] }),
    };
    await withScript(script, async (url) => {
      const remote = await connectTo(url);
      try {
        assert.equal(textOf(await remote.callTool('a')), 'ran a');
        const afterFirst = listings;
        page.push(tool('b'));
        assert.equal(textOf(await remote.callTool('b')), 'ran b');
        assert.equal((await clientError(remote.callTool('c'))).code, 'unknown_tool');
        assert.ok(listings > afterFirst);
      } finally {
        await remote.close();
      }
    });
  });

  it('never surfaces a remote error message', async () => {
    const script: LegacyScript = {
      pages: [[tool('boom')]],
      call: () => {
        throw new Error('db password hunter2');
      },
    };
    await withScript(script, async (url) => {
      const remote = await connectTo(url);
      try {
        const failure = await clientError(remote.callTool('boom'));
        assert.equal(failure.code, 'protocol_error');
        assert.equal(typeof failure.rpcCode, 'number');
        assert.ok(!failure.message.includes('hunter2'));
        assert.ok(!JSON.stringify(failure.context).includes('hunter2'));
      } finally {
        await remote.close();
      }
    });
  });

  it('cuts off an oversized body and keeps the connection usable', async () => {
    const script: LegacyScript = {
      pages: [[tool('big'), tool('small')]],
      call: (name) => ({
        content: [{ type: 'text', text: name === 'big' ? 'x'.repeat(500_000) : 'ok' }],
      }),
    };
    await withScript(script, async (url) => {
      const remote = await connectTo(url, { maxResultBytes: 10_000 });
      try {
        assert.equal((await clientError(remote.callTool('big'))).code, 'result_too_large');
        assert.equal(textOf(await remote.callTool('small')), 'ok');
      } finally {
        await remote.close();
      }
    });
  });
});

// Each test spawns its own child, so a few overlap instead of queueing
// behind each child's cold start (two of them on a modern or auto connection,
// where the SDK probes on a disposable sibling first).
describe('connectMcp over stdio', { concurrency: SPAWN_CONCURRENCY }, () => {
  for (const mode of MODES) {
    it(`calls, answers input, and aborts (${mode})`, async () => {
      const seen: McpElicitation[] = [];
      const remote = await connectMcp({
        transport: {
          kind: 'stdio',
          command: process.execPath,
          args: [CHILD],
          env: CHILD_ENV,
          stderr: 'ignore',
        },
        protocol: mode,
        elicit: (request) => {
          seen.push(request);
          return { action: 'accept', content: { name: 'Ada' } };
        },
      });
      try {
        assert.equal(remote.info.era, mode === 'legacy' ? 'legacy' : 'modern');
        assert.equal(textOf(await remote.callTool('whoami')), 'developer *');
        assert.equal(textOf(await remote.callTool('ask')), 'Hello Ada (state {"round":1})');
        assert.equal(seen[0]?.key, mode === 'legacy' ? undefined : 'name');
        const controller = new AbortController();
        const call = remote.callTool(
          'slow',
          { wait: true },
          { signal: controller.signal, onProgress: () => controller.abort() },
        );
        assert.equal((await clientError(call)).code, 'aborted');
        const observed = remote.callTool('cancelled', { count: 1 });
        assert.equal(
          textOf(await within(observed, 'the slow handler seeing the cancellation')),
          '1',
        );
        assert.equal(textOf(await remote.callTool('slow', { wait: false })), 'finished');
      } finally {
        await remote.close();
      }
    });
  }

  it('fails to connect to a command that cannot be spawned', async () => {
    const failure = await clientError(
      connectMcp({
        transport: { kind: 'stdio', command: '/nonexistent/jsails-mcp-server', stderr: 'ignore' },
        protocol: 'legacy',
        timeoutMs: 5_000,
      }),
    );
    assert.equal(failure.code, 'connect_failed');
  });
});

describe('withDefaults', () => {
  it('fills omitted fields from the form defaults and keeps what the user gave', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', default: 'John Doe' },
        age: { type: 'integer', default: 30 },
        tags: { type: 'array', items: { type: 'string' }, default: ['a'] },
        status: { type: 'string', default: 'active' },
        loose: { type: 'string', default: { not: 'a form value' } },
        plain: { type: 'string' },
      },
    };
    assert.deepEqual(withDefaults({ status: 'pending' }, schema), {
      status: 'pending',
      name: 'John Doe',
      age: 30,
      tags: ['a'],
    });
    assert.deepEqual(withDefaults({ name: 'x' }, { type: 'object' }), { name: 'x' });
  });

  it('defines a field a remote schema names __proto__ instead of setting the prototype', () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string","default":"x"}}}',
    ) as Record<string, never>;
    const filled = withDefaults({}, schema);
    assert.equal(Object.getPrototypeOf(filled), Object.prototype);
    assert.ok(Object.hasOwn(filled, '__proto__'));
  });
});
