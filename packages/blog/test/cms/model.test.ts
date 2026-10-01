import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLOG_MENU_MAX_DEPTH,
  BLOG_MENU_MAX_ITEMS,
  contentStatusSchema,
  isAllowedMenuHref,
  jsonValueSchema,
  menuItemSchema,
  menuSchema,
  pageSchema,
  postSchema,
} from '../../src/cms/model.js';

/** A fully-populated, schema-valid post. */
function validPost(): Record<string, unknown> {
  return {
    id: 'p1',
    title: 'Hello',
    slug: 'hello',
    excerpt: '',
    blocks: { version: 2, blocks: [] },
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
    blocks: { version: 2, blocks: [] },
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

describe('menu link policy', () => {
  it('accepts same-origin paths, fragments, and http(s)/mailto URLs', () => {
    for (const href of [
      '/',
      '/about',
      'about',
      '#top',
      '?q=1',
      '/a:b',
      'https://example.com/x',
      'HTTP://example.com',
      'mailto:hi@example.com',
    ]) {
      assert.equal(isAllowedMenuHref(href), true, href);
    }
  });

  it('refuses script schemes, including ones split by a control character', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:alert(1)',
      '\u0000javascript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      '1javascript:x',
      '//evil.example',
      '\\\\evil.example',
      '/\\evil.example',
      ' /padded',
      '',
    ]) {
      assert.equal(isAllowedMenuHref(href), false, JSON.stringify(href));
    }
  });

  it('applies the policy to every stored menu item, nested ones included', () => {
    const item = (href: string) => ({ label: 'x', href, sortOrder: 0, children: [] });
    assert.equal(menuItemSchema.safeParse(item('java\tscript:alert(1)')).success, false);
    assert.equal(
      menuSchema.safeParse({
        id: 'm',
        name: 'n',
        location: 'primary',
        items: [{ ...item('/ok'), children: [item('javascript:alert(1)')] }],
      }).success,
      false,
    );
  });

  it('bounds the menu tree depth and width', () => {
    let tree = { label: 'leaf', href: '/', sortOrder: 0, children: [] as unknown[] };
    for (let depth = 1; depth <= BLOG_MENU_MAX_DEPTH; depth += 1) {
      tree = { label: 'node', href: '/', sortOrder: 0, children: [tree] };
    }
    const menu = (items: unknown[]) => ({ id: 'm', name: 'n', location: 'primary', items });
    assert.equal(menuSchema.safeParse(menu([tree])).success, false);
    assert.equal(menuSchema.safeParse(menu(tree.children)).success, true);
    const wide = Array.from({ length: BLOG_MENU_MAX_ITEMS + 1 }, () => ({
      label: 'x',
      href: '/',
      sortOrder: 0,
      children: [],
    }));
    assert.equal(menuSchema.safeParse(menu(wide)).success, false);
  });
});

describe('slug policy', () => {
  it('accepts lowercase hyphenated slugs only', () => {
    assert.equal(postSchema.safeParse({ ...validPost(), slug: 'hello-world-2' }).success, true);
    for (const slug of [
      '../admin',
      'a?b#c',
      'Upper',
      'a b',
      '-lead',
      'trail-',
      'a--b',
      '<i>x</i>',
    ]) {
      assert.equal(postSchema.safeParse({ ...validPost(), slug }).success, false, slug);
    }
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
