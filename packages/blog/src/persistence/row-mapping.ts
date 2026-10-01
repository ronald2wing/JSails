/**
 * Entity row to plain model value mapping for the database-backed blog
 * repository.
 *
 * Rows carry the database-internal integer `id` and `Date` columns; model values
 * carry the repository-assigned string id (`contentId`) and ISO timestamps. The
 * mapping is the only place those two representations meet.
 */

import type {
  BlogTerm,
  BlogMenu,
  BlogPage,
  BlogPost,
  BlogRevision,
  BlogSetting,
} from '../cms/model.js';
import type {
  JsailsBlogCategory,
  JsailsBlogMenu,
  JsailsBlogPage,
  JsailsBlogPost,
  JsailsBlogRevision,
  JsailsBlogSetting,
  JsailsBlogTag,
} from './entities.js';

/** Parse an ISO string into a `Date` for a `datetime` column. */
export function toDate(iso: string): Date {
  return new Date(iso);
}

export function rowToPost(row: JsailsBlogPost): BlogPost {
  return {
    id: row.contentId,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    blocks: row.blocks,
    ...(row.editor === null ? {} : { editor: row.editor }),
    ...(row.native === null ? {} : { native: row.native }),
    status: row.status,
    authorId: row.authorId,
    featuredMediaId: row.featuredMediaId,
    categoryIds: row.categoryIds,
    tagIds: row.tagIds,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function rowToPage(row: JsailsBlogPage): BlogPage {
  return {
    id: row.contentId,
    title: row.title,
    slug: row.slug,
    blocks: row.blocks,
    ...(row.editor === null ? {} : { editor: row.editor }),
    ...(row.native === null ? {} : { native: row.native }),
    status: row.status,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Map a category or tag row. A `null` or empty description column is the
 * model's absent description.
 */
export function rowToTerm(row: JsailsBlogCategory | JsailsBlogTag): BlogTerm {
  const description =
    row.description === null || row.description === '' ? undefined : row.description;
  return {
    id: row.contentId,
    name: row.name,
    slug: row.slug,
    ...(description === undefined ? {} : { description }),
  };
}

export function rowToSetting(row: JsailsBlogSetting): BlogSetting {
  return { key: row.key, value: row.value, updatedAt: row.updatedAt.toISOString() };
}

export function rowToMenu(row: JsailsBlogMenu): BlogMenu {
  return { id: row.contentId, name: row.name, location: row.location, items: row.items };
}

export function rowToRevision(row: JsailsBlogRevision): BlogRevision {
  return {
    id: row.contentId,
    entryType: row.entryType,
    entryId: row.entryId,
    snapshot: row.snapshot,
    createdAt: row.createdAt.toISOString(),
    authorId: row.authorId,
  };
}
