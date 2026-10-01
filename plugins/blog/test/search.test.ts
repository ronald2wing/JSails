/**
 * Search contract and database-driver search for the blog.
 *
 * The database engine reads the repository's published posts on every search,
 * so there is no separate index to keep in sync: `index`/`remove`/`reindex` are
 * documented no-ops that exist for contract symmetry with future external
 * engines. Matching is case-insensitive over title, excerpt, and the plain-text
 * body, ordered newest-first. Route and admin-indexing behavior are covered via
 * the real plugin/admin surfaces.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Hono } from 'hono';

import { runExtensions, type HttpExtensionHook } from 'jsails/extensions';
import type { Session } from 'jsails';
import type { AdminPlugin, Resource } from '@jsails/admin';
import {
  BLOG_SEARCH_PAGE_SIZE,
  blogAdmin,
  blogPlugin,
  blogSearchToken,
  createBlogSearch,
  createContentRepository,
  createDatabaseBlogSearch,
  postSearchText,
  type BlogSearchEngine,
  type ContentRepository,
  type Post,
  type PostCreateInput,
} from '@jsails/blog';

/** A valid post-create input, published unless overridden. */
function seedInput(input: Partial<PostCreateInput>): PostCreateInput {
  return {
    title: 'Seed',
    slug: 'seed',
    blocks: { version: 1, blocks: [] },
    status: 'published',
    authorId: 'test-author',
    ...input,
  };
}

async function seedPost(
  repository: ContentRepository,
  input: Partial<PostCreateInput>,
): Promise<Post> {
  return repository.createPost(seedInput(input));
}

describe('postSearchText', () => {
  it('projects text-bearing blocks and skips code/media/divider', async () => {
    const repository = createContentRepository();
    const post = await seedPost(repository, {
      title: 'T',
      slug: 't',
      blocks: {
        version: 1,
        blocks: [
          { id: 'b1', type: 'paragraph', text: 'First paragraph' },
          { id: 'b2', type: 'heading', level: 2, text: 'A heading' },
          { id: 'b3', type: 'list', style: 'unordered', items: ['one', 'two'] },
          { id: 'b4', type: 'quote', text: 'Quoted', citation: 'Someone' },
          { id: 'b5', type: 'code', code: 'console.log("not indexed")', language: 'js' },
          { id: 'b6', type: 'callout', tone: 'info', text: 'Callout text' },
          { id: 'b7', type: 'cta', label: 'Read more', href: '/x' },
          { id: 'b8', type: 'divider' },
        ],
      },
    });

    const text = postSearchText(post);
    assert.match(text, /First paragraph/);
    assert.match(text, /A heading/);
    assert.match(text, /one/);
    assert.match(text, /two/);
    assert.match(text, /Quoted \(Someone\)/);
    assert.match(text, /Callout text/);
    assert.match(text, /Read more/);
    assert.doesNotMatch(text, /not indexed/);
  });

  it('returns an empty string for an empty document', () => {
    const post: Post = {
      id: 'p1',
      title: 'T',
      slug: 't',
      excerpt: '',
      blocks: { version: 1, blocks: [] },
      status: 'published',
      authorId: 'a',
      featuredMediaId: null,
      categoryIds: [],
      tagIds: [],
      publishedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(postSearchText(post), '');
  });
});

describe('createDatabaseBlogSearch', () => {
  it('matches title, excerpt, and body case-insensitively', async () => {
    const repository = createContentRepository();
    const engine = createDatabaseBlogSearch({ repository });

    await seedPost(repository, {
      title: 'Launching the new website',
      slug: 'launch',
      excerpt: 'Announcing our redesign',
      blocks: { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text: 'Ship it.' }] },
    });
    await seedPost(repository, {
      title: 'Unrelated post',
      slug: 'unrelated',
      excerpt: 'Nothing to see',
      blocks: { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text: 'Fluff.' }] },
    });

    const byTitle = await engine.search('WEBSITE');
    assert.equal(byTitle.total, 1);
    assert.equal(byTitle.posts[0]?.slug, 'launch');

    const byExcerpt = await engine.search('redesign');
    assert.equal(byExcerpt.total, 1);
    assert.equal(byExcerpt.posts[0]?.slug, 'launch');

    const byBody = await engine.search('ship');
    assert.equal(byBody.total, 1);
    assert.equal(byBody.posts[0]?.slug, 'launch');

    const none = await engine.search('zzzz');
    assert.equal(none.total, 0);
    assert.equal(none.posts.length, 0);
  });

  it('returns only published posts', async () => {
    const repository = createContentRepository();
    const engine = createDatabaseBlogSearch({ repository });

    await seedPost(repository, { title: 'Draft thing', slug: 'draft-thing', status: 'draft' });
    await seedPost(repository, { title: 'Live thing', slug: 'live-thing', status: 'published' });

    const result = await engine.search('thing');
    assert.equal(result.total, 1);
    assert.equal(result.posts[0]?.slug, 'live-thing');
  });

  it('orders results by publishedAt descending deterministically', async () => {
    // Inject a stepping clock so the two posts get distinct, known timestamps.
    let tick = 0;
    const repository = createContentRepository({
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    });
    const engine = createDatabaseBlogSearch({ repository });

    const older = await seedPost(repository, { title: 'Older', slug: 'older' });
    const newer = await seedPost(repository, { title: 'Newer', slug: 'newer' });

    const result = await engine.search('');
    assert.deepEqual(
      result.posts.map((post) => post.id),
      [newer.id, older.id],
    );
  });

  it('applies limit and page bounds, clamping malformed values', async () => {
    const repository = createContentRepository();
    const engine = createDatabaseBlogSearch({ repository });

    for (let i = 0; i < 5; i += 1) {
      await seedPost(repository, { title: `Post ${i}`, slug: `post-${i}` });
    }

    const page1 = await engine.search('', { page: 1, limit: 2 });
    assert.equal(page1.total, 5);
    assert.equal(page1.posts.length, 2);

    const page3 = await engine.search('', { page: 3, limit: 2 });
    assert.equal(page3.posts.length, 1);
    assert.equal(page3.total, 5);

    // Malformed page/limit fall back to defaults (page 1, default size).
    const malformed = await engine.search('', { page: NaN, limit: -5 });
    assert.equal(malformed.posts.length, BLOG_SEARCH_PAGE_SIZE > 5 ? 5 : BLOG_SEARCH_PAGE_SIZE);
  });

  it('treats index/remove/reindex as value-safe no-ops', async () => {
    const repository = createContentRepository();
    const engine = createDatabaseBlogSearch({ repository });
    const post = await seedPost(repository, { title: 'Indexed', slug: 'indexed' });

    await assert.doesNotReject(() => engine.index(post));
    await assert.doesNotReject(() => engine.remove(post.id));
    await assert.doesNotReject(() => engine.reindex([post]));

    // The repository stays the source of truth: the post is still searchable.
    const result = await engine.search('Indexed');
    assert.equal(result.total, 1);
  });

  it('matches every published post for an empty query', async () => {
    const repository = createContentRepository();
    const engine = createDatabaseBlogSearch({ repository });
    await seedPost(repository, { title: 'A', slug: 'a' });
    await seedPost(repository, { title: 'B', slug: 'b' });
    await seedPost(repository, { title: 'Draft', slug: 'draft', status: 'draft' });

    const result = await engine.search('');
    assert.equal(result.total, 2);
  });
});

describe('createBlogSearch factory', () => {
  it('builds an engine over the same repository it returns', async () => {
    const { repository, engine } = createBlogSearch();
    await seedPost(repository, { title: 'Factory', slug: 'factory' });

    const result = await engine.search('factory');
    assert.equal(result.total, 1);
    assert.equal(result.posts[0]?.slug, 'factory');
  });
});

// App helpers mirroring the existing blog test harness.
type TestAppEnv = Parameters<HttpExtensionHook>[0] extends Hono<infer E> ? E : never;

async function makeSearchApp(repository: ContentRepository, search?: BlogSearchEngine) {
  const plugin = blogPlugin(search === undefined ? { repository } : { repository, search });
  const runtime = await runExtensions([plugin]);
  const app = new Hono<TestAppEnv>();
  for (const hook of runtime.httpHooks) {
    await hook(app);
  }
  return { app, runtime, repository, engine: runtime.services.get(blogSearchToken) };
}

describe('blog search route', () => {
  it('returns a themed or plain results page for a query', async () => {
    const repository = createContentRepository();
    await seedPost(repository, { title: 'Cat food review', slug: 'cat-food', excerpt: 'Crunchy' });
    await seedPost(repository, { title: 'Dog walk', slug: 'dog-walk' });

    const { app, runtime } = await makeSearchApp(repository);
    const response = await app.request('/blog/search?q=cat');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Cat food review/);
    assert.doesNotMatch(html, /dog-walk/);
    await runtime.close();
  });

  it('escapes the query and result titles', async () => {
    const repository = createContentRepository();
    await seedPost(repository, { title: '<script>alert(1)</script>', slug: 'xss' });

    const { app, runtime } = await makeSearchApp(repository);
    const response = await app.request('/blog/search?q=<script>');
    assert.equal(response.status, 200);
    const html = await response.text();
    // The query is echoed back HTML-escaped in the form value and heading.
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    // The matching post title is escaped, never emitted as raw markup.
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    await runtime.close();
  });

  it('renders the search form and an empty-state message when nothing matches', async () => {
    const repository = createContentRepository();

    const { app, runtime } = await makeSearchApp(repository);
    const response = await app.request('/blog/search?q=ghost');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /No posts match your search/);
    assert.match(html, /name="q"/);
    await runtime.close();
  });

  it('provides the engine under the blogSearchToken on the runtime', async () => {
    const repository = createContentRepository();
    const { runtime, engine } = await makeSearchApp(repository);
    assert.ok(engine);
    assert.equal(engine, runtime.services.tryGet(blogSearchToken));
    await runtime.close();
  });
});

// Admin indexing coverage: the admin defaults to a database engine over its
// repository, and after a successful save the engine's `index` is observable
// via an injected spy engine.
const session: Session = { id: 's', csrfToken: 't', data: {}, expiresAt: 0 };

/** Capture the admin plugin's `posts` resource save callback, mirroring the blog test harness. */
function postsResource(plugin: AdminPlugin): {
  save: NonNullable<Resource['save']>;
} {
  let found: Resource | undefined;
  plugin.register({
    addPage() {},
    addNavigationItem() {},
    addResource(resource) {
      if (resource.slug === 'posts') {
        found = resource;
      }
    },
  });
  assert.ok(found, 'blog admin must contribute the posts resource');
  assert.ok(found.save, 'resource must define save');
  return { save: found.save };
}

describe('blog admin search indexing', () => {
  it('calls search.index after a successful published post create', async () => {
    const repository = createContentRepository();
    const indexed: string[] = [];
    const spy: BlogSearchEngine = {
      search: async () => ({ posts: [], total: 0 }),
      index: async (post) => {
        indexed.push(post.slug);
      },
      remove: async () => {},
      reindex: async () => {},
    };

    const resource = postsResource(blogAdmin({ repository, search: spy }));
    await resource.save({
      session,
      id: null,
      values: { title: 'Published post', slug: 'published-post', status: 'published' },
    });

    assert.deepEqual(indexed, ['published-post']);
  });

  it('calls search.remove for a draft post and does not fail the save on index error', async () => {
    const repository = createContentRepository();
    const removed: string[] = [];
    const spy: BlogSearchEngine = {
      search: async () => ({ posts: [], total: 0 }),
      index: async () => {
        throw new Error('index down');
      },
      remove: async (id) => {
        removed.push(id);
      },
      reindex: async () => {},
    };

    const resource = postsResource(blogAdmin({ repository, search: spy }));

    // A published create whose index throws must still persist the write.
    await resource.save({
      session,
      id: null,
      values: { title: 'Survives', slug: 'survives', status: 'published' },
    });
    const id = await firstId(repository);
    assert.ok(id);
    const published = await repository.getPost(id);
    assert.ok(published);
    assert.equal(published.title, 'Survives');

    // A draft create removes rather than indexes.
    await resource.save({
      session,
      id: null,
      values: { title: 'Drafty', slug: 'drafty', status: 'draft' },
    });
    assert.equal(removed.length, 1);
  });

  it('re-indexes (index or remove) after a status transition on update', async () => {
    const repository = createContentRepository();
    const events: string[] = [];
    const spy: BlogSearchEngine = {
      search: async () => ({ posts: [], total: 0 }),
      index: async (post) => {
        events.push(`index:${post.status}`);
      },
      remove: async (id) => {
        events.push(`remove:${id}`);
      },
      reindex: async () => {},
    };

    const resource = postsResource(blogAdmin({ repository, search: spy }));
    await resource.save({
      session,
      id: null,
      values: { title: 'Draft then publish', slug: 'draft-then-publish', status: 'draft' },
    });
    const id = await firstId(repository);
    assert.ok(id);

    // Publish via an update: the final post must be indexed as published.
    await resource.save({
      session,
      id,
      values: { title: 'Draft then publish', slug: 'draft-then-publish', status: 'published' },
    });

    assert.ok(events.some((entry) => entry === 'index:published'));
  });
});

/** Resolve the single repository post id (helper for the admin-indexing tests). */
async function firstId(repository: ContentRepository): Promise<string | undefined> {
  const posts = await repository.listPosts();
  return posts[0]?.id;
}
