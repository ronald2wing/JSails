/**
 * Public discovery surfaces for the blog plugin: paginated list, category/tag
 * listings, RSS/Atom feeds, and the sitemap.
 *
 * Everything here is a pure function over the plain post summaries and terms
 * the repository returns; the routes in `plugin.ts` query exactly the page they
 * show and hand it in, so escaping and XML validity stay in one place and stay
 * testable without a listener or database. The listings render HTML through
 * the five-entity escape (`& < > " '`); the feeds and sitemap map posts onto
 * `@jsails/content`'s source-neutral XML renderers.
 *
 * Internal: nothing here is re-exported from the public `@jsails/blog` barrel.
 */

import {
  renderAtomXml,
  renderRssXml,
  renderSitemapXml,
  trimTrailingSlashes,
  type FeedChannel,
  type FeedItem,
} from '@jsails/content';
import { Str } from 'jsails/support';

import { comparePublishedPosts } from './cms/entity-builders.js';
import type { BlogPost, BlogPostSummary, BlogTerm } from './cms/index.js';

/** The path segment the discovery surfaces live under. */
export const BLOG_PATH = '/blog';

// ---------------------------------------------------------------------------
// Ordering and pagination
// ---------------------------------------------------------------------------

/**
 * Published posts newest-first, in the repository listing order. Used by the
 * search engines that index full posts; the public routes page in the
 * repository instead.
 */
export function publishedPosts(posts: readonly BlogPost[]): readonly BlogPost[] {
  return posts.filter((post) => post.status === 'published').sort(comparePublishedPosts);
}

/**
 * The 1-based page a raw `?page=` value asks for. Every non-positive-integer
 * value falls back to page 1, so a malformed query never reaches the
 * repository as a bad offset.
 */
export function requestedPage(rawPage: string | undefined): number {
  const parsed = rawPage === undefined ? 1 : Number(rawPage);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** The number of pages `total` items fill at `pageSize` per page (at least 1). */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** A resolved page of a listing with prev/next page numbers. */
export interface Pagination {
  readonly page: number;
  readonly totalPages: number;
  readonly items: readonly BlogPostSummary[];
  readonly prev: number | null;
  readonly next: number | null;
  /** The listing path the prev/next links point at (`/blog`, a term archive). */
  readonly basePath: string;
}

/** Build the pagination record for one fetched page. */
export function pagination(
  items: readonly BlogPostSummary[],
  page: number,
  totalPages: number,
  basePath: string,
): Pagination {
  return {
    page,
    totalPages,
    items,
    prev: page > 1 ? page - 1 : null,
    next: page < totalPages ? page + 1 : null,
    basePath,
  };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/** The `/blog/<slug>` link for a post; the slug is a single encoded path segment. */
export function postPath(post: Pick<BlogPostSummary, 'slug'>): string {
  return `${BLOG_PATH}/${encodeURIComponent(post.slug)}`;
}

/** The shared unordered list of post links, or the empty-state message. */
function renderPostList(posts: readonly BlogPostSummary[]): string {
  if (posts.length === 0) return '<p>No posts yet.</p>';
  const items = posts.map(
    (post) =>
      `<li><a href="${Str.escapeHtml(postPath(post))}">${Str.escapeHtml(post.title)}</a></li>`,
  );
  return `<ul>${items.join('')}</ul>`;
}

/** Prev/next navigation, or an empty string when there is only one page. */
export function renderPaginationNav(pages: Pagination): string {
  if (pages.prev === null && pages.next === null) return '';
  const base = Str.escapeHtml(pages.basePath);
  const links: string[] = [];
  if (pages.prev !== null) {
    links.push(`<a href="${base}?page=${pages.prev}" rel="prev">Previous</a>`);
  }
  if (pages.next !== null) {
    links.push(`<a href="${base}?page=${pages.next}" rel="next">Next</a>`);
  }
  return `<nav aria-label="Pagination">${links.join(' ')}</nav>`;
}

/** The paginated published index: the current page plus prev/next links. */
export function renderBlogIndex(pages: Pagination): string {
  return renderPostList(pages.items) + renderPaginationNav(pages);
}

/** A category or tag listing with the term name in the heading, paginated. */
export function renderTermIndex(term: BlogTerm, pages: Pagination): string {
  return `<h1>${Str.escapeHtml(term.name)}</h1>` + renderBlogIndex(pages);
}

/**
 * Render the search results list: the count line plus the post list, or a
 * value-free empty-state message when there are no matches. The query is
 * echoed back HTML-escaped in the heading (never into an error), and the post
 * titles/slugs go through the same five-entity escape as the rest of the list.
 */
export function renderSearchResults(
  query: string,
  posts: readonly BlogPostSummary[],
  total: number,
): string {
  const heading = `<h1>Search results for “${Str.escapeHtml(query)}”</h1>`;
  if (posts.length === 0) return heading + '<p>No posts match your search.</p>';
  const count = `<p>${total} result${total === 1 ? '' : 's'}.</p>`;
  return heading + count + renderPostList(posts);
}

/** A server-rendered search form, shared by the themed and plain surfaces. */
export function renderSearchForm(query: string): string {
  return `<form action="/blog/search" method="get" role="search" aria-label="Search the blog"><input type="search" name="q" value="${Str.escapeHtml(query)}" placeholder="Search posts…" aria-label="Search query"><button type="submit">Search</button></form>`;
}

// ---------------------------------------------------------------------------
// Feeds and sitemap
// ---------------------------------------------------------------------------

/** The feed channel text a site configures. */
export interface BlogFeedSite {
  /** The absolute public origin every link is built on. */
  readonly siteUrl: string;
  readonly title: string;
  readonly description?: string;
}

/** Parse a repository ISO timestamp; an unparseable one renders as the epoch. */
function postDate(post: BlogPostSummary): Date {
  return new Date(post.publishedAt ?? post.createdAt);
}

/** The feed channel for a feed served at `<site>/blog/<file>`. */
function blogChannel(site: BlogFeedSite, base: string, file: string): FeedChannel {
  return {
    title: site.title,
    ...(site.description === undefined || site.description === ''
      ? {}
      : { description: site.description }),
    siteUrl: base,
    feedUrl: `${base}${BLOG_PATH}/${file}`,
  };
}

/** Posts as feed items, in the order given; an empty excerpt is no summary. */
function feedItems(posts: readonly BlogPostSummary[], base: string): FeedItem[] {
  return posts.map((post) => ({
    title: post.title,
    url: `${base}${postPath(post)}`,
    ...(post.excerpt === '' ? {} : { summary: post.excerpt }),
    date: postDate(post),
  }));
}

/** Render the RSS 2.0 feed of the given (published, newest-first) posts. */
export function renderBlogRssFeed(posts: readonly BlogPostSummary[], site: BlogFeedSite): string {
  const base = trimTrailingSlashes(site.siteUrl);
  return renderRssXml(blogChannel(site, base, 'rss.xml'), feedItems(posts, base));
}

/** Render the Atom 1.0 feed of the given (published, newest-first) posts. */
export function renderBlogAtomFeed(posts: readonly BlogPostSummary[], site: BlogFeedSite): string {
  const base = trimTrailingSlashes(site.siteUrl);
  return renderAtomXml(blogChannel(site, base, 'atom.xml'), feedItems(posts, base));
}

/**
 * The calendar day (`YYYY-MM-DD`) of an instant in a time zone, or `undefined`
 * for an unparseable instant. An unknown zone falls back to UTC.
 */
export function calendarDay(iso: string, timeZone: string): string | undefined {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return undefined;
  try {
    // `en-CA` formats a date as `YYYY-MM-DD`.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/**
 * Render the sitemap: `/blog` plus one `<url>` per given post, each carrying
 * its publication (or last update) day in the site's time zone as `<lastmod>`.
 */
export function renderBlogSitemap(
  posts: readonly BlogPostSummary[],
  siteUrl: string,
  timeZone = 'UTC',
): string {
  const base = trimTrailingSlashes(siteUrl);
  return renderSitemapXml([
    { loc: `${base}${BLOG_PATH}` },
    ...posts.map((post) => {
      const lastmod = calendarDay(post.publishedAt ?? post.updatedAt, timeZone);
      return { loc: `${base}${postPath(post)}`, ...(lastmod === undefined ? {} : { lastmod }) };
    }),
  ]);
}
