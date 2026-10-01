/**
 * The server factory on a real wire: the official client against the SDK HTTP
 * entry in both eras, and over an in-memory transport. Covers listing order
 * and descriptors, structured output and its conformance, the error mapping
 * (tool failures, generic failures, invalid arguments, timeouts, result cap),
 * the context (signal, progress, client info, actor), resources, templates,
 * prompts, completion, cache hints, the gate (allow, hidden, challenge,
 * throwing and malformed gates), and the properties that the listed set is the
 * callable set, that hidden and nonexistent items fail identically, and that
 * no foreign error text reaches a response: unknown names get one fixed text,
 * and a throwing args or params schema a generic failure. On a connected
 * legacy unit, input requests in modes the client did not declare answer
 * `input_unavailable`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  publicAccess,
  type McpActor,
  type McpAuthorize,
  type McpGateDecision,
} from '../src/access.js';
import { toolResult } from '../src/content.js';
import {
  defineMcpPrompt,
  defineMcpResource,
  defineMcpResourceTemplate,
  defineMcpServer,
  defineMcpTool,
  type McpTool,
} from '../src/definitions.js';
import { MCP_ERROR_CODES, McpDefinitionError, McpToolFailure } from '../src/errors.js';
import { inputRequired } from '../src/input-required.js';
import { createMcpServerFactory, type McpServingOptions } from '../src/server-factory.js';
import { ERAS, errorSink, forAll, overHttp, overMemory, rejection, USER } from './fixtures.js';

const open = publicAccess('test fixture');

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((block) => block.text ?? '').join('');
}

function serve(spec: Parameters<typeof defineMcpServer>[0], options: McpServingOptions = {}) {
  return createMcpServerFactory(defineMcpServer(spec), options);
}

describe('createMcpServerFactory', () => {
  it('rejects foreign servers, bad options, and gated servers without a gate', () => {
    assert.throws(
      () => createMcpServerFactory({ kind: 'server', name: 'x', version: '1' }),
      (error: unknown) =>
        error instanceof McpDefinitionError && error.code === 'invalid_definition',
    );
    const server = defineMcpServer({ name: 's', version: '1' });
    for (const options of [
      { timeoutMs: 0 },
      { maxResultBytes: -1 },
      { maxToolInputElements: 1.5 },
      { authorize: 'x' },
    ]) {
      assert.throws(
        () => createMcpServerFactory(server, options as McpServingOptions),
        (error: unknown) => error instanceof McpDefinitionError && error.code === 'invalid_option',
      );
    }
    const gated = defineMcpServer({
      name: 's',
      version: '1',
      tools: [
        defineMcpTool({
          name: 't',
          description: 'd',
          access: { role: 'admin' },
          handler: () => 'x',
        }),
      ],
    });
    assert.throws(
      () => createMcpServerFactory(gated),
      (error: unknown) => error instanceof McpDefinitionError && error.code === 'missing_gate',
    );
  });

  for (const era of ERAS) {
    describe(`over HTTP, ${era} era`, () => {
      it('lists tools in name order with precomputed descriptors and no listChanged', async () => {
        const harness = overHttp(
          serve({
            name: 'notes',
            version: '2.0.0',
            title: 'Notes',
            instructions: 'Use search first.',
            tools: [
              defineMcpTool({
                name: 'zeta',
                description: 'Last.',
                access: open,
                handler: () => 'z',
              }),
              defineMcpTool({
                name: 'alpha',
                title: 'Alpha',
                description: 'First.',
                input: z.object({ q: z.string().describe('Query') }),
                output: z.object({ hits: z.number() }),
                annotations: { readOnly: true, openWorld: false },
                icons: [{ src: 'https://x.example/i.png', sizes: ['48x48'] }],
                access: open,
                handler: () => ({ hits: 1 }),
              }),
            ],
          }),
        );
        const client = await harness.connect(era);
        const { tools } = await client.listTools();
        assert.deepEqual(
          tools.map((tool) => tool.name),
          ['alpha', 'zeta'],
        );
        const [alpha, zeta] = tools;
        assert.equal(alpha?.title, 'Alpha');
        assert.deepEqual(alpha?.annotations, { readOnlyHint: true, openWorldHint: false });
        assert.deepEqual(alpha?.icons, [{ src: 'https://x.example/i.png', sizes: ['48x48'] }]);
        assert.equal(
          (alpha?.inputSchema.properties as Record<string, { description?: string }>).q
            ?.description,
          'Query',
        );
        assert.equal(alpha?.outputSchema?.type, 'object');
        assert.deepEqual(zeta?.inputSchema, {
          type: 'object',
          properties: {},
          additionalProperties: false,
        });
        assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: false });
        assert.equal(client.getServerCapabilities()?.prompts, undefined);
        if (era === 'legacy') {
          assert.equal(client.getInstructions(), 'Use search first.');
        }
        await harness.close();
      });

      it('returns structured output with a JSON text block and strips unknown keys', async () => {
        const harness = overHttp(
          serve({
            name: 's',
            version: '1',
            tools: [
              defineMcpTool({
                name: 'stats',
                description: 'd',
                input: z.object({ n: z.number() }),
                output: z.object({ doubled: z.number() }),
                access: open,
                handler: ({ n }) => ({ doubled: n * 2, internal: 'leak' }) as { doubled: number },
              }),
              defineMcpTool({
                name: 'explicit',
                description: 'd',
                output: z.object({ ok: z.boolean() }),
                access: open,
                handler: () =>
                  toolResult.structured({ ok: true }, [{ type: 'text', text: 'All good.' }]),
              }),
              defineMcpTool({
                name: 'plain',
                description: 'd',
                access: open,
                handler: () => ({ list: [1, 2] }),
              }),
              defineMcpTool({
                name: 'words',
                description: 'd',
                access: open,
                handler: () => 'hello',
              }),
              defineMcpTool({
                name: 'nothing',
                description: 'd',
                access: open,
                handler: () => undefined,
              }),
            ],
          }),
        );
        const client = await harness.connect(era);
        const stats = await client.callTool({ name: 'stats', arguments: { n: 21 } });
        assert.deepEqual(stats.structuredContent, { doubled: 42 });
        assert.deepEqual(stats.content, [{ type: 'text', text: '{"doubled":42}' }]);
        assert.equal(stats.isError, undefined);
        const explicit = await client.callTool({ name: 'explicit', arguments: {} });
        assert.deepEqual(explicit.content, [{ type: 'text', text: 'All good.' }]);
        assert.deepEqual(explicit.structuredContent, { ok: true });
        const plain = await client.callTool({ name: 'plain', arguments: {} });
        assert.deepEqual(plain.content, [{ type: 'text', text: '{"list":[1,2]}' }]);
        assert.equal(plain.structuredContent, undefined);
        assert.equal(textOf(await client.callTool({ name: 'words', arguments: {} })), 'hello');
        assert.deepEqual((await client.callTool({ name: 'nothing' })).content, []);
        if (era === 'modern') {
          const wire = await findResult(harness.exchanges, 'structuredContent');
          assert.equal(wire.resultType, 'complete');
        }
        await harness.close();
      });

      it('maps failures: tool failure, invalid arguments, generic failure, bad output, timeout, size cap', async () => {
        const sink = errorSink();
        const SECRET = 'SELECT * FROM users WHERE password = hunter2';
        const harness = overHttp(
          serve(
            {
              name: 's',
              version: '1',
              tools: [
                defineMcpTool({
                  name: 'refuse',
                  description: 'd',
                  access: open,
                  handler: () => {
                    throw new McpToolFailure('quota_exceeded', 'You have used your daily quota.');
                  },
                }),
                defineMcpTool({
                  name: 'badcode',
                  description: 'd',
                  access: open,
                  handler: () => {
                    throw new McpToolFailure('Not Snake', 'x');
                  },
                }),
                defineMcpTool({
                  name: 'crash',
                  description: 'd',
                  access: open,
                  handler: () => {
                    throw new Error(SECRET);
                  },
                }),
                defineMcpTool({
                  name: 'strict',
                  description: 'd',
                  input: z.object({ email: z.email(), count: z.number().int() }),
                  access: open,
                  handler: () => 'never',
                }),
                defineMcpTool({
                  name: 'noargs',
                  description: 'd',
                  access: open,
                  handler: () => 'never',
                }),
                defineMcpTool({
                  name: 'wrongshape',
                  description: 'd',
                  output: z.object({ total: z.number() }),
                  access: open,
                  handler: () => ({ total: 'many' }) as unknown as { total: number },
                }),
                defineMcpTool({
                  name: 'badcontent',
                  description: 'd',
                  access: open,
                  handler: () =>
                    toolResult.content([{ type: 'image', data: SECRET, mimeType: 'image/png' }]),
                }),
                defineMcpTool({
                  name: 'slow',
                  description: 'd',
                  timeoutMs: 30,
                  access: open,
                  handler: (_input, ctx) =>
                    new Promise<string>((resolve) => {
                      ctx.signal.addEventListener('abort', () => resolve('late'));
                    }),
                }),
                defineMcpTool({
                  name: 'huge',
                  description: 'd',
                  access: open,
                  handler: () => 'x'.repeat(5000),
                }),
              ],
            },
            { onError: sink.onError, maxResultBytes: 2048 },
          ),
        );
        const client = await harness.connect(era);
        const call = (name: string, args: Record<string, unknown> = {}) =>
          client.callTool({ name, arguments: args });

        const refused = await call('refuse');
        assert.equal(refused.isError, true);
        assert.deepEqual(refused.structuredContent, {
          code: 'quota_exceeded',
          message: 'You have used your daily quota.',
        });
        assert.equal(textOf(refused), 'You have used your daily quota.');

        const generic = { code: 'tool_failed', message: 'The tool failed.' };
        assert.deepEqual((await call('badcode')).structuredContent, generic);
        assert.deepEqual((await call('crash')).structuredContent, generic);

        const strict = await call('strict', { email: 'not-an-email', count: 1.5, extra: SECRET });
        assert.equal(strict.isError, true);
        assert.deepEqual(strict.structuredContent, {
          code: 'invalid_arguments',
          message: 'Invalid arguments at: email, count.',
        });
        const noargs = await call('noargs', { surprise: 1 });
        assert.deepEqual(noargs.structuredContent, {
          code: 'invalid_arguments',
          message: 'Invalid arguments at: (root).',
        });

        assert.deepEqual((await call('wrongshape')).structuredContent, generic);
        assert.deepEqual((await call('badcontent')).structuredContent, generic);
        assert.deepEqual((await call('slow')).structuredContent, {
          code: 'timed_out',
          message: 'The tool did not finish in time.',
        });
        assert.deepEqual((await call('huge')).structuredContent, {
          code: 'result_too_large',
          message: 'The tool result is too large to send.',
        });

        for (const exchange of harness.exchanges) {
          assert.ok(
            !(await exchange.body).includes('hunter2'),
            'a foreign error message reached the wire',
          );
        }
        assert.deepEqual(
          sink.errors.map((error) => [error.code, error.context.name]),
          [
            ['handler_failed', 'badcode'],
            ['handler_failed', 'crash'],
            ['invalid_result', 'wrongshape'],
            ['invalid_result', 'badcontent'],
            ['timed_out', 'slow'],
            ['result_too_large', 'huge'],
          ],
        );
        assert.equal((sink.errors[1]?.cause as Error).message, SECRET);
        await harness.close();
      });

      it('gives handlers the actor, client info, a live signal, and progress', async () => {
        const seen: unknown[] = [];
        const actor: McpActor = { kind: 'service', id: 'svc-9', scopes: ['notes:read'] };
        const harness = overHttp(
          serve({
            name: 's',
            version: '1',
            tools: [
              defineMcpTool({
                name: 'inspect',
                description: 'd',
                access: open,
                handler: (_input, ctx) => {
                  seen.push({ actor: ctx.actor, client: ctx.client, aborted: ctx.signal.aborted });
                  ctx.progress(1, 3, 'one');
                  ctx.progress(1, 3, 'repeat is dropped');
                  ctx.progress(2, 3);
                  return 'done';
                },
              }),
            ],
          }),
          actor,
        );
        const client = await harness.connect(era);
        const progress: unknown[] = [];
        await client.callTool(
          { name: 'inspect', arguments: {} },
          { onprogress: (update) => progress.push(update) },
        );
        const [observed] = seen as {
          actor: McpActor;
          client: Record<string, unknown>;
          aborted: boolean;
        }[];
        assert.deepEqual(observed?.actor, actor);
        assert.equal(observed?.aborted, false);
        assert.equal(observed?.client.era, era);
        if (era === 'modern') {
          assert.deepEqual(observed?.client, {
            name: 'test-client',
            version: '7.0.0',
            protocolVersion: '2026-07-28',
            era,
            elicitation: { form: false, url: false },
          });
          assert.deepEqual(progress, [
            { progress: 1, total: 3, message: 'one' },
            { progress: 2, total: 3 },
          ]);
        } else {
          assert.match(String(observed?.client.protocolVersion), /^2025-/);
        }
        await harness.close();
      });

      it('serves resources, templates, and prompts with completion and cache hints', async () => {
        const sink = errorSink();
        const notes = new Map([
          ['a b', 'First note'],
          ['2', 'Second note'],
        ]);
        const harness = overHttp(
          serve(
            {
              name: 's',
              version: '1',
              listCacheTtlMs: 1000,
              resources: [
                defineMcpResource({
                  uri: 'notes://index',
                  name: 'index',
                  mimeType: 'text/plain',
                  access: open,
                  cache: { ttlMs: 60_000, scope: 'public' },
                  read: () => [{ text: [...notes.keys()].join('\n') }],
                }),
                defineMcpResource({
                  uri: 'notes://broken',
                  name: 'broken',
                  access: open,
                  read: () => [{ blob: 'not base64' }],
                }),
                defineMcpResourceTemplate({
                  uriTemplate: 'notes://item/{id}',
                  name: 'note',
                  params: z.object({ id: z.string().min(1) }),
                  access: open,
                  complete: {
                    id: (prefix) => [...notes.keys()].filter((key) => key.startsWith(prefix)),
                  },
                  list: () =>
                    [...notes.keys()].map((id) => ({
                      uri: `notes://item/${encodeURIComponent(id)}`,
                      name: id,
                    })),
                  read: ({ id }) => {
                    const text = notes.get(id);
                    return text === undefined ? null : [{ text, mimeType: 'text/plain' }];
                  },
                }),
              ],
              prompts: [
                defineMcpPrompt({
                  name: 'summarize',
                  description: 'Summarize a note.',
                  args: z.object({
                    id: z.string().describe('Note id'),
                    tone: z.enum(['short', 'long']).optional(),
                  }),
                  access: open,
                  complete: { tone: () => ['short', 'long', 7 as unknown as string] },
                  render: ({ id, tone }) => [
                    {
                      role: 'user',
                      content: { type: 'text', text: `Summarize ${id} (${tone ?? 'short'}).` },
                    },
                  ],
                }),
                defineMcpPrompt({
                  name: 'hello',
                  access: open,
                  render: () => [{ role: 'assistant', content: { type: 'text', text: 'Hi.' } }],
                }),
              ],
            },
            { onError: sink.onError },
          ),
        );
        const client = await harness.connect(era);
        const listed = await client.listResources();
        assert.deepEqual(
          listed.resources.map((resource) => resource.uri),
          ['notes://broken', 'notes://index', 'notes://item/a%20b', 'notes://item/2'],
        );
        const templates = await client.listResourceTemplates();
        assert.deepEqual(
          templates.resourceTemplates.map((template) => template.uriTemplate),
          ['notes://item/{id}'],
        );
        const index = await client.readResource({ uri: 'notes://index' });
        // The body names no MIME type, so it carries the one the resource declares.
        assert.deepEqual(index.contents, [
          { uri: 'notes://index', mimeType: 'text/plain', text: 'a b\n2' },
        ]);
        const note = await client.readResource({ uri: 'notes://item/a%20b' });
        assert.deepEqual(note.contents, [
          { uri: 'notes://item/a%20b', text: 'First note', mimeType: 'text/plain' },
        ]);
        const missing = await rejection(client.readResource({ uri: 'notes://item/zzz' }));
        assert.equal(missing.code, -32602);
        const nowhere = await rejection(client.readResource({ uri: 'other://x' }));
        assert.equal(nowhere.code, -32602);
        const broken = await rejection(client.readResource({ uri: 'notes://broken' }));
        assert.equal(broken.code, -32603);
        assert.equal(broken.message.includes('base64'), false);

        const prompts = await client.listPrompts();
        assert.deepEqual(
          prompts.prompts.map((prompt) => prompt.name),
          ['hello', 'summarize'],
        );
        assert.deepEqual(prompts.prompts[1]?.arguments, [
          { name: 'id', description: 'Note id', required: true },
          { name: 'tone', required: false },
        ]);
        const rendered = await client.getPrompt({
          name: 'summarize',
          arguments: { id: '2', tone: 'long' },
        });
        assert.deepEqual(rendered.messages, [
          { role: 'user', content: { type: 'text', text: 'Summarize 2 (long).' } },
        ]);
        const badArgs = await rejection(
          client.getPrompt({ name: 'summarize', arguments: { tone: 'medium' } }),
        );
        assert.equal(badArgs.code, -32602);
        assert.match(badArgs.message, /Invalid prompt arguments at: id, tone\./);
        assert.equal((await client.getPrompt({ name: 'hello' })).messages.length, 1);

        const completeId = await client.complete({
          ref: { type: 'ref/resource', uri: 'notes://item/{id}' },
          argument: { name: 'id', value: 'a' },
        });
        assert.deepEqual(completeId.completion.values, ['a b']);
        const completeTone = await client.complete({
          ref: { type: 'ref/prompt', name: 'summarize' },
          argument: { name: 'tone', value: '' },
        });
        assert.deepEqual(completeTone.completion, {
          values: ['short', 'long'],
          total: 2,
          hasMore: false,
        });
        const noCompleter = await client.complete({
          ref: { type: 'ref/prompt', name: 'summarize' },
          argument: { name: 'id', value: '' },
        });
        assert.deepEqual(noCompleter.completion.values, []);
        const unknownRef = await rejection(
          client.complete({
            ref: { type: 'ref/prompt', name: 'nope' },
            argument: { name: 'x', value: '' },
          }),
        );
        assert.equal(unknownRef.code, -32602);

        if (era === 'modern') {
          const listBody = await findResult(harness.exchanges, 'resources');
          assert.equal(listBody.ttlMs, 1000);
          assert.equal(listBody.cacheScope, 'public');
          const readBody = await findResult(harness.exchanges, 'contents');
          assert.equal(readBody.ttlMs, 60_000);
          assert.equal(readBody.cacheScope, 'public');
        }
        assert.deepEqual(
          sink.errors.map((error) => error.code),
          ['invalid_result'],
        );
        await harness.close();
      });
    });
  }
});

/** The first JSON-RPC result body among the exchanges that carries `key`. */
async function findResult(
  exchanges: readonly { body: Promise<string> }[],
  key: string,
): Promise<Record<string, unknown>> {
  for (const exchange of exchanges) {
    const text = await exchange.body;
    if (!text.startsWith('{')) {
      continue;
    }
    const message = JSON.parse(text) as { result?: Record<string, unknown> };
    if (message.result !== undefined && key in message.result) {
      return message.result;
    }
  }
  throw new Error(`no result with ${key}`);
}

describe('the gate', () => {
  const role = (name: string) => ({ role: name });

  function gatedServer(authorize: McpAuthorize, options: McpServingOptions = {}) {
    return serve(
      {
        name: 's',
        version: '1',
        tools: [
          defineMcpTool({
            name: 'public_tool',
            description: 'd',
            access: open,
            handler: () => 'public',
          }),
          defineMcpTool({
            name: 'admin_tool',
            description: 'd',
            access: role('admin'),
            handler: () => 'admin',
          }),
          defineMcpTool({
            name: 'writer_tool',
            description: 'd',
            access: role('writer'),
            handler: () => 'write',
          }),
        ],
        resources: [
          defineMcpResource({
            uri: 'secret://doc',
            name: 'doc',
            access: role('admin'),
            read: () => [{ text: 's' }],
          }),
        ],
        prompts: [
          defineMcpPrompt({ name: 'admin_prompt', access: role('admin'), render: () => [] }),
        ],
      },
      { authorize, ...options },
    );
  }

  it('asks the gate once per non-public item per unit, with kind, name, access, and actor', async () => {
    const asked: unknown[] = [];
    const factory = gatedServer((item, actor) => {
      asked.push([item.kind, item.name, item.access, actor.id]);
      return 'allow';
    });
    await factory({ actor: USER, era: 'modern' });
    assert.deepEqual(
      asked.sort(),
      [
        ['prompt', 'admin_prompt', { role: 'admin' }, 'user-1'],
        ['resource', 'secret://doc', { role: 'admin' }, 'user-1'],
        ['tool', 'admin_tool', { role: 'admin' }, 'user-1'],
        ['tool', 'writer_tool', { role: 'writer' }, 'user-1'],
      ].sort(),
    );
  });

  it('hides denied items and fails them exactly like nonexistent ones', async () => {
    const hidden = overHttp(gatedServer(() => 'hidden'));
    const absent = overHttp(
      serve({
        name: 's',
        version: '1',
        tools: [
          defineMcpTool({
            name: 'public_tool',
            description: 'd',
            access: open,
            handler: () => 'p',
          }),
        ],
        resources: [
          defineMcpResource({
            uri: 'public://doc',
            name: 'doc',
            access: open,
            read: () => [{ text: 'p' }],
          }),
        ],
        prompts: [defineMcpPrompt({ name: 'public_prompt', access: open, render: () => [] })],
      }),
    );
    const bodyOf = async (
      harness: ReturnType<typeof overHttp>,
      call: () => Promise<unknown>,
    ): Promise<string> => {
      const before = harness.exchanges.length;
      await rejection(call());
      return normalize(await harness.exchanges[before]!.body);
    };
    for (const era of ERAS) {
      const hiddenClient = await hidden.connect(era);
      const absentClient = await absent.connect(era);
      assert.deepEqual(
        (await hiddenClient.listTools()).tools.map((tool) => tool.name),
        ['public_tool'],
      );
      assert.deepEqual((await hiddenClient.listResources()).resources, []);
      assert.deepEqual((await hiddenClient.listPrompts()).prompts, []);
      for (const name of ['admin_tool', 'writer_tool']) {
        assert.equal(
          await bodyOf(hidden, () => hiddenClient.callTool({ name, arguments: {} })),
          await bodyOf(absent, () => absentClient.callTool({ name, arguments: {} })),
        );
      }
      const read = { uri: 'secret://doc' };
      const hiddenRead = await bodyOf(hidden, () => hiddenClient.readResource(read));
      assert.equal(hiddenRead, await bodyOf(absent, () => absentClient.readResource(read)));
      assert.match(hiddenRead, /-32602/);
      const prompt = { name: 'admin_prompt' };
      const hiddenPrompt = await bodyOf(hidden, () => hiddenClient.getPrompt(prompt));
      assert.equal(hiddenPrompt, await bodyOf(absent, () => absentClient.getPrompt(prompt)));
      assert.match(hiddenPrompt, /-32602/);
    }
    await hidden.close();
    await absent.close();
  });

  it('lists challenged items and answers 403 insufficient_scope over HTTP', async () => {
    const harness = overHttp(
      gatedServer((item) =>
        item.name === 'writer_tool' ? { challenge: ['notes:write', 'notes:read'] } : 'hidden',
      ),
    );
    for (const era of ERAS) {
      const client = await harness.connect(era);
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name),
        ['public_tool', 'writer_tool'],
      );
      const before = harness.exchanges.length;
      await assert.rejects(
        client.callTool({ name: 'writer_tool', arguments: {} }),
        /Insufficient scope/,
      );
      const exchange = harness.exchanges[before]!;
      assert.equal(exchange.status, 403);
      assert.match(
        exchange.headers.get('www-authenticate') ?? '',
        /error="insufficient_scope".*scope="notes:write notes:read"/,
      );
    }
    await harness.close();
  });

  it('refuses challenged items in-band on a transport without HTTP', async () => {
    const challenge: McpGateDecision = { challenge: ['admin'] };
    const { client, close } = await overMemory(gatedServer(() => challenge));
    const result = await client.callTool({ name: 'admin_tool', arguments: {} });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      code: 'insufficient_scope',
      message: 'The credential lacks a scope this tool needs.',
      scopes: ['admin'],
    });
    const read = await rejection(client.readResource({ uri: 'secret://doc' }));
    assert.deepEqual(
      [read.code, read.data],
      [-32602, { reason: 'insufficient_scope', scopes: ['admin'] }],
    );
    const prompt = await rejection(client.getPrompt({ name: 'admin_prompt' }));
    assert.equal(prompt.code, -32602);
    await close();
  });

  it('hides items when the gate throws or answers something malformed, and reports it', async () => {
    const sink = errorSink();
    const factory = gatedServer(
      (item) => {
        if (item.name === 'admin_tool') {
          throw new Error('directory down');
        }
        return (item.name === 'writer_tool' ? 'yes' : 'allow') as McpGateDecision;
      },
      { onError: sink.onError },
    );
    const { client, close } = await overMemory(factory);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ['public_tool'],
    );
    assert.deepEqual(sink.errors.map((error) => [error.code, error.context.name]).sort(), [
      ['gate_failed', 'admin_tool'],
      ['invalid_gate_decision', 'writer_tool'],
    ]);
    await close();
  });

  it('keeps list results private when any item is gated', async () => {
    const harness = overHttp(gatedServer(() => 'allow'));
    const client = await harness.connect('modern');
    await client.listTools();
    const body = await findResult(harness.exchanges, 'tools');
    assert.equal(body.cacheScope, 'private');
    await harness.close();
  });
});

function normalize(body: string): string {
  return body.replace(/"id":\s*("[^"]*"|\d+)/g, '"id":0');
}

describe('access properties', () => {
  it('lists exactly the callable set, and every other name fails like a nonexistent one', async () => {
    const decisions: readonly McpGateDecision[] = ['allow', 'hidden', { challenge: ['extra'] }];
    await forAll(0x6d63_7002, 25, async (gen) => {
      const count = gen.int(1, 5);
      const chosen = new Map<string, McpGateDecision>();
      const tools: McpTool[] = [];
      for (let index = 0; index < count; index += 1) {
        const name = `tool_${index}`;
        const isPublic = gen.bool() && gen.bool();
        chosen.set(name, isPublic ? 'allow' : gen.pick(decisions));
        tools.push(
          defineMcpTool({
            name,
            description: 'd',
            access: isPublic ? open : { item: name },
            handler: () => name,
          }),
        );
      }
      const factory = createMcpServerFactory(defineMcpServer({ name: 's', version: '1', tools }), {
        authorize: (item) => chosen.get(item.name) ?? 'hidden',
      });
      const { client, close } = await overMemory(factory);
      const listed = new Set((await client.listTools()).tools.map((tool) => tool.name));
      const unknown = await rejection(client.callTool({ name: 'never_defined', arguments: {} }));
      for (const [name, decision] of chosen) {
        const expectedListed = decision !== 'hidden';
        assert.equal(listed.has(name), expectedListed, `${name} listing`);
        if (decision === 'allow') {
          assert.equal(textOf(await client.callTool({ name, arguments: {} })), name);
        } else if (decision === 'hidden') {
          const failure = await rejection(client.callTool({ name, arguments: {} }));
          assert.deepEqual(failure, unknown);
        } else {
          const refused = await client.callTool({ name, arguments: {} });
          assert.equal(refused.isError, true);
        }
      }
      await close();
    });
  });

  it('never sends a foreign error message, stack, or argument value', async () => {
    await forAll(0x6d63_7003, 20, async (gen, seed) => {
      const marker = `MARKER${seed}x${gen.int(1000, 9999)}`;
      const sink = errorSink();
      const throwers = [
        () => {
          throw new Error(marker);
        },
        () => Promise.reject(new TypeError(marker)),
        () => {
          throw marker;
        },
        () => {
          throw Object.assign(new Error('wrapped'), { cause: new Error(marker) });
        },
        () =>
          toolResult.content([
            { type: 'text', text: 1 as unknown as string },
            { type: 'image', data: marker, mimeType: 'image/png' },
          ]),
      ];
      const harness = overHttp(
        serve(
          {
            name: 's',
            version: '1',
            tools: [
              defineMcpTool({
                name: 'boom',
                description: 'd',
                access: open,
                handler: gen.pick(throwers),
              }),
              defineMcpTool({
                name: 'typed',
                description: 'd',
                input: z.object({ n: z.number() }),
                access: open,
                handler: () => 'ok',
              }),
            ],
            resources: [
              defineMcpResource({
                uri: 'x://r',
                name: 'r',
                access: open,
                read: gen.pick(throwers) as never,
              }),
            ],
          },
          { onError: sink.onError },
        ),
      );
      const client = await harness.connect(gen.pick(ERAS));
      await client.callTool({ name: 'boom', arguments: {} });
      await client.callTool({ name: 'typed', arguments: { n: marker } });
      await rejection(client.readResource({ uri: 'x://r' }));
      for (const exchange of harness.exchanges) {
        assert.ok(!(await exchange.body).includes(marker), 'marker leaked');
      }
      assert.equal(sink.errors.length, 2);
      await harness.close();
    });
  });
});

describe('serving defaults', () => {
  it('projects schemas once per definition, not per serving unit', async () => {
    const input = z.object({ q: z.string() });
    const original = input['~standard'].jsonSchema.input;
    let projections = 0;
    const counted = {
      '~standard': {
        ...input['~standard'],
        jsonSchema: {
          ...input['~standard'].jsonSchema,
          input: (options: { readonly target: 'draft-2020-12' }) => {
            projections += 1;
            return original(options);
          },
        },
      },
    };
    const factory = serve({
      name: 's',
      version: '1',
      tools: [
        defineMcpTool({
          name: 'find',
          description: 'd',
          input: counted,
          access: open,
          handler: () => 'x',
        }),
      ],
    });
    for (let unit = 0; unit < 3; unit += 1) {
      const { client, close } = await overMemory(factory);
      await client.listTools();
      await client.callTool({ name: 'find', arguments: { q: 'a' } });
      await close();
    }
    assert.equal(projections, 1);
  });

  it('reports to console.error without a hook, and survives a throwing hook', async (t) => {
    const logged: unknown[] = [];
    t.mock.method(console, 'error', (error: unknown) => void logged.push(error));
    const warnings: unknown[] = [];
    t.mock.method(process, 'emitWarning', (...args: unknown[]) => void warnings.push(args));
    const crashing = defineMcpTool({
      name: 'crash',
      description: 'd',
      access: open,
      handler: () => {
        throw new Error('x');
      },
    });
    const quiet = await overMemory(serve({ name: 's', version: '1', tools: [crashing] }));
    assert.equal((await quiet.client.callTool({ name: 'crash', arguments: {} })).isError, true);
    assert.equal(logged.length, 1);
    await quiet.close();
    const loud = await overMemory(
      serve(
        { name: 's', version: '1', tools: [crashing] },
        {
          onError: () => {
            throw new Error('reporter broke');
          },
        },
      ),
    );
    assert.equal((await loud.client.callTool({ name: 'crash', arguments: {} })).isError, true);
    assert.equal(warnings.length, 1);
    await loud.close();
  });

  it('caps the number of argument elements', async () => {
    const harness = await overMemory(
      serve(
        {
          name: 's',
          version: '1',
          tools: [
            defineMcpTool({
              name: 'sum',
              description: 'd',
              input: z.object({ values: z.array(z.number()) }),
              access: open,
              handler: ({ values }) => String(values.length),
            }),
          ],
        },
        { maxToolInputElements: 5 },
      ),
    );
    const result = await harness.client.callTool({
      name: 'sum',
      arguments: { values: [1, 2, 3, 4, 5, 6] },
    });
    assert.equal(result.isError, true);
    assert.equal(
      textOf(await harness.client.callTool({ name: 'sum', arguments: { values: [1] } })),
      '1',
    );
    await harness.close();
  });

  it('aborts the handler signal when the client cancels', async () => {
    let aborted: Promise<void> | undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const harness = await overMemory(
      serve({
        name: 's',
        version: '1',
        tools: [
          defineMcpTool({
            name: 'wait',
            description: 'd',
            access: open,
            handler: (_input, ctx) => {
              aborted = new Promise((resolve) =>
                ctx.signal.addEventListener('abort', () => resolve()),
              );
              started();
              return new Promise<string>(() => undefined);
            },
          }),
        ],
      }),
    );
    const controller = new AbortController();
    const pending = harness.client.callTool(
      { name: 'wait', arguments: {} },
      { signal: controller.signal },
    );
    await running;
    controller.abort();
    await assert.rejects(pending);
    await aborted;
    await harness.close();
  });
});

describe('refusals and throwing schemas', () => {
  it('refuses unknown tools and prompts with one fixed text that echoes nothing', async () => {
    const harness = overHttp(
      serve({
        name: 's',
        version: '1',
        tools: [defineMcpTool({ name: 't', description: 'd', access: open, handler: () => 'ok' })],
        prompts: [defineMcpPrompt({ name: 'p', access: open, render: () => [] })],
      }),
    );
    for (const era of ERAS) {
      const client = await harness.connect(era);
      const tool = await rejection(client.callTool({ name: 'nope<script>', arguments: {} }));
      assert.deepEqual([tool.code, tool.message], [-32602, 'Unknown tool']);
      const prompt = await rejection(client.getPrompt({ name: 'nope<b>' }));
      assert.deepEqual([prompt.code, prompt.message], [-32602, 'Unknown prompt']);
      assert.deepEqual((await client.getPrompt({ name: 'p' })).messages, []);
    }
    for (const exchange of harness.exchanges) {
      const body = await exchange.body;
      assert.ok(!body.includes('nope'), 'the caller-supplied name was echoed');
    }
    await harness.close();
  });

  it('answers a throwing args or params schema with a generic -32603 and one report', async () => {
    const sink = errorSink();
    const throwing = z.string().refine(() => {
      throw new Error('INTERNAL-SECRET');
    });
    const harness = overHttp(
      serve(
        {
          name: 's',
          version: '1',
          prompts: [
            defineMcpPrompt({
              name: 'p',
              args: z.object({ q: throwing }),
              access: open,
              render: () => [],
            }),
          ],
          resources: [
            defineMcpResourceTemplate({
              uriTemplate: 'x://item/{id}',
              name: 'item',
              params: z.object({ id: throwing }),
              access: open,
              read: () => [{ text: 'never' }],
            }),
          ],
        },
        { onError: sink.onError },
      ),
    );
    for (const era of ERAS) {
      const client = await harness.connect(era);
      const before = sink.errors.length;
      const prompt = await rejection(client.getPrompt({ name: 'p', arguments: { q: 'abc' } }));
      assert.deepEqual([prompt.code, prompt.message], [-32603, 'Internal error']);
      const read = await rejection(client.readResource({ uri: 'x://item/abc' }));
      assert.deepEqual([read.code, read.message], [-32603, 'Internal error']);
      const reported = sink.errors.slice(before);
      assert.deepEqual(
        reported.map((error) => [error.code, error.context.kind]),
        [
          ['handler_failed', 'prompt'],
          ['handler_failed', 'resource-template'],
        ],
      );
      assert.ok(reported.every((error) => String(error.cause).includes('INTERNAL-SECRET')));
    }
    for (const exchange of harness.exchanges) {
      assert.ok(!(await exchange.body).includes('INTERNAL-SECRET'), 'schema text leaked');
    }
    await harness.close();
  });
});

describe('input on a connected legacy unit', () => {
  const form = (key: string) =>
    inputRequired({
      requests: { [key]: { mode: 'form', message: 'Value?', schema: z.object({ v: z.string() }) } },
    });
  const factory = (sink: ReturnType<typeof errorSink>) =>
    serve(
      {
        name: 's',
        version: '1',
        tools: [
          defineMcpTool({
            name: 'ask_form',
            description: 'd',
            access: open,
            handler: async (_input, ctx) => {
              const answer = await ctx.answer('q', z.object({ v: z.string() }));
              return answer?.action === 'accept' ? `got ${answer.content.v}` : form('q');
            },
          }),
          defineMcpTool({
            name: 'ask_url',
            description: 'd',
            access: open,
            handler: () =>
              inputRequired({
                requests: { u: { mode: 'url', message: 'Go', url: 'https://example.com/ok' } },
              }),
          }),
        ],
        resources: [
          defineMcpResource({ uri: 'x://r', name: 'r', access: open, read: () => form('r') }),
        ],
        prompts: [defineMcpPrompt({ name: 'p', access: open, render: () => form('p') })],
      },
      { onError: sink.onError },
    );

  it('answers input_unavailable when the client declared no elicitation, never SDK text', async () => {
    const sink = errorSink();
    const { client, close } = await overMemory(factory(sink));
    for (const name of ['ask_form', 'ask_url']) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, {
        code: 'input_unavailable',
        message: 'The tool needs input this connection cannot carry.',
      });
    }
    for (const call of [
      () => client.readResource({ uri: 'x://r' }),
      () => client.getPrompt({ name: 'p' }),
    ]) {
      const refused = await rejection(call());
      assert.equal(refused.code, -32603);
      assert.deepEqual(refused.data, { reason: 'input_unavailable' });
    }
    assert.deepEqual(sink.errors, []);
    await close();
  });

  it('asks only in the modes the client declared', async () => {
    const sink = errorSink();
    const { client, close } = await overMemory(factory(sink), USER, {
      elicitation: { form: {} },
    });
    client.setRequestHandler('elicitation/create', () => ({
      action: 'accept',
      content: { v: 'yes' },
    }));
    assert.equal(textOf(await client.callTool({ name: 'ask_form', arguments: {} })), 'got yes');
    const url = await client.callTool({ name: 'ask_url', arguments: {} });
    assert.equal((url.structuredContent as { code: string }).code, 'input_unavailable');
    assert.deepEqual(sink.errors, []);
    await close();
  });
});

describe('the error code table', () => {
  it('lists the fixed tool-error codes and no code that is never raised', () => {
    assert.deepEqual([...MCP_ERROR_CODES.tool].sort(), [
      'aborted',
      'confirmation_unavailable',
      'input_unavailable',
      'insufficient_scope',
      'invalid_arguments',
      'not_confirmed',
      'result_too_large',
      'timed_out',
      'too_many_input_rounds',
      'tool_failed',
    ]);
    assert.ok(!(MCP_ERROR_CODES.serving as readonly string[]).includes('reporter_failed'));
    assert.ok(Object.isFrozen(MCP_ERROR_CODES.tool));
  });
});
