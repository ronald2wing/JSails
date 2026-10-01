/**
 * The first-party blog subpath (`jsails/blog`).
 *
 * A live blog built on the tenant-free CMS `ContentRepository`. `blogPlugin`
 * contributes the repository service (under `blogRepositoryToken`) plus the
 * HTTP list/create surface and the CMS database schema; `blogAdmin`
 * contributes the admin CRUD surface; `blogThemeAdmin` contributes the admin
 * theme-activation page over a `@jsails/theme` registry. Build one repository
 * with `createContentRepository` (in-memory) or `createDatabaseContentRepository`
 * (MariaDB/Postgres/SQLite via TypeORM) and share it across all three so the
 * surfaces stay in sync.
 *
 * The content model/repository and the database-backed persistence are
 * re-exported here; the media library, block renderer, and editor surfaces
 * live under their own subpaths.
 */

export {
  BLOG_HTTP_AUTHOR_ID,
  BlogValidationError,
  blogEditorRendererToken,
  blogPlugin,
  blogRepositoryToken,
  createPostOperation,
  deriveSlug,
  postCreatedEvent,
  type BlogPostCreatedEvent,
  type BlogEditorRenderer,
  type BlogPluginOptions,
} from './plugin.js';

export {
  BLOG_SEARCH_PAGE_SIZE,
  blogSearchToken,
  createBlogSearch,
  type BlogSearchEngine,
  type BlogSearchOptions,
  type BlogSearchResult,
} from './search-contract.js';
export { createDatabaseBlogSearch, postSearchText } from './search-database.js';

export { createOramaBlogSearch } from './search-orama.js';

export {
  BlogSearchError,
  createBlogSearchEngine,
  type BlogSearchDriver,
  type BlogSearchEngineOptions,
  type BlogSearchErrorCode,
} from './search-drivers.js';

export { blogAdmin, type BlogAdminOptions } from './admin-resource.js';

export {
  blogThemeAdmin,
  THEME_ACTIVATED_NOTICE,
  type BlogThemeAdminOptions,
} from './theme-admin.js';

// The `blog` factory is the subpath's default export, matching every other
// first-party plugin subpath: `plugins.use` resolves `'jsails/blog'` by
// importing the default export and calling it with the options tuple.
export { blogPlugin as default } from './plugin.js';

// Tenant-free CMS content model + in-memory repository, and the database-backed
// persistence for the same model. Both are re-exported from `jsails/blog` so an
// app imports one subpath.
export * from './content/index.js';
export * from './persistence/index.js';
