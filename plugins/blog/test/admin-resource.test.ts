import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import type { Session } from 'jsails';
import { type AdminPage, type AdminPlugin, type Resource } from '@jsails/admin';
import {
  blogAdmin,
  createContentRepository,
  type ContentRepository,
  type JsonValue,
} from '@jsails/blog';
import { defineRichTextEditorAdapter } from 'jsails/rich-text';

/**
 * Tests for the blog admin resource surface. The resources are exercised
 * through their descriptors: the `list`/`get`/`save` callbacks are invoked
 * directly with the same shape `adminPlugin` hands them, so the CRUD contract
 * is covered without a live panel, database, or HTTP server. The two curated
 * pages (settings and menus) are covered separately in `admin-pages.test.ts`.
 */

const session: Session = { id: 's', csrfToken: 't', data: {}, expiresAt: 0 };

/** Capture every resource and page the admin plugin registers. */
function captureContributions(plugin: AdminPlugin): {
  resources: Map<string, Resource>;
  pages: Map<string, AdminPage>;
} {
  const resources = new Map<string, Resource>();
  const pages = new Map<string, AdminPage>();
  plugin.register({
    addPage(page) {
      pages.set(page.slug, page);
    },
    addNavigationItem() {},
    addResource(resource) {
      resources.set(resource.slug, resource);
    },
  });
  return { resources, pages };
}

/** Capture every resource the admin plugin registers, keyed by slug. */
function captureResources(plugin: AdminPlugin): Map<string, Resource> {
  return captureContributions(plugin).resources;
}

/** Narrow a resource's optional `get`/`save` to their required forms. */
function handlers(resource: Resource): {
  list: Resource['list'];
  get: NonNullable<Resource['get']>;
  save: NonNullable<Resource['save']>;
} {
  assert.ok(resource.get, `resource ${resource.slug} must define get`);
  assert.ok(resource.save, `resource ${resource.slug} must define save`);
  return { list: resource.list, get: resource.get, save: resource.save };
}

/** Build the admin plugin with a fresh, deterministic repository. */
function makeAdmin(): { repository: ContentRepository; resources: Map<string, Resource> } {
  const repository = createContentRepository();
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

function makeEditorAdmin(): { repository: ContentRepository; resources: Map<string, Resource> } {
  const repository = createContentRepository();
  return { repository, resources: captureResources(blogAdmin({ repository, editor: fakeEditor })) };
}

describe('blog admin resources', () => {
  it('registers the four content resources plus the settings, menus, and revisions pages', () => {
    const plugin = blogAdmin();
    assert.equal(plugin.id, 'blog');

    const { resources, pages } = captureContributions(plugin);
    assert.deepEqual([...resources.keys()].sort(), ['categories', 'pages', 'posts', 'tags']);
    assert.deepEqual([...pages.keys()].sort(), ['menus', 'revisions', 'settings']);

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

  it('keeps the posts resource unchanged (title/slug/status columns; tag arrays unsupported)', () => {
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
