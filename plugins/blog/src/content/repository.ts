/**
 * Tenant-free content repository: the persistence boundary for posts, pages,
 * categories, tags, settings, menus, and revisions.
 *
 * {@link createContentRepository} returns an in-memory {@link ContentRepository}
 * with injectable `now`/`nextId` clocks. It owns no TypeORM import and no
 * database: a future database-backed repository would map the same plain
 * values from `./model.js` into whatever storage the app selects without
 * changing this surface.
 *
 * ## Semantics
 *
 * - **Ids and timestamps are repository-owned.** Create methods assign `id`
 *   via `nextId`, stamp `createdAt`/`updatedAt`, and (for posts) set
 *   `publishedAt` when the entry is created `published`.
 * - **Slugs are unique per collection** (posts, pages, categories, tags —
 *   each its own namespace). Exact, case-sensitive match; a duplicate raises
 *   `slug_conflict`. The repository never slugifies: the caller owns slug
 *   generation.
 * - **Transitions.** `publish*` moves `draft`/`scheduled` → `published`
 *   (stamping `publishedAt` on posts) and is a no-op for an already-published
 *   entry; `unpublish*` moves `published`/`scheduled` → `draft` and is a
 *   no-op for an already-draft entry. Archiving is a later layer's operation,
 *   so an `archived` entry is unreachable here: `archived` is rejected at
 *   create time and any transition on it raises `invalid_status`.
 * - **Revisions** are append-only snapshots of an entry; `appendRevision`
 *   validates that the snapshot is JSON-safe (`invalid_snapshot`) but does not
 *   verify the referenced entry exists — the caller owns that correlation.
 *
 * ## Errors
 *
 * Every failure that reaches a caller is a value-free {@link ContentError}
 * (`invalid_input`, `not_found`, `slug_conflict`, `invalid_status`, or
 * `invalid_snapshot`). Returned entities are deep-frozen decoded values of the
 * model schemas, so neither the caller nor the map entry can mutate shared
 * state after a write.
 */

import { z } from 'zod';

import { Encoding } from 'jsails/support';
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
} from './model.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable reason for a {@link ContentError}. */
export type ContentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'slug_conflict'
  | 'invalid_status'
  | 'invalid_snapshot'
  | 'unsupported_construct';

/** Raised for every content failure that reaches a caller. Messages are value-free. */
export class ContentError extends Error {
  readonly code: ContentErrorCode;

  constructor(code: ContentErrorCode, message: string) {
    super(message);
    this.name = 'ContentError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/** The tenant-free content repository. */
export interface ContentRepository {
  // Posts
  listPosts(): Promise<readonly Post[]>;
  getPost(id: string): Promise<Post | undefined>;
  /**
   * Fetch several posts in one round trip. Search engines resolve a page of
   * hits through this instead of calling {@link getPost} per hit, which would
   * issue one query per result. Missing ids are omitted; order is not
   * guaranteed, so callers that need hit order must reorder.
   */
  getPosts(ids: readonly string[]): Promise<readonly Post[]>;
  createPost(input: PostCreateInput): Promise<Post>;
  updatePost(id: string, input: PostUpdateInput): Promise<Post>;
  publishPost(id: string): Promise<Post>;
  unpublishPost(id: string): Promise<Post>;
  deletePost(id: string): Promise<void>;

  // Pages
  listPages(): Promise<readonly Page[]>;
  getPage(id: string): Promise<Page | undefined>;
  createPage(input: PageCreateInput): Promise<Page>;
  updatePage(id: string, input: PageUpdateInput): Promise<Page>;
  publishPage(id: string): Promise<Page>;
  unpublishPage(id: string): Promise<Page>;
  deletePage(id: string): Promise<void>;

  // Categories
  listCategories(): Promise<readonly Category[]>;
  getCategory(id: string): Promise<Category | undefined>;
  createCategory(input: CategoryInput): Promise<Category>;
  updateCategory(id: string, input: CategoryInput): Promise<Category>;
  deleteCategory(id: string): Promise<void>;

  // Tags
  listTags(): Promise<readonly Tag[]>;
  getTag(id: string): Promise<Tag | undefined>;
  createTag(input: TagInput): Promise<Tag>;
  updateTag(id: string, input: TagInput): Promise<Tag>;
  deleteTag(id: string): Promise<void>;

  // Settings
  listSettings(): Promise<readonly Setting[]>;
  getSetting(key: string): Promise<Setting | undefined>;
  setSetting(key: string, value: JsonValue): Promise<Setting>;

  // Menus
  listMenus(): Promise<readonly Menu[]>;
  getMenu(id: string): Promise<Menu | undefined>;
  createMenu(input: MenuCreateInput): Promise<Menu>;
  updateMenu(id: string, input: MenuUpdateInput): Promise<Menu>;
  deleteMenu(id: string): Promise<void>;

  // Revisions
  listRevisions(entryType: string, entryId: string): Promise<readonly Revision[]>;
  appendRevision(input: RevisionInput): Promise<Revision>;
}

/** Options for {@link createContentRepository}. */
export interface ContentRepositoryOptions {
  /** Clock used to stamp timestamps. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Id generator. Defaults to a URL-safe random id. Must return a non-empty string. */
  readonly nextId?: () => string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maximum id length, matching the model's `idSchema` bound. */
const MAX_ID_LENGTH = 190;

/** Deep-freeze a plain object tree; primitives and `null` pass through. */
function deepFreeze<T extends object>(value: T): T {
  for (const key of Object.keys(value)) {
    const member = (value as Record<string, unknown>)[key];
    if (member !== null && typeof member === 'object') {
      deepFreeze(member);
    }
  }
  Object.freeze(value);
  return value;
}

/** True for a collection entry surface; used only for slug-conflict scans. */
interface Sluggable {
  readonly id: string;
  readonly slug: string;
}

// ---------------------------------------------------------------------------
// createContentRepository
// ---------------------------------------------------------------------------

/**
 * Build an in-memory {@link ContentRepository}. Option mistakes throw
 * `TypeError`; per-operation failures raise the value-free {@link ContentError}s
 * detailed in the module doc.
 */
export function createContentRepository(options: ContentRepositoryOptions = {}): ContentRepository {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createContentRepository requires an options object');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }
  if (options.nextId !== undefined && typeof options.nextId !== 'function') {
    throw new TypeError('nextId must be a function');
  }

  const now = options.now ?? (() => new Date());
  const nextId = options.nextId ?? (() => Encoding.nanoid());

  const posts = new Map<string, Post>();
  const pages = new Map<string, Page>();
  const categories = new Map<string, Category>();
  const tags = new Map<string, Tag>();
  const settings = new Map<string, Setting>();
  const menus = new Map<string, Menu>();
  const revisions: Revision[] = [];

  /** Stamp the current instant as an ISO string from the injected clock. */
  function stamp(): string {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new ContentError('invalid_input', 'now must return a valid Date');
    }
    return value.toISOString();
  }

  /** Produce and validate a non-empty id from the injected generator. */
  function makeId(): string {
    const id = nextId();
    if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LENGTH) {
      throw new ContentError('invalid_input', 'nextId must return a non-empty string id');
    }
    return id;
  }

  /** Reject a non-object input with a value-free `invalid_input`. */
  function assertObject(value: unknown, label: string): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ContentError('invalid_input', `${label} input must be an object`);
    }
  }

  /** Validate and decode an entity against its schema, failing value-free. */
  function parseEntity<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
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

  /** Raise `slug_conflict` when another entry in the collection uses the slug. */
  function assertNoSlugConflict(
    entries: readonly Sluggable[],
    selfId: string | null,
    slug: string,
  ): void {
    if (entries.some((entry) => entry.id !== selfId && entry.slug === slug)) {
      throw new ContentError('slug_conflict', 'slug is already in use');
    }
  }

  /** Raise `not_found` for a missing entity of the given collection. */
  function notFound(label: string): ContentError {
    return new ContentError('not_found', `${label} not found`);
  }

  // -- Posts ----------------------------------------------------------------

  async function createPost(input: PostCreateInput): Promise<Post> {
    assertObject(input, 'post');
    assertCreatableStatus(input.status);
    const timestamp = stamp();
    const post = parseEntity(
      postSchema,
      {
        id: makeId(),
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
    assertNoSlugConflict([...posts.values()], null, post.slug);
    const frozen = deepFreeze(post);
    posts.set(frozen.id, frozen);
    return frozen;
  }

  async function updatePost(id: string, input: PostUpdateInput): Promise<Post> {
    const current = posts.get(id);
    if (current === undefined) {
      throw notFound('post');
    }
    assertObject(input, 'post');
    const post = parseEntity(
      postSchema,
      {
        id: current.id,
        title: input.title ?? current.title,
        slug: input.slug ?? current.slug,
        excerpt: input.excerpt ?? current.excerpt,
        blocks: input.blocks ?? current.blocks,
        ...(input.editor !== undefined
          ? { editor: input.editor }
          : current.editor === undefined
            ? {}
            : { editor: current.editor }),
        ...(input.native !== undefined
          ? { native: input.native }
          : current.native === undefined
            ? {}
            : { native: current.native }),
        status: current.status,
        authorId: current.authorId,
        featuredMediaId:
          input.featuredMediaId === undefined ? current.featuredMediaId : input.featuredMediaId,
        categoryIds: input.categoryIds ?? current.categoryIds,
        tagIds: input.tagIds ?? current.tagIds,
        publishedAt: current.publishedAt,
        createdAt: current.createdAt,
        updatedAt: stamp(),
      },
      'post',
    );
    assertNoSlugConflict([...posts.values()], current.id, post.slug);
    const frozen = deepFreeze(post);
    posts.set(frozen.id, frozen);
    return frozen;
  }

  async function publishPost(id: string): Promise<Post> {
    const current = posts.get(id);
    if (current === undefined) {
      throw notFound('post');
    }
    if (current.status === 'published') {
      return current;
    }
    if (current.status === 'archived') {
      throw new ContentError('invalid_status', 'cannot publish an archived entry');
    }
    const timestamp = stamp();
    const frozen = deepFreeze({
      ...current,
      status: 'published' as const,
      publishedAt: timestamp,
      updatedAt: timestamp,
    });
    posts.set(frozen.id, frozen);
    return frozen;
  }

  async function unpublishPost(id: string): Promise<Post> {
    const current = posts.get(id);
    if (current === undefined) {
      throw notFound('post');
    }
    if (current.status === 'draft') {
      return current;
    }
    if (current.status === 'archived') {
      throw new ContentError('invalid_status', 'cannot unpublish an archived entry');
    }
    const frozen = deepFreeze({
      ...current,
      status: 'draft' as const,
      updatedAt: stamp(),
    });
    posts.set(frozen.id, frozen);
    return frozen;
  }

  async function deletePost(id: string): Promise<void> {
    if (!posts.delete(id)) {
      throw notFound('post');
    }
  }

  // -- Pages ----------------------------------------------------------------

  async function createPage(input: PageCreateInput): Promise<Page> {
    assertObject(input, 'page');
    assertCreatableStatus(input.status);
    const timestamp = stamp();
    const page = parseEntity(
      pageSchema,
      {
        id: makeId(),
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
    assertNoSlugConflict([...pages.values()], null, page.slug);
    const frozen = deepFreeze(page);
    pages.set(frozen.id, frozen);
    return frozen;
  }

  async function updatePage(id: string, input: PageUpdateInput): Promise<Page> {
    const current = pages.get(id);
    if (current === undefined) {
      throw notFound('page');
    }
    assertObject(input, 'page');
    const page = parseEntity(
      pageSchema,
      {
        id: current.id,
        title: input.title ?? current.title,
        slug: input.slug ?? current.slug,
        blocks: input.blocks ?? current.blocks,
        ...(input.editor !== undefined
          ? { editor: input.editor }
          : current.editor === undefined
            ? {}
            : { editor: current.editor }),
        ...(input.native !== undefined
          ? { native: input.native }
          : current.native === undefined
            ? {}
            : { native: current.native }),
        status: current.status,
        parentId: input.parentId === undefined ? current.parentId : input.parentId,
        sortOrder: input.sortOrder ?? current.sortOrder,
        createdAt: current.createdAt,
        updatedAt: stamp(),
      },
      'page',
    );
    assertNoSlugConflict([...pages.values()], current.id, page.slug);
    const frozen = deepFreeze(page);
    pages.set(frozen.id, frozen);
    return frozen;
  }

  async function publishPage(id: string): Promise<Page> {
    const current = pages.get(id);
    if (current === undefined) {
      throw notFound('page');
    }
    if (current.status === 'published') {
      return current;
    }
    if (current.status === 'archived') {
      throw new ContentError('invalid_status', 'cannot publish an archived entry');
    }
    const frozen = deepFreeze({
      ...current,
      status: 'published' as const,
      updatedAt: stamp(),
    });
    pages.set(frozen.id, frozen);
    return frozen;
  }

  async function unpublishPage(id: string): Promise<Page> {
    const current = pages.get(id);
    if (current === undefined) {
      throw notFound('page');
    }
    if (current.status === 'draft') {
      return current;
    }
    if (current.status === 'archived') {
      throw new ContentError('invalid_status', 'cannot unpublish an archived entry');
    }
    const frozen = deepFreeze({
      ...current,
      status: 'draft' as const,
      updatedAt: stamp(),
    });
    pages.set(frozen.id, frozen);
    return frozen;
  }

  async function deletePage(id: string): Promise<void> {
    if (!pages.delete(id)) {
      throw notFound('page');
    }
  }

  // -- Categories -----------------------------------------------------------

  async function createCategory(input: CategoryInput): Promise<Category> {
    assertObject(input, 'category');
    const category = parseEntity(
      categorySchema,
      {
        id: makeId(),
        name: input.name,
        slug: input.slug,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      'category',
    );
    assertNoSlugConflict([...categories.values()], null, category.slug);
    const frozen = deepFreeze(category);
    categories.set(frozen.id, frozen);
    return frozen;
  }

  async function updateCategory(id: string, input: CategoryInput): Promise<Category> {
    const current = categories.get(id);
    if (current === undefined) {
      throw notFound('category');
    }
    assertObject(input, 'category');
    const category = parseEntity(
      categorySchema,
      {
        id: current.id,
        name: input.name,
        slug: input.slug,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      'category',
    );
    assertNoSlugConflict([...categories.values()], current.id, category.slug);
    const frozen = deepFreeze(category);
    categories.set(frozen.id, frozen);
    return frozen;
  }

  async function deleteCategory(id: string): Promise<void> {
    if (!categories.delete(id)) {
      throw notFound('category');
    }
  }

  // -- Tags -----------------------------------------------------------------

  async function createTag(input: TagInput): Promise<Tag> {
    assertObject(input, 'tag');
    const tag = parseEntity(
      tagSchema,
      {
        id: makeId(),
        name: input.name,
        slug: input.slug,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      'tag',
    );
    assertNoSlugConflict([...tags.values()], null, tag.slug);
    const frozen = deepFreeze(tag);
    tags.set(frozen.id, frozen);
    return frozen;
  }

  async function updateTag(id: string, input: TagInput): Promise<Tag> {
    const current = tags.get(id);
    if (current === undefined) {
      throw notFound('tag');
    }
    assertObject(input, 'tag');
    const tag = parseEntity(
      tagSchema,
      {
        id: current.id,
        name: input.name,
        slug: input.slug,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      'tag',
    );
    assertNoSlugConflict([...tags.values()], current.id, tag.slug);
    const frozen = deepFreeze(tag);
    tags.set(frozen.id, frozen);
    return frozen;
  }

  async function deleteTag(id: string): Promise<void> {
    if (!tags.delete(id)) {
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
    const setting = parseEntity(
      settingSchema,
      { key, value: parsedValue.data, updatedAt: stamp() },
      'setting',
    );
    const frozen = deepFreeze(setting);
    settings.set(frozen.key, frozen);
    return frozen;
  }

  // -- Menus ----------------------------------------------------------------

  async function createMenu(input: MenuCreateInput): Promise<Menu> {
    assertObject(input, 'menu');
    const menu = parseEntity(
      menuSchema,
      {
        id: makeId(),
        name: input.name,
        location: input.location,
        items: [...input.items],
      },
      'menu',
    );
    const frozen = deepFreeze(menu);
    menus.set(frozen.id, frozen);
    return frozen;
  }

  async function updateMenu(id: string, input: MenuUpdateInput): Promise<Menu> {
    const current = menus.get(id);
    if (current === undefined) {
      throw notFound('menu');
    }
    assertObject(input, 'menu');
    const menu = parseEntity(
      menuSchema,
      {
        id: current.id,
        name: input.name ?? current.name,
        location: input.location ?? current.location,
        items: input.items ?? current.items,
      },
      'menu',
    );
    const frozen = deepFreeze(menu);
    menus.set(frozen.id, frozen);
    return frozen;
  }

  async function deleteMenu(id: string): Promise<void> {
    if (!menus.delete(id)) {
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
    const revision = parseEntity(
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
    const frozen = deepFreeze(revision);
    revisions.push(frozen);
    return frozen;
  }

  async function listRevisions(entryType: string, entryId: string): Promise<readonly Revision[]> {
    return revisions.filter(
      (revision) => revision.entryType === entryType && revision.entryId === entryId,
    );
  }

  return {
    // Posts
    listPosts: async () => [...posts.values()],
    getPost: async (id) => posts.get(id),
    getPosts: async (ids) => {
      const found: Post[] = [];
      for (const id of ids) {
        const post = posts.get(id);
        if (post !== undefined) found.push(post);
      }
      return found;
    },
    createPost,
    updatePost,
    publishPost,
    unpublishPost,
    deletePost,

    // Pages
    listPages: async () => [...pages.values()],
    getPage: async (id) => pages.get(id),
    createPage,
    updatePage,
    publishPage,
    unpublishPage,
    deletePage,

    // Categories
    listCategories: async () => [...categories.values()],
    getCategory: async (id) => categories.get(id),
    createCategory,
    updateCategory,
    deleteCategory,

    // Tags
    listTags: async () => [...tags.values()],
    getTag: async (id) => tags.get(id),
    createTag,
    updateTag,
    deleteTag,

    // Settings
    listSettings: async () => [...settings.values()],
    getSetting: async (key) => settings.get(key),
    setSetting,

    // Menus
    listMenus: async () => [...menus.values()],
    getMenu: async (id) => menus.get(id),
    createMenu,
    updateMenu,
    deleteMenu,

    // Revisions
    listRevisions,
    appendRevision,
  };
}
