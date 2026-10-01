import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEmptyRichTextDocument } from 'jsails/rich-text';
import {
  createPost,
  createTerm,
  mergePost,
  mergeTerm,
  transitionStatus,
} from '../../src/cms/entity-builders.js';
import { BlogContentError } from '../../src/cms/repository.js';

/**
 * The entity builders are shared by the memory and database repositories, so
 * the merge rules both stores rely on are pinned here once.
 */

const STAMP = { id: 'id-1', timestamp: '2026-01-01T00:00:00.000Z' };

describe('entity builders: terms', () => {
  it('keeps the stored description when the update omits it', () => {
    const term = createTerm(
      { name: 'News', slug: 'news', description: 'Updates' },
      'c1',
      'category',
    );
    const merged = mergeTerm(term, { name: 'Headlines', slug: 'headlines' }, 'category');
    assert.deepEqual(merged, {
      id: 'c1',
      name: 'Headlines',
      slug: 'headlines',
      description: 'Updates',
    });
  });

  it('replaces the description when the update carries one', () => {
    const term = createTerm({ name: 'News', slug: 'news', description: 'Updates' }, 'c1', 'tag');
    const merged = mergeTerm(term, { name: 'News', slug: 'news', description: '' }, 'tag');
    assert.equal(merged.description, '');
  });

  it('rejects an invalid term value-free', () => {
    assert.throws(
      () => createTerm({ name: '', slug: 'SECRET_SLUG' }, 'c1', 'category'),
      (error: unknown) =>
        error instanceof BlogContentError &&
        error.code === 'invalid_input' &&
        !error.message.includes('SECRET_SLUG'),
    );
  });
});

describe('entity builders: posts', () => {
  it('stamps publishedAt only for a post created published', () => {
    const base = { title: 'Hi', slug: 'hi', blocks: createEmptyRichTextDocument(), authorId: 'a1' };
    assert.equal(createPost({ ...base, status: 'draft' }, STAMP).publishedAt, null);
    assert.equal(createPost({ ...base, status: 'published' }, STAMP).publishedAt, STAMP.timestamp);
  });

  it('merges only the supplied fields and leaves lifecycle fields alone', () => {
    const post = createPost(
      {
        title: 'Hi',
        slug: 'hi',
        blocks: createEmptyRichTextDocument(),
        status: 'published',
        authorId: 'a1',
        native: { text: 'hi' },
      },
      STAMP,
    );
    const merged = mergePost(post, { title: 'Hello', native: null }, '2026-02-01T00:00:00.000Z');
    assert.equal(merged.title, 'Hello');
    assert.equal(merged.slug, 'hi');
    assert.equal(merged.native, null);
    assert.equal(merged.status, 'published');
    assert.equal(merged.publishedAt, STAMP.timestamp);
    assert.equal(merged.createdAt, STAMP.timestamp);
    assert.equal(merged.updatedAt, '2026-02-01T00:00:00.000Z');
  });
});

describe('entity builders: transitions', () => {
  it('returns the target status or undefined when already there', () => {
    assert.equal(transitionStatus('draft', 'publish'), 'published');
    assert.equal(transitionStatus('published', 'publish'), undefined);
    assert.equal(transitionStatus('published', 'unpublish'), 'draft');
    assert.equal(transitionStatus('draft', 'unpublish'), undefined);
  });

  it('refuses to move an archived entry', () => {
    assert.throws(
      () => transitionStatus('archived', 'publish'),
      (error: unknown) => error instanceof BlogContentError && error.code === 'invalid_status',
    );
  });
});
