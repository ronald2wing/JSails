/**
 * Pure builders for the persisted blog entities, shared by every
 * {@link BlogRepository} implementation.
 *
 * A repository owns its store, its ids, and its clock; the shape of a new or
 * merged entity and the publish/unpublish rules are the same for every store,
 * so they live here. Each `create*` builder assembles a new entity from a
 * create input plus the repository-assigned id and timestamp; each `merge*`
 * builder applies an update input onto the current entity, keeping every
 * omitted field. Every result is validated against the model schema and fails
 * value-free through {@link BlogContentError}.
 */

import type { JsonValue } from 'jsails/plugin-sdk';

import {
  blogTermSchema,
  jsonValueSchema,
  menuSchema,
  pageSchema,
  postSchema,
  revisionSchema,
  settingSchema,
  type BlogContentStatus,
  type BlogMenu,
  type BlogMenuCreateInput,
  type BlogMenuUpdateInput,
  type BlogPage,
  type BlogPageCreateInput,
  type BlogPageUpdateInput,
  type BlogPost,
  type BlogPostCreateInput,
  type BlogPostUpdateInput,
  type BlogRevision,
  type BlogRevisionInput,
  type BlogSetting,
  type BlogTerm,
  type BlogTermInput,
} from './model.js';
import { BlogContentError } from './repository.js';
import { archivedTransition, assertCreatableStatus, parseEntity } from './repository-guards.js';

/** The repository-assigned identity of a new entity. */
export interface EntityStamp {
  readonly id: string;
  /** ISO timestamp of the write. */
  readonly timestamp: string;
}

// -- Posts ------------------------------------------------------------------

/** A new post; `publishedAt` is stamped when it is created `published`. */
export function createPost(input: BlogPostCreateInput, stamp: EntityStamp): BlogPost {
  assertCreatableStatus(input.status);
  return parseEntity(
    postSchema,
    {
      id: stamp.id,
      title: input.title,
      slug: input.slug,
      excerpt: input.excerpt ?? '',
      blocks: input.blocks,
      ...(input.editor === undefined ? {} : { editor: input.editor }),
      ...(input.native === undefined ? {} : { native: input.native }),
      status: input.status,
      authorId: input.authorId,
      featuredMediaId: input.featuredMediaId ?? null,
      categoryIds: [...(input.categoryIds ?? [])],
      tagIds: [...(input.tagIds ?? [])],
      publishedAt: input.status === 'published' ? stamp.timestamp : null,
      createdAt: stamp.timestamp,
      updatedAt: stamp.timestamp,
    },
    'post',
  );
}

/** The current post with the update applied; lifecycle fields are untouched. */
export function mergePost(
  current: BlogPost,
  input: BlogPostUpdateInput,
  timestamp: string,
): BlogPost {
  const editor = input.editor ?? current.editor;
  // `null` is a valid native payload, so only `undefined` means "unchanged".
  const native = input.native !== undefined ? input.native : current.native;
  return parseEntity(
    postSchema,
    {
      id: current.id,
      title: input.title ?? current.title,
      slug: input.slug ?? current.slug,
      excerpt: input.excerpt ?? current.excerpt,
      blocks: input.blocks ?? current.blocks,
      ...(editor === undefined ? {} : { editor }),
      ...(native === undefined ? {} : { native }),
      status: current.status,
      authorId: current.authorId,
      featuredMediaId:
        input.featuredMediaId === undefined ? current.featuredMediaId : input.featuredMediaId,
      categoryIds: input.categoryIds ?? current.categoryIds,
      tagIds: input.tagIds ?? current.tagIds,
      publishedAt: current.publishedAt,
      createdAt: current.createdAt,
      updatedAt: timestamp,
    },
    'post',
  );
}

// -- Pages ------------------------------------------------------------------

/** A new page. */
export function createPage(input: BlogPageCreateInput, stamp: EntityStamp): BlogPage {
  assertCreatableStatus(input.status);
  return parseEntity(
    pageSchema,
    {
      id: stamp.id,
      title: input.title,
      slug: input.slug,
      blocks: input.blocks,
      ...(input.editor === undefined ? {} : { editor: input.editor }),
      ...(input.native === undefined ? {} : { native: input.native }),
      status: input.status,
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdAt: stamp.timestamp,
      updatedAt: stamp.timestamp,
    },
    'page',
  );
}

/** The current page with the update applied; lifecycle fields are untouched. */
export function mergePage(
  current: BlogPage,
  input: BlogPageUpdateInput,
  timestamp: string,
): BlogPage {
  const editor = input.editor ?? current.editor;
  const native = input.native !== undefined ? input.native : current.native;
  return parseEntity(
    pageSchema,
    {
      id: current.id,
      title: input.title ?? current.title,
      slug: input.slug ?? current.slug,
      blocks: input.blocks ?? current.blocks,
      ...(editor === undefined ? {} : { editor }),
      ...(native === undefined ? {} : { native }),
      status: current.status,
      parentId: input.parentId === undefined ? current.parentId : input.parentId,
      sortOrder: input.sortOrder ?? current.sortOrder,
      createdAt: current.createdAt,
      updatedAt: timestamp,
    },
    'page',
  );
}

// -- Status transitions -----------------------------------------------------

/**
 * The status a publish or unpublish moves an entry to, or `undefined` when the
 * entry is already there. An archived entry accepts neither transition.
 */
export function transitionStatus(
  current: BlogContentStatus,
  transition: 'publish' | 'unpublish',
): BlogContentStatus | undefined {
  if (current === 'archived') {
    throw archivedTransition(transition);
  }
  const target = transition === 'publish' ? 'published' : 'draft';
  return current === target ? undefined : target;
}

// -- Categories and tags ----------------------------------------------------

/** A new category or tag. */
export function createTerm(input: BlogTermInput, id: string, label: string): BlogTerm {
  return parseEntity(
    blogTermSchema,
    {
      id,
      name: input.name,
      slug: input.slug,
      ...(input.description === undefined ? {} : { description: input.description }),
    },
    label,
  );
}

/** The current term with the update applied; an omitted description is kept. */
export function mergeTerm(current: BlogTerm, input: BlogTermInput, label: string): BlogTerm {
  const description = input.description ?? current.description;
  return parseEntity(
    blogTermSchema,
    {
      id: current.id,
      name: input.name,
      slug: input.slug,
      ...(description === undefined ? {} : { description }),
    },
    label,
  );
}

// -- Settings ---------------------------------------------------------------

/** A setting carrying a JSON-safe value. */
export function createSetting(key: string, value: JsonValue, timestamp: string): BlogSetting {
  // The value is checked first so a non-JSON-safe value gets its own message;
  // the key bounds and timestamp are then checked by the schema.
  const parsedValue = jsonValueSchema.safeParse(value);
  if (!parsedValue.success) {
    throw new BlogContentError('invalid_input', 'setting value must be JSON-safe');
  }
  return parseEntity(
    settingSchema,
    { key, value: parsedValue.data, updatedAt: timestamp },
    'setting',
  );
}

// -- Menus ------------------------------------------------------------------

/** A new menu. */
export function createMenu(input: BlogMenuCreateInput, id: string): BlogMenu {
  return parseEntity(
    menuSchema,
    { id, name: input.name, location: input.location, items: [...input.items] },
    'menu',
  );
}

/** The current menu with the update applied. */
export function mergeMenu(current: BlogMenu, input: BlogMenuUpdateInput): BlogMenu {
  return parseEntity(
    menuSchema,
    {
      id: current.id,
      name: input.name ?? current.name,
      location: input.location ?? current.location,
      items: input.items ?? current.items,
    },
    'menu',
  );
}

// -- Revisions --------------------------------------------------------------

/** A new revision carrying a JSON-safe snapshot. */
export function createRevision(input: BlogRevisionInput, stamp: EntityStamp): BlogRevision {
  const parsedSnapshot = jsonValueSchema.safeParse(input.snapshot);
  if (!parsedSnapshot.success) {
    throw new BlogContentError('invalid_snapshot', 'revision snapshot must be JSON-safe');
  }
  return parseEntity(
    revisionSchema,
    {
      id: stamp.id,
      entryType: input.entryType,
      entryId: input.entryId,
      snapshot: parsedSnapshot.data,
      createdAt: stamp.timestamp,
      authorId: input.authorId,
    },
    'revision',
  );
}
