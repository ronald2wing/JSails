/**
 * Developer MCP server tests over the official client and an in-memory
 * transport, in modern (2026-07-28), legacy (2025), and auto modes: the golden
 * tools/list, structured answers, closed input schemas, value-free errors
 * (config_unavailable, routes_unavailable, invalid_arguments, and a generic
 * tool_failed for foreign throws), the package version, the instructions,
 * close on abort, and a stdio run that stops listening for signals after the
 * first. The tool set is also checked directly for config binding.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import {
  createJsailsMcpTools,
  JSAILS_MCP_TOOL_ANNOTATIONS,
  JsailsMcpToolError,
} from '../../src/mcp/builtin-tools.js';
import type { SignalSource } from '../../src/cli/shutdown.js';
import {
  runJsailsDevMcp,
  serveJsailsDevMcp,
  type JsailsDevMcpOptions,
} from '../../src/mcp/server.js';

type Mode = 'modern' | 'legacy' | 'auto';
const MODES: readonly Mode[] = ['modern', 'legacy', 'auto'];

const root = mkdtempSync(join(tmpdir(), 'jsails-mcp-dev-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

/** A compiled app on disk: an app config, two pages, and an API route. */
function app(files: Readonly<Record<string, string>> = {}): string {
  const dir = join(root, `app-${seq++}`);
  const all: Record<string, string> = {
    'jsails.app.js': 'export default {};\n',
    'pages/index.js': '',
    'pages/blog/[slug].js': '',
    'api/users.js': '',
    ...files,
  };
  for (const [relative, contents] of Object.entries(all)) {
    const absolute = join(dir, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return dir;
}

interface Session {
  readonly client: Client;
  readonly logs: string[];
  close(): Promise<void>;
}

async function connect(
  mode: Mode,
  options: JsailsDevMcpOptions & { readonly version?: string } = {},
): Promise<Session> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const logs: string[] = [];
  const served = serveJsailsDevMcp({
    ...options,
    transport: serverSide,
    log: (line) => logs.push(line),
  });
  const client = new Client(
    { name: 'dev-test', version: '1.0.0' },
    {
      versionNegotiation: {
        mode: mode === 'modern' ? { pin: '2026-07-28' } : mode === 'legacy' ? 'legacy' : 'auto',
      },
    },
  );
  await client.connect(clientSide);
  return {
    client,
    logs,
    close: async () => {
      await client.close();
      await served;
    },
  };
}

interface ToolOutcome {
  readonly isError: boolean;
  readonly body: Record<string, unknown>;
  readonly text: string;
  readonly structured: unknown;
}

async function call(session: Session, name: string, args: Record<string, unknown> = {}) {
  const result = await session.client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, 'text');
  const text = content[0]?.text ?? '';
  const outcome: ToolOutcome = {
    isError: result.isError === true,
    body: JSON.parse(text) as Record<string, unknown>,
    text,
    structured: result.structuredContent,
  };
  assert.deepEqual(outcome.structured, outcome.body, 'structuredContent mirrors the text block');
  return outcome;
}

const NO_ARGUMENTS = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const GOLDEN_TOOLS = [
  { name: 'jsails_describe', title: 'Describe the app', inputSchema: NO_ARGUMENTS },
  { name: 'jsails_inspect_routes', title: 'List routes', inputSchema: NO_ARGUMENTS },
  {
    name: 'jsails_explain_route',
    title: 'Explain a request path',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description: 'The request path to resolve, such as /blog/hello',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  { name: 'jsails_schema', title: 'Entity schema', inputSchema: NO_ARGUMENTS },
];

const packageVersion = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

for (const mode of MODES) {
  describe(`developer MCP server (${mode})`, () => {
    it('lists the golden tool set: closed schemas and read-only, idempotent, closed-world hints', async () => {
      const session = await connect(mode, { configPath: join(app(), 'jsails.app.js') });
      try {
        const { tools } = await session.client.listTools();
        assert.deepEqual(
          tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            inputSchema: tool.inputSchema,
          })),
          GOLDEN_TOOLS,
        );
        for (const tool of tools) {
          assert.deepEqual(tool.annotations, {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: false,
          });
          assert.ok((tool.description ?? '').length > 20, `${tool.name} has a description`);
        }
      } finally {
        await session.close();
      }
    });

    it('reports the framework package version and instructions', async () => {
      const session = await connect(mode);
      try {
        assert.deepEqual(session.client.getServerVersion(), {
          name: 'jsails',
          version: packageVersion,
        });
        assert.match(session.client.getInstructions() ?? '', /jsails_describe/);
        assert.equal(
          session.client.getNegotiatedProtocolVersion(),
          mode === 'legacy' ? '2025-11-25' : '2026-07-28',
        );
      } finally {
        await session.close();
      }
    });

    it('answers routes, explain, describe, and schema with structured content', async () => {
      const dir = app({
        'jsails.database.js':
          "export default { async getModelSchema() { return { tables: [{ name: 'posts', columns: [] }] }; } };\n",
      });
      const session = await connect(mode, {
        configPath: join(dir, 'jsails.app.js'),
        dbConfigPath: join(dir, 'jsails.database.js'),
      });
      try {
        const routes = await call(session, 'jsails_inspect_routes');
        assert.equal(routes.isError, false);
        assert.equal(routes.body.source, 'scan');
        assert.deepEqual(
          (routes.body.data as { route: string }[]).map((route) => route.route).sort(),
          ['/', '/api/users', '/blog/:slug'],
        );

        const explained = await call(session, 'jsails_explain_route', { path: '/blog/hello' });
        assert.equal(explained.isError, false);
        assert.equal(explained.body.matched, true);
        assert.deepEqual(explained.body.paramValues, { slug: 'hello' });

        const describeResult = await call(session, 'jsails_describe');
        assert.equal(describeResult.isError, false);
        assert.ok('routes' in describeResult.body);

        const schema = await call(session, 'jsails_schema');
        assert.deepEqual(
          (schema.body.tables as { name: string }[]).map((table) => table.name),
          ['posts'],
        );
      } finally {
        await session.close();
      }
    });

    it('answers an unmatched path with matched: false, not an error', async () => {
      const session = await connect(mode, { configPath: join(app(), 'jsails.app.js') });
      try {
        const outcome = await call(session, 'jsails_explain_route', { path: '/nowhere/at/all' });
        assert.equal(outcome.isError, false);
        assert.equal(outcome.body.matched, false);
      } finally {
        await session.close();
      }
    });

    it('reports a config that does not load as config_unavailable on every config tool', async () => {
      const dir = app({ 'jsails.app.js': 'export default { pagesDir: 42 };\n' });
      const session = await connect(mode, { configPath: join(dir, 'jsails.app.js') });
      try {
        for (const [name, args] of [
          ['jsails_describe', {}],
          ['jsails_inspect_routes', {}],
          ['jsails_explain_route', { path: '/' }],
        ] as const) {
          const outcome = await call(session, name, args);
          assert.equal(outcome.isError, true, name);
          assert.equal(outcome.body.code, 'config_unavailable', name);
          assert.equal(typeof outcome.body.suggestion, 'string');
          assert.ok(!outcome.text.includes(dir), 'no path in the tool error');
        }
        assert.equal(session.logs.length, 3, 'each failure is logged with its cause');
        assert.match(session.logs[0] ?? '', /jsails_describe: the app config module/);
      } finally {
        await session.close();
      }
    });

    it('rejects undeclared and malformed arguments before any config loads', async () => {
      const marker = `__jsailsMcpArgs${seq}`;
      const dir = app({ 'jsails.app.js': `globalThis.${marker} = true;\nexport default {};\n` });
      const globals = globalThis as Record<string, unknown>;
      const session = await connect(mode, { configPath: join(dir, 'jsails.app.js') });
      try {
        for (const [name, args] of [
          ['jsails_describe', { configPath: '/etc/secret-module.js' }],
          ['jsails_explain_route', {}],
          ['jsails_explain_route', { path: '' }],
          ['jsails_explain_route', { path: 7 }],
          ['jsails_explain_route', { path: '/', method: 'GET' }],
        ] as const) {
          const outcome = await call(session, name, args);
          assert.equal(outcome.isError, true, `${name} ${JSON.stringify(args)}`);
          assert.equal(outcome.body.code, 'invalid_arguments');
          assert.ok(!outcome.text.includes('secret-module'), 'no argument value is echoed');
        }
        assert.equal(globals[marker], undefined, 'the config was never loaded');
      } finally {
        delete globals[marker];
        await session.close();
      }
    });

    it('turns a foreign error into a generic tool_failed and logs the detail', async (t) => {
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
      const dir = app();
      const locked = join(dir, 'pages', 'blog');
      chmodSync(locked, 0o000);
      const session = await connect(mode, { configPath: join(dir, 'jsails.app.js') });
      try {
        const outcome = await call(session, 'jsails_inspect_routes');
        assert.equal(outcome.isError, true);
        assert.deepEqual(outcome.body, {
          code: 'tool_failed',
          message: 'the tool failed; the server log has the details',
        });
        assert.ok(!outcome.text.includes('EACCES'));
        assert.ok(!outcome.text.includes(dir));
        // The log names the failure value-free: the errno code, never the
        // message, which quotes the locked path.
        const log = session.logs.join('\n');
        assert.match(
          log,
          /jsails mcp: jsails_inspect_routes failed: an error that is not a framework error\n {2}error: Error EACCES \(scandir\)/,
        );
        assert.ok(!log.includes(locked));

        const explained = await call(session, 'jsails_explain_route', { path: '/' });
        assert.equal(explained.body.code, 'routes_unavailable');
      } finally {
        chmodSync(locked, 0o755);
        await session.close();
      }
    });
  });
}

describe('developer MCP server lifecycle', () => {
  it('resolves when the signal aborts, and immediately for an aborted signal', async () => {
    for (const preAborted of [false, true]) {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const controller = new AbortController();
      if (preAborted) controller.abort();
      const served = serveJsailsDevMcp({
        transport: serverSide,
        signal: controller.signal,
        log: () => undefined,
      });
      await clientSide.start();
      controller.abort();
      await served;
    }
  });

  it('stops listening on the first signal, so a second one ends the process', async () => {
    const signals = new EventEmitter() as EventEmitter & SignalSource;
    const stdin = new PassThrough();
    const run = runJsailsDevMcp(
      {},
      { stdin, stdout: new PassThrough(), stderr: new PassThrough(), signals },
    );
    assert.equal(signals.listenerCount('SIGINT'), 1);
    assert.equal(signals.listenerCount('SIGTERM'), 1);
    signals.emit('SIGINT', 'SIGINT');
    // Before the stop has settled: with no listener left, Node's default
    // handling ends the process on the next SIGINT or SIGTERM, however long
    // the graceful stop takes.
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    await run;
    stdin.destroy();
  });

  it('uses an explicit version when one is given', async () => {
    const session = await connect('modern', { version: '0.0.1-test' });
    try {
      assert.equal(session.client.getServerVersion()?.version, '0.0.1-test');
    } finally {
      await session.close();
    }
  });
});

describe('developer tool set', () => {
  it('builds frozen tools with the shared annotations', () => {
    const tools = createJsailsMcpTools();
    assert.ok(Object.isFrozen(tools));
    for (const tool of tools) {
      assert.ok(Object.isFrozen(tool));
      assert.ok(Object.isFrozen(tool.inputSchema));
      assert.equal(tool.annotations, JSAILS_MCP_TOOL_ANNOTATIONS);
    }
  });

  it('never loads a config module named by the caller', async () => {
    const dir = app();
    const marker = '__jsailsMcpCallerModuleRan';
    const globals = globalThis as Record<string, unknown>;
    const callerModule = join(dir, 'caller.js');
    writeFileSync(callerModule, `globalThis.${marker} = true;\nexport default {};\n`);
    try {
      for (const tool of createJsailsMcpTools({ configPath: join(dir, 'missing.app.js') })) {
        await tool
          .call({ path: '/', configPath: callerModule, dbConfigPath: callerModule })
          .catch(() => undefined);
        await tool.call({ path: '/' }).catch(() => undefined);
      }
      assert.equal(globals[marker], undefined, 'the caller-named module was executed');
    } finally {
      delete globals[marker];
    }
  });

  it('answers jsails_schema from the database config alone', async () => {
    const dir = app();
    const dbConfigPath = join(dir, 'jsails.database.js');
    writeFileSync(
      dbConfigPath,
      "export default { async getModelSchema() { return { tables: [{ name: 'posts', columns: [] }] }; } };\n",
    );
    const schemaTool = createJsailsMcpTools({
      configPath: join(dir, 'missing.app.js'),
      dbConfigPath,
    }).find((tool) => tool.name === 'jsails_schema');
    const schema = (await schemaTool?.call(undefined)) as { tables: { name: string }[] };
    assert.deepEqual(
      schema.tables.map((table) => table.name),
      ['posts'],
    );
  });

  it('carries the inner config error code as context on config_unavailable', async () => {
    const [describeTool] = createJsailsMcpTools({ configPath: join(root, 'absent.app.js') });
    await assert.rejects(
      describeTool?.call({}) ?? Promise.resolve(),
      (error: unknown) =>
        error instanceof JsailsMcpToolError &&
        error.code === 'config_unavailable' &&
        typeof error.context.reason === 'string' &&
        error.cause !== undefined,
    );
  });
});
