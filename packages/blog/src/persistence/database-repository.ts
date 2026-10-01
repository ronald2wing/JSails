/**
 * Database-backed {@link BlogRepository} for the tenant-free blog CMS
 * content model.
 *
 * {@link createDatabaseBlogRepository} persists posts, pages, categories,
 * tags, settings, menus, and revisions through the injected TypeORM
 * `DataSource`'s repositories: no raw SQL and no runtime DDL. The tables must
 * already exist: an app includes {@link blogEntities} in its
 * `JsailsDataSource` `entities` and creates them with `jsails db:push`. A
 * missing table fails with a value-free {@link BlogPersistenceError} naming
 * that command; the repository never creates a table.
 *
 * The data source is resolved lazily and initialized on first use when it is
 * not already initialized, so a config can build the repository over a
 * `getDataSource` thunk that reads environment variables and constructs (but
 * does not connect) the source only once a query actually runs. The table
 * probe is memoized on success and retried after a failure
 * (`createOwnedTables`).
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
 *   violation from a concurrent writer onto the same `slug_conflict`, never
 *   leaking the duplicated value.
 * - **Transitions.** `publish*`/`unpublish*` follow the shared
 *   `transitionStatus` rule; `archived` is rejected at create time and any
 *   transition on it raises `invalid_status`.
 * - **Revisions.** `appendRevision` validates the snapshot is JSON-safe;
 *   `listRevisions` orders oldest-first (ascending `createdAt`, then id), and
 *   `pruneRevisions` deletes all but the newest N of an entry.
 * - **Public reads are bounded queries.** `listPublishedPosts` filters on
 *   `status`, orders, and pages in SQL over the summary columns only (never the
 *   `blocks`/`native` JSON). A term filter reads just the id/term columns of the
 *   published posts, because `categoryIds`/`tagIds` are JSON arrays that no
 *   portable SQL predicate can match, then loads the page's summaries by id.
 * - **Transactions.** `transaction(work)` runs `work` over repositories bound
 *   to one TypeORM transaction's entity manager; a nested call joins it.
 *
 * Reads run through the TypeORM repositories after the table check, so a
 * read-only `FileDataSource` (sqljs) can serve the read surface unchanged;
 * writes fail at the SQLite level there, as designed.
 */
import {
  In,
  type DataSource,
  type EntityManager,
  type FindOptionsWhere,
  type Repository,
} from 'typeorm';

import { createOwnedTables, JsailsError, type JsonValue } from 'jsails/plugin-sdk';
import { Encoding } from 'jsails/support';

import {
  comparePublishedPosts,
  createMenu,
  createPage,
  createPost,
  createRevision,
  createSetting,
  createTerm,
  mergeMenu,
  mergePage,
  mergePost,
  mergeTerm,
  transitionStatus,
} from '../cms/entity-builders.js';
import type {
  BlogMenu,
  BlogMenuCreateInput,
  BlogMenuUpdateInput,
  BlogPage,
  BlogPageCreateInput,
  BlogPageUpdateInput,
  BlogPost,
  BlogPostCreateInput,
  BlogPostPage,
  BlogPostSummary,
  BlogPostUpdateInput,
  BlogPublishedPostQuery,
  BlogRevision,
  BlogRevisionInput,
  BlogSetting,
  BlogTerm,
  BlogTermInput,
} from '../cms/model.js';
import type { BlogRepository } from '../cms/repository.js';
import {
  assertInputObject,
  assertPublishedQuery,
  assertRevisionKeep,
  createRepositoryClock,
  notFound,
  slugConflict,
  type RepositoryClock,
} from '../cms/repository-guards.js';
import {
  BLOG_CATEGORY_TABLE,
  BLOG_MENU_TABLE,
  BLOG_PAGE_TABLE,
  BLOG_POST_TABLE,
  BLOG_REVISION_TABLE,
  BLOG_SETTING_TABLE,
  BLOG_TAG_TABLE,
  JsailsBlogCategory,
  JsailsBlogMenu,
  JsailsBlogPage,
  JsailsBlogPost,
  JsailsBlogRevision,
  JsailsBlogSetting,
  JsailsBlogTag,
} from './entities.js';
import {
  rowToMenu,
  rowToPage,
  rowToPost,
  rowToPostSummary,
  rowToRevision,
  rowToSetting,
  rowToTerm,
  toDate,
} from './row-mapping.js';
import { withSlugConflict } from './unique-violation.js';

/** Machine-readable reason for a {@link BlogPersistenceError}. */
export type BlogPersistenceErrorCode = 'invalid_data_source' | 'missing_table';

/** Raised for a missing table or an invalid data-source option. Messages are value-free. */
export class BlogPersistenceError extends JsailsError {
  constructor(
    readonly code: BlogPersistenceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Options for {@link createDatabaseBlogRepository}. */
export interface DatabaseBlogRepositoryOptions {
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

/** Every table the repository requires, checked before the first query. */
const REQUIRED_TABLES = [
  BLOG_POST_TABLE,
  BLOG_PAGE_TABLE,
  BLOG_CATEGORY_TABLE,
  BLOG_TAG_TABLE,
  BLOG_SETTING_TABLE,
  BLOG_MENU_TABLE,
  BLOG_REVISION_TABLE,
] as const;

/** The initialized data source plus one TypeORM repository per content table. */
interface BlogTables {
  readonly source: DataSource;
  /** The entity manager every repository below is bound to. */
  readonly manager: EntityManager;
  /** True when `manager` already runs inside a transaction. */
  readonly inTransaction: boolean;
  readonly post: Repository<JsailsBlogPost>;
  readonly page: Repository<JsailsBlogPage>;
  readonly category: Repository<JsailsBlogCategory>;
  readonly tag: Repository<JsailsBlogTag>;
  readonly setting: Repository<JsailsBlogSetting>;
  readonly menu: Repository<JsailsBlogMenu>;
  readonly revision: Repository<JsailsBlogRevision>;
}

/** A category or tag row; the two entities share one column shape. */
type TaxonomyRow = JsailsBlogCategory | JsailsBlogTag;

/** The post columns a summary needs: everything but the rich-text body. */
const POST_SUMMARY_COLUMNS = [
  'post.id',
  'post.contentId',
  'post.title',
  'post.slug',
  'post.excerpt',
  'post.status',
  'post.authorId',
  'post.featuredMediaId',
  'post.categoryIds',
  'post.tagIds',
  'post.publishedAt',
  'post.createdAt',
  'post.updatedAt',
] as const;

/** Bind one repository per content table to an entity manager. */
function tablesFor(source: DataSource, manager: EntityManager, inTransaction: boolean): BlogTables {
  return {
    source,
    manager,
    inTransaction,
    post: manager.getRepository(JsailsBlogPost),
    page: manager.getRepository(JsailsBlogPage),
    category: manager.getRepository(JsailsBlogCategory),
    tag: manager.getRepository(JsailsBlogTag),
    setting: manager.getRepository(JsailsBlogSetting),
    menu: manager.getRepository(JsailsBlogMenu),
    revision: manager.getRepository(JsailsBlogRevision),
  };
}

/** True for a value with the TypeORM `DataSource` surface the repository uses. */
function isDataSource(value: unknown): value is DataSource {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { getRepository?: unknown }).getRepository === 'function' &&
    typeof (value as { initialize?: unknown }).initialize === 'function'
  );
}

/**
 * Delete one row by its repository-assigned id, raising `not_found` when no row
 * matched. A query builder keeps the delete key a scalar: `FindOptionsWhere`
 * over the recursive JSON columns exceeds TypeScript's instantiation depth.
 */
async function deleteByContentId<Row extends { contentId: string }>(
  repository: Repository<Row>,
  id: string,
  label: string,
): Promise<void> {
  const result = await repository
    .createQueryBuilder(label)
    .delete()
    .where('contentId = :contentId', { contentId: id })
    .execute();
  if (result.affected === 0) {
    throw notFound(label);
  }
}

/**
 * Raise `slug_conflict` when the slug is already taken in the table. The
 * pre-check makes the common duplicate path fail value-free without an INSERT;
 * the unique constraint (see `withSlugConflict`) is the concurrency backstop.
 */
async function assertSlugFree<Row extends { slug: string }>(
  repository: Repository<Row>,
  slug: string,
): Promise<void> {
  if (await repository.existsBy({ slug } as FindOptionsWhere<Row>)) {
    throw slugConflict();
  }
}

/** Copy the mutable post columns from a model value onto its row. */
function applyPost(row: JsailsBlogPost, post: BlogPost): JsailsBlogPost {
  row.title = post.title;
  row.slug = post.slug;
  row.excerpt = post.excerpt;
  row.blocks = post.blocks;
  row.editor = post.editor ?? null;
  row.native = post.native ?? null;
  row.status = post.status;
  row.featuredMediaId = post.featuredMediaId;
  row.categoryIds = post.categoryIds;
  row.tagIds = post.tagIds;
  row.publishedAt = post.publishedAt === null ? null : toDate(post.publishedAt);
  row.updatedAt = toDate(post.updatedAt);
  return row;
}

/** Copy the mutable page columns from a model value onto its row. */
function applyPage(row: JsailsBlogPage, page: BlogPage): JsailsBlogPage {
  row.title = page.title;
  row.slug = page.slug;
  row.blocks = page.blocks;
  row.editor = page.editor ?? null;
  row.native = page.native ?? null;
  row.status = page.status;
  row.parentId = page.parentId;
  row.sortOrder = page.sortOrder;
  row.updatedAt = toDate(page.updatedAt);
  return row;
}

/**
 * Build a database-backed {@link BlogRepository} over a TypeORM data source.
 * Option mistakes throw `TypeError`; a bad/missing table raises the value-free
 * {@link BlogPersistenceError}; per-operation failures raise the value-free
 * {@link BlogContentError}s detailed in the contract.
 */
export function createDatabaseBlogRepository(
  options: DatabaseBlogRepositoryOptions,
): BlogRepository {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createDatabaseBlogRepository requires an options object');
  }
  if (options.dataSource === undefined && options.getDataSource === undefined) {
    throw new TypeError('createDatabaseBlogRepository requires a dataSource or getDataSource');
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
  const clock = createRepositoryClock(
    options.nextId ?? (() => Encoding.nanoid()),
    options.now ?? (() => new Date()),
  );

  const owned = createOwnedTables({
    dataSource: () => {
      const resolved = resolveDataSource();
      if (!isDataSource(resolved)) {
        throw new BlogPersistenceError(
          'invalid_data_source',
          'the content data source must be a TypeORM data source',
        );
      }
      return resolved;
    },
    tables: REQUIRED_TABLES,
    initialize: true,
    makeError: (failure, table) =>
      new BlogPersistenceError(
        failure === 'missing_table' ? 'missing_table' : 'invalid_data_source',
        failure === 'missing_table'
          ? `the ${table ?? 'content'} table does not exist; run \`jsails db:push\` to create it`
          : 'the content data source is not initialized',
      ),
  });
  let tables: BlogTables | undefined;

  /** The table repositories over the probed data source, cached after the first open. */
  async function open(): Promise<BlogTables> {
    if (tables !== undefined) return tables;
    const source = await owned.open();
    tables = tablesFor(source, source.manager, false);
    return tables;
  }

  return databaseRepository(open, clock);
}

/**
 * The repository surface over a table resolver. The root repository resolves
 * the shared data source; a transaction builds another one over tables bound
 * to the transaction's entity manager.
 */
function databaseRepository(
  open: () => Promise<BlogTables>,
  clock: RepositoryClock,
): BlogRepository {
  const { makeId, stamp } = clock;

  // -- Posts ----------------------------------------------------------------

  async function findPostRow(id: string): Promise<JsailsBlogPost> {
    const row = await (await open()).post.findOne({ where: { contentId: id } });
    if (row === null) {
      throw notFound('post');
    }
    return row;
  }

  async function insertPost(input: BlogPostCreateInput): Promise<BlogPost> {
    assertInputObject(input, 'post');
    const repository = (await open()).post;
    const post = createPost(input, { id: makeId(), timestamp: stamp() });
    await assertSlugFree(repository, post.slug);
    const row = applyPost(
      repository.create({
        contentId: post.id,
        authorId: post.authorId,
        createdAt: toDate(post.createdAt),
      }),
      post,
    );
    return rowToPost(await withSlugConflict(() => repository.save(row)));
  }

  async function updatePost(id: string, input: BlogPostUpdateInput): Promise<BlogPost> {
    assertInputObject(input, 'post');
    const repository = (await open()).post;
    const current = await findPostRow(id);
    const post = mergePost(rowToPost(current), input, stamp());
    if (post.slug !== current.slug) {
      await assertSlugFree(repository, post.slug);
    }
    return rowToPost(await withSlugConflict(() => repository.save(applyPost(current, post))));
  }

  async function transitionPost(
    id: string,
    transition: 'publish' | 'unpublish',
  ): Promise<BlogPost> {
    const current = await findPostRow(id);
    const status = transitionStatus(current.status, transition);
    if (status === undefined) {
      return rowToPost(current);
    }
    const timestamp = toDate(stamp());
    current.status = status;
    if (status === 'published') {
      current.publishedAt = timestamp;
    }
    current.updatedAt = timestamp;
    return rowToPost(await (await open()).post.save(current));
  }

  // -- Pages ----------------------------------------------------------------

  async function findPageRow(id: string): Promise<JsailsBlogPage> {
    const row = await (await open()).page.findOne({ where: { contentId: id } });
    if (row === null) {
      throw notFound('page');
    }
    return row;
  }

  async function insertPage(input: BlogPageCreateInput): Promise<BlogPage> {
    assertInputObject(input, 'page');
    const repository = (await open()).page;
    const page = createPage(input, { id: makeId(), timestamp: stamp() });
    await assertSlugFree(repository, page.slug);
    const row = applyPage(
      repository.create({ contentId: page.id, createdAt: toDate(page.createdAt) }),
      page,
    );
    return rowToPage(await withSlugConflict(() => repository.save(row)));
  }

  async function updatePage(id: string, input: BlogPageUpdateInput): Promise<BlogPage> {
    assertInputObject(input, 'page');
    const repository = (await open()).page;
    const current = await findPageRow(id);
    const page = mergePage(rowToPage(current), input, stamp());
    if (page.slug !== current.slug) {
      await assertSlugFree(repository, page.slug);
    }
    return rowToPage(await withSlugConflict(() => repository.save(applyPage(current, page))));
  }

  async function transitionPage(
    id: string,
    transition: 'publish' | 'unpublish',
  ): Promise<BlogPage> {
    const current = await findPageRow(id);
    const status = transitionStatus(current.status, transition);
    if (status === undefined) {
      return rowToPage(current);
    }
    current.status = status;
    current.updatedAt = toDate(stamp());
    return rowToPage(await (await open()).page.save(current));
  }

  // -- Categories and tags --------------------------------------------------

  /**
   * One taxonomy's CRUD over its table. Categories and tags share the column
   * shape and the per-table slug namespace, so they share this code.
   */
  function taxonomyTable(select: (tables: BlogTables) => Repository<TaxonomyRow>, label: string) {
    const repository = async () => select(await open());

    return {
      async list(): Promise<readonly BlogTerm[]> {
        const rows = await (await repository()).find({ order: { name: 'ASC', id: 'ASC' } });
        return rows.map((row) => rowToTerm(row));
      },
      async get(id: string): Promise<BlogTerm | undefined> {
        const row = await (await repository()).findOne({ where: { contentId: id } });
        return row === null ? undefined : rowToTerm(row);
      },
      async getBySlug(slug: string): Promise<BlogTerm | undefined> {
        const row = await (await repository()).findOne({ where: { slug } });
        return row === null ? undefined : rowToTerm(row);
      },
      async create(input: BlogTermInput): Promise<BlogTerm> {
        assertInputObject(input, label);
        const table = await repository();
        const term = createTerm(input, makeId(), label);
        await assertSlugFree(table, term.slug);
        const row = await withSlugConflict(() =>
          table.save(
            table.create({
              contentId: term.id,
              name: term.name,
              slug: term.slug,
              description: term.description ?? null,
            }),
          ),
        );
        return rowToTerm(row);
      },
      async update(id: string, input: BlogTermInput): Promise<BlogTerm> {
        assertInputObject(input, label);
        const table = await repository();
        const current = await table.findOne({ where: { contentId: id } });
        if (current === null) {
          throw notFound(label);
        }
        const term = mergeTerm(rowToTerm(current), input, label);
        if (term.slug !== current.slug) {
          await assertSlugFree(table, term.slug);
        }
        current.name = term.name;
        current.slug = term.slug;
        current.description = term.description ?? null;
        return rowToTerm(await withSlugConflict(() => table.save(current)));
      },
      async delete(id: string): Promise<void> {
        await deleteByContentId(await repository(), id, label);
      },
    };
  }

  const categories = taxonomyTable((t) => t.category, 'category');
  const tags = taxonomyTable((t) => t.tag, 'tag');

  // -- Settings -------------------------------------------------------------

  async function setSetting(key: string, value: JsonValue): Promise<BlogSetting> {
    const setting = createSetting(key, value, stamp());
    const { source, manager: bound, inTransaction } = await open();
    const write = async (manager: EntityManager): Promise<void> => {
      const tx = manager.getRepository(JsailsBlogSetting);
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
    };
    // Inside an outer transaction the write joins it; otherwise the
    // read-then-write pair gets its own.
    await (inTransaction ? write(bound) : source.transaction(write));
    return setting;
  }

  async function getSetting(key: string): Promise<BlogSetting | undefined> {
    // TypeORM's `FindOptionsWhere` over the recursive `JsonValue` column
    // exceeds TypeScript's instantiation depth; a query builder keeps the
    // lookup key a scalar without the deep conditional type.
    const row = await (
      await open()
    ).setting
      .createQueryBuilder('setting')
      .where('setting.key = :key', { key })
      .getOne();
    return row === null ? undefined : rowToSetting(row);
  }

  // -- Menus ----------------------------------------------------------------

  async function insertMenu(input: BlogMenuCreateInput): Promise<BlogMenu> {
    assertInputObject(input, 'menu');
    const repository = (await open()).menu;
    const menu = createMenu(input, makeId());
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

  async function updateMenu(id: string, input: BlogMenuUpdateInput): Promise<BlogMenu> {
    assertInputObject(input, 'menu');
    const repository = (await open()).menu;
    const current = await repository.findOne({ where: { contentId: id } });
    if (current === null) {
      throw notFound('menu');
    }
    const menu = mergeMenu(rowToMenu(current), input);
    current.name = menu.name;
    current.location = menu.location;
    current.items = menu.items;
    return rowToMenu(await repository.save(current));
  }

  // -- Revisions ------------------------------------------------------------

  async function appendRevision(input: BlogRevisionInput): Promise<BlogRevision> {
    assertInputObject(input, 'revision');
    const revision = createRevision(input, { id: makeId(), timestamp: stamp() });
    const repository = (await open()).revision;
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

  async function pruneRevisions(entryType: string, entryId: string, keep: number): Promise<number> {
    assertRevisionKeep(keep);
    const repository = (await open()).revision;
    // Newest first by the same order `listRevisions` reverses; everything past
    // the first `keep` rows is deleted by surrogate id.
    const rows = await repository
      .createQueryBuilder('revision')
      .select(['revision.id'])
      .where('revision.entryType = :entryType AND revision.entryId = :entryId', {
        entryType,
        entryId,
      })
      .orderBy('revision.createdAt', 'DESC')
      .addOrderBy('revision.id', 'DESC')
      .offset(keep)
      .getMany();
    if (rows.length === 0) return 0;
    await repository
      .createQueryBuilder('revision')
      .delete()
      .where('id IN (:...ids)', { ids: rows.map((row) => row.id) })
      .execute();
    return rows.length;
  }

  /** Published-post summaries in listing order, paged in SQL. */
  async function publishedPage(limit: number, offset: number): Promise<BlogPostPage> {
    const [rows, total] = await (
      await open()
    ).post
      .createQueryBuilder('post')
      .select([...POST_SUMMARY_COLUMNS])
      .where('post.status = :status', { status: 'published' })
      .orderBy('post.publishedAt', 'DESC')
      .addOrderBy('post.createdAt', 'DESC')
      .addOrderBy('post.contentId', 'ASC')
      .offset(offset)
      .limit(limit)
      .getManyAndCount();
    return { posts: rows.map(rowToPostSummary), total };
  }

  /**
   * Published-post summaries in a term. Only the ids, order keys, and the
   * term columns of published posts are read to find the members; the page's
   * summaries are then loaded by id.
   */
  async function publishedTermPage(query: BlogPublishedPostQuery): Promise<BlogPostPage> {
    const { post } = await open();
    const members = await post
      .createQueryBuilder('post')
      .select([
        'post.id',
        'post.contentId',
        'post.publishedAt',
        'post.createdAt',
        'post.categoryIds',
        'post.tagIds',
      ])
      .where('post.status = :status', { status: 'published' })
      .getMany();
    const matched = members
      .filter(
        (row) =>
          (query.categoryId === undefined || row.categoryIds.includes(query.categoryId)) &&
          (query.tagId === undefined || row.tagIds.includes(query.tagId)),
      )
      .map((row) => ({
        id: row.contentId,
        publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      }))
      .sort(comparePublishedPosts);
    const ids = matched.slice(query.offset, query.offset + query.limit).map((entry) => entry.id);
    if (ids.length === 0) return { posts: [], total: matched.length };
    const rows = await post
      .createQueryBuilder('post')
      .select([...POST_SUMMARY_COLUMNS])
      .where('post.contentId IN (:...ids)', { ids })
      .getMany();
    const byId = new Map<string, BlogPostSummary>(
      rows.map((row) => [row.contentId, rowToPostSummary(row)]),
    );
    return {
      posts: ids
        .map((id) => byId.get(id))
        .filter((entry): entry is BlogPostSummary => entry !== undefined),
      total: matched.length,
    };
  }

  async function listPublishedPosts(query: BlogPublishedPostQuery): Promise<BlogPostPage> {
    assertPublishedQuery(query);
    if (query.categoryId !== undefined || query.tagId !== undefined) {
      return publishedTermPage(query);
    }
    return publishedPage(query.limit, query.offset);
  }

  const repository: BlogRepository = {
    async listPosts() {
      const rows = await (await open()).post.find({ order: { createdAt: 'ASC', id: 'ASC' } });
      return rows.map(rowToPost);
    },
    async getPost(id) {
      const row = await (await open()).post.findOne({ where: { contentId: id } });
      return row === null ? undefined : rowToPost(row);
    },
    async getPosts(ids) {
      if (ids.length === 0) return [];
      const rows = await (await open()).post.find({ where: { contentId: In([...ids]) } });
      return rows.map(rowToPost);
    },
    async getPostBySlug(slug) {
      const row = await (await open()).post.findOne({ where: { slug } });
      return row === null ? undefined : rowToPost(row);
    },
    listPublishedPosts,
    async listPostSummaries(query) {
      assertPublishedQuery(query);
      const [rows, total] = await (
        await open()
      ).post
        .createQueryBuilder('post')
        .select([...POST_SUMMARY_COLUMNS])
        .orderBy('post.createdAt', 'ASC')
        .addOrderBy('post.id', 'ASC')
        .offset(query.offset)
        .limit(query.limit)
        .getManyAndCount();
      return { posts: rows.map(rowToPostSummary), total };
    },
    createPost: insertPost,
    updatePost,
    publishPost: (id) => transitionPost(id, 'publish'),
    unpublishPost: (id) => transitionPost(id, 'unpublish'),
    deletePost: async (id) => deleteByContentId((await open()).post, id, 'post'),

    async listPages() {
      const rows = await (
        await open()
      ).page.find({
        order: { createdAt: 'ASC', id: 'ASC', sortOrder: 'ASC' },
      });
      return rows.map(rowToPage);
    },
    async getPage(id) {
      const row = await (await open()).page.findOne({ where: { contentId: id } });
      return row === null ? undefined : rowToPage(row);
    },
    createPage: insertPage,
    updatePage,
    publishPage: (id) => transitionPage(id, 'publish'),
    unpublishPage: (id) => transitionPage(id, 'unpublish'),
    deletePage: async (id) => deleteByContentId((await open()).page, id, 'page'),

    listCategories: categories.list,
    getCategory: categories.get,
    getCategoryBySlug: categories.getBySlug,
    createCategory: categories.create,
    updateCategory: categories.update,
    deleteCategory: categories.delete,

    listTags: tags.list,
    getTag: tags.get,
    getTagBySlug: tags.getBySlug,
    createTag: tags.create,
    updateTag: tags.update,
    deleteTag: tags.delete,

    async listSettings() {
      const rows = await (await open()).setting.find({ order: { key: 'ASC' } });
      return rows.map(rowToSetting);
    },
    getSetting,
    setSetting,

    async listMenus() {
      const rows = await (await open()).menu.find({ order: { name: 'ASC', id: 'ASC' } });
      return rows.map(rowToMenu);
    },
    async getMenu(id) {
      const row = await (await open()).menu.findOne({ where: { contentId: id } });
      return row === null ? undefined : rowToMenu(row);
    },
    createMenu: insertMenu,
    updateMenu,
    deleteMenu: async (id) => deleteByContentId((await open()).menu, id, 'menu'),

    async listRevisions(entryType, entryId) {
      const rows = await (
        await open()
      ).revision.find({
        where: { entryType, entryId },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      return rows.map(rowToRevision);
    },
    appendRevision,
    pruneRevisions,

    async transaction(work) {
      const { source, inTransaction } = await open();
      if (inTransaction) return work(repository);
      return source.transaction((manager) => {
        const bound = tablesFor(source, manager, true);
        return work(databaseRepository(async () => bound, clock));
      });
    },
  };
  return repository;
}
