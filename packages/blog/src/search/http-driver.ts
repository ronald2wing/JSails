/**
 * The shared boundary for the external search drivers (Meilisearch, Typesense,
 * OpenSearch): config validation, the value-free error type, the HTTP/JSON
 * request seam, the indexed document shape, and the engine assembly.
 *
 * Each driver maintains its own remote index and maps hits back through the
 * repository (`resolvePublishedHits`), so a returned post is always a published
 * repository `Post`. Indexing is a real write: a published post is upserted and
 * any other post is removed from the remote index, so an unpublished post can
 * never surface in a search.
 *
 * No dependency is added: all three engines speak plain HTTP/JSON over a
 * `fetch` injected at construction, so tests substitute a double and no driver
 * touches the network in the default suite. A driver never connects at
 * construction; the first operation performs the first request. Every request
 * is bounded by a timeout (`timeoutMs`, default 5 s), so a stalled engine fails
 * fast with `request_failed` instead of holding a public search or an admin save
 * open until the platform's socket timeouts. `reindex` sends published posts
 * through each engine's bulk endpoint in batches.
 */

import { trimTrailingSlashes } from '@jsails/content';
import { JsailsError } from 'jsails/errors';

import type { BlogRepository, BlogPost } from '../cms/index.js';
import type { BlogSearchEngine, BlogSearchOptions, BlogSearchResult } from './contract.js';
import { postBodyText } from './post-document.js';

/** Machine-readable reason for a {@link BlogSearchError}. */
export type BlogSearchErrorCode = 'invalid_config' | 'request_failed' | 'bad_response';

/**
 * Raised for every external-search failure that reaches a caller. Messages are
 * value-free: they never echo a query, URL, document id, or payload, because
 * those values are caller input and must not round-trip into logs or responses.
 */
export class BlogSearchError extends JsailsError {
  constructor(
    readonly code: BlogSearchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Construction options every HTTP driver accepts. */
export interface HttpDriverOptions {
  /** The post repository, used to map remote hit ids back to published posts. */
  readonly repository: BlogRepository;
  /** The `fetch` implementation every request goes through. */
  readonly fetch: typeof globalThis.fetch;
  /** Base URL of the search engine, e.g. `https://search.example.com`. */
  readonly url?: string;
  /** API key for engines that require authentication. */
  readonly apiKey?: string;
  /** Index (or Typesense collection) name; defaults to `blog-posts`. */
  readonly index?: string;
  /** Per-request timeout in milliseconds; defaults to {@link BLOG_SEARCH_DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Default per-request timeout for the external search drivers. */
export const BLOG_SEARCH_DEFAULT_TIMEOUT_MS = 5_000;

/** Largest accepted `timeoutMs`. */
const MAX_TIMEOUT_MS = 120_000;

/** Posts sent per bulk request during `reindex`. */
export const REINDEX_BATCH_SIZE = 100;

/** Validate a per-request timeout, value-free on rejection. */
export function cleanTimeout(value: number | undefined): number {
  const timeout = value ?? BLOG_SEARCH_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new BlogSearchError('invalid_config', 'the search timeout must be 1 to 120000 ms');
  }
  return timeout;
}

/** A driver's bound request function: the `fetch` seam plus the timeout. */
export type DriverRequest = (url: string, init: RequestInit) => Promise<Response>;

/** Bind the `fetch` implementation and the validated timeout of a driver. */
export function driverRequest(options: HttpDriverOptions): DriverRequest {
  const timeoutMs = cleanTimeout(options.timeoutMs);
  return (url, init) => request(options.fetch, url, init, timeoutMs);
}

/** Validate an http(s) base URL (trailing slashes dropped), value-free on rejection. */
export function cleanUrl(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new BlogSearchError('invalid_config', 'a search engine URL is required');
  }
  const url = trimTrailingSlashes(value);
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new BlogSearchError('invalid_config', 'the search engine URL is not a valid URL');
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new BlogSearchError('invalid_config', 'the search engine URL must be http or https');
  }
  return url;
}

/** Validate an index/collection name as a safe slug, value-free on rejection. */
export function cleanIndex(value: string | undefined): string {
  const index = value === undefined || value === '' ? 'blog-posts' : value;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(index)) {
    throw new BlogSearchError('invalid_config', 'the search index name is not a safe slug');
  }
  return index;
}

/** Require an API key for a driver that authenticates, value-free on rejection. */
export function requireKey(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new BlogSearchError('invalid_config', 'an API key is required for this search engine');
  }
  return value;
}

/**
 * Send a request, aborting it after `timeoutMs`, and map a network failure or
 * a timeout to a value-free error.
 */
export function request(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number = BLOG_SEARCH_DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    init.signal === undefined || init.signal === null
      ? timeout
      : AbortSignal.any([init.signal, timeout]);
  return fetchImpl(url, { ...init, signal }).catch(() => {
    throw new BlogSearchError('request_failed', 'the search engine request failed');
  });
}

/** Read a JSON body, mapping a non-JSON or non-2xx response to value-free errors. */
export async function jsonOrError(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new BlogSearchError('bad_response', 'the search engine rejected the request');
  }
  try {
    return await response.json();
  } catch {
    throw new BlogSearchError('bad_response', 'the search engine returned invalid JSON');
  }
}

/** Coerce an engine-reported total, falling back when it is not a finite number. */
export function totalOf(raw: unknown, fallback: number): number {
  const total = Number(raw ?? fallback);
  return Number.isFinite(total) ? total : fallback;
}

/** Keep only string ids from a list of raw engine hit ids. */
export function stringIds(raw: readonly unknown[]): string[] {
  return raw.filter((id): id is string => typeof id === 'string');
}

/** The engine-neutral document a published post upserts into an external index. */
export function documentFor(post: BlogPost): Record<string, unknown> {
  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    body: postBodyText(post),
    status: post.status,
    publishedAt: post.publishedAt,
  };
}

/** The per-engine operations an HTTP driver implements. */
export interface HttpDriverOperations {
  search(query: string, options?: BlogSearchOptions): Promise<BlogSearchResult>;
  upsert(post: BlogPost): Promise<void>;
  /** Upsert a batch of published posts in one bulk request. */
  upsertMany(posts: readonly BlogPost[]): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Assemble a {@link BlogSearchEngine} from a driver's operations: `index`
 * upserts a published post and deletes any other, and `reindex` applies that
 * rule to every given post — published posts in bulk batches of
 * {@link REINDEX_BATCH_SIZE}, the rest as deletes.
 */
export function httpSearchEngine(operations: HttpDriverOperations): BlogSearchEngine {
  async function index(post: BlogPost): Promise<void> {
    if (post.status === 'published') {
      await operations.upsert(post);
    } else {
      await operations.delete(post.id);
    }
  }
  return {
    search: operations.search,
    index,
    remove: operations.delete,
    async reindex(posts) {
      const published = posts.filter((post) => post.status === 'published');
      for (let start = 0; start < published.length; start += REINDEX_BATCH_SIZE) {
        await operations.upsertMany(published.slice(start, start + REINDEX_BATCH_SIZE));
      }
      for (const post of posts) {
        if (post.status !== 'published') await operations.delete(post.id);
      }
    },
  };
}
