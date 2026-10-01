/**
 * The database-backed content repository is exercised against a real on-disk
 * sql.js database (the actual WASM build TypeORM loads internally), with the
 * `jsails_blog_content_*` tables created by the declarative schema plan — never
 * by runtime DDL. Covers the portable schema the entities produce, repository
 * round-trips (mapping, slug conflict, publish transitions, revisions,
 * settings), and fail-closed behavior on a missing table.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { applyOperations, diffSchemaStates } from 'jsails';
import { JsailsDataSource } from 'jsails/database';
import { createEmptyDataSource } from 'jsails/testing';
import { createEmptyRichTextDocument } from '@jsails/editor';
import {
  CONTENT_POST_TABLE,
  ContentError,
  ContentPersistenceError,
  createDatabaseContentRepository,
  contentEntities,
  type DatabaseContentRepositoryOptions,
} from '@jsails/blog';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'content-db-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a repository over a ready data source with deterministic ids/timestamps. */
function makeRepository(
  dataSource: JsailsDataSource,
  overrides: Partial<DatabaseContentRepositoryOptions> = {},
) {
  let sequence = 0;
  return createDatabaseContentRepository({
    dataSource,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    nextId: () => `id-${(sequence += 1)}`,
    ...overrides,
  });
}

const FIXED_ISO = '2026-01-01T00:00:00.000Z';

/** Assert a call rejects with a value-free ContentError of the given code. */
async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<ContentError> {
  let captured: ContentError | undefined;
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ContentError);
    captured = err;
    return true;
  });
  assert.ok(captured !== undefined);
  assert.equal(captured.code, code);
  return captured;
}

describe('content entities: portable schema and migration', () => {
  it('builds a schema with one table per content entity, offline', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'schema.db'),
      entities: contentEntities,
    });
    const schema = await dataSource.getModelSchema();

    assert.equal(dataSource.isInitialized, false);
    const names = schema.tables.map((table) => table.name).sort();
    assert.deepEqual(names, [
      'jsails_blog_content_category',
      'jsails_blog_content_menu',
      'jsails_blog_content_page',
      'jsails_blog_content_post',
      'jsails_blog_content_revision',
      'jsails_blog_content_setting',
      'jsails_blog_content_tag',
    ]);
  });

  it('maps json columns and keeps the generated integer primary key', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'shape.db'),
      entities: contentEntities,
    });
    const schema = await dataSource.getModelSchema();
    const post = schema.tables.find((table) => table.name === CONTENT_POST_TABLE);
    assert.ok(post, 'expected the content post table');

    const byName = new Map(post.columns.map((column) => [column.name, column]));
    assert.deepEqual(byName.get('id'), {
      name: 'id',
      type: 'integer',
      nullable: false,
      primaryKey: true,
    });
    assert.equal(byName.get('blocks')?.type, 'json');
    assert.equal(byName.get('categoryIds')?.type, 'json');
    assert.equal(byName.get('tagIds')?.type, 'json');
    assert.equal(byName.get('slug')?.type, 'varchar');
  });

  it('emits create_table operations that round-trip through applyOperations', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'migration.db'),
      entities: contentEntities,
    });
    const schema = await dataSource.getModelSchema();
    const operations = diffSchemaStates({ tables: [] }, schema);

    assert.equal(operations.length, contentEntities.length);
    assert.ok(operations.every((operation) => operation.kind === 'create_table'));

    assert.deepEqual(applyOperations({ tables: [] }, operations), schema);
  });

  it('creates the tables via the declarative plan for the round-trip harness', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'ready.db'),
    });
    const repository = dataSource.getRepository(contentEntities[0]!);
    // The post table exists and is queryable.
    assert.equal(await repository.count(), 0);
    await dataSource.destroy();
  });
});

describe('createDatabaseContentRepository: mapping and round-trip', () => {
  it('creates a draft post with JSON blocks and lists it back with string ids', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'post-roundtrip.db'),
    });
    const repo = makeRepository(dataSource);

    const post = await repo.createPost({
      title: 'Hello',
      slug: 'hello',
      blocks: createEmptyRichTextDocument(),
      status: 'draft',
      authorId: 'a1',
      categoryIds: ['c1', 'c2'],
      tagIds: ['t1'],
    });

    assert.equal(post.id, 'id-1');
    assert.equal(post.status, 'draft');
    assert.equal(post.createdAt, FIXED_ISO);
    assert.equal(post.publishedAt, null);
    assert.deepEqual(post.categoryIds, ['c1', 'c2']);
    assert.deepEqual(post.tagIds, ['t1']);

    const listed = await repo.listPosts();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], post);
    assert.deepEqual(await repo.getPost(post.id), post);

    await dataSource.destroy();
  });

  it('stamps publishedAt when a post is created published', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'post-published.db'),
    });
    const repo = makeRepository(dataSource);

    const post = await repo.createPost({
      title: 'Live',
      slug: 'live',
      blocks: { version: 1, blocks: [] },
      status: 'published',
      authorId: 'a1',
    });
    assert.equal(post.publishedAt, FIXED_ISO);

    await dataSource.destroy();
  });

  it('round-trips categories and tags with optional descriptions', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'taxonomy.db'),
    });
    const repo = makeRepository(dataSource);

    const withDescription = await repo.createCategory({
      name: 'News',
      slug: 'news',
      description: 'Announcements',
    });
    const withoutDescription = await repo.createTag({ name: 'News', slug: 'news' });

    assert.equal(withDescription.description, 'Announcements');
    assert.equal(withoutDescription.description, undefined);

    assert.deepEqual(
      (await repo.listCategories()).map((c) => c.name),
      ['News'],
    );
    assert.deepEqual((await repo.getTag(withoutDescription.id))?.name, 'News');

    const renamed = await repo.updateCategory(withDescription.id, {
      name: 'Updates',
      slug: 'updates',
    });
    assert.equal(renamed.description, 'Announcements');

    await dataSource.destroy();
  });

  it('round-trips a menu with nested items', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'menu.db'),
    });
    const repo = makeRepository(dataSource);

    const items = [
      { label: 'Home', href: '/', sortOrder: 0, children: [] },
      { label: 'About', href: '/about', sortOrder: 1, children: [] },
    ];
    const menu = await repo.createMenu({ name: 'Header', location: 'header', items });

    assert.equal(menu.id, 'id-1');
    assert.deepEqual(menu.items, items);
    assert.deepEqual(await repo.getMenu(menu.id), menu);

    const updated = await repo.updateMenu(menu.id, { location: 'footer' });
    assert.equal(updated.location, 'footer');

    await dataSource.destroy();
  });
});

describe('createDatabaseContentRepository: slug conflict', () => {
  it('rejects a duplicate post slug value-free', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'slug.db'),
    });
    const repo = makeRepository(dataSource);

    await repo.createPost({
      title: 'First',
      slug: 'shared',
      blocks: createEmptyRichTextDocument(),
      status: 'draft',
      authorId: 'a1',
    });
    await rejectsWithCode(
      repo.createPost({
        title: 'Second',
        slug: 'shared',
        blocks: createEmptyRichTextDocument(),
        status: 'draft',
        authorId: 'a1',
      }),
      'slug_conflict',
    );

    await dataSource.destroy();
  });

  it('keeps post and page slug namespaces independent', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'slug-ns.db'),
    });
    const repo = makeRepository(dataSource);

    await repo.createPost({
      title: 'P',
      slug: 'shared',
      blocks: createEmptyRichTextDocument(),
      status: 'draft',
      authorId: 'a1',
    });
    const page = await repo.createPage({
      title: 'Page',
      slug: 'shared',
      blocks: createEmptyRichTextDocument(),
      status: 'draft',
    });
    assert.equal(page.slug, 'shared');

    await dataSource.destroy();
  });
});

describe('createDatabaseContentRepository: publish transitions', () => {
  it('publishes a draft and unpublishes back, preserving publishedAt', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'transition.db'),
    });
    const repo = makeRepository(dataSource);

    const draft = await repo.createPost({
      title: 'D',
      slug: 'd',
      blocks: createEmptyRichTextDocument(),
      status: 'draft',
      authorId: 'a1',
    });
    const published = await repo.publishPost(draft.id);
    assert.equal(published.status, 'published');
    assert.equal(published.publishedAt, FIXED_ISO);

    const unpublished = await repo.unpublishPost(draft.id);
    assert.equal(unpublished.status, 'draft');
    assert.equal(unpublished.publishedAt, FIXED_ISO);

    await dataSource.destroy();
  });

  it('publish and unpublish are idempotent for their target states', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'transition-idem.db'),
    });
    const repo = makeRepository(dataSource);

    const published = await repo.createPost({
      title: 'Live',
      slug: 'live',
      blocks: createEmptyRichTextDocument(),
      status: 'published',
      authorId: 'a1',
    });
    assert.equal((await repo.publishPost(published.id)).publishedAt, FIXED_ISO);

    const draft = await repo.createPost({
      title: 'Draft',
      slug: 'draft',
      blocks: createEmptyRichTextDocument(),
      status: 'draft',
      authorId: 'a1',
    });
    assert.equal((await repo.unpublishPost(draft.id)).status, 'draft');

    await dataSource.destroy();
  });

  it('rejects an archived status at create time', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'transition-archived.db'),
    });
    const repo = makeRepository(dataSource);

    await rejectsWithCode(
      repo.createPost({
        title: 'A',
        slug: 'a',
        blocks: createEmptyRichTextDocument(),
        status: 'archived',
        authorId: 'a1',
      }),
      'invalid_status',
    );

    await dataSource.destroy();
  });
});

describe('createDatabaseContentRepository: revisions', () => {
  it('appends revisions oldest-first, filtered by entry type and id', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'revision.db'),
    });
    const repo = makeRepository(dataSource);

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

    await dataSource.destroy();
  });

  it('rejects a non-JSON-safe snapshot', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'revision-invalid.db'),
    });
    const repo = makeRepository(dataSource);

    await rejectsWithCode(
      repo.appendRevision({
        entryType: 'post',
        entryId: 'p1',
        snapshot: new Date() as never,
        authorId: 'a1',
      }),
      'invalid_snapshot',
    );

    await dataSource.destroy();
  });
});

describe('createDatabaseContentRepository: settings', () => {
  it('upserts settings by key and lists them', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'setting.db'),
    });
    const repo = makeRepository(dataSource);

    const first = await repo.setSetting('site.title', 'My Blog');
    assert.equal(first.updatedAt, FIXED_ISO);

    const second = await repo.setSetting('site.title', { nested: { value: 42 } });
    assert.deepEqual(second.value, { nested: { value: 42 } });

    assert.equal((await repo.listSettings()).length, 1);
    assert.deepEqual(await repo.getSetting('site.title'), second);
    assert.equal(await repo.getSetting('missing'), undefined);

    await dataSource.destroy();
  });

  it('rejects a non-JSON-safe value and an empty key', async () => {
    const dataSource = await createEmptyDataSource(contentEntities, {
      location: join(tmpRoot, 'setting-invalid.db'),
    });
    const repo = makeRepository(dataSource);

    await rejectsWithCode(repo.setSetting('site.title', new Date() as never), 'invalid_input');
    await rejectsWithCode(repo.setSetting('', true), 'invalid_input');

    assert.equal((await repo.listSettings()).length, 0);

    await dataSource.destroy();
  });
});

describe('createDatabaseContentRepository: missing table', () => {
  it('fails with a clear error when the tables were never migrated', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'missing.db'),
      entities: contentEntities,
    });
    await dataSource.initialize();

    const repo = makeRepository(dataSource);
    await assert.rejects(
      async () => repo.listPosts(),
      (err: unknown) => err instanceof ContentPersistenceError && /db:push/.test(err.message),
    );
    await assert.rejects(
      async () =>
        repo.createPost({
          title: 'x',
          slug: 'x',
          blocks: createEmptyRichTextDocument(),
          status: 'draft',
          authorId: 'a1',
        }),
      (err: unknown) => err instanceof ContentPersistenceError && /db:push/.test(err.message),
    );

    await dataSource.destroy();
  });

  it('auto-initializes an uninitialized data source on first use', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'autoinit.db'),
      entities: contentEntities,
    });
    assert.equal(dataSource.isInitialized, false);

    const repo = makeRepository(dataSource);
    await assert.rejects(
      async () => repo.listPosts(),
      (err: unknown) => err instanceof ContentPersistenceError,
    );
    assert.equal(dataSource.isInitialized, true);

    await dataSource.destroy();
  });
});

describe('createDatabaseContentRepository: options', () => {
  it('rejects missing or invalid construction options', () => {
    assert.throws(() => createDatabaseContentRepository({}), TypeError);
    assert.throws(
      () => createDatabaseContentRepository({ getDataSource: 'nope' as never }),
      TypeError,
    );
  });
});
