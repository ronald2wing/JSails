/**
 * Database-backed persistence for the blog CMS: the TypeORM entities and the
 * `BlogRepository` implementation over them.
 *
 * An app adds {@link blogEntities} to its `JsailsDataSource` `entities` list,
 * runs `jsails db:push`, and builds a repository with
 * {@link createDatabaseBlogRepository} over that (or a lazily-resolved) data
 * source.
 */
export {
  BLOG_CATEGORY_TABLE,
  BLOG_MENU_TABLE,
  BLOG_PAGE_TABLE,
  BLOG_POST_TABLE,
  BLOG_REVISION_TABLE,
  BLOG_SETTING_TABLE,
  BLOG_TAG_TABLE,
  JsailsBlogCategory,
  JsailsBlogMenu,
  JsailsBlogPage,
  JsailsBlogPost,
  JsailsBlogRevision,
  JsailsBlogSetting,
  JsailsBlogTag,
  blogEntities,
} from './entities.js';

export {
  BlogPersistenceError,
  createDatabaseBlogRepository,
  type BlogPersistenceErrorCode,
  type DatabaseBlogRepositoryOptions,
} from './database-repository.js';
