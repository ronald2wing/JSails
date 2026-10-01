/**
 * Public discovery surfaces for the blog plugin: paginated list, category/tag
 * listings, RSS/Atom feeds, and the sitemap.
 *
 * Everything here is a pure function over the plain `BlogPost`/`BlogTerm`
 * records the repository returns; the routes in `plugin.ts` fetch the entities
 * and hand them in, so escaping and XML validity stay in one place and stay
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
import { compareStrings, Str } from 'jsails/support';

import type { BlogTerm, BlogPost } from './cms/index.js';

/** Fixed page size for the paginated published list. */
const BLOG_PAGE_SIZE = 10;

/** Fixed site title for feeds; the site URL is derived from the request origin. */
const BLOG_SITE_TITLE = 'Blog';

/** The path segment the discovery surfaces live under. */
const BLOG_PATH = '/blog';

// ---------------------------------------------------------------------------
// Ordering and pagination
// ---------------------------------------------------------------------------

/**
 * Published posts newest-first: `publishedAt` descending, then `createdAt`
 * descending, then `id` for a deterministic tiebreak.
 */
export function publishedPosts(posts: readonly BlogPost[]): readonly BlogPost[] {
  return posts
    .filter((post) => post.status === 'published')
    .sort((a, b) => {
      const byPublished = compareStrings(b.publishedAt ?? '', a.publishedAt ?? '');
      if (byPublished !== 0) return byPublished;
      const byCreated = compareStrings(b.createdAt, a.createdAt);
      if (byCreated !== 0) return byCreated;
      return compareStrings(a.id, b.id);
    });
}

/** A resolved page of the published list with prev/next page numbers. */
export interface Pagination {
  readonly page: number;
  readonly totalPages: number;
  readonly items: readonly BlogPost[];
  readonly prev: number | null;
  readonly next: number | null;
}

/**
 * Resolve a raw `?page=` value to a valid page of the given post set. Every
 * non-positive-integer value falls back to page 1, and a page beyond the last
 * clamps to the last page, so the caller can never receive an out-of-range
 * slice or a 500 from a malformed query.
 */
export function paginate(posts: readonly BlogPost[], rawPage: string | undefined): Pagination {
  const parsed = rawPage === undefined ? 1 : Number(rawPage);
  const requested = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  const totalPages = Math.max(1, Math.ceil(posts.length / BLOG_PAGE_SIZE));
  const page = Math.min(requested, totalPages);
  const start = (page - 1) * BLOG_PAGE_SIZE;
  return {
    page,
    totalPages,
    items: posts.slice(start, start + BLOG_PAGE_SIZE),
    prev: page > 1 ? page - 1 : null,
    next: page < totalPages ? page + 1 : null,
  };
}

// ---------------------------------------------------------------------------
// Taxonomy resolution
// ---------------------------------------------------------------------------

/** Resolve a category or tag by slug (posts reference terms by id). */
export function findTermBySlug(terms: readonly BlogTerm[], slug: string): BlogTerm | undefined {
  return terms.find((term) => term.slug === slug);
}

/** Published posts carrying the given category id. */
export function postsInCategory(
  posts: readonly BlogPost[],
  categoryId: string,
): readonly BlogPost[] {
  return publishedPosts(posts).filter((post) => post.categoryIds.includes(categoryId));
}

/** Published posts carrying the given tag id. */
export function postsInTag(posts: readonly BlogPost[], tagId: string): readonly BlogPost[] {
  return publishedPosts(posts).filter((post) => post.tagIds.includes(tagId));
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/** The shared unordered list of post links, or the empty-state message. */
function renderPostList(posts: readonly BlogPost[]): string {
  if (posts.length === 0) return '<p>No posts yet.</p>';
  const items = posts.map(
    (post) =>
      `<li><a href="/blog/${Str.escapeHtml(post.slug)}">${Str.escapeHtml(post.title)}</a></li>`,
  );
  return `<ul>${items.join('')}</ul>`;
}

/** Prev/next navigation, or an empty string when there is only one page. */
function renderPaginationNav(pagination: Pagination): string {
  if (pagination.prev === null && pagination.next === null) return '';
  const links: string[] = [];
  if (pagination.prev !== null) {
    links.push(`<a href="/blog?page=${pagination.prev}" rel="prev">Previous</a>`);
  }
  if (pagination.next !== null) {
    links.push(`<a href="/blog?page=${pagination.next}" rel="next">Next</a>`);
  }
  return `<nav>${links.join(' ')}</nav>`;
}

/** The paginated published index: the current page plus prev/next links. */
export function renderBlogIndex(pagination: Pagination): string {
  return renderPostList(pagination.items) + renderPaginationNav(pagination);
}

/** A category or tag listing with the term name in the heading. */
export function renderTermIndex(term: BlogTerm, posts: readonly BlogPost[]): string {
  return `<h1>${Str.escapeHtml(term.name)}</h1>` + renderPostList(posts);
}

/**
 * Render the search results list: the count line plus the post list, or a
 * value-free empty-state message when there are no matches. The query is
 * echoed back HTML-escaped in the heading (never into an error), and the post
 * titles/slugs go through the same five-entity escape as the rest of the list.
 */
export function renderSearchResults(
  query: string,
  posts: readonly BlogPost[],
  total: number,
): string {
  const heading = `<h1>Search results for \u201c${Str.escapeHtml(query)}\u201d</h1>`;
  if (posts.length === 0) return heading + '<p>No posts match your search.</p>';
  const count = `<p>${total} result${total === 1 ? '' : 's'}.</p>`;
  return heading + count + renderPostList(posts);
}

/** A server-rendered search form, shared by the themed and plain surfaces. */
export function renderSearchForm(query: string): string {
  return `<form action="/blog/search" method="get" role="search" aria-label="Search the blog"><input type="search" name="q" value="${Str.escapeHtml(query)}" placeholder="Search posts\u2026" aria-label="Search query"><button type="submit">Search</button></form>`;
}

// ---------------------------------------------------------------------------
// Feeds and sitemap
// ---------------------------------------------------------------------------

/** Parse a repository ISO timestamp; an unparseable one renders as the epoch. */
function postDate(post: BlogPost): Date {
  return new Date(post.publishedAt ?? post.createdAt);
}

/** The feed channel for a feed served at `<site>/blog/<file>`. */
function blogChannel(site: string, file: string): FeedChannel {
  return { title: BLOG_SITE_TITLE, siteUrl: site, feedUrl: `${site}${BLOG_PATH}/${file}` };
}

/** Published posts as newest-first feed items; an empty excerpt is no summary. */
function feedItems(posts: readonly BlogPost[], site: string): FeedItem[] {
  return publishedPosts(posts).map((post) => ({
    title: post.title,
    url: `${site}${BLOG_PATH}/${post.slug}`,
    ...(post.excerpt === '' ? {} : { summary: post.excerpt }),
    date: postDate(post),
  }));
}

/** Render the RSS 2.0 feed of published posts. */
export function renderBlogRssFeed(posts: readonly BlogPost[], siteUrl: string): string {
  const site = trimTrailingSlashes(siteUrl);
  return renderRssXml(blogChannel(site, 'rss.xml'), feedItems(posts, site));
}

/** Render the Atom 1.0 feed of published posts. */
export function renderBlogAtomFeed(posts: readonly BlogPost[], siteUrl: string): string {
  const site = trimTrailingSlashes(siteUrl);
  return renderAtomXml(blogChannel(site, 'atom.xml'), feedItems(posts, site));
}

/**
 * Render the sitemap: `/blog` plus one `<url>` per published post, each post
 * carrying its publication (or last update) day as `<lastmod>`.
 */
export function renderBlogSitemap(posts: readonly BlogPost[], siteUrl: string): string {
  const site = trimTrailingSlashes(siteUrl);
  return renderSitemapXml([
    { loc: `${site}${BLOG_PATH}` },
    ...publishedPosts(posts).map((post) => {
      const lastmod = new Date(post.publishedAt ?? post.updatedAt);
      return {
        loc: `${site}${BLOG_PATH}/${post.slug}`,
        ...(Number.isNaN(lastmod.getTime()) ? {} : { lastmod: lastmod.toISOString().slice(0, 10) }),
      };
    }),
  ]);
}
