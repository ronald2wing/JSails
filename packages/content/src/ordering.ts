/**
 * Deterministic content ordering shared by the collection, sections, blog, and
 * feed surfaces. Keeping the comparators in one place means the default order
 * cannot drift between `getStaticPaths`, `prevNext`, the blog index, and feeds.
 */

import { compareStrings } from 'jsails/support';

import type { ContentPage } from './model.js';

/** The fields the default order compares. */
interface OrderedContent {
  readonly order: number;
  readonly title: string;
  readonly slug: string;
}

/** Sort by `order` ascending, then `title`, then `slug` for determinism. */
export function compareByOrder(a: OrderedContent, b: OrderedContent): number {
  if (a.order !== b.order) return a.order - b.order;
  return compareStrings(a.title, b.title) || compareStrings(a.slug, b.slug);
}

/**
 * Return a new array sorted newest-first: `date` descending, then the default
 * order (`order` ascending, then title, then slug).
 */
export function newestFirst<Data>(pages: readonly ContentPage<Data>[]): ContentPage<Data>[] {
  return [...pages].sort((a, b) => {
    return compareStrings(b.date ?? '', a.date ?? '') || compareByOrder(a, b);
  });
}
