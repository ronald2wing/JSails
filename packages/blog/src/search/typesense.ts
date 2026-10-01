/** Typesense driver for the blog search contract (REST over `fetch`). */

import { searchWindow, type BlogSearchEngine } from './contract.js';
import {
  BlogSearchError,
  cleanIndex,
  cleanUrl,
  documentFor,
  httpSearchEngine,
  jsonOrError,
  request,
  requireKey,
  stringIds,
  totalOf,
  type HttpDriverOptions,
} from './http-driver.js';
import { resolvePublishedHits } from './post-document.js';

/** The collection fields the driver creates on first use. */
const COLLECTION_FIELDS = [
  { name: 'id', type: 'string' },
  { name: 'title', type: 'string' },
  { name: 'slug', type: 'string' },
  { name: 'excerpt', type: 'string' },
  { name: 'body', type: 'string' },
  { name: 'status', type: 'string', facet: true },
  { name: 'publishedAt', type: 'string', optional: true },
];

/** The subset of a Typesense search response the driver reads. */
interface TypesenseSearchResponse {
  readonly hits?: readonly { readonly document?: { readonly id?: unknown } }[];
  readonly found?: unknown;
}

/**
 * Build a Typesense-backed engine; requires a URL and an API key. The collection
 * is created on the first operation (an existing collection's 409 is accepted).
 */
export function createTypesenseBlogSearch(options: HttpDriverOptions): BlogSearchEngine {
  const { fetch: fetchImpl, repository } = options;
  const url = cleanUrl(options.url);
  const collection = cleanIndex(options.index);
  const apiKey = requireKey(options.apiKey);
  const headers = { 'Content-Type': 'application/json', 'X-TYPESENSE-API-KEY': apiKey };
  const documents = `${url}/collections/${collection}/documents`;
  let ensured = false;

  async function ensureCollection(): Promise<void> {
    if (ensured) return;
    const response = await request(fetchImpl, `${url}/collections`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: collection, fields: COLLECTION_FIELDS }),
    });
    // A collection that already exists reports 409; that is not a failure.
    if (!response.ok && response.status !== 409) {
      throw new BlogSearchError('bad_response', 'the search engine rejected the request');
    }
    ensured = true;
  }

  return httpSearchEngine({
    async search(query, searchOptions) {
      await ensureCollection();
      const { page, limit } = searchWindow(searchOptions);
      const params = new URLSearchParams({
        q: query.trim(),
        query_by: 'title,excerpt,body',
        filter_by: 'status:=published',
        per_page: String(limit),
        page: String(page),
      });
      const payload = (await jsonOrError(
        await request(fetchImpl, `${documents}/search?${params.toString()}`, {
          method: 'GET',
          headers: { 'X-TYPESENSE-API-KEY': apiKey },
        }),
      )) as TypesenseSearchResponse;
      const ids = stringIds((payload.hits ?? []).map((hit) => hit.document?.id));
      const posts = await resolvePublishedHits(repository, ids);
      return { posts, total: totalOf(payload.found ?? ids.length, posts.length) };
    },
    async upsert(post) {
      await ensureCollection();
      await jsonOrError(
        await request(fetchImpl, `${documents}?action=upsert`, {
          method: 'POST',
          headers,
          body: JSON.stringify(documentFor(post)),
        }),
      );
    },
    async delete(id) {
      await ensureCollection();
      await jsonOrError(
        await request(fetchImpl, `${documents}/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers,
        }),
      );
    },
  });
}
