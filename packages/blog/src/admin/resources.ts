/**
 * Blog admin: the admin-panel CRUD surface for the tenant-free CMS content.
 *
 * `blogAdmin(options?)` returns an {@link AdminPlugin} (id `blog`) whose
 * `register` contributes one resource per content collection — `posts`, `pages`,
 * `categories`, and `tags` — each backed by a {@link BlogRepository}, plus
 * the three structured admin pages from {@link defineBlogSettingsAdminPage},
 * {@link defineBlogMenusAdminPage}, and {@link defineBlogRevisionsAdminPage}
 * (settings curation, `primary`-menu administration, and revision
 * listing/restore).
 * Each resource mounts the standard list/new/create/edit/update routes under
 * the admin panel path, so the CMS content model is editable from the admin
 * dashboard exactly like any other resource.
 *
 * The repository is captured by closure, so an application that also mounts
 * {@link blogPlugin} must build one repository — `createMemoryBlogRepository` or
 * `createDatabaseBlogRepository` — and hand the same instance to both,
 * otherwise the HTTP list/create surface and the admin CRUD surface would write
 * to two different repositories.
 *
 * Post and page ids are the repository-assigned string ids (never the
 * database's numeric surrogate). Settings, menus, and revisions are curated
 * pages rather than resources, because their values are structured (typed
 * settings, an ordered menu, restorable snapshots) rather than flat rows.
 *
 * The module is ORM-free: it imports only the admin descriptors, the CMS
 * model/repository contract, and the resource factories.
 */

import { defineAdminPlugin, type AdminPlugin } from '@jsails/admin';
import type { RichTextEditorAdapter } from 'jsails/rich-text';

import { createMemoryBlogRepository, type BlogRepository } from '../cms/index.js';
import type { BlogSearchEngine } from '../search/contract.js';
import { createOramaBlogSearch } from '../search/orama.js';
import { pagesResource, postsResource, taxonomyResource } from './content-resources.js';
import { defineBlogMenusAdminPage } from './menus-page.js';
import { defineBlogRevisionsAdminPage } from './revisions-page.js';
import { defineBlogSettingsAdminPage } from './settings-page.js';

/** Options for {@link blogAdmin}. */
export interface BlogAdminOptions {
  /** The repository to back the resources; defaults to a fresh in-memory one. */
  readonly repository?: BlogRepository;
  /** The admin-panel base path for the settings/menus pages. Defaults to the panel's. */
  readonly path?: string;
  /**
   * Editor adapter applied to the posts/pages `body` `richText` field. When
   * present the resources persist an `EditorDocument` envelope (canonical
   * content plus an adapter-native payload) instead of a bare `RichTextDocument`,
   * and hydrate the adapter's island in the admin form. When omitted, the
   * `body` field stays a canonical-only `RichTextDocument`.
   */
  readonly editor?: RichTextEditorAdapter;
  /** Optional same-origin media picker endpoint for image/gallery blocks. */
  readonly mediaPickerUrl?: string;
  /**
   * Search engine indexed on every successful post save. Defaults to the
   * shared Orama engine for the repository (`createOramaBlogSearch`). Indexing
   * failures are swallowed so a search-index error can never lose the
   * already-committed database write.
   */
  readonly search?: BlogSearchEngine;
}

/**
 * Build the blog admin plugin. Every call creates its own repository unless one
 * is injected, so the descriptor owns no global state. The returned descriptor
 * is inert until {@link adminPlugin} invokes its `register` during assembly.
 */
export function blogAdmin(options: BlogAdminOptions = {}): AdminPlugin {
  const repository = options.repository ?? createMemoryBlogRepository();
  const search = options.search ?? createOramaBlogSearch({ repository });
  const { path, editor, mediaPickerUrl } = options;
  const content = {
    repository,
    ...(editor === undefined ? {} : { editor }),
    ...(mediaPickerUrl === undefined ? {} : { mediaPickerUrl }),
  };
  return defineAdminPlugin({
    id: 'blog',
    register(builder) {
      builder.addResource(postsResource({ ...content, search }));
      builder.addResource(pagesResource(content));
      builder.addResource(
        taxonomyResource('categories', 'Categories', {
          list: () => repository.listCategories(),
          get: (id) => repository.getCategory(id),
          create: (input) => repository.createCategory(input),
          update: (id, input) => repository.updateCategory(id, input),
        }),
      );
      builder.addResource(
        taxonomyResource('tags', 'Tags', {
          list: () => repository.listTags(),
          get: (id) => repository.getTag(id),
          create: (input) => repository.createTag(input),
          update: (id, input) => repository.updateTag(id, input),
        }),
      );
      builder.addPage(defineBlogSettingsAdminPage({ repository, path }));
      builder.addPage(defineBlogMenusAdminPage({ repository, path }));
      builder.addPage(defineBlogRevisionsAdminPage({ repository, path }));
    },
  });
}
