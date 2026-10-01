/**
 * Database-backed {@link MediaIndex} tests.
 *
 * The index is exercised against a real on-disk sql.js database (the actual
 * WASM build TypeORM loads internally), with the `jsails_media_asset` table
 * created by the declarative schema plan — never by runtime DDL. A second data
 * source that skips the migration exercises the missing-table failure path.
 *
 * Covered:
 *
 * - `put`/`get` round trip across every {@link MediaAsset} field (width/height
 *   presence, ISO timestamp round-trip through the `datetime` columns);
 * - `list()` insertion-order preservation via `createdAt ASC, id ASC`;
 * - `put` overwriting an existing id (upsert);
 * - `remove` deleting a row and being a no-op on a missing id;
 * - a value-free `disk_failed` `MediaError` pointing at `db:push` when the
 *   table does not exist.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { JsailsDataSource } from 'jsails/database';
import { diffSchemaStates, executeSchemaPlan } from 'jsails';

import {
  MediaError,
  createDatabaseMediaIndex,
  JsailsMediaAsset,
  mediaEntities,
  type MediaAsset,
} from '../../src/index.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'media-'));
let sequence = 0;

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Initialize a file-backed data source and apply the entity schema, or skip the plan. */
async function dataSource(migrate: boolean): Promise<JsailsDataSource> {
  const source = new JsailsDataSource({
    type: 'sqljs',
    location: join(tmpRoot, `media-${(sequence += 1)}.db`),
    entities: [JsailsMediaAsset],
  });
  await source.initialize();
  if (migrate) {
    const schema = await source.getModelSchema();
    const operations = diffSchemaStates({ tables: [] }, schema);
    await executeSchemaPlan(source, operations);
  }
  return source;
}

/** A well-formed asset descriptor for round-trip tests. */
function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1',
    disk: 'uploads',
    path: 'media/asset-1/hero.png',
    filename: 'hero.png',
    mimeType: 'image/png',
    size: 1234,
    width: 1200,
    height: 630,
    alt: 'A hero image',
    caption: 'The header banner',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('createDatabaseMediaIndex', () => {
  it('rejects construction without a data source', () => {
    assert.throws(() => createDatabaseMediaIndex({}), TypeError);
  });

  it('returns undefined for get and an empty list on an empty table', async () => {
    const source = await dataSource(true);
    const index = createDatabaseMediaIndex({ dataSource: source });

    assert.deepEqual(await index.list(), []);
    assert.equal(await index.get('missing'), undefined);
  });

  it('put/get round-trips every field, including optional dimensions and timestamps', async () => {
    const source = await dataSource(true);
    const index = createDatabaseMediaIndex({ dataSource: source });

    await index.put(asset());
    const fetched = await index.get('asset-1');

    assert.deepEqual(fetched, asset());
  });

  it('put round-trips an asset without optional width/height', async () => {
    const source = await dataSource(true);
    const index = createDatabaseMediaIndex({ dataSource: source });

    const bare: MediaAsset = {
      id: 'asset-1',
      disk: 'uploads',
      path: 'media/asset-1/hero.png',
      filename: 'hero.png',
      mimeType: 'image/png',
      size: 1234,
      alt: 'A hero image',
      caption: 'The header banner',
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    };
    await index.put(bare);
    assert.deepEqual(await index.get('asset-1'), bare);
  });

  it('list preserves insertion order by createdAt then id', async () => {
    const source = await dataSource(true);
    const index = createDatabaseMediaIndex({ dataSource: source });

    await index.put(asset({ id: 'b', createdAt: '2026-10-20T00:00:00.000Z' }));
    await index.put(asset({ id: 'c', createdAt: '2026-10-18T00:00:00.000Z' }));
    await index.put(asset({ id: 'a', createdAt: '2026-10-20T00:00:00.000Z' }));

    const ordered = await index.list();
    assert.deepEqual(
      ordered.map((entry: MediaAsset) => entry.id),
      ['c', 'a', 'b'],
    );
  });

  it('put is an upsert, replacing an existing id rather than duplicating', async () => {
    const source = await dataSource(true);
    const index = createDatabaseMediaIndex({ dataSource: source });

    await index.put(asset({ alt: 'original' }));
    await index.put(asset({ alt: 'replaced', updatedAt: '2026-10-20T01:00:00.000Z' }));

    const listed = await index.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.alt, 'replaced');
    assert.equal(listed[0]?.updatedAt, '2026-10-20T01:00:00.000Z');
  });

  it('remove deletes a row and is a no-op when the id is absent', async () => {
    const source = await dataSource(true);
    const index = createDatabaseMediaIndex({ dataSource: source });

    await index.put(asset());
    await index.remove('asset-1');
    assert.equal(await index.get('asset-1'), undefined);
    assert.deepEqual(await index.list(), []);

    await index.remove('asset-1');
  });

  it('fails value-free when the table does not exist, pointing at db:push', async () => {
    const source = await dataSource(false);
    const index = createDatabaseMediaIndex({ dataSource: source });

    await assert.rejects(
      index.put(asset()),
      (error: unknown) =>
        error instanceof MediaError &&
        error.code === 'disk_failed' &&
        /db:push/.test(error.message),
    );
  });

  it('initializes a lazily-resolved data source on first use', async () => {
    const location = join(tmpRoot, `media-lazy-${(sequence += 1)}.db`);

    // Prepare the schema on a first source over the shared file, then close it.
    const seeder = new JsailsDataSource({
      type: 'sqljs',
      location,
      entities: [JsailsMediaAsset],
    });
    await seeder.initialize();
    await executeSchemaPlan(
      seeder,
      diffSchemaStates({ tables: [] }, await seeder.getModelSchema()),
    );
    await seeder.destroy();

    // A fresh, un-initialized source over the same file, resolved lazily.
    const lazy = new JsailsDataSource({
      type: 'sqljs',
      location,
      entities: [JsailsMediaAsset],
    });
    const index = createDatabaseMediaIndex({ getDataSource: () => lazy });

    await index.put(asset({ id: 'lazy-id' }));
    assert.equal(lazy.isInitialized, true, 'the lazy source is initialized before use');
    assert.equal((await index.get('lazy-id'))?.id, 'lazy-id');
  });

  it('reports an uninitialized data source value-free', async () => {
    const uninitialized = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, `media-uni-${(sequence += 1)}.db`),
      entities: [JsailsMediaAsset],
    });
    const index = createDatabaseMediaIndex({ dataSource: uninitialized });

    await assert.rejects(
      index.put(asset()),
      (error: unknown) => error instanceof MediaError && error.code === 'disk_failed',
    );
  });

  it('exposes the single media entity in mediaEntities', () => {
    assert.deepEqual(mediaEntities, [JsailsMediaAsset]);
  });

  it('produces the expected portable schema offline', async () => {
    const source = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, `media-schema-${(sequence += 1)}.db`),
      entities: [JsailsMediaAsset],
    });
    const schema = await source.getModelSchema();

    assert.equal(schema.tables.length, 1);
    const table = schema.tables[0];
    assert.ok(table);
    assert.equal(table.name, 'jsails_media_asset');

    // Column order is not deterministic; compare by name.
    const byName = new Map((table.columns ?? []).map((column) => [column.name, column]));
    const columns = {
      id: { type: 'integer', nullable: false, primaryKey: true },
      assetId: { type: 'varchar', length: 190, nullable: false },
      disk: { type: 'varchar', length: 190, nullable: false },
      path: { type: 'varchar', length: 1024, nullable: false },
      filename: { type: 'varchar', length: 255, nullable: false },
      mimeType: { type: 'varchar', length: 190, nullable: false },
      size: { type: 'integer', nullable: false },
      width: { type: 'integer', nullable: true },
      height: { type: 'integer', nullable: true },
      alt: { type: 'text', nullable: false },
      caption: { type: 'text', nullable: false },
      createdAt: { type: 'datetime', nullable: false },
      updatedAt: { type: 'datetime', nullable: false },
    } as const;

    assert.equal(byName.size, Object.keys(columns).length);
    for (const [name, expected] of Object.entries(columns)) {
      const column = byName.get(name);
      assert.ok(column, `expected column ${name}`);
      assert.deepEqual(
        {
          name: column.name,
          type: column.type,
          ...(column.length === undefined ? {} : { length: column.length }),
          nullable: column.nullable,
          ...(column.primaryKey === undefined ? {} : { primaryKey: column.primaryKey }),
        },
        { name, ...expected },
      );
    }

    assert.deepEqual(table.uniques, [
      { name: 'UQ_jsails_media_asset_assetId', columns: ['assetId'] },
    ]);
  });
});
