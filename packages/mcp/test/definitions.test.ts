/**
 * Define-time validation: names (including the Object.prototype keys and
 * all-digit names the SDK's registries cannot hold or order), text fields,
 * icons, annotations, cache hints, access, schemas, templates, completers,
 * server uniqueness, and the frozen opaque handles.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { publicAccess } from '../src/access.js';
import {
  defineMcpPrompt,
  defineMcpResource,
  defineMcpResourceTemplate,
  defineMcpServer,
  defineMcpTool,
  serverRecord,
} from '../src/definitions.js';
import { McpDefinitionError, type McpDefinitionErrorCode } from '../src/errors.js';
import { connectInMemory } from '../src/in-memory.js';

const open = publicAccess('test fixture');
const gated = { scope: 'notes:read' };

function rejects(code: McpDefinitionErrorCode, define: () => unknown): void {
  assert.throws(define, (error: unknown) => {
    assert.ok(
      error instanceof McpDefinitionError,
      `expected McpDefinitionError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    return true;
  });
}

function tool(overrides: Record<string, unknown> = {}) {
  return defineMcpTool({
    name: 'echo',
    description: 'Echo the input.',
    access: open,
    handler: () => 'ok',
    ...overrides,
  });
}

describe('defineMcpTool', () => {
  it('returns a frozen opaque handle', () => {
    const handle = tool();
    assert.deepEqual(handle, { kind: 'tool', name: 'echo' });
    assert.ok(Object.isFrozen(handle));
    assert.deepEqual(Object.keys(handle), ['kind', 'name']);
  });

  it('enforces the name rule', () => {
    for (const name of [
      '',
      'has space',
      'comma,name',
      '-lead',
      'trail.',
      'é',
      'x'.repeat(129),
      7,
    ]) {
      rejects('invalid_name', () => tool({ name }));
    }
    for (const name of ['a', 'get_user', 'ns.tool-v2', 'A9', 'x'.repeat(128)]) {
      assert.equal(tool({ name }).name, name);
    }
  });

  it('requires a description and non-empty text fields', () => {
    rejects('invalid_definition', () => tool({ description: undefined }));
    rejects('invalid_definition', () => tool({ description: '  ' }));
    rejects('invalid_definition', () => tool({ title: '' }));
  });

  it('rejects unknown spec fields and non-function handlers', () => {
    rejects('invalid_definition', () => tool({ handlr: () => 'x' }));
    rejects('invalid_definition', () => tool({ handler: 'nope' }));
    rejects('invalid_definition', () => defineMcpTool(null as never));
  });

  it('requires access', () => {
    rejects('invalid_access', () => tool({ access: undefined }));
    rejects('invalid_access', () => tool({ access: 'public' }));
    assert.equal(tool({ access: gated }).name, 'echo');
  });

  it('validates annotations', () => {
    rejects('invalid_definition', () => tool({ annotations: { readOnly: 'yes' } }));
    rejects('invalid_definition', () => tool({ annotations: { readOnlyHint: true } }));
    rejects('invalid_definition', () =>
      tool({ annotations: { readOnly: true, destructive: true } }),
    );
    const handle = tool({ annotations: { readOnly: true, idempotent: true, openWorld: false } });
    const record = serverRecord(defineMcpServer({ name: 's', version: '1', tools: [handle] }));
    assert.deepEqual(record?.tools[0]?.annotations, {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('validates icons', () => {
    rejects('invalid_icon', () => tool({ icons: [{ src: 'http://insecure.example/a.png' }] }));
    rejects('invalid_icon', () => tool({ icons: [{ src: 'not a uri' }] }));
    rejects('invalid_icon', () =>
      tool({ icons: [{ src: 'https://x.example/a.png', sizes: ['big'] }] }),
    );
    rejects('invalid_icon', () =>
      tool({ icons: [{ src: 'https://x.example/a.png', theme: 'blue' }] }),
    );
    rejects('invalid_icon', () =>
      tool({ icons: [{ src: 'https://x.example/a.png', mimeType: 'png' }] }),
    );
    rejects('invalid_icon', () => tool({ icons: [{ src: 'https://x.example/a.png', extra: 1 }] }));
    rejects('invalid_icon', () => tool({ icons: 'https://x.example/a.png' }));
    assert.ok(
      tool({
        icons: [
          {
            src: 'https://x.example/a.png',
            mimeType: 'image/png',
            sizes: ['48x48', 'any'],
            theme: 'dark',
          },
          { src: 'data:image/svg+xml;base64,PHN2Zy8+' },
        ],
      }),
    );
  });

  it('validates timeoutMs', () => {
    for (const timeoutMs of [0, -1, 1.5, 2 ** 31, '10']) {
      rejects('invalid_definition', () => tool({ timeoutMs }));
    }
    assert.ok(tool({ timeoutMs: 50 }));
  });

  it('rejects schemas that are not object-rooted Standard JSON schemas', () => {
    rejects('invalid_schema', () => tool({ input: { type: 'object' } }));
    rejects('invalid_schema', () => tool({ input: z.string() }));
    rejects('invalid_schema', () => tool({ input: z.object({ when: z.date() }) }));
    assert.ok(tool({ input: z.object({ a: z.string() }), output: z.array(z.number()) }));
  });

  it('rejects invalid x-mcp-header declarations at define time', () => {
    const header = (schema: z.ZodType, value: unknown) => schema.meta({ 'x-mcp-header': value });
    rejects('invalid_schema', () => tool({ input: z.object({ a: header(z.number(), 'A') }) }));
    rejects('invalid_schema', () =>
      tool({ input: z.object({ a: header(z.string(), 'Bad Name') }) }),
    );
    rejects('invalid_schema', () =>
      tool({ input: z.object({ a: header(z.string(), 'Dup'), b: header(z.string(), 'dup') }) }),
    );
    rejects('invalid_schema', () =>
      tool({ input: z.object({ a: z.array(header(z.string(), 'A')) }) }),
    );
    assert.ok(
      tool({ input: z.object({ a: header(z.string(), 'Region'), b: header(z.boolean(), 'Dry') }) }),
    );
  });
});

describe('defineMcpResource', () => {
  const resource = (overrides: Record<string, unknown> = {}) =>
    defineMcpResource({
      uri: 'notes://index',
      name: 'Notes index',
      access: open,
      read: () => [{ text: 'x' }],
      ...overrides,
    });

  it('requires an absolute canonical URI', () => {
    rejects('invalid_uri', () => resource({ uri: 'relative/path' }));
    rejects('invalid_uri', () => resource({ uri: 'HTTPS://Example.com/a' }));
    assert.deepEqual(resource(), { kind: 'resource', uri: 'notes://index' });
  });

  it('validates the cache hint against access', () => {
    rejects('invalid_cache_hint', () => resource({ cache: { ttlMs: -1 } }));
    rejects('invalid_cache_hint', () => resource({ cache: { ttlMs: 10, scope: 'shared' } }));
    rejects('invalid_cache_hint', () =>
      resource({ access: gated, cache: { ttlMs: 10, scope: 'public' } }),
    );
    assert.ok(resource({ access: gated, cache: { ttlMs: 10 } }));
    assert.ok(resource({ cache: { ttlMs: 10, scope: 'public' } }));
  });

  it('validates mimeType and read', () => {
    rejects('invalid_definition', () => resource({ mimeType: 'text' }));
    rejects('invalid_definition', () => resource({ read: undefined }));
  });
});

describe('defineMcpResourceTemplate', () => {
  const template = (overrides: Record<string, unknown> = {}) =>
    defineMcpResourceTemplate({
      uriTemplate: 'notes://{id}',
      name: 'note',
      params: z.object({ id: z.string() }),
      access: open,
      read: () => null,
      ...overrides,
    });

  it('requires params to declare exactly the template variables', () => {
    rejects('invalid_schema', () => template({ params: z.object({ other: z.string() }) }));
    rejects('invalid_schema', () =>
      template({ params: z.object({ id: z.string(), extra: z.string() }) }),
    );
    rejects('invalid_schema', () => template({ params: z.object({ id: z.number() }) }));
    assert.deepEqual(template(), { kind: 'resource-template', uriTemplate: 'notes://{id}' });
  });

  it('rejects malformed templates', () => {
    rejects('invalid_uri_template', () => template({ uriTemplate: 'notes://{id' }));
    rejects('invalid_uri_template', () => template({ uriTemplate: '{scheme}://x' }));
  });

  it('checks completers against the declared variables', () => {
    rejects('invalid_definition', () => template({ complete: { nope: () => [] } }));
    rejects('invalid_definition', () => template({ complete: { id: 'x' } }));
    assert.ok(template({ complete: { id: () => ['a'] } }));
  });
});

describe('defineMcpPrompt', () => {
  const prompt = (overrides: Record<string, unknown> = {}) =>
    defineMcpPrompt({ name: 'review', access: open, render: () => [], ...overrides });

  it('accepts string arguments only', () => {
    rejects('invalid_schema', () => prompt({ args: z.object({ count: z.number() }) }));
    assert.ok(
      prompt({ args: z.object({ code: z.string(), style: z.enum(['short', 'long']).optional() }) }),
    );
  });

  it('needs args for completers and a valid name', () => {
    rejects('invalid_definition', () => prompt({ complete: { code: () => [] } }));
    rejects('invalid_name', () => prompt({ name: 'bad name' }));
  });
});

describe('names every serving unit can register and list in order', () => {
  const RESERVED = [
    '__proto__',
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__defineGetter__',
    '__lookupSetter__',
  ];
  const kinds: readonly [string, (name: string) => unknown][] = [
    ['tool', (name) => tool({ name })],
    ['prompt', (name) => defineMcpPrompt({ name, access: open, render: () => [] })],
    [
      'resource template',
      (name) =>
        defineMcpResourceTemplate({
          uriTemplate: 'notes://{id}',
          name,
          params: z.object({ id: z.string() }),
          access: open,
          read: () => null,
        }),
    ],
  ];

  for (const [kind, define] of kinds) {
    it(`refuses Object.prototype keys and all-digit ${kind} names`, () => {
      for (const name of [...RESERVED, '0', '9', '10', '4294967295', '007']) {
        rejects('invalid_name', () => define(name));
      }
      for (const name of ['constructor_v2', 'proto', 'v10', '1a', '1.0', 'toString2']) {
        assert.ok(define(name));
      }
    });
  }

  it('serves and lists names in sorted order', async () => {
    const server = defineMcpServer({
      name: 's',
      version: '1',
      tools: ['b', 'v10', 'v9', 'a', '1a'].map((name) => tool({ name })),
    });
    assert.deepEqual(
      serverRecord(server)?.tools.map((record) => record.name),
      ['1a', 'a', 'b', 'v10', 'v9'],
    );
    const remote = await connectInMemory(server, { protocol: 'modern' });
    try {
      assert.deepEqual(
        (await remote.listTools()).map((listed) => listed.name),
        ['1a', 'a', 'b', 'v10', 'v9'],
      );
    } finally {
      await remote.close();
    }
  });
});

describe('defineMcpServer', () => {
  it('rejects foreign handles and duplicates', () => {
    rejects('invalid_definition', () =>
      defineMcpServer({ name: 's', version: '1', tools: [{ kind: 'tool', name: 'forged' }] }),
    );
    rejects('duplicate_tool', () =>
      defineMcpServer({ name: 's', version: '1', tools: [tool(), tool()] }),
    );
    const prompt = () => defineMcpPrompt({ name: 'p', access: open, render: () => [] });
    rejects('duplicate_prompt', () =>
      defineMcpServer({ name: 's', version: '1', prompts: [prompt(), prompt()] }),
    );
    const resource = () =>
      defineMcpResource({ uri: 'a://b', name: 'b', access: open, read: () => null });
    rejects('duplicate_resource', () =>
      defineMcpServer({ name: 's', version: '1', resources: [resource(), resource()] }),
    );
    const template = (name: string, uriTemplate: string) =>
      defineMcpResourceTemplate({
        uriTemplate,
        name,
        params: z.object({ id: z.string() }),
        access: open,
        read: () => null,
      });
    rejects('duplicate_resource', () =>
      defineMcpServer({
        name: 's',
        version: '1',
        resources: [template('t', 'a://{id}'), template('t', 'b://{id}')],
      }),
    );
    rejects('duplicate_resource', () =>
      defineMcpServer({
        name: 's',
        version: '1',
        resources: [template('t', 'a://{id}'), template('u', 'a://{id}')],
      }),
    );
  });

  it('requires name and version and a valid list cache ttl', () => {
    rejects('invalid_definition', () => defineMcpServer({ name: '', version: '1' }));
    rejects('invalid_definition', () => defineMcpServer({ name: 's' } as never));
    rejects('invalid_cache_hint', () =>
      defineMcpServer({ name: 's', version: '1', listCacheTtlMs: -5 }),
    );
  });

  it('orders items deterministically and derives list cache scopes', () => {
    const names = ['zeta', 'alpha', 'mid'];
    const server = defineMcpServer({
      name: 's',
      version: '1',
      tools: names.map((name) => tool({ name, access: name === 'mid' ? gated : open })),
      resources: [
        defineMcpResource({ uri: 'b://x', name: 'b', access: open, read: () => null }),
        defineMcpResource({ uri: 'a://x', name: 'a', access: open, read: () => null }),
      ],
      listCacheTtlMs: 5000,
    });
    const record = serverRecord(server);
    assert.deepEqual(
      record?.tools.map((item) => item.name),
      ['alpha', 'mid', 'zeta'],
    );
    assert.deepEqual(
      record?.resources.map((item) => item.uri),
      ['a://x', 'b://x'],
    );
    assert.deepEqual(record?.listCache.tools, { ttlMs: 5000, cacheScope: 'private' });
    assert.deepEqual(record?.listCache.resources, { ttlMs: 5000, cacheScope: 'public' });
    assert.equal(record?.gated, true);
    assert.deepEqual(server, { kind: 'server', name: 's', version: '1' });
    assert.ok(Object.isFrozen(server));
  });
});
