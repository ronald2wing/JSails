/**
 * Tests for the derived Zod schema: slider bounds, keyvalue parsing, markdown
 * stored through the caller sanitizer, formset keys lifted into an array, and
 * the richText field (JSON string or direct object, normalised to canonical
 * form, read with parseRichText; absent or blank is no value).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defineResource, type ResourceColumn, type ResourceField } from '../../src/index.js';
import { defineBodyResource, RICH_TEXT_DOCUMENT } from '../fixtures.js';

describe('field kinds', () => {
  it('coerces a slider field to a bounded number', () => {
    const resource = defineResource({
      slug: 's',
      label: 'S',
      columns: [{ name: 'level', label: 'Level' }],
      fields: [{ name: 'level', label: 'Level', type: 'slider', min: 0, max: 10, step: 1 }],
      list: async () => ({ rows: [], total: 0 }),
      save: async () => {},
    });
    const parsed = resource.schema.safeParse({ level: '5' });
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.level, 5);
  });

  it('rejects a slider value outside its bounds', () => {
    const resource = defineResource({
      slug: 's2',
      label: 'S2',
      columns: [{ name: 'level', label: 'Level' }],
      fields: [{ name: 'level', label: 'Level', type: 'slider', min: 0, max: 10 }],
      list: async () => ({ rows: [], total: 0 }),
    });
    assert.equal(resource.schema.safeParse({ level: '99' }).success, false);
  });

  it('parses a keyvalue field into an object', () => {
    const resource = defineResource({
      slug: 'kv',
      label: 'KV',
      columns: [{ name: 'meta', label: 'Meta' }],
      fields: [{ name: 'meta', label: 'Meta', type: 'keyvalue' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const parsed = resource.schema.safeParse({ meta: '{"a":"1"}' });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.meta, { a: '1' });
  });
});

describe('markdown field', () => {
  it('stores sanitized HTML through the caller sanitizer', () => {
    const resource = defineResource({
      slug: 'md',
      label: 'MD',
      columns: [{ name: 'body', label: 'Body' }],
      fields: [
        {
          name: 'body',
          label: 'Body',
          type: 'markdown',
          sanitize: (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, ''),
        },
      ],
      list: async () => ({ rows: [], total: 0 }),
    });
    const parsed = resource.schema.safeParse({ body: '<p>hi</p><script>alert(1)</script>' });
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.body, '<p>hi</p>');
  });
});

describe('formset schema', () => {
  const FORMSET_FIELDS: readonly ResourceField[] = [
    { name: 'title', label: 'Title', type: 'text' },
    {
      name: 'addresses',
      label: 'Addresses',
      type: 'repeater',
      formset: {
        fields: [
          { name: 'street', label: 'Street', type: 'text' },
          { name: 'city', label: 'City', type: 'text' },
          { name: 'zip', label: 'ZIP', type: 'number' },
        ],
      },
    },
  ];

  it('reuses flat-key lifting: submitted formset keys are lifted into an array', () => {
    const resource = defineResource({
      slug: 'contacts',
      label: 'Contacts',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ] as readonly ResourceColumn[],
      fields: FORMSET_FIELDS,
      list: async () => ({ rows: [], total: 0 }),
    });
    const result = resource.schema.parse({
      title: 'T',
      'addresses[0].street': 'Main',
      'addresses[0].city': 'Springfield',
      'addresses[0].zip': '12345',
    });
    assert.deepEqual(result, {
      title: 'T',
      addresses: [{ street: 'Main', city: 'Springfield', zip: 12345 }],
    });
  });
});

describe('richText field schema', () => {
  it('round-trips a valid document submitted as a JSON string', () => {
    const resource = defineBodyResource();
    const parsed = resource.schema.safeParse({ body: JSON.stringify(RICH_TEXT_DOCUMENT) });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.body, RICH_TEXT_DOCUMENT);
  });

  it('round-trips a direct object value', () => {
    const resource = defineBodyResource();
    const parsed = resource.schema.safeParse({ body: RICH_TEXT_DOCUMENT });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.body, RICH_TEXT_DOCUMENT);
  });

  it('returns a field error for invalid JSON', () => {
    const resource = defineBodyResource();
    const parsed = resource.schema.safeParse({ body: '{not json' });
    assert.equal(parsed.success, false);
  });

  it('returns a field error for an invalid document', () => {
    const resource = defineBodyResource();
    const parsed = resource.schema.safeParse({
      body: JSON.stringify({ version: 3, blocks: [] }),
    });
    assert.equal(parsed.success, false);
  });

  it('returns a field error for a non-object value', () => {
    const resource = defineBodyResource();
    // A JSON number is valid JSON but not a rich-text document.
    const parsed = resource.schema.safeParse({ body: '42' });
    assert.equal(parsed.success, false);
  });

  it('reads an absent or blank value as no key at all, never an empty document', () => {
    for (const values of [{}, { body: '' }, { body: '  ' }]) {
      const parsed = defineBodyResource().schema.safeParse(values);
      assert.equal(parsed.success, true);
      assert.deepEqual(parsed.success && parsed.data, {});
    }
  });
});

describe('richText field as a writer', () => {
  it('stores the canonical form of a schema-valid submission', () => {
    const parsed = defineBodyResource().schema.safeParse({
      body: JSON.stringify({
        version: 2,
        blocks: [
          {
            type: 'paragraph',
            content: [
              { text: 'a', marks: ['italic', 'bold'] },
              { text: 'b', marks: ['bold', 'italic'] },
              { text: '' },
            ],
          },
          { type: 'list', style: 'ordered', items: [] },
        ],
      }),
    });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.success && parsed.data.body, {
      version: 2,
      blocks: [{ type: 'paragraph', content: [{ text: 'ab', marks: ['bold', 'italic'] }] }],
    });
  });

  it('refuses a version 1 document, a refused URL and an envelope with value-free errors', () => {
    for (const body of [
      { version: 1, blocks: [] },
      { version: 2, blocks: [{ type: 'cta', label: 'Go', href: 'javascript:alert("x1")' }] },
      { version: 1, editor: 'editorjs', content: { version: 1, blocks: [] } },
    ]) {
      const parsed = defineBodyResource().schema.safeParse({ body });
      assert.equal(parsed.success, false);
      assert.doesNotMatch(JSON.stringify(parsed.error?.issues), /javascript|x1/);
    }
  });

  it('refuses a document over the budget', () => {
    const parsed = defineBodyResource().schema.safeParse({
      body: { version: 2, blocks: Array.from({ length: 501 }, () => ({ type: 'divider' })) },
    });
    assert.equal(parsed.success, false);
  });
});
