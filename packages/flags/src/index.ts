/**
 * First-party feature flags (`@jsails/flags`).
 *
 * A boolean gate the app flips without a deploy. The public surface is narrow:
 * the value-free {@link FeatureFlagError}, the {@link FeatureStore} contract
 * with an in-memory default ({@link createMemoryFlagStore}) and the token
 * family another plugin provides a store under ({@link featureStoreToken}),
 * the {@link resolveFeature} active/inactive branch helper, and the
 * {@link flagsPlugin} exposing a {@link FeatureFlags} service under
 * {@link flagsToken}, whose checks read a cached flag set.
 * Scopes are independent string/id namespaces, so the same key can be active
 * for one scope and inactive elsewhere.
 *
 * Importing this barrel is inert and loads no TypeORM: nothing connects and no
 * flag is read or written until a store or service method is called. The
 * database-backed store is the `@jsails/flags/database` subpath and the admin
 * page the `@jsails/flags/admin` subpath.
 */

export {
  FeatureFlagError,
  createMemoryFlagStore,
  resolveFeature,
  type FeatureFlagErrorCode,
  type FeatureFlags,
  type FeatureResolution,
  type FeatureStore,
} from './flags.js';

export {
  coverage,
  everyone,
  nobody,
  beforeAfter,
  shipped,
  when,
  type FlagScope,
} from './scopes.js';

export { featureStoreToken, flagsPlugin, flagsToken, type FlagsPluginOptions } from './plugin.js';

// `plugins.use` resolves a specifier by importing the default export and
// calling it with the options tuple.
export { flagsPlugin as default } from './plugin.js';
