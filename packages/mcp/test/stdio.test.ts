/**
 * Serving over stdio. In process, over pass-through streams: option checks,
 * the default developer actor, resolving at end of input and on abort, and
 * stdout carrying protocol frames only. In a spawned child, with the official
 * client in the modern, legacy, and auto modes: listing and calling, the
 * multi-round-trip flow (sealed state on a modern connection, the legacy shim's
 * real elicitation on a 2025 one), confirmation, the `maxInputRounds` failure
 * (the same on both eras), progress, and cancellation reaching the handler
 * promptly.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { describe, it, type TestContext } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { publicAccess } from '../src/access.js';
import { defineMcpServer, defineMcpTool } from '../src/definitions.js';
import { McpDefinitionError } from '../src/errors.js';
import { serveMcpStdio, type McpStdioOptions } from '../src/stdio.js';
import { within } from './fixtures.js';
import { CLIENT_MODES, envelope, type ClientMode } from './http-harness.js';

const CHILD = fileURLToPath(new URL('./stdio-child.js', import.meta.url));
// The SDK hands a child only a whitelisted environment, which leaves out the
// runner's compile cache; passing it on spares every child (and the SDK's probe
// sibling) a cold compile of the modules it loads.
const CHILD_ENV: Record<string, string> =
  process.env.NODE_COMPILE_CACHE === undefined
    ? {}
    : { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE };
const open = publicAccess('test fixture');

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((block) => block.text ?? '').join('');
}

const tinyServer = defineMcpServer({
  name: 'tiny',
  version: '1.0.0',
  tools: [
    defineMcpTool({
      name: 'whoami',
      description: 'Name the actor.',
      access: open,
      handler: (_input, ctx) => `${ctx.actor.kind}:${ctx.actor.id ?? '-'}`,
    }),
  ],
});

interface Piped {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly lines: string[];
  next(): Promise<Record<string, unknown>>;
}

function piped(): Piped {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let buffer = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      lines.push(line);
      waiting.shift()?.(line);
    }
  });
  let read = 0;
  return {
    stdin,
    stdout,
    lines,
    next: () =>
      new Promise((resolve) => {
        const line = lines[read];
        read += 1;
        if (line !== undefined) {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } else {
          waiting.push((arrived) => resolve(JSON.parse(arrived) as Record<string, unknown>));
        }
      }),
  };
}

function send(pipe: Piped, message: Record<string, unknown>): void {
  pipe.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function callWhoami(pipe: Piped, id: number): void {
  send(pipe, {
    id,
    method: 'tools/call',
    params: { name: 'whoami', arguments: {}, _meta: envelope() },
  });
}

describe('serveMcpStdio in process', () => {
  it('serves the developer by default and resolves at end of input', async () => {
    const pipe = piped();
    const served = serveMcpStdio(tinyServer, { stdin: pipe.stdin, stdout: pipe.stdout });
    callWhoami(pipe, 1);
    const reply = await pipe.next();
    assert.equal(textOf(reply.result as { content: unknown }), 'developer:-');
    pipe.stdin.end();
    await served;
  });

  it('serves the configured actor and writes nothing but JSON-RPC frames to stdout', async () => {
    const pipe = piped();
    const controller = new AbortController();
    const served = serveMcpStdio(tinyServer, {
      actor: { kind: 'service', id: 'ci', scopes: ['notes:read'] },
      stdin: pipe.stdin,
      stdout: pipe.stdout,
      signal: controller.signal,
    });
    callWhoami(pipe, 1);
    send(pipe, { id: 2, method: 'server/discover', params: { _meta: envelope() } });
    send(pipe, { id: 3, method: 'nope/nothing', params: { _meta: envelope() } });
    pipe.stdin.write('this is not json\n');
    send(pipe, { method: 'notifications/cancelled', params: { requestId: 9, _meta: envelope() } });
    callWhoami(pipe, 4);
    const replies = [await pipe.next(), await pipe.next(), await pipe.next(), await pipe.next()];
    const byId = (id: number) => replies.find((reply) => reply.id === id);
    assert.equal(textOf(byId(1)?.result as { content: unknown }), 'service:ci');
    assert.equal(textOf(byId(4)?.result as { content: unknown }), 'service:ci');
    assert.equal((byId(2)?.result as { resultType: unknown }).resultType, 'complete');
    assert.equal((replies.find((reply) => reply.id === 3)?.error as { code: number }).code, -32601);
    controller.abort();
    await served;
    for (const line of pipe.lines) {
      assert.equal((JSON.parse(line) as { jsonrpc: unknown }).jsonrpc, '2.0', line);
    }
  });

  it('resolves at once for an already aborted signal', async () => {
    const pipe = piped();
    await serveMcpStdio(tinyServer, {
      stdin: pipe.stdin,
      stdout: pipe.stdout,
      signal: AbortSignal.abort(),
    });
  });

  it('refuses legacy handshakes when legacy is reject', async () => {
    const pipe = piped();
    const served = serveMcpStdio(tinyServer, {
      legacy: 'reject',
      stdin: pipe.stdin,
      stdout: pipe.stdout,
    });
    send(pipe, {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'old', version: '1' },
      },
    });
    const reply = await pipe.next();
    assert.ok(reply.error, JSON.stringify(reply));
    pipe.stdin.end();
    await served;
  });

  it('rejects malformed options before touching the streams', async () => {
    const pipe = piped();
    const cases: Partial<McpStdioOptions>[] = [
      { actor: { kind: 'robot', scopes: '*' } as never },
      { actor: { kind: 'user', scopes: 'all' } as never },
      { actor: { kind: 'user', scopes: [1] } as never },
      { actor: { kind: 'user', id: '', scopes: [] } },
      { legacy: 'sometimes' as never },
      { signal: {} as never },
      { maxInputRounds: 0 },
    ];
    for (const options of cases) {
      await assert.rejects(
        serveMcpStdio(tinyServer, { ...options, stdin: pipe.stdin, stdout: pipe.stdout }),
        (error: unknown) => error instanceof McpDefinitionError && error.code === 'invalid_option',
        JSON.stringify(options),
      );
    }
    assert.deepEqual(pipe.lines, []);
  });
});

interface Child {
  readonly client: Client;
  /**
   * Resolves once the child has written a line matching `line` to stderr, and
   * rejects with everything it wrote if its stderr ends first. The child's
   * reports travel on their own pipe, unordered with the protocol frames on
   * stdout, so a test waits for them instead of reading at once.
   */
  stderrLine(line: RegExp): Promise<void>;
  close(): Promise<void>;
}

/** A pending `stderrLine` wait. */
interface StderrWatcher {
  readonly line: RegExp;
  resolve(): void;
  reject(error: Error): void;
}

type Elicited =
  | { action: 'accept'; content: Record<string, string | number | boolean> }
  | { action: 'decline' | 'cancel' };

/**
 * Spawn the stdio child and connect the official client to it. The child is
 * closed after the test whatever its outcome, so a failed assertion cannot
 * leave a live child holding the test process open; `close` is memoized, so a
 * test may close it itself first.
 */
async function spawnChild(
  t: TestContext,
  mode: ClientMode,
  answer?: (message: string) => Elicited,
): Promise<Child> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CHILD],
    env: CHILD_ENV,
    stderr: 'pipe',
  });
  // Set before connect, which chains it into the client's own close handling,
  // so the exit is seen even when the child ends before the test closes it.
  const exited = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  let stderr = '';
  let stderrEnded = false;
  const watchers = new Set<StderrWatcher>();
  const missing = (line: RegExp): Error =>
    new Error(`the child's stderr ended without a line matching ${line}; it wrote:\n${stderr}`);
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    for (const watcher of watchers) {
      if (watcher.line.test(stderr)) {
        watchers.delete(watcher);
        watcher.resolve();
      }
    }
  });
  // The SDK pipes the child's stderr into this stream, which ends with it: a
  // line still awaited then will never come, so the wait fails with what the
  // child did write instead of running into the test timeout.
  transport.stderr?.on('end', () => {
    stderrEnded = true;
    for (const watcher of watchers) {
      watcher.reject(missing(watcher.line));
    }
    watchers.clear();
  });
  const stderrLine = (line: RegExp): Promise<void> =>
    new Promise((resolve, reject) => {
      const multiline = new RegExp(line.source, `${line.flags.replace('m', '')}m`);
      if (multiline.test(stderr)) {
        resolve();
      } else if (stderrEnded) {
        reject(missing(multiline));
      } else {
        watchers.add({ line: multiline, resolve, reject });
      }
    });
  const client = new Client(
    { name: 'stdio-client', version: '3.0.0' },
    {
      ...(answer === undefined ? {} : { capabilities: { elicitation: { form: {} } } }),
      versionNegotiation: {
        mode: mode === 'modern' ? { pin: '2026-07-28' } : mode === 'legacy' ? 'legacy' : 'auto',
      },
    },
  );
  if (answer !== undefined) {
    client.setRequestHandler('elicitation/create', (request) =>
      answer((request.params as { message: string }).message),
    );
  }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const running = transport.pid !== null;
      await client.close();
      // A client that never connected leaves the child to the transport.
      await transport.close();
      if (running) {
        await exited;
      }
    })();
    return closing;
  };
  t.after(close);
  await client.connect(transport);
  return { client, stderrLine, close };
}

// Each test spawns its own child and holds no state another reads, so they run
// at once: a child spends most of its life loading modules, and a modern or
// auto connection spawns two (the SDK probes on a disposable sibling first).
describe('serveMcpStdio with the official client', { concurrency: true }, () => {
  for (const mode of CLIENT_MODES) {
    it(`lists and calls in ${mode} mode, and the child exits when the client closes`, async (t) => {
      const child = await spawnChild(t, mode);
      const names = (await child.client.listTools()).tools.map((tool) => tool.name);
      assert.deepEqual(names, ['ask', 'cancelled', 'deploy', 'forever', 'slow', 'whoami']);
      assert.equal(
        textOf(await child.client.callTool({ name: 'whoami', arguments: {} })),
        'developer *',
      );
      assert.equal(
        child.client.getNegotiatedProtocolVersion(),
        mode === 'legacy' ? '2025-11-25' : '2026-07-28',
      );
      await child.close();
      await child.stderrLine(/^closed$/);
    });

    it(`runs the input flow and confirmation in ${mode} mode`, async (t) => {
      const asked: string[] = [];
      const child = await spawnChild(t, mode, (message): Elicited => {
        asked.push(message);
        return message === 'Deploy?'
          ? { action: 'accept', content: { confirm: true } }
          : { action: 'accept', content: { name: 'Ada' } };
      });
      assert.equal(
        textOf(await child.client.callTool({ name: 'ask', arguments: {} })),
        'Hello Ada (state {"round":1})',
      );
      assert.equal(
        textOf(await child.client.callTool({ name: 'deploy', arguments: {} })),
        'deployed',
      );
      assert.deepEqual(asked, ['Your name?', 'Deploy?']);
      await child.close();
    });
  }

  for (const mode of ['modern', 'legacy'] as const) {
    it(`stops a handler that keeps asking after maxInputRounds in ${mode} mode`, async (t) => {
      let rounds = 0;
      const child = await spawnChild(t, mode, () => {
        rounds += 1;
        return { action: 'accept', content: { ok: true } };
      });
      const outcome = await child.client.callTool({ name: 'forever', arguments: {} }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      assert.ok(!('error' in outcome), String('error' in outcome ? outcome.error : ''));
      assert.ok('result' in outcome, mode);
      assert.equal(outcome.result.isError, true);
      assert.deepEqual(outcome.result.structuredContent, {
        code: 'too_many_input_rounds',
        message: 'The tool asked for input more times than allowed.',
      });
      assert.equal(rounds, 3, 'the client answers exactly maxInputRounds rounds');
      await child.stderrLine(/^input_rounds_exceeded$/);
      assert.equal(
        textOf(await child.client.callTool({ name: 'whoami', arguments: {} })),
        'developer *',
      );
    });
  }

  it('declines through the legacy shim', async (t) => {
    const child = await spawnChild(t, 'legacy', () => ({ action: 'decline' }));
    assert.equal(textOf(await child.client.callTool({ name: 'ask', arguments: {} })), 'decline');
    await child.close();
  });

  for (const mode of ['modern', 'legacy'] as const) {
    it(`sends progress and aborts the handler on cancellation in ${mode} mode`, async (t) => {
      const child = await spawnChild(t, mode);
      // The SDK client dispatches a notification a microtask after it reads it
      // and a response at once, so a progress frame that arrives in the same
      // read as the result is dropped once the result settles the request
      // (common on macOS pipes). A handler that finishes right after reporting
      // therefore only proves the call completes; delivery is asserted on a
      // handler that waits until the client has seen its progress.
      const finished = await child.client.callTool({ name: 'slow', arguments: { wait: false } });
      assert.equal(textOf(finished), 'finished');
      const controller = new AbortController();
      const seen: number[] = [];
      let progressed: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        progressed = resolve;
      });
      const pending = child.client.callTool(
        { name: 'slow', arguments: { wait: true } },
        {
          signal: controller.signal,
          onprogress: (progress) => {
            seen.push(progress.progress);
            progressed();
          },
        },
      );
      await started;
      controller.abort();
      await assert.rejects(pending);
      assert.deepEqual(seen, [1]);
      await within(child.stderrLine(/^aborted$/), 'the slow handler seeing the cancellation');
      await child.close();
    });
  }
});
