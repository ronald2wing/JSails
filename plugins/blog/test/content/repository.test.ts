import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ContentError,
  createContentRepository,
  type ContentRepository,
  type PageCreateInput,
  type PostCreateInput,
} from '@jsails/blog';
import { createEmptyRichTextDocument } from '@jsails/editor';

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

/** Build a repository with deterministic ids and timestamps. */
function makeRepository(): ContentRepository {
  let sequence = 0;
  return createContentRepository({
    now: () => FIXED_NOW,
    nextId: () => `id-${(sequence += 1)}`,
  });
}

/** A minimal post create input, overridable per test. */
function postInput(overrides: Partial<PostCreateInput> = {}): PostCreateInput {
  return {
    title: 'Hello',
    slug: 'hello',
    blocks: createEmptyRichTextDocument(),
    status: 'draft',
    authorId: 'a1',
    ...overrides,
  };
}

/** Assert a call rejects with a value-free ContentError of the given code. */
async function rejectsWithCode(
  promise: Promise<unknown>,
  code: string,
  messageMustNotContain?: string,
): Promise<ContentError> {
  let captured: ContentError | undefined;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ContentError, `expected ContentError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (messageMustNotContain !== undefined) {
      assert.ok(
        !error.message.includes(messageMustNotContain),
        'error message must not echo input',
      );
    }
    captured = error;
    return true;
  });
  assert.ok(captured !== undefined, 'expected a ContentError');
  return captured;
}

describe('posts', () => {
  it('creates a draft with assigned id and timestamps', async () => {
    const repo = makeRepository();
    const post = await repo.createPost(postInput());

    assert.equal(post.id, 'id-1');
    assert.equal(post.status, 'draft');
    assert.equal(post.excerpt, '');
    assert.equal(post.featuredMediaId, null);
    assert.deepEqual(post.categoryIds, []);
    assert.deepEqual(post.tagIds, []);
    assert.equal(post.publishedAt, null);
    assert.equal(post.createdAt, FIXED_NOW.toISOString());
    assert.equal(post.updatedAt, FIXED_NOW.toISOString());
    assert.ok(Object.isFrozen(post));
  });

  it('stamps publishedAt when created published', async () => {
    const repo = makeRepository();
    const post = await repo.createPost(postInput({ status: 'published' }));
    assert.equal(post.status, 'published');
    assert.equal(post.publishedAt, FIXED_NOW.toISOString());
  });

  it('lists and gets by id', async () => {
    const repo = makeRepository();
    const post = await repo.createPost(postInput());
    assert.deepEqual(await repo.listPosts(), [post]);
    assert.equal(await repo.getPost(post.id), post);
    assert.equal(await repo.getPost('missing'), undefined);
  });

  it('updates fields in place and bumps updatedAt only', async () => {
    const repo = makeRepository();
    const created = await repo.createPost(postInput());

    const updated = await repo.updatePost(created.id, {
      title: 'Renamed',
      excerpt: 'A new excerpt',
      blocks: { version: 1, blocks: [] },
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.title, 'Renamed');
    assert.equal(updated.excerpt, 'A new excerpt');
    assert.equal(updated.updatedAt, FIXED_NOW.toISOString());
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal((await repo.getPost(created.id))?.title, 'Renamed');
  });

  it('clears featured media with an explicit null', async () => {
    const repo = makeRepository();
    const created = await repo.createPost(postInput({ featuredMediaId: 'm1' }));
    assert.equal(created.featuredMediaId, 'm1');

    const updated = await repo.updatePost(created.id, { featuredMediaId: null });
    assert.equal(updated.featuredMediaId, null);
  });

  it('reconciles from draft to published on publish', async () => {
    const repo = makeRepository();
    const created = await repo.createPost(postInput());

    const published = await repo.publishPost(created.id);
    assert.equal(published.status, 'published');
    assert.equal(published.publishedAt, FIXED_NOW.toISOString());
  });

  it('publish is an idempotent no-op for an already-published post', async () => {
    const repo = makeRepository();
    const created = await repo.createPost(postInput({ status: 'published' }));

    const again = await repo.publishPost(created.id);
    assert.equal(again, created);
  });

  it('unpublishes published content back to draft without dropping publishedAt', async () => {
    const repo = makeRepository();
    const created = await repo.createPost(postInput({ status: 'published' }));

    const draft = await repo.unpublishPost(created.id);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.publishedAt, created.publishedAt);
  });

  it('unpublish is a no-op for an already-draft post', async () => {
    const repo = makeRepository();
    const created = await repo.createPost(postInput());
    assert.equal(await repo.unpublishPost(created.id), created);
  });

  it('deletes a post and errors for a missing id', async () => {
    const repo = makeRepository();
    const created = await repo.createPost(postInput());

    await repo.deletePost(created.id);
    assert.equal(await repo.getPost(created.id), undefined);
    await rejectsWithCode(repo.deletePost(created.id), 'not_found');
  });

  it('rejects an archived status at create time', async () => {
    const repo = makeRepository();
    await rejectsWithCode(repo.createPost(postInput({ status: 'archived' })), 'invalid_status');
  });

  it('enforces slug uniqueness within the post collection', async () => {
    const repo = makeRepository();
    await repo.createPost(postInput());
    await rejectsWithCode(repo.createPost(postInput({ title: 'Other' })), 'slug_conflict', 'hello');
  });

  it('rejects a slug move onto another post', async () => {
    const repo = makeRepository();
    const first = await repo.createPost(postInput({ slug: 'first' }));
    await repo.createPost(postInput({ title: 'Second', slug: 'second' }));

    await rejectsWithCode(repo.updatePost(first.id, { slug: 'second' }), 'slug_conflict');
  });

  it('allows an update that keeps its own slug', async () => {
    const repo = makeRepository();
    const first = await repo.createPost(postInput({ slug: 'first' }));
    await repo.createPost(postInput({ title: 'Second', slug: 'second' }));

    const updated = await repo.updatePost(first.id, { title: 'Still first', slug: 'first' });
    assert.equal(updated.title, 'Still first');
  });
});

describe('pages', () => {
  function pageInput(overrides: Partial<PageCreateInput> = {}): PageCreateInput {
    return {
      title: 'About',
      slug: 'about',
      blocks: createEmptyRichTextDocument(),
      status: 'draft',
      ...overrides,
    };
  }

  it('creates with a null parent and zero sort order by default', async () => {
    const repo = makeRepository();
    const page = await repo.createPage(pageInput());
    assert.equal(page.parentId, null);
    assert.equal(page.sortOrder, 0);
    assert.ok(Object.isFrozen(page));
  });

  it('keeps page slugs independent of post slugs', async () => {
    const repo = makeRepository();
    await repo.createPost(postInput({ slug: 'shared' }));
    const page = await repo.createPage(pageInput({ slug: 'shared' }));
    assert.equal(page.slug, 'shared');
  });

  it('publishes and unpublishes a page', async () => {
    const repo = makeRepository();
    const page = await repo.createPage(pageInput());

    const published = await repo.publishPage(page.id);
    assert.equal(published.status, 'published');
    const draft = await repo.unpublishPage(page.id);
    assert.equal(draft.status, 'draft');
  });

  it('clears the parent id with an explicit null', async () => {
    const repo = makeRepository();
    const page = await repo.createPage(pageInput({ parentId: 'parent' }));
    const updated = await repo.updatePage(page.id, { parentId: null });
    assert.equal(updated.parentId, null);
  });
});

describe('categories and tags', () => {
  it('creates, lists, updates, and deletes a category', async () => {
    const repo = makeRepository();
    const category = await repo.createCategory({ name: 'News', slug: 'news' });
    assert.equal(category.id, 'id-1');
    assert.deepEqual(await repo.listCategories(), [category]);

    const renamed = await repo.updateCategory(category.id, {
      name: 'Updates',
      slug: 'updates',
      description: 'Changelog posts',
    });
    assert.equal(renamed.name, 'Updates');
    assert.equal(renamed.slug, 'updates');

    await repo.deleteCategory(category.id);
    assert.equal(await repo.getCategory(category.id), undefined);
  });

  it('keeps category and tag slug namespaces independent', async () => {
    const repo = makeRepository();
    const category = await repo.createCategory({ name: 'News', slug: 'news' });
    const tag = await repo.createTag({ name: 'News', slug: 'news' });
    assert.equal(category.slug, tag.slug);
  });

  it('enforces slug uniqueness within a taxonomy collection', async () => {
    const repo = makeRepository();
    await repo.createCategory({ name: 'News', slug: 'news' });
    await rejectsWithCode(
      repo.createCategory({ name: 'Other', slug: 'news' }),
      'slug_conflict',
      'news',
    );
  });
});

describe('settings', () => {
  it('upserts settings by key and lists them', async () => {
    const repo = makeRepository();
    const first = await repo.setSetting('site.title', 'My Blog');
    assert.equal(first.updatedAt, FIXED_NOW.toISOString());

    const second = await repo.setSetting('site.title', 'Renamed');
    assert.equal(second.value, 'Renamed');
    assert.equal((await repo.listSettings()).length, 1);
    assert.deepEqual(await repo.getSetting('site.title'), second);
    assert.equal(await repo.getSetting('missing'), undefined);
  });

  it('rejects a non-JSON-safe value', async () => {
    const repo = makeRepository();
    await rejectsWithCode(repo.setSetting('site.title', new Date() as never), 'invalid_input');
  });

  it('rejects an empty key', async () => {
    const repo = makeRepository();
    await rejectsWithCode(repo.setSetting('', { nested: true }), 'invalid_input');
  });
});

describe('menus', () => {
  const items = [{ label: 'Home', href: '/', sortOrder: 0, children: [] }];

  it('creates, lists, updates, and deletes a menu', async () => {
    const repo = makeRepository();
    const menu = await repo.createMenu({ name: 'Header', location: 'header', items });
    assert.equal(menu.id, 'id-1');
    assert.deepEqual(menu.items, items);
    assert.deepEqual(await repo.listMenus(), [menu]);

    const updated = await repo.updateMenu(menu.id, { location: 'footer' });
    assert.equal(updated.location, 'footer');
    assert.equal(updated.name, 'Header');

    await repo.deleteMenu(menu.id);
    assert.equal(await repo.getMenu(menu.id), undefined);
  });
});

describe('revisions', () => {
  it('appends revisions oldest-first, filtered by entry type and id', async () => {
    const repo = makeRepository();
    const first = await repo.appendRevision({
      entryType: 'post',
      entryId: 'p1',
      snapshot: { title: 'One' },
      authorId: 'a1',
    });
    const second = await repo.appendRevision({
      entryType: 'post',
      entryId: 'p1',
      snapshot: { title: 'Two' },
      authorId: 'a1',
    });

    const listed = await repo.listRevisions('post', 'p1');
    assert.deepEqual(
      [...listed].map((r) => r.id),
      [first.id, second.id],
    );

    assert.deepEqual(await repo.listRevisions('page', 'p1'), []);
    assert.deepEqual(await repo.listRevisions('post', 'other'), []);
  });

  it('rejects a non-JSON-safe snapshot', async () => {
    const repo = makeRepository();
    await rejectsWithCode(
      repo.appendRevision({
        entryType: 'post',
        entryId: 'p1',
        snapshot: new Date() as never,
        authorId: 'a1',
      }),
      'invalid_snapshot',
    );
  });
});
