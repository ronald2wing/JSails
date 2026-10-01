/**
 * Starter load-more feed: the unified pagination recipe as a server component.
 *
 * The component owns two state fields, `page` and `pageSize`, and derives a
 * `Page<string>` from a fixed demo dataset with `paginateArray`. Two server
 * actions move through it:
 * - `page` — jump to an explicit page; the pager links carry the target page
 *   and page size as action args.
 * - `loadMore` — advance one page; the sentinel at the bottom fires it when it
 *   scrolls into view.
 *
 * The pager and sentinel markers come from the framework's shared builders
 * (`pagerAttrs`, `intersectAttrs`), so this component never hand-writes the
 * `data-jsails-*` transport attributes. `pagerAttrs` returns `null` for a
 * direction with no link, which is why each link is rendered conditionally.
 *
 * Intersection is fire-once per element: the client unobserves a sentinel after
 * it dispatches `loadMore`, so scrolling away and back does not re-trigger it.
 * Every morphed render re-creates the observer over the new subtree, which
 * re-arms the freshly rendered sentinel for the next page.
 *
 * Stable `data-*` markers are the browser-verification contract:
 * - `data-feed-item`     — each rendered item
 * - `data-feed-sentinel` — the load-more sentinel
 */

import { z } from 'zod';

import { paginateArray, type Page } from 'jsails/api';

import {
  defineComponent,
  defineStyle,
  intersectAttrs,
  pagerAttrs,
  serverAction,
} from '../app/application-component.js';

// #region model

/** Items shown per page on the first render. */
const INITIAL_PAGE_SIZE = 3;

/** Upper bound for the page size a client may request. */
const MAX_PAGE_SIZE = 20;

/**
 * The fixed demo dataset. There is no store in this starter, so the feed is a
 * module-level array and `paginateArray` slices it per request — the same
 * in-memory approach the task list uses for its state.
 */
const DEMO_ITEMS: readonly string[] = [
  'A server component owns its own state',
  'Pager links carry the target page as action args',
  'The sentinel loads the next page on intersection',
  'Intersection fires once per element',
  'A morphed render re-arms the new sentinel',
  'Page size is bounded by the state schema',
  'Previous and next are null at the edges',
  'Static export renders the first page only',
  'No database is required for this demo',
  'The same recipe works over a real store',
];

/**
 * The persisted state shape. Both fields are positive integers; `pageSize` is
 * capped so a client cannot request an unbounded window.
 */
const stateSchema = z
  .object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
  })
  .strict();

type LoadMoreFeedState = z.infer<typeof stateSchema>;

/** The args a pager link sends: the target page and the applied page size. */
const pageArgsSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
});

// #endregion model

// #region style

const style = defineStyle({
  card: 'card w-full bg-base-100 shadow-xl',
  body: 'card-body',
  title: 'card-title',
  intro: 'text-base-content/70',
  list: 'list w-full',
  item: 'list-row',
  count: 'text-sm text-base-content/60',
  pager: 'flex items-center gap-2',
  pagerLink: 'btn btn-sm btn-outline',
  sentinel:
    'mt-2 rounded-lg border border-dashed border-base-300 px-4 py-3 text-center text-sm text-base-content/60',
});

// #endregion style

// #region view

export const loadMoreFeed = defineComponent<LoadMoreFeedState>({
  name: 'load-more-feed',
  stateSchema,
  style,
  initialState() {
    return { page: 1, pageSize: INITIAL_PAGE_SIZE };
  },
  // Public demo policy: this starter has no identity system, so the component
  // is intentionally open. A real app replaces this with its own session check
  // (the runtime is default-deny and requires an exact `true`).
  authorize() {
    return true;
  },
  actions: {
    page: serverAction({
      input: pageArgsSchema,
      run(state, args) {
        state.page = args.page;
        state.pageSize = args.pageSize;
      },
    }),
    loadMore: serverAction({
      // The sentinel dispatches with empty args; the next page is derived from
      // the current state. Clamped to the last page so a replayed call cannot
      // walk past the end of the dataset.
      input: z.object({}),
      run(state) {
        const totalPages = Math.max(1, Math.ceil(DEMO_ITEMS.length / state.pageSize));
        state.page = Math.min(state.page + 1, totalPages);
      },
    }),
  },
  derived: {
    paged: (state) => paginateArray(DEMO_ITEMS, { page: state.page, pageSize: state.pageSize }),
  },
  render(_state, { derived }) {
    const paged = derived('paged') as Page<string>;
    const { previous, next } = pagerAttrs(paged, { action: 'page' });
    const totalPages = Math.max(1, Math.ceil(paged.count / paged.pageSize));
    return (
      <section class={style.slot('card')}>
        <div class={style.slot('body')}>
          <h2 class={style.slot('title')}>Load-more feed</h2>
          <p class={style.slot('intro')}>
            A fixed demo dataset paged on the server. The pager links jump to an explicit page; the
            sentinel at the bottom loads the next one when it scrolls into view.
          </p>

          <ul class={style.slot('list')}>
            {paged.results.map((item) => (
              <li class={style.slot('item')} data-feed-item key={item}>
                {item}
              </li>
            ))}
          </ul>

          <p class={style.slot('count')}>
            Page {paged.page} of {totalPages} — {paged.count} items
          </p>

          <div class={style.slot('pager')}>
            {previous !== null ? (
              <a class={style.slot('pagerLink')} {...previous}>
                Previous
              </a>
            ) : null}
            {next !== null ? (
              <a class={style.slot('pagerLink')} {...next}>
                Next
              </a>
            ) : null}
          </div>

          {next !== null ? (
            <div class={style.slot('sentinel')} data-feed-sentinel {...intersectAttrs('loadMore')}>
              Load more
            </div>
          ) : null}
        </div>
      </section>
    );
  },
  staticFallback() {
    // Static export has no request context, so no state, signing, or actions.
    // Render the first page read-only instead of a dead pager.
    const firstPage = paginateArray(DEMO_ITEMS, { page: 1, pageSize: INITIAL_PAGE_SIZE });
    return (
      <section class={style.slot('card')}>
        <div class={style.slot('body')}>
          <h2 class={style.slot('title')}>Load-more feed</h2>
          <p class={style.slot('intro')}>
            The first page of the feed, rendered read-only. Live paging is a server component — run
            the app with <code>jsails serve</code> to use it.
          </p>
          <ul class={style.slot('list')}>
            {firstPage.results.map((item) => (
              <li class={style.slot('item')} key={item}>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  },
});

// #endregion view
