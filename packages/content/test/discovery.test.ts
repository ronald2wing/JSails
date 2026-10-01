/**
 * Content discovery tests: recursive discovery and slug/section derivation,
 * deterministic ordering, draft exclusion from navigation/search (while
 * remaining discoverable), tags/date normalization, TOC/excerpt/search-corpus
 * extraction, symlink rejection, and cache-dir isolation. Runs entirely
 * against temp directories.
 */

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ContentError, discoverContent } from '../src/index.js';
import { tempRoot, writeFiles } from './fixtures.js';

/** Keep the incremental content cache inside the temp root so tests stay hermetic. */
function contentCacheDir(root: string): string {
  return join(root, '.cache');
}

/** Assert a rejection is a `ContentError` with the given code. */
function isContentError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof ContentError, `expected ContentError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
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
describe('discoverContent', () => {
  it('recursively discovers .md files and derives slug/section', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await discoverContent(root, { cacheDir: contentCacheDir(root) });

    const slugs = collection.pages.map((p) => p.slug).sort();
    assert.deepEqual(slugs, ['a', 'api/ref', 'guide/intro', 'guide/setup']);

    const a = collection.bySlug.get('a');
    assert.ok(a);
    assert.equal(a.section, '', 'top-level file has an empty section');

    const intro = collection.bySlug.get('guide/intro');
    assert.ok(intro);
    assert.equal(intro.section, 'guide');
  });

  it('sorts by order → title → slug deterministically', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await discoverContent(root, { cacheDir: contentCacheDir(root) });
    const slugs = collection.pages.map((p) => p.slug);

    assert.deepEqual(slugs, ['api/ref', 'guide/setup', 'a', 'guide/intro']);
  });

  it('excludes drafts from prevNext and search but keeps them discoverable', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await discoverContent(root, { cacheDir: contentCacheDir(root) });

    assert.ok(collection.bySlug.has('guide/setup'), 'draft stays discoverable by slug');

    assert.equal(collection.prevNext.has('guide/setup'), false, 'draft has no nav neighbours');
    assert.deepEqual(collection.prevNext.get('api/ref'), { prev: null, next: 'a' });
    assert.deepEqual(collection.prevNext.get('a'), { prev: 'api/ref', next: 'guide/intro' });
    assert.deepEqual(collection.prevNext.get('guide/intro'), { prev: 'a', next: null });

    const searchSlugs = collection.search.map((r) => r.slug);
    assert.deepEqual(searchSlugs, ['api/ref', 'a', 'guide/intro']);
  });

  it('extracts title, tags, date, toc, and excerpt', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, FIXTURES);

    const collection = await discoverContent(root, { cacheDir: contentCacheDir(root) });

    const ref = collection.bySlug.get('api/ref');
    assert.ok(ref);
    assert.deepEqual(ref.tags, ['api', 'docs']);
    assert.equal(ref.date, '2026-10-07');
    assert.equal(ref.order, 1);

    const a = collection.bySlug.get('a');
    assert.ok(a);
    assert.equal(a.excerpt, 'First paragraph for excerpt.');
    assert.equal(a.order, 2);

    // TOC: after the leading H1 strip, only the ## Sub section heading remains.
    assert.deepEqual(
      a.toc.map((h) => ({ depth: h.depth, text: h.text })),
      [{ depth: 2, text: 'Sub section' }],
    );
    assert.equal(a.toc[0]?.id, 'sub-section');
  });

  it('returns an empty collection for a missing directory', async (t) => {
    const root = tempRoot(t);
    const missing = join(root, 'does-not-exist');

    const collection = await discoverContent(missing, { cacheDir: contentCacheDir(root) });
    assert.deepEqual(collection.pages, []);
    assert.deepEqual(collection.search, []);
  });

  it('rejects a file missing the required title', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, { 'no-title.md': '---\norder: 1\n---\nbody\n' });

    await assert.rejects(
      discoverContent(root, { cacheDir: contentCacheDir(root) }),
      isContentError('missing_required_field'),
    );
  });
});

// ---- Symlinked root ---- //

describe('symlink safety', () => {
  it('throws symlink_rejected when the content root is a symlink', async (t) => {
    const root = tempRoot(t);
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'index.md'), '---\ntitle: Works\n---\n# Works\n', 'utf-8');

    const link = join(root, 'link');
    symlinkSync(real, link);

    await assert.rejects(
      discoverContent(link, { cacheDir: contentCacheDir(root) }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, 'symlink_rejected');
        return true;
      },
    );
  });
});

// ---- Cache-dir isolation ---- //

describe('cache-dir isolation', () => {
  it('returns distinct collections when cacheDir differs', async (t) => {
    const root = tempRoot(t);
    writeFiles(root, { 'a.md': '---\ntitle: Alpha\n---\n# Alpha\n' });

    const a = await discoverContent(root, { cacheDir: contentCacheDir(root) });
    const b = await discoverContent(root, { cacheDir: join(root, 'cache-v2') });

    assert.notStrictEqual(a, b, 'different cacheDir must produce distinct memo keys');
  });
});
