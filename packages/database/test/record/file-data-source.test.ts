/**
 * `FileDataSource`: seeded rows, from code or a JSON file, loaded through
 * `insertAll` into an in-memory SQLite database that is then read-only.
 * Queries and relation filters work over the seed; every write fails with
 * the engine's `read_only`; JSON values for timestamps, big integers and
 * bytes are read in their text forms; a read-only transaction leaves it
 * read-only; a malformed seed is refused naming only the model and the
 * field, and binds nothing.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { FileDataSource, query, transaction } from '../../src/index.js';
import { column, defineTable } from '../../src/model/index.js';
import { Author, Post } from '../query/fixtures/query-models.js';

const Sample = defineTable({
  table: 'f_samples',
  columns: {
    at: column.timestamp(),
    big: column.bigint(),
    bytes: column.binary(),
  },
});

describe('FileDataSource', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jsails-file-ds-'));
  after(() => rmSync(directory, { recursive: true, force: true }));

  it('serves seeded rows read-only', async () => {
    writeFileSync(
      join(directory, 'posts.json'),
      JSON.stringify([
        {
          id: 1,
          title: 'Seeded',
          status: 'live',
          authorId: 1,
          publishedAt: '2024-05-01T12:00:00.000Z',
        },
        { id: 2, title: 'Second', authorId: 2 },
      ]),
    );
    const dataSource = await FileDataSource.open({
      root: directory,
      models: [
        {
          model: Author,
          rows: [
            { id: 1, name: 'ada' },
            { id: 2, name: 'bob' },
          ],
        },
        { model: Post, file: 'posts.json' },
      ],
    });
    try {
      assert.deepEqual(await Post.all().orderBy('id').pluck('title'), ['Seeded', 'Second']);
      const seeded = await Post.find(1);
      assert.deepEqual(seeded.publishedAt, new Date('2024-05-01T12:00:00.000Z'));
      assert.equal(seeded.status, 'live');
      assert.equal((await Post.find(2)).status, 'draft');
      assert.deepEqual(
        await Post.all().whereHas<Author>('author', { name: 'bob' }).pluck('title'),
        ['Second'],
      );
      seeded.title = 'Changed';
      await assert.rejects(() => seeded.save(), { code: 'read_only' });
      await assert.rejects(() => Author.create({ name: 'cy' }), { code: 'read_only' });
      await assert.rejects(() => Post.all().deleteAll(), { code: 'read_only' });
      assert.equal(await Post.all().count(), 2);
    } finally {
      await dataSource.close();
    }
    assert.throws(() => Post.all(), { code: 'data_source.not_bound' });
  });

  it('stays read-only after a read-only transaction', async () => {
    const dataSource = await FileDataSource.open({
      models: [{ model: Author, rows: [{ id: 1, name: 'ada' }] }],
    });
    try {
      await assert.rejects(() => Author.create({ name: 'x' }), { code: 'read_only' });
      assert.equal(
        await transaction(dataSource, () => Author.all().count(), { readOnly: true }),
        1,
      );
      await assert.rejects(() => Author.create({ name: 'y' }), { code: 'read_only' });
      await assert.rejects(() => dataSource.transaction(() => Author.create({ name: 'z' })), {
        code: 'read_only',
      });
      await assert.rejects(() => Author.all().updateAll({ name: 'w' }), { code: 'read_only' });
      assert.deepEqual(await Author.all().pluck('name'), ['ada']);
    } finally {
      await dataSource.close();
    }
  });

  it('reads timestamps, big integers and bytes from their JSON text forms', async () => {
    writeFileSync(
      join(directory, 'samples.json'),
      JSON.stringify([{ at: '2024-01-02T03:04:05.006Z', big: '9007199254740993', bytes: 'AQID' }]),
    );
    const dataSource = await FileDataSource.open({
      root: directory,
      models: [{ model: Sample, file: 'samples.json' }],
    });
    try {
      const [row] = await query<{ at: Date; big: bigint; bytes: Uint8Array }>(Sample).getMany();
      assert.deepEqual(row?.at, new Date('2024-01-02T03:04:05.006Z'));
      assert.equal(row?.big, 9007199254740993n);
      assert.deepEqual([...(row?.bytes ?? [])], [1, 2, 3]);
    } finally {
      await dataSource.close();
    }
  });

  it('refuses malformed seeds, naming only the model and field, and binds nothing', async () => {
    writeFileSync(join(directory, 'broken.json'), '{ "secret": ');
    writeFileSync(join(directory, 'object.json'), '{ "id": 1 }');
    writeFileSync(
      join(directory, 'bad-date.json'),
      JSON.stringify([{ at: 'yesterday', big: 1, bytes: '' }]),
    );
    const cases = [
      { file: 'broken.json', model: Post, field: 'Post.file' },
      { file: 'object.json', model: Post, field: 'Post.file' },
      { file: 'missing.json', model: Post, field: 'Post.file' },
      { file: 'bad-date.json', model: Sample, field: 'f_samples.rows' },
    ];
    for (const { file, model, field } of cases) {
      await assert.rejects(
        () => FileDataSource.open({ root: directory, models: [{ model, file }] }),
        (error: Error & { code?: string; context?: unknown }) => {
          assert.equal(error.code, 'data_source.invalid_options');
          assert.deepEqual(error.context, { field });
          assert.doesNotMatch(error.message, /secret|yesterday|broken/);
          return true;
        },
      );
    }
    await assert.rejects(() => FileDataSource.open({ models: 'x' as never }), {
      code: 'data_source.invalid_options',
    });
    assert.throws(() => Post.all(), { code: 'data_source.not_bound' });
  });
});
