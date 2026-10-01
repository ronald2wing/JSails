import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Hono } from 'hono';
import { z } from 'zod';

import { definePlugin, runExtensions } from 'jsails/extensions';
import { defineRichTextEditorAdapter } from 'jsails/rich-text';
import { blogAdmin } from '../src/admin/index.js';
import type { BlogPost, BlogPostCreateInput } from '../src/cms/index.js';
import { blogEntities } from '../src/persistence/index.js';
import {
  BlogValidationError,
  blogEditorRendererToken,
  blogPlugin,
  blogRepositoryToken,
  createPostOperation,
  postCreatedEvent,
  type BlogPostCreatedEvent,
} from '../src/plugin.js';
import {
  captureResource,
  makeApp,
  postBody,
  seedInput,
  session,
  type TestAppEnv,
} from './fixtures.js';

/**
 * Tests for the first-party blog plugin: its static schema, the HTTP routes,
 * and the operation/event contract. The plugin runs through the real
 * extension runner, its collected HTTP hooks mount on a fresh Hono app, and
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
    const { app, runtime, repository } = await makeApp();

    const response = await app.request(
      '/blog/posts',
      postBody({ title: '  Hello  ', slug: '', body: 'world' }),
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
      version: 1,
      blocks: [{ id: post.blocks.blocks[0]?.id, type: 'paragraph', text: 'world' }],
    });

    await runtime.close();
  });

  it('lists published posts only, with escaped title and slug', async () => {
    const { app, runtime, repository } = await makeApp();

    await app.request('/blog/posts', postBody({ title: '<b>Draft</b>', body: 'x' }));
    await repository.createPost(seedInput({ title: '<b>Hi</b>', slug: '<i>hi</i>' }));

    const response = await app.request('/blog');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /&lt;b&gt;Hi&lt;\/b&gt;/);
    assert.match(html, /&lt;i&gt;hi&lt;\/i&gt;/);
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

    const runtime = await runExtensions([blogPlugin(), observerPlugin]);
    const app = new Hono<TestAppEnv>();
    for (const hook of runtime.httpHooks) {
      await hook(app);
    }

    const response = await app.request('/blog/posts', postBody({ title: 'Shared', body: 'x' }));
    assert.equal(response.status, 303);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.post.title, 'Shared');

    await runtime.close();
  });

  it('rejects an empty title with a value-free 422 and no post', async () => {
    const { app, runtime, repository } = await makeApp();

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

describe('blog plugin service and contract', () => {
  it('exposes an adapter renderer only when the adapter supplies render', async () => {
    const adapter = defineRichTextEditorAdapter({
      id: 'fake',
      island: 'fake-editor',
      payloadSchema: z.object({ text: z.string() }),
      toContent: (payload) => ({
        version: 1,
        blocks: [{ id: 'b1', type: 'paragraph', text: payload.text }],
      }),
      fromContent: (document) => {
        const first = document.blocks[0];
        return { text: first?.type === 'paragraph' ? first.text : '' };
      },
      render: (payload) => `<p>${payload.text}</p>`,
    });
    const runtime = await runExtensions([blogPlugin({ editor: adapter })]);
    try {
      const renderer = runtime.services.get(blogEditorRendererToken);
      const document = {
        version: 1 as const,
        editor: 'fake',
        content: {
          version: 1 as const,
          blocks: [{ id: 'b1', type: 'paragraph' as const, text: 'hello' }],
        },
        native: { text: 'hello' },
      };
      assert.equal(renderer(document), '<p>hello</p>');
      assert.equal(renderer({ ...document, editor: 'other' }), undefined);
    } finally {
      await runtime.close();
    }
  });

  it('does not provide a renderer token without an adapter renderer', async () => {
    const runtime = await runExtensions([blogPlugin()]);
    try {
      assert.equal(runtime.services.tryGet(blogEditorRendererToken), undefined);
    } finally {
      await runtime.close();
    }
  });

  it('resolves the blogRepository token to the repository used by the routes', async () => {
    const { app, runtime, repository } = await makeApp();

    assert.equal(runtime.services.get(blogRepositoryToken), repository);

    await app.request('/blog/posts', postBody({ title: 'Hello', body: 'x' }));
    assert.equal((await repository.listPosts()).length, 1);

    await runtime.close();
  });

  it('works with a shared repository handed to both plugin and admin', async () => {
    const { app, runtime, repository } = await makeApp();

    await app.request('/blog/posts', postBody({ title: 'Shared', body: 'x' }));

    const resource = captureResource(blogAdmin({ repository }), 'posts');
    const list = await resource.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.total, 1);
    assert.equal(list.rows[0]?.title, 'Shared');

    await runtime.close();
  });

  it('before interceptor trims and rejects an empty title with a fixed message', async () => {
    const { runtime } = await makeApp();

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
    const { runtime } = await makeApp();

    const args: BlogPostCreateInput = seedInput({ title: 'Hello' });
    const post: BlogPost = {
      id: 'p1',
      title: 'Hello',
      slug: 'hello',
      excerpt: '',
      blocks: { version: 1, blocks: [] },
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
    const { runtime } = await makeApp();

    const post: BlogPost = {
      id: 'p1',
      title: 'Hello',
      slug: 'hello',
      excerpt: '',
      blocks: { version: 1, blocks: [] },
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
