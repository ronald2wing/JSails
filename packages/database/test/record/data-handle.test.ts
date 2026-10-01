/**
 * The model-set handle a gated plugin is given: its owned models read as
 * records and accept writes; its read grants return frozen plain rows and
 * refuse writes and row locks (`data_source.not_granted`); every other model of the data
 * source is out of reach, both directly and through a relation filter
 * (`statement.unknown_table` before any SQL); a model of another data source
 * cannot be named at all.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  createQueryLedger,
  dataHandle,
  JsailsDataSource,
  resolveDatabaseConfig,
  withQueryLedger,
  type DataHandle,
} from '../../src/index.js';
import { column, defineTable } from '../../src/model/index.js';
import { unguarded } from '../../src/unguarded/index.js';
import { createTableStatements } from '../../src/schema/emit.js';
import { declaredTables } from '../../src/schema/declared-tables.js';
import { Author, Comment, MODELS, Post } from '../query/fixtures/query-models.js';

const Elsewhere = defineTable({ table: 'h_elsewhere', columns: { note: column.string(10) } });

describe('dataHandle', () => {
  let dataSource: JsailsDataSource;
  let handle: DataHandle;

  before(async () => {
    dataSource = new JsailsDataSource({
      config: resolveDatabaseConfig({ file: ':memory:' }, { env: {} }),
      models: MODELS,
    });
    const conn = await unguarded(dataSource).lease();
    try {
      for (const table of declaredTables(MODELS, 'sqlite')) {
        for (const statement of createTableStatements(table, 'sqlite')) await conn.query(statement);
      }
    } finally {
      await conn.release();
    }
    const ada = await Author.create({ name: 'ada' });
    const post = await Post.create({ title: 'Owned', authorId: ada.id });
    await Comment.create({ body: 'hidden', postId: post.id });
    handle = dataHandle(dataSource, { models: [Post], read: [Author] });
  });
  after(() => dataSource.close());

  it('reads and writes owned models as records', async () => {
    const [post] = await handle.query(Post).getMany();
    assert.ok(post instanceof Post);
    assert.equal(post.title, 'Owned');
    assert.deepEqual(await handle.insertAll<Post>(Post, [{ title: 'Inserted' }]), { affected: 1 });
    assert.deepEqual(await handle.query(Post).where({ title: 'Inserted' }).deleteAll(), {
      affected: 1,
    });
  });

  it('reads granted models as frozen plain rows and refuses writes to them', async () => {
    const [author] = await handle.read(Author).getMany();
    assert.equal(author?.name, 'ada');
    assert.equal(author instanceof Author, false);
    assert.equal(Object.isFrozen(author), true);
    assert.throws(() => handle.query(Author), {
      code: 'data_source.not_granted',
      context: { model: 'Author', access: 'write' },
    });
    await assert.rejects(() => handle.read(Author).updateAll({ name: 'x' }), {
      code: 'data_source.not_granted',
    });
    await assert.rejects(() => handle.insertAll(Author, [{ name: 'x' }]), {
      code: 'data_source.not_granted',
    });
  });

  it('refuses a row lock through a read grant, in either mode', async () => {
    for (const mode of ['update', 'share'] as const) {
      assert.throws(() => handle.read(Author).lock(mode), {
        code: 'data_source.not_granted',
        context: { model: 'Author', access: 'write' },
      });
      assert.throws(() => handle.read(Post).lock(mode), {
        code: 'data_source.not_granted',
        context: { model: 'Post', access: 'write' },
      });
    }
    await handle.transaction(async () => {
      assert.equal((await handle.query(Post).lock().getMany()).length, 1);
    });
  });

  it('keeps every other model out of reach, relation filters included', async () => {
    assert.throws(() => handle.read(Comment), {
      code: 'data_source.not_granted',
      context: { model: 'Comment', access: 'read' },
    });
    const ledger = createQueryLedger({ detail: true });
    await withQueryLedger(ledger, async () => {
      assert.throws(() => handle.query(Post).whereHas('comments'), {
        code: 'statement.unknown_table',
      });
      assert.deepEqual(
        await handle.query(Post).whereHas<Author>('author', { name: 'ada' }).pluck('title'),
        ['Owned'],
      );
    });
    assert.equal(ledger.count, 1);
  });

  it('refuses models of another data source and malformed grants', () => {
    assert.throws(() => dataHandle(dataSource, { models: [Elsewhere] }), {
      code: 'data_source.not_bound',
    });
    assert.throws(() => dataHandle(dataSource, { models: [{}] }), {
      code: 'data_source.not_a_model',
    });
    assert.throws(() => dataHandle(dataSource, { models: Post as never }), {
      code: 'data_source.invalid_options',
    });
  });
});
