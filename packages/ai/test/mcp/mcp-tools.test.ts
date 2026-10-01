/**
 * `mcpTools`: a real client and scripted server round trip through the run
 * loop; result mapping (text, checked images, text resources, placeholders,
 * `structuredContent` as a fallback); `isError` forwarded or hidden;
 * cancellation reaching the server; approval rules (untrusted always,
 * trusted by annotations, `never`, and the untrusted guard); idempotency
 * only from trusted hints; skipped descriptors with reasons; include and
 * prefix; schema validation only for trusted servers; the authorize hook;
 * descriptions; media byte and image bounds on results; unparseable input
 * never reaching a server; the reserved `INVALID_JSON` property; and option
 * checks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { generate } from '../../src/run/run.js';
import { executeTool, parseToolInput, toolNeedsApproval } from '../../src/tools/tool-invocation.js';
import { AI_TOOL } from '../../src/tools/define-tool.js';
import { createFakeProvider } from '../../src/testing/fake-provider.js';
import {
  fromMcpClient,
  type McpToolDescriptor,
  type McpToolResultLike,
  type McpToolSource,
} from '../../src/mcp/mcp-source.js';
import { mcpTools, type McpTool, type McpToolsOptions } from '../../src/mcp/mcp-tools.js';
import { startScriptedServer } from './scripted-mcp-server.js';

const actor = { kind: 'user', id: 'u1' } as const;
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function descriptor(name: string, extra: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    name,
    description: `Tool ${name}.`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    ...extra,
  };
}

function source(
  tools: readonly unknown[],
  onCall: (name: string, args: unknown, signal: AbortSignal) => unknown = () => ({ content: [] }),
): McpToolSource {
  return {
    listTools: () => Promise.resolve(tools as readonly McpToolDescriptor[]),
    callTool: (name, args, options) =>
      Promise.resolve(onCall(name, args, options.signal) as McpToolResultLike),
  };
}

function ctx(signal: AbortSignal = new AbortController().signal) {
  return { actor, toolCallId: 'call_1', step: 0, signal };
}

async function only(result: unknown, options: Partial<McpToolsOptions> = {}): Promise<McpTool> {
  const { tools } = await mcpTools(
    source([descriptor('t')], () => result),
    {
      trusted: true,
      ...options,
    },
  );
  const tool = tools[0];
  assert.ok(tool !== undefined);
  return tool;
}

async function callOnce(result: unknown, options: Partial<McpToolsOptions> = {}) {
  return executeTool(await only(result, options), { q: 'x' }, ctx());
}

describe('mcpTools: round trip', () => {
  it('runs a server tool through the run loop with a real client', async () => {
    const server = await startScriptedServer(
      [descriptor('search', { annotations: { readOnlyHint: true } })],
      (name, args) => ({ content: [{ type: 'text', text: `${name}:${String(args.q)}` }] }),
    );
    try {
      const { tools, skipped } = await mcpTools(fromMcpClient(server.client), {
        trusted: true,
        prefix: 'docs_',
      });
      assert.deepEqual(skipped, []);
      assert.equal(tools[0]?.name, 'docs_search');
      const provider = createFakeProvider([
        { toolCalls: [{ name: 'docs_search', input: { q: 'sse' } }] },
        { text: 'found' },
      ]);
      const result = await generate({
        model: provider.model(),
        input: 'look it up',
        tools,
        context: { actor },
      });
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.steps[0]?.toolResults[0]?.output, [
        { type: 'text', text: 'search:sse' },
      ]);
      assert.equal(provider.requests[0]?.tools[0]?.strict, false);
      assert.ok(server.methods.includes('tools/call'));
    } finally {
      await server.close();
    }
  });

  it('forwards cancellation to the server', async () => {
    const server = await startScriptedServer(
      [descriptor('slow', { annotations: { readOnlyHint: true } })],
      () => new Promise(() => undefined),
    );
    try {
      const { tools } = await mcpTools(fromMcpClient(server.client), { trusted: true });
      const tool = tools[0];
      assert.ok(tool !== undefined);
      const controller = new AbortController();
      const outcome = executeTool(tool, { q: 'x' }, ctx(controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      assert.equal((await outcome).code, 'aborted');
      for (let wait = 0; wait < 50 && server.cancelled.length === 0; wait += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(server.cancelled.length, 1);
    } finally {
      await server.close();
    }
  });
});

describe('mcpTools: results', () => {
  it('maps text, checked images, text resources, and placeholders', async () => {
    const outcome = await callOnce({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
        { type: 'image', data: PNG, mimeType: 'image/jpeg' },
        { type: 'image', data: 'not base64!', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a', text: 'doc text' } },
        { type: 'resource', resource: { uri: 'file:///b', blob: 'AAAA' } },
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        { type: 'CANARY<script>' },
      ],
    });
    assert.equal(outcome.isError, false);
    assert.deepEqual(outcome.output, [
      { type: 'text', text: 'hello' },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: PNG } },
      { type: 'text', text: '[omitted MCP content: image]' },
      { type: 'text', text: '[omitted MCP content: image]' },
      { type: 'text', text: 'doc text' },
      { type: 'text', text: '[omitted MCP content: resource]' },
      { type: 'text', text: '[omitted MCP content: audio]' },
      { type: 'text', text: '[omitted MCP content: unknown]' },
    ]);
  });

  it('uses structuredContent only when the content has nothing usable', async () => {
    assert.deepEqual((await callOnce({ content: [], structuredContent: { temp: 21 } })).output, [
      { type: 'text', text: '{"temp":21}' },
    ]);
    assert.deepEqual(
      (
        await callOnce({
          content: [{ type: 'text', text: '21C' }],
          structuredContent: { temp: 21 },
        })
      ).output,
      [{ type: 'text', text: '21C' }],
    );
    assert.equal((await callOnce({ content: [] })).output, '');
  });

  it('forwards isError text, or hides it', async () => {
    const failing = { isError: true, content: [{ type: 'text', text: 'bad date' }] };
    const forwarded = await callOnce(failing);
    assert.deepEqual(forwarded, { output: 'error: bad date', isError: true, code: 'tool_failed' });
    const hidden = await callOnce(failing, { errors: 'hide' });
    assert.deepEqual(hidden, {
      output: 'error: the tool failed',
      isError: true,
      code: 'tool_failed',
    });
    const silent = await callOnce({ isError: true, content: [] });
    assert.equal(silent.output, 'error: the tool failed');
  });

  it('turns a malformed result into the fixed failure', async () => {
    const outcome = await callOnce({ content: 'CANARY' });
    assert.deepEqual(outcome, {
      output: 'error: the tool failed',
      isError: true,
      code: 'tool_failed',
    });
  });
});

describe('mcpTools: trust and approval', () => {
  const annotated = [
    descriptor('plain'),
    descriptor('reader', { annotations: { readOnlyHint: true } }),
    descriptor('safe', { annotations: { destructiveHint: false } }),
    descriptor('again', { annotations: { idempotentHint: true } }),
  ];

  async function approvals(options: McpToolsOptions): Promise<Record<string, [boolean, boolean]>> {
    const { tools } = await mcpTools(source(annotated), options);
    const out: Record<string, [boolean, boolean]> = {};
    for (const tool of tools) {
      out[tool.name] = [await toolNeedsApproval(tool, { q: 'x' }, ctx()), tool.idempotent];
    }
    return out;
  }

  it('an untrusted server always needs approval and never re-runs', async () => {
    assert.deepEqual(await approvals({ trusted: false }), {
      plain: [true, false],
      reader: [true, false],
      safe: [true, false],
      again: [true, false],
    });
  });

  it('a trusted server uses its annotations as hints', async () => {
    assert.deepEqual(await approvals({ trusted: true }), {
      plain: [true, false],
      reader: [false, true],
      safe: [false, false],
      again: [true, true],
    });
    const never = await approvals({ trusted: true, approval: 'never' });
    assert.ok(Object.values(never).every(([needs]) => !needs));
    const always = await approvals({ trusted: true, approval: 'always' });
    assert.ok(Object.values(always).every(([needs]) => needs));
  });

  it('refuses any approval but always for an untrusted server', async () => {
    for (const approval of ['destructive', 'never'] as const) {
      await assert.rejects(
        mcpTools(source(annotated), { trusted: false, approval }),
        (error) =>
          error instanceof AiError &&
          error.code === 'invalid_options' &&
          error.context.reason === 'approval_untrusted',
      );
    }
  });

  it('stops an untrusted call for approval in a run', async () => {
    const { tools } = await mcpTools(source([descriptor('delete')]), { trusted: false });
    const provider = createFakeProvider([{ toolCalls: [{ name: 'delete', input: { q: 'x' } }] }]);
    const result = await generate({
      model: provider.model(),
      input: 'go',
      tools,
      context: { actor },
    });
    assert.equal(result.status, 'awaiting-approval');
    assert.equal(result.pendingApprovals[0]?.name, 'delete');
  });
});

describe('mcpTools: listing', () => {
  it('skips malformed, misnamed, duplicate, and unusable tools with reasons', async () => {
    const { tools, skipped } = await mcpTools(
      source([
        descriptor('good'),
        'CANARY',
        { name: 5, inputSchema: { type: 'object' } },
        descriptor('bad', { annotations: { readOnlyHint: 'yes' } as never }),
        descriptor('has space'),
        descriptor('x'.repeat(70)),
        descriptor('good'),
        descriptor('array', { inputSchema: { type: 'array' } }),
        descriptor('remote', {
          inputSchema: { type: 'object', properties: { a: { $ref: 'https://evil/x' } } },
        }),
      ]),
      { trusted: true },
    );
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['good'],
    );
    assert.deepEqual(skipped, [
      { name: '', reason: 'malformed' },
      { name: '', reason: 'malformed' },
      { name: 'bad', reason: 'malformed' },
      { name: 'has space', reason: 'name' },
      { name: 'x'.repeat(70), reason: 'name' },
      { name: 'good', reason: 'duplicate' },
      { name: 'array', reason: 'input_schema' },
      { name: 'remote', reason: 'input_schema' },
    ]);
  });

  it('keeps only included tools, under the prefix', async () => {
    const { tools } = await mcpTools(source([descriptor('a'), descriptor('b')]), {
      trusted: false,
      include: ['b'],
      prefix: 'srv_',
    });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['srv_b'],
    );
  });

  it('falls back to the title for a description and caps its length', async () => {
    const { tools } = await mcpTools(
      source([
        { name: 'a', title: 'Alpha tool', inputSchema: { type: 'object' } },
        { name: 'b', inputSchema: { type: 'object' } },
        { name: 'c', description: 'd'.repeat(5000), inputSchema: { type: 'object' } },
      ]),
      { trusted: true },
    );
    assert.equal(tools[0]?.description, 'Alpha tool');
    assert.equal(tools[1]?.description, 'The b tool.');
    assert.equal(tools[2]?.description.length, 4096);
  });

  it('rejects a malformed listing from a custom source', async () => {
    const broken: McpToolSource = {
      listTools: () => Promise.resolve('CANARY' as unknown as readonly McpToolDescriptor[]),
      callTool: () => Promise.resolve({ content: [] }),
    };
    await assert.rejects(
      mcpTools(broken, { trusted: true }),
      (error) => error instanceof AiError && error.code === 'mcp_failed',
    );
  });
});

describe('mcpTools: input and authorization', () => {
  it('validates against the schema only for a trusted server', async () => {
    const trusted = await only({ content: [] });
    const rejected = parseToolInput(trusted, { q: 5 }, 'loose');
    assert.equal(rejected.ok, false);
    assert.match(rejected.ok ? '' : String(rejected.outcome.output), /q: invalid_type/);
    const { tools } = await mcpTools(source([descriptor('t')]), { trusted: false });
    const untrusted = tools[0];
    assert.ok(untrusted !== undefined);
    assert.equal(parseToolInput(untrusted, { q: 5 }, 'loose').ok, true);
    assert.equal(parseToolInput(untrusted, ['not', 'object'], 'loose').ok, false);
    assert.equal(untrusted[AI_TOOL].validateInput({ n: 1n }).ok, false);
  });

  it('asks the authorize hook with the server name', async () => {
    const seen: unknown[] = [];
    const tool = await only(
      { content: [{ type: 'text', text: 'ok' }] },
      {
        prefix: 'p_',
        authorize: (call, context) => {
          seen.push(call.name, call.input, context.actor.id);
          return call.input.q !== 'blocked';
        },
      },
    );
    assert.equal((await executeTool(tool, { q: 'fine' }, ctx())).isError, false);
    const denied = await executeTool(tool, { q: 'blocked' }, ctx());
    assert.equal(denied.code, 'tool_denied');
    assert.deepEqual(seen.slice(0, 3), ['t', { q: 'fine' }, 'u1']);
  });

  it('applies the timeout, the result cap, and browser exposure', async () => {
    const tool = await only(
      { content: [{ type: 'text', text: 'abcdefghij' }] },
      { timeoutMs: 1234, maxResultChars: 5, exposeToBrowser: true },
    );
    assert.equal(tool.timeoutMs, 1234);
    assert.equal(tool.exposeToBrowser, true);
    const outcome = await executeTool(tool, { q: 'x' }, ctx());
    assert.equal(outcome.isError, false);
    assert.deepEqual(outcome.output, [{ type: 'text', text: 'abcde' }]);
  });

  it('bounds image content by media bytes and image count', async () => {
    const images = Array.from({ length: 50 }, () => ({
      type: 'image',
      data: PNG,
      mimeType: 'image/png',
    }));
    const marker = { type: 'text', text: '[output truncated]' };
    const bySize = await mcpTools(
      source([descriptor('t')], () => ({ content: images })),
      { trusted: false, maxResultMediaBytes: 100 },
    );
    const sizeTool = bySize.tools[0];
    assert.ok(sizeTool !== undefined);
    assert.equal(sizeTool.maxResultMediaBytes, 100);
    const sized = await executeTool(sizeTool, { q: 'x' }, ctx(), { maxResultChars: 100 });
    assert.equal(sized.isError, false);
    assert.deepEqual(sized.output, [
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: PNG } },
      marker,
    ]);

    const counted = await executeTool(await only({ content: images }), { q: 'x' }, ctx(), {
      maxResultImages: 3,
    });
    assert.equal(Array.isArray(counted.output) ? counted.output.length : 0, 4);
    const unbounded = await executeTool(await only({ content: images }), { q: 'x' }, ctx());
    assert.ok(Array.isArray(unbounded.output));
    assert.equal(unbounded.output.filter((item) => item.type === 'image').length, 16);
  });

  it('never sends unparseable model input to an untrusted server', async () => {
    const calls: unknown[] = [];
    const { tools } = await mcpTools(
      source([descriptor('t', { inputSchema: { type: 'object' } })], (name, args) => {
        calls.push([name, args]);
        return { content: [{ type: 'text', text: 'ran' }] };
      }),
      { trusted: false },
    );
    const tool = tools[0];
    assert.ok(tool !== undefined);
    const parsed = parseToolInput(tool, { INVALID_JSON: '{"q":"drop table' }, 'loose');
    assert.equal(parsed.ok, false);
    const provider = createFakeProvider([
      { toolCalls: [{ id: 'c1', name: 't', input: { INVALID_JSON: '{"q":"drop table' } }] },
      { text: 'sorry' },
    ]);
    const result = await generate({
      model: provider.model(),
      input: 'go',
      tools,
      context: { actor },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.steps[0]?.toolResults[0]?.isError, true);
    assert.deepEqual(calls, []);
  });

  it('skips a server tool that declares the reserved INVALID_JSON property', async () => {
    const { tools, skipped } = await mcpTools(
      source([
        descriptor('t', {
          inputSchema: { type: 'object', properties: { INVALID_JSON: { type: 'string' } } },
        }),
      ]),
      { trusted: true },
    );
    assert.deepEqual(tools, []);
    assert.deepEqual(skipped, [{ name: 't', reason: 'input_schema' }]);
  });

  it('rejects bad options', async () => {
    const bad: unknown[] = [
      null,
      {},
      { trusted: 'yes' },
      { trusted: true, approval: 'sometimes' },
      { trusted: true, errors: 'loud' },
      { trusted: true, prefix: 'bad prefix' },
      { trusted: true, include: [1] },
      { trusted: true, authorize: 'no' },
      { trusted: true, exposeToBrowser: 1 },
      { trusted: true, timeoutMs: 0 },
      { trusted: true, maxResultChars: -1 },
      { trusted: true, maxResultMediaBytes: 0 },
      { trusted: true, signal: {} },
    ];
    for (const options of bad) {
      await assert.rejects(
        mcpTools(source([]), options as McpToolsOptions),
        (error) => error instanceof AiError && error.code === 'invalid_options',
      );
    }
    await assert.rejects(
      mcpTools({} as McpToolSource, { trusted: true }),
      (error) => error instanceof AiError && error.code === 'invalid_options',
    );
  });
});
