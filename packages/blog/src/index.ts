/**
 * The first-party blog package (`@jsails/blog`).
 *
 * A live blog built on the tenant-free CMS `BlogRepository`. `blogPlugin`
 * contributes the repository service (under `blogRepositoryToken`), the public
 * discovery and search routes, and the CMS database schema. Build one
 * repository with `createMemoryBlogRepository` or `createDatabaseBlogRepository`
 * (MariaDB/Postgres/SQLite via TypeORM) and share it with the admin surfaces so
 * every surface stays in sync. The site settings are the `blog.site`
 * `@jsails/config` set, `blogSiteConfig`.
 *
 * The admin-panel integration (`blogAdmin`, `blogThemeAdmin`, and the page
 * factories) lives under `@jsails/blog/admin`, so this entry never loads the
 * optional `@jsails/admin` peer.
 */

export {
  BLOG_FEED_DEFAULT_LIMIT,
  BLOG_PRIMARY_MENU_LOCATION,
  BLOG_SEARCH_MAX_QUERY_LENGTH,
  BLOG_THEME_SETTING_KEY,
  blogPlugin,
  blogRepositoryToken,
  type BlogCreateRouteOptions,
  type BlogPostCreatedEvent,
  type BlogPluginOptions,
} from './plugin.js';

// The `blog` factory is the package's default export: `plugins.use` resolves
// `'@jsails/blog'` by importing the default export and calling it with the
// options tuple.
export { blogPlugin as default } from './plugin.js';

export {
  BLOG_MAX_POSTS_PER_PAGE,
  BLOG_SITE_DEFAULTS,
  blogSiteConfig,
  readBlogSiteSettings,
  type BlogSiteSettings,
} from './site-config.js';

export {
  BLOG_SEARCH_PAGE_SIZE,
  blogSearchToken,
  type BlogSearchEngine,
  type BlogSearchOptions,
  type BlogSearchResult,
} from './search/contract.js';
export { createDatabaseBlogSearch } from './search/database.js';
export { createOramaBlogSearch } from './search/orama.js';
export {
  BLOG_SEARCH_DEFAULT_TIMEOUT_MS,
  BlogSearchError,
  type BlogSearchErrorCode,
} from './search/http-driver.js';
export {
  createBlogSearchEngine,
  type BlogSearchDriver,
  type BlogSearchEngineOptions,
} from './search/engine.js';

export {
  BLOG_MENU_MAX_DEPTH,
  BLOG_MENU_MAX_ITEMS,
  BLOG_SLUG_PATTERN,
  BlogContentError,
  createMemoryBlogRepository,
  isAllowedMenuHref,
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
  type BlogPostPage,
  type BlogPostSnapshot,
  type BlogPostSummary,
  type BlogPostSummaryQuery,
  type BlogPostUpdateInput,
  type BlogPublishedPostQuery,
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
  blogRichTextUpgrade,
  createDatabaseBlogRepository,
  type BlogPersistenceErrorCode,
  type DatabaseBlogRepositoryOptions,
} from './persistence/index.js';
