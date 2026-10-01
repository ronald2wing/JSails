/**
 * Tenant-free content model schemas and types for the blog CMS.
 *
 * This module owns the persisted shapes of every content entity — posts,
 * pages, categories, tags, media references, menus, settings, and revisions —
 * as Zod schemas plus their inferred TypeScript types. It imports nothing from
 * TypeORM: the repository in `./repository.ts` is the persistence boundary,
 * and a future database-backed repository would map these plain values into
 * whatever storage the app selects.
 *
 * Timestamps are ISO 8601 strings (as produced by `Date#toISOString`), kept as
 * strings so a tenant-free core carries no clock or database coupling. The
 * repository assigns ids and timestamps; input types therefore omit them.
 */

import { z } from 'zod';

import { richTextSchema, type RichTextDocument } from 'jsails/rich-text';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(190);
const slugSchema = z.string().min(1).max(190);
const nameSchema = z.string().min(1).max(190);
const descriptionSchema = z.string().max(2000).optional();
const timestampSchema = z.string().min(1); // ISO 8601, e.g. 2026-01-01T00:00:00.000Z

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Lifecycle state of a post or page. */
export const contentStatusSchema = z.enum(['draft', 'published', 'scheduled', 'archived']);

/** A post/page lifecycle state. */
export type ContentStatus = z.infer<typeof contentStatusSchema>;

// ---------------------------------------------------------------------------
// JSON-safe values
// ---------------------------------------------------------------------------

/** Any value that survives a JSON round-trip (used for settings and snapshots). */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };

/** Recursive schema for {@link JsonValue}. */
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
// Editor bodies
// ---------------------------------------------------------------------------

// The editor adapter id, when the record was written through an editor adapter.
// Bounded to the same `varchar(190)` width as other id columns; absent for a
// canonical-only record.
const editorIdSchema = z.string().min(1).max(190).optional();

// The editor-native payload, when the adapter preserved one; opaque JSON.
const nativeSchema = jsonValueSchema.optional();

// ---------------------------------------------------------------------------
// Categories and tags
// ---------------------------------------------------------------------------

/** A content category. */
export const categorySchema = z.object({
  id: idSchema,
  name: nameSchema,
  slug: slugSchema,
  description: descriptionSchema,
});

/** A category taxonomy term. */
export type Category = z.infer<typeof categorySchema>;

/** A content tag. */
export const tagSchema = z.object({
  id: idSchema,
  name: nameSchema,
  slug: slugSchema,
  description: descriptionSchema,
});

/** A tag taxonomy term. */
export type Tag = z.infer<typeof tagSchema>;

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** A named menu item (a node in a menu tree). */
export interface MenuItem {
  readonly label: string;
  readonly href: string;
  readonly sortOrder: number;
  readonly children: MenuItem[];
}

/** Recursive schema for {@link MenuItem}. */
export const menuItemSchema: z.ZodType<MenuItem> = z.lazy(() =>
  z.object({
    label: z.string().min(1).max(190),
    href: z.string().min(1).max(2048),
    sortOrder: z.number().int(),
    children: z.array(menuItemSchema),
  }),
);

/** A named, location-bound menu. */
export const menuSchema = z.object({
  id: idSchema,
  name: nameSchema,
  location: z.string().min(1).max(64),
  items: z.array(menuItemSchema),
});

/** A navigation menu. */
export type Menu = z.infer<typeof menuSchema>;

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/** An authored blog post. */
export const postSchema = z.object({
  id: idSchema,
  title: nameSchema,
  slug: slugSchema,
  excerpt: z.string().max(2000),
  blocks: richTextSchema,
  editor: editorIdSchema,
  native: nativeSchema,
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
export type Post = z.infer<typeof postSchema>;

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** A standalone content page. */
export const pageSchema = z.object({
  id: idSchema,
  title: nameSchema,
  slug: slugSchema,
  blocks: richTextSchema,
  editor: editorIdSchema,
  native: nativeSchema,
  status: contentStatusSchema,
  parentId: idSchema.nullable(),
  sortOrder: z.number().int(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** A content page. */
export type Page = z.infer<typeof pageSchema>;

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
export const postSnapshotSchema = postSchema.pick({
  title: true,
  slug: true,
  excerpt: true,
  blocks: true,
  editor: true,
  native: true,
  categoryIds: true,
  tagIds: true,
  featuredMediaId: true,
});

/** The content captured in a {@link postSnapshotSchema} revision. */
export type PostSnapshot = z.infer<typeof postSnapshotSchema>;

/** The content fields captured in a page revision snapshot. */
export const pageSnapshotSchema = pageSchema.pick({
  title: true,
  slug: true,
  blocks: true,
  editor: true,
  native: true,
  parentId: true,
  sortOrder: true,
});

/** The content captured in a {@link pageSnapshotSchema} revision. */
export type PageSnapshot = z.infer<typeof pageSnapshotSchema>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** A keyed application setting with a JSON-safe value. */
export const settingSchema = z.object({
  key: z.string().min(1).max(190),
  value: jsonValueSchema,
  updatedAt: timestampSchema,
});

/** A keyed setting. */
export type Setting = z.infer<typeof settingSchema>;

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/** A point-in-time snapshot of a content entry. */
export const revisionSchema = z.object({
  id: idSchema,
  entryType: z.string().min(1).max(64),
  entryId: idSchema,
  snapshot: jsonValueSchema,
  createdAt: timestampSchema,
  authorId: idSchema,
});

/** A content revision. */
export type Revision = z.infer<typeof revisionSchema>;

// ---------------------------------------------------------------------------
// Repository input types (ids and timestamps are repository-owned)
// ---------------------------------------------------------------------------

/** Fields the repository accepts when creating a post. */
export interface PostCreateInput {
  readonly title: string;
  readonly slug: string;
  readonly excerpt?: string;
  readonly blocks: RichTextDocument;
  readonly editor?: string;
  readonly native?: JsonValue;
  readonly status: ContentStatus;
  readonly authorId: string;
  readonly featuredMediaId?: string;
  readonly categoryIds?: readonly string[];
  readonly tagIds?: readonly string[];
}

/** Fields the repository accepts when updating a post (all optional). */
export interface PostUpdateInput {
  readonly title?: string;
  readonly slug?: string;
  readonly excerpt?: string;
  readonly blocks?: RichTextDocument;
  /** Pulled from the submitted editor envelope; omit to keep the current value. */
  readonly editor?: string;
  /** The adapter-native payload; omit to keep the current value. */
  readonly native?: JsonValue;
  /** Pass `null` to clear the featured media; omit to keep the current value. */
  readonly featuredMediaId?: string | null;
  readonly categoryIds?: readonly string[];
  readonly tagIds?: readonly string[];
}

/** Fields the repository accepts when creating a page. */
export interface PageCreateInput {
  readonly title: string;
  readonly slug: string;
  readonly blocks: RichTextDocument;
  readonly editor?: string;
  readonly native?: JsonValue;
  readonly status: ContentStatus;
  readonly parentId?: string;
  readonly sortOrder?: number;
}

/** Fields the repository accepts when updating a page (all optional). */
export interface PageUpdateInput {
  readonly title?: string;
  readonly slug?: string;
  readonly blocks?: RichTextDocument;
  /** Pulled from the submitted editor envelope; omit to keep the current value. */
  readonly editor?: string;
  /** The adapter-native payload; omit to keep the current value. */
  readonly native?: JsonValue;
  /** Pass `null` to detach the page from its parent; omit to keep the parent. */
  readonly parentId?: string | null;
  readonly sortOrder?: number;
}

/** Fields the repository accepts when creating or updating a category. */
export interface CategoryInput {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
}

/** Fields the repository accepts when creating or updating a tag. */
export interface TagInput {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
}

/** Fields the repository accepts when creating a menu. */
export interface MenuCreateInput {
  readonly name: string;
  readonly location: string;
  readonly items: readonly MenuItem[];
}

/** Fields the repository accepts when updating a menu (all optional). */
export interface MenuUpdateInput {
  readonly name?: string;
  readonly location?: string;
  readonly items?: readonly MenuItem[];
}

/** Fields the repository accepts when appending a revision. */
export interface RevisionInput {
  readonly entryType: string;
  readonly entryId: string;
  readonly snapshot: JsonValue;
  readonly authorId: string;
}
