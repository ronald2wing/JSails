/**
 * Tests for the global search page: searchable resources are queried, matching
 * rows link to their edit pages, rows the session may not view are excluded, a
 * throwing resource is skipped, and the search term is never echoed raw.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from 'jsails';

import { defineResource, type Resource } from '../src/index.js';
import { createAdminTestApp } from './fixtures.js';

describe('admin global search', () => {
  type Article = {
    readonly id: string;
    readonly title: string;
  };

  const ARTICLES: Article[] = [
    { id: '1', title: 'First post' },
    { id: '2', title: 'Second post' },
    { id: '3', title: 'Hidden post' },
  ];

  function makeSearchableArticles(
    rows: Article[] = ARTICLES,
    authorize?: (session: Session, action: string, recordId?: string) => boolean,
  ): Resource {
    return defineResource({
      slug: 'articles',
      label: 'Articles',
      columns: [
        { name: 'title', label: 'Title', searchable: true },
        { name: 'id', label: 'ID' },
      ],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async ({ search }) => {
        const term = search ?? '';
        const filtered = term === '' ? rows : rows.filter((r) => r.title.includes(term));
        return { rows: filtered, total: filtered.length };
      },
      get: async ({ id }) => rows.find((r) => r.id === id) ?? null,
      ...(authorize === undefined
        ? {}
        : {
            authorize: (context: { session: Session; action: string; recordId?: string }) =>
              authorize(context.session, context.action, context.recordId),
          }),
    });
  }

  function makeNonSearchableNotes(): Resource {
    return defineResource({
      slug: 'notes',
      label: 'Notes',
      columns: [{ name: 'title', label: 'Title' }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows: [{ id: 'n1', title: 'A note' }], total: 1 }),
    });
  }

  function createSearchApp(resources: Resource[]) {
    return createAdminTestApp({ resources });
  }

  it('searches searchable resources and links matching rows', async () => {
    const app = await createSearchApp([makeSearchableArticles()]);

    const body = await (await app.request('/admin/_search?q=Second')).text();
    assert.match(body, /Articles/);
    assert.match(body, /Second post/);
    assert.match(body, /\/admin\/articles\/2/);
    assert.doesNotMatch(body, /First post/);

    await app.close();
  });

  it('skips resources without a searchable column', async () => {
    const app = await createSearchApp([makeSearchableArticles(), makeNonSearchableNotes()]);

    const body = await (await app.request('/admin/_search?q=post')).text();
    assert.match(body, /Articles/);
    assert.doesNotMatch(body, /Notes/);
    assert.doesNotMatch(body, /A note/);

    await app.close();
  });

  it('excludes rows the session may not view', async () => {
    const app = await createSearchApp([
      makeSearchableArticles(ARTICLES, (_session, action, recordId) =>
        action === 'view' ? recordId !== '3' : true,
      ),
    ]);

    const body = await (await app.request('/admin/_search?q=post')).text();
    assert.match(body, /First post/);
    assert.doesNotMatch(body, /Hidden post/);

    await app.close();
  });

  it('skips a resource whose list throws instead of failing the page', async () => {
    const throwing = defineResource({
      slug: 'broken',
      label: 'Broken',
      columns: [{ name: 'title', label: 'Title', searchable: true }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => {
        throw new Error('boom');
      },
    });
    const app = await createSearchApp([throwing, makeSearchableArticles()]);

    const response = await app.request('/admin/_search?q=post');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Articles/);
    assert.doesNotMatch(body, /Broken/);

    await app.close();
  });

  it('escapes a hostile search term in the form and never echoes it raw', async () => {
    const app = await createSearchApp([makeSearchableArticles()]);

    const body = await (await app.request('/admin/_search?q=<script>alert(1)</script>')).text();
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);

    await app.close();
  });
});
