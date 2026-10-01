/**
 * Public discovery surfaces for the blog plugin: paginated list, category/tag
 * listings, RSS/Atom feeds, and the sitemap.
 *
 * Everything here is a pure function over the plain `Post`/`Category`/`Tag`
 * records the repository returns; the routes in `plugin.ts` fetch the entities
 * and hand them in, so escaping and XML validity stay in one place and stay
 * testable without a listener or database. The list/listings render HTML, the
 * feeds and sitemap render XML — both go through the same five-entity escape
 * (`& < > " '`), which is exactly the set HTML and XML text/attributes share.
 *
 * Server-only: nothing here is re-exported from the public `jsails/blog`
 * barrel.
 */

import { Str, Time } from 'jsails/support';

import type { Category, Post, Tag } from './content/index.js';

/** Fixed page size for the paginated published list. */
export const BLOG_PAGE_SIZE = 10;

/** Fixed site title for feeds; the site URL is derived from the request origin. */
export const BLOG_SITE_TITLE = 'Blog';

/** The path segment the discovery surfaces live under. */
const BLOG_PATH = '/blog';

/**
 * Escape `&`, `<`, `>`, `"`, and `'` — the single shared set for HTML and XML
 * text and attribute content.
 */
function escapeXml(value: string): string {
  return Str.escapeHtml(value);
}

// ---------------------------------------------------------------------------
// Ordering and pagination
// ---------------------------------------------------------------------------

/**
 * Published posts newest-first: `publishedAt` descending, then `createdAt`
 * descending, then `id` for a deterministic tiebreak.
 */
export function publishedPosts(posts: readonly Post[]): readonly Post[] {
  return posts
    .filter((post) => post.status === 'published')
    .sort((a, b) => {
      const aPub = a.publishedAt ?? '';
      const bPub = b.publishedAt ?? '';
      if (aPub !== bPub) return aPub > bPub ? -1 : 1;
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return 0;
    });
}

/** A resolved page of the published list with prev/next page numbers. */
export interface Pagination {
  readonly page: number;
  readonly totalPages: number;
  readonly items: readonly Post[];
  readonly prev: number | null;
  readonly next: number | null;
}

/**
 * Resolve a raw `?page=` value to a valid page of the given post set. Every
 * non-positive-integer value falls back to page 1, and a page beyond the last
 * clamps to the last page, so the caller can never receive an out-of-range
 * slice or a 500 from a malformed query.
 */
export function paginate(posts: readonly Post[], rawPage: string | undefined): Pagination {
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

/** Resolve a category by slug (posts reference terms by id via `categoryIds`). */
export function findCategoryBySlug(
  categories: readonly Category[],
  slug: string,
): Category | undefined {
  return categories.find((category) => category.slug === slug);
}

/** Resolve a tag by slug (posts reference terms by id via `tagIds`). */
export function findTagBySlug(tags: readonly Tag[], slug: string): Tag | undefined {
  return tags.find((tag) => tag.slug === slug);
}

/** Published posts carrying the given category id. */
export function postsInCategory(posts: readonly Post[], categoryId: string): readonly Post[] {
  return publishedPosts(posts).filter((post) => post.categoryIds.includes(categoryId));
}

/** Published posts carrying the given tag id. */
export function postsInTag(posts: readonly Post[], tagId: string): readonly Post[] {
  return publishedPosts(posts).filter((post) => post.tagIds.includes(tagId));
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/** The shared unordered list of post links, or the empty-state message. */
function renderPostList(posts: readonly Post[]): string {
  if (posts.length === 0) return '<p>No posts yet.</p>';
  const items = posts.map(
    (post) => `<li><a href="/blog/${escapeXml(post.slug)}">${escapeXml(post.title)}</a></li>`,
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

/** A category listing with the category name in the heading. */
export function renderCategoryIndex(category: Category, posts: readonly Post[]): string {
  return `<h1>${escapeXml(category.name)}</h1>` + renderPostList(posts);
}

/** A tag listing with the tag name in the heading. */
export function renderTagIndex(tag: Tag, posts: readonly Post[]): string {
  return `<h1>${escapeXml(tag.name)}</h1>` + renderPostList(posts);
}

/**
 * Render the search results list: the count line plus the post list, or a
 * value-free empty-state message when there are no matches. The query is
 * echoed back HTML-escaped in the heading (never into an error), and the post
 * titles/slugs go through the same five-entity escape as the rest of the list.
 */
export function renderSearchResults(query: string, posts: readonly Post[], total: number): string {
  const heading = `<h1>Search results for \u201c${escapeXml(query)}\u201d</h1>`;
  if (posts.length === 0) return heading + '<p>No posts match your search.</p>';
  const count = `<p>${total} result${total === 1 ? '' : 's'}.</p>`;
  return heading + count + renderPostList(posts);
}

/** A server-rendered search form, shared by the themed and plain surfaces. */
export function renderSearchForm(query: string): string {
  return `<form action="/blog/search" method="get" role="search" aria-label="Search the blog"><input type="search" name="q" value="${escapeXml(query)}" placeholder="Search posts\u2026" aria-label="Search query"><button type="submit">Search</button></form>`;
}

// ---------------------------------------------------------------------------
// Date formatting (RFC 822 for RSS, ISO 8601 for Atom)
// ---------------------------------------------------------------------------

/** Format an ISO timestamp as an RFC 822 datetime, falling back to the epoch. */
function toRfc822(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 'Thu, 01 Jan 1970 00:00:00 +0000';
  return Time.rfc822(parsed);
}

/** Normalize an ISO timestamp to canonical UTC, falling back to the epoch. */
function toIso8601(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '1970-01-01T00:00:00.000Z';
  return Time.iso8601(parsed);
}

// ---------------------------------------------------------------------------
// Site URL derivation
// ---------------------------------------------------------------------------

/** The absolute post URL for a slug under the given site origin. */
function postUrl(site: string, slug: string): string {
  return `${site}${BLOG_PATH}/${slug}`;
}

// ---------------------------------------------------------------------------
// RSS 2.0
// ---------------------------------------------------------------------------

/**
 * Render an RSS 2.0 feed of published posts. Each item carries `title`,
 * `link`, `guid`, and `pubDate`; `description` is emitted only when the post
 * has an excerpt.
 */
export function renderRssFeed(posts: readonly Post[], siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, '');
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${escapeXml(BLOG_SITE_TITLE)}</title>`,
    `<link>${escapeXml(site)}</link>`,
    `<atom:link href="${escapeXml(`${site}${BLOG_PATH}/rss.xml`)}" rel="self" type="application/rss+xml"/>`,
  ];

  for (const post of publishedPosts(posts)) {
    const url = postUrl(site, post.slug);
    parts.push('<item>');
    parts.push(`<title>${escapeXml(post.title)}</title>`);
    parts.push(`<link>${escapeXml(url)}</link>`);
    parts.push(`<guid isPermaLink="true">${escapeXml(url)}</guid>`);
    parts.push(`<pubDate>${toRfc822(post.publishedAt ?? post.createdAt)}</pubDate>`);
    if (post.excerpt !== '') parts.push(`<description>${escapeXml(post.excerpt)}</description>`);
    parts.push('</item>');
  }

  parts.push('</channel>', '</rss>');
  return parts.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Atom 1.0
// ---------------------------------------------------------------------------

/**
 * Render an Atom 1.0 feed of published posts. Entries carry `title`, `link`,
 * `id`, `updated`, and an optional `summary` (the excerpt).
 */
export function renderAtomFeed(posts: readonly Post[], siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, '');
  const ordered = publishedPosts(posts);
  const feedUpdated =
    ordered[0] === undefined
      ? toIso8601('')
      : toIso8601(ordered[0].publishedAt ?? ordered[0].createdAt);

  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<title>${escapeXml(BLOG_SITE_TITLE)}</title>`,
    `<link href="${escapeXml(`${site}${BLOG_PATH}/atom.xml`)}" rel="self"/>`,
    `<link href="${escapeXml(site)}"/>`,
    `<id>${escapeXml(`${site}${BLOG_PATH}/atom.xml`)}</id>`,
    `<updated>${feedUpdated}</updated>`,
  ];

  for (const post of ordered) {
    const url = postUrl(site, post.slug);
    parts.push('<entry>');
    parts.push(`<title>${escapeXml(post.title)}</title>`);
    parts.push(`<link href="${escapeXml(url)}"/>`);
    parts.push(`<id>${escapeXml(url)}</id>`);
    parts.push(`<updated>${toIso8601(post.publishedAt ?? post.createdAt)}</updated>`);
    if (post.excerpt !== '') parts.push(`<summary>${escapeXml(post.excerpt)}</summary>`);
    parts.push('</entry>');
  }

  parts.push('</feed>');
  return parts.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

/**
 * Render a sitemap with one `<url>` for `/blog` and one per published post,
 * each carrying `<loc>` and, when the post has a date, a `<lastmod>`.
 */
export function renderSitemap(posts: readonly Post[], siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, '');
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '<url>',
    `<loc>${escapeXml(`${site}${BLOG_PATH}`)}</loc>`,
    '</url>',
  ];

  for (const post of publishedPosts(posts)) {
    const url = postUrl(site, post.slug);
    parts.push('<url>');
    parts.push(`<loc>${escapeXml(url)}</loc>`);
    const lastmod = post.publishedAt ?? post.updatedAt ?? post.createdAt;
    parts.push(`<lastmod>${toIso8601(lastmod).slice(0, 10)}</lastmod>`);
    parts.push('</url>');
  }

  parts.push('</urlset>');
  return parts.join('\n') + '\n';
}
