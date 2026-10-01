/**
 * Listing helpers over a content collection and taxonomy: the newest-first
 * index of a blog-style collection, the tag-cloud order, and page URLs.
 *
 * Every function is pure: no I/O, no connection, no mutation.
 */

import { compareStrings } from 'jsails/support';

import type { ContentCollectionDescriptor, ContentPage } from './model.js';
import type { Taxonomy, TaxonomyTerm } from './taxonomy.js';
import { newestFirst } from './ordering.js';

// ---------------------------------------------------------------------------
// blogIndex
// ---------------------------------------------------------------------------

/** Options for {@link blogIndex}. */
export interface BlogIndexOptions<Data = Record<string, unknown>> {
  /** Max number of pages to return. Defaults to all non-draft pages. */
  readonly limit?: number;
  /** Only pages carrying this tag. Defaults to all non-draft pages. */
  readonly tag?: string;
  /**
   * Optional URL override for deriving page URLs. When absent, URLs are
   * `/` + `slug`.
   */
  readonly urlFor?: (page: ContentPage<Data>) => string;
}

/**
 * Return the collection's non-draft pages sorted newest-first (by `date`
 * descending, then `order` ascending, then title/slug for determinism).
 *
 * This is a convenience over `collection.getEntries({ draft: false })`
 * so a page module's `load` can call `blogIndex(await blog, { limit: 10 })`
 * without sorting or filtering inline.
 */
export function blogIndex<Data = Record<string, unknown>>(
  collection: ContentCollectionDescriptor<Data>,
  options?: BlogIndexOptions<Data>,
): readonly ContentPage<Data>[] {
  const pages = collection.getEntries({ draft: false, tag: options?.tag });
  const sorted = newestFirst(pages);
  if (options?.limit !== undefined) return sorted.slice(0, options.limit);
  return sorted;
}

// ---------------------------------------------------------------------------
// tagIndex
// ---------------------------------------------------------------------------

/**
 * Return the taxonomy's terms sorted by count descending, then term
 * ascending. This is the canonical sort for a tag-cloud or tag-index page:
 * the most common term first, with alphabetical tiebreaking.
 */
export function tagIndex<Data = Record<string, unknown>>(
  taxonomy: Taxonomy<Data>,
): readonly TaxonomyTerm<Data>[] {
  return [...taxonomy.terms].sort((a, b) => b.count - a.count || compareStrings(a.term, b.term));
}

// ---------------------------------------------------------------------------
// pageUrl
// ---------------------------------------------------------------------------

/** Options for {@link pageUrl}. */
export interface PageUrlOptions<Data = Record<string, unknown>> {
  /**
   * Optional override that receives the page and returns its full URL.
   * When absent, the URL is `'/' + page.slug`.
   */
  readonly urlFor?: (page: ContentPage<Data>) => string;
}

/**
 * Derive the canonical URL for a content page.
 *
 * The default URL is `'/' + page.slug` (e.g. `/blog/hello`). Pass an
 * `urlFor` callback to override this (e.g. prepend a site host for feeds).
 */
export function pageUrl<Data = Record<string, unknown>>(
  page: ContentPage<Data>,
  options?: PageUrlOptions<Data>,
): string {
  if (options?.urlFor !== undefined) return options.urlFor(page);
  return `/${page.slug}`;
}
