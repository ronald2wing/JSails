import type { JsonValue } from 'jsails/plugin-sdk';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { ValidationError } from 'jsails/api';
import { defineRichTextEditorAdapter } from 'jsails/rich-text';
import { createTestApp, postForm } from 'jsails/testing';
import { adminPlugin, defineAdminPanel, type AdminPlugin, type Resource } from '@jsails/admin';
import { blogAdmin } from '../../src/admin/index.js';
import { createMemoryBlogRepository, type BlogRepository } from '../../src/cms/index.js';
import { captureContributions, captureResource, handlers, session } from '../fixtures.js';

/**
 * Tests for the blog admin resource surface. The resources are exercised
 * through their descriptors: the `list`/`get`/`save` callbacks are invoked
 * directly with the same shape `adminPlugin` hands them, so the CRUD contract
 * is covered without a live panel, database, or HTTP server. The curated pages
 * (menus, revisions, themes) have their own test files.
 */

/** Capture every resource the admin plugin registers, keyed by slug. */
function captureResources(plugin: AdminPlugin): Map<string, Resource> {
  return captureContributions(plugin).resources;
}

/** Build the admin plugin with a fresh, deterministic repository. */
function makeAdmin(): { repository: BlogRepository; resources: Map<string, Resource> } {
  const repository = createMemoryBlogRepository();
  return { repository, resources: captureResources(blogAdmin({ repository })) };
}

/** Narrow a revision snapshot to its object form (it is always a record here). */
function jsonSnapshot(snapshot: JsonValue): Record<string, JsonValue> {
  assert.equal(typeof snapshot, 'object');
  assert.ok(snapshot !== null && !Array.isArray(snapshot));
  return snapshot as Record<string, JsonValue>;
}

/** A fake native-payload adapter: content is the paragraph text. */
const fakeEditor = defineRichTextEditorAdapter({
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
});

function makeEditorAdmin(): { repository: BlogRepository; resources: Map<string, Resource> } {
  const repository = createMemoryBlogRepository();
  return { repository, resources: captureResources(blogAdmin({ repository, editor: fakeEditor })) };
}

describe('blog admin resources', () => {
  it('registers the four content resources plus the menus and revisions pages', () => {
    const plugin = blogAdmin();
    assert.equal(plugin.id, 'blog');

    const { resources, pages } = captureContributions(plugin);
    assert.deepEqual([...resources.keys()].sort(), ['categories', 'pages', 'posts', 'tags']);
    assert.deepEqual([...pages.keys()].sort(), ['menus', 'revisions']);

    for (const resource of resources.values()) {
      assert.ok(resource.list, `resource ${resource.slug} must define list`);
      assert.ok(resource.get, `resource ${resource.slug} must define get`);
      assert.ok(resource.save, `resource ${resource.slug} must define save`);
      assert.equal(typeof resource.schema, 'object');
    }
    for (const page of pages.values()) {
      assert.ok(page.render, `page ${page.slug} must define render`);
      assert.ok(page.handlePost, `page ${page.slug} must define handlePost`);
    }
  });

  it('exposes title/slug/status columns and the body field on the posts resource', () => {
    const resources = captureResources(blogAdmin());
    const posts = resources.get('posts');
    assert.ok(posts);
    assert.deepEqual(
      posts.columns.map((column) => column.name),
      ['title', 'slug', 'status'],
    );
    assert.deepEqual(
      posts.fields.map((field) => field.name),
      ['title', 'slug', 'body', 'status'],
    );
  });

  it('lists, gets, creates, and updates posts by string id', async () => {
    const resource = captureResource(blogAdmin(), 'posts');

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

  it('persists the submitted body as the post blocks', async () => {
    const resource = captureResource(blogAdmin(), 'posts');

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
    const resource = captureResource(blogAdmin(), 'posts');

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
    const resource = captureResource(blogAdmin(), 'posts');

    await resource.save({ session, id: null, values: { title: 'Hello World!' } });

    const list = await resource.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.rows[0]?.slug, 'hello-world');
  });

  it('creates, lists, gets, and updates a page through save', async () => {
    const { repository, resources } = makeAdmin();
    const pages = handlers(resources.get('pages')!);

    await pages.save({
      session,
      id: null,
      values: {
        title: 'About',
        slug: '',
        body: { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text: 'Hello.' }] },
        status: 'draft',
        parentId: '',
        sortOrder: 3,
      },
    });

    const list = await pages.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.total, 1);
    const row = list.rows[0];
    assert.ok(row);
    assert.equal(row.title, 'About');
    assert.equal(row.slug, 'about'); // derived from the title
    assert.equal(row.status, 'draft');
    assert.equal(row.sortOrder, 3);
    const id = String(row.id);

    const got = await pages.get({ session, id });
    assert.ok(got);
    assert.equal(got.title, 'About');
    assert.equal(got.parentId, ''); // null parent rendered as an empty field
    assert.equal(got.sortOrder, 3);
    assert.deepEqual(got.body, {
      version: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text: 'Hello.' }],
    });

    await pages.save({
      session,
      id,
      values: { title: 'Renamed', slug: 'renamed', status: 'draft', sortOrder: 5 },
    });
    const renamed = await repository.getPage(id);
    assert.ok(renamed);
    assert.equal(renamed.title, 'Renamed');
    assert.equal(renamed.slug, 'renamed');
    assert.equal(renamed.sortOrder, 5);
  });

  it('transitions a page status through publishPage/unpublishPage on save', async () => {
    const { repository, resources } = makeAdmin();
    const pages = handlers(resources.get('pages')!);

    await pages.save({
      session,
      id: null,
      values: { title: 'Draft', status: 'draft' },
    });
    const list = await pages.list({ session, page: 1, pageSize: 10 });
    const id = String(list.rows[0]!.id);

    // draft -> published through the publish transition
    await pages.save({ session, id, values: { title: 'Draft', status: 'published' } });
    assert.equal((await repository.getPage(id))!.status, 'published');

    // published -> draft through the unpublish transition
    await pages.save({ session, id, values: { title: 'Draft', status: 'draft' } });
    assert.equal((await repository.getPage(id))!.status, 'draft');
  });

  it('creates, lists, gets, and updates a category, deriving its slug when blank', async () => {
    const { repository, resources } = makeAdmin();
    const categories = handlers(resources.get('categories')!);

    await categories.save({
      session,
      id: null,
      values: { name: 'Tutorials', description: 'Step-by-step guides' },
    });

    const list = await categories.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.total, 1);
    const row = list.rows[0];
    assert.ok(row);
    assert.equal(row.slug, 'tutorials');
    const id = String(row.id);

    const got = await categories.get({ session, id });
    assert.deepEqual(got, {
      name: 'Tutorials',
      slug: 'tutorials',
      description: 'Step-by-step guides',
    });

    await categories.save({ session, id, values: { name: 'Guides', slug: 'guides' } });
    const updated = await repository.getCategory(id);
    assert.ok(updated);
    assert.equal(updated.name, 'Guides');
    assert.equal(updated.slug, 'guides');
  });

  it('creates, lists, gets, and updates a tag', async () => {
    const { repository, resources } = makeAdmin();
    const tags = handlers(resources.get('tags')!);

    await tags.save({ session, id: null, values: { name: 'News' } });

    const list = await tags.list({ session, page: 1, pageSize: 10 });
    assert.equal(list.total, 1);
    const row = list.rows[0];
    assert.ok(row);
    assert.equal(row.slug, 'news');
    const id = String(row.id);

    await tags.save({ session, id, values: { name: 'Updates', slug: 'updates' } });
    const updated = await repository.getTag(id);
    assert.ok(updated);
    assert.equal(updated.name, 'Updates');
    assert.equal(updated.slug, 'updates');
  });

  it('returns null for an unknown id on every resource', async () => {
    const { resources } = makeAdmin();
    for (const resource of resources.values()) {
      const { get } = handlers(resource);
      assert.equal(await get({ session, id: 'does-not-exist' }), null, resource.slug);
    }
  });

  it('records a revision on post update but not on create', async () => {
    const { repository, resources } = makeAdmin();
    const posts = resources.get('posts')!;

    // Create records nothing.
    await posts.save!({ session, id: null, values: { title: 'Draft', slug: '' } });
    const created = (await repository.listPosts())[0]!;
    assert.equal((await repository.listRevisions('post', created.id)).length, 0);

    // Update records one revision snapshot carrying the saved content fields.
    await posts.save!({
      session,
      id: created.id,
      values: {
        title: 'Renamed',
        slug: 'renamed',
        body: { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text: 'Hi.' }] },
        status: 'draft',
      },
    });

    const revisions = await repository.listRevisions('post', created.id);
    assert.equal(revisions.length, 1);
    const snapshot = jsonSnapshot(revisions[0]!.snapshot);
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'blocks',
      'categoryIds',
      'excerpt',
      'featuredMediaId',
      'slug',
      'tagIds',
      'title',
    ]);
    assert.equal(snapshot['title'], 'Renamed');
    assert.equal(snapshot['slug'], 'renamed');
    assert.equal(snapshot['excerpt'], '');
    assert.deepEqual(snapshot['categoryIds'], []);
    assert.deepEqual(snapshot['tagIds'], []);
    assert.equal(snapshot['featuredMediaId'], null);
  });

  it('records a revision on page update with page content fields', async () => {
    const { repository, resources } = makeAdmin();
    const pages = resources.get('pages')!;

    await pages.save!({ session, id: null, values: { title: 'About', slug: '' } });
    const created = (await repository.listPages())[0]!;

    await pages.save!({
      session,
      id: created.id,
      values: { title: 'About Us', slug: 'about-us', parentId: '', sortOrder: 2 },
    });

    const revisions = await repository.listRevisions('page', created.id);
    assert.equal(revisions.length, 1);
    const snapshot = jsonSnapshot(revisions[0]!.snapshot);
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'blocks',
      'parentId',
      'slug',
      'sortOrder',
      'title',
    ]);
    assert.equal(snapshot['title'], 'About Us');
    assert.equal(snapshot['slug'], 'about-us');
    assert.equal(snapshot['parentId'], null);
    assert.equal(snapshot['sortOrder'], 2);
  });
});

describe('blog admin editor adapters', () => {
  it('stores the canonical content, editor id, and native payload for a post', async () => {
    const { repository, resources } = makeEditorAdmin();
    const posts = handlers(resources.get('posts')!);

    await posts.save({
      session,
      id: null,
      values: {
        title: 'Adapter post',
        slug: 'adapter-post',
        status: 'draft',
        body: {
          version: 1,
          editor: 'fake',
          content: {
            version: 1,
            blocks: [{ id: 'b1', type: 'paragraph', text: 'Native hello' }],
          },
          native: { text: 'Native hello' },
        },
      },
    });

    const created = (await repository.listPosts())[0];
    assert.ok(created);
    assert.equal(created.editor, 'fake');
    assert.deepEqual(created.native, { text: 'Native hello' });
    assert.deepEqual(created.blocks, {
      version: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text: 'Native hello' }],
    });

    const got = await posts.get({ session, id: created.id });
    assert.ok(got);
    assert.deepEqual(got.body, {
      version: 1,
      editor: 'fake',
      content: created.blocks,
      native: { text: 'Native hello' },
    });
  });

  it('stores an envelope for a page and reloads it into the edit form shape', async () => {
    const { repository, resources } = makeEditorAdmin();
    const pages = handlers(resources.get('pages')!);

    await pages.save({
      session,
      id: null,
      values: {
        title: 'Adapter page',
        slug: 'adapter-page',
        status: 'draft',
        sortOrder: 0,
        body: {
          version: 1,
          editor: 'fake',
          content: {
            version: 1,
            blocks: [{ id: 'b1', type: 'paragraph', text: 'Page native' }],
          },
          native: { text: 'Page native' },
        },
      },
    });

    const created = (await repository.listPages())[0];
    assert.ok(created);
    assert.equal(created.editor, 'fake');
    assert.deepEqual(created.native, { text: 'Page native' });

    const got = await pages.get({ session, id: created.id });
    assert.ok(got);
    assert.deepEqual(got.body, {
      version: 1,
      editor: 'fake',
      content: created.blocks,
      native: { text: 'Page native' },
    });
  });

  it('rejects a mismatched editor id and a native payload the adapter rejects', async () => {
    const { resources } = makeEditorAdmin();
    const posts = handlers(resources.get('posts')!);
    const base = {
      title: 'Bad',
      slug: 'bad',
      status: 'draft',
    };

    await assert.rejects(
      posts.save({
        session,
        id: null,
        values: {
          ...base,
          body: {
            version: 1,
            editor: 'other',
            content: { version: 1, blocks: [] },
            native: { text: 'x' },
          },
        },
      }),
    );
    await assert.rejects(
      posts.save({
        session,
        id: null,
        values: {
          ...base,
          body: {
            version: 1,
            editor: 'fake',
            content: { version: 1, blocks: [] },
            native: { text: 42 },
          },
        },
      }),
    );
  });
});

describe('blog admin saves: retention, attribution, and atomicity', () => {
  /** A post body value whose paragraph text is `text`. */
  function body(text: string) {
    return { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text }] };
  }

  it('keeps only the newest revisions per entry', async () => {
    const repository = createMemoryBlogRepository();
    const posts = handlers(
      captureResources(blogAdmin({ repository, revisionLimit: 3 })).get('posts')!,
    );
    await posts.save({ session, id: null, values: { title: 'Post', slug: 'post' } });
    const id = (await repository.listPosts())[0]!.id;

    for (let i = 1; i <= 5; i += 1) {
      await posts.save({
        session,
        id,
        values: { title: `Edit ${i}`, slug: 'post', body: body(`v${i}`), status: 'draft' },
      });
    }

    const titles = (await repository.listRevisions('post', id)).map(
      (revision) => jsonSnapshot(revision.snapshot)['title'],
    );
    assert.deepEqual(titles, ['Edit 3', 'Edit 4', 'Edit 5']);
  });

  it('records no revision when a save leaves the content unchanged', async () => {
    const { repository, resources } = makeAdmin();
    const posts = handlers(resources.get('posts')!);
    await posts.save({ session, id: null, values: { title: 'Post', slug: 'post' } });
    const id = (await repository.listPosts())[0]!.id;
    const values = { title: 'Same', slug: 'post', body: body('same'), status: 'draft' };

    await posts.save({ session, id, values });
    await posts.save({ session, id, values: { ...values, status: 'published' } });

    assert.equal((await repository.listRevisions('post', id)).length, 1);
    assert.equal((await repository.getPost(id))?.status, 'published');
  });

  it('attributes writes and revisions to the signed-in admin user', async () => {
    const { repository, resources } = makeAdmin();
    const posts = handlers(resources.get('posts')!);
    const editor = { ...session, data: { user: { id: 'user-42' } } };

    await posts.save({ session: editor, id: null, values: { title: 'Mine', slug: 'mine' } });
    const created = (await repository.listPosts())[0]!;
    await posts.save({
      session: editor,
      id: created.id,
      values: { title: 'Mine 2', slug: 'mine', body: body('x'), status: 'draft' },
    });

    assert.equal(created.authorId, 'user-42');
    assert.equal((await repository.listRevisions('post', created.id))[0]?.authorId, 'user-42');
  });

  it('rolls the content update back when the status transition fails', async () => {
    const backing = createMemoryBlogRepository();
    const failing: BlogRepository = {
      ...backing,
      transaction: (work) =>
        backing.transaction((tx) =>
          work({
            ...tx,
            publishPost: () => Promise.reject(new Error('transition failed')),
          }),
        ),
    };
    const posts = handlers(captureResources(blogAdmin({ repository: failing })).get('posts')!);
    await posts.save({ session, id: null, values: { title: 'Before', slug: 'before' } });
    const id = (await backing.listPosts())[0]!.id;

    await assert.rejects(
      posts.save({
        session,
        id,
        values: { title: 'After', slug: 'before', body: body('x'), status: 'published' },
      }),
      /transition failed/,
    );

    assert.equal((await backing.getPost(id))?.title, 'Before');
    assert.equal((await backing.listRevisions('post', id)).length, 0);
  });

  it('lists a page of post summaries without loading every post', async () => {
    const backing = createMemoryBlogRepository();
    const repository: BlogRepository = {
      ...backing,
      listPosts: () => Promise.reject(new Error('the admin list must page in the repository')),
    };
    for (const slug of ['a', 'b', 'c']) {
      await backing.createPost({
        title: slug,
        slug,
        blocks: { version: 1, blocks: [] },
        status: 'draft',
        authorId: 'a1',
      });
    }
    const posts = handlers(captureResources(blogAdmin({ repository })).get('posts')!);

    const page = await posts.list({ session, page: 2, pageSize: 2 });

    assert.equal(page.total, 3);
    assert.deepEqual(
      page.rows.map((row) => row['slug']),
      ['c'],
    );
  });

  it('rejects a revision limit that is not a positive integer', () => {
    for (const revisionLimit of [0, -1, 2.5]) {
      assert.throws(() => blogAdmin({ revisionLimit }), TypeError);
    }
  });
});

describe('blog admin saves: slug and conflict form errors', () => {
  /** Assert a save rejected with a value-free form error on the given field. */
  function isFieldError(field: string | undefined) {
    return (error: unknown): boolean =>
      error instanceof ValidationError &&
      error.issues.length === 1 &&
      error.issues[0]!.path[0] === field;
  }

  it('rejects a typed slug the model refuses on every resource, writing nothing', async () => {
    const { repository, resources } = makeAdmin();
    for (const slug of ['Hello World', 'my_post', 'a--b', '../admin']) {
      for (const [resourceSlug, values] of [
        ['posts', { title: 'Post', slug }],
        ['pages', { title: 'Page', slug }],
        ['categories', { name: 'Cat', slug }],
        ['tags', { name: 'Tag', slug }],
      ] as const) {
        await assert.rejects(
          handlers(resources.get(resourceSlug)!).save({ session, id: null, values }),
          isFieldError('slug'),
        );
      }
    }
    assert.equal((await repository.listPosts()).length, 0);
    assert.equal((await repository.listPages()).length, 0);
    assert.equal((await repository.listCategories()).length, 0);
    assert.equal((await repository.listTags()).length, 0);
  });

  it('trims a typed slug before checking it', async () => {
    const { repository, resources } = makeAdmin();
    await handlers(resources.get('posts')!).save({
      session,
      id: null,
      values: { title: 'Post', slug: '  my-post  ' },
    });
    assert.equal((await repository.listPosts())[0]?.slug, 'my-post');
  });

  it('shows a taken slug on the slug field instead of failing the request', async () => {
    const { resources } = makeAdmin();
    const posts = handlers(resources.get('posts')!);
    await posts.save({ session, id: null, values: { title: 'One', slug: 'same' } });

    await assert.rejects(
      posts.save({ session, id: null, values: { title: 'Two', slug: 'same' } }),
      isFieldError('slug'),
    );
  });

  it('re-renders the admin form with a 422 for an invalid slug', async () => {
    const repository = createMemoryBlogRepository();
    const posts = captureResources(blogAdmin({ repository })).get('posts')!;
    const panel = defineAdminPanel({
      resolveSession: () => session,
      authorize: () => true,
      resources: [posts],
    });
    const app = await createTestApp({ config: { port: 0, extensions: [adminPlugin(panel)] } });
    try {
      const response = await postForm(app, '/admin/posts', {
        _csrf: session.csrfToken,
        title: 'Hello',
        slug: 'Hello World',
        status: 'draft',
        body: JSON.stringify({ version: 1, blocks: [{ id: 'b1', type: 'paragraph', text: 'Hi' }] }),
      });
      assert.equal(response.status, 422);
      assert.match(
        await response.text(),
        /role="alert">Use lowercase letters, digits, and single hyphens/,
      );
      assert.equal((await repository.listPosts()).length, 0);
    } finally {
      await app.close();
    }
  });
});
