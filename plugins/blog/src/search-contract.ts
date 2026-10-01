/**
 * Search contract for the blog.
 *
 * {@link BlogSearchEngine} is the engine-neutral boundary: the blog plugin and
 * admin call `search`/`index`/`remove`/`reindex` and never know whether the
 * backing store is the in-repository scan in `search-database.ts`, Orama, or an
 * external engine (Meilisearch/Typesense/OpenSearch). {@link createBlogSearch}
 * resolves the default engine for a repository.
 */

import { createServiceToken, type ServiceToken } from 'jsails/extensions';

import { createContentRepository, type ContentRepository, type Post } from './content/index.js';
import { createDatabaseBlogSearch } from './search-database.js';

/**
 * Options for {@link BlogSearchEngine.search}. `limit`/`page` bound the result
 * window; a malformed value is ignored and falls back to the default.
 */
export interface BlogSearchOptions {
  /** Page to return, 1-based; non-positive-integer values fall back to 1. */
  readonly page?: number;
  /** Maximum posts per page; non-positive-integer values fall back to the default. */
  readonly limit?: number;
}

/** Result of a search: the matched posts plus the total number of matches. */
export interface BlogSearchResult {
  readonly posts: readonly Post[];
  readonly total: number;
}

/**
 * Engine-neutral search boundary for the blog. Matching is over published posts
 * only; a draft/scheduled/archived post is never returned, and removing a post
 * from the index makes it unsearchable.
 */
export interface BlogSearchEngine {
  /** Search published posts for `query`; an empty query matches all published posts. */
  search(query: string, options?: BlogSearchOptions): Promise<BlogSearchResult>;
  /** Add/replace one post in the index (a no-op for the repository-scanning engine). */
  index(post: Post): Promise<void>;
  /** Drop one post from the index (a no-op for the repository-scanning engine). */
  remove(id: string): Promise<void>;
  /** Rebuild the index from the given posts (a no-op for the repository-scanning engine). */
  reindex(posts: readonly Post[]): Promise<void>;
}

/** Default page size for the blog search engines. */
export const BLOG_SEARCH_PAGE_SIZE = 10;

/** Typed service token for the blog search engine. */
export const blogSearchToken: ServiceToken<BlogSearchEngine> =
  createServiceToken<BlogSearchEngine>('blogSearch');

/**
 * Build a search engine backed by the given repository, or a fresh in-memory
 * one when omitted. Returns the engine plus the repository it resolved, so a
 * caller can hand the same repository to both the blog surfaces and the engine.
 */
export function createBlogSearch(repository?: ContentRepository): {
  readonly repository: ContentRepository;
  readonly engine: BlogSearchEngine;
} {
  const resolved = repository ?? createContentRepository();
  return { repository: resolved, engine: createDatabaseBlogSearch({ repository: resolved }) };
}
