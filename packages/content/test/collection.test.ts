/**
 * Typed collection tests: frontmatter schema validation (value-free
 * `ContentError`), static-path derivation, and the `getEntry`/`getEntries`
 * helpers. Runs entirely against temp directories.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { z } from 'zod';

import {
  ContentError,
  createMarkdownStaticPaths,
  defineContentCollection,
  type FieldError,
} from '../src/index.js';
import { tempRoot, writeFiles } from './fixtures.js';

/** Keep the incremental content cache inside the temp root so tests stay hermetic. */
function contentCacheDir(root: string): string {
  return join(root, '.cache');
}

const FIXTURES: Record<string, string> = {
  'a.md': `---
title: Alpha
order: 2
---
# Alpha Heading

First paragraph for excerpt.

## Sub section

Second paragraph.
`,
  'guide/intro.md': `---
title: Intro
---
# Guide Intro

Guide paragraph.
`,
  'guide/setup.md': `---
title: Setup Draft
draft: true
order: 1
---
# Setup

Draft content.
`,
  'api/ref.md': `---
title: Reference
order: 1
tags:
  - api
  - docs
date: 2026-10-07
---
# Reference

\`\`\`js
const x = 1;
\`\`\`

Ref paragraph.
`,
};
describe('defineContentCollection', () => {
  it('validates frontmatter against a schema and types data', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, {
      'post.md': `---
title: Post
views: 3
---
Body.
`,
    });

    const schema = z.object({ title: z.string(), views: z.number() });
    const collection = await defineContentCollection({
      dir: root,
      schema,
      cacheDir: contentCacheDir(root),
    });

    const entry = collection.getEntry('post');
    assert.ok(entry);
    assert.equal(entry.data.views, 3);
    assert.equal(entry.data.title, 'Post');
  });

  it('throws a value-free ContentError for malformed frontmatter', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, {
      'post.md': `---
title: Post
views: not-a-number
---
Body.
`,
    });

    const schema = z.object({ title: z.string(), views: z.number() });
    const promise = defineContentCollection({ dir: root, schema, cacheDir: contentCacheDir(root) });

    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof ContentError);
      assert.equal(error.code, 'invalid_frontmatter');
      assert.ok(error.errors.length > 0);
      const errors: readonly FieldError[] = error.errors;
      const first = errors[0];
      assert.ok(first);
      assert.equal(first.field, 'views');
      // Value-free: the input value never appears in the message.
      assert.ok(!first.message.includes('not-a-number'));
      assert.ok(!error.message.includes('not-a-number'));
      return true;
    });
  });

  it('derives getStaticPaths from the route param (default [slug])', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await defineContentCollection({
      dir: root,
      cacheDir: contentCacheDir(root),
    });
    const paths = createMarkdownStaticPaths(collection);

    assert.deepEqual(paths, [{ slug: 'api/ref' }, { slug: 'a' }, { slug: 'guide/intro' }]);
  });

  it('honours a custom route param name', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await defineContentCollection({
      dir: root,
      route: '[id]',
      cacheDir: contentCacheDir(root),
    });
    const paths = collection.getStaticPaths();

    assert.deepEqual(paths, [{ id: 'api/ref' }, { id: 'a' }, { id: 'guide/intro' }]);
  });

  it('filters entries via getEntries', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await defineContentCollection({
      dir: root,
      cacheDir: contentCacheDir(root),
    });

    assert.deepEqual(
      collection.getEntries({ section: 'guide' }).map((p) => p.slug),
      ['guide/setup', 'guide/intro'],
    );
    assert.deepEqual(
      collection.getEntries({ tag: 'api' }).map((p) => p.slug),
      ['api/ref'],
    );
    assert.deepEqual(
      collection.getEntries({ draft: true }).map((p) => p.slug),
      ['guide/setup'],
    );
    assert.equal(collection.getEntries({ section: 'missing' }).length, 0);
  });

  it('applies a custom order comparator', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await defineContentCollection({
      dir: root,
      // Reverse the default: title descending.
      order: (a, b) => (a.title < b.title ? 1 : a.title > b.title ? -1 : 0),
      cacheDir: contentCacheDir(root),
    });

    const first = collection.pages[0];
    assert.ok(first);
    // Highest title among fixtures is "Setup Draft".
    assert.equal(first.title, 'Setup Draft');
  });
});
