/** OpenSearch driver for the blog search contract (REST over `fetch`). */

import { searchWindow, type BlogSearchEngine } from './contract.js';
import {
  cleanIndex,
  cleanUrl,
  documentFor,
  httpSearchEngine,
  jsonOrError,
  request,
  stringIds,
  totalOf,
  type HttpDriverOptions,
} from './http-driver.js';
import { resolvePublishedHits } from './post-document.js';

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
  const { fetch: fetchImpl, repository, apiKey } = options;
  const base = `${cleanUrl(options.url)}/${cleanIndex(options.index)}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey !== undefined && apiKey !== '') {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return httpSearchEngine({
    async search(query, searchOptions) {
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
        await request(fetchImpl, `${base}/_search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            from: offset,
            size: limit,
            query: { bool: { must: [queryClause, { term: { status: 'published' } }] } },
            sort: [{ publishedAt: { order: 'desc' } }],
          }),
        }),
      )) as OpenSearchSearchResponse;
      const ids = stringIds((payload.hits?.hits ?? []).map((hit) => hit._id));
      const totalRaw = payload.hits?.total;
      // OpenSearch reports `{ value, relation }`; older clusters report a number.
      const reported =
        typeof totalRaw === 'object' && totalRaw !== null
          ? (totalRaw as { value?: unknown }).value
          : totalRaw;
      const posts = await resolvePublishedHits(repository, ids);
      return { posts, total: totalOf(reported ?? ids.length, posts.length) };
    },
    async upsert(post) {
      await jsonOrError(
        await request(fetchImpl, `${base}/_doc/${encodeURIComponent(post.id)}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(documentFor(post)),
        }),
      );
    },
    async delete(id) {
      await jsonOrError(
        await request(fetchImpl, `${base}/_doc/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers,
        }),
      );
    },
  });
}
