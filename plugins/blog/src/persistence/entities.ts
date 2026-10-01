/**
 * Framework-owned entities for the database-backed content repository.
 *
 * These entities are the single source of truth for the tables JSails reserves
 * for the tenant-free blog CMS content model (`jsails/blog/content`). They are
 * plain Active Record entities — a generated integer primary key plus scalar
 * columns — that the portable schema model accepts, so an app registers them
 * with its `JsailsDataSource` and creates the tables through the normal
 * declarative schema history (`db:push`), never through runtime DDL.
 *
 * ## Column shapes
 *
 * - Scalar columns mirror the model bounds in `../content/model.js`: ids, slugs,
 *   titles, and names are `varchar(190)`; long text (excerpts, bodies) is
 *   `text`; every timestamp is `datetime` with no database default — the
 *   repository stamps them from application code (an injectable `now` clock).
 * - **Blocks, menu items, and revision snapshots are `json` columns.** The
 *   portable schema maps `json` to `jsonb` on Postgres, `text` on SQLite, and
 *   `json` elsewhere; all three round-trip objects/arrays/null correctly.
 * - **`categoryIds`/`tagIds` are `json` arrays of string ids**, not junction
 *   tables. There is therefore **no relational integrity** on category/tag
 *   membership: a dangling id is stored as-is, and deleting a category/tag does
 *   not purge it from a post. The repository validates ids as
 *   strings up front; referential integrity is a later layer's concern.
 *
 * ## Slug uniqueness
 *
 * `slug` carries a per-table unique constraint so the database is the final
 * backstop for slug conflicts (the repository also pre-checks, so the common
 * path raises a value-free `slug_conflict` before the INSERT). Because each
 * content type is its own table, posts/pages/categories/tags each get their
 * own slug namespace — matching the contract.
 *
 * ## Ids
 *
 * The portable schema model accepts only a single generated **integer**
 * primary key, but the repository contract owns **string** ids (a nanoid by
 * default). Every content entity therefore carries a unique `contentId`
 * `varchar(190)` column that holds the repository-assigned id; the integer
 * `id` is a database-internal surrogate the repository never exposes. The
 * setting entity is keyed by `key` instead and has no `contentId`.
 *
 * ## Naming
 *
 * The tables are prefixed `jsails_blog_content_` and are framework-owned by the
 * `jsails/blog` plugin's static schema; there is no separate legacy blog table.
 */
import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import type { RichTextDocument } from 'jsails/rich-text';
import type { ContentStatus, JsonValue, MenuItem } from '../content/model.js';

// ---------------------------------------------------------------------------
// Shared bounds
// ---------------------------------------------------------------------------

/** Column width for ids, slugs, titles, names, and other `varchar(190)` fields. */
const LABEL_LENGTH = 190;

/** Column width for the revision `entryType` discriminator. */
const ENTRY_TYPE_LENGTH = 64;

/** Column width for a menu `location` discriminator. */
const LOCATION_LENGTH = 64;

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/** Table JSails reserves for database-backed content posts. */
export const CONTENT_POST_TABLE = 'jsails_blog_content_post';

@Entity(CONTENT_POST_TABLE)
export class JsailsContentPost extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The repository-assigned string id (unique across posts). */
  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  contentId!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: false })
  title!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  slug!: string;

  @Column({ type: 'text', nullable: false })
  excerpt!: string;

  /** A `RichTextDocument` persisted as JSON in a `json` column. */
  @Column({ type: 'json', nullable: false })
  blocks!: RichTextDocument;

  /** The editor adapter id, or `null` for a canonical-only record. */
  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: true })
  editor!: string | null;

  /** The editor-native payload, or `null` when the adapter preserved none. */
  @Column({ type: 'json', nullable: true })
  native!: JsonValue | null;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: false })
  status!: ContentStatus;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: false })
  authorId!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: true })
  featuredMediaId!: string | null;

  /** Array of category ids persisted as JSON in a `json` column. */
  @Column({ type: 'json', nullable: false })
  categoryIds!: string[];

  /** Array of tag ids persisted as JSON in a `json` column. */
  @Column({ type: 'json', nullable: false })
  tagIds!: string[];

  @Column({ type: 'datetime', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'datetime', nullable: false })
  createdAt!: Date;

  @Column({ type: 'datetime', nullable: false })
  updatedAt!: Date;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** Table JSails reserves for database-backed content pages. */
export const CONTENT_PAGE_TABLE = 'jsails_blog_content_page';

@Entity(CONTENT_PAGE_TABLE)
export class JsailsContentPage extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The repository-assigned string id (unique across pages). */
  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  contentId!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: false })
  title!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  slug!: string;

  /** A `RichTextDocument` persisted as JSON in a `json` column. */
  @Column({ type: 'json', nullable: false })
  blocks!: RichTextDocument;

  /** The editor adapter id, or `null` for a canonical-only record. */
  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: true })
  editor!: string | null;

  /** The editor-native payload, or `null` when the adapter preserved none. */
  @Column({ type: 'json', nullable: true })
  native!: JsonValue | null;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: false })
  status!: ContentStatus;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: true })
  parentId!: string | null;

  @Column({ type: 'integer', nullable: false })
  sortOrder!: number;

  @Column({ type: 'datetime', nullable: false })
  createdAt!: Date;

  @Column({ type: 'datetime', nullable: false })
  updatedAt!: Date;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** Table JSails reserves for database-backed content categories. */
export const CONTENT_CATEGORY_TABLE = 'jsails_blog_content_category';

@Entity(CONTENT_CATEGORY_TABLE)
export class JsailsContentCategory extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The repository-assigned string id (unique across categories). */
  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  contentId!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: false })
  name!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  slug!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Table JSails reserves for database-backed content tags. */
export const CONTENT_TAG_TABLE = 'jsails_blog_content_tag';

@Entity(CONTENT_TAG_TABLE)
export class JsailsContentTag extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The repository-assigned string id (unique across tags). */
  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  contentId!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: false })
  name!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  slug!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Table JSails reserves for database-backed content settings. */
export const CONTENT_SETTING_TABLE = 'jsails_blog_content_setting';

@Entity(CONTENT_SETTING_TABLE)
export class JsailsContentSetting extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  key!: string;

  /** Any JSON-safe value persisted as JSON in a `json` column. */
  @Column({ type: 'json', nullable: false })
  value!: JsonValue;

  @Column({ type: 'datetime', nullable: false })
  updatedAt!: Date;
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** Table JSails reserves for database-backed content menus. */
export const CONTENT_MENU_TABLE = 'jsails_blog_content_menu';

@Entity(CONTENT_MENU_TABLE)
export class JsailsContentMenu extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The repository-assigned string id (unique across menus). */
  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  contentId!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: false })
  name!: string;

  @Column({ type: 'varchar', length: LOCATION_LENGTH, nullable: false })
  location!: string;

  /** A `MenuItem` tree persisted as JSON in a `json` column. */
  @Column({ type: 'json', nullable: false })
  items!: MenuItem[];
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/** Table JSails reserves for database-backed content revisions. */
export const CONTENT_REVISION_TABLE = 'jsails_blog_content_revision';

/** Index name over the `(entryType, entryId)` lookup columns. */
const CONTENT_REVISION_ENTRY_INDEX = 'idx_jsails_content_revision_entry';

@Entity(CONTENT_REVISION_TABLE)
@Index(CONTENT_REVISION_ENTRY_INDEX, ['entryType', 'entryId'])
export class JsailsContentRevision extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The repository-assigned string id (unique across revisions). */
  @Column({ type: 'varchar', length: LABEL_LENGTH, unique: true, nullable: false })
  contentId!: string;

  @Column({ type: 'varchar', length: ENTRY_TYPE_LENGTH, nullable: false })
  entryType!: string;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: false })
  entryId!: string;

  /** A JSON-safe snapshot persisted as JSON in a `json` column. */
  @Column({ type: 'json', nullable: false })
  snapshot!: JsonValue;

  @Column({ type: 'varchar', length: LABEL_LENGTH, nullable: false })
  authorId!: string;

  @Column({ type: 'datetime', nullable: false })
  createdAt!: Date;
}

/**
 * The entities an app must include in its `JsailsDataSource` `entities` list
 * when it persists the content model in the database.
 */
export const contentEntities = [
  JsailsContentPost,
  JsailsContentPage,
  JsailsContentCategory,
  JsailsContentTag,
  JsailsContentSetting,
  JsailsContentMenu,
  JsailsContentRevision,
];
