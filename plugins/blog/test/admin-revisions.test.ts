import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from 'jsails';
import {
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
  type AdminPlugin,
} from '@jsails/admin';
import { blogAdmin, createContentRepository, type ContentRepository } from '@jsails/blog';

/**
 * Tests for the blog admin revisions page. The page is exercised through its
 * descriptor (registered by `blogAdmin`): `render`/`handleGet`/`handlePost` are
 * invoked directly with hand-built contexts (a fixed `Session`, a stub
 * `Request`, and a `URL`), so the list/restore contract is covered without a
 * live panel, database, or HTTP server. Revision recording on update is covered
 * alongside the posts/pages resources in `admin-resource.test.ts`.
 */

const session: Session = { id: 's', csrfToken: 't', data: {}, expiresAt: 0 };

/** Build a `URL` for the given pathname (base path is ignored by the page). */
function makeUrl(pathname: string): URL {
  return new URL(pathname, 'http://localhost');
}

/** Build a `GET` render context with the given base path and query URL. */
function renderContext(path: string, url: URL): AdminPageRenderContext {
  return {
    session,
    path,
    request: new Request(url),
    url,
  };
}

/** Build a `POST` context with a string-only form body. */
function postContext(path: string, url: URL, body: Record<string, string>): AdminPagePostContext {
  return { ...renderContext(path, url), body };
}

/** Capture the revisions page from the plugin's contributions. */
function revisionsPage(repository: ContentRepository): AdminPage {
  const plugin: AdminPlugin = blogAdmin({ repository });
  let captured: AdminPage | undefined;
  plugin.register({
    addPage(page) {
      if (page.slug === 'revisions') {
        captured = page;
      }
    },
    addNavigationItem() {},
    addResource() {},
  });
  assert.ok(captured, 'blog must register the revisions page');
  return captured;
}

/** Create a post and record one revision against it, returning the post id. */
async function seedPost(repository: ContentRepository): Promise<string> {
  const post = await repository.createPost({
    title: 'First',
    slug: 'first',
    excerpt: '',
    blocks: { version: 1, blocks: [] },
    status: 'draft',
    authorId: 'a1',
  });
  await repository.appendRevision({
    entryType: 'post',
    entryId: post.id,
    snapshot: {
      title: 'First',
      slug: 'first',
      excerpt: '',
      blocks: { version: 1, blocks: [] },
      categoryIds: [],
      tagIds: [],
      featuredMediaId: null,
    },
    authorId: 'a1',
  });
  return post.id;
}

/** A post id that does not correspond to any entry. */
const MISSING_ID = 'does-not-exist';

describe('blog admin revisions page', () => {
  it('registers a revisions page with slug, label, and group', () => {
    const page = revisionsPage(createContentRepository());
    assert.equal(page.slug, 'revisions');
    assert.equal(page.label, 'Revisions');
    assert.equal(page.group, 'Content');
    assert.equal(typeof page.render, 'function');
    assert.equal(typeof page.handleGet, 'function');
    assert.equal(typeof page.handlePost, 'function');
  });

  it('renders the lookup form when no entry is selected', async () => {
    const page = revisionsPage(createContentRepository());
    const html = await page.render(renderContext('/admin', makeUrl('/admin/revisions')));
    assert.match(html, /Entry type/);
    assert.match(html, /Entry id/);
    assert.match(html, /Choose an entry to list its revisions\./);
  });

  it('lists revisions newest-first with a restore action per revision', async () => {
    const repository = createContentRepository();
    const page = revisionsPage(repository);
    const entryId = await seedPost(repository);
    await repository.appendRevision({
      entryType: 'post',
      entryId,
      snapshot: {
        title: 'Second',
        slug: 'first',
        excerpt: '',
        blocks: { version: 1, blocks: [] },
        categoryIds: [],
        tagIds: [],
        featuredMediaId: null,
      },
      authorId: 'a1',
    });

    const html = await page.render(
      renderContext('/admin', makeUrl(`/admin/revisions?entryType=post&entryId=${entryId}`)),
    );

    assert.match(html, /Revisions/);
    assert.match(html, /Restore/);
    // The newest revision ("Second") is listed before the older one.
    const secondIndex = html.indexOf('Second');
    const firstIndex = html.indexOf('First');
    assert.ok(secondIndex >= 0 && firstIndex >= 0 && secondIndex < firstIndex);
  });

  it('renders an empty state for an entry with no revisions', async () => {
    const repository = createContentRepository();
    const post = await repository.createPost({
      title: 'No revisions',
      slug: 'no-revisions',
      status: 'draft',
      authorId: 'a1',
      blocks: { version: 1, blocks: [] },
    });
    const page = revisionsPage(repository);

    const html = await page.render(
      renderContext('/admin', makeUrl(`/admin/revisions?entryType=post&entryId=${post.id}`)),
    );
    assert.match(html, /No revisions recorded for this entry\./);
  });

  it('rejects an unknown entry type with a value-free 400', async () => {
    const page = revisionsPage(createContentRepository());
    const response = await page.handleGet!(
      renderContext('/admin', makeUrl(`/admin/revisions?entryType=notatype&entryId=${MISSING_ID}`)),
    );
    assert.equal(response?.status, 400);
    assert.doesNotMatch(await response.text(), /notatype/);
  });

  it('rejects an unknown entry id with a value-free 404', async () => {
    const page = revisionsPage(createContentRepository());
    const response = await page.handleGet!(
      renderContext('/admin', makeUrl(`/admin/revisions?entryType=post&entryId=${MISSING_ID}`)),
    );
    assert.equal(response?.status, 404);
    assert.doesNotMatch(await response.text(), new RegExp(MISSING_ID));
  });

  it('restores a valid snapshot onto the entry and redirects with a notice', async () => {
    const repository = createContentRepository();
    const post = await repository.createPost({
      title: 'Original',
      slug: 'original',
      blocks: { version: 1, blocks: [] },
      status: 'draft',
      authorId: 'a1',
    });
    const revision = await repository.appendRevision({
      entryType: 'post',
      entryId: post.id,
      snapshot: {
        title: 'Restored title',
        slug: 'restored-slug',
        excerpt: 'Recovered.',
        blocks: { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text: 'Back.' }] },
        categoryIds: [],
        tagIds: [],
        featuredMediaId: null,
      },
      authorId: 'a1',
    });
    const page = revisionsPage(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/revisions'), {
        action: 'restore',
        entryType: 'post',
        entryId: post.id,
        revisionId: revision.id,
        _csrf: 't',
      }),
    );

    assert.equal(response.status, 303);
    assert.match(response.headers.get('location') ?? '', /notice=restored/);

    const restored = await repository.getPost(post.id);
    assert.ok(restored);
    assert.equal(restored.title, 'Restored title');
    assert.equal(restored.slug, 'restored-slug');
    assert.equal(restored.excerpt, 'Recovered.');
    assert.deepEqual(restored.blocks.blocks, [{ id: 'b1', type: 'paragraph', text: 'Back.' }]);
  });

  it('rejects an invalid snapshot with a value-free 400', async () => {
    const repository = createContentRepository();
    const post = await repository.createPost({
      title: 'Original',
      slug: 'original',
      blocks: { version: 1, blocks: [] },
      status: 'draft',
      authorId: 'a1',
    });
    const revision = await repository.appendRevision({
      entryType: 'post',
      entryId: post.id,
      snapshot: { title: 12345, slug: 'x' },
      authorId: 'a1',
    });
    const page = revisionsPage(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/revisions'), {
        action: 'restore',
        entryType: 'post',
        entryId: post.id,
        revisionId: revision.id,
        _csrf: 't',
      }),
    );

    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /12345/);
    // The entry is unchanged by the rejected restore.
    const unchanged = await repository.getPost(post.id);
    assert.equal(unchanged?.title, 'Original');
  });

  it('rejects an unknown revision id with a value-free 404', async () => {
    const repository = createContentRepository();
    const post = await repository.createPost({
      title: 'Original',
      slug: 'original',
      blocks: { version: 1, blocks: [] },
      status: 'draft',
      authorId: 'a1',
    });
    const page = revisionsPage(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/revisions'), {
        action: 'restore',
        entryType: 'post',
        entryId: post.id,
        revisionId: MISSING_ID,
        _csrf: 't',
      }),
    );

    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), new RegExp(MISSING_ID));
  });

  it('rejects an unknown action with a value-free 400', async () => {
    const repository = createContentRepository();
    const post = await repository.createPost({
      title: 'Original',
      slug: 'original',
      blocks: { version: 1, blocks: [] },
      status: 'draft',
      authorId: 'a1',
    });
    const page = revisionsPage(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/revisions'), {
        action: 'delete',
        entryType: 'post',
        entryId: post.id,
        revisionId: 'r1',
        _csrf: 't',
      }),
    );

    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /delete/);
  });

  it('does not restore a snapshot into a different entry type', async () => {
    const repository = createContentRepository();
    const post = await repository.createPost({
      title: 'Post',
      slug: 'post',
      blocks: { version: 1, blocks: [] },
      status: 'draft',
      authorId: 'a1',
    });
    const pageEntity = await repository.createPage({
      title: 'Page',
      slug: 'page',
      blocks: { version: 1, blocks: [] },
      status: 'draft',
    });
    // Record the post revision, then ask to restore it against the page.
    const revision = await repository.appendRevision({
      entryType: 'post',
      entryId: post.id,
      snapshot: {
        title: 'Taken over',
        slug: 'taken-over',
        excerpt: '',
        blocks: { version: 1, blocks: [] },
        categoryIds: [],
        tagIds: [],
        featuredMediaId: null,
      },
      authorId: 'a1',
    });
    const page = revisionsPage(repository);

    const response = await page.handlePost!(
      postContext('/admin', makeUrl('/admin/revisions'), {
        action: 'restore',
        entryType: 'page',
        entryId: pageEntity.id,
        revisionId: revision.id,
        _csrf: 't',
      }),
    );

    // The revision does not exist in the page scope, so the restore 404s and
    // the page is untouched.
    assert.equal(response.status, 404);
    const unchanged = await repository.getPage(pageEntity.id);
    assert.equal(unchanged?.title, 'Page');
  });
});
