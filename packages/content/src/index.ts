/**
 * Markdown/SSG content layer (`@jsails/content`).
 *
 * Server-only: it imports `node:fs`/`node:path`, uses the YAML frontmatter
 * parser from `jsails/support/server`, pulls in `markdown-it` and `shiki`, and
 * performs disk I/O, so it never belongs in a browser bundle.
 *
 * A content collection = a directory tree of `.md` files + (optionally) a Zod
 * schema for its frontmatter. Static paths, prev/next, the search corpus, and
 * build-time validation are all derived from those two inputs.
 *
 * The idiomatic page-module usage defines the collection once and awaits it:
 *
 * ```ts
 * const blog = defineContentCollection({
 *   dir: 'content/blog',
 *   schema: z.object({ title: z.string(), description: z.string() }),
 * });
 *
 * export async function getStaticPaths() {
 *   return createMarkdownStaticPaths(await blog);
 * }
 *
 * export async function load({ params }) {
 *   return (await blog).getEntry(params.slug);
 * }
 * ```
 */

export { defineContentCollection, createMarkdownStaticPaths } from './collection.js';
export type { DefineContentCollectionOptions } from './collection.js';
export { ContentError, type ContentErrorCode } from './errors.js';
export { discoverContent } from './discovery.js';
export { defineTaxonomy } from './taxonomy.js';
export { defineTaxonomies } from './taxonomy-registry.js';
export { defineSections } from './sections.js';
export { readContentVersions, defineContentVersions } from './versions.js';
export { readingTime } from './render.js';

export type {
  ContentCollection,
  ContentCollectionDescriptor,
  ContentOptions,
  ContentPage,
  EntryFilter,
  PrevNext,
  SearchRecord,
  TocHeading,
} from './model.js';

export type { DefineTaxonomyOptions, Taxonomy, TaxonomyTerm, TaxonomyOrder } from './taxonomy.js';
export type {
  DefineTaxonomiesOptions,
  Taxonomies,
  TaxonomyDefinition,
} from './taxonomy-registry.js';
export type { SectionNode, SectionTree, DefineSectionsOptions } from './sections.js';
export type {
  ContentVersionEntry,
  ContentVersionsManifest,
  ContentVersionInfo,
  ContentVersions,
  DefineContentVersionsOptions,
} from './versions.js';

export { renderRssFeed, renderAtomFeed, renderRssXml, renderAtomXml } from './feed.js';
export type { FeedChannel, FeedItem, FeedOptions } from './feed.js';

export { renderSitemap, renderSitemapXml } from './sitemap.js';
export { trimTrailingSlashes } from './site-url.js';
export type { ContentSitemapOptions, SitemapUrl } from './sitemap.js';

export { blogIndex, tagIndex, pageUrl } from './listing.js';
export type { BlogIndexOptions, PageUrlOptions } from './listing.js';

// `FieldError` is the single `{ field, message }` shape from `jsails/validation`
// (imported, never redefined). Re-exported here so content-layer consumers can
// type a `ContentError`'s `.errors` without a second import.
export type { FieldError } from 'jsails/validation';
