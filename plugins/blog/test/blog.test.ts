import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Hono } from 'hono';
import { z } from 'zod';

import type { Session } from 'jsails';
import {
  definePlugin,
  runExtensions,
  type ExtensionRuntime,
  type HttpExtensionHook,
} from 'jsails/extensions';
import { type AdminPlugin, type Resource } from '@jsails/admin';
import { defineRichTextEditorAdapter } from 'jsails/rich-text';
import {
  BlogValidationError,
  blogEditorRendererToken,
  blogRepositoryToken,
  blogAdmin,
  blogPlugin,
  contentEntities,
  createPostOperation,
  postCreatedEvent,
  type BlogPostCreatedEvent,
  type ContentRepository,
  type Post,
  type PostCreateInput,
} from '@jsails/blog';

/**
 * Tests for the first-party blog plugin and its admin surface. The plugin runs
 * through the real extension runner, its collected HTTP hooks mount on a fresh
 * Hono app, and requests are driven in-process (no listener, no database, no
 * service). The admin surface is exercised through its descriptor: the
 * resource callbacks (`list`/`get`/`save`) are invoked directly with the same
 * shape `adminPlugin` hands them, so the CRUD contract is covered without a
 * live panel.
 */

// `AppEnv` is not part of the public `jsails` surface; recover it from the
// public `HttpExtensionHook` contract instead of naming it.
type TestAppEnv = Parameters<HttpExtensionHook>[0] extends Hono<infer E> ? E : never;

interface TestApp {
  app: Hono<TestAppEnv>;
  runtime: ExtensionRuntime;
  repository: ContentRepository;
}

/** Build the plugin through the runner and mount its hooks on a fresh Hono app. */
async function makeApp(repository?: ContentRepository): Promise<TestApp> {
  const plugin = blogPlugin(repository === undefined ? {} : { repository });
  const runtime = await runExtensions([plugin]);
  const app = new Hono<TestAppEnv>();
  for (const hook of runtime.httpHooks) {
    await hook(app);
  }
  return { app, runtime, repository: runtime.services.get(blogRepositoryToken) };
}

/** An `application/x-www-form-urlencoded` POST body. */
function postBody(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

/** A valid post-create input the tests seed published posts with. */
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

describe('blog plugin schema', () => {
  it('declares the CMS entities statically for db:push', () => {
    const plugin = blogPlugin();
    assert.ok(plugin.schema, 'blog plugin must declare a static schema');
    assert.deepEqual(plugin.schema.entities, contentEntities);
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
    // Regression: the blog plugin used to run its operation through a private
    // registry, so observers registered by other plugins never fired for posts
    // created over HTTP. It now runs through the shared registry.
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

    const resource = blogResource(blogAdmin({ repository }));
    const list = await resource.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.total, 1);
    assert.equal(list.rows[0]?.title, 'Shared');

    await runtime.close();
  });

  it('before interceptor trims and rejects an empty title with a fixed message', async () => {
    const { runtime } = await makeApp();

    const args: PostCreateInput = seedInput({ title: '  Hello  ', slug: ' hello ' });
    await runtime.interceptors.runBefore(createPostOperation, args);
    assert.equal(args.title, 'Hello');
    assert.equal(args.slug, 'hello');

    await assert.rejects(
      runtime.interceptors.runBefore(createPostOperation, seedInput({ title: '   ' })),
      (error: unknown) => {
        assert.ok(error instanceof BlogValidationError);
        assert.equal(error.message, 'blog post title must be a non-empty string');
        return true;
      },
    );

    await runtime.close();
  });

  it('after interceptor passes the created post through', async () => {
    const { runtime } = await makeApp();

    const args: PostCreateInput = seedInput({ title: 'Hello' });
    const post: Post = {
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

    const post: Post = {
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

// Shared by the admin tests below.
const session: Session = { id: 's', csrfToken: 't', data: {}, expiresAt: 0 };

/** Capture every resource contribution from the admin plugin's register. */
function captureResources(plugin: AdminPlugin): readonly Resource[] {
  const captured: Resource[] = [];
  plugin.register({
    addPage() {},
    addNavigationItem() {},
    addResource(resource) {
      captured.push(resource);
    },
  });
  assert.ok(captured.length > 0, 'blog admin must contribute resources');
  return captured;
}

/** Capture one resource by slug (the admin contributes four). */
function captureResource(plugin: AdminPlugin, slug = 'posts'): Resource {
  const resource = captureResources(plugin).find((entry) => entry.slug === slug);
  assert.ok(resource, `blog admin must contribute the ${slug} resource`);
  return resource;
}

/** Capture the resource and narrow its optional `get`/`save` to required. */
function blogResource(plugin: AdminPlugin): {
  list: Resource['list'];
  get: NonNullable<Resource['get']>;
  save: NonNullable<Resource['save']>;
} {
  const resource = captureResource(plugin);
  assert.ok(resource.get, 'resource must define get');
  assert.ok(resource.save, 'resource must define save');
  return { list: resource.list, get: resource.get, save: resource.save };
}

describe('blog admin', () => {
  it('has id "blog" and a "posts" resource with the CMS columns and fields', () => {
    const plugin = blogAdmin();
    assert.equal(plugin.id, 'blog');
    const resource = captureResource(plugin);
    assert.equal(resource.slug, 'posts');
    assert.deepEqual(
      resource.columns.map((column) => column.name),
      ['title', 'slug', 'status'],
    );
    assert.deepEqual(
      resource.fields.map((field) => field.name),
      ['title', 'slug', 'body', 'status'],
    );
    assert.ok(resource.list);
    assert.ok(resource.get);
    assert.ok(resource.save);
  });

  it('lists, gets, creates, and updates posts by string id', async () => {
    const resource = blogResource(blogAdmin());

    // Create through the admin save path (drafts by default when status is absent).
    await resource.save({ session, id: null, values: { title: 'First', slug: 'first' } });
    await resource.save({
      session,
      id: null,
      values: { title: 'Second', slug: 'second', status: 'published' },
    });

    const list = await resource.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.total, 2);
    assert.deepEqual(
      list.rows.map((row) => row.title),
      ['First', 'Second'],
    );
    assert.deepEqual(
      list.rows.map((row) => row.status),
      ['draft', 'published'],
    );

    const first = list.rows[0];
    assert.ok(first);
    assert.equal(typeof first.id, 'string');

    const got = await resource.get({ session, id: String(first.id) });
    assert.deepEqual(got, {
      title: 'First',
      slug: 'first',
      status: 'draft',
      body: { version: 1, blocks: [] },
    });

    await resource.save({
      session,
      id: String(first.id),
      values: { title: 'Renamed', slug: 'renamed', status: 'published' },
    });
    const renamed = await resource.get({ session, id: String(first.id) });
    assert.deepEqual(renamed, {
      title: 'Renamed',
      slug: 'renamed',
      status: 'published',
      body: { version: 1, blocks: [] },
    });
  });

  it('returns null for an unknown id', async () => {
    const resource = blogResource(blogAdmin());

    assert.equal(await resource.get({ session, id: 'does-not-exist' }), null);
  });

  it('persists the submitted body as the post blocks', async () => {
    const resource = blogResource(blogAdmin());

    await resource.save({
      session,
      id: null,
      values: {
        title: 'With body',
        slug: 'with-body',
        body: { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text: 'Hello.' }] },
      },
    });

    const list = await resource.list({ session, page: 1, pageSize: 10 });
    const row = list.rows[0];
    assert.ok(row);
    const got = await resource.get({ session, id: String(row.id) });
    assert.deepEqual(got, {
      title: 'With body',
      slug: 'with-body',
      status: 'draft',
      body: { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text: 'Hello.' }] },
    });
  });

  it('rejects a malformed body defensively with an empty document', async () => {
    const resource = blogResource(blogAdmin());

    await resource.save({
      session,
      id: null,
      values: { title: 'Bad body', slug: 'bad-body', body: 'not-a-document' },
    });

    const list = await resource.list({ session, page: 1, pageSize: 10 });
    const row = list.rows[0];
    assert.ok(row);
    const got = await resource.get({ session, id: String(row.id) });
    assert.ok(got);
    assert.deepEqual(got.body, { version: 1, blocks: [] });
  });

  it('derives a slug when the form leaves it blank', async () => {
    const resource = blogResource(blogAdmin());

    await resource.save({ session, id: null, values: { title: 'Hello World!' } });

    const list = await resource.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.rows[0]?.slug, 'hello-world');
  });
});
