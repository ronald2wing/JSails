/**
 * RSS 2.0 and Atom 1.0 feed rendering.
 *
 * Two layers: {@link renderRssXml}/{@link renderAtomXml} render a feed from a
 * plain channel and item list, so any source (this package's collections, the
 * blog CMS) shares one XML implementation; {@link renderRssFeed}/
 * {@link renderAtomFeed} map a content collection onto them. Every text and
 * attribute value goes through `Str.escapeHtml` (the five-entity set
 * `&`/`<`/`>`/`"`/`'`, valid in both XML text and attributes) so raw markup in
 * authored content never corrupts the XML structure.
 */

import { Str, Time } from 'jsails/support';

import type { ContentCollectionDescriptor, ContentPage } from './model.js';
import { newestFirst } from './ordering.js';
import { requireSiteUrl, trimTrailingSlashes } from './site-url.js';

/** The feed-level metadata of a rendered feed. */
export interface FeedChannel {
  /** Feed title (the `<title>` / `<channel><title>`). */
  readonly title: string;
  /** Optional feed description (`<description>` in RSS, `<subtitle>` in Atom). */
  readonly description?: string;
  /** The site's public URL, the feed's alternate link. */
  readonly siteUrl: string;
  /** The URL the feed itself is served from (the self link and Atom id). */
  readonly feedUrl: string;
}

/** One entry of a rendered feed, newest first. */
export interface FeedItem {
  readonly title: string;
  /** The absolute entry URL, also used as the RSS guid and Atom id. */
  readonly url: string;
  /** Optional summary (`<description>` in RSS, `<summary>` in Atom). */
  readonly summary?: string;
  /** Publication date; an absent or invalid date renders as the Unix epoch. */
  readonly date?: Date;
}

/** The epoch fallback keeps a feed well-formed when an item has no usable date. */
function feedDate(date: Date | undefined): Date {
  return date === undefined || Number.isNaN(date.getTime()) ? new Date(0) : date;
}

/** Render an RSS 2.0 document. Items render in the given order. */
export function renderRssXml(channel: FeedChannel, items: readonly FeedItem[]): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${Str.escapeHtml(channel.title)}</title>`,
    `<link>${Str.escapeHtml(channel.siteUrl)}</link>`,
  ];
  if (channel.description !== undefined) {
    parts.push(`<description>${Str.escapeHtml(channel.description)}</description>`);
  }
  // Atom self-link for feed readers that discover from the channel.
  parts.push(
    `<atom:link href="${Str.escapeHtml(channel.feedUrl)}" rel="self" type="application/rss+xml"/>`,
  );

  for (const item of items) {
    parts.push('<item>');
    parts.push(`<title>${Str.escapeHtml(item.title)}</title>`);
    parts.push(`<link>${Str.escapeHtml(item.url)}</link>`);
    if (item.summary !== undefined) {
      parts.push(`<description>${Str.escapeHtml(item.summary)}</description>`);
    }
    parts.push(`<pubDate>${Time.rfc822(feedDate(item.date))}</pubDate>`);
    parts.push(`<guid isPermaLink="true">${Str.escapeHtml(item.url)}</guid>`);
    parts.push('</item>');
  }

  parts.push('</channel>', '</rss>');
  return parts.join('\n') + '\n';
}

/**
 * Render an Atom 1.0 document. Items render in the given order; the feed's
 * `<updated>` is the first (newest) item's date.
 */
export function renderAtomXml(channel: FeedChannel, items: readonly FeedItem[]): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<title>${Str.escapeHtml(channel.title)}</title>`,
  ];
  if (channel.description !== undefined) {
    parts.push(`<subtitle>${Str.escapeHtml(channel.description)}</subtitle>`);
  }
  parts.push(`<link href="${Str.escapeHtml(channel.feedUrl)}" rel="self"/>`);
  parts.push(`<link href="${Str.escapeHtml(channel.siteUrl)}"/>`);
  parts.push(`<id>${Str.escapeHtml(channel.feedUrl)}</id>`);
  parts.push(`<updated>${Time.iso8601(feedDate(items[0]?.date))}</updated>`);

  for (const item of items) {
    parts.push('<entry>');
    parts.push(`<title>${Str.escapeHtml(item.title)}</title>`);
    parts.push(`<link href="${Str.escapeHtml(item.url)}"/>`);
    parts.push(`<id>${Str.escapeHtml(item.url)}</id>`);
    parts.push(`<updated>${Time.iso8601(feedDate(item.date))}</updated>`);
    if (item.summary !== undefined) {
      parts.push(`<summary>${Str.escapeHtml(item.summary)}</summary>`);
    }
    parts.push('</entry>');
  }

  parts.push('</feed>');
  return parts.join('\n') + '\n';
}

/** Options for {@link renderRssFeed} and {@link renderAtomFeed}. */
export interface FeedOptions<Data = Record<string, unknown>> {
  /** Feed title (the `<title>` / `<channel><title>`). */
  readonly title: string;
  /** Optional feed description. */
  readonly description?: string;
  /**
   * The site's canonical public URL (e.g. `https://example.com`). Must be an
   * absolute `http(s)` URL, otherwise a value-free `ContentError` is thrown.
   */
  readonly siteUrl: string;
  /**
   * The URL where this feed lives. Defaults to `siteUrl + '/feed.xml'` (RSS) or
   * `siteUrl + '/atom.xml'` (Atom).
   */
  readonly feedUrl?: string;
  /** Max number of non-draft pages to include. Defaults to all, newest first. */
  readonly limit?: number;
  /** URL override for a single page. Defaults to `<siteUrl>/<slug>`. */
  readonly urlFor?: (page: ContentPage<Data>) => string;
}

/** Resolve a collection + options into the channel and newest-first items. */
function collectionFeed<Data>(
  collection: ContentCollectionDescriptor<Data>,
  options: FeedOptions<Data>,
  defaultFeedPath: string,
): { channel: FeedChannel; items: FeedItem[] } {
  const siteUrl = requireSiteUrl(options.siteUrl);
  const base = trimTrailingSlashes(siteUrl);
  const pages = newestFirst(collection.getEntries({ draft: false })).slice(0, options.limit);
  return {
    channel: {
      title: options.title,
      ...(options.description === undefined ? {} : { description: options.description }),
      siteUrl,
      feedUrl: options.feedUrl ?? `${base}${defaultFeedPath}`,
    },
    items: pages.map((page) => ({
      title: page.title,
      url: options.urlFor !== undefined ? options.urlFor(page) : `${base}/${page.slug}`,
      ...(page.excerpt === undefined ? {} : { summary: page.excerpt }),
      // `page.date` is a normalized YYYY-MM-DD day, read as UTC midnight.
      ...(page.date === undefined ? {} : { date: new Date(`${page.date}T00:00:00Z`) }),
    })),
  };
}

/** Render an RSS 2.0 feed of a collection's non-draft pages, newest first. */
export function renderRssFeed<Data = Record<string, unknown>>(
  collection: ContentCollectionDescriptor<Data>,
  options: FeedOptions<Data>,
): string {
  const { channel, items } = collectionFeed(collection, options, '/feed.xml');
  return renderRssXml(channel, items);
}

/** Render an Atom 1.0 feed of a collection's non-draft pages, newest first. */
export function renderAtomFeed<Data = Record<string, unknown>>(
  collection: ContentCollectionDescriptor<Data>,
  options: FeedOptions<Data>,
): string {
  const { channel, items } = collectionFeed(collection, options, '/atom.xml');
  return renderAtomXml(channel, items);
}
