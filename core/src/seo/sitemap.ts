/**
 * Sitemap XML generation (`jsails/seo`).
 *
 * {@link buildSitemapXml} wraps the `sitemap` package's `SitemapStream` to
 * produce a `<urlset>` document from a list of absolute URLs. It is a pure
 * string producer — no file I/O; the static exporter writes the result into
 * `out/sitemap.xml`.
 *
 * This is the route-manifest sitemap (every rendered page). It is distinct from
 * `jsails/content`'s content-scoped `renderSitemap`, which walks a content
 * collection; the two cover different axes and are named differently on
 * purpose.
 */

import { SitemapStream, streamToPromise, ErrorLevel } from 'sitemap';
import { ABSOLUTE_URL_PATTERN } from '../internal/absolute-url.js';
import type { SitemapItemLoose } from 'sitemap';

import { SeoError } from './errors.js';

/** A single sitemap entry. `loc` must be an absolute `http(s)` URL. */
export interface SitemapEntry {
  readonly loc: string;
  /** An ISO-8601 date or datetime; emitted as `<lastmod>`. */
  readonly lastmod?: string;
}

/** Options for {@link buildSitemapXml}. */
export interface SitemapOptions {
  /** Emit `lastmod` as `YYYY-MM-DD` rather than a full timestamp. */
  readonly lastmodDateOnly?: boolean;
  /** An XSL stylesheet URL for human-readable sitemap display. */
  readonly xslUrl?: string;
}

/**
 * Build a sitemap XML document from a list of entries. Every `loc` is
 * pre-validated as an absolute `http(s)` URL; an invalid entry throws a
 * value-free {@link SeoError} rather than letting the `sitemap` package echo
 * the URL in a warning. The stream runs at `ErrorLevel.SILENT` so a library
 * warning can never leak a URL either.
 */
export async function buildSitemapXml(
  entries: readonly SitemapEntry[],
  options: SitemapOptions = {},
): Promise<string> {
  if (entries.length === 0) {
    throw new SeoError('empty_sitemap', 'a sitemap must contain at least one entry');
  }
  for (const entry of entries) {
    if (!ABSOLUTE_URL_PATTERN.test(entry.loc)) {
      throw new SeoError('invalid_sitemap_url', 'a sitemap entry must be an absolute http(s) URL');
    }
  }

  const stream = new SitemapStream({
    level: ErrorLevel.SILENT,
    lastmodDateOnly: options.lastmodDateOnly ?? false,
    ...(options.xslUrl !== undefined ? { xslUrl: options.xslUrl } : {}),
  });

  const collected = streamToPromise(stream);
  for (const entry of entries) {
    const item: SitemapItemLoose = { url: entry.loc };
    if (entry.lastmod !== undefined) item.lastmod = entry.lastmod;
    stream.write(item);
  }
  stream.end();

  const buffer = await collected;
  return buffer.toString('utf8');
}
