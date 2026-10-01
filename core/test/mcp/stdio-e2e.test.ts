/**
 * `jsails mcp` end to end: the real CLI spawned as a child process and driven
 * by the official MCP client in modern, legacy, and auto modes, on a fixture
 * app whose config modules write to the console (at import and inside a tool
 * call) and to `process.stdout` directly.
 *
 * Every byte the child writes to stdout is recorded and must parse as a
 * JSON-RPC message; the app's output must arrive on stderr instead. The child
 * must exit on stdin end of file (even when an app module holds the event loop
 * open) and on SIGTERM and SIGINT.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  Client,
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';

const CLI = fileURLToPath(new URL('../../src/cli/index.js', import.meta.url));

type Mode = 'modern' | 'legacy' | 'auto';
const MODES: readonly Mode[] = ['modern', 'legacy', 'auto'];

const root = mkdtempSync(join(tmpdir(), 'jsails-mcp-e2e-'));
const children = new Set<ChildProcessWithoutNullStreams>();
after(() => {
  // A failed assertion leaves its child running; never leave one behind.
  for (const child of children) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});
let seq = 0;

const NOISY_APP = [
  "console.log('app config says hello');",
  "console.info('app config info');",
  "process.stdout.write('app config raw write\\n');",
  'export default {};',
  '',
].join('\n');

const NOISY_DATABASE = [
  'export default {',
  '  async getModelSchema() {',
  "    console.log('schema tool says hello');",
  "    return { tables: [{ name: 'posts', columns: [] }] };",
  '  },',
  '};',
  '',
].join('\n');

function fixture(extra: Readonly<Record<string, string>> = {}): string {
  const dir = join(root, `app-${seq++}`);
  const files: Record<string, string> = {
    'jsails.app.js': NOISY_APP,
    'jsails.database.js': NOISY_DATABASE,
    'pages/index.js': '',
    'pages/blog/[slug].js': '',
    ...extra,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return dir;
}

/** A client transport over a spawned child that records every stdout byte. */
class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  stdout = '';
  stderr = '';
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly buffer = new ReadBuffer();

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.exited = once(child, 'exit').then(([code, signal]) => ({
      code: code as number | null,
      signal: signal as NodeJS.Signals | null,
    }));
  }

  async start(): Promise<void> {
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.stdout += chunk.toString('utf8');
      this.buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (error) {
          this.onerror?.(error as Error);
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
    this.child.on('close', () => this.onclose?.());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.child.stdin.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.child.stdin.end();
  }
}

interface Running {
  readonly client: Client;
  readonly transport: RecordingTransport;
}

async function start(mode: Mode, cwd: string): Promise<Running> {
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    cwd,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const transport = new RecordingTransport(child);
  const client = new Client(
    { name: 'e2e', version: '1.0.0' },
    {
      versionNegotiation: {
        mode: mode === 'modern' ? { pin: '2026-07-28' } : mode === 'legacy' ? 'legacy' : 'auto',
      },
    },
  );
  await client.connect(transport);
  return { client, transport };
}

/** Every stdout line is one JSON-RPC 2.0 message; nothing else was written. */
function assertPureStdout(stdout: string): void {
  assert.ok(stdout.endsWith('\n'), 'stdout ends on a frame boundary');
  const lines = stdout.slice(0, -1).split('\n');
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    const message = JSON.parse(line) as { jsonrpc?: unknown };
    assert.equal(message.jsonrpc, '2.0', `not a JSON-RPC frame: ${line.slice(0, 80)}`);
  }
}

async function callText(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, name);
  const [block] = result.content as { type: string; text: string }[];
  return JSON.parse(block?.text ?? 'null') as Record<string, unknown>;
}

async function exercise(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['jsails_describe', 'jsails_inspect_routes', 'jsails_explain_route', 'jsails_schema'],
  );
  const explained = await callText(client, 'jsails_explain_route', { path: '/blog/hello' });
  assert.deepEqual(explained.paramValues, { slug: 'hello' });
  const schema = await callText(client, 'jsails_schema');
  assert.deepEqual(
    (schema.tables as { name: string }[]).map((table) => table.name),
    ['posts'],
  );
  await callText(client, 'jsails_describe');
}

// Each test spawns its own CLI on its own fixture directory, so they run at
// once instead of queueing behind each child's cold start.
describe('jsails mcp over stdio (spawned)', { concurrency: true }, () => {
  for (const mode of MODES) {
    it(`keeps stdout pure and exits on end of input (${mode})`, async () => {
      const { client, transport } = await start(mode, fixture());
      await exercise(client);
      assert.equal(
        client.getNegotiatedProtocolVersion(),
        mode === 'legacy' ? '2025-11-25' : '2026-07-28',
      );
      await client.close();
      const exit = await transport.exited;
      assert.deepEqual(exit, { code: 0, signal: null });
      assertPureStdout(transport.stdout);
      for (const text of [
        'app config says hello',
        'app config info',
        'app config raw write',
        'schema tool says hello',
      ]) {
        assert.ok(transport.stderr.includes(text), `${text} reached stderr`);
        assert.ok(!transport.stdout.includes(text), `${text} stayed off stdout`);
      }
    });
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    // Windows has no graceful signals: kill() terminates the child outright,
    // so the server's shutdown path cannot run there.
    it(
      `closes and exits cleanly on ${signal}`,
      { skip: process.platform === 'win32' && 'graceful signals are POSIX-only' },
      async () => {
        const { client, transport } = await start('auto', fixture());
        await exercise(client);
        transport.child.kill(signal);
        const exit = await transport.exited;
        assert.deepEqual(exit, { code: 0, signal: null });
        assertPureStdout(transport.stdout);
        await client.close();
      },
    );
  }

  it('exits after end of input even when an app module holds the event loop open', async () => {
    const dir = fixture({
      'jsails.app.js': `setInterval(() => undefined, 60_000);\n${NOISY_APP}`,
    });
    const { client, transport } = await start('modern', dir);
    await callText(client, 'jsails_inspect_routes');
    const closedAt = Date.now();
    await client.close();
    const exit = await transport.exited;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.ok(Date.now() - closedAt < 10_000, 'the grace period bounds the exit');
    assertPureStdout(transport.stdout);
  });

  it('reports a foreign failure on stderr while the client sees a generic error', async (t) => {
    if (process.platform === 'win32') {
      // Windows maps chmod to the read-only attribute, which does not stop
      // listing a directory, so the access is never denied there.
      t.skip('directory permissions are POSIX-only');
      return;
    }
    if (process.getuid?.() === 0) {
      t.skip('root ignores directory permissions');
      return;
    }
    const dir = fixture({ 'pages/locked/index.js': '' });
    const { chmodSync } = await import('node:fs');
    chmodSync(join(dir, 'pages', 'locked'), 0o000);
    try {
      const { client, transport } = await start('modern', dir);
      const result = await client.callTool({ name: 'jsails_inspect_routes', arguments: {} });
      assert.equal(result.isError, true);
      const [block] = result.content as { type: string; text: string }[];
      assert.equal(JSON.parse(block?.text ?? '{}').code, 'tool_failed');
      assert.ok(!transport.stdout.includes('EACCES'));
      await client.close();
      await transport.exited;
      assert.match(transport.stderr, /jsails_inspect_routes failed: EACCES/);
    } finally {
      chmodSync(join(dir, 'pages', 'locked'), 0o755);
    }
  });
});
