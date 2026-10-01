/**
 * Meilisearch driver for the blog search contract (REST over `fetch`).
 *
 * The index holds only published posts (`index` deletes anything else) and
 * every hit is re-checked through the repository, so a search sends no
 * `status` filter: Meilisearch rejects a filter on an attribute the index has
 * not declared filterable, which would fail every search on a fresh index.
 * The first write also applies the index settings (searchable, filterable, and
 * sortable attributes), so an operator never configures the index by hand. A
 * search before the index exists (`404`) is an empty result, not an error.
 */

import { searchWindow, type BlogSearchEngine } from './contract.js';
import {
  cleanIndex,
  cleanUrl,
  documentFor,
  driverRequest,
  httpSearchEngine,
  jsonOrError,
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

/** The index settings the driver applies before its first write. */
const INDEX_SETTINGS = {
  searchableAttributes: ['title', 'excerpt', 'body'],
  filterableAttributes: ['status'],
  sortableAttributes: ['publishedAt'],
};

/** Build a Meilisearch-backed engine; requires a URL and an API key. */
export function createMeilisearchBlogSearch(options: HttpDriverOptions): BlogSearchEngine {
  const { repository } = options;
  const send = driverRequest(options);
  const base = `${cleanUrl(options.url)}/indexes/${cleanIndex(options.index)}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${requireKey(options.apiKey)}`,
  };
  let configured = false;

  /** Apply the index settings once per process (Meilisearch creates the index on demand). */
  async function ensureSettings(): Promise<void> {
    if (configured) return;
    await jsonOrError(
      await send(`${base}/settings`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(INDEX_SETTINGS),
      }),
    );
    configured = true;
  }

  async function putDocuments(documents: readonly Record<string, unknown>[]): Promise<void> {
    await ensureSettings();
    await jsonOrError(
      await send(`${base}/documents?primaryKey=id`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(documents),
      }),
    );
  }

  return httpSearchEngine({
    async search(query, searchOptions) {
      const { limit, offset } = searchWindow(searchOptions);
      const response = await send(`${base}/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ q: query.trim(), limit, offset }),
      });
      // Nothing has been indexed yet, so nothing matches.
      if (response.status === 404) return { posts: [], total: 0 };
      const payload = (await jsonOrError(response)) as MeilisearchSearchResponse | null;
      const ids = stringIds((payload?.hits ?? []).map((hit) => hit.id));
      const posts = await resolvePublishedHits(repository, ids);
      return {
        posts,
        total: totalOf(
          payload?.estimatedTotalHits ?? payload?.totalHits ?? ids.length,
          posts.length,
        ),
      };
    },
    async upsert(post) {
      await putDocuments([documentFor(post)]);
    },
    async upsertMany(posts) {
      await putDocuments(posts.map(documentFor));
    },
    async delete(id) {
      const response = await send(`${base}/documents/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers,
      });
      // Deleting from an index that does not exist yet leaves nothing to remove.
      if (response.status === 404) return;
      await jsonOrError(response);
    },
  });
}
