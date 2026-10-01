/**
 * Admin resource `richText` field tests.
 *
 * The `richText` field is a generic resource field validating a submitted JSON
 * string (or a direct object) against the framework's `richTextSchema`. These
 * tests prove the validation gate, the derived schema coercion, and the form
 * markup contract (a `data-jsails-island="rich-text"` mount marker carrying the
 * field name and document in its props, with the no-JS fallback textarea nested
 * inside it) without a client bundle.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ResourceError,
  adminPlugin,
  defineAdminPanel,
  defineResource,
  type Resource,
  type ResourceField,
} from '../src/index.js';
import { createEmptyRichTextDocument, defineRichTextEditorAdapter } from 'jsails/rich-text';
import { z } from 'zod';
import type { Session } from 'jsails';
import { createTestApp, type TestApplication } from 'jsails/testing';

const SESSION: Session = {
  id: 'rt-session',
  csrfToken: 'csrf-secret-token',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

const DOCUMENT = {
  version: 1,
  blocks: [{ id: 'b1', type: 'paragraph', text: 'Hello rich text' }],
} as const;

const fakeEditor = defineRichTextEditorAdapter({
  id: 'fake',
  island: 'fake-editor',
  payloadSchema: z.object({ text: z.string() }),
  toContent: (payload) => ({
    version: 1,
    blocks: [{ id: 'b1', type: 'paragraph', text: payload.text }],
  }),
  fromContent: (document) => {
    const first = document.blocks[0];
    return { text: first?.type === 'paragraph' ? first.text : '' };
  },
});

const ENVELOPE = {
  version: 1,
  editor: 'fake',
  content: DOCUMENT,
  native: { text: 'Hello rich text' },
} as const;

function makeBodyResource(
  overrides: { fields?: readonly ResourceField[]; get?: Resource['get'] } = {},
): Resource {
  return defineResource({
    slug: 'bodies',
    label: 'Bodies',
    columns: [{ name: 'id', label: 'ID' }],
    fields: overrides.fields ?? [{ name: 'body', label: 'Body', type: 'richText' }],
    list: async () => ({ rows: [], total: 0 }),
    ...(overrides.get === undefined ? {} : { get: overrides.get }),
    save: async () => {},
  });
}

async function makeApp(resource: Resource): Promise<TestApplication> {
  return createTestApp({
    config: {
      port: 0,
      extensions: [
        adminPlugin(
          defineAdminPanel({
            resolveSession: () => SESSION,
            authorize: () => true,
            resources: [resource],
          }),
        ),
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('richText field validation', () => {
  function base() {
    return {
      slug: 'b',
      label: 'B',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [] as ResourceField[],
      list: async () => ({ rows: [], total: 0 }),
    };
  }

  it('accepts a richText field with no type-specific config', () => {
    const resource = defineResource({
      ...base(),
      fields: [{ name: 'body', label: 'Body', type: 'richText' }],
    });
    assert.equal(resource.fields[0]!.type, 'richText');
  });

  it('accepts an optional richText field', () => {
    const resource = defineResource({
      ...base(),
      fields: [{ name: 'body', label: 'Body', type: 'richText', required: false }],
    });
    assert.equal(resource.fields[0]!.required, false);
  });

  it('rejects options on a richText field', () => {
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [
            {
              name: 'body',
              label: 'Body',
              type: 'richText',
              options: [{ value: 'a', label: 'A' }],
            },
          ],
        }),
      ResourceError,
    );
  });

  it('accepts a mediaPickerUrl on a richText field', () => {
    const resource = defineResource({
      ...base(),
      fields: [
        {
          name: 'body',
          label: 'Body',
          type: 'richText',
          mediaPickerUrl: '/admin/media?format=json',
        },
      ],
    });
    assert.equal(resource.fields[0]!.mediaPickerUrl, '/admin/media?format=json');
  });

  it('rejects mediaPickerUrl on a non-richText field', () => {
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [{ name: 'title', label: 'Title', type: 'text', mediaPickerUrl: '/m' }],
        }),
      ResourceError,
    );
  });

  it('rejects a blank or control-character mediaPickerUrl', () => {
    for (const mediaPickerUrl of ['', '   ', '/admin/media\u0000']) {
      assert.throws(
        () =>
          defineResource({
            ...base(),
            fields: [{ name: 'body', label: 'Body', type: 'richText', mediaPickerUrl }],
          }),
        ResourceError,
      );
    }
  });

  it('rejects repeater, formset, accept, and slider bounds on a richText field', () => {
    const fields: Array<Omit<ResourceField, 'name' | 'label'>> = [
      {
        type: 'richText',
        repeater: { fields: [{ name: 'x', label: 'X', type: 'text' }] },
      },
      {
        type: 'richText',
        formset: { fields: [{ name: 'x', label: 'X', type: 'text' }] },
      },
      { type: 'richText', accept: 'text/plain' },
      { type: 'richText', min: 1, max: 10 },
      { type: 'richText', language: 'ts' },
      { type: 'richText', sanitize: (h: string) => h },
      { type: 'richText', autocomplete: { search: async () => [] } },
    ];
    for (const field of fields) {
      assert.throws(
        () =>
          defineResource({
            ...base(),
            fields: [{ name: 'body', label: 'Body', ...field }],
          }),
        ResourceError,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Schema coercion
// ---------------------------------------------------------------------------

describe('richText field schema', () => {
  it('round-trips a valid document submitted as a JSON string', () => {
    const resource = makeBodyResource();
    const parsed = resource.schema.safeParse({ body: JSON.stringify(DOCUMENT) });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.body, DOCUMENT);
  });

  it('round-trips a direct object value', () => {
    const resource = makeBodyResource();
    const parsed = resource.schema.safeParse({ body: DOCUMENT });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.body, DOCUMENT);
  });

  it('returns a field error for invalid JSON', () => {
    const resource = makeBodyResource();
    const parsed = resource.schema.safeParse({ body: '{not json' });
    assert.equal(parsed.success, false);
  });

  it('returns a field error for an invalid document', () => {
    const resource = makeBodyResource();
    const parsed = resource.schema.safeParse({
      body: JSON.stringify({ version: 2, blocks: [] }),
    });
    assert.equal(parsed.success, false);
  });

  it('returns a field error for a non-object value', () => {
    const resource = makeBodyResource();
    // A JSON number is valid JSON but not a rich-text document.
    const parsed = resource.schema.safeParse({ body: '42' });
    assert.equal(parsed.success, false);
  });

  it('rejects a blank required value and passes blank through as undefined when optional', () => {
    const required = makeBodyResource().schema.safeParse({ body: '' });
    assert.equal(required.success, false);

    const optional = makeBodyResource({
      fields: [{ name: 'body', label: 'Body', type: 'richText', required: false }],
    }).schema.safeParse({ body: '' });
    assert.equal(optional.success, true);
    assert.equal(optional.success && optional.data.body, undefined);
  });
});

// ---------------------------------------------------------------------------
// Form rendering
// ---------------------------------------------------------------------------

describe('richText form rendering', () => {
  it('renders the named JSON textarea and the island marker on an empty create form', async () => {
    const app = await makeApp(makeBodyResource());
    const body = await (await app.request('/admin/bodies/new')).text();

    // The fallback textarea named after the field carries the empty document JSON.
    assert.match(body, /<textarea[^>]*name="body"/);
    assert.match(body, /&quot;version&quot;:1/);
    assert.match(body, /&quot;blocks&quot;:\[\]/);
    // The mount marker: island id plus props carrying the field name and document.
    assert.match(body, /data-jsails-island="rich-text"/);
    assert.match(body, /data-jsails-rich-text/);
    assert.match(
      body,
      /data-jsails-props="\{&quot;name&quot;:&quot;body&quot;,&quot;document&quot;:\{&quot;version&quot;:1,&quot;blocks&quot;:\[\]\}\}"/,
    );
    // The textarea is nested inside the marker (not a sibling), so Preact
    // replaces it on hydration — it is not marked hidden.
    const nested =
      /<div data-jsails-rich-text(?:=""|\s)[^>]*>[\s\S]*?<textarea[^>]*name="body"[^>]*>[^<]*<\/textarea>[\s\S]*?<\/div>/.test(
        body,
      );
    assert.equal(nested, true);
    assert.doesNotMatch(body, /<textarea[^>]*\bhidden\b/);

    await app.close();
  });

  it('renders the current record value into the textarea on edit', async () => {
    const resource = makeBodyResource({
      get: async ({ id }) => ({ id, body: DOCUMENT }),
    });
    const app = await makeApp(resource);
    const body = await (await app.request('/admin/bodies/1')).text();

    assert.match(body, /name="body"/);
    assert.match(body, /Hello rich text/);
    assert.match(body, /data-jsails-island="rich-text"/);
    // The document props carry the edited record's blocks.
    assert.match(body, /&quot;document&quot;:\{&quot;version&quot;:1,&quot;blocks&quot;:/);
    assert.match(body, /&quot;Hello rich text&quot;/);

    await app.close();
  });

  it('renders the empty empty-document JSON when the record has no value', async () => {
    const resource = makeBodyResource({
      get: async () => ({ id: '1' }),
    });
    const app = await makeApp(resource);
    const body = await (await app.request('/admin/bodies/1')).text();

    assert.match(body, /&quot;blocks&quot;:\[\]/);
    assert.deepEqual(createEmptyRichTextDocument(), { version: 1, blocks: [] });

    await app.close();
  });

  it('passes the mediaPickerUrl through the island props', async () => {
    const resource = makeBodyResource({
      fields: [
        {
          name: 'body',
          label: 'Body',
          type: 'richText',
          mediaPickerUrl: '/admin/media?format=json',
        },
      ],
    });
    const app = await makeApp(resource);
    const body = await (await app.request('/admin/bodies/new')).text();

    assert.match(body, /&quot;mediaPickerUrl&quot;:&quot;\/admin\/media\?format=json&quot;/);
    await app.close();
  });
});

describe('richText editor adapter field', () => {
  function editorResource(): Resource {
    return makeBodyResource({
      fields: [{ name: 'body', label: 'Body', type: 'richText', editor: fakeEditor }],
    });
  }

  it('accepts an envelope whose editor id and payload match the adapter', () => {
    const parsed = editorResource().schema.safeParse({ body: ENVELOPE });
    assert.equal(parsed.success, true);
    if (parsed.success) assert.deepEqual(parsed.data.body, ENVELOPE);
  });

  it('rejects a mismatched editor id and a native payload the adapter rejects', () => {
    const resource = editorResource();
    assert.equal(
      resource.schema.safeParse({
        body: { ...ENVELOPE, editor: 'other' },
      }).success,
      false,
    );
    assert.equal(
      resource.schema.safeParse({
        body: { ...ENVELOPE, native: { text: 42 } },
      }).success,
      false,
    );
  });

  it('renders the adapter island and passes the editor id in the mount props', async () => {
    const app = await makeApp(editorResource());
    const body = await (await app.request('/admin/bodies/new')).text();

    assert.match(body, /data-jsails-island="fake-editor"/);
    assert.match(body, /&quot;editor&quot;:&quot;fake&quot;/);
    assert.match(body, /data-jsails-rich-text/);
    await app.close();
  });
});
