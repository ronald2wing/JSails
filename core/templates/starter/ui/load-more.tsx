/**
 * Load-more island for the static starter.
 *
 * A pure client island: it owns `page`/`pageSize` state, paginates an inline
 * seed with `paginateArray`, and renders the same pager and intersection
 * markers a server component would. There is no server, no database, and no
 * signed snapshot — the island is the whole authority, so it works unchanged in
 * a static export.
 *
 * The seed is exported so the page can serialize it into `data-jsails-props`
 * and render the same markup for SSR; `parseLoadMoreSeed` is the defensive
 * boundary the browser entry uses to decode that JSON.
 */

import { useState } from 'preact/hooks';

import { paginateArray } from 'jsails/api';

import { intersectAttrs, pagerAttrs, useIslandTools } from '../app/application-client.js';

/** One demo entry. Plain data so it survives JSON serialization. */
export interface DemoEntry {
  readonly id: number;
  readonly title: string;
}

/** The inline seed: 24 entries, four pages of six. */
export const SEED: readonly DemoEntry[] = [
  { id: 1, title: 'A small, typed beginning' },
  { id: 2, title: 'Why the static export stays boring' },
  { id: 3, title: 'Content collections without a database' },
  { id: 4, title: 'One island, one job' },
  { id: 5, title: 'Pagination as plain data' },
  { id: 6, title: 'The pager is just attributes' },
  { id: 7, title: 'Intersection observers, once' },
  { id: 8, title: 'State that never leaves the page' },
  { id: 9, title: 'Hydration without a framework tax' },
  { id: 10, title: 'Typed props at the island boundary' },
  { id: 11, title: 'A seed you can read in the source' },
  { id: 12, title: 'Six entries per page' },
  { id: 13, title: 'Previous, next, and load more' },
  { id: 14, title: 'No fetch, no router, no server' },
  { id: 15, title: 'The same recipe as a server component' },
  { id: 16, title: 'Markers instead of callbacks' },
  { id: 17, title: 'Re-arming the sentinel' },
  { id: 18, title: 'A page that resets on reload' },
  { id: 19, title: 'Small state, small surface' },
  { id: 20, title: 'Progressive enhancement by default' },
  { id: 21, title: 'The last page has no sentinel' },
  { id: 22, title: 'Reading the seed defensively' },
  { id: 23, title: 'One component, two renderers' },
  { id: 24, title: 'Done, and still static' },
];

/** Entries per page. Six keeps the pager visible without a long scroll. */
const PAGE_SIZE = 6;

function isDemoEntry(value: unknown): value is DemoEntry {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'number' && typeof record.title === 'string';
}

/**
 * Decode the serialized seed from `data-jsails-props`.
 *
 * The island boundary hands components untyped JSON, so this validates the
 * shape and falls back to the inline seed when the marker is absent or
 * malformed. That keeps the first client render identical to the SSR markup.
 */
export function parseLoadMoreSeed(value: unknown): readonly DemoEntry[] {
  if (!Array.isArray(value)) return SEED;
  const entries = value.filter(isDemoEntry);
  return entries.length > 0 ? entries : SEED;
}

export interface LoadMoreProps {
  /** Entries to paginate. Defaults to the inline seed. */
  readonly seed?: readonly DemoEntry[];
}

export function LoadMore({ seed = SEED }: LoadMoreProps) {
  const [page, setPage] = useState(1);
  const paged = paginateArray(seed, { page, pageSize: PAGE_SIZE });
  const pager = pagerAttrs(paged, { action: 'page' });

  // `loadMore` fires once per sentinel; advancing `page` re-renders, which
  // re-arms the observer for the sentinel at the bottom of the new page.
  const { ref } = useIslandTools<HTMLDivElement>({
    handlers: {
      loadMore: () => setPage((current) => current + 1),
      page: ({ page: next }) => setPage(Number(next)),
    },
  });

  const totalPages = Math.max(1, Math.ceil(paged.count / paged.pageSize));

  return (
    <div ref={ref} class="space-y-6">
      <ul class="space-y-4">
        {paged.results.map((entry) => (
          <li
            key={entry.id}
            class="post-row border-b border-base-300/60 pb-4 last:border-b-0 last:pb-0"
          >
            <div class="tabular pt-1 text-xs text-base-content/45">#{entry.id}</div>
            <div>
              <h2 class="text-xl leading-snug sm:text-2xl">
                <span class="post-title inline-block text-base-content">{entry.title}</span>
              </h2>
            </div>
          </li>
        ))}
      </ul>

      <p class="tabular text-xs text-base-content/45">
        Page {paged.page} of {totalPages} · {paged.count} entries
      </p>

      <nav class="flex items-center gap-4 text-sm" aria-label="Pagination">
        {pager.previous !== null ? (
          <a class="tag-link" {...pager.previous}>
            Previous
          </a>
        ) : null}
        {pager.next !== null ? (
          <a class="tag-link" {...pager.next}>
            Next
          </a>
        ) : null}
      </nav>

      {paged.next !== null ? (
        <div class="tag-link text-sm" {...intersectAttrs('loadMore')}>
          Load more
        </div>
      ) : null}
    </div>
  );
}
