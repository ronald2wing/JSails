/**
 * The persistence entity for database-indexed media metadata.
 *
 * {@link JsailsMediaAsset} is the single source of truth for the
 * `jsails_media_asset` table JSails reserves for a database-backed
 * {@link MediaIndex}. It is a plain Active Record entity — a generated integer
 * primary key plus one scalar column per {@link MediaAsset} field — that the
 * portable schema model accepts, so an app registers it with its
 * `JsailsDataSource` and creates the table through the normal declarative
 * schema history (`db:push`), never through runtime DDL.
 *
 * ## Column choices
 *
 * - The table's primary key is a generated integer `id`, matching every other
 *   `jsails_*` reserved table: the portable schema model supports only generated
 *   integer primary keys (or a full composite key), not a single string
 *   `@PrimaryColumn`. The opaque media asset id is therefore stored in the
 *   unique `assetId` `varchar` column (190 keeps it within the indexable length
 *   for the server SQL drivers); the store maps it to and from the
 *   {@link MediaAsset} `id` field at the boundary so the framework schema model
 *   and the public descriptor never disagree.
 * - `createdAt`/`updatedAt` are `datetime` (`Date`) without database defaults;
 *   the store stamps them from application code, matching `JsailsPluginState`.
 *   The {@link MediaAsset} interface exposes ISO-8601 strings, so the store owns
 *   the `Date` <-> ISO-string round-trip at the boundary.
 * - `size` is `integer`, matching {@link JsailsAttachment.byteSize}: the
 *   portable schema model has no 64-bit integer with a JS `number` binding (a
 *   `bigint` column reads back as a string and custom value transformers are
 *   rejected), and media payloads are bounded by the library's upload cap so a
 *   32-bit byte length is ample.
 * - `alt` and `caption` are `text` (the library caps them at 500 / 5000
 *   characters respectively but they need not be indexed).
 */

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Table JSails reserves for database-indexed media metadata. */
export const MEDIA_ASSET_TABLE = 'jsails_media_asset';

/** `jsails_media_asset.assetId` / `disk` / `mimeType` column width. */
export const MEDIA_ID_COLUMN_LENGTH = 190;

/** `jsails_media_asset.path` column width (an id-prefixed disk key). */
export const MEDIA_PATH_COLUMN_LENGTH = 1024;

/** `jsails_media_asset.filename` column width. */
export const MEDIA_FILENAME_COLUMN_LENGTH = 255;

@Entity(MEDIA_ASSET_TABLE)
@Unique('UQ_jsails_media_asset_assetId', ['assetId'])
export class JsailsMediaAsset extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: MEDIA_ID_COLUMN_LENGTH, nullable: false })
  assetId!: string;

  @Column({ type: 'varchar', length: MEDIA_ID_COLUMN_LENGTH, nullable: false })
  disk!: string;

  @Column({ type: 'varchar', length: MEDIA_PATH_COLUMN_LENGTH, nullable: false })
  path!: string;

  @Column({ type: 'varchar', length: MEDIA_FILENAME_COLUMN_LENGTH, nullable: false })
  filename!: string;

  @Column({ type: 'varchar', length: MEDIA_ID_COLUMN_LENGTH, nullable: false })
  mimeType!: string;

  @Column({ type: 'integer', nullable: false })
  size!: number;

  @Column({ type: 'integer', nullable: true })
  width!: number | null;

  @Column({ type: 'integer', nullable: true })
  height!: number | null;

  @Column({ type: 'text', nullable: false })
  alt!: string;

  @Column({ type: 'text', nullable: false })
  caption!: string;

  @Column({ type: 'datetime', nullable: false })
  createdAt!: Date;

  @Column({ type: 'datetime', nullable: false })
  updatedAt!: Date;
}

/**
 * The entity an app must include in its `JsailsDataSource` `entities` list
 * when it indexes media metadata in the database.
 */
export const mediaEntities = [JsailsMediaAsset];
