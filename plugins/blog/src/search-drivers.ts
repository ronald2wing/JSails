/**
 * External search drivers behind the engine-neutral {@link BlogSearchEngine}
 * contract: Meilisearch, Typesense, and OpenSearch over the global `fetch`.
 *
 * Each driver maintains its own remote index and maps search hits back through
 * the {@link ContentRepository} so a returned post is always a published
 * repository `Post`, never the engine's own stored projection. Indexing is a
 * real write: a published post is upserted and a non-published post is removed
 * from the remote index (so an unpublished post can never surface in a search).
 *
 * No dependency is added — all three engines speak plain HTTP/JSON over
 * `fetch`, injected at construction so tests substitute a double and no driver
 * ever touches the network in the default suite. A driver never connects at
 * construction; the first operation performs the first request.
 */

import type { ContentRepository, Post } from './content/index.js';
import { createDatabaseBlogSearch, postSearchText } from './search-database.js';
import type { BlogSearchEngine, BlogSearchResult } from './search-contract.js';
import { createOramaBlogSearch } from './search-orama.js';

/** The engine a {@link createBlogSearchEngine} call targets. */
export type BlogSearchDriver = 'orama' | 'database' | 'meilisearch' | 'typesense' | 'opensearch';

/** Options for {@link createBlogSearchEngine}. */
export interface BlogSearchEngineOptions {
  /** Which backing engine to build. */
  readonly driver: BlogSearchDriver;
  /** The post repository, used to map remote hit ids back to published posts. */
  readonly repository: ContentRepository;
  /** Base URL of the search engine, e.g. `https://search.example.com`. */
  readonly url?: string;
  /** API key for engines that require authentication. */
  readonly apiKey?: string;
  /** Index (or Typesense collection) name; defaults to `blog-posts`. */
  readonly index?: string;
  /** `fetch` implementation; defaults to the global `fetch`, injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable reason for a {@link BlogSearchError}. */
export type BlogSearchErrorCode = 'invalid_config' | 'request_failed' | 'bad_response';

/**
 * Raised for every external-search failure that reaches a caller. Messages are
 * value-free: they never echo a query, URL, document id, or payload, because
 * those values are caller input and must not round-trip into logs or responses.
 */
export class BlogSearchError extends Error {
  readonly code: BlogSearchErrorCode;

  constructor(code: BlogSearchErrorCode, message: string) {
    super(message);
    this.name = 'BlogSearchError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/** Validate an http(s) URL, returning a value-free error on rejection. */
function cleanUrl(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new BlogSearchError('invalid_config', 'a search engine URL is required');
  }
  const url = value.replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BlogSearchError('invalid_config', 'the search engine URL must be http or https');
    }
  } catch {
    throw new BlogSearchError('invalid_config', 'the search engine URL is not a valid URL');
  }
  return url;
}

/** Validate an index/collection name as a safe slug, value-free on rejection. */
function cleanIndex(value: string | undefined): string {
  const index = value === undefined || value === '' ? 'blog-posts' : value;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(index)) {
    throw new BlogSearchError('invalid_config', 'the search index name is not a safe slug');
  }
  return index;
}

/** Require an API key for a driver that authenticates, value-free on rejection. */
function requireKey(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new BlogSearchError('invalid_config', 'an API key is required for this search engine');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Shared HTTP helper
// ---------------------------------------------------------------------------

type Fetch = typeof globalThis.fetch;

/** The shared request/response boundary for every driver. */
function request(fetchImpl: Fetch, url: string, init: RequestInit): Promise<Response> {
  return fetchImpl(url, init).catch(() => {
    throw new BlogSearchError('request_failed', 'the search engine request failed');
  });
}

/** Read a JSON body, mapping a non-JSON or non-2xx response to value-free errors. */
async function jsonOrError(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new BlogSearchError('bad_response', 'the search engine rejected the request');
  }
  try {
    return await response.json();
  } catch {
    throw new BlogSearchError('bad_response', 'the search engine returned invalid JSON');
  }
}

// ---------------------------------------------------------------------------
// Pagination (shared across drivers)
// ---------------------------------------------------------------------------

function pageOf(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value >= 1 ? value : 1;
}

function limitOf(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 1 ? value : fallback;
}

// ---------------------------------------------------------------------------
// Post document shaping (shared across drivers)
// ---------------------------------------------------------------------------

/** The searchable body text of a post. */
function bodyText(post: Post): string {
  return postSearchText(post);
}

/** The engine-neutral document a published post upserts into an external index. */
function documentFor(post: Post): Record<string, unknown> {
  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    body: bodyText(post),
    status: post.status,
    publishedAt: post.publishedAt,
  };
}

// ---------------------------------------------------------------------------
// Hit mapping (shared across drivers)
// ---------------------------------------------------------------------------

/**
 * Map raw engine hit ids back through the repository, dropping non-published
 * rows. One batch lookup replaces a query per hit; the batch returns rows in no
 * particular order, so the engine's relevance order is restored here.
 */
async function resolveHits(
  repository: ContentRepository,
  ids: readonly string[],
): Promise<readonly Post[]> {
  if (ids.length === 0) return [];
  const byId = new Map((await repository.getPosts(ids)).map((post) => [post.id, post]));
  return ids
    .map((id) => byId.get(id))
    .filter((post): post is Post => post !== undefined && post.status === 'published');
}

// ---------------------------------------------------------------------------
// Meilisearch
// ---------------------------------------------------------------------------

function meiliHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function meiliIndex(url: string, index: string): string {
  return `${url}/indexes/${index}`;
}

function createMeilisearch(
  options: Required<Pick<BlogSearchEngineOptions, 'repository' | 'fetch'>> &
    Pick<BlogSearchEngineOptions, 'url' | 'apiKey' | 'index'>,
): BlogSearchEngine {
  const fetchImpl = options.fetch;
  const repository = options.repository;
  const url = cleanUrl(options.url);
  const index = cleanIndex(options.index);
  const apiKey = requireKey(options.apiKey);
  const base = meiliIndex(url, index);

  async function indexPost(post: Post): Promise<void> {
    await jsonOrError(
      await request(fetchImpl, `${base}/documents?primaryKey=id`, {
        method: 'PUT',
        headers: meiliHeaders(apiKey),
        body: JSON.stringify([documentFor(post)]),
      }),
    );
  }

  async function deletePost(id: string): Promise<void> {
    await jsonOrError(
      await request(fetchImpl, `${base}/documents/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: meiliHeaders(apiKey),
      }),
    );
  }

  return {
    async search(query, options = {}): Promise<BlogSearchResult> {
      const trimmed = query.trim();
      const limit = limitOf(options.limit, 10);
      const page = pageOf(options.page);
      const body: Record<string, unknown> = {
        q: trimmed,
        limit,
        offset: (page - 1) * limit,
        filter: 'status = published',
      };
      const payload = (await jsonOrError(
        await request(fetchImpl, `${base}/search`, {
          method: 'POST',
          headers: meiliHeaders(apiKey),
          body: JSON.stringify(body),
        }),
      )) as { hits?: Array<{ id?: unknown }>; estimatedTotalHits?: unknown; totalHits?: unknown };
      const hits = payload.hits ?? [];
      const ids = hits.map((hit) => hit.id).filter((id): id is string => typeof id === 'string');
      const total = Number(payload.estimatedTotalHits ?? payload.totalHits ?? ids.length);
      const posts = await resolveHits(repository, ids);
      return { posts, total: Number.isFinite(total) ? total : posts.length };
    },
    index: indexPost,
    remove: deletePost,
    async reindex(posts): Promise<void> {
      for (const post of posts) {
        if (post.status === 'published') {
          await indexPost(post);
        } else {
          await deletePost(post.id);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Typesense
// ---------------------------------------------------------------------------

function typesenseHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-TYPESENSE-API-KEY': apiKey,
  };
}

const TYPESENSE_SCHEMA = {
  name: 'blog-posts',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'title', type: 'string' },
    { name: 'slug', type: 'string' },
    { name: 'excerpt', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'status', type: 'string', facet: true },
    { name: 'publishedAt', type: 'string', optional: true },
  ],
};

function createTypesense(
  options: Required<Pick<BlogSearchEngineOptions, 'repository' | 'fetch'>> &
    Pick<BlogSearchEngineOptions, 'url' | 'apiKey' | 'index'>,
): BlogSearchEngine {
  const fetchImpl = options.fetch;
  const repository = options.repository;
  const url = cleanUrl(options.url);
  const index = cleanIndex(options.index);
  const apiKey = requireKey(options.apiKey);
  let ensured = false;

  async function ensureCollection(): Promise<void> {
    if (ensured) return;
    const response = await request(fetchImpl, `${url}/collections`, {
      method: 'POST',
      headers: typesenseHeaders(apiKey),
      body: JSON.stringify({ ...TYPESENSE_SCHEMA, name: index }),
    });
    // A collection that already exists reports 409; that is not a failure.
    if (!response.ok && response.status !== 409) {
      throw new BlogSearchError('bad_response', 'the search engine rejected the request');
    }
    ensured = true;
  }

  async function indexPost(post: Post): Promise<void> {
    await ensureCollection();
    await jsonOrError(
      await request(fetchImpl, `${url}/collections/${index}/documents?action=upsert`, {
        method: 'POST',
        headers: typesenseHeaders(apiKey),
        body: JSON.stringify(documentFor(post)),
      }),
    );
  }

  async function deletePost(id: string): Promise<void> {
    await ensureCollection();
    await jsonOrError(
      await request(fetchImpl, `${url}/collections/${index}/documents/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: typesenseHeaders(apiKey),
      }),
    );
  }

  return {
    async search(query, options = {}): Promise<BlogSearchResult> {
      await ensureCollection();
      const trimmed = query.trim();
      const limit = limitOf(options.limit, 10);
      const page = pageOf(options.page);
      const params = new URLSearchParams({
        q: trimmed,
        query_by: 'title,excerpt,body',
        filter_by: 'status:=published',
        per_page: String(limit),
        page: String(page),
      });
      const payload = (await jsonOrError(
        await request(
          fetchImpl,
          `${url}/collections/${index}/documents/search?${params.toString()}`,
          { method: 'GET', headers: { 'X-TYPESENSE-API-KEY': apiKey } },
        ),
      )) as { hits?: Array<{ document?: { id?: unknown } }>; found?: unknown };

      const hits = payload.hits ?? [];
      const ids = hits
        .map((hit) => hit.document?.id)
        .filter((id): id is string => typeof id === 'string');
      const total = Number(payload.found ?? ids.length);
      const posts = await resolveHits(repository, ids);
      return { posts, total: Number.isFinite(total) ? total : posts.length };
    },
    index: indexPost,
    remove: deletePost,
    async reindex(posts): Promise<void> {
      for (const post of posts) {
        if (post.status === 'published') {
          await indexPost(post);
        } else {
          await deletePost(post.id);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// OpenSearch
// ---------------------------------------------------------------------------

function openSearchHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // `apiKey` is interpreted as a bearer token; basic auth is not supported.
  if (apiKey !== undefined && apiKey !== '') {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function createOpenSearch(
  options: Required<Pick<BlogSearchEngineOptions, 'repository' | 'fetch'>> &
    Pick<BlogSearchEngineOptions, 'url' | 'apiKey' | 'index'>,
): BlogSearchEngine {
  const fetchImpl = options.fetch;
  const repository = options.repository;
  const url = cleanUrl(options.url);
  const index = cleanIndex(options.index);
  const apiKey = options.apiKey;

  const headers = openSearchHeaders(apiKey);

  async function indexPost(post: Post): Promise<void> {
    await jsonOrError(
      await request(fetchImpl, `${url}/${index}/_doc/${encodeURIComponent(post.id)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(documentFor(post)),
      }),
    );
  }

  async function deletePost(id: string): Promise<void> {
    await jsonOrError(
      await request(fetchImpl, `${url}/${index}/_doc/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers,
      }),
    );
  }

  return {
    async search(query, options = {}): Promise<BlogSearchResult> {
      const trimmed = query.trim();
      const limit = limitOf(options.limit, 10);
      const page = pageOf(options.page);
      // An empty query matches all published docs (match_all); a non-empty one
      // reaches into title/excerpt/body. Both are bounded to `published` and
      // ordered newest-first for a stable result.
      const queryClause =
        trimmed === ''
          ? { match_all: {} }
          : { multi_match: { query: trimmed, fields: ['title', 'excerpt', 'body'] } };
      const requestBody = {
        from: (page - 1) * limit,
        size: limit,
        query: {
          bool: {
            must: [queryClause, { term: { status: 'published' } }],
          },
        },
        sort: [{ publishedAt: { order: 'desc' } }],
      };
      const payload = (await jsonOrError(
        await request(fetchImpl, `${url}/${index}/_search`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        }),
      )) as {
        hits?: {
          total?: unknown;
          hits?: Array<{ _id?: unknown }>;
        };
      };

      const hits = payload.hits?.hits ?? [];
      const ids = hits.map((hit) => hit._id).filter((id): id is string => typeof id === 'string');
      const totalRaw = payload.hits?.total;
      const total =
        typeof totalRaw === 'object' && totalRaw !== null
          ? Number((totalRaw as { value?: unknown }).value ?? ids.length)
          : Number(totalRaw ?? ids.length);
      const posts = await resolveHits(repository, ids);
      return { posts, total: Number.isFinite(total) ? total : posts.length };
    },
    index: indexPost,
    remove: deletePost,
    async reindex(posts): Promise<void> {
      for (const post of posts) {
        if (post.status === 'published') {
          await indexPost(post);
        } else {
          await deletePost(post.id);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link BlogSearchEngine} for the requested {@link BlogSearchDriver}.
 *
 * `database` returns the no-dependency {@link createDatabaseBlogSearch} over the
 * repository. The HTTP drivers validate their URL and index name (and API key
 * where required) eagerly but never connect at construction — the first
 * operation performs the first request. Construction mistakes throw
 * `BlogSearchError`; per-operation failures raise the value-free
 * {@link BlogSearchError}s detailed in the module doc.
 */
export function createBlogSearchEngine(options: BlogSearchEngineOptions): BlogSearchEngine {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new BlogSearchError('invalid_config', 'search engine options must be an object');
  }
  const { driver, repository, url, apiKey, index, fetch: fetchImpl } = options;
  if (repository === undefined) {
    throw new BlogSearchError('invalid_config', 'a repository is required');
  }
  if (driver === 'database') {
    return createDatabaseBlogSearch({ repository });
  }
  if (driver === 'orama') {
    return createOramaBlogSearch({ repository });
  }
  if (driver !== 'meilisearch' && driver !== 'typesense' && driver !== 'opensearch') {
    throw new BlogSearchError('invalid_config', 'unknown search driver');
  }
  const resolvedFetch = fetchImpl ?? globalThis.fetch;
  const shared = { repository, fetch: resolvedFetch, url, apiKey, index };
  switch (driver) {
    case 'meilisearch':
      return createMeilisearch(shared);
    case 'typesense':
      return createTypesense(shared);
    case 'opensearch':
      return createOpenSearch(shared);
    default:
      throw new BlogSearchError('invalid_config', 'unknown search driver');
  }
}
