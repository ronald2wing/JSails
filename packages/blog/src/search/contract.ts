/**
 * Search contract for the blog.
 *
 * {@link BlogSearchEngine} is the engine-neutral boundary: the blog plugin and
 * admin call `search`/`index`/`remove`/`reindex` and never know whether the
 * backing store is the repository scan (`./database.ts`), Orama, or an external
 * engine (Meilisearch/Typesense/OpenSearch).
 */

import { createServiceToken, type ServiceToken } from 'jsails/extensions';
import { isPositiveInteger } from 'jsails/plugin-sdk';

import type { BlogPost } from '../cms/index.js';

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
  readonly posts: readonly BlogPost[];
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
  index(post: BlogPost): Promise<void>;
  /** Drop one post from the index (a no-op for the repository-scanning engine). */
  remove(id: string): Promise<void>;
  /** Rebuild the index from the given posts (a no-op for the repository-scanning engine). */
  reindex(posts: readonly BlogPost[]): Promise<void>;
}

/** Default page size for the blog search engines. */
export const BLOG_SEARCH_PAGE_SIZE = 10;

/** Largest page a search caller may request; larger values are clamped. */
const BLOG_SEARCH_MAX_PAGE_SIZE = 100;

/** Typed service token for the blog search engine. */
export const blogSearchToken: ServiceToken<BlogSearchEngine> =
  createServiceToken<BlogSearchEngine>('blogSearch');

/** A normalized result window: 1-based page, page size, and zero-based offset. */
export interface SearchWindow {
  readonly page: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Normalize {@link BlogSearchOptions} into a window, applying the contract's
 * fallbacks (page 1, {@link BLOG_SEARCH_PAGE_SIZE}) to malformed values.
 */
export function searchWindow(options: BlogSearchOptions = {}): SearchWindow {
  const page = isPositiveInteger(options.page) ? options.page : 1;
  const limit = isPositiveInteger(options.limit)
    ? Math.min(options.limit, BLOG_SEARCH_MAX_PAGE_SIZE)
    : BLOG_SEARCH_PAGE_SIZE;
  return { page, limit, offset: (page - 1) * limit };
}
