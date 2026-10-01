/**
 * The blog repository contract: the persistence boundary for posts, pages,
 * categories, tags, settings, menus, and revisions.
 *
 * Two implementations share these semantics: the in-memory
 * `createMemoryBlogRepository` (`./memory-repository.ts`) and the TypeORM-backed
 * `createDatabaseBlogRepository` (`../persistence/database-repository.ts`).
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
 * - **Revisions** are snapshots of an entry; `appendRevision` validates that
 *   the snapshot is JSON-safe (`invalid_snapshot`) but does not verify the
 *   referenced entry exists — the caller owns that correlation.
 *   `pruneRevisions` keeps only the newest N of an entry, so a retention policy
 *   bounds how much history an often-saved entry carries.
 * - **Public reads are query-shaped.** `listPublishedPosts` returns one page of
 *   published post summaries (no rich-text body) plus the total, ordered
 *   `publishedAt` desc, `createdAt` desc, then id; the slug lookups resolve one
 *   row. A public route never needs `listPosts`, which loads every post in full.
 * - **Transactions.** `transaction(work)` runs `work` against a repository whose
 *   writes commit together or not at all; a nested call joins the outer one.
 *
 * ## Errors
 *
 * Every failure that reaches a caller is a value-free {@link BlogContentError}
 * (`invalid_input`, `not_found`, `slug_conflict`, `invalid_status`, or
 * `invalid_snapshot`).
 */

import type { JsonValue } from 'jsails/plugin-sdk';
import { JsailsError } from 'jsails/support';

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
  BlogPostSummaryQuery,
  BlogPostUpdateInput,
  BlogPublishedPostQuery,
  BlogRevision,
  BlogRevisionInput,
  BlogSetting,
  BlogTerm,
  BlogTermInput,
} from './model.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable reason for a {@link BlogContentError}. */
export type BlogContentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'slug_conflict'
  | 'invalid_status'
  | 'invalid_snapshot'
  | 'unsupported_construct';

/** Raised for every content failure that reaches a caller. Messages are value-free. */
export class BlogContentError extends JsailsError {
  constructor(
    readonly code: BlogContentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/** The tenant-free content repository. */
export interface BlogRepository {
  // Posts
  listPosts(): Promise<readonly BlogPost[]>;
  getPost(id: string): Promise<BlogPost | undefined>;
  /**
   * Fetch several posts in one round trip. Search engines resolve a page of
   * hits through this instead of calling {@link getPost} per hit, which would
   * issue one query per result. Missing ids are omitted; order is not
   * guaranteed, so callers that need hit order must reorder.
   */
  getPosts(ids: readonly string[]): Promise<readonly BlogPost[]>;
  /** The post with this slug, whatever its status, or `undefined`. */
  getPostBySlug(slug: string): Promise<BlogPost | undefined>;
  /**
   * One page of published post summaries plus the total match count. A
   * malformed `limit`/`offset` raises `invalid_input`.
   */
  listPublishedPosts(query: BlogPublishedPostQuery): Promise<BlogPostPage>;
  /**
   * One page of post summaries of every status in `listPosts` order, plus the
   * total: the admin list reads this instead of loading every body.
   */
  listPostSummaries(query: BlogPostSummaryQuery): Promise<BlogPostPage>;
  createPost(input: BlogPostCreateInput): Promise<BlogPost>;
  updatePost(id: string, input: BlogPostUpdateInput): Promise<BlogPost>;
  publishPost(id: string): Promise<BlogPost>;
  unpublishPost(id: string): Promise<BlogPost>;
  deletePost(id: string): Promise<void>;

  // Pages
  listPages(): Promise<readonly BlogPage[]>;
  getPage(id: string): Promise<BlogPage | undefined>;
  createPage(input: BlogPageCreateInput): Promise<BlogPage>;
  updatePage(id: string, input: BlogPageUpdateInput): Promise<BlogPage>;
  publishPage(id: string): Promise<BlogPage>;
  unpublishPage(id: string): Promise<BlogPage>;
  deletePage(id: string): Promise<void>;

  // Categories
  listCategories(): Promise<readonly BlogTerm[]>;
  getCategory(id: string): Promise<BlogTerm | undefined>;
  getCategoryBySlug(slug: string): Promise<BlogTerm | undefined>;
  createCategory(input: BlogTermInput): Promise<BlogTerm>;
  updateCategory(id: string, input: BlogTermInput): Promise<BlogTerm>;
  deleteCategory(id: string): Promise<void>;

  // Tags
  listTags(): Promise<readonly BlogTerm[]>;
  getTag(id: string): Promise<BlogTerm | undefined>;
  getTagBySlug(slug: string): Promise<BlogTerm | undefined>;
  createTag(input: BlogTermInput): Promise<BlogTerm>;
  updateTag(id: string, input: BlogTermInput): Promise<BlogTerm>;
  deleteTag(id: string): Promise<void>;

  // Settings
  listSettings(): Promise<readonly BlogSetting[]>;
  getSetting(key: string): Promise<BlogSetting | undefined>;
  setSetting(key: string, value: JsonValue): Promise<BlogSetting>;

  // Menus
  listMenus(): Promise<readonly BlogMenu[]>;
  getMenu(id: string): Promise<BlogMenu | undefined>;
  createMenu(input: BlogMenuCreateInput): Promise<BlogMenu>;
  updateMenu(id: string, input: BlogMenuUpdateInput): Promise<BlogMenu>;
  deleteMenu(id: string): Promise<void>;

  // Revisions
  listRevisions(entryType: string, entryId: string): Promise<readonly BlogRevision[]>;
  appendRevision(input: BlogRevisionInput): Promise<BlogRevision>;
  /**
   * Delete all but the newest `keep` revisions of one entry and return how many
   * were removed. `keep` must be a non-negative integer (`invalid_input`).
   */
  pruneRevisions(entryType: string, entryId: string, keep: number): Promise<number>;

  // Transactions
  /**
   * Run `work` against a repository whose writes commit together: when `work`
   * throws, none of them persist. Calling `transaction` inside `work` joins the
   * outer transaction.
   */
  transaction<T>(work: (repository: BlogRepository) => Promise<T>): Promise<T>;
}
