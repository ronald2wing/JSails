/**
 * MCP tool registry + in-process client tests (the JSails-owned surface).
 *
 * The JSON-RPC/stdio transport is now the official `@modelcontextprotocol`
 * SDK; what remains JSails-owned — and what these tests cover — is the tool
 * registry (duplicate rejection) and the in-process client (list/call).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';

import { createInProcessMcpClient } from '../../src/mcp/client.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import {
  createMcpToolRegistry,
  defineMcpTool,
  McpToolError,
  type McpToolRegistry,
} from '../../src/mcp/tool.js';
import { createJsailsMcpTools, jsailsMcpTools } from '../../src/mcp/builtin-tools.js';

/** A minimal JSON-RPC client over the SDK's in-memory transport. */
async function connect(tools: McpToolRegistry) {
  const server = buildMcpServer({ name: 'test', version: '1.0.0', tools });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  client.onmessage = (message: JSONRPCMessage) => {
    const record = message as unknown as Record<string, unknown>;
    if (typeof record.id === 'number') pending.get(record.id)?.(record);
  };
  await server.connect(serverSide);
  await client.start();
  let nextId = 0;
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolveResponse) => {
      nextId += 1;
      pending.set(nextId, resolveResponse);
      void client.send({ jsonrpc: '2.0', id: nextId, method, params });
    });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    request,
    close: async () => {
      await server.close();
    },
  };
}

describe('McpToolRegistry', () => {
  it('rejects duplicate tool names', () => {
    const tool = defineMcpTool({
      name: 'dup',
      description: 'first',
      async handler() {
        return {};
      },
    });
    assert.throws(() => createMcpToolRegistry([tool, tool]), McpToolError);
  });

  it('lists definitions with name + description', () => {
    const registry = createMcpToolRegistry([
      defineMcpTool({ name: 'a', description: 'A', async handler() {} }),
    ]);
    assert.deepEqual(
      registry.list().map((t) => t.name),
      ['a'],
    );
  });
});

describe('in-process MCP client', () => {
  it('lists and calls a tool', async () => {
    const registry = createMcpToolRegistry([
      defineMcpTool({
        name: 'greet',
        description: 'greet',
        async handler(args) {
          return { greeting: `hello ${String(args.name)}` };
        },
      }),
    ]);
    const client = createInProcessMcpClient(registry);
    assert.equal((await client.listTools()).length, 1);
    const result = await client.callTool('greet', { name: 'x' });
    assert.deepEqual(result.content, [{ type: 'text', text: '{"greeting":"hello x"}' }]);
  });
});

describe('jsails built-in tools', () => {
  it('ships the introspection tool set', () => {
    const names = jsailsMcpTools.map((tool) => tool.definition.name).sort();
    assert.ok(names.includes('jsails_describe'));
    assert.ok(names.includes('jsails_inspect_routes'));
    assert.ok(names.includes('jsails_explain_route'));
    assert.ok(names.includes('jsails_schema'));
  });
});

describe('MCP server protocol surface', () => {
  const echo = defineMcpTool({
    name: 'echo',
    description: 'echo the arguments',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    async handler(args) {
      return args;
    },
  });

  it('advertises each tool input schema in tools/list', async () => {
    const session = await connect(createMcpToolRegistry([echo]));
    try {
      const response = await session.request('tools/list', {});
      const tools = (response.result as { tools: Array<Record<string, unknown>> }).tools;
      assert.deepEqual(tools[0]?.inputSchema, {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      });
    } finally {
      await session.close();
    }
  });

  it('passes the client arguments to the tool handler', async () => {
    const session = await connect(createMcpToolRegistry([echo]));
    try {
      const response = await session.request('tools/call', {
        name: 'echo',
        arguments: { path: '/blog/hello' },
      });
      assert.deepEqual(response.result, {
        content: [{ type: 'text', text: '{"path":"/blog/hello"}' }],
      });
    } finally {
      await session.close();
    }
  });

  it('rejects arguments that do not match the schema before the handler runs', async () => {
    let calls = 0;
    const counted = defineMcpTool({
      ...echo.definition,
      async handler() {
        calls += 1;
        return {};
      },
    });
    const session = await connect(createMcpToolRegistry([counted]));
    try {
      const response = await session.request('tools/call', { name: 'echo', arguments: {} });
      assert.equal((response.result as { isError?: boolean }).isError, true);
      assert.equal(calls, 0);
    } finally {
      await session.close();
    }
  });

  it('advertises the explain_route path argument and no config path arguments', async () => {
    const session = await connect(createMcpToolRegistry(jsailsMcpTools));
    try {
      const response = await session.request('tools/list', {});
      const tools = (
        response.result as {
          tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
        }
      ).tools;
      const explain = tools.find((tool) => tool.name === 'jsails_explain_route');
      assert.ok(explain?.inputSchema.properties?.path !== undefined);
      for (const tool of tools) {
        const properties = Object.keys(tool.inputSchema.properties ?? {});
        assert.ok(!properties.includes('configPath'), `${tool.name} exposes configPath`);
        assert.ok(!properties.includes('dbConfigPath'), `${tool.name} exposes dbConfigPath`);
      }
    } finally {
      await session.close();
    }
  });
});

describe('built-in tool config binding', () => {
  it('never loads a config module named by the caller', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsails-mcp-bind-'));
    const marker = '__jsailsMcpCallerModuleRan';
    const globals = globalThis as Record<string, unknown>;
    try {
      const callerModule = join(dir, 'caller.js');
      writeFileSync(callerModule, `globalThis.${marker} = true;\nexport default {};\n`);
      const registry = createMcpToolRegistry(
        createJsailsMcpTools({ configPath: join(dir, 'missing.app.js') }),
      );
      for (const name of ['jsails_describe', 'jsails_inspect_routes', 'jsails_schema']) {
        await registry
          .call(name, { configPath: callerModule, dbConfigPath: callerModule })
          .catch(() => undefined);
      }
      await registry
        .call('jsails_explain_route', { path: '/', configPath: callerModule })
        .catch(() => undefined);
      assert.equal(globals[marker], undefined, 'the caller-named module was executed');
    } finally {
      delete globals[marker];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing explain path as a value-free tool error', async () => {
    const registry = createMcpToolRegistry(jsailsMcpTools);
    await assert.rejects(
      registry.call('jsails_explain_route', {}),
      (error: unknown) => error instanceof McpToolError && error.code === 'invalid_argument',
    );
  });
});
