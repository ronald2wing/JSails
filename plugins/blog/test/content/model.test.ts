import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  contentStatusSchema,
  jsonValueSchema,
  menuItemSchema,
  menuSchema,
  pageSchema,
  postSchema,
} from '@jsails/blog';

/** A fully-populated, schema-valid post. */
function validPost(): Record<string, unknown> {
  return {
    id: 'p1',
    title: 'Hello',
    slug: 'hello',
    excerpt: '',
    blocks: { version: 1, blocks: [] },
    status: 'draft',
    authorId: 'a1',
    featuredMediaId: null,
    categoryIds: [],
    tagIds: [],
    publishedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A fully-populated, schema-valid page. */
function validPage(): Record<string, unknown> {
  return {
    id: 'page1',
    title: 'About',
    slug: 'about',
    blocks: { version: 1, blocks: [] },
    status: 'draft',
    parentId: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('jsonValueSchema', () => {
  it('accepts deeply nested JSON-safe values', () => {
    const value = { a: [1, 'two', null, { b: true }], c: false };
    assert.equal(jsonValueSchema.safeParse(value).success, true);
  });

  it('rejects undefined, functions, and Date instances', () => {
    assert.equal(jsonValueSchema.safeParse(undefined).success, false);
    assert.equal(jsonValueSchema.safeParse(() => 0).success, false);
    assert.equal(jsonValueSchema.safeParse(new Date()).success, false);
  });
});

describe('menuItemSchema', () => {
  it('accepts a recursive item tree', () => {
    const item = {
      label: 'Home',
      href: '/',
      sortOrder: 0,
      children: [{ label: 'Sub', href: '/sub', sortOrder: 1, children: [] }],
    };
    const result = menuItemSchema.safeParse(item);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.children.length, 1);
    }
  });

  it('rejects an item missing its children list', () => {
    const result = menuItemSchema.safeParse({
      label: 'Home',
      href: '/',
      sortOrder: 0,
    });
    assert.equal(result.success, false);
  });
});

describe('menuSchema', () => {
  it('accepts a menu with nested items', () => {
    const menu = {
      id: 'm1',
      name: 'Header',
      location: 'header',
      items: [{ label: 'Home', href: '/', sortOrder: 0, children: [] }],
    };
    assert.equal(menuSchema.safeParse(menu).success, true);
  });
});

describe('contentStatusSchema', () => {
  it('accepts every lifecycle status', () => {
    for (const status of ['draft', 'published', 'scheduled', 'archived']) {
      assert.equal(contentStatusSchema.safeParse(status).success, true, status);
    }
  });

  it('rejects an unknown status', () => {
    assert.equal(contentStatusSchema.safeParse('missing').success, false);
  });
});

describe('postSchema', () => {
  it('accepts a valid post', () => {
    assert.equal(postSchema.safeParse(validPost()).success, true);
  });

  it('rejects an invalid status', () => {
    assert.equal(postSchema.safeParse({ ...validPost(), status: 'nope' }).success, false);
  });

  it('accepts a nullable featured media id', () => {
    assert.equal(postSchema.safeParse({ ...validPost(), featuredMediaId: 'm42' }).success, true);
  });
});

describe('pageSchema', () => {
  it('accepts a valid page', () => {
    assert.equal(pageSchema.safeParse(validPage()).success, true);
  });

  it('accepts a nullable parent id', () => {
    assert.equal(pageSchema.safeParse({ ...validPage(), parentId: 'about' }).success, true);
  });
});
