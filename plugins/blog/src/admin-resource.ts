/**
 * Blog admin: the admin-panel CRUD surface for the tenant-free CMS content.
 *
 * `blogAdmin(options?)` returns an {@link AdminPlugin} (id `blog`) whose
 * `register` contributes one resource per content collection — `posts`, `pages`,
 * `categories`, and `tags` — each backed by a {@link ContentRepository}, plus
 * the three structured admin pages from {@link settingsAdminPage},
 * {@link menusAdminPage}, and {@link revisionsAdminPage} (settings curation,
 * `primary`-menu administration, and revision listing/restore).
 * Each resource mounts the standard list/new/create/edit/update routes under
 * the admin panel path, so the CMS content model is editable from the admin
 * dashboard exactly like any other resource.
 *
 * The repository is captured by closure, so an application that also mounts
 * {@link blogPlugin} must build one repository — `createContentRepository` or
 * `createDatabaseContentRepository` — and hand the same instance to both,
 * otherwise the HTTP list/create surface and the admin CRUD surface would write
 * to two different repositories.
 *
 * Post and page ids are the repository-assigned string ids (never the
 * database's numeric surrogate). Store-backed `settings`, `menus`, and
 * `revisions` are no longer raw-JSON textarea resources: they are curated
 * pages defined in `./admin-pages.js`, edited through structured forms and
 * persisted through the repository's `setSetting`/`updateMenu`/`appendRevision`
 * contracts.
 *
 * The module is ORM-free: it imports only the admin resource/plugin descriptors,
 * the admin pages, and the content model/repository plus the plugin's shared
 * slug helper.
 */

import { defineAdminPlugin, defineResource, type AdminPlugin, type Resource } from '@jsails/admin';
import {
  createCanonicalEditorDocument,
  editorDocumentContent,
  editorDocumentPayload,
  editorDocumentSchema,
  isEditorDocument,
  richTextSchema,
  type EditorDocument,
  type EditorJsonValue,
  type RichTextDocument,
  type RichTextEditorAdapter,
} from 'jsails/rich-text';
import { menusAdminPage, revisionsAdminPage, settingsAdminPage } from './admin-pages.js';
import {
  ContentError,
  createContentRepository,
  jsonValueSchema,
  type ContentRepository,
  type ContentStatus,
  type JsonValue,
  type Page,
  type Post,
} from './content/index.js';
import { BLOG_HTTP_AUTHOR_ID, deriveSlug } from './plugin.js';
import { type BlogSearchEngine } from './search-contract.js';
import { createOramaBlogSearch } from './search-orama.js';

/** Options for {@link blogAdmin}. */
export interface BlogAdminOptions {
  /** The repository to back the resources; defaults to a fresh in-memory one. */
  repository?: ContentRepository;
  /** The admin-panel base path for the settings/menus pages. Defaults to the panel's. */
  path?: string;
  /**
   * Editor adapter applied to the posts/pages `body` `richText` field. When
   * present the resources persist an `EditorDocument` envelope (canonical
   * content plus an adapter-native payload) instead of a bare `RichTextDocument`,
   * and hydrate the adapter's island in the admin form. When omitted, the
   * `body` field stays a canonical-only `RichTextDocument`.
   */
  editor?: RichTextEditorAdapter;
  /** Optional same-origin media picker endpoint for image/gallery blocks. */
  mediaPickerUrl?: string;
  /**
   * Search engine indexed on every successful post save. Defaults to
   * {@link createDatabaseBlogSearch} over the repository. Indexing failures are
   * swallowed so a search-index error can never lose the already-committed
   * database write; see `savePost`.
   */
  search?: BlogSearchEngine;
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
function toStatus(value: unknown): ContentStatus | null {
  return value === 'draft' || value === 'published' || value === 'scheduled' ? value : null;
}

/** Coerce a form value into an integer sort order, defaulting to `0`. */
function toSortOrder(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** The blocks for a newly-created admin post/page: an empty document (no body yet). */
function emptyDocument(): RichTextDocument {
  return { version: 1, blocks: [] };
}

/** Validate a submitted body as a rich-text document, or `null` when invalid. */
function toRichTextDocument(value: unknown): RichTextDocument | null {
  const result = richTextSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * The persistence triple an adapter-backed `body` resolves to: canonical blocks
 * plus the editor id and (optional) native payload.
 */
interface EditorBody {
  readonly blocks: RichTextDocument;
  readonly editorId: string;
  readonly native?: EditorJsonValue;
}

/**
 * The `EditorDocument` envelope returned by `get` for an adapter-backed body.
 * A record already carrying `editor`/`native` preserves them; a legacy
 * canonical record falls back to the adapter id with canonical content and no
 * native payload.
 */
function editorEnvelope(
  editor: RichTextEditorAdapter,
  blocks: RichTextDocument,
  recordEditor?: string,
  recordNative?: EditorJsonValue,
): EditorDocument {
  return editorDocumentSchema.parse({
    version: 1,
    editor: recordEditor ?? editor.id,
    content: blocks,
    ...(recordNative === undefined ? {} : { native: recordNative }),
  });
}

/**
 * Resolve a submitted adapter-backed body into its persistence triple, or
 * `null` for a value-free rejection (unrecognized shape, mismatched editor id,
 * or a native payload the adapter's schema rejects). A legacy canonical
 * document is accepted: its content is projected onto the adapter's payload via
 * {@link editorDocumentPayload} so a first adapter-backed save round-trips the
 * native payload on the next `get`.
 */
function editorBody(editor: RichTextEditorAdapter, value: unknown): EditorBody | null {
  if (isEditorDocument(value)) {
    if (value.editor !== editor.id) {
      return null;
    }
    if (value.native !== undefined && !editor.payloadSchema.safeParse(value.native).success) {
      return null;
    }
    return {
      blocks: editorDocumentContent(value),
      editorId: value.editor,
      ...(value.native === undefined ? {} : { native: value.native }),
    };
  }
  const parsed = richTextSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const envelope = createCanonicalEditorDocument(editor.id, parsed.data);
  return {
    blocks: editorDocumentContent(envelope),
    editorId: envelope.editor,
    native: editorDocumentPayload(editor, envelope),
  };
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
function postRevisionSnapshot(post: Post): JsonValue {
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
function pageRevisionSnapshot(page: Page): JsonValue {
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
  readonly current: (id: string) => Promise<{ status: ContentStatus } | undefined>;
  readonly publish: (id: string) => Promise<unknown>;
  readonly unpublish: (id: string) => Promise<unknown>;
}

/** Move a post/page to the requested status when the form changed it. */
async function reconcileStatus(
  id: string,
  requested: ContentStatus | null,
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

/**
 * Build the blog admin plugin. Every call creates its own repository unless one
 * is injected, so the descriptor owns no global state. The returned descriptor
 * is inert until {@link adminPlugin} invokes its `register` during assembly.
 */
export function blogAdmin(options: BlogAdminOptions = {}): AdminPlugin {
  const repository = options.repository ?? createContentRepository();
  const search = options.search ?? createOramaBlogSearch({ repository });
  const path = options.path;
  const editor = options.editor;
  const mediaPickerUrl = options.mediaPickerUrl;
  return defineAdminPlugin({
    id: 'blog',
    register(builder) {
      builder.addResource(postsResource(repository, editor, mediaPickerUrl, search));
      builder.addResource(pagesResource(repository, editor, mediaPickerUrl));
      builder.addResource(categoriesResource(repository));
      builder.addResource(tagsResource(repository));
      builder.addPage(settingsAdminPage({ repository, path }));
      builder.addPage(menusAdminPage({ repository, path }));
      builder.addPage(revisionsAdminPage({ repository, path }));
    },
  });
}

/** The posts resource: title, slug, rich-text body, and status. */
function postsResource(
  repository: ContentRepository,
  editor?: RichTextEditorAdapter,
  mediaPickerUrl?: string,
  search?: BlogSearchEngine,
): Resource {
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
        body:
          editor === undefined
            ? post.blocks
            : editorEnvelope(editor, post.blocks, post.editor, post.native),
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
        return savePost(repository, id, values, title, slug, blocks, search);
      }

      // Adapter path: resolve the submitted envelope (or a legacy canonical
      // document) into its persistence triple, rejecting value-free on a
      // mismatched editor id or a payload the adapter rejects.
      const body = editorBody(editor, values['body']);
      if (body === null) {
        throw new ContentError('invalid_input', 'invalid editor body');
      }
      return savePost(
        repository,
        id,
        values,
        title,
        slug,
        body.blocks,
        search,
        body.editorId,
        body.native,
      );
    },
  });
}

/**
 * Reconcile a post's search presence after a save: publish indexes it, any
 * other status removes it, so a drafted post never surfaces in search. Indexing
 * errors are swallowed here (the repository write already succeeded) so a
 * search-index failure can never lose the save.
 */
async function indexPost(search: BlogSearchEngine | undefined, post: Post): Promise<void> {
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

/** Persist a post create/update plus the revision, status reconciliation, and search index. */
async function savePost(
  repository: ContentRepository,
  id: string | null,
  values: Record<string, unknown>,
  title: string,
  slug: string,
  blocks: RichTextDocument,
  search?: BlogSearchEngine,
  editor?: string,
  native?: EditorJsonValue,
): Promise<void> {
  if (id === null) {
    const status = toStatus(values['status']) ?? 'draft';
    const created = await repository.createPost({
      title,
      slug,
      blocks,
      ...(editor === undefined ? {} : { editor }),
      ...(native === undefined ? {} : { native }),
      status,
      authorId: BLOG_HTTP_AUTHOR_ID,
    });
    await indexPost(search, created);
    return;
  }

  const saved = await repository.updatePost(id, {
    title,
    slug,
    blocks,
    ...(editor === undefined ? {} : { editor }),
    ...(native === undefined ? {} : { native }),
  });
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
function pagesResource(
  repository: ContentRepository,
  editor?: RichTextEditorAdapter,
  mediaPickerUrl?: string,
): Resource {
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
        body:
          editor === undefined
            ? page.blocks
            : editorEnvelope(editor, page.blocks, page.editor, page.native),
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
        return savePage(repository, id, values, title, slug, blocks, parentId, sortOrder);
      }

      const body = editorBody(editor, values['body']);
      if (body === null) {
        throw new ContentError('invalid_input', 'invalid editor body');
      }
      return savePage(
        repository,
        id,
        values,
        title,
        slug,
        body.blocks,
        parentId,
        sortOrder,
        body.editorId,
        body.native,
      );
    },
  });
}

/** Persist a page create/update plus the revision and status reconciliation. */
async function savePage(
  repository: ContentRepository,
  id: string | null,
  values: Record<string, unknown>,
  title: string,
  slug: string,
  blocks: RichTextDocument,
  parentId: string | null | undefined,
  sortOrder: number,
  editor?: string,
  native?: EditorJsonValue,
): Promise<void> {
  if (id === null) {
    await repository.createPage({
      title,
      slug,
      blocks,
      ...(editor === undefined ? {} : { editor }),
      ...(native === undefined ? {} : { native }),
      status: toStatus(values['status']) ?? 'draft',
      parentId: parentId === null ? undefined : parentId,
      sortOrder,
    });
    return;
  }

  const saved = await repository.updatePage(id, {
    title,
    slug,
    blocks,
    ...(editor === undefined ? {} : { editor }),
    ...(native === undefined ? {} : { native }),
    parentId,
    sortOrder,
  });
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

/** The categories resource: name, slug (derived when blank), and description. */
function categoriesResource(repository: ContentRepository): Resource {
  return defineResource({
    slug: 'categories',
    label: 'Categories',
    columns: [
      { name: 'name', label: 'Name' },
      { name: 'slug', label: 'Slug' },
      { name: 'description', label: 'Description' },
    ],
    fields: [...TAXONOMY_FIELDS],
    list: async ({ page, pageSize }) => {
      const categories = await repository.listCategories();
      const start = (page - 1) * pageSize;
      return {
        rows: categories.slice(start, start + pageSize).map((category) => ({
          id: category.id,
          name: category.name,
          slug: category.slug,
          description: category.description ?? '',
        })),
        total: categories.length,
      };
    },
    get: async ({ id }) => {
      const category = await repository.getCategory(id);
      if (category === undefined) {
        return null;
      }
      return {
        name: category.name,
        slug: category.slug,
        description: category.description ?? '',
      };
    },
    save: async ({ id, values }) => {
      const name = toString(values['name']);
      const slug = resolveSlug(values['slug'], name);
      const description = toString(values['description']);
      const input = {
        name,
        slug,
        ...(description === '' ? {} : { description }),
      };
      if (id === null) {
        await repository.createCategory(input);
      } else {
        await repository.updateCategory(id, input);
      }
    },
  });
}

/** The tags resource: name, slug (derived when blank), and description. */
function tagsResource(repository: ContentRepository): Resource {
  return defineResource({
    slug: 'tags',
    label: 'Tags',
    columns: [
      { name: 'name', label: 'Name' },
      { name: 'slug', label: 'Slug' },
      { name: 'description', label: 'Description' },
    ],
    fields: [...TAXONOMY_FIELDS],
    list: async ({ page, pageSize }) => {
      const tags = await repository.listTags();
      const start = (page - 1) * pageSize;
      return {
        rows: tags.slice(start, start + pageSize).map((tag) => ({
          id: tag.id,
          name: tag.name,
          slug: tag.slug,
          description: tag.description ?? '',
        })),
        total: tags.length,
      };
    },
    get: async ({ id }) => {
      const tag = await repository.getTag(id);
      if (tag === undefined) {
        return null;
      }
      return {
        name: tag.name,
        slug: tag.slug,
        description: tag.description ?? '',
      };
    },
    save: async ({ id, values }) => {
      const name = toString(values['name']);
      const slug = resolveSlug(values['slug'], name);
      const description = toString(values['description']);
      const input = {
        name,
        slug,
        ...(description === '' ? {} : { description }),
      };
      if (id === null) {
        await repository.createTag(input);
      } else {
        await repository.updateTag(id, input);
      }
    },
  });
}
