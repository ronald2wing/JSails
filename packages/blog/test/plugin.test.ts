import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { definePlugin } from 'jsails/extensions';
import { createTestApp } from 'jsails/testing';
import { blogAdmin } from '../src/admin/index.js';
import type { BlogPost, BlogPostCreateInput } from '../src/cms/index.js';
import { blogEntities } from '../src/persistence/index.js';
import {
  BlogValidationError,
  blogPlugin,
  blogRepositoryToken,
  createPostOperation,
  postCreatedEvent,
  type BlogCreateRouteOptions,
  type BlogPostCreatedEvent,
} from '../src/plugin.js';
import {
  captureResource,
  makeApp,
  makeRuntime,
  OPEN_CREATE_ROUTE,
  postBody,
  seedInput,
  session,
} from './fixtures.js';

/**
 * Tests for the first-party blog plugin: its static schema, the HTTP routes,
 * and the operation/event contract. The plugin runs in an in-process app, so
 * its routes take the real request pipeline (the access chain included), and
 * requests are driven in-process (no listener, no database, no service).
 */

describe('blog plugin schema', () => {
  it('declares the CMS entities statically for db:push', () => {
    const plugin = blogPlugin();
    assert.ok(plugin.schema, 'blog plugin must declare a static schema');
    assert.deepEqual(plugin.schema.entities, blogEntities);
  });
});

describe('blog plugin HTTP routes', () => {
  it('renders an empty-state message when no published posts exist', async () => {
    const { app, runtime } = await makeApp();

    const response = await app.request('/blog');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /No posts yet/);
    assert.doesNotMatch(html, /<ul>/);

    await runtime.close();
  });

  it('creates a draft post through the interceptor path and 303-redirects', async () => {
    const { app, runtime, repository } = await makeApp(OPEN_CREATE_ROUTE);

    const response = await app.request(
      '/blog/posts',
      postBody({ title: '  Hello  ', slug: '', body: 'hello\tthe\r\nworld' }),
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/blog');

    const posts = await repository.listPosts();
    assert.equal(posts.length, 1);
    const post = posts[0];
    assert.ok(post);
    assert.equal(post.title, 'Hello'); // before interceptor trimmed the title
    assert.equal(post.slug, 'hello'); // slug derived from the title
    assert.equal(post.status, 'draft');
    assert.deepEqual(post.blocks, {
      version: 2,
      blocks: [{ type: 'paragraph', content: [{ text: 'hello the\nworld' }] }],
    });

    await runtime.close();
  });

  it('lists published posts only, with an escaped title', async () => {
    const { app, runtime, repository } = await makeApp(OPEN_CREATE_ROUTE);

    await app.request('/blog/posts', postBody({ title: '<b>Draft</b>', body: 'x' }));
    await repository.createPost(seedInput({ title: '<b>Hi</b>', slug: 'hi' }));

    const response = await app.request('/blog');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /&lt;b&gt;Hi&lt;\/b&gt;/);
    assert.match(html, /href="\/blog\/hi"/);
    assert.doesNotMatch(html, /<b>Hi<\/b>/);
    // The draft post created over HTTP is hidden from the public list.
    assert.doesNotMatch(html, /Draft/);

    await runtime.close();
  });

  it('fires another plugin observer on postCreatedEvent through the shared registry', async () => {
    // The operation runs through the shared registry, so an observer another
    // plugin registers sees every post created over HTTP.
    const seen: BlogPostCreatedEvent[] = [];
    const observerPlugin = definePlugin({
      name: 'post-observer',
      setup({ observe }) {
        observe(postCreatedEvent, (payload) => {
          seen.push(payload);
        });
      },
    });

    const app = await createTestApp({
      config: { port: 0, extensions: [blogPlugin(OPEN_CREATE_ROUTE), observerPlugin] },
    });

    const response = await app.request('/blog/posts', postBody({ title: 'Shared', body: 'x' }));
    assert.equal(response.status, 303);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.post.title, 'Shared');

    await app.close();
  });

  it('rejects an empty title with a value-free 422 and no post', async () => {
    const { app, runtime, repository } = await makeApp(OPEN_CREATE_ROUTE);

    const response = await app.request(
      '/blog/posts',
      postBody({ title: '   ', body: 'SECRET_BODY' }),
    );
    assert.equal(response.status, 422);
    const html = await response.text();
    assert.match(html, /Title is required/);
    assert.doesNotMatch(html, /SECRET_BODY/);
    assert.equal((await repository.listPosts()).length, 0);

    await runtime.close();
  });
});

describe('blog plugin create route (opt-in)', () => {
  it('registers no POST /blog/posts unless the app opts in', async () => {
    const { app, runtime, repository } = await makeApp();

    const response = await app.request('/blog/posts', postBody({ title: 'Spam', body: 'x' }));

    assert.equal(response.status, 404);
    assert.equal((await repository.listPosts()).length, 0);
    await runtime.close();
  });

  it("answers core's 401 and writes nothing when the app's access denies", async () => {
    const seen: string[] = [];
    const { app, runtime, repository } = await makeApp({
      createRoute: {
        access: (context) => {
          seen.push(context.url.pathname);
          return false;
        },
      },
    });

    const response = await app.request('/blog/posts', postBody({ title: 'Nope', body: 'x' }));

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(seen, ['/blog/posts'], 'the access receives the request context');
    assert.equal((await repository.listPosts()).length, 0);
    await runtime.close();
  });

  it('refuses a cross-origin or origin-less post before the access runs', async () => {
    let calls = 0;
    const { app, runtime, repository } = await makeApp({
      createRoute: {
        access: () => {
          calls += 1;
          return true;
        },
      },
    });

    const crossSite = await app.request(
      '/blog/posts',
      postBody({ title: 'CSRF', body: 'x' }, 'https://evil.example'),
    );
    const noOrigin = await app.request('/blog/posts', postBody({ title: 'CSRF', body: 'x' }, null));

    assert.equal(crossSite.status, 403);
    assert.equal(noOrigin.status, 403);
    assert.equal(calls, 0);
    assert.equal((await repository.listPosts()).length, 0);
    await runtime.close();
  });

  it('answers 413 for a form past the 1 MiB cap and writes nothing', async () => {
    const { app, runtime, repository } = await makeApp(OPEN_CREATE_ROUTE);

    const response = await app.request(
      '/blog/posts',
      postBody({ title: 'Big', body: 'x'.repeat(1024 * 1024) }),
    );

    assert.equal(response.status, 413);
    assert.equal((await repository.listPosts()).length, 0);
    await runtime.close();
  });

  it('rejects a malformed caller slug with a value-free 422', async () => {
    const { app, runtime, repository } = await makeApp(OPEN_CREATE_ROUTE);

    for (const slug of ['../admin', 'a?b#c', 'Upper', 'a b']) {
      const response = await app.request(
        '/blog/posts',
        postBody({ title: 'Slug', slug, body: 'x' }),
      );
      assert.equal(response.status, 422, `slug ${slug} must be refused`);
      assert.doesNotMatch(await response.text(), /admin|a\?b/);
    }
    assert.equal((await repository.listPosts()).length, 0);
    await runtime.close();
  });

  it('fails at construction when createRoute has no access', () => {
    assert.throws(
      () => blogPlugin({ createRoute: {} as unknown as BlogCreateRouteOptions }),
      TypeError,
    );
  });
});

describe('blog plugin service and contract', () => {
  it('resolves the blogRepository token to the repository used by the routes', async () => {
    const { app, runtime, repository } = await makeApp(OPEN_CREATE_ROUTE);

    assert.equal(runtime.services.get(blogRepositoryToken), repository);

    await app.request('/blog/posts', postBody({ title: 'Hello', body: 'x' }));
    assert.equal((await repository.listPosts()).length, 1);

    await runtime.close();
  });

  it('works with a shared repository handed to both plugin and admin', async () => {
    const { app, runtime, repository } = await makeApp(OPEN_CREATE_ROUTE);

    await app.request('/blog/posts', postBody({ title: 'Shared', body: 'x' }));

    const resource = captureResource(blogAdmin({ repository }), 'posts');
    const list = await resource.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.total, 1);
    assert.equal(list.rows[0]?.title, 'Shared');

    await runtime.close();
  });

  it('before interceptor trims and rejects an empty title with a fixed message', async () => {
    const runtime = await makeRuntime();

    const args: BlogPostCreateInput = seedInput({ title: '  Hello  ', slug: ' hello ' });
    await runtime.interceptors.runBefore(createPostOperation, args);
    assert.equal(args.title, 'Hello');
    assert.equal(args.slug, 'hello');

    await assert.rejects(
      runtime.interceptors.runBefore(createPostOperation, seedInput({ title: '   ' })),
      (error: unknown) => {
        assert.ok(error instanceof BlogValidationError);
        assert.equal(error.code, 'missing_title');
        assert.equal(error.message, 'blog post title must be a non-empty string');
        return true;
      },
    );

    await runtime.close();
  });

  it('after interceptor passes the created post through', async () => {
    const runtime = await makeRuntime();

    const args: BlogPostCreateInput = seedInput({ title: 'Hello' });
    const post: BlogPost = {
      id: 'p1',
      title: 'Hello',
      slug: 'hello',
      excerpt: '',
      blocks: { version: 2, blocks: [] },
      status: 'published',
      authorId: 'test-author',
      featuredMediaId: null,
      categoryIds: [],
      tagIds: [],
      publishedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const result = await runtime.interceptors.runAfter(createPostOperation, args, post);

    assert.equal(result, post);

    await runtime.close();
  });

  it('emits postCreatedEvent with the created post', async () => {
    const runtime = await makeRuntime();

    const post: BlogPost = {
      id: 'p1',
      title: 'Hello',
      slug: 'hello',
      excerpt: '',
      blocks: { version: 2, blocks: [] },
      status: 'published',
      authorId: 'test-author',
      featuredMediaId: null,
      categoryIds: [],
      tagIds: [],
      publishedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const errors = await runtime.interceptors.emit(postCreatedEvent, { post });

    assert.equal(errors.length, 0);

    await runtime.close();
  });
});
