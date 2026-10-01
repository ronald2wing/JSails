/**
 * Deterministic content ordering shared by the collection, sections, blog, and
 * feed surfaces. Keeping the comparators in one place means the default order
 * cannot drift between `getStaticPaths`, `prevNext`, the blog index, and feeds.
 */

import type { ContentPage } from './content-model.js';

/** The fields the default order compares. */
interface OrderedContent {
  readonly order: number;
  readonly title: string;
  readonly slug: string;
}

/** Sort by `order` ascending, then `title`, then `slug` for determinism. */
export function compareByOrder(a: OrderedContent, b: OrderedContent): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.title < b.title) return -1;
  if (a.title > b.title) return 1;
  if (a.slug < b.slug) return -1;
  if (a.slug > b.slug) return 1;
  return 0;
}

/**
 * Return a new array sorted newest-first: `date` descending, then the default
 * order (`order` ascending, then title, then slug).
 */
export function newestFirst<Data>(pages: readonly ContentPage<Data>[]): ContentPage<Data>[] {
  return [...pages].sort((a, b) => {
    const aDate = a.date ?? '';
    const bDate = b.date ?? '';
    if (aDate > bDate) return -1;
    if (aDate < bDate) return 1;
    return compareByOrder(a, b);
  });
}
