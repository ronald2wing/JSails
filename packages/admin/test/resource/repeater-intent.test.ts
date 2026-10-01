/**
 * Tests for repeater fields through the form routes: the rendered item inputs
 * with Add/Remove buttons, add and remove intents applied without saving
 * (renumbering the remaining items), the `maxItems` bound, and value-free item
 * validation followed by a coerced array save.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { postForm } from 'jsails/testing';

import { defineResource, type Resource, type ResourceField } from '../../src/index.js';
import { createAdminTestApp, CSRF } from '../fixtures.js';

describe('admin repeater fields', () => {
  interface RepeaterStore {
    saves: Array<{ id: string | null; values: Record<string, unknown> }>;
  }

  const REPEATER_FIELDS: readonly ResourceField[] = [
    { name: 'title', label: 'Title', type: 'text' },
    {
      name: 'tags',
      label: 'Tags',
      type: 'repeater',
      repeater: {
        fields: [
          { name: 'name', label: 'Name', type: 'text' },
          { name: 'count', label: 'Count', type: 'number' },
        ],
      },
    },
  ];

  function makeRepeaterResource(store: RepeaterStore, maxItems?: number): Resource {
    return defineResource({
      slug: 'tags',
      label: 'Tags',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: REPEATER_FIELDS.map((field) =>
        field.type === 'repeater' && maxItems !== undefined
          ? { ...field, repeater: { ...field.repeater!, maxItems } }
          : field,
      ),
      list: async () => ({ rows: [], total: 0 }),
      save: async ({ id, values }) => {
        store.saves.push({ id, values });
      },
    });
  }

  it('renders the repeater with an item input, a Remove button, and an Add button', async () => {
    const app = await createAdminTestApp({ resources: [makeRepeaterResource({ saves: [] })] });

    const body = await (await app.request('/admin/tags/new')).text();
    assert.match(body, /name="tags\[0\]\.name"/);
    assert.match(body, /name="_repeater_add" value="tags"/);
    assert.match(body, /name="_repeater_remove" value="tags\.0"/);

    await app.close();
  });

  it('applies an add intent without saving, rendering a second item', async () => {
    const store: RepeaterStore = { saves: [] };
    const app = await createAdminTestApp({ resources: [makeRepeaterResource(store)] });

    const response = await postForm(app, '/admin/tags', {
      _csrf: CSRF,
      title: 'T',
      'tags[0].name': 'a',
      'tags[0].count': '1',
      _repeater_add: 'tags',
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /name="tags\[1\]\.name"/);
    assert.match(body, /value="a"/);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('applies a remove intent, renumbering the remaining items without saving', async () => {
    const store: RepeaterStore = { saves: [] };
    const app = await createAdminTestApp({ resources: [makeRepeaterResource(store)] });

    const response = await postForm(app, '/admin/tags', {
      _csrf: CSRF,
      title: 'T',
      'tags[0].name': 'a',
      'tags[0].count': '1',
      'tags[1].name': 'b',
      'tags[1].count': '2',
      _repeater_remove: 'tags.0',
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /name="tags\[0\]\.name"/);
    assert.match(body, /value="b"/);
    assert.match(body, /value="2"/);
    assert.doesNotMatch(body, /tags\[1\]\.name/);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('omits the Add button at maxItems and rejects an over-bound submission', async () => {
    const store: RepeaterStore = { saves: [] };
    const app = await createAdminTestApp({ resources: [makeRepeaterResource(store, 1)] });

    const form = await (await app.request('/admin/tags/new')).text();
    assert.doesNotMatch(form, /_repeater_add/);

    const response = await postForm(app, '/admin/tags', {
      _csrf: CSRF,
      title: 'T',
      'tags[0].name': 'a',
      'tags[0].count': '1',
      'tags[1].name': 'b',
      'tags[1].count': '2',
    });
    assert.equal(response.status, 422);
    assert.match(await response.text(), /Must have at most 1 items/);
    assert.equal(store.saves.length, 0);

    await app.close();
  });

  it('validates a repeater item value-free and coerces a valid save to an array', async () => {
    const store: RepeaterStore = { saves: [] };
    const app = await createAdminTestApp({ resources: [makeRepeaterResource(store)] });

    const invalid = await postForm(app, '/admin/tags', {
      _csrf: CSRF,
      title: 'T',
      'tags[0].name': 'a',
      'tags[0].count': 'not-a-number',
    });
    assert.equal(invalid.status, 422);
    assert.match(await invalid.text(), /Expected a number/);
    assert.equal(store.saves.length, 0);

    const valid = await postForm(app, '/admin/tags', {
      _csrf: CSRF,
      title: 'T',
      'tags[0].name': 'a',
      'tags[0].count': '5',
    });
    assert.equal(valid.status, 303);
    assert.deepEqual(store.saves[0]!.values['tags'], [{ name: 'a', count: 5 }]);

    await app.close();
  });
});
