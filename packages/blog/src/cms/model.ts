/**
 * Tenant-free content model schemas and types for the blog CMS.
 *
 * This module owns the persisted shapes of every content entity (posts,
 * pages, categories, tags, media references, menus, settings, and revisions)
 * as Zod schemas plus their inferred TypeScript types. It imports nothing from
 * TypeORM: the `BlogRepository` contract (`./repository.ts`) is the persistence
 * boundary, and each implementation maps these plain values into its storage.
 *
 * Timestamps are ISO 8601 strings (as produced by `Date#toISOString`), kept as
 * strings so a tenant-free core carries no clock or database coupling. The
 * repository assigns ids and timestamps; input types therefore omit them.
 */

import { z } from 'zod';

import type { JsonValue } from 'jsails/plugin-sdk';
import { parseRichText, richTextSchema, type RichTextDocument } from 'jsails/rich-text';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(190);

/**
 * A URL slug: lowercase ASCII words joined by single hyphens. Every writer (the
 * admin, revision restore, and any app code) goes through the model schemas, so
 * a slug can never carry a path separator, query, fragment, or markup that a
 * route or link would have to defend against.
 */
export const BLOG_SLUG_PATTERN: RegExp = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const slugSchema = z.string().min(1).max(190).regex(BLOG_SLUG_PATTERN);
const nameSchema = z.string().min(1).max(190);
const descriptionSchema = z.string().max(2000).optional();
const timestampSchema = z.string().min(1); // ISO 8601, e.g. 2026-01-01T00:00:00.000Z

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Lifecycle state of a post or page. */
export const contentStatusSchema: z.ZodEnum<{
  draft: 'draft';
  published: 'published';
  scheduled: 'scheduled';
  archived: 'archived';
}> = z.enum(['draft', 'published', 'scheduled', 'archived']);

/** A post/page lifecycle state. */
export type BlogContentStatus = z.infer<typeof contentStatusSchema>;

// ---------------------------------------------------------------------------
// JSON-safe values
// ---------------------------------------------------------------------------

/** Recursive schema for a JSON-safe value (used for settings and snapshots). */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * A post or page body: a document `parseRichText` reads, so canonical and
 * within budget. Writers normalise before calling the repository (the admin
 * field does); a body in any other form is refused, never repaired here.
 */
const bodySchema: typeof richTextSchema = richTextSchema.superRefine((document, context) => {
  const read = parseRichText(document);
  if (!read.ok) {
    for (const issue of read.issues) {
      context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
    }
  }
});

// ---------------------------------------------------------------------------
// Categories and tags
// ---------------------------------------------------------------------------

/**
 * A taxonomy term: the one shape categories and tags share. The two
 * collections differ only in which table and repository methods hold them.
 */
export const blogTermSchema: z.ZodObject<
  {
    id: z.ZodString;
    name: z.ZodString;
    slug: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
> = z.object({
  id: idSchema,
  name: nameSchema,
  slug: slugSchema,
  description: descriptionSchema,
});

/** A category or tag. */
export type BlogTerm = z.infer<typeof blogTermSchema>;

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** A named menu item (a node in a menu tree). */
export interface BlogMenuItem {
  readonly label: string;
  readonly href: string;
  readonly sortOrder: number;
  readonly children: readonly BlogMenuItem[];
}

/** Most items one menu level may hold. */
export const BLOG_MENU_MAX_ITEMS = 100;

/** Deepest nesting a menu tree may reach (top-level items are depth 1). */
export const BLOG_MENU_MAX_DEPTH = 4;

/** C0 controls and DEL: browsers drop tab/CR/LF from URLs, so `java\tscript:` would run. */
const URL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Schemes a menu link may use; everything else (`javascript:`, `data:`, ...) is refused. */
const MENU_HREF_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * The menu link policy: a same-origin path (`/about`, `about`), a fragment or
 * query, or an absolute `http:`/`https:`/`mailto:` URL. Control characters,
 * backslashes, and protocol-relative `//host` values are refused, because
 * browsers normalize them into another origin or an executable scheme.
 */
export function isAllowedMenuHref(href: string): boolean {
  if (href.trim() !== href || href === '') return false;
  if (URL_CONTROL_CHARS.test(href) || href.includes('\\') || href.startsWith('//')) {
    return false;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (scheme !== null) return MENU_HREF_SCHEMES.has(scheme[1]!.toLowerCase());
  // A colon before the first `/`, `?`, or `#` is a scheme the pattern above did
  // not recognize (for example one starting with a digit): refuse it.
  const firstDelimiter = href.search(/[/?#]/);
  const colon = href.indexOf(':');
  return colon === -1 || (firstDelimiter !== -1 && firstDelimiter < colon);
}

/** The depth of a menu tree (an empty list is depth 0). */
function menuDepth(items: readonly BlogMenuItem[]): number {
  let depth = 0;
  for (const item of items) depth = Math.max(depth, 1 + menuDepth(item.children));
  return depth;
}

/** Recursive schema for {@link BlogMenuItem}. */
export const menuItemSchema: z.ZodType<BlogMenuItem> = z.lazy(() =>
  z.object({
    label: z.string().min(1).max(190),
    href: z.string().min(1).max(2048).refine(isAllowedMenuHref),
    sortOrder: z.number().int(),
    children: z.array(menuItemSchema).max(BLOG_MENU_MAX_ITEMS),
  }),
);

/** A named, location-bound menu. */
export const menuSchema: z.ZodObject<
  {
    id: z.ZodString;
    name: z.ZodString;
    location: z.ZodString;
    items: z.ZodArray<z.ZodType<BlogMenuItem>>;
  },
  z.core.$strip
> = z.object({
  id: idSchema,
  name: nameSchema,
  location: z.string().min(1).max(64),
  items: z
    .array(menuItemSchema)
    .max(BLOG_MENU_MAX_ITEMS)
    .refine((items) => menuDepth(items) <= BLOG_MENU_MAX_DEPTH),
});

/** A navigation menu. */
export type BlogMenu = z.infer<typeof menuSchema>;

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/** The fields of {@link postSchema}. */
type PostShape = {
  id: z.ZodString;
  title: z.ZodString;
  slug: z.ZodString;
  excerpt: z.ZodString;
  blocks: typeof richTextSchema;
  status: typeof contentStatusSchema;
  authorId: z.ZodString;
  featuredMediaId: z.ZodNullable<z.ZodString>;
  categoryIds: z.ZodArray<z.ZodString>;
  tagIds: z.ZodArray<z.ZodString>;
  publishedAt: z.ZodNullable<z.ZodString>;
  createdAt: z.ZodString;
  updatedAt: z.ZodString;
};

/** An authored blog post. */
export const postSchema: z.ZodObject<PostShape, z.core.$strip> = z.object({
  id: idSchema,
  title: nameSchema,
  slug: slugSchema,
  excerpt: z.string().max(2000),
  blocks: bodySchema,
  status: contentStatusSchema,
  authorId: idSchema,
  featuredMediaId: idSchema.nullable(),
  categoryIds: z.array(idSchema),
  tagIds: z.array(idSchema),
  publishedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** A blog post. */
export type BlogPost = z.infer<typeof postSchema>;

/**
 * A post without its rich-text body: what a listing, feed, or sitemap needs.
 * Repositories return summaries for list reads so a page of cards never loads
 * every post's `blocks`.
 */
export type BlogPostSummary = Omit<BlogPost, 'blocks'>;

/** A page window over a post listing. */
export interface BlogPostSummaryQuery {
  /** Most posts to return; a positive integer. */
  readonly limit: number;
  /** Posts to skip before the page; a non-negative integer. */
  readonly offset: number;
}

/** One page of published posts, newest first, filtered to a term when given. */
export interface BlogPublishedPostQuery extends BlogPostSummaryQuery {
  /** Only posts carrying this category id. */
  readonly categoryId?: string;
  /** Only posts carrying this tag id. */
  readonly tagId?: string;
}

/** The result of {@link BlogPublishedPostQuery}: the page plus the total match count. */
export interface BlogPostPage {
  readonly posts: readonly BlogPostSummary[];
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** The fields of {@link pageSchema}. */
type PageShape = {
  id: z.ZodString;
  title: z.ZodString;
  slug: z.ZodString;
  blocks: typeof richTextSchema;
  status: typeof contentStatusSchema;
  parentId: z.ZodNullable<z.ZodString>;
  sortOrder: z.ZodNumber;
  createdAt: z.ZodString;
  updatedAt: z.ZodString;
};

/** A standalone content page. */
export const pageSchema: z.ZodObject<PageShape, z.core.$strip> = z.object({
  id: idSchema,
  title: nameSchema,
  slug: slugSchema,
  blocks: bodySchema,
  status: contentStatusSchema,
  parentId: idSchema.nullable(),
  sortOrder: z.number().int(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** A content page. */
export type BlogPage = z.infer<typeof pageSchema>;

// ---------------------------------------------------------------------------
// Revision snapshots
// ---------------------------------------------------------------------------

/**
 * The content fields captured in a post revision snapshot (everything the
 * admin CRUD surface can edit, plus the taxonomy/media relations it may later
 * surface). Lifecycle and repository-owned fields (`id`, `status`, `authorId`,
 * timestamps) are deliberately excluded: a restore applies these fields onto
 * the current entity rather than resurrecting a point-in-time row.
 */
export const postSnapshotSchema: z.ZodObject<
  Pick<
    PostShape,
    'title' | 'slug' | 'excerpt' | 'blocks' | 'categoryIds' | 'tagIds' | 'featuredMediaId'
  >,
  z.core.$strip
> = postSchema.pick({
  title: true,
  slug: true,
  excerpt: true,
  blocks: true,
  categoryIds: true,
  tagIds: true,
  featuredMediaId: true,
});

/** The content captured in a {@link postSnapshotSchema} revision. */
export type BlogPostSnapshot = z.infer<typeof postSnapshotSchema>;

/** The content fields captured in a page revision snapshot. */
export const pageSnapshotSchema: z.ZodObject<
  Pick<PageShape, 'title' | 'slug' | 'blocks' | 'parentId' | 'sortOrder'>,
  z.core.$strip
> = pageSchema.pick({
  title: true,
  slug: true,
  blocks: true,
  parentId: true,
  sortOrder: true,
});

/** The content captured in a {@link pageSnapshotSchema} revision. */
export type BlogPageSnapshot = z.infer<typeof pageSnapshotSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** A keyed application setting with a JSON-safe value. */
export const settingSchema: z.ZodObject<
  { key: z.ZodString; value: z.ZodType<JsonValue>; updatedAt: z.ZodString },
  z.core.$strip
> = z.object({
  key: z.string().min(1).max(190),
  value: jsonValueSchema,
  updatedAt: timestampSchema,
});

/** A keyed setting. */
export type BlogSetting = z.infer<typeof settingSchema>;

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/** A point-in-time snapshot of a content entry. */
export const revisionSchema: z.ZodObject<
  {
    id: z.ZodString;
    entryType: z.ZodString;
    entryId: z.ZodString;
    snapshot: z.ZodType<JsonValue>;
    createdAt: z.ZodString;
    authorId: z.ZodString;
  },
  z.core.$strip
> = z.object({
  id: idSchema,
  entryType: z.string().min(1).max(64),
  entryId: idSchema,
  snapshot: jsonValueSchema,
  createdAt: timestampSchema,
  authorId: idSchema,
});

/** A content revision. */
export type BlogRevision = z.infer<typeof revisionSchema>;

// ---------------------------------------------------------------------------
// Repository input types (ids and timestamps are repository-owned)
// ---------------------------------------------------------------------------

/** Fields the repository accepts when creating a post. */
export interface BlogPostCreateInput {
  readonly title: string;
  readonly slug: string;
  readonly excerpt?: string;
  readonly blocks: RichTextDocument;
  readonly status: BlogContentStatus;
  readonly authorId: string;
  readonly featuredMediaId?: string;
  readonly categoryIds?: readonly string[];
  readonly tagIds?: readonly string[];
}

/** Fields the repository accepts when updating a post (all optional). */
export interface BlogPostUpdateInput {
  readonly title?: string;
  readonly slug?: string;
  readonly excerpt?: string;
  readonly blocks?: RichTextDocument;
  /** Pass `null` to clear the featured media; omit to keep the current value. */
  readonly featuredMediaId?: string | null;
  readonly categoryIds?: readonly string[];
  readonly tagIds?: readonly string[];
}

/** Fields the repository accepts when creating a page. */
export interface BlogPageCreateInput {
  readonly title: string;
  readonly slug: string;
  readonly blocks: RichTextDocument;
  readonly status: BlogContentStatus;
  readonly parentId?: string;
  readonly sortOrder?: number;
}

/** Fields the repository accepts when updating a page (all optional). */
export interface BlogPageUpdateInput {
  readonly title?: string;
  readonly slug?: string;
  readonly blocks?: RichTextDocument;
  /** Pass `null` to detach the page from its parent; omit to keep the parent. */
  readonly parentId?: string | null;
  readonly sortOrder?: number;
}

/**
 * Fields the repository accepts when creating or updating a category or tag.
 * On update, an omitted `description` keeps the stored one.
 */
export interface BlogTermInput {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
}

/** Fields the repository accepts when creating a menu. */
export interface BlogMenuCreateInput {
  readonly name: string;
  readonly location: string;
  readonly items: readonly BlogMenuItem[];
}

/** Fields the repository accepts when updating a menu (all optional). */
export interface BlogMenuUpdateInput {
  readonly name?: string;
  readonly location?: string;
  readonly items?: readonly BlogMenuItem[];
}

/** Fields the repository accepts when appending a revision. */
export interface BlogRevisionInput {
  readonly entryType: string;
  readonly entryId: string;
  readonly snapshot: JsonValue;
  readonly authorId: string;
}
