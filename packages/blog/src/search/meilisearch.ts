/** Meilisearch driver for the blog search contract (REST over `fetch`). */

import { searchWindow, type BlogSearchEngine } from './contract.js';
import {
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

/** The subset of a Meilisearch search response the driver reads. */
interface MeilisearchSearchResponse {
  readonly hits?: readonly { readonly id?: unknown }[];
  readonly estimatedTotalHits?: unknown;
  readonly totalHits?: unknown;
}

/** Build a Meilisearch-backed engine; requires a URL and an API key. */
export function createMeilisearchBlogSearch(options: HttpDriverOptions): BlogSearchEngine {
  const { fetch: fetchImpl, repository } = options;
  const base = `${cleanUrl(options.url)}/indexes/${cleanIndex(options.index)}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${requireKey(options.apiKey)}`,
  };

  return httpSearchEngine({
    async search(query, searchOptions) {
      const { limit, offset } = searchWindow(searchOptions);
      const payload = (await jsonOrError(
        await request(fetchImpl, `${base}/search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            q: query.trim(),
            limit,
            offset,
            filter: 'status = published',
          }),
        }),
      )) as MeilisearchSearchResponse;
      const ids = stringIds((payload.hits ?? []).map((hit) => hit.id));
      const posts = await resolvePublishedHits(repository, ids);
      return {
        posts,
        total: totalOf(payload.estimatedTotalHits ?? payload.totalHits ?? ids.length, posts.length),
      };
    },
    async upsert(post) {
      await jsonOrError(
        await request(fetchImpl, `${base}/documents?primaryKey=id`, {
          method: 'PUT',
          headers,
          body: JSON.stringify([documentFor(post)]),
        }),
      );
    },
    async delete(id) {
      await jsonOrError(
        await request(fetchImpl, `${base}/documents/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers,
        }),
      );
    },
  });
}
