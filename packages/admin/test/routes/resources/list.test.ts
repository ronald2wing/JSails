/**
 * Tests for the resource list route: pagination, the create/edit links, the
 * table state query (allowlisted sort/direction, clamped search, allowlisted
 * filters) preserved through pagination links and the create-form `_back`
 * redirect, and the formatted cells (badge, boolean, date, image, tags,
 * relation) rendered escaped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { postForm } from 'jsails/testing';

import {
  defineResource,
  type Resource,
  type ResourceColumn,
  type ResourceListContext,
} from '../../../src/index.js';
import {
  article,
  createAdminTestApp,
  createArticleStore,
  CSRF,
  defineArticleResource,
} from '../../fixtures.js';

describe('admin resource list', () => {
  it('renders rows, columns, the create link, and edit actions', async () => {
    const store = createArticleStore([
      article('1', { title: 'First', status: 'published', priority: 5, active: true }),
      article('2', { title: 'Second', status: 'draft' }),
      article('3', { title: 'Third', status: 'draft' }),
    ]);
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const response = await app.request('/admin/articles');
    assert.equal(response.status, 200);
    const body = await response.text();

    // Rows and column cells.
    assert.match(body, /First/);
    assert.match(body, /Second/);
    assert.match(body, /Third/);
    assert.match(body, /ID/);
    assert.match(body, /Status/);
    // The create link (a `save` callback is present) and the edit action.
    assert.match(body, /New Articles/);
    assert.match(body, /Edit/);
    // Default pagination: page 1, pageSize 20, three total.
    assert.match(body, /Page 1 of 1 \(3 total\)/);
    assert.deepEqual(store.listCalls, [{ page: 1, pageSize: 20 }]);

    await app.close();
  });

  it('paginates by page and pageSize, showing only the requested slice', async () => {
    const store = createArticleStore([
      article('1', { title: 'First' }),
      article('2', { title: 'Second' }),
      article('3', { title: 'Third' }),
    ]);
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const response = await app.request('/admin/articles?page=2&pageSize=2');
    assert.equal(response.status, 200);
    const body = await response.text();

    assert.match(body, /Page 2 of 2 \(3 total\)/);
    assert.match(body, /Third/);
    assert.doesNotMatch(body, /First/);
    assert.doesNotMatch(body, /Second/);
    assert.match(body, /Previous/);
    assert.doesNotMatch(body, /Next/);
    assert.deepEqual(store.listCalls, [{ page: 2, pageSize: 2 }]);

    await app.close();
  });

  it('falls back to page 1 and the default page size for invalid query params', async () => {
    const store = createArticleStore([article('1', { title: 'First' })]);
    const app = await createAdminTestApp({ resources: [defineArticleResource(store)] });

    const response = await app.request('/admin/articles?page=zero&pageSize=999999');
    assert.equal(response.status, 200);
    assert.deepEqual(store.listCalls, [{ page: 1, pageSize: 100 }]);

    await app.close();
  });
});

describe('admin resource column formats', () => {
  const REPORT_COLUMNS: readonly ResourceColumn[] = [
    { name: 'id', label: 'ID' },
    { name: 'title', label: 'Title' },
    {
      name: 'status',
      label: 'Status',
      format: 'badge',
      colors: { published: 'green', draft: 'gray' },
    },
    { name: 'active', label: 'Active', format: 'boolean', colors: { true: 'green', false: 'red' } },
    { name: 'created', label: 'Created', format: 'date' },
  ];

  function makeReportResource(rows: readonly Record<string, unknown>[]): Resource {
    return defineResource({
      slug: 'reports',
      label: 'Reports',
      columns: REPORT_COLUMNS,
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows, total: rows.length }),
    });
  }

  it('renders badge colors, boolean yes/no, and the date portion', async () => {
    const app = await createAdminTestApp({
      resources: [
        makeReportResource([
          {
            id: '1',
            title: 'Report',
            status: 'published',
            active: true,
            created: '2024-01-15T09:00:00.000Z',
          },
        ]),
      ],
    });

    const body = await (await app.request('/admin/reports')).text();
    assert.match(body, /admin-badge/);
    assert.match(body, /green/);
    assert.match(body, /admin-boolean/);
    assert.match(body, /Yes/);
    assert.match(body, /admin-date/);
    assert.match(body, /2024-01-15/);

    await app.close();
  });

  it('escapes hostile cell values and never emits them raw', async () => {
    const app = await createAdminTestApp({
      resources: [
        makeReportResource([
          {
            id: '1',
            title: '<script>alert(1)</script>',
            status: 'draft',
            active: false,
            created: '',
          },
        ]),
      ],
    });

    const body = await (await app.request('/admin/reports')).text();
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);

    await app.close();
  });
});

describe('admin resource table state', () => {
  type Product = {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly price: number;
  };

  const PRODUCT_COLUMNS: readonly ResourceColumn[] = [
    { name: 'id', label: 'ID' },
    { name: 'name', label: 'Name', sortable: true, searchable: true },
    {
      name: 'status',
      label: 'Status',
      filter: [
        { value: 'published', label: 'Published' },
        { value: 'draft', label: 'Draft' },
      ],
    },
    { name: 'price', label: 'Price', sortable: true },
  ];

  function makeProductResource(calls: ResourceListContext[], rows: Product[] = []): Resource {
    return defineResource({
      slug: 'products',
      label: 'Products',
      columns: PRODUCT_COLUMNS,
      fields: [{ name: 'name', label: 'Name', type: 'text' }],
      list: async (context) => {
        calls.push(context);
        return { rows, total: rows.length };
      },
      save: async () => {},
    });
  }

  it('passes a allowlisted sort and direction through to list', async () => {
    const calls: ResourceListContext[] = [];
    const app = await createAdminTestApp({ resources: [makeProductResource(calls)] });

    await app.request('/admin/products?sort=name&direction=desc');
    assert.equal(calls[0]?.sort, 'name');
    assert.equal(calls[0]?.direction, 'desc');

    // A non-sortable column name is dropped (allowlisted).
    await app.request('/admin/products?sort=id&direction=desc');
    assert.equal(calls[1]?.sort, undefined);

    await app.close();
  });

  it('passes a clamped search term and allowlisted filters to list', async () => {
    const calls: ResourceListContext[] = [];
    const app = await createAdminTestApp({ resources: [makeProductResource(calls)] });

    await app.request('/admin/products?search=abc&f_status=published&f_status=nope');
    assert.equal(calls[0]?.search, 'abc');
    assert.deepEqual(calls[0]?.filters, { status: 'published' });

    // A search term longer than the clamp is truncated before reaching list.
    await app.request(`/admin/products?search=${'a'.repeat(300)}`);
    assert.equal(calls[1]?.search, 'a'.repeat(200));

    await app.close();
  });

  it('preserves sort/search/filter state through pagination links', async () => {
    const rows: Product[] = Array.from({ length: 25 }, (_, i) => ({
      id: String(i + 1),
      name: `Product ${i + 1}`,
      status: 'draft',
      price: i,
    }));
    const calls: ResourceListContext[] = [];
    const app = await createAdminTestApp({ resources: [makeProductResource(calls, rows)] });

    const body = await (
      await app.request('/admin/products?sort=name&search=x&f_status=published&pageSize=10')
    ).text();
    // The Next link must carry the current state so it survives navigation.
    assert.match(body, /sort=name/);
    assert.match(body, /search=x/);
    assert.match(body, /f_status=published/);
    assert.match(body, /Next/);

    await app.close();
  });

  it('escapes a hostile search term in the filter form and never echoes it raw', async () => {
    const calls: ResourceListContext[] = [];
    const app = await createAdminTestApp({ resources: [makeProductResource(calls)] });

    const body = await (
      await app.request('/admin/products?search=<script>alert(1)</script>')
    ).text();
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);

    await app.close();
  });

  it('preserves table state through a create-form save redirect', async () => {
    const calls: ResourceListContext[] = [];
    const app = await createAdminTestApp({ resources: [makeProductResource(calls)] });

    const form = await app.request('/admin/products/new?sort=name');
    const formBody = await form.text();
    assert.match(formBody, /name="_back"/);
    assert.match(formBody, /sort=name/);

    const response = await postForm(app, '/admin/products', {
      _csrf: CSRF,
      name: 'New product',
      _back: 'sort=name',
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/admin/products?sort=name');

    await app.close();
  });
});

describe('admin relation columns', () => {
  const RELATION_COLUMNS: readonly ResourceColumn[] = [
    { name: 'id', label: 'ID' },
    { name: 'title', label: 'Title' },
    {
      name: 'tags',
      label: 'Tags',
      type: 'relation',
      resolve: async (row) => (row['tags'] as string[]) ?? [],
    },
  ];

  function makeRelationResource(rows: readonly Record<string, unknown>[]): Resource {
    return defineResource({
      slug: 'posts',
      label: 'Posts',
      columns: RELATION_COLUMNS,
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows, total: rows.length }),
    });
  }

  it('renders resolved relation labels inside an admin-relation list', async () => {
    const app = await createAdminTestApp({
      resources: [
        makeRelationResource([
          { id: '1', title: 'First', tags: ['a', 'b'] },
          { id: '2', title: 'Second', tags: [] },
        ]),
      ],
    });

    const body = await (await app.request('/admin/posts')).text();
    assert.match(body, /admin-relation/);
    assert.match(body, /<li>a<\/li>/);
    assert.match(body, /<li>b<\/li>/);

    await app.close();
  });

  it('escapes hostile relation labels and renders empty for a resolver failure', async () => {
    const resource = defineResource({
      slug: 'posts',
      label: 'Posts',
      columns: [
        { name: 'id', label: 'ID' },
        {
          name: 'tags',
          label: 'Tags',
          type: 'relation',
          resolve: async (row) => {
            if (row['id'] === 'boom') throw new Error('boom');
            return [row['tags'] as string];
          },
        },
      ],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({
        rows: [
          { id: '1', tags: '<script>alert(1)</script>' },
          { id: 'boom', tags: 'nope' },
        ],
        total: 2,
      }),
    });
    const app = await createAdminTestApp({ resources: [resource] });

    const body = await (await app.request('/admin/posts')).text();
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);
    assert.doesNotMatch(body, /nope/);

    await app.close();
  });
});

describe('column formats', () => {
  it('renders an image cell as an <img> with the resolved src', async () => {
    const resource = defineResource({
      slug: 'media',
      label: 'Media',
      columns: [{ name: 'thumb', label: 'Thumb', format: 'image', imageBaseUrl: '/uploads/' }],
      fields: [{ name: 'thumb', label: 'Thumb', type: 'text' }],
      list: async () => ({ rows: [{ id: '1', thumb: 'a.png' }], total: 1 }),
    });
    const app = await createAdminTestApp({ resources: [resource] });
    const html = await (await app.request('/admin/media')).text();
    assert.match(html, /<img[^>]+src="\/uploads\/a\.png"/);
    await app.close();
  });

  it('renders a tags cell as one element per separator-split value', async () => {
    const resource = defineResource({
      slug: 'posts',
      label: 'Posts',
      columns: [{ name: 'tags', label: 'Tags', format: 'tags' }],
      fields: [{ name: 'tags', label: 'Tags', type: 'text' }],
      list: async () => ({ rows: [{ id: '1', tags: 'a,b' }], total: 1 }),
    });
    const app = await createAdminTestApp({ resources: [resource] });
    const html = await (await app.request('/admin/posts')).text();
    assert.match(html, /admin-tag[^>]*>a</);
    assert.match(html, /admin-tag[^>]*>b</);
    await app.close();
  });
});
