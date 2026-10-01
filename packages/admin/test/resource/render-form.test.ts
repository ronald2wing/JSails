/**
 * Tests for the form page: infolist entries above the edit form, autocomplete
 * and formset inputs (escaped), inline relation manager HTML, and the richText
 * field's island markup: a named source input for a readable value, an
 * unnamed one beside its issues for an unreadable value, and an absent
 * value on update reaching the save as no key.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEmptyRichTextDocument } from 'jsails/rich-text';
import { postForm } from 'jsails/testing';

import {
  defineAdminPanel,
  defineRelationManager,
  defineResource,
  renderRelationManager,
  type Resource,
  type ResourceColumn,
  type ResourceField,
  type ResourceGetContext,
  type ResourceInfolist,
} from '../../src/index.js';
import { renderFormPage } from '../../src/resource/render-form.js';
import {
  allowAll,
  createAdminTestApp,
  defineBodyResource,
  RICH_TEXT_DOCUMENT,
  SESSION,
} from '../fixtures.js';

describe('admin infolists', () => {
  const INFOLIST: ResourceInfolist = {
    label: 'Details',
    entries: [
      {
        name: 'status',
        label: 'Status',
        format: 'badge',
        colors: { open: 'green', closed: 'gray' },
      },
      {
        name: 'active',
        label: 'Active',
        format: 'boolean',
        colors: { true: 'green', false: 'red' },
      },
      { name: 'created', label: 'Created', format: 'date' },
    ],
  };

  function makeInfolistResource(): Resource {
    return defineResource({
      authorize: allowAll,
      slug: 'items',
      label: 'Items',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
      get: async ({ id }: ResourceGetContext) => {
        if (id !== '1') return null;
        return {
          id: '1',
          title: 'Item',
          status: 'open',
          active: true,
          created: '2024-01-15T09:00:00.000Z',
        };
      },
      infolist: INFOLIST,
    });
  }

  it('renders badge, boolean, and date infolist entries above the edit form', async () => {
    const app = await createAdminTestApp({ resources: [makeInfolistResource()] });

    const body = await (await app.request('/admin/items/1')).text();
    assert.match(body, /admin-infolist/);
    assert.match(body, /Details/);
    assert.match(body, /admin-badge/);
    assert.match(body, />open</);
    assert.match(body, /green/);
    assert.match(body, /admin-boolean/);
    assert.match(body, /Yes/);
    assert.match(body, /admin-date/);
    assert.match(body, /2024-01-15/);

    await app.close();
  });

  it('omits the infolist from the create form (no record)', async () => {
    const app = await createAdminTestApp({ resources: [makeInfolistResource()] });

    const body = await (await app.request('/admin/items/new')).text();
    assert.doesNotMatch(body, /admin-infolist/);

    await app.close();
  });
});

describe('admin autocomplete fields', () => {
  const BASE = {
    slug: 'items',
    label: 'Items',
    columns: [{ name: 'id', label: 'ID' }] as readonly ResourceColumn[],
    authorize: allowAll,
    list: async () => ({ rows: [], total: 0 }),
  };

  it('renders an autocomplete field as a text input with the data marker', async () => {
    const resource = defineResource({
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
    const app = await createAdminTestApp({ resources: [resource] });

    const body = await (await app.request('/admin/items/new')).text();
    assert.match(body, /type="text"/);
    assert.match(body, /name="tag"/);
    assert.match(body, /data-jsails-autocomplete/);

    await app.close();
  });

  it('escapes a hostile query value in the autocomplete input', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    const resource = defineResource({
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
    const html = renderFormPage(panel, resource, {
      id: null,
      values: { tag: '<script>alert(1)</script>' },
      errors: {},
      action: '/admin/items',
      back: '',
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script/);
  });
});

describe('admin formsets', () => {
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

  function makeFormsetResource(saveStore: Array<Record<string, unknown>>): Resource {
    return defineResource({
      authorize: allowAll,
      slug: 'contacts',
      label: 'Contacts',
      columns: [
        { name: 'id', label: 'ID' },
        { name: 'title', label: 'Title' },
      ],
      fields: FORMSET_FIELDS,
      list: async () => ({ rows: [], total: 0 }),
      save: async ({ values }) => {
        saveStore.push(values);
      },
    });
  }

  it('renders formset rows with flat-key inputs, an Add button, and a Remove button', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    const resource = makeFormsetResource([]);
    const html = renderFormPage(panel, resource, {
      id: null,
      values: {},
      errors: {},
      action: '/admin/contacts',
      back: '',
    });
    assert.match(html, /name="addresses\[0\]\.street"/);
    assert.match(html, /name="addresses\[0\]\.city"/);
    assert.match(html, /name="addresses\[0\]\.zip"/);
    assert.match(html, /name="_repeater_add" value="addresses"/);
    assert.match(html, /name="_repeater_remove" value="addresses\.0"/);
  });

  it('escapes a hostile value in a formset item input', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    const resource = makeFormsetResource([]);
    const html = renderFormPage(panel, resource, {
      id: null,
      values: { 'addresses[0].street': '<script>alert(1)</script>' },
      errors: {},
      action: '/admin/contacts',
      back: '',
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script/);
  });
});

describe('admin inline relation managers', () => {
  const INLINE_COLUMNS: readonly ResourceColumn[] = [
    { name: 'id', label: 'ID' },
    { name: 'title', label: 'Title' },
  ];

  it('renderFormPage embeds relationManagerHtml strings with admin-relation-inline class', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    const resource = defineResource({
      authorize: allowAll,
      slug: 'articles',
      label: 'Articles',
      columns: INLINE_COLUMNS,
      fields: [{ name: 'title', label: 'Title', type: 'text' }] as readonly ResourceField[],
      list: async () => ({ rows: [], total: 0 }),
    });
    const inlineHtml = renderRelationManager(
      defineRelationManager({
        name: 'comments',
        label: 'Comments',
        related: defineResource({
          authorize: allowAll,
          slug: 'comments',
          label: 'Comments',
          columns: [{ name: 'body', label: 'Body' }],
          fields: [{ name: 'body', label: 'Body', type: 'text' }],
          list: async () => ({ rows: [], total: 0 }),
        }),
        foreignKey: 'articleId',
        list: async () => ({ rows: [{ id: 'c1', body: 'Great post' }], total: 1 }),
      }),
      [{ id: 'c1', body: 'Great post' }],
      'a1',
      {
        panelPath: '/admin',
        resourceSlug: 'articles',
      },
    );

    const html = renderFormPage(panel, resource, {
      id: 'a1',
      record: { id: 'a1', title: 'My Article' },
      values: {},
      errors: {},
      action: '/admin/articles/a1',
      back: '',
      relationManagerHtml: [inlineHtml],
    });
    assert.match(html, /admin-relation-inline/);
    assert.match(html, /admin-relation-manager/);
    assert.match(html, /Great post/);
  });

  it('renderFormPage escapes hostile relation manager content passed inline', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
    });
    const resource = defineResource({
      authorize: allowAll,
      slug: 'articles',
      label: 'Articles',
      columns: INLINE_COLUMNS,
      fields: [{ name: 'title', label: 'Title', type: 'text' }] as readonly ResourceField[],
      list: async () => ({ rows: [], total: 0 }),
    });
    // renderRelationManager already escapes cell values (tested earlier), so a
    // hostile value becomes &lt;script&gt; in the HTML string. When we embed
    // that via dangerouslySetInnerHTML the raw <script> is never present.
    const inlineHtml = renderRelationManager(
      defineRelationManager({
        name: 'comments',
        label: 'Comments',
        related: defineResource({
          authorize: allowAll,
          slug: 'comments',
          label: 'Comments',
          columns: [{ name: 'body', label: 'Body' }],
          fields: [{ name: 'body', label: 'Body', type: 'text' }],
          list: async () => ({ rows: [], total: 0 }),
        }),
        foreignKey: 'articleId',
        list: async () => ({ rows: [{ id: 'c1', body: '<script>alert(1)</script>' }], total: 1 }),
      }),
      [{ id: 'c1', body: '<script>alert(1)</script>' }],
      'a1',
      {
        panelPath: '/admin',
        resourceSlug: 'articles',
      },
    );
    // renderRelationManager already escapes — verify the inline wrapper still
    // produces safe output.
    assert.doesNotMatch(inlineHtml, /<script>/);
    assert.match(inlineHtml, /&lt;script/);

    const html = renderFormPage(panel, resource, {
      id: 'a1',
      record: { id: 'a1', title: 'My Article' },
      values: {},
      errors: {},
      action: '/admin/articles/a1',
      back: '',
      relationManagerHtml: [inlineHtml],
    });
    assert.match(html, /admin-relation-inline/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script/);
  });
});

/** The `rich-text` island element's opening tag and its decoded props. */
function richTextIsland(html: string): { readonly tag: string; readonly props: unknown } {
  const tag = /<div data-jsails-island="rich-text"[^>]*>/.exec(html)?.[0];
  assert.ok(tag !== undefined, 'the rich-text island marker');
  const props = /data-jsails-props="([^"]*)"/.exec(tag)?.[1] ?? '';
  return { tag, props: JSON.parse(props.replaceAll('&quot;', '"').replaceAll('&amp;', '&')) };
}

/** The source input of the rich-text field: whether it is named, and its decoded value. */
function richTextSource(html: string): { readonly name: string | null; readonly value: string } {
  // An attribute value may hold `>`, so the input is matched attribute by attribute.
  const match =
    /<input type="hidden" data-rich-text-source(?: name="([^"]*)")? value="([^"]*)"/.exec(html);
  assert.ok(match !== null, 'the rich-text source input');
  return {
    name: match[1] ?? null,
    value: (match[2] ?? '')
      .replaceAll('&quot;', '"')
      .replaceAll('&lt;', '<')
      .replaceAll('&amp;', '&'),
  };
}

describe('richText form rendering', () => {
  it('renders the island marker, its props and the named source input on a create form', async () => {
    const app = await createAdminTestApp({ resources: [defineBodyResource()] });
    const html = await (await app.request('/admin/bodies/new')).text();

    // The props name the field and label the editor; the document travels in
    // the source input, never in the bounded props.
    assert.deepEqual(richTextIsland(html).props, { name: 'body', label: 'Body', id: 'field-body' });
    assert.match(html, /<label for="field-body">Body<\/label>/);
    assert.deepEqual(richTextSource(html), {
      name: 'body',
      value: JSON.stringify(createEmptyRichTextDocument()),
    });
    assert.match(
      html,
      /<div class="rich-text-editor" data-state="loading"><p class="rich-text-editor-fallback">Editing this field needs JavaScript/,
    );
    assert.doesNotMatch(html, /<textarea[^>]*name="body"/);
    await app.close();
  });

  it('carries a stored document under the field name, so a no-JS save round-trips it', async () => {
    const resource = defineBodyResource({
      get: async ({ id }) => ({ id, body: RICH_TEXT_DOCUMENT }),
    });
    const app = await createAdminTestApp({ resources: [resource] });
    const html = await (await app.request('/admin/bodies/1')).text();

    assert.deepEqual(richTextSource(html), {
      name: 'body',
      value: JSON.stringify(RICH_TEXT_DOCUMENT),
    });
    assert.equal(JSON.stringify(richTextIsland(html).props).includes('Hello rich text'), false);
    await app.close();
  });

  it('carries an unreadable stored body without a name, beside its issues', async () => {
    const stored = { version: 1, blocks: [{ type: 'paragraph', text: 'Old <b>body</b>' }] };
    const resource = defineBodyResource({ get: async ({ id }) => ({ id, body: stored }) });
    const app = await createAdminTestApp({ resources: [resource] });
    const html = await (await app.request('/admin/bodies/1')).text();

    assert.deepEqual(richTextSource(html), { name: null, value: JSON.stringify(stored) });
    assert.match(html, /<div class="rich-text-editor" data-state="unreadable">/);
    assert.match(html, /This content cannot be edited here\./);
    assert.match(
      html,
      /<li>version: version 1 documents must be upgraded with upgradeRichTextDocument<\/li>/,
    );
    assert.match(html, /Saving the form keeps the stored content unchanged\./);
    assert.doesNotMatch(html, /name="body"/);
    await app.close();
  });

  it('starts from the empty document when the record has no value', async () => {
    const resource = defineBodyResource({ get: async () => ({ id: '1' }) });
    const app = await createAdminTestApp({ resources: [resource] });
    const html = await (await app.request('/admin/bodies/1')).text();

    assert.deepEqual(richTextSource(html), {
      name: 'body',
      value: JSON.stringify({ version: 2, blocks: [] }),
    });
    await app.close();
  });

  it('passes the mediaPickerUrl through the island props', async () => {
    const resource = defineBodyResource({
      fields: [
        {
          name: 'body',
          label: 'Body',
          type: 'richText',
          mediaPickerUrl: '/admin/media?format=json',
        },
      ],
    });
    const app = await createAdminTestApp({ resources: [resource] });
    const html = await (await app.request('/admin/bodies/new')).text();

    assert.deepEqual(richTextIsland(html).props, {
      name: 'body',
      label: 'Body',
      id: 'field-body',
      mediaPickerUrl: '/admin/media?format=json',
    });
    await app.close();
  });
});

describe('richText re-render after a refused submission', () => {
  function bodyAndTitle(): Resource {
    return defineBodyResource({
      fields: [
        { name: 'body', label: 'Body', type: 'richText' },
        { name: 'title', label: 'Title', type: 'text' },
      ],
    });
  }

  it('carries the normalised submission under the field name', async () => {
    const app = await createAdminTestApp({ resources: [bodyAndTitle()] });
    const submitted = JSON.stringify({
      version: 2,
      blocks: [{ type: 'paragraph', content: [{ text: 'a' }, { text: 'b' }] }],
    });
    const response = await postForm(app, '/admin/bodies', { body: submitted });
    const html = await response.text();

    assert.equal(response.status, 422);
    assert.deepEqual(richTextSource(html), {
      name: 'body',
      value: JSON.stringify({
        version: 2,
        blocks: [{ type: 'paragraph', content: [{ text: 'ab' }] }],
      }),
    });
    await app.close();
  });

  it('carries a refused submission without a name, with the field error', async () => {
    const app = await createAdminTestApp({ resources: [bodyAndTitle()] });
    const response = await postForm(app, '/admin/bodies', {
      body: '{"version":2,"blocks":[',
      title: 'Post',
    });
    const html = await response.text();

    assert.equal(response.status, 422);
    assert.deepEqual(richTextSource(html), { name: null, value: '{"version":2,"blocks":[' });
    assert.match(html, /This content cannot be edited here\./);
    await app.close();
  });
});

describe('richText absent on update', () => {
  it('hands the save no body, so the stored body stays as it is', async () => {
    const saves: Record<string, unknown>[] = [];
    const resource = defineResource({
      slug: 'bodies',
      label: 'Bodies',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'body', label: 'Body', type: 'richText' },
      ],
      authorize: allowAll,
      list: async () => ({ rows: [], total: 0 }),
      get: async ({ id }) => ({ id, title: 'Old', body: { version: 1, blocks: [] } }),
      save: async ({ values }) => {
        saves.push(values);
      },
    });
    const app = await createAdminTestApp({ resources: [resource] });
    // What a browser submits for an unreadable body: the source input has no name.
    const response = await postForm(app, '/admin/bodies/1', { title: 'New' });

    assert.equal(response.status, 303);
    assert.deepEqual(saves, [{ title: 'New' }]);
    await app.close();
  });
});
