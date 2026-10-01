/**
 * Tests for the blog body upgrade migration over a real (sql.js) database:
 * a stored version 1 body is unreadable until the migration runs, the
 * migration upgrades post, page and revision bodies and drops the retired
 * snapshot keys, a second run changes nothing, and a body that cannot be
 * upgraded fails the run with its count and row ids, never its content,
 * before anything is written.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { JsailsDataSource } from 'jsails/database';
import type { JsonValue } from 'jsails/plugin-sdk';
import { createEmptyRichTextDocument } from 'jsails/rich-text';
import { createEmptyDataSource } from 'jsails/testing';

import { BlogContentError } from '../../src/cms/index.js';
import {
  JsailsBlogPage,
  JsailsBlogPost,
  JsailsBlogRevision,
  blogEntities,
  blogRichTextUpgrade,
  createDatabaseBlogRepository,
} from '../../src/persistence/index.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'body-upgrade-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const V1_BODY: JsonValue = {
  version: 1,
  blocks: [
    { id: 'b1', type: 'paragraph', text: 'Hello\r\nworld' },
    { id: 'b2', type: 'cta', label: 'Go', href: 'javascript:alert(1)' },
  ],
};

const V2_BODY = {
  version: 2,
  blocks: [
    { type: 'paragraph', content: [{ text: 'Hello\nworld' }] },
    { type: 'paragraph', content: [{ text: 'Go' }] },
  ],
};

/** Overwrite a stored body with raw JSON, bypassing the repository's writer. */
async function storeBody(
  dataSource: JsailsDataSource,
  target: typeof JsailsBlogPost | typeof JsailsBlogPage,
  contentId: string,
  value: unknown,
): Promise<void> {
  const repository = dataSource.getRepository<JsailsBlogPost | JsailsBlogPage>(target);
  const row = await repository.findOneByOrFail({ contentId });
  row.blocks = value;
  await repository.save(row);
}

async function seeded(name: string) {
  const dataSource = await createEmptyDataSource(blogEntities, {
    location: join(tmpRoot, `${name}.db`),
  });
  let sequence = 0;
  const repository = createDatabaseBlogRepository({
    dataSource,
    nextId: () => `id-${(sequence += 1)}`,
  });
  const post = await repository.createPost({
    title: 'Post',
    slug: 'post',
    blocks: createEmptyRichTextDocument(),
    status: 'draft',
    authorId: 'a1',
  });
  const page = await repository.createPage({
    title: 'Page',
    slug: 'page',
    blocks: createEmptyRichTextDocument(),
    status: 'draft',
  });
  await repository.appendRevision({
    entryType: 'post',
    entryId: post.id,
    snapshot: { title: 'Post', blocks: V1_BODY, editor: 'editorjs', native: { blocks: [] } },
    authorId: 'a1',
  });
  await storeBody(dataSource, JsailsBlogPost, post.id, V1_BODY);
  await storeBody(dataSource, JsailsBlogPage, page.id, V1_BODY);
  return { dataSource, repository, postId: post.id, pageId: page.id };
}

async function runUp(dataSource: JsailsDataSource): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    await blogRichTextUpgrade.up({ queryRunner });
  } finally {
    await queryRunner.release();
  }
}

async function stored(dataSource: JsailsDataSource): Promise<unknown[]> {
  return [
    ...(await dataSource.getRepository(JsailsBlogPost).find()).map((row) => row.blocks),
    ...(await dataSource.getRepository(JsailsBlogPage).find()).map((row) => row.blocks),
    ...(await dataSource.getRepository(JsailsBlogRevision).find()).map((row) => row.snapshot),
  ];
}

describe('blogRichTextUpgrade', () => {
  it('leaves a version 1 body unreadable until the migration upgrades it', async () => {
    const { dataSource, repository, postId, pageId } = await seeded('upgrade');

    await assert.rejects(
      repository.getPost(postId),
      (error: unknown) => error instanceof BlogContentError && error.code === 'unreadable_body',
    );

    await runUp(dataSource);

    assert.deepEqual((await repository.getPost(postId))?.blocks, V2_BODY);
    assert.deepEqual((await repository.getPage(pageId))?.blocks, V2_BODY);
    const [revision] = await repository.listRevisions('post', postId);
    assert.deepEqual(revision?.snapshot, { title: 'Post', blocks: V2_BODY });
    await dataSource.destroy();
  });

  it('changes nothing on a second run', async () => {
    const { dataSource } = await seeded('idempotent');
    await runUp(dataSource);
    const once = await stored(dataSource);
    await runUp(dataSource);
    assert.deepEqual(await stored(dataSource), once);
    await dataSource.destroy();
  });

  it('fails with a count and row ids, no content, and writes nothing when a body cannot be upgraded', async () => {
    const { dataSource, postId } = await seeded('refused');
    await storeBody(dataSource, JsailsBlogPost, postId, { version: 1, blocks: 'secret-body' });
    const before = await stored(dataSource);
    const postRows = dataSource.getRepository(JsailsBlogPost);
    const row = await postRows.findOneByOrFail({ contentId: postId });
    const reference = `${postRows.metadata.tableName}#${String(row.id)}`;

    await assert.rejects(
      runUp(dataSource),
      (error: unknown) =>
        error instanceof BlogContentError &&
        error.code === 'unreadable_body' &&
        error.message.startsWith('1 ') &&
        error.message.includes(reference) &&
        !error.message.includes('secret'),
    );
    assert.deepEqual(await stored(dataSource), before);
    await dataSource.destroy();
  });

  it('is a frozen, transactional, one-way data migration', async () => {
    assert.equal(Object.isFrozen(blogRichTextUpgrade), true);
    assert.equal(blogRichTextUpgrade.transactional, true);
    const { dataSource } = await seeded('down');
    const queryRunner = dataSource.createQueryRunner();
    await assert.rejects(
      blogRichTextUpgrade.down({ queryRunner }),
      (error: unknown) => error instanceof BlogContentError,
    );
    await queryRunner.release();
    await dataSource.destroy();
  });
});
