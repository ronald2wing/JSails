/**
 * Sitemap XML for a content collection or any plain list of URLs.
 *
 * {@link renderSitemapXml} renders a `<urlset>` from plain URL entries, so any
 * source (this package's collections, the blog CMS) shares one XML
 * implementation; {@link renderSitemap} maps a content collection onto it. This
 * is a content-scoped sitemap; the route-manifest sitemap of every rendered
 * page is `jsails/seo`'s `buildSitemapXml`.
 */

import { Str } from 'jsails/support';

import type { ContentCollectionDescriptor, ContentPage } from './model.js';
import { requireSiteUrl, trimTrailingSlashes } from './site-url.js';

/** One `<url>` of a rendered sitemap. */
export interface SitemapUrl {
  /** The absolute page URL. */
  readonly loc: string;
  /** Optional last-modified date, emitted verbatim (e.g. `YYYY-MM-DD`). */
  readonly lastmod?: string;
}

/** Render a sitemap document with one `<url>` per entry, in the given order. */
export function renderSitemapXml(urls: readonly SitemapUrl[]): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const url of urls) {
    parts.push('<url>');
    parts.push(`<loc>${Str.escapeHtml(url.loc)}</loc>`);
    if (url.lastmod !== undefined) {
      parts.push(`<lastmod>${Str.escapeHtml(url.lastmod)}</lastmod>`);
    }
    parts.push('</url>');
  }
  parts.push('</urlset>');
  return parts.join('\n') + '\n';
}

/** Options for {@link renderSitemap}. */
export interface ContentSitemapOptions<Data = Record<string, unknown>> {
  /**
   * The site's canonical public URL (e.g. `https://example.com`). Must be an
   * absolute `http(s)` URL, otherwise a value-free `ContentError` is thrown.
   */
  readonly siteUrl: string;
  /** URL override for a single page. Defaults to `<siteUrl>/<slug>`. */
  readonly urlFor?: (page: ContentPage<Data>) => string;
}

/**
 * Render a sitemap of a collection's non-draft pages. A page with a `date`
 * (already normalized to `YYYY-MM-DD`) carries it as `<lastmod>`.
 */
export function renderSitemap<Data = Record<string, unknown>>(
  collection: ContentCollectionDescriptor<Data>,
  options: ContentSitemapOptions<Data>,
): string {
  const base = trimTrailingSlashes(requireSiteUrl(options.siteUrl));
  return renderSitemapXml(
    collection.getEntries({ draft: false }).map((page) => ({
      loc: options.urlFor !== undefined ? options.urlFor(page) : `${base}/${page.slug}`,
      ...(page.date === undefined ? {} : { lastmod: page.date }),
    })),
  );
}
