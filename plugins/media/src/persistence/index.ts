/**
 * Database-backed {@link MediaIndex}.
 *
 * {@link createDatabaseMediaIndex} persists media metadata in the
 * framework-owned `jsails_media_asset` table through the injected TypeORM
 * `DataSource`'s repository — no raw SQL and no runtime DDL. The table must
 * already exist: an app includes {@link mediaEntities} in its `JsailsDataSource`
 * entities and creates the table through the normal declarative schema history
 * (`db:push`). A missing table fails with a clear, value-free {@link MediaError}
 * (`disk_failed`) telling the caller to run that command; the index never
 * creates it. A data source that is not initialized fails with an equivalent
 * clear error before any repository query runs.
 *
 * Timestamps round-trip across the persistence boundary: the {@link MediaAsset}
 * descriptor carries ISO-8601 strings (set by the library's clock), while the
 * entity stores `Date` columns. `put` is an upsert keyed by the media asset id;
 * `remove` is a no-op when the id is absent; `list` preserves insertion order
 * via `createdAt ASC, assetId ASC`.
 */

import type { DataSource } from 'typeorm';

import { MediaError, type MediaAsset, type MediaIndex } from '../library.js';
import { JsailsMediaAsset, MEDIA_ASSET_TABLE } from './entities.js';

/** Options for {@link createDatabaseMediaIndex}. */
export interface DatabaseMediaIndexOptions {
  /** A TypeORM data source backing media metadata. */
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

/** Map an inbound {@link MediaAsset} to the entity row shape for `save`. */
function fromAsset(asset: MediaAsset, rowId?: number): JsailsMediaAsset {
  return JsailsMediaAsset.create({
    ...(rowId === undefined ? {} : { id: rowId }),
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
  });
}

/**
 * Build a database-backed {@link MediaIndex} over an initialized TypeORM data
 * source. The `jsails_media_asset` table must already exist (created by the
 * migration history). See the module doc for the exact contract.
 */
export function createDatabaseMediaIndex(options: DatabaseMediaIndexOptions): MediaIndex {
  if (options.dataSource === undefined && options.getDataSource === undefined) {
    throw new TypeError('createDatabaseMediaIndex requires a data source');
  }

  let resolved: DataSource | undefined;
  let resolving: Promise<DataSource> | undefined;

  /** Resolve and (for a lazy source) initialize the data source once. */
  async function resolveDataSource(): Promise<DataSource> {
    if (resolved !== undefined) return resolved;
    resolving ??= (async () => {
      const getDataSource = options.getDataSource;
      const source = getDataSource !== undefined ? getDataSource() : options.dataSource;
      if (source === undefined) {
        throw new TypeError('createDatabaseMediaIndex requires a data source');
      }
      if (getDataSource !== undefined && !source.isInitialized) {
        await source.initialize();
      }
      resolved = source;
      return source;
    })();
    try {
      return await resolving;
    } finally {
      resolving = undefined;
    }
  }

  /** Fail with a clear error when the table is missing; never create it. */
  async function assertTableExists(dataSource: DataSource): Promise<void> {
    if (!dataSource.isInitialized) {
      throw new MediaError('disk_failed', 'the media metadata data source must be initialized');
    }
    const queryRunner = dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      if (!(await queryRunner.hasTable(MEDIA_ASSET_TABLE))) {
        throw new MediaError(
          'disk_failed',
          'the media metadata table does not exist; run jsails db:push to create it',
        );
      }
    } finally {
      await queryRunner.release();
    }
  }

  async function list(): Promise<readonly MediaAsset[]> {
    const dataSource = await resolveDataSource();
    await assertTableExists(dataSource);
    const rows = await dataSource.getRepository(JsailsMediaAsset).find({
      order: { createdAt: 'ASC', assetId: 'ASC' },
    });
    return rows.map(toAsset);
  }

  async function get(id: string): Promise<MediaAsset | undefined> {
    const dataSource = await resolveDataSource();
    await assertTableExists(dataSource);
    const row = await dataSource.getRepository(JsailsMediaAsset).findOneBy({ assetId: id });
    return row === null ? undefined : toAsset(row);
  }

  async function put(asset: MediaAsset): Promise<void> {
    const dataSource = await resolveDataSource();
    await assertTableExists(dataSource);
    const repository = dataSource.getRepository(JsailsMediaAsset);
    const existing = await repository.findOneBy({ assetId: asset.id });
    // `save` upserts by primary key; reusing the existing row's generated id
    // makes `put` an upsert on the natural `assetId` key instead of a fresh row.
    await repository.save(fromAsset(asset, existing?.id));
  }

  async function remove(id: string): Promise<void> {
    const dataSource = await resolveDataSource();
    await assertTableExists(dataSource);
    await dataSource.getRepository(JsailsMediaAsset).delete({ assetId: id });
  }

  return { list, get, put, remove };
}
