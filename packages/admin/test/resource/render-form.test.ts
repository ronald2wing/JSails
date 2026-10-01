/**
 * Tests for the form page: infolist entries above the edit form, autocomplete
 * and formset inputs (escaped), inline relation manager HTML, and the richText
 * island marker with its no-JS textarea fallback.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEmptyRichTextDocument } from 'jsails/rich-text';

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
  createAdminTestApp,
  defineBodyResource,
  fakeRichTextEditor,
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
      csrf: 'csrf-test',
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
      csrf: 'csrf-test',
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
      csrf: 'csrf-test',
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
        csrfToken: 'csrf-test',
      },
    );

    const html = renderFormPage(panel, resource, {
      id: 'a1',
      record: { id: 'a1', title: 'My Article' },
      values: {},
      errors: {},
      csrf: 'csrf-test',
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
        csrfToken: 'csrf-test',
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
      csrf: 'csrf-test',
      action: '/admin/articles/a1',
      back: '',
      relationManagerHtml: [inlineHtml],
    });
    assert.match(html, /admin-relation-inline/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script/);
  });
});

describe('richText form rendering', () => {
  it('renders the named JSON textarea and the island marker on an empty create form', async () => {
    const app = await createAdminTestApp({ resources: [defineBodyResource()] });
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
    const resource = defineBodyResource({
      get: async ({ id }) => ({ id, body: RICH_TEXT_DOCUMENT }),
    });
    const app = await createAdminTestApp({ resources: [resource] });
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
    const resource = defineBodyResource({
      get: async () => ({ id: '1' }),
    });
    const app = await createAdminTestApp({ resources: [resource] });
    const body = await (await app.request('/admin/bodies/1')).text();

    assert.match(body, /&quot;blocks&quot;:\[\]/);
    assert.deepEqual(createEmptyRichTextDocument(), { version: 1, blocks: [] });

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
    const body = await (await app.request('/admin/bodies/new')).text();

    assert.match(body, /&quot;mediaPickerUrl&quot;:&quot;\/admin\/media\?format=json&quot;/);
    await app.close();
  });
});

describe('richText editor adapter field', () => {
  function editorResource(): Resource {
    return defineBodyResource({
      fields: [{ name: 'body', label: 'Body', type: 'richText', editor: fakeRichTextEditor }],
    });
  }

  it('renders the adapter island and passes the editor id in the mount props', async () => {
    const app = await createAdminTestApp({ resources: [editorResource()] });
    const body = await (await app.request('/admin/bodies/new')).text();

    assert.match(body, /data-jsails-island="fake-editor"/);
    assert.match(body, /&quot;editor&quot;:&quot;fake&quot;/);
    assert.match(body, /data-jsails-rich-text/);
    await app.close();
  });
});
