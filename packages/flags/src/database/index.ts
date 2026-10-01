/**
 * The database-backed feature store (`@jsails/flags/database`): the
 * `jsails_feature_flag` entity and {@link createDatabaseFlagStore}. A separate
 * subpath, so importing `@jsails/flags` (the plugin a config lists) loads no
 * TypeORM. An app that persists flags provides the store under
 * `featureStoreToken` from its own plugin and names it in
 * `flagsPlugin({ store: featureStoreToken })`.
 */

export { JsailsFeatureFlag, flagsEntities } from './entities.js';
export { createDatabaseFlagStore, type DatabaseFlagStoreOptions } from './store.js';
