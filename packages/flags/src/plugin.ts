/**
 * First-party `flags` plugin: exposes a {@link FeatureFlags} service under
 * {@link flagsToken}.
 *
 * `flagsPlugin(options?)` configures a plugin named `flags` on the
 * `definePlugin` contract. Its one option is checked by a strict schema when
 * the factory is called (a failure is `config.invalid_options`, before
 * anything runs):
 *
 * - `store` names the {@link FeatureStore} another plugin provides under
 *   {@link featureStoreToken} (or a keyed member); it is required, used
 *   verbatim, and never closed here;
 * - without it the plugin owns a zero-config in-memory store
 *   ({@link createMemoryFlagStore}).
 *
 * The service's checks read a flag set cached through `defineCache` over the
 * `cache` plugin's services, which the plugin therefore requires. Setup builds
 * the service over that cache and returns no cleanup; nothing connects and no
 * flag is read or written until the service is used. The admin page reaches
 * the same service through the application scope, so the admin and the
 * runtime never diverge.
 */

import { cacheTagsToken, cacheToken, defineCache } from 'jsails/cache';
import {
  createServiceToken,
  definePlugin,
  tokenRef,
  type PluginFactory,
  type ServiceToken,
  type ServiceTokenFamily,
} from 'jsails/kernel';
import { z } from 'jsails/zod';

import {
  FLAGS_CACHE,
  createFeatureFlags,
  createMemoryFlagStore,
  type FeatureFlags,
  type FeatureStore,
} from './flags.js';

/**
 * Opaque token for the application {@link FeatureFlags}. Defined once here and
 * shared by the provider (`flagsPlugin`) and any consumer (a plugin's
 * `requires`, the admin page).
 */
export const flagsToken: ServiceToken<FeatureFlags> = createServiceToken<FeatureFlags>('flags');

/**
 * Token family for a {@link FeatureStore} another plugin provides, named by
 * `flagsPlugin({ store: featureStoreToken })`.
 *
 * @public
 */
export const featureStoreToken: ServiceTokenFamily<FeatureStore> =
  createServiceToken<FeatureStore>('flags.store');

/**
 * Options accepted by {@link flagsPlugin}.
 *
 * @public
 */
export interface FlagsPluginOptions {
  /** The store another plugin provides; used verbatim and never closed here. */
  readonly store?: ServiceToken<FeatureStore>;
}

const flagsOptions: z.ZodType<FlagsPluginOptions> = z
  .object({ store: tokenRef(featureStoreToken).optional() })
  .strict();

/**
 * The first-party `flags` plugin. Nothing is read until the service is used.
 */
export const flagsPlugin: PluginFactory<FlagsPluginOptions | undefined> = definePlugin({
  name: 'flags',
  options: flagsOptions.optional(),
  requires: (options) => [cacheToken, cacheTagsToken, options?.store],
  provides: [flagsToken],
  setup({ options, services }) {
    const store =
      options?.store === undefined ? createMemoryFlagStore() : services.get(options.store);
    services.provide(flagsToken, createFeatureFlags(store, defineCache(services, FLAGS_CACHE)));
  },
});
