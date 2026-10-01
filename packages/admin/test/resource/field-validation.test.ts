/**
 * Tests for field validation at `defineResource` time: type, duplicate names,
 * inherited-property names, select/radio options, markdown sanitizers,
 * repeater and formset configs, autocomplete configs, and the richText field's
 * exclusions. Every rejection is a value-free `AdminDefinitionError`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminDefinitionError,
  defineResource,
  type ResourceColumn,
  type ResourceField,
} from '../../src/index.js';

describe('field validation', () => {
  const base = () => ({
    slug: 'ok',
    label: 'Label',
    columns: [{ name: 'id', label: 'ID' }],
    fields: [] as ResourceField[],
    list: async () => ({ rows: [], total: 0 }),
  });

  it('rejects an invalid field type, duplicate names, and options on a non-select', () => {
    assert.throws(
      () =>
        defineResource({ ...base(), fields: [{ name: 'f', label: 'F', type: 'bogus' as never }] }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [
            { name: 'f', label: 'F', type: 'text' },
            { name: 'f', label: 'G', type: 'text' },
          ],
        }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [{ name: 'f', label: 'F', type: 'text', options: [{ value: 'a', label: 'A' }] }],
        }),
      AdminDefinitionError,
    );
  });

  it('rejects select options that are empty or have duplicate values', () => {
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [{ name: 'f', label: 'F', type: 'select', options: [] }],
        }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [
            {
              name: 'f',
              label: 'F',
              type: 'select',
              options: [
                { value: 'a', label: 'A' },
                { value: 'a', label: 'A2' },
              ],
            },
          ],
        }),
      AdminDefinitionError,
    );
  });

  it('rejects a field name shadowing an inherited property', () => {
    for (const name of ['toString', 'constructor', '__proto__']) {
      assert.throws(
        () => defineResource({ ...base(), fields: [{ name, label: 'F', type: 'text' }] }),
        AdminDefinitionError,
        `field name ${name}`,
      );
    }
  });

  it('rejects a radio field without options and options on an unsupported field', () => {
    assert.throws(
      () => defineResource({ ...base(), fields: [{ name: 'p', label: 'P', type: 'radio' }] }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base(),
          fields: [
            { name: 'n', label: 'N', type: 'number', options: [{ value: 'a', label: 'A' }] },
          ],
        }),
      AdminDefinitionError,
    );
  });

  it('rejects a markdown field without a sanitize function', () => {
    assert.throws(
      () =>
        defineResource({
          slug: 'md2',
          label: 'MD2',
          columns: [{ name: 'body', label: 'Body' }],
          fields: [{ name: 'body', label: 'Body', type: 'markdown' }],
          list: async () => ({ rows: [], total: 0 }),
        }),
      AdminDefinitionError,
    );
  });
});

describe('repeater validation', () => {
  it('rejects an empty, out-of-bounds, or non-scalar repeater config at defineResource time', () => {
    const base = {
      slug: 'tags',
      label: 'Tags',
      columns: [{ name: 'id', label: 'ID' }],
      list: async () => ({ rows: [], total: 0 }),
    };
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [{ name: 'tags', label: 'Tags', type: 'repeater', repeater: { fields: [] } }],
        }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'tags',
              label: 'Tags',
              type: 'repeater',
              repeater: {
                fields: [{ name: 'name', label: 'Name', type: 'text' }],
                maxItems: 0,
              },
            },
          ],
        }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'tags',
              label: 'Tags',
              type: 'repeater',
              repeater: {
                fields: [{ name: 'name', label: 'Name', type: 'file' as never }],
              },
            },
          ],
        }),
      AdminDefinitionError,
    );
    // `repeater` on a non-repeater field is rejected too.
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'x',
              label: 'X',
              type: 'text',
              repeater: { fields: [{ name: 'n', label: 'N', type: 'text' }] },
            },
          ],
        }),
      AdminDefinitionError,
    );
  });
});

describe('autocomplete validation', () => {
  const BASE = {
    slug: 'items',
    label: 'Items',
    columns: [{ name: 'id', label: 'ID' }] as readonly ResourceColumn[],
    list: async () => ({ rows: [], total: 0 }),
  };

  it('validates the autocomplete config: search must be a function, minChars >= 1', () => {
    // No autocomplete config on an autocomplete field
    assert.throws(
      () =>
        defineResource({
          ...BASE,
          fields: [{ name: 'tag', label: 'Tag', type: 'autocomplete' }] as readonly ResourceField[],
        }),
      AdminDefinitionError,
    );
    // search not a function
    assert.throws(
      () =>
        defineResource({
          ...BASE,
          fields: [
            {
              name: 'tag',
              label: 'Tag',
              type: 'autocomplete',
              autocomplete: { search: 'not-a-function' as never },
            },
          ] as readonly ResourceField[],
        }),
      AdminDefinitionError,
    );
    // minChars < 1
    assert.throws(
      () =>
        defineResource({
          ...BASE,
          fields: [
            {
              name: 'tag',
              label: 'Tag',
              type: 'autocomplete',
              autocomplete: { search: async () => [], minChars: 0 },
            },
          ] as readonly ResourceField[],
        }),
      AdminDefinitionError,
    );
    // minChars non-integer
    assert.throws(
      () =>
        defineResource({
          ...BASE,
          fields: [
            {
              name: 'tag',
              label: 'Tag',
              type: 'autocomplete',
              autocomplete: { search: async () => [], minChars: 1.5 },
            },
          ] as readonly ResourceField[],
        }),
      AdminDefinitionError,
    );
    // Valid spec (defaults minChars to 2)
    const r = defineResource({
      ...BASE,
      fields: [
        {
          name: 'tag',
          label: 'Tag',
          type: 'autocomplete',
          autocomplete: { search: async () => [] },
        },
      ] as readonly ResourceField[],
    });
    assert.equal(r.fields[0]!.type, 'autocomplete');
    assert.equal(r.fields[0]!.autocomplete!.search !== undefined, true);
    // Valid spec with explicit minChars
    const r2 = defineResource({
      ...BASE,
      fields: [
        {
          name: 'tag',
          label: 'Tag',
          type: 'autocomplete',
          autocomplete: { search: async () => [], minChars: 3 },
        },
      ] as readonly ResourceField[],
    });
    assert.equal(r2.fields[0]!.autocomplete!.minChars, 3);
  });

  it('rejects autocomplete config on a non-autocomplete field', () => {
    assert.throws(
      () =>
        defineResource({
          ...BASE,
          fields: [
            {
              name: 'tag',
              label: 'Tag',
              type: 'text',
              autocomplete: { search: async () => [] },
            },
          ] as readonly ResourceField[],
        }),
      AdminDefinitionError,
    );
  });
});

describe('formset validation', () => {
  it('rejects minItems > maxItems at defineResource time', () => {
    const base = {
      slug: 'c',
      label: 'C',
      columns: [{ name: 'id', label: 'ID' }] as readonly ResourceColumn[],
      list: async () => ({ rows: [], total: 0 }),
    };
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'addrs',
              label: 'Addrs',
              type: 'repeater',
              formset: {
                fields: [{ name: 'street', label: 'Street', type: 'text' }],
                minItems: 5,
                maxItems: 2,
              },
            },
          ] as readonly ResourceField[],
        }),
      AdminDefinitionError,
    );
    // formset on a non-repeater field is rejected.
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'x',
              label: 'X',
              type: 'text',
              formset: { fields: [{ name: 'n', label: 'N', type: 'text' }] },
            },
          ] as readonly ResourceField[],
        }),
      AdminDefinitionError,
    );
    // both repeater and formset on the same field is rejected.
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'addrs',
              label: 'Addrs',
              type: 'repeater',
              repeater: {
                fields: [{ name: 'street', label: 'Street', type: 'text' }],
              },
              formset: {
                fields: [{ name: 'street', label: 'Street', type: 'text' }],
              },
            },
          ] as readonly ResourceField[],
        }),
      AdminDefinitionError,
    );
    // empty formset fields is rejected.
    assert.throws(
      () =>
        defineResource({
          ...base,
          fields: [
            {
              name: 'addrs',
              label: 'Addrs',
              type: 'repeater',
              formset: { fields: [] },
            },
          ] as readonly ResourceField[],
        }),
      AdminDefinitionError,
    );
  });
});

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
      AdminDefinitionError,
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
      AdminDefinitionError,
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
        AdminDefinitionError,
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
        AdminDefinitionError,
      );
    }
  });
});
