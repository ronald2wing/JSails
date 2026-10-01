/**
 * Database-backed {@link MediaIndex}.
 *
 * {@link createDatabaseMediaIndex} persists media metadata in the
 * framework-owned `jsails_media_asset` table through the injected TypeORM
 * `DataSource`'s repository — no raw SQL and no runtime DDL. The table must
 * already exist: an app includes {@link mediaEntities} in its `JsailsDataSource`
 * entities and creates the table through the normal declarative schema history
 * (`db:push`). A missing table fails with a value-free {@link MediaLibraryError}
 * (`missing_table`) telling the caller to run that command; the index never
 * creates it. A data source handed in directly must already be initialized
 * (`not_initialized` otherwise); a lazily resolved one is initialized on first
 * use, so an app config can construct the source without connecting.
 *
 * Timestamps round-trip across the persistence boundary: the {@link MediaAsset}
 * descriptor carries ISO-8601 strings (set by the library's clock), while the
 * entity stores `Date` columns. `put` is an upsert keyed by the media asset id;
 * `remove` is a no-op when the id is absent; `list` preserves insertion order
 * via `createdAt ASC, assetId ASC`.
 */

import type { DataSource } from 'typeorm';
import { createOwnedTables, upsertRow } from 'jsails/plugin-sdk';

import { MediaLibraryError, type MediaAsset, type MediaIndex } from './library.js';
import { JsailsMediaAsset, MEDIA_ASSET_TABLE } from './entities.js';

/** Options for {@link createDatabaseMediaIndex}. */
export interface DatabaseMediaIndexOptions {
  /** An initialized TypeORM data source backing media metadata. */
  readonly dataSource?: DataSource;
  /**
   * Resolve the data source lazily on first use. Preferred for app configs:
   * constructing the source reads `DATABASE_*` but connecting waits for the
   * first metadata read/write, so static export never opens a connection.
   */
  readonly getDataSource?: () => DataSource;
}

/** Map an entity row to the public ISO-string {@link MediaAsset} descriptor. */
function toAsset(row: JsailsMediaAsset): MediaAsset {
  return {
    id: row.assetId,
    disk: row.disk,
    path: row.path,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    alt: row.alt,
    caption: row.caption,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The persisted columns of a {@link MediaAsset}: every entity field but the generated key. */
type MediaAssetColumns = Pick<
  JsailsMediaAsset,
  | 'assetId'
  | 'disk'
  | 'path'
  | 'filename'
  | 'mimeType'
  | 'size'
  | 'width'
  | 'height'
  | 'alt'
  | 'caption'
  | 'createdAt'
  | 'updatedAt'
>;

/** The column values of a {@link MediaAsset}, shared by the insert and the update. */
function toColumns(asset: MediaAsset): MediaAssetColumns {
  return {
    assetId: asset.id,
    disk: asset.disk,
    path: asset.path,
    filename: asset.filename,
    mimeType: asset.mimeType,
    size: asset.size,
    width: asset.width ?? null,
    height: asset.height ?? null,
    alt: asset.alt,
    caption: asset.caption,
    createdAt: new Date(asset.createdAt),
    updatedAt: new Date(asset.updatedAt),
  };
}

/**
 * Create a database-backed {@link MediaIndex}. The `jsails_media_asset` table
 * must already exist. See the module doc for the exact contract.
 */
export function createDatabaseMediaIndex(options: DatabaseMediaIndexOptions): MediaIndex {
  const { dataSource, getDataSource } = options;
  if (getDataSource === undefined && dataSource === undefined) {
    throw new TypeError('createDatabaseMediaIndex requires a data source');
  }
  const tables = createOwnedTables({
    dataSource: getDataSource ?? (dataSource as DataSource),
    tables: [MEDIA_ASSET_TABLE],
    initialize: getDataSource !== undefined,
    makeError: (failure) =>
      failure === 'not_initialized'
        ? new MediaLibraryError(
            'not_initialized',
            'the media metadata data source must be initialized',
          )
        : new MediaLibraryError(
            'missing_table',
            'the media metadata table does not exist; run jsails db:push to create it',
          ),
  });

  async function list(): Promise<readonly MediaAsset[]> {
    const source = await tables.open();
    const rows = await source.getRepository(JsailsMediaAsset).find({
      order: { createdAt: 'ASC', assetId: 'ASC' },
    });
    return rows.map(toAsset);
  }

  async function get(id: string): Promise<MediaAsset | undefined> {
    const source = await tables.open();
    const row = await source.getRepository(JsailsMediaAsset).findOneBy({ assetId: id });
    return row === null ? undefined : toAsset(row);
  }

  async function put(asset: MediaAsset): Promise<void> {
    const source = await tables.open();
    await upsertRow({
      dataSource: source,
      entity: JsailsMediaAsset,
      where: { assetId: asset.id },
      update: (existing) => Object.assign(existing, toColumns(asset)),
      create: () => toColumns(asset),
    });
  }

  async function remove(id: string): Promise<void> {
    const source = await tables.open();
    await source.getRepository(JsailsMediaAsset).delete({ assetId: id });
  }

  return { list, get, put, remove };
}
