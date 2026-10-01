/**
 * Database-backed persistence for the tenant-free blog CMS content model.
 *
 * This subpath (`src/blog/persistence/`) wires the `ContentRepository` contract
 * from `../content/repository.js` to TypeORM entities and a repository. An app
 * opts in by adding {@link contentEntities} to its `JsailsDataSource` `entities`
 * list and running `jsails db:push`; it then builds a repository with
 * {@link createDatabaseContentRepository} over that (or a lazily-resolved) data
 * source.
 *
 * This barrel is deliberately **not** re-exported from `jsails/blog` yet: the
 * content model's public surface (`jsails/blog/content`) already ships an
 * in-memory repository, and wiring this database-backed one into the plugin's
 * service token is a separate integration step the caller owns.
 */
export {
  CONTENT_CATEGORY_TABLE,
  CONTENT_MENU_TABLE,
  CONTENT_PAGE_TABLE,
  CONTENT_POST_TABLE,
  CONTENT_REVISION_TABLE,
  CONTENT_SETTING_TABLE,
  CONTENT_TAG_TABLE,
  JsailsContentCategory,
  JsailsContentMenu,
  JsailsContentPage,
  JsailsContentPost,
  JsailsContentRevision,
  JsailsContentSetting,
  JsailsContentTag,
  contentEntities,
} from './entities.js';

export {
  ContentPersistenceError,
  createDatabaseContentRepository,
  type DatabaseContentRepositoryOptions,
} from './database-repository.js';
