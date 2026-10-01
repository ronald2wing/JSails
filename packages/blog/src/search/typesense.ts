/** Typesense driver for the blog search contract (REST over `fetch`). */

import { searchWindow, type BlogSearchEngine } from './contract.js';
import {
  BlogSearchError,
  cleanIndex,
  cleanUrl,
  documentFor,
  httpSearchEngine,
  driverRequest,
  jsonOrError,
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

/** True for one import result line that reports success. */
function importSucceeded(line: string): boolean {
  try {
    return (JSON.parse(line) as { success?: unknown }).success === true;
  } catch {
    return false;
  }
}

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
  const { repository } = options;
  const send = driverRequest(options);
  const url = cleanUrl(options.url);
  const collection = cleanIndex(options.index);
  const apiKey = requireKey(options.apiKey);
  const headers = { 'Content-Type': 'application/json', 'X-TYPESENSE-API-KEY': apiKey };
  const documents = `${url}/collections/${collection}/documents`;
  let ensured = false;

  async function ensureCollection(): Promise<void> {
    if (ensured) return;
    const response = await send(`${url}/collections`, {
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
        await send(`${documents}/search?${params.toString()}`, {
          method: 'GET',
          headers: { 'X-TYPESENSE-API-KEY': apiKey },
        }),
      )) as TypesenseSearchResponse | null;
      const ids = stringIds((payload?.hits ?? []).map((hit) => hit.document?.id));
      const posts = await resolvePublishedHits(repository, ids);
      return { posts, total: totalOf(payload?.found ?? ids.length, posts.length) };
    },
    async upsert(post) {
      await ensureCollection();
      await jsonOrError(
        await send(`${documents}?action=upsert`, {
          method: 'POST',
          headers,
          body: JSON.stringify(documentFor(post)),
        }),
      );
    },
    async upsertMany(posts) {
      await ensureCollection();
      // The import endpoint takes one JSON document per line and answers with
      // one result line per document; any failed line fails the batch.
      const response = await send(`${documents}/import?action=upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-TYPESENSE-API-KEY': apiKey },
        body: posts.map((post) => JSON.stringify(documentFor(post))).join('\n'),
      });
      if (!response.ok) {
        throw new BlogSearchError('bad_response', 'the search engine rejected the request');
      }
      // The request timeout also covers reading the body, so a timeout or reset
      // mid-body must surface as the drivers' value-free error, not a raw one.
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new BlogSearchError('bad_response', 'the search engine returned an invalid response');
      }
      const lines = text.split('\n').filter((line) => line.trim() !== '');
      if (!lines.every(importSucceeded)) {
        throw new BlogSearchError('bad_response', 'the search engine rejected the request');
      }
    },
    async delete(id) {
      await ensureCollection();
      const response = await send(`${documents}/${encodeURIComponent(id)}`, {
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
