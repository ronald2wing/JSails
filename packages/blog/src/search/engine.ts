/**
 * {@link createBlogSearchEngine}: one config-driven entry point that builds any
 * of the blog's search engines by driver name.
 */

import type { BlogRepository } from '../cms/index.js';
import type { BlogSearchEngine } from './contract.js';
import { createDatabaseBlogSearch } from './database.js';
import { BlogSearchError } from './http-driver.js';
import { createMeilisearchBlogSearch } from './meilisearch.js';
import { createOpenSearchBlogSearch } from './opensearch.js';
import { createOramaBlogSearch } from './orama.js';
import { createTypesenseBlogSearch } from './typesense.js';

/** The engine a {@link createBlogSearchEngine} call targets. */
export type BlogSearchDriver = 'orama' | 'database' | 'meilisearch' | 'typesense' | 'opensearch';

/** Options for {@link createBlogSearchEngine}. */
export interface BlogSearchEngineOptions {
  /** Which backing engine to build. */
  readonly driver: BlogSearchDriver;
  /** The post repository, used to map remote hit ids back to published posts. */
  readonly repository: BlogRepository;
  /** Base URL of an external engine, e.g. `https://search.example.com`. */
  readonly url?: string;
  /** API key for engines that require authentication. */
  readonly apiKey?: string;
  /** Index (or Typesense collection) name; defaults to `blog-posts`. */
  readonly index?: string;
  /** `fetch` implementation; defaults to the global `fetch`, injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Build a {@link BlogSearchEngine} for the requested {@link BlogSearchDriver}.
 *
 * `database` and `orama` run in-process over the repository. The HTTP drivers
 * validate their URL and index name (and API key where required) eagerly but
 * never connect at construction — the first operation performs the first
 * request. Construction mistakes and per-operation failures raise the
 * value-free {@link BlogSearchError}.
 */
export function createBlogSearchEngine(options: BlogSearchEngineOptions): BlogSearchEngine {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new BlogSearchError('invalid_config', 'search engine options must be an object');
  }
  const { driver, repository, url, apiKey, index } = options;
  if (repository === undefined) {
    throw new BlogSearchError('invalid_config', 'a repository is required');
  }
  const http = { repository, fetch: options.fetch ?? globalThis.fetch, url, apiKey, index };
  switch (driver) {
    case 'database':
      return createDatabaseBlogSearch({ repository });
    case 'orama':
      return createOramaBlogSearch({ repository });
    case 'meilisearch':
      return createMeilisearchBlogSearch(http);
    case 'typesense':
      return createTypesenseBlogSearch(http);
    case 'opensearch':
      return createOpenSearchBlogSearch(http);
    default:
      throw new BlogSearchError('invalid_config', 'unknown search driver');
  }
}
