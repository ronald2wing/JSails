/**
 * Listing tests: blogIndex (sort, tag filter, limit), tagIndex (count
 * descending, then term), and pageUrl (derivation and override).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { blogIndex, defineTaxonomy, pageUrl, tagIndex, type ContentPage } from '../src/index.js';
import { postsCollection } from './fixtures.js';

describe('blogIndex', () => {
  it('returns non-draft pages sorted newest-first', async (t) => {
    const collection = await postsCollection(t);
    const posts = blogIndex(collection);

    const slugs = posts.map((p) => p.slug);
    // post-b (2026-10-10) > post-a (2026-10-05) > no-date (no date).
    assert.deepEqual(slugs, ['post-b', 'post-a', 'no-date']);
  });

  it('applies a limit', async (t) => {
    const collection = await postsCollection(t);
    const posts = blogIndex(collection, { limit: 1 });

    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.slug, 'post-b');
  });

  it('filters by tag', async (t) => {
    const collection = await postsCollection(t);
    const posts = blogIndex(collection, { tag: 'javascript' });

    const slugs = posts.map((p) => p.slug);
    assert.deepEqual(slugs, ['post-a', 'no-date']);
  });

  it('combines limit and tag filter', async (t) => {
    const collection = await postsCollection(t);
    const posts = blogIndex(collection, { tag: 'guide', limit: 1 });

    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.slug, 'post-b');
  });
});

describe('tagIndex', () => {
  it('sorts terms by count descending then term ascending', async (t) => {
    const collection = await postsCollection(t);
    const taxonomy = defineTaxonomy({ collection, field: 'tags' });
    const terms = tagIndex(taxonomy);

    const names = terms.map((x) => x.term);
    // guide: 2, javascript: 2, typescript: 1. But within ties, alphabetical.
    // Actually: javascript appears on post-a and no-date → 2.
    // guide appears on post-a and post-b → 2.
    // typescript appears on post-b → 1.
    // "guide" < "javascript" alphabetically, so for count=2: guide, javascript.
    assert.deepEqual(names, ['guide', 'javascript', 'typescript']);
  });

  it('returns an empty array for an empty taxonomy', () => {
    const taxonomy = defineTaxonomy({
      collection: { pages: [], bySlug: new Map(), prevNext: new Map(), search: [] },
      field: 'tags',
    });
    const terms = tagIndex(taxonomy);
    assert.deepEqual(terms, []);
  });
});

describe('pageUrl', () => {
  it('derives URL from slug', () => {
    const page: ContentPage = {
      slug: 'blog/hello',
      section: 'blog',
      title: 'Hello',
      order: 1,
      html: '',
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(pageUrl(page), '/blog/hello');
  });

  it('uses urlFor override', () => {
    const page: ContentPage = {
      slug: 'hello',
      section: '',
      title: 'Hello',
      order: 1,
      html: '',
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(
      pageUrl(page, { urlFor: (p) => `https://example.com/posts/${p.slug}` }),
      'https://example.com/posts/hello',
    );
  });

  it('prepends slash for top-level slugs', () => {
    const page: ContentPage = {
      slug: 'about',
      section: '',
      title: 'About',
      order: 1,
      html: '',
      toc: [],
      draft: false,
      tags: [],
      data: {},
    };
    assert.equal(pageUrl(page), '/about');
  });
});
