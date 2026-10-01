/**
 * Audit regressions for the blog (CNT-01): each test states the correct
 * behaviour for one audited defect. Those that fail today are listed, with the
 * failure they show, in `scripts/expected-failures/content.json`.
 *
 * Row counts are observed with a TypeORM subscriber's `afterLoad`, which fires
 * once per hydrated entity, so a test can tell a query that reads one page
 * from one that reads the whole table without parsing SQL.
 */

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { Hono } from 'hono';
import { runExtensions } from 'jsails/extensions';
import type { JsailsDataSource } from 'jsails/database';
import { auditCase, createEmptyDataSource, tempDir } from 'jsails/testing';

import type { BlogPost, BlogPostUpdateInput, BlogRepository } from '../src/cms/index.js';
import { createMemoryBlogRepository } from '../src/cms/memory-repository.js';
import {
  BLOG_POST_TABLE,
  blogEntities,
  createDatabaseBlogRepository,
} from '../src/persistence/index.js';
import { blogPlugin } from '../src/plugin.js';
import type { BlogSearchEngine, BlogSearchOptions } from '../src/search/contract.js';
import { createDatabaseBlogSearch } from '../src/search/database.js';
import { createOramaBlogSearch } from '../src/search/orama.js';
import { seedInput, type TestAppEnv } from './fixtures.js';

async function blogDataSource(t: TestContext): Promise<JsailsDataSource> {
  const dataSource = await createEmptyDataSource(blogEntities, {
    location: `${tempDir(t, 'jsails-audit-blog-')}/blog.sqlite`,
  });
  t.after(() => dataSource.destroy());
  return dataSource;
}

function databaseRepository(dataSource: JsailsDataSource, prefix = 'id'): BlogRepository {
  let sequence = 0;
  return createDatabaseBlogRepository({
    dataSource,
    nextId: () => `${prefix}-${(sequence += 1)}`,
  });
}

/** Count every blog post row the data source hydrates from now on. */
function countPostLoads(dataSource: JsailsDataSource): { readonly loads: number } {
  const postEntity = blogEntities.find(
    (entity) => dataSource.getMetadata(entity).tableName === BLOG_POST_TABLE,
  );
  assert.ok(postEntity !== undefined, 'the blog post entity is registered');
  const counter = { loads: 0 };
  dataSource.subscribers.push({
    listenTo: () => postEntity,
    afterLoad: () => {
      counter.loads += 1;
    },
  });
  return counter;
}

/** A search engine that records what it is asked and indexes nothing. */
function recordingSearch(): BlogSearchEngine & {
  readonly indexed: string[];
  readonly removed: string[];
  readonly windows: BlogSearchOptions[];
} {
  const indexed: string[] = [];
  const removed: string[] = [];
  const windows: BlogSearchOptions[] = [];
  return {
    indexed,
    removed,
    windows,
    search: async (_query, options) => {
      windows.push(options ?? {});
      return { posts: [], total: 0 };
    },
    index: async (post) => {
      indexed.push(post.id);
    },
    remove: async (id) => {
      removed.push(id);
    },
    reindex: async () => undefined,
  };
}

async function mount(options: Parameters<typeof blogPlugin>[0]) {
  const runtime = await runExtensions([blogPlugin(options)]);
  const app = new Hono<TestAppEnv>();
  for (const hook of runtime.httpHooks) {
    await hook(app);
  }
  return app;
}

test(
  ...auditCase(
    'blog/default-memory-repository',
    'the blog plugin refuses to start without a persistent repository',
  ),
  async () => {
    await assert.rejects(
      (async () => runExtensions([blogPlugin()]))(),
      'a bare blogPlugin() keeps every post in process memory and loses them on restart',
    );
  },
);

test(
  ...auditCase(
    'blog/write-path-search-sync',
    'publishing, unpublishing and deleting a post keep the search engine in step',
  ),
  async () => {
    const repository = createMemoryBlogRepository();
    const search = recordingSearch();
    await mount({ repository, search });
    const draft = await repository.createPost(seedInput({ status: 'draft', slug: 'sync' }));
    await repository.publishPost(draft.id);
    assert.ok(search.indexed.includes(draft.id), 'a published post never reached the index');
    await repository.unpublishPost(draft.id);
    await repository.deletePost(draft.id);
    assert.ok(search.removed.includes(draft.id), 'a deleted post stays searchable');
  },
);

test(
  ...auditCase('blog/optimistic-locking', 'a save based on a stale read of a post is refused'),
  async (t) => {
    const repository = databaseRepository(await blogDataSource(t));
    const post = await repository.createPost(seedInput({ slug: 'locked' }));
    const stale = (post as BlogPost & { readonly lockVersion?: unknown }).lockVersion;
    assert.equal(typeof stale, 'number', 'posts carry no lockVersion, so edits cannot be fenced');
    await repository.updatePost(post.id, { title: 'Editor A' });
    await assert.rejects(
      repository.updatePost(post.id, {
        title: 'Editor B',
        lockVersion: stale,
      } as BlogPostUpdateInput),
      "editor B's stale save overwrote editor A's",
    );
  },
);

test(
  ...auditCase(
    'blog/term-delete-dangling',
    'deleting a category removes it from the posts that carried it',
  ),
  async (t) => {
    const repository = databaseRepository(await blogDataSource(t));
    const category = await repository.createCategory({ name: 'News', slug: 'news' });
    const post = await repository.createPost(
      seedInput({ slug: 'filed', categoryIds: [category.id] }),
    );
    await repository.deleteCategory(category.id);
    const reloaded = await repository.getPost(post.id);
    assert.deepEqual(reloaded?.categoryIds, [], 'the post still names the deleted category');
  },
);

test(
  ...auditCase(
    'blog/term-archive-reads-all-posts',
    'a category archive page reads that page of posts, not every published post',
  ),
  async (t) => {
    const dataSource = await blogDataSource(t);
    const repository = databaseRepository(dataSource);
    const category = await repository.createCategory({ name: 'Rare', slug: 'rare' });
    for (let index = 0; index < 40; index += 1) {
      await repository.createPost(seedInput({ slug: `post-${index}` }));
    }
    await repository.createPost(seedInput({ slug: 'filed', categoryIds: [category.id] }));
    const counter = countPostLoads(dataSource);
    const page = await repository.listPublishedPosts({
      categoryId: category.id,
      limit: 10,
      offset: 0,
    });
    assert.equal(page.posts.length, 1);
    assert.ok(counter.loads <= 10, `one archive page hydrated ${counter.loads} post rows`);
  },
);

test(
  ...auditCase(
    'blog/database-search-scans',
    'a database search reads the matching page, not every post with its body',
  ),
  async (t) => {
    const dataSource = await blogDataSource(t);
    const repository = databaseRepository(dataSource);
    for (let index = 0; index < 40; index += 1) {
      await repository.createPost(seedInput({ slug: `post-${index}`, title: `Post ${index}` }));
    }
    await repository.createPost(seedInput({ slug: 'needle', title: 'The needle' }));
    const counter = countPostLoads(dataSource);
    const result = await createDatabaseBlogSearch({ repository }).search('needle');
    assert.equal(result.total, 1);
    assert.ok(counter.loads <= 10, `one search hydrated ${counter.loads} post rows`);
  },
);

test(
  ...auditCase(
    'blog/orama-per-process',
    'a post published through one instance is searchable on another',
  ),
  async (t) => {
    const dataSource = await blogDataSource(t);
    const instanceA = databaseRepository(dataSource, 'a');
    const instanceB = databaseRepository(dataSource, 'b');
    const searchA = createOramaBlogSearch({ repository: instanceA });
    const searchB = createOramaBlogSearch({ repository: instanceB });
    await searchB.search('');
    const post = await instanceA.createPost(seedInput({ slug: 'fresh', title: 'Fresh news' }));
    await searchA.index(post);
    const found = await searchB.search('Fresh');
    assert.equal(found.total, 1, 'instance B still searches its startup snapshot');
  },
);

test(
  ...auditCase(
    'blog/search-page-unbounded',
    'the search route bounds the page it asks the engine for',
  ),
  async () => {
    const search = recordingSearch();
    const app = await mount({ repository: createMemoryBlogRepository(), search });
    const response = await app.request('http://localhost/blog/search?q=x&page=1000000');
    assert.equal(response.status, 200);
    const window = search.windows[0] ?? {};
    const reach = (window.page ?? 1) * (window.limit ?? 10);
    assert.ok(reach <= 10_000, `the engine was asked for results up to #${reach}`);
  },
);

test(
  ...auditCase(
    'blog/sitemap-requeries',
    'the sitemap is read once per content version: fresh after a write, cached otherwise',
  ),
  async () => {
    const base = createMemoryBlogRepository();
    let reads = 0;
    const repository: BlogRepository = {
      ...base,
      listPublishedPosts: async (query) => {
        reads += 1;
        return base.listPublishedPosts(query);
      },
    };
    const app = await mount({ repository, search: recordingSearch() });
    await base.createPost(seedInput({ slug: 'first' }));
    await app.request('http://localhost/blog/sitemap.xml');
    await app.request('http://localhost/blog/sitemap.xml');
    assert.equal(
      reads,
      1,
      `two sitemap requests with no write in between read posts ${reads} times`,
    );
    await repository.createPost(seedInput({ slug: 'second' }));
    const fresh = await (await app.request('http://localhost/blog/sitemap.xml')).text();
    assert.match(fresh, /second/, 'a post published after the first request is missing');
  },
);
