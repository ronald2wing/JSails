/**
 * The first-party blog package (`@jsails/blog`).
 *
 * A live blog built on the tenant-free CMS `BlogRepository`. `blogPlugin`
 * contributes the repository service (under `blogRepositoryToken`), the public
 * discovery and search routes, and the CMS database schema. Build one
 * repository with `createMemoryBlogRepository` or `createDatabaseBlogRepository`
 * (MariaDB/Postgres/SQLite via TypeORM) and share it with the admin surfaces so
 * every surface stays in sync.
 *
 * The admin-panel integration (`blogAdmin`, `blogThemeAdmin`, and the page
 * factories) lives under `@jsails/blog/admin`, so this entry never loads the
 * optional `@jsails/admin` peer.
 */

export {
  BLOG_THEME_SETTING_KEY,
  blogEditorRendererToken,
  blogPlugin,
  blogRepositoryToken,
  type BlogPostCreatedEvent,
  type BlogEditorRenderer,
  type BlogPluginOptions,
} from './plugin.js';

// The `blog` factory is the package's default export: `plugins.use` resolves
// `'@jsails/blog'` by importing the default export and calling it with the
// options tuple.
export { blogPlugin as default } from './plugin.js';

export {
  BLOG_SEARCH_PAGE_SIZE,
  blogSearchToken,
  type BlogSearchEngine,
  type BlogSearchOptions,
  type BlogSearchResult,
} from './search/contract.js';
export { createDatabaseBlogSearch } from './search/database.js';
export { createOramaBlogSearch } from './search/orama.js';
export { BlogSearchError, type BlogSearchErrorCode } from './search/http-driver.js';
export {
  createBlogSearchEngine,
  type BlogSearchDriver,
  type BlogSearchEngineOptions,
} from './search/engine.js';

export {
  BlogContentError,
  createMemoryBlogRepository,
  type BlogContentErrorCode,
  type BlogContentStatus,
  type BlogMenu,
  type BlogMenuCreateInput,
  type BlogMenuItem,
  type BlogMenuUpdateInput,
  type BlogPage,
  type BlogPageCreateInput,
  type BlogPageSnapshot,
  type BlogPageUpdateInput,
  type BlogPost,
  type BlogPostCreateInput,
  type BlogPostSnapshot,
  type BlogPostUpdateInput,
  type BlogRepository,
  type BlogRevision,
  type BlogRevisionInput,
  type BlogSetting,
  type BlogTerm,
  type BlogTermInput,
  type MemoryBlogRepositoryOptions,
} from './cms/index.js';

export {
  BlogPersistenceError,
  blogEntities,
  createDatabaseBlogRepository,
  type BlogPersistenceErrorCode,
  type DatabaseBlogRepositoryOptions,
} from './persistence/index.js';
