import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createContentRepository, type ContentRepository } from '@jsails/blog';
import { createOramaBlogSearch } from '../src/search-orama.js';

function repository(): ContentRepository {
  return createContentRepository({
    nextId: (() => {
      let id = 0;
      return () => `post-${++id}`;
    })(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
}

async function seed(repo: ContentRepository) {
  await repo.createPost({
    title: 'Orama search for blogs',
    slug: 'orama-search',
    excerpt: 'Embedded typo tolerant search',
    blocks: {
      version: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text: 'Orama runs inside the app.' }],
    },
    status: 'published',
    authorId: 'author',
  });
  await repo.createPost({
    title: 'Draft launch notes',
    slug: 'draft-notes',
    excerpt: 'Not public',
    blocks: { version: 1, blocks: [] },
    status: 'draft',
    authorId: 'author',
  });
}

describe('Orama blog search', () => {
  it('searches published titles, excerpts, and body text', async () => {
    const repo = repository();
    await seed(repo);
    const engine = createOramaBlogSearch({ repository: repo });

    const title = await engine.search('Orama');
    assert.equal(title.total, 1);
    assert.equal(title.posts[0]?.slug, 'orama-search');

    const body = await engine.search('inside the app');
    assert.equal(body.total, 1);
    assert.equal(body.posts[0]?.slug, 'orama-search');

    const draft = await engine.search('Draft');
    assert.equal(draft.total, 0);
  });

  it('returns a bounded page and a stable total', async () => {
    const repo = repository();
    await seed(repo);
    const engine = createOramaBlogSearch({ repository: repo });
    const result = await engine.search('', { page: 1, limit: 1 });
    assert.equal(result.total, 1);
    assert.equal(result.posts.length, 1);
  });

  it('shares one index for the same repository and updates on index/remove', async () => {
    const repo = repository();
    await seed(repo);
    const first = createOramaBlogSearch({ repository: repo });
    const second = createOramaBlogSearch({ repository: repo });
    assert.equal(first, second);

    const posts = await repo.listPosts();
    const draft = posts.find((post) => post.status === 'draft');
    assert.ok(draft);
    await first.index({ ...draft, status: 'published' });
    assert.equal((await second.search('Draft')).total, 1);

    await second.remove(draft.id);
    assert.equal((await first.search('Draft')).total, 0);
  });

  it('rebuilds from a supplied post list', async () => {
    const repo = repository();
    await seed(repo);
    const engine = createOramaBlogSearch({ repository: repo });
    await engine.reindex([]);
    assert.equal((await engine.search('Orama')).total, 0);

    const posts = await repo.listPosts();
    await engine.reindex(posts);
    assert.equal((await engine.search('Orama')).total, 1);
  });

  it('resolves a page of hits with one batch lookup, preserving relevance order', async () => {
    // A per-hit `getPost` loop issued one query per result. The engine now
    // resolves the whole page through `getPosts`, so the call count must not
    // scale with the number of hits.
    const base = repository();
    for (let i = 0; i < 5; i += 1) {
      await base.createPost({
        title: `Batched search result ${i}`,
        slug: `batched-${i}`,
        excerpt: 'Batched lookup',
        blocks: { version: 1, blocks: [] },
        status: 'published',
        authorId: 'author',
      });
    }

    const calls = { getPost: 0, getPosts: 0 };
    const counting: ContentRepository = {
      ...base,
      getPost: async (id) => {
        calls.getPost += 1;
        return base.getPost(id);
      },
      getPosts: async (ids) => {
        calls.getPosts += 1;
        return base.getPosts(ids);
      },
    };

    const engine = createOramaBlogSearch({ repository: counting });
    const result = await engine.search('Batched');

    assert.equal(result.posts.length, 5);
    assert.equal(calls.getPost, 0, 'no per-hit lookups');
    assert.equal(calls.getPosts, 1, 'one batch lookup per page');

    // The batch returns rows unordered; the engine must restore hit order.
    const slugs = result.posts.map((post) => post.slug);
    assert.deepEqual(slugs, [...slugs].sort());
  });
});
