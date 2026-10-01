/**
 * First-party `routing` plugin: discovers filesystem routes and publishes the
 * {@link RouteManifest} under a typed service token so the pipeline can resolve
 * the manifest from the registry after the plugins run.
 *
 * `routingPlugin(options?)` configures a plugin named `routing` on the
 * `definePlugin` contract. Its options are the pages and API directories,
 * relative to the application root the host hands setup
 * (`PluginSetupContext.rootDir`), checked by a strict schema when the factory
 * is called (a failure is `config.invalid_options`, before anything runs).
 *
 * Setup calls {@link discoverRoutes}, which reads the route directories, and
 * provides the result under {@link routeManifestToken}. It writes nothing,
 * opens nothing, and returns no cleanup: the manifest is static after
 * discovery.
 */

import { z } from 'zod';

import { definePlugin, type PluginFactory } from '../plugins/contract/define-plugin.js';
import { discoverRoutes } from './routes.js';
import { routeManifestToken } from './token.js';

/** Options for the routing plugin. */
export interface RoutingPluginOptions {
  /** The pages directory relative to the application root (default `pages`). */
  readonly pagesDir?: string;
  /** The API directory relative to the application root (default `api`). */
  readonly apiDir?: string;
}

const routingOptions: z.ZodType<RoutingPluginOptions> = z
  .object({
    pagesDir: z.string().min(1).optional(),
    apiDir: z.string().min(1).optional(),
  })
  .strict();

/**
 * The first-party `routing` plugin. Nothing is read from disk until its setup
 * runs, which provides the manifest under {@link routeManifestToken}.
 */
export const routingPlugin: PluginFactory<RoutingPluginOptions | undefined> = definePlugin({
  name: 'routing',
  options: routingOptions.optional(),
  provides: [routeManifestToken],
  setup({ options, rootDir, services }) {
    services.provide(
      routeManifestToken,
      discoverRoutes(rootDir, { pagesDir: options?.pagesDir, apiDir: options?.apiDir }),
    );
  },
});
