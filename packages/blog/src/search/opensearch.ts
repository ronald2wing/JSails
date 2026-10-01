/**
 * OpenSearch driver for the blog search contract (REST over `fetch`).
 *
 * The index is created on the first operation with an explicit mapping
 * (`status` a keyword, `publishedAt` a date), so the `status` term filter and
 * the `publishedAt` sort never depend on dynamic mapping guessing the types
 * from whichever document arrives first. An index that already exists is
 * accepted as is.
 */

import { searchWindow, type BlogSearchEngine } from './contract.js';
import {
  BlogSearchError,
  cleanIndex,
  cleanUrl,
  documentFor,
  driverRequest,
  httpSearchEngine,
  jsonOrError,
  stringIds,
  totalOf,
  type HttpDriverOptions,
} from './http-driver.js';
import { resolvePublishedHits } from './post-document.js';

/** The explicit index mapping the driver creates. */
const INDEX_MAPPING = {
  mappings: {
    properties: {
      id: { type: 'keyword' },
      title: { type: 'text' },
      slug: { type: 'keyword' },
      excerpt: { type: 'text' },
      body: { type: 'text' },
      status: { type: 'keyword' },
      publishedAt: { type: 'date' },
    },
  },
};

/** The subset of an OpenSearch search response the driver reads. */
interface OpenSearchSearchResponse {
  readonly hits?: {
    readonly total?: unknown;
    readonly hits?: readonly { readonly _id?: unknown }[];
  };
}

/**
 * Build an OpenSearch-backed engine; requires a URL. `apiKey`, when given, is
 * sent as a bearer token (basic auth is not supported).
 */
export function createOpenSearchBlogSearch(options: HttpDriverOptions): BlogSearchEngine {
  const { repository, apiKey } = options;
  const send = driverRequest(options);
  const base = `${cleanUrl(options.url)}/${cleanIndex(options.index)}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey !== undefined && apiKey !== '') {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  let ensured = false;

  /** Create the index with its mapping once; an existing index is accepted. */
  async function ensureIndex(): Promise<void> {
    if (ensured) return;
    const response = await send(base, {
      method: 'PUT',
      headers,
      body: JSON.stringify(INDEX_MAPPING),
    });
    if (!response.ok && !(await alreadyExists(response))) {
      throw new BlogSearchError('bad_response', 'the search engine rejected the request');
    }
    ensured = true;
  }

  return httpSearchEngine({
    async search(query, searchOptions) {
      await ensureIndex();
      const trimmed = query.trim();
      const { limit, offset } = searchWindow(searchOptions);
      // An empty query matches all published docs (match_all); a non-empty one
      // reaches into title/excerpt/body. Both are bounded to `published` and
      // ordered newest-first for a stable result.
      const queryClause =
        trimmed === ''
          ? { match_all: {} }
          : { multi_match: { query: trimmed, fields: ['title', 'excerpt', 'body'] } };
      const payload = (await jsonOrError(
        await send(`${base}/_search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            from: offset,
            size: limit,
            query: { bool: { must: [queryClause, { term: { status: 'published' } }] } },
            sort: [{ publishedAt: { order: 'desc' } }],
          }),
        }),
      )) as OpenSearchSearchResponse | null;
      const ids = stringIds((payload?.hits?.hits ?? []).map((hit) => hit._id));
      const totalRaw = payload?.hits?.total;
      // OpenSearch reports `{ value, relation }`; older clusters report a number.
      const reported =
        typeof totalRaw === 'object' && totalRaw !== null
          ? (totalRaw as { value?: unknown }).value
          : totalRaw;
      const posts = await resolvePublishedHits(repository, ids);
      return { posts, total: totalOf(reported ?? ids.length, posts.length) };
    },
    async upsert(post) {
      await ensureIndex();
      await jsonOrError(
        await send(`${base}/_doc/${encodeURIComponent(post.id)}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(documentFor(post)),
        }),
      );
    },
    async upsertMany(posts) {
      await ensureIndex();
      // `_bulk` takes newline-delimited action/document pairs and reports
      // per-item failures in `errors` with a 200 status.
      const body = posts
        .map(
          (post) =>
            `${JSON.stringify({ index: { _id: post.id } })}\n${JSON.stringify(documentFor(post))}\n`,
        )
        .join('');
      const payload = (await jsonOrError(
        await send(`${base}/_bulk`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/x-ndjson' },
          body,
        }),
      )) as { errors?: unknown } | null;
      if (payload?.errors !== false) {
        throw new BlogSearchError('bad_response', 'the search engine rejected the request');
      }
    },
    async delete(id) {
      await ensureIndex();
      const response = await send(`${base}/_doc/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers,
      });
      // A post that was never indexed (a draft never published) answers 404:
      // there is nothing to remove, so reindex must not fail on it.
      if (response.status === 404) return;
      await jsonOrError(response);
    },
  });
}

/** True when a failed index creation reports that the index already exists. */
async function alreadyExists(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const payload = (await response.json()) as { error?: { type?: unknown } };
    return payload.error?.type === 'resource_already_exists_exception';
  } catch {
    return false;
  }
}
