/**
 * The admin resources over the blog content collections: posts, pages, and the
 * two taxonomies. Each resource maps the admin form onto the
 * {@link BlogRepository}, records a revision on every update that changed the
 * content (keeping only the newest N per entry), reconciles the requested
 * status through the repository's transitions, and (for posts) keeps the search
 * index in step with the saved state. The update, its revision, and the status
 * change run in one repository transaction, so a failure part-way leaves the
 * entry as it was.
 */

import { isDeepStrictEqual } from 'node:util';

import { defineResource, type Resource } from '@jsails/admin';
import { ValidationError } from 'jsails/api';
import type { JsonValue } from 'jsails/plugin-sdk';
import type { EditorJsonValue, RichTextDocument, RichTextEditorAdapter } from 'jsails/rich-text';

import {
  BLOG_SLUG_PATTERN,
  BlogContentError,
  jsonValueSchema,
  type BlogContentStatus,
  type BlogPage,
  type BlogPost,
  type BlogRepository,
  type BlogTerm,
  type BlogTermInput,
} from '../cms/index.js';
import { deriveSlug } from '../plugin.js';
import type { BlogSearchEngine } from '../search/contract.js';
import { editorBody, editorEnvelope, emptyDocument, toRichTextDocument } from './editor-body.js';
import { sessionAuthorId } from './page-frame.js';

/** Revisions kept per entry when the app sets no retention. */
export const BLOG_DEFAULT_REVISION_LIMIT = 25;

/** What a post or page resource needs beyond the repository. */
export interface ContentResourceOptions {
  readonly repository: BlogRepository;
  /** Revisions kept per entry; older ones are pruned on save. */
  readonly revisionLimit?: number;
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

/** The longest slug the model accepts. */
const SLUG_MAX_LENGTH = 190;

/** A value-free form error on one field (or the whole form when `field` is null). */
function formError(field: string | null, code: string, message: string): ValidationError {
  return new ValidationError([{ path: field === null ? [] : [field], code, message }]);
}

/**
 * Resolve a submitted slug, deriving one from the label when blank. A typed
 * slug the model would refuse (`Hello World`, `my_post`, or a legacy slug on an
 * edited row) is a form error on the slug field, so the admin re-renders the
 * form with a 422 instead of reporting an editor typo as a server fault.
 */
function resolveSlug(rawSlug: unknown, label: string): string {
  const typed = toString(rawSlug).trim();
  const slug = typed === '' ? deriveSlug(label) : typed;
  if (slug.length > SLUG_MAX_LENGTH || !BLOG_SLUG_PATTERN.test(slug)) {
    throw formError('slug', 'pattern', 'Use lowercase letters, digits, and single hyphens');
  }
  return slug;
}

/**
 * Run a resource write, turning the repository's editor-facing failures into
 * value-free form errors: a taken slug is shown on the slug field and any other
 * rejected input as a form-level message. Every other error (a lost row, a
 * database fault) propagates as a server error.
 */
async function asFormErrors(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (error instanceof BlogContentError && error.code === 'slug_conflict') {
      throw formError('slug', 'slug_conflict', 'That slug is already in use');
    }
    if (error instanceof BlogContentError && error.code === 'invalid_input') {
      throw formError(null, 'invalid_input', 'The submitted content is invalid');
    }
    throw error;
  }
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
  const revisionLimit = options.revisionLimit ?? BLOG_DEFAULT_REVISION_LIMIT;
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
      const { posts, total } = await repository.listPostSummaries({
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return {
        rows: posts.map((post) => ({
          id: post.id,
          title: post.title,
          slug: post.slug,
          status: post.status,
        })),
        total,
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
    save: ({ session, id, values }) =>
      asFormErrors(async () => {
        const title = toString(values['title']);
        const slug = resolveSlug(values['slug'], title);
        const authorId = sessionAuthorId(session);

        if (editor === undefined) {
          // Canonical path: the admin schema already validated `body` as a
          // rich-text document; parse it again defensively so a malformed value
          // can never reach the repository.
          const blocks = toRichTextDocument(values['body']) ?? emptyDocument();
          return savePost({
            repository,
            search,
            revisionLimit,
            authorId,
            id,
            values,
            content: { title, slug, blocks },
          });
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
          revisionLimit,
          authorId,
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
      }),
  });
}

/**
 * Reconcile a post's search presence after a save: publish indexes it, any
 * other status removes it, so a drafted post never surfaces in search. Indexing
 * errors are swallowed here (the repository write already succeeded) so a
 * search-index failure can never lose the save; the external drivers bound
 * each request with a timeout, so a stalled engine cannot hold the save open.
 */
export async function indexPost(
  search: BlogSearchEngine | undefined,
  post: BlogPost,
): Promise<void> {
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
  /** Revisions kept per entry after this save. */
  readonly revisionLimit: number;
  /** The signed-in admin user the write and its revision are attributed to. */
  readonly authorId: string;
  readonly id: string | null;
  /** The raw form values; the status field is read from here. */
  readonly values: Record<string, unknown>;
  readonly content: Content;
}

/** A post save additionally reconciles the search index. */
interface SavePostOptions extends SaveOptions<SavedContent> {
  readonly search?: BlogSearchEngine;
}

/**
 * Append a revision of an entry's saved content unless it equals the newest
 * recorded one (a save that changed only the status, or nothing), then prune
 * the entry's history to the newest `limit` revisions.
 */
export async function recordRevision(
  repository: BlogRepository,
  entryType: 'post' | 'page',
  entryId: string,
  snapshot: JsonValue,
  authorId: string,
  limit: number,
): Promise<void> {
  const history = await repository.listRevisions(entryType, entryId);
  const latest = history.at(-1);
  if (latest !== undefined && isDeepStrictEqual(latest.snapshot, snapshot)) return;
  await repository.appendRevision({ entryType, entryId, snapshot, authorId });
  await repository.pruneRevisions(entryType, entryId, limit);
}

/** Persist a post create/update plus the revision, status reconciliation, and search index. */
async function savePost(options: SavePostOptions): Promise<void> {
  const { repository, search, revisionLimit, authorId, id, values, content } = options;
  if (id === null) {
    const status = toStatus(values['status']) ?? 'draft';
    const created = await repository.createPost({ ...content, status, authorId });
    await indexPost(search, created);
    return;
  }

  // The update, its revision, and the status transition commit together; the
  // search index is reconciled only after the commit, from the final row.
  const final = await repository.transaction(async (tx) => {
    const saved = await tx.updatePost(id, content);
    // Record the full updated row as a revision before the status transition,
    // so a restore recovers the content exactly as saved. Create is skipped:
    // it has no prior content to restore to.
    await recordRevision(tx, 'post', id, postRevisionSnapshot(saved), authorId, revisionLimit);
    // `PostUpdateInput` has no status field: a status change goes through the
    // repository's transition methods instead.
    await reconcileStatus(id, toStatus(values['status']), {
      current: (entryId) => tx.getPost(entryId),
      publish: (entryId) => tx.publishPost(entryId),
      unpublish: (entryId) => tx.unpublishPost(entryId),
    });
    return tx.getPost(id);
  });

  // Index the post in its final state (post-transition), so an unpublish
  // removes it from search.
  if (final !== undefined) {
    await indexPost(search, final);
  }
}

/** The pages resource: title, slug, body, status, optional parent, and sort order. */
export function pagesResource(options: ContentResourceOptions): Resource {
  const { repository, editor, mediaPickerUrl } = options;
  const revisionLimit = options.revisionLimit ?? BLOG_DEFAULT_REVISION_LIMIT;
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
    save: ({ session, id, values }) =>
      asFormErrors(async () => {
        const title = toString(values['title']);
        const slug = resolveSlug(values['slug'], title);
        const authorId = sessionAuthorId(session);
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
            revisionLimit,
            authorId,
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
          revisionLimit,
          authorId,
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
      }),
  });
}

/** The editable content of a page; `parentId` is `null` to detach, `undefined` to keep. */
interface SavedPageContent extends SavedContent {
  readonly parentId: string | null | undefined;
  readonly sortOrder: number;
}

/** Persist a page create/update plus the revision and status reconciliation. */
async function savePage(options: SaveOptions<SavedPageContent>): Promise<void> {
  const { repository, revisionLimit, authorId, id, values, content } = options;
  if (id === null) {
    const { parentId, ...rest } = content;
    await repository.createPage({
      ...rest,
      status: toStatus(values['status']) ?? 'draft',
      ...(parentId === null || parentId === undefined ? {} : { parentId }),
    });
    return;
  }

  await repository.transaction(async (tx) => {
    const saved = await tx.updatePage(id, content);
    // Record the full updated row as a revision, as with posts: update only.
    await recordRevision(tx, 'page', id, pageRevisionSnapshot(saved), authorId, revisionLimit);
    await reconcileStatus(id, toStatus(values['status']), {
      current: (entryId) => tx.getPage(entryId),
      publish: (entryId) => tx.publishPage(entryId),
      unpublish: (entryId) => tx.unpublishPage(entryId),
    });
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
    save: ({ id, values }) =>
      asFormErrors(async () => {
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
      }),
  });
}
