/**
 * The database-backed config store (`@jsails/config/database`): the
 * `jsails_config` entity and {@link createDatabaseConfigStore}. A separate
 * subpath, so importing `@jsails/config` (the plugin a config lists) loads no
 * TypeORM. An app that persists config provides the store under
 * `configStoreToken` from its own plugin and names it in
 * `configPlugin({ store: configStoreToken })`.
 */

export { CONFIG_TABLE, JsailsConfigEntry, configEntities } from './entities.js';
export { createDatabaseConfigStore, type DatabaseConfigStoreOptions } from './store.js';
