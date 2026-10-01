/**
 * The admin resources over the blog content collections: posts, pages, and the
 * two taxonomies. Each resource maps the admin form onto the
 * {@link BlogRepository}, records a revision on every update, reconciles the
 * requested status through the repository's transitions, and (for posts)
 * keeps the search index in step with the saved state.
 */

import { defineResource, type Resource } from '@jsails/admin';
import type { JsonValue } from 'jsails/plugin-sdk';
import type { EditorJsonValue, RichTextDocument, RichTextEditorAdapter } from 'jsails/rich-text';

import {
  BlogContentError,
  jsonValueSchema,
  type BlogContentStatus,
  type BlogPage,
  type BlogPost,
  type BlogRepository,
  type BlogTerm,
  type BlogTermInput,
} from '../cms/index.js';
import { BLOG_HTTP_AUTHOR_ID, deriveSlug } from '../plugin.js';
import type { BlogSearchEngine } from '../search/contract.js';
import { editorBody, editorEnvelope, emptyDocument, toRichTextDocument } from './editor-body.js';

/** What a post or page resource needs beyond the repository. */
export interface ContentResourceOptions {
  readonly repository: BlogRepository;
  /** The editor adapter applied to the `body` field, when one is configured. */
  readonly editor?: RichTextEditorAdapter;
  /** Optional same-origin media picker endpoint for image/gallery blocks. */
  readonly mediaPickerUrl?: string;
}

/** The posts resource additionally indexes saved posts. */
export interface PostsResourceOptions extends ContentResourceOptions {
  readonly search?: BlogSearchEngine;
}

/** The statuses the admin form offers; `scheduled`/`archived` have no transition here. */
const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
] as const;

/** Coerce a resource form value into a non-empty string (non-strings become ''). */
function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Narrow a form status to a creatable content status, or `null` when invalid. */
function toStatus(value: unknown): BlogContentStatus | null {
  return value === 'draft' || value === 'published' || value === 'scheduled' ? value : null;
}

/** Coerce a form value into an integer sort order, defaulting to `0`. */
function toSortOrder(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** Resolve a submitted slug, deriving one from the label when blank. */
function resolveSlug(rawSlug: unknown, label: string): string {
  const slug = toString(rawSlug);
  return slug.trim() === '' ? deriveSlug(label) : slug;
}

/**
 * The revision snapshot for a post: its editable content plus the taxonomy/
 * media relations. Built from the full entity returned by `updatePost` (a
 * complete row), so a snapshot is recorded on every update, never on create —
 * a create has no prior content worth restoring to.
 */
function postRevisionSnapshot(post: BlogPost): JsonValue {
  return jsonValueSchema.parse({
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    blocks: post.blocks,
    ...(post.editor === undefined ? {} : { editor: post.editor }),
    ...(post.native === undefined ? {} : { native: post.native }),
    categoryIds: [...post.categoryIds],
    tagIds: [...post.tagIds],
    featuredMediaId: post.featuredMediaId,
  });
}

/** The revision snapshot for a page, built from the full updated entity. */
function pageRevisionSnapshot(page: BlogPage): JsonValue {
  return jsonValueSchema.parse({
    title: page.title,
    slug: page.slug,
    blocks: page.blocks,
    ...(page.editor === undefined ? {} : { editor: page.editor }),
    ...(page.native === undefined ? {} : { native: page.native }),
    parentId: page.parentId,
    sortOrder: page.sortOrder,
  });
}

/**
 * The catch-all senders needed to reconcile a status change on a post or page:
 * fetch current status, then the publish/unpublish transition for that entity.
 */
interface StatusTransition {
  readonly current: (id: string) => Promise<{ status: BlogContentStatus } | undefined>;
  readonly publish: (id: string) => Promise<unknown>;
  readonly unpublish: (id: string) => Promise<unknown>;
}

/** Move a post/page to the requested status when the form changed it. */
async function reconcileStatus(
  id: string,
  requested: BlogContentStatus | null,
  transition: StatusTransition,
): Promise<void> {
  if (requested === null) {
    return;
  }
  const current = await transition.current(id);
  if (current === undefined || current.status === requested) {
    return;
  }
  if (requested === 'published') {
    await transition.publish(id);
  } else if (requested === 'draft') {
    await transition.unpublish(id);
  }
}

/** The posts resource: title, slug, rich-text body, and status. */
export function postsResource(options: PostsResourceOptions): Resource {
  const { repository, editor, mediaPickerUrl, search } = options;
  return defineResource({
    slug: 'posts',
    label: 'Posts',
    columns: [
      { name: 'title', label: 'Title' },
      { name: 'slug', label: 'Slug' },
      { name: 'status', label: 'Status', format: 'badge' },
    ],
    fields: [
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'slug', label: 'Slug', type: 'text' },
      {
        name: 'body',
        label: 'Body',
        type: 'richText',
        ...(editor === undefined ? {} : { editor }),
        ...(mediaPickerUrl === undefined ? {} : { mediaPickerUrl }),
      },
      { name: 'status', label: 'Status', type: 'select', options: [...STATUS_OPTIONS] },
    ],
    list: async ({ page, pageSize }) => {
      const posts = await repository.listPosts();
      const start = (page - 1) * pageSize;
      return {
        rows: posts.slice(start, start + pageSize).map((post) => ({
          id: post.id,
          title: post.title,
          slug: post.slug,
          status: post.status,
        })),
        total: posts.length,
      };
    },
    get: async ({ id }) => {
      const post = await repository.getPost(id);
      if (post === undefined) {
        return null;
      }
      return {
        title: post.title,
        slug: post.slug,
        status: post.status,
        body: editor === undefined ? post.blocks : editorEnvelope(editor, post.blocks, post),
      };
    },
    save: async ({ id, values }) => {
      const title = toString(values['title']);
      const slug = resolveSlug(values['slug'], title);

      if (editor === undefined) {
        // Canonical path: the admin schema already validated `body` as a
        // rich-text document; parse it again defensively so a malformed value
        // can never reach the repository.
        const blocks = toRichTextDocument(values['body']) ?? emptyDocument();
        return savePost({ repository, search, id, values, content: { title, slug, blocks } });
      }

      // Adapter path: resolve the submitted envelope (or a canonical-only
      // document) into its persistence triple, rejecting value-free on a
      // mismatched editor id or a payload the adapter rejects.
      const body = editorBody(editor, values['body']);
      if (body === null) {
        throw new BlogContentError('invalid_input', 'invalid editor body');
      }
      return savePost({
        repository,
        search,
        id,
        values,
        content: {
          title,
          slug,
          blocks: body.blocks,
          editor: body.editorId,
          ...(body.native === undefined ? {} : { native: body.native }),
        },
      });
    },
  });
}

/**
 * Reconcile a post's search presence after a save: publish indexes it, any
 * other status removes it, so a drafted post never surfaces in search. Indexing
 * errors are swallowed here (the repository write already succeeded) so a
 * search-index failure can never lose the save.
 */
async function indexPost(search: BlogSearchEngine | undefined, post: BlogPost): Promise<void> {
  if (search === undefined) return;
  try {
    if (post.status === 'published') {
      await search.index(post);
    } else {
      await search.remove(post.id);
    }
  } catch {
    // Best-effort: search indexing must never undo an already-committed write.
  }
}

/** The editable content of a post or page as resolved from the admin form. */
interface SavedContent {
  readonly title: string;
  readonly slug: string;
  readonly blocks: RichTextDocument;
  readonly editor?: string;
  readonly native?: EditorJsonValue;
}

/** One admin save of a post or page: `id` is `null` on create. */
interface SaveOptions<Content extends SavedContent> {
  readonly repository: BlogRepository;
  readonly id: string | null;
  /** The raw form values; the status field is read from here. */
  readonly values: Record<string, unknown>;
  readonly content: Content;
}

/** A post save additionally reconciles the search index. */
interface SavePostOptions extends SaveOptions<SavedContent> {
  readonly search?: BlogSearchEngine;
}

/** Persist a post create/update plus the revision, status reconciliation, and search index. */
async function savePost(options: SavePostOptions): Promise<void> {
  const { repository, search, id, values, content } = options;
  if (id === null) {
    const status = toStatus(values['status']) ?? 'draft';
    const created = await repository.createPost({
      ...content,
      status,
      authorId: BLOG_HTTP_AUTHOR_ID,
    });
    await indexPost(search, created);
    return;
  }

  const saved = await repository.updatePost(id, content);
  // Record the full updated row as a revision before the status transition,
  // so a restore recovers the content exactly as saved. Create is skipped:
  // it has no prior content to restore to.
  await repository.appendRevision({
    entryType: 'post',
    entryId: id,
    snapshot: postRevisionSnapshot(saved),
    authorId: BLOG_HTTP_AUTHOR_ID,
  });

  // `PostUpdateInput` has no status field: a status change goes through the
  // repository's transition methods instead.
  await reconcileStatus(id, toStatus(values['status']), {
    current: (entryId) => repository.getPost(entryId),
    publish: (entryId) => repository.publishPost(entryId),
    unpublish: (entryId) => repository.unpublishPost(entryId),
  });

  // Index the post in its final state (post-transition), so an unpublish
  // removes it from search.
  const final = await repository.getPost(id);
  if (final !== undefined) {
    await indexPost(search, final);
  }
}

/** The pages resource: title, slug, body, status, optional parent, and sort order. */
export function pagesResource(options: ContentResourceOptions): Resource {
  const { repository, editor, mediaPickerUrl } = options;
  return defineResource({
    slug: 'pages',
    label: 'Pages',
    columns: [
      { name: 'title', label: 'Title' },
      { name: 'slug', label: 'Slug' },
      { name: 'status', label: 'Status', format: 'badge' },
      { name: 'sortOrder', label: 'Order' },
    ],
    fields: [
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'slug', label: 'Slug', type: 'text' },
      {
        name: 'body',
        label: 'Body',
        type: 'richText',
        ...(editor === undefined ? {} : { editor }),
        ...(mediaPickerUrl === undefined ? {} : { mediaPickerUrl }),
      },
      { name: 'status', label: 'Status', type: 'select', options: [...STATUS_OPTIONS] },
      { name: 'parentId', label: 'Parent id', type: 'text', required: false },
      { name: 'sortOrder', label: 'Sort order', type: 'number', required: false },
    ],
    list: async ({ page, pageSize }) => {
      const pages = await repository.listPages();
      const start = (page - 1) * pageSize;
      return {
        rows: pages.slice(start, start + pageSize).map((page) => ({
          id: page.id,
          title: page.title,
          slug: page.slug,
          status: page.status,
          sortOrder: page.sortOrder,
        })),
        total: pages.length,
      };
    },
    get: async ({ id }) => {
      const page = await repository.getPage(id);
      if (page === undefined) {
        return null;
      }
      return {
        title: page.title,
        slug: page.slug,
        status: page.status,
        body: editor === undefined ? page.blocks : editorEnvelope(editor, page.blocks, page),
        parentId: page.parentId ?? '',
        sortOrder: page.sortOrder,
      };
    },
    save: async ({ id, values }) => {
      const title = toString(values['title']);
      const slug = resolveSlug(values['slug'], title);
      const sortOrder = toSortOrder(values['sortOrder']);
      // A blank parent id means "no parent"; an absent field means "unchanged".
      const rawParent = values['parentId'];
      const parentId =
        rawParent === undefined || rawParent === null
          ? undefined
          : typeof rawParent === 'string' && rawParent.trim() === ''
            ? null
            : String(rawParent);

      if (editor === undefined) {
        const blocks = toRichTextDocument(values['body']) ?? emptyDocument();
        return savePage({
          repository,
          id,
          values,
          content: { title, slug, blocks, parentId, sortOrder },
        });
      }

      const body = editorBody(editor, values['body']);
      if (body === null) {
        throw new BlogContentError('invalid_input', 'invalid editor body');
      }
      return savePage({
        repository,
        id,
        values,
        content: {
          title,
          slug,
          blocks: body.blocks,
          editor: body.editorId,
          ...(body.native === undefined ? {} : { native: body.native }),
          parentId,
          sortOrder,
        },
      });
    },
  });
}

/** The editable content of a page; `parentId` is `null` to detach, `undefined` to keep. */
interface SavedPageContent extends SavedContent {
  readonly parentId: string | null | undefined;
  readonly sortOrder: number;
}

/** Persist a page create/update plus the revision and status reconciliation. */
async function savePage(options: SaveOptions<SavedPageContent>): Promise<void> {
  const { repository, id, values, content } = options;
  if (id === null) {
    const { parentId, ...rest } = content;
    await repository.createPage({
      ...rest,
      status: toStatus(values['status']) ?? 'draft',
      ...(parentId === null || parentId === undefined ? {} : { parentId }),
    });
    return;
  }

  const saved = await repository.updatePage(id, content);
  // Record the full updated row as a revision, as with posts: update only.
  await repository.appendRevision({
    entryType: 'page',
    entryId: id,
    snapshot: pageRevisionSnapshot(saved),
    authorId: BLOG_HTTP_AUTHOR_ID,
  });
  await reconcileStatus(id, toStatus(values['status']), {
    current: (entryId) => repository.getPage(entryId),
    publish: (entryId) => repository.publishPage(entryId),
    unpublish: (entryId) => repository.unpublishPage(entryId),
  });
}

/** Shared taxonomy fields (name + derivable slug + optional description). */
const TAXONOMY_FIELDS = [
  { name: 'name', label: 'Name', type: 'text' },
  { name: 'slug', label: 'Slug', type: 'text' },
  { name: 'description', label: 'Description', type: 'textarea', required: false },
] as const;

/** The repository operations one taxonomy (categories or tags) exposes. */
export interface TaxonomyOperations {
  list(): Promise<readonly BlogTerm[]>;
  get(id: string): Promise<BlogTerm | undefined>;
  create(input: BlogTermInput): Promise<unknown>;
  update(id: string, input: BlogTermInput): Promise<unknown>;
}

/** A taxonomy resource: name, slug (derived when blank), and description. */
export function taxonomyResource(slug: string, label: string, terms: TaxonomyOperations): Resource {
  return defineResource({
    slug,
    label,
    columns: [
      { name: 'name', label: 'Name' },
      { name: 'slug', label: 'Slug' },
      { name: 'description', label: 'Description' },
    ],
    fields: [...TAXONOMY_FIELDS],
    list: async ({ page, pageSize }) => {
      const all = await terms.list();
      const start = (page - 1) * pageSize;
      return {
        rows: all.slice(start, start + pageSize).map((term) => ({
          id: term.id,
          name: term.name,
          slug: term.slug,
          description: term.description ?? '',
        })),
        total: all.length,
      };
    },
    get: async ({ id }) => {
      const term = await terms.get(id);
      if (term === undefined) {
        return null;
      }
      return { name: term.name, slug: term.slug, description: term.description ?? '' };
    },
    save: async ({ id, values }) => {
      const name = toString(values['name']);
      const description = toString(values['description']);
      const input: BlogTermInput = {
        name,
        slug: resolveSlug(values['slug'], name),
        ...(description === '' ? {} : { description }),
      };
      if (id === null) {
        await terms.create(input);
      } else {
        await terms.update(id, input);
      }
    },
  });
}
