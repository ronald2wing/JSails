/**
 * Database-backed {@link ContentRepository} for the tenant-free blog CMS
 * content model.
 *
 * {@link createDatabaseContentRepository} persists posts, pages, categories,
 * tags, settings, menus, and revisions through the injected TypeORM
 * `DataSource`'s repositories — no raw SQL and no runtime DDL. The tables must
 * already exist: an app includes {@link contentEntities} in its
 * `JsailsDataSource` `entities` and creates them through the normal declarative
 * schema history (`db:push`). A missing table fails with a clear, value-free
 * {@link ContentPersistenceError} telling the caller to run those commands; the
 * repository never creates a table.
 *
 * The data source is resolved lazily and initialized on first use when it is
 * not already initialized, so a config can build the repository over a
 * `getDataSource` thunk that reads environment variables and constructs (but
 * does not connect) the source only once a query actually runs. Initialization
 * is idempotent: concurrent first uses share one `initialize()` promise.
 *
 * ## Semantics (mirrors the in-memory repository)
 *
 * - **Ids and timestamps are repository-owned.** The `nextId`/`now` clocks are
 *   injectable (defaulting to `Encoding.nanoid` and the system clock); create
 *   methods assign `id`, stamp `createdAt`/`updatedAt`, and stamp `publishedAt`
 *   when a post is created `published`. Entity ids are kept as strings.
 * - **Slugs are unique per collection.** Each content type has its own table
 *   and a per-table unique constraint on `slug`. The repository pre-checks the
 *   slug before writing (raising `slug_conflict`), and maps a database unique
 *   violation from a concurrent writer onto the same `slug_conflict` — never
 *   leaking the duplicated value.
 * - **Transitions.** `publish*`/`unpublish*` reconcile state exactly as the
 *   in-memory repository does; `archived` is rejected at create time and any
 *   transition on it raises `invalid_status`.
 * - **Revisions are append-only.** `appendRevision` validates the snapshot is
 *   JSON-safe; `listRevisions` orders oldest-first (ascending `createdAt`, then
 *   id).
 *
 * Reads run through the repository (`findOneBy`) after the table check, so a
 * graceful-degradation `FileDataSource` (read-only sqljs) can serve the read
 * surface unchanged; writes fail at the SQLite level there, as designed.
 */
import { QueryFailedError } from 'typeorm/error/index.js';
import type { DataSource, Repository } from 'typeorm';
import type { ZodType } from 'zod';

import {
  categorySchema,
  jsonValueSchema,
  menuSchema,
  pageSchema,
  postSchema,
  revisionSchema,
  settingSchema,
  tagSchema,
  type Category,
  type CategoryInput,
  type JsonValue,
  type Menu,
  type MenuCreateInput,
  type MenuUpdateInput,
  type Page,
  type PageCreateInput,
  type PageUpdateInput,
  type Post,
  type PostCreateInput,
  type PostUpdateInput,
  type Revision,
  type RevisionInput,
  type Setting,
  type Tag,
  type TagInput,
} from '../content/model.js';
import { ContentError, type ContentRepository } from '../content/repository.js';
import {
  CONTENT_CATEGORY_TABLE,
  CONTENT_MENU_TABLE,
  CONTENT_PAGE_TABLE,
  CONTENT_POST_TABLE,
  CONTENT_REVISION_TABLE,
  CONTENT_SETTING_TABLE,
  CONTENT_TAG_TABLE,
  JsailsContentCategory,
  JsailsContentMenu,
  JsailsContentPage,
  JsailsContentPost,
  JsailsContentRevision,
  JsailsContentSetting,
  JsailsContentTag,
} from './entities.js';
import { Encoding } from 'jsails/support';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised for a missing/uninitialized table or an invalid data-source option. */
export class ContentPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentPersistenceError';
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link createDatabaseContentRepository}. */
export interface DatabaseContentRepositoryOptions {
  /**
   * The TypeORM data source backing the content model. Provide either this or
   * `getDataSource`; the repository initializes the source on first use when it
   * is not already initialized.
   */
  readonly dataSource?: DataSource;
  /**
   * Resolve the data source lazily on first use. Prefer this when constructing
   * the source reads environment variables (or otherwise must not run at config
   * import time); the thunk runs once, on the first query. Takes precedence
   * over `dataSource`.
   */
  readonly getDataSource?: () => DataSource;
  /** Id generator. Defaults to a URL-safe random id. Must return a non-empty string. */
  readonly nextId?: () => string;
  /** Clock used to stamp timestamps. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maximum id length, matching the model's `idSchema` bound. */
const MAX_ID_LENGTH = 190;

/** True for a value with the TypeORM `DataSource` surface the repository uses. */
function isDataSource(value: unknown): value is DataSource {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { getRepository?: unknown }).getRepository === 'function' &&
    typeof (value as { initialize?: unknown }).initialize === 'function'
  );
}

/** The TypeORM `QueryFailedError` surface used to detect a unique violation. */
interface UniqueFailure {
  readonly driverError?: { code?: unknown; message?: unknown; errno?: unknown };
}

/**
 * True when a thrown error is the database reporting a unique violation. SQLite
 * (sql.js) reports `UNIQUE constraint failed: <table>.<column>` with no error
 * code; MariaDB reports `code: 'ER_DUP_ENTRY'`; Postgres reports `23505`.
 */
function isUniqueFailure(error: unknown): error is UniqueFailure {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driver = error.driverError as UniqueFailure['driverError'] | undefined;
  if (driver === undefined || driver === null) {
    return false;
  }
  if (typeof driver.message === 'string' && driver.message.includes('UNIQUE constraint failed')) {
    return true;
  }
  if (driver.code === 'ER_DUP_ENTRY' || driver.code === 'ER_DUP_KEY') {
    return true;
  }
  if (driver.code === '23505') {
    return true;
  }
  if (driver.errno === 1062 || driver.errno === 2067) {
    return true;
  }
  return false;
}

/**
 * Raise `slug_conflict` for a database unique violation, rethrowing anything
 * else unchanged. The message is value-free: it never echoes the slug.
 */
function rethrowSlugConflict(error: unknown): never {
  if (isUniqueFailure(error)) {
    throw new ContentError('slug_conflict', 'slug is already in use');
  }
  throw error;
}

// ---------------------------------------------------------------------------
// createDatabaseContentRepository
// ---------------------------------------------------------------------------

/**
 * Build a database-backed {@link ContentRepository} over a TypeORM data source.
 * Option mistakes throw `TypeError`; a bad/missing table raises the value-free
 * {@link ContentPersistenceError}; per-operation failures raise the value-free
 * {@link ContentError}s detailed in the module doc.
 */
export function createDatabaseContentRepository(
  options: DatabaseContentRepositoryOptions,
): ContentRepository {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createDatabaseContentRepository requires an options object');
  }
  if (options.dataSource === undefined && options.getDataSource === undefined) {
    throw new TypeError('createDatabaseContentRepository requires a dataSource or getDataSource');
  }
  if (options.getDataSource !== undefined && typeof options.getDataSource !== 'function') {
    throw new TypeError('getDataSource must be a function');
  }
  if (options.nextId !== undefined && typeof options.nextId !== 'function') {
    throw new TypeError('nextId must be a function');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }

  const resolveDataSource = options.getDataSource ?? (() => options.dataSource as DataSource);
  const now = options.now ?? (() => new Date());
  const nextId = options.nextId ?? (() => Encoding.nanoid());

  let dataSource: DataSource | undefined;
  let initializing: Promise<DataSource> | undefined;
  const repositories: {
    post?: Repository<JsailsContentPost>;
    page?: Repository<JsailsContentPage>;
    category?: Repository<JsailsContentCategory>;
    tag?: Repository<JsailsContentTag>;
    setting?: Repository<JsailsContentSetting>;
    menu?: Repository<JsailsContentMenu>;
    revision?: Repository<JsailsContentRevision>;
  } = {};

  /** Resolve and (idempotently) initialize the data source on first use. */
  async function ensureReady(): Promise<DataSource> {
    if (dataSource === undefined) {
      const resolved = resolveDataSource();
      if (!isDataSource(resolved)) {
        throw new ContentPersistenceError('the content data source must be a TypeORM data source');
      }
      dataSource = resolved;
    }
    const source = dataSource;
    if (!source.isInitialized) {
      // Concurrent first uses share one initialize() promise.
      initializing ??= source.initialize().then(() => source);
      await initializing;
    }
    return source;
  }

  /** Ensure every table exists, failing with a clear error when one is missing. */
  async function assertTablesExist(): Promise<void> {
    const source = await ensureReady();

    const queryRunner = source.createQueryRunner();
    try {
      await queryRunner.connect();
      // `hasTable` is unreliable on the sql.js driver; inspect the live table
      // list instead so an unmigrated database fails with the db:push hint.
      const live = new Set((await queryRunner.getTables()).map((table) => table.name));
      const tables = [
        CONTENT_POST_TABLE,
        CONTENT_PAGE_TABLE,
        CONTENT_CATEGORY_TABLE,
        CONTENT_TAG_TABLE,
        CONTENT_SETTING_TABLE,
        CONTENT_MENU_TABLE,
        CONTENT_REVISION_TABLE,
      ];
      for (const table of tables) {
        if (!live.has(table)) {
          throw new ContentPersistenceError(
            `the ${table} table does not exist; run db:push to create it`,
          );
        }
      }
    } finally {
      await queryRunner.release();
    }

    // Cache repositories only after the table check, so a failed check never
    // leaves a usable repository behind for a later call to bypass.
    repositories.post ??= source.getRepository(JsailsContentPost);
    repositories.page ??= source.getRepository(JsailsContentPage);
    repositories.category ??= source.getRepository(JsailsContentCategory);
    repositories.tag ??= source.getRepository(JsailsContentTag);
    repositories.setting ??= source.getRepository(JsailsContentSetting);
    repositories.menu ??= source.getRepository(JsailsContentMenu);
    repositories.revision ??= source.getRepository(JsailsContentRevision);
  }

  /** Resolve every repository after asserting all tables exist. */
  async function ready() {
    await assertTablesExist();
    return dataSource!;
  }

  /** Produce and validate a non-empty string id from the injected generator. */
  function makeId(): string {
    const id = nextId();
    if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) {
      throw new ContentError('invalid_input', 'nextId must return a non-empty string id');
    }
    return id;
  }

  /** Stamp the current instant as an ISO string from the injected clock. */
  function stamp(): string {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new ContentError('invalid_input', 'now must return a valid Date');
    }
    return value.toISOString();
  }

  /** Reject a non-object input with a value-free `invalid_input`. */
  function assertObject(value: unknown, label: string): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ContentError('invalid_input', `${label} input must be an object`);
    }
  }

  /** Validate and decode an entity against its schema, failing value-free. */
  function parse<T>(schema: ZodType<T>, value: unknown, label: string): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new ContentError('invalid_input', `invalid ${label}`);
    }
    return result.data;
  }

  /** Reject a create-time `archived` status (archiving is a later layer's transition). */
  function assertCreatableStatus(status: unknown): void {
    if (status === 'archived') {
      throw new ContentError('invalid_status', 'cannot create an archived entry');
    }
  }

  /** Raise `not_found` for a missing entity of the given collection. */
  function notFound(label: string): ContentError {
    return new ContentError('not_found', `${label} not found`);
  }

  /** Normalize `null` vs an empty string description to the model's `undefined`. */
  function descriptionOf(value: string | null): string | undefined {
    return value === null || value === '' ? undefined : value;
  }

  // -- Row mapping (entity row <-> plain model value) ------------------------

  function rowToPost(row: JsailsContentPost): Post {
    return {
      id: row.contentId,
      title: row.title,
      slug: row.slug,
      excerpt: row.excerpt,
      blocks: row.blocks,
      ...(row.editor === null ? {} : { editor: row.editor }),
      ...(row.native === null ? {} : { native: row.native }),
      status: row.status,
      authorId: row.authorId,
      featuredMediaId: row.featuredMediaId,
      categoryIds: row.categoryIds,
      tagIds: row.tagIds,
      publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  function rowToPage(row: JsailsContentPage): Page {
    return {
      id: row.contentId,
      title: row.title,
      slug: row.slug,
      blocks: row.blocks,
      ...(row.editor === null ? {} : { editor: row.editor }),
      ...(row.native === null ? {} : { native: row.native }),
      status: row.status,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  function rowToCategory(row: JsailsContentCategory): Category {
    return {
      id: row.contentId,
      name: row.name,
      slug: row.slug,
      ...(descriptionOf(row.description) === undefined
        ? {}
        : { description: descriptionOf(row.description) }),
    };
  }

  function rowToTag(row: JsailsContentTag): Tag {
    return {
      id: row.contentId,
      name: row.name,
      slug: row.slug,
      ...(descriptionOf(row.description) === undefined
        ? {}
        : { description: descriptionOf(row.description) }),
    };
  }

  function rowToSetting(row: JsailsContentSetting): Setting {
    return { key: row.key, value: row.value, updatedAt: row.updatedAt.toISOString() };
  }

  function rowToMenu(row: JsailsContentMenu): Menu {
    return {
      id: row.contentId,
      name: row.name,
      location: row.location,
      items: row.items,
    };
  }

  function rowToRevision(row: JsailsContentRevision): Revision {
    return {
      id: row.contentId,
      entryType: row.entryType,
      entryId: row.entryId,
      snapshot: row.snapshot,
      createdAt: row.createdAt.toISOString(),
      authorId: row.authorId,
    };
  }

  /** Parse an ISO string into a `Date` for a `datetime` column. */
  function toDate(iso: string): Date {
    return new Date(iso);
  }

  // -- Posts ----------------------------------------------------------------

  async function createPost(input: PostCreateInput): Promise<Post> {
    assertObject(input, 'post');
    assertCreatableStatus(input.status);
    const repository = (repositories.post ??= (await ready()).getRepository(JsailsContentPost));
    const timestamp = stamp();
    const id = makeId();
    // Pre-check the slug so the common duplicate path fails value-free (and
    // without an INSERT); the unique constraint is the concurrency backstop.
    if (await repository.exists({ where: { slug: input.slug } })) {
      throw new ContentError('slug_conflict', 'slug is already in use');
    }
    const post = parse(
      postSchema,
      {
        id,
        title: input.title,
        slug: input.slug,
        excerpt: input.excerpt ?? '',
        blocks: input.blocks,
        ...(input.editor === undefined ? {} : { editor: input.editor }),
        ...(input.native === undefined ? {} : { native: input.native }),
        status: input.status,
        authorId: input.authorId,
        featuredMediaId: input.featuredMediaId ?? null,
        categoryIds: [...(input.categoryIds ?? [])],
        tagIds: [...(input.tagIds ?? [])],
        publishedAt: input.status === 'published' ? timestamp : null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      'post',
    );
    let row: JsailsContentPost;
    try {
      row = await repository.save(
        repository.create({
          contentId: post.id,
          title: post.title,
          slug: post.slug,
          excerpt: post.excerpt,
          blocks: post.blocks,
          editor: post.editor ?? null,
          native: post.native ?? null,
          status: post.status,
          authorId: post.authorId,
          featuredMediaId: post.featuredMediaId,
          categoryIds: post.categoryIds,
          tagIds: post.tagIds,
          publishedAt: post.publishedAt === null ? null : toDate(post.publishedAt),
          createdAt: toDate(post.createdAt),
          updatedAt: toDate(post.updatedAt),
        }),
      );
    } catch (error) {
      rethrowSlugConflict(error);
    }
    return rowToPost(row);
  }

  async function updatePost(id: string, input: PostUpdateInput): Promise<Post> {
    assertObject(input, 'post');
    const repository = (repositories.post ??= (await ready()).getRepository(JsailsContentPost));
    const current = await repository.findOne({ where: { contentId: id } });
    if (current === null) {
      throw notFound('post');
    }
    if (input.slug !== undefined && input.slug !== current.slug) {
      if (await repository.exists({ where: { slug: input.slug } })) {
        throw new ContentError('slug_conflict', 'slug is already in use');
      }
    }
    const post = parse(
      postSchema,
      {
        id,
        title: input.title ?? current.title,
        slug: input.slug ?? current.slug,
        excerpt: input.excerpt ?? current.excerpt,
        blocks: input.blocks ?? current.blocks,
        ...(input.editor !== undefined
          ? { editor: input.editor }
          : current.editor === null
            ? {}
            : { editor: current.editor }),
        ...(input.native !== undefined
          ? { native: input.native }
          : current.native === null
            ? {}
            : { native: current.native }),
        status: current.status,
        authorId: current.authorId,
        featuredMediaId:
          input.featuredMediaId === undefined ? current.featuredMediaId : input.featuredMediaId,
        categoryIds: input.categoryIds ?? current.categoryIds,
        tagIds: input.tagIds ?? current.tagIds,
        publishedAt: current.publishedAt === null ? null : current.publishedAt.toISOString(),
        createdAt: current.createdAt.toISOString(),
        updatedAt: stamp(),
      },
      'post',
    );
    current.title = post.title;
    current.slug = post.slug;
    current.excerpt = post.excerpt;
    current.blocks = post.blocks;
    current.editor = post.editor ?? null;
    current.native = post.native ?? null;
    current.featuredMediaId = post.featuredMediaId;
    current.categoryIds = post.categoryIds;
    current.tagIds = post.tagIds;
    current.updatedAt = toDate(post.updatedAt);
    let saved: JsailsContentPost;
    try {
      saved = await repository.save(current);
    } catch (error) {
      rethrowSlugConflict(error);
    }
    return rowToPost(saved);
  }

  async function publishPost(id: string): Promise<Post> {
    const repository = (repositories.post ??= (await ready()).getRepository(JsailsContentPost));
    const current = await repository.findOne({ where: { contentId: id } });
    if (current === null) {
      throw notFound('post');
    }
    if (current.status === 'published') {
      return rowToPost(current);
    }
    if (current.status === 'archived') {
      throw new ContentError('invalid_status', 'cannot publish an archived entry');
    }
    const timestamp = stamp();
    current.status = 'published';
    current.publishedAt = toDate(timestamp);
    current.updatedAt = toDate(timestamp);
    return rowToPost(await repository.save(current));
  }

  async function unpublishPost(id: string): Promise<Post> {
    const repository = (repositories.post ??= (await ready()).getRepository(JsailsContentPost));
    const current = await repository.findOne({ where: { contentId: id } });
    if (current === null) {
      throw notFound('post');
    }
    if (current.status === 'draft') {
      return rowToPost(current);
    }
    if (current.status === 'archived') {
      throw new ContentError('invalid_status', 'cannot unpublish an archived entry');
    }
    current.status = 'draft';
    current.updatedAt = toDate(stamp());
    return rowToPost(await repository.save(current));
  }

  async function deletePost(id: string): Promise<void> {
    const repository = (repositories.post ??= (await ready()).getRepository(JsailsContentPost));
    // `FindOptionsWhere` over the recursive `native` column exceeds TypeScript's
    // instantiation depth; a query builder keeps the delete key a scalar.
    const result = await repository
      .createQueryBuilder('post')
      .delete()
      .where('contentId = :contentId', { contentId: id })
      .execute();
    if (result.affected === 0) {
      throw notFound('post');
    }
  }

  // -- Pages ----------------------------------------------------------------

  async function createPage(input: PageCreateInput): Promise<Page> {
    assertObject(input, 'page');
    assertCreatableStatus(input.status);
    const repository = (repositories.page ??= (await ready()).getRepository(JsailsContentPage));
    const timestamp = stamp();
    const id = makeId();
    if (await repository.exists({ where: { slug: input.slug } })) {
      throw new ContentError('slug_conflict', 'slug is already in use');
    }
    const page = parse(
      pageSchema,
      {
        id,
        title: input.title,
        slug: input.slug,
        blocks: input.blocks,
        ...(input.editor === undefined ? {} : { editor: input.editor }),
        ...(input.native === undefined ? {} : { native: input.native }),
        status: input.status,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      'page',
    );
    let row: JsailsContentPage;
    try {
      row = await repository.save(
        repository.create({
          contentId: page.id,
          title: page.title,
          slug: page.slug,
          blocks: page.blocks,
          editor: page.editor ?? null,
          native: page.native ?? null,
          status: page.status,
          parentId: page.parentId,
          sortOrder: page.sortOrder,
          createdAt: toDate(page.createdAt),
          updatedAt: toDate(page.updatedAt),
        }),
      );
    } catch (error) {
      rethrowSlugConflict(error);
    }
    return rowToPage(row);
  }

  async function updatePage(id: string, input: PageUpdateInput): Promise<Page> {
    assertObject(input, 'page');
    const repository = (repositories.page ??= (await ready()).getRepository(JsailsContentPage));
    const current = await repository.findOne({ where: { contentId: id } });
    if (current === null) {
      throw notFound('page');
    }
    if (input.slug !== undefined && input.slug !== current.slug) {
      if (await repository.exists({ where: { slug: input.slug } })) {
        throw new ContentError('slug_conflict', 'slug is already in use');
      }
    }
    const page = parse(
      pageSchema,
      {
        id,
        title: input.title ?? current.title,
        slug: input.slug ?? current.slug,
        blocks: input.blocks ?? current.blocks,
        ...(input.editor !== undefined
          ? { editor: input.editor }
          : current.editor === null
            ? {}
            : { editor: current.editor }),
        ...(input.native !== undefined
          ? { native: input.native }
          : current.native === null
            ? {}
            : { native: current.native }),
        status: current.status,
        parentId: input.parentId === undefined ? current.parentId : input.parentId,
        sortOrder: input.sortOrder ?? current.sortOrder,
        createdAt: current.createdAt.toISOString(),
        updatedAt: stamp(),
      },
      'page',
    );
    current.title = page.title;
    current.slug = page.slug;
    current.blocks = page.blocks;
    current.editor = page.editor ?? null;
    current.native = page.native ?? null;
    current.parentId = page.parentId;
    current.sortOrder = page.sortOrder;
    current.updatedAt = toDate(page.updatedAt);
    let saved: JsailsContentPage;
    try {
      saved = await repository.save(current);
    } catch (error) {
      rethrowSlugConflict(error);
    }
    return rowToPage(saved);
  }

  async function publishPage(id: string): Promise<Page> {
    const repository = (repositories.page ??= (await ready()).getRepository(JsailsContentPage));
    const current = await repository.findOne({ where: { contentId: id } });
    if (current === null) {
      throw notFound('page');
    }
    if (current.status === 'published') {
      return rowToPage(current);
    }
    if (current.status === 'archived') {
      throw new ContentError('invalid_status', 'cannot publish an archived entry');
    }
    current.status = 'published';
    current.updatedAt = toDate(stamp());
    return rowToPage(await repository.save(current));
  }

  async function unpublishPage(id: string): Promise<Page> {
    const repository = (repositories.page ??= (await ready()).getRepository(JsailsContentPage));
    const current = await repository.findOne({ where: { contentId: id } });
    if (current === null) {
      throw notFound('page');
    }
    if (current.status === 'draft') {
      return rowToPage(current);
    }
    if (current.status === 'archived') {
      throw new ContentError('invalid_status', 'cannot unpublish an archived entry');
    }
    current.status = 'draft';
    current.updatedAt = toDate(stamp());
    return rowToPage(await repository.save(current));
  }

  async function deletePage(id: string): Promise<void> {
    const repository = (repositories.page ??= (await ready()).getRepository(JsailsContentPage));
    const result = await repository
      .createQueryBuilder('page')
      .delete()
      .where('contentId = :contentId', { contentId: id })
      .execute();
    if (result.affected === 0) {
      throw notFound('page');
    }
  }

  // -- Categories -----------------------------------------------------------

  async function createCategory(input: CategoryInput): Promise<Category> {
    assertObject(input, 'category');
    const repository = (repositories.category ??= (await ready()).getRepository(
      JsailsContentCategory,
    ));
    const id = makeId();
    if (await repository.exists({ where: { slug: input.slug } })) {
      throw new ContentError('slug_conflict', 'slug is already in use');
    }
    const category = parse(
      categorySchema,
      {
        id,
        name: input.name,
        slug: input.slug,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      'category',
    );
    let row: JsailsContentCategory;
    try {
      row = await repository.save(
        repository.create({
          contentId: category.id,
          name: category.name,
          slug: category.slug,
          description: category.description ?? null,
        }),
      );
    } catch (error) {
      rethrowSlugConflict(error);
    }
    return rowToCategory(row);
  }

  async function updateCategory(id: string, input: CategoryInput): Promise<Category> {
    assertObject(input, 'category');
    const repository = (repositories.category ??= (await ready()).getRepository(
      JsailsContentCategory,
    ));
    const current = await repository.findOne({ where: { contentId: id } });
    if (current === null) {
      throw notFound('category');
    }
    if (input.slug !== current.slug) {
      if (await repository.exists({ where: { slug: input.slug } })) {
        throw new ContentError('slug_conflict', 'slug is already in use');
      }
    }
    const category = parse(
      categorySchema,
      {
        id,
        name: input.name,
        slug: input.slug,
        ...(input.description === undefined
          ? current.description === null
            ? {}
            : { description: current.description }
          : { description: input.description }),
      },
      'category',
    );
    current.name = category.name;
    current.slug = category.slug;
    current.description = category.description ?? null;
    let saved: JsailsContentCategory;
    try {
      saved = await repository.save(current);
    } catch (error) {
      rethrowSlugConflict(error);
    }
    return rowToCategory(saved);
  }

  async function deleteCategory(id: string): Promise<void> {
    const repository = (repositories.category ??= (await ready()).getRepository(
      JsailsContentCategory,
    ));
    const result = await repository
      .createQueryBuilder('category')
      .delete()
      .where('contentId = :contentId', { contentId: id })
      .execute();
    if (result.affected === 0) {
      throw notFound('category');
    }
  }

  // -- Tags -----------------------------------------------------------------

  async function createTag(input: TagInput): Promise<Tag> {
    assertObject(input, 'tag');
    const repository = (repositories.tag ??= (await ready()).getRepository(JsailsContentTag));
    const id = makeId();
    if (await repository.exists({ where: { slug: input.slug } })) {
      throw new ContentError('slug_conflict', 'slug is already in use');
    }
    const tag = parse(
      tagSchema,
      {
        id,
        name: input.name,
        slug: input.slug,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      'tag',
    );
    let row: JsailsContentTag;
    try {
      row = await repository.save(
        repository.create({
          contentId: tag.id,
          name: tag.name,
          slug: tag.slug,
          description: tag.description ?? null,
        }),
      );
    } catch (error) {
      rethrowSlugConflict(error);
    }
    return rowToTag(row);
  }

  async function updateTag(id: string, input: TagInput): Promise<Tag> {
    assertObject(input, 'tag');
    const repository = (repositories.tag ??= (await ready()).getRepository(JsailsContentTag));
    const current = await repository.findOne({ where: { contentId: id } });
    if (current === null) {
      throw notFound('tag');
    }
    if (input.slug !== current.slug) {
      if (await repository.exists({ where: { slug: input.slug } })) {
        throw new ContentError('slug_conflict', 'slug is already in use');
      }
    }
    const tag = parse(
      tagSchema,
      {
        id,
        name: input.name,
        slug: input.slug,
        ...(input.description === undefined
          ? current.description === null
            ? {}
            : { description: current.description }
          : { description: input.description }),
      },
      'tag',
    );
    current.name = tag.name;
    current.slug = tag.slug;
    current.description = tag.description ?? null;
    let saved: JsailsContentTag;
    try {
      saved = await repository.save(current);
    } catch (error) {
      rethrowSlugConflict(error);
    }
    return rowToTag(saved);
  }

  async function deleteTag(id: string): Promise<void> {
    const repository = (repositories.tag ??= (await ready()).getRepository(JsailsContentTag));
    const result = await repository
      .createQueryBuilder('tag')
      .delete()
      .where('contentId = :contentId', { contentId: id })
      .execute();
    if (result.affected === 0) {
      throw notFound('tag');
    }
  }

  // -- Settings -------------------------------------------------------------

  async function setSetting(key: string, value: JsonValue): Promise<Setting> {
    // Validate the value first so a non-JSON-safe value gets its own, precise
    // message; the shape (key bounds, timestamp) is then checked by the schema.
    const parsedValue = jsonValueSchema.safeParse(value);
    if (!parsedValue.success) {
      throw new ContentError('invalid_input', 'setting value must be JSON-safe');
    }
    const setting = parse(
      settingSchema,
      { key, value: parsedValue.data, updatedAt: stamp() },
      'setting',
    );
    await ready();
    await dataSource!.transaction(async (manager) => {
      const tx = manager.getRepository(JsailsContentSetting);
      // Same recursive `JsonValue` instantiation issue as `getSetting`.
      let existing = await tx
        .createQueryBuilder('setting')
        .where('setting.key = :key', { key })
        .getOne();
      if (existing === null) {
        existing = tx.create({ key, value: setting.value, updatedAt: toDate(setting.updatedAt) });
      } else {
        existing.value = setting.value;
        existing.updatedAt = toDate(setting.updatedAt);
      }
      await tx.save(existing);
    });
    return setting;
  }

  // -- Menus ----------------------------------------------------------------

  async function createMenu(input: MenuCreateInput): Promise<Menu> {
    assertObject(input, 'menu');
    const repository = (repositories.menu ??= (await ready()).getRepository(JsailsContentMenu));
    const menu = parse(
      menuSchema,
      { id: makeId(), name: input.name, location: input.location, items: [...input.items] },
      'menu',
    );
    const row = await repository.save(
      repository.create({
        contentId: menu.id,
        name: menu.name,
        location: menu.location,
        items: menu.items,
      }),
    );
    return rowToMenu(row);
  }

  async function updateMenu(id: string, input: MenuUpdateInput): Promise<Menu> {
    assertObject(input, 'menu');
    const repository = (repositories.menu ??= (await ready()).getRepository(JsailsContentMenu));
    const current = await repository.findOne({ where: { contentId: id } });
    if (current === null) {
      throw notFound('menu');
    }
    const menu = parse(
      menuSchema,
      {
        id,
        name: input.name ?? current.name,
        location: input.location ?? current.location,
        items: input.items ?? current.items,
      },
      'menu',
    );
    current.name = menu.name;
    current.location = menu.location;
    current.items = menu.items;
    return rowToMenu(await repository.save(current));
  }

  async function deleteMenu(id: string): Promise<void> {
    const repository = (repositories.menu ??= (await ready()).getRepository(JsailsContentMenu));
    const result = await repository
      .createQueryBuilder('menu')
      .delete()
      .where('contentId = :contentId', { contentId: id })
      .execute();
    if (result.affected === 0) {
      throw notFound('menu');
    }
  }

  // -- Revisions ------------------------------------------------------------

  async function appendRevision(input: RevisionInput): Promise<Revision> {
    assertObject(input, 'revision');
    const parsedSnapshot = jsonValueSchema.safeParse(input.snapshot);
    if (!parsedSnapshot.success) {
      throw new ContentError('invalid_snapshot', 'revision snapshot must be JSON-safe');
    }
    const revision = parse(
      revisionSchema,
      {
        id: makeId(),
        entryType: input.entryType,
        entryId: input.entryId,
        snapshot: parsedSnapshot.data,
        createdAt: stamp(),
        authorId: input.authorId,
      },
      'revision',
    );
    const repository = (repositories.revision ??= (await ready()).getRepository(
      JsailsContentRevision,
    ));
    const row = await repository.save(
      repository.create({
        contentId: revision.id,
        entryType: revision.entryType,
        entryId: revision.entryId,
        snapshot: revision.snapshot,
        authorId: revision.authorId,
        createdAt: toDate(revision.createdAt),
      }),
    );
    return rowToRevision(row);
  }

  async function listRevisions(entryType: string, entryId: string): Promise<readonly Revision[]> {
    const repository = (repositories.revision ??= (await ready()).getRepository(
      JsailsContentRevision,
    ));
    const rows = await repository.find({
      where: { entryType, entryId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return rows.map(rowToRevision);
  }

  // -- Read surface ---------------------------------------------------------

  async function listPosts(): Promise<readonly Post[]> {
    const repository = (repositories.post ??= (await ready()).getRepository(JsailsContentPost));
    const rows = await repository.find({ order: { createdAt: 'ASC', id: 'ASC' } });
    return rows.map(rowToPost);
  }

  async function getPost(id: string): Promise<Post | undefined> {
    const repository = (repositories.post ??= (await ready()).getRepository(JsailsContentPost));
    const row = await repository.findOne({ where: { contentId: id } });
    return row === null ? undefined : rowToPost(row);
  }

  async function listPages(): Promise<readonly Page[]> {
    const repository = (repositories.page ??= (await ready()).getRepository(JsailsContentPage));
    const rows = await repository.find({
      order: { createdAt: 'ASC', id: 'ASC', sortOrder: 'ASC' },
    });
    return rows.map(rowToPage);
  }

  async function getPage(id: string): Promise<Page | undefined> {
    const repository = (repositories.page ??= (await ready()).getRepository(JsailsContentPage));
    const row = await repository.findOne({ where: { contentId: id } });
    return row === null ? undefined : rowToPage(row);
  }

  async function listCategories(): Promise<readonly Category[]> {
    const repository = (repositories.category ??= (await ready()).getRepository(
      JsailsContentCategory,
    ));
    const rows = await repository.find({ order: { name: 'ASC', id: 'ASC' } });
    return rows.map(rowToCategory);
  }

  async function getCategory(id: string): Promise<Category | undefined> {
    const repository = (repositories.category ??= (await ready()).getRepository(
      JsailsContentCategory,
    ));
    const row = await repository.findOne({ where: { contentId: id } });
    return row === null ? undefined : rowToCategory(row);
  }

  async function listTags(): Promise<readonly Tag[]> {
    const repository = (repositories.tag ??= (await ready()).getRepository(JsailsContentTag));
    const rows = await repository.find({ order: { name: 'ASC', id: 'ASC' } });
    return rows.map(rowToTag);
  }

  async function getTag(id: string): Promise<Tag | undefined> {
    const repository = (repositories.tag ??= (await ready()).getRepository(JsailsContentTag));
    const row = await repository.findOne({ where: { contentId: id } });
    return row === null ? undefined : rowToTag(row);
  }

  async function listSettings(): Promise<readonly Setting[]> {
    const repository = (repositories.setting ??= (await ready()).getRepository(
      JsailsContentSetting,
    ));
    const rows = await repository.find({ order: { key: 'ASC' } });
    return rows.map(rowToSetting);
  }

  async function getSetting(key: string): Promise<Setting | undefined> {
    const repository = (repositories.setting ??= (await ready()).getRepository(
      JsailsContentSetting,
    ));
    // TypeORM's `FindOptionsWhere` over the recursive `JsonValue` column
    // exceeds TypeScript's instantiation depth; a query builder keeps the
    // lookup key a scalar without the deep conditional type.
    const row = await repository
      .createQueryBuilder('setting')
      .where('setting.key = :key', { key })
      .getOne();
    return row === null ? undefined : rowToSetting(row);
  }

  async function listMenus(): Promise<readonly Menu[]> {
    const repository = (repositories.menu ??= (await ready()).getRepository(JsailsContentMenu));
    const rows = await repository.find({ order: { name: 'ASC', id: 'ASC' } });
    return rows.map(rowToMenu);
  }

  async function getMenu(id: string): Promise<Menu | undefined> {
    const repository = (repositories.menu ??= (await ready()).getRepository(JsailsContentMenu));
    const row = await repository.findOne({ where: { contentId: id } });
    return row === null ? undefined : rowToMenu(row);
  }

  return {
    // Posts
    listPosts,
    getPost,
    createPost,
    updatePost,
    publishPost,
    unpublishPost,
    deletePost,

    // Pages
    listPages,
    getPage,
    createPage,
    updatePage,
    publishPage,
    unpublishPage,
    deletePage,

    // Categories
    listCategories,
    getCategory,
    createCategory,
    updateCategory,
    deleteCategory,

    // Tags
    listTags,
    getTag,
    createTag,
    updateTag,
    deleteTag,

    // Settings
    listSettings,
    getSetting,
    setSetting,

    // Menus
    listMenus,
    getMenu,
    createMenu,
    updateMenu,
    deleteMenu,

    // Revisions
    listRevisions,
    appendRevision,
  };
}
