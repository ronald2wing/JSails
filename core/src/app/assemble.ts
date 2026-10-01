/**
 * The application layer over opened {@link Services}, for `createApplication`.
 *
 * The kernel already ran every plugin's setup (`openServices`). The route
 * manifest, page renderer, and static-site generator are read here from the
 * sealed service registry; a plugin that did not provide its service is a
 * fatal boot error. The app's own legacy `setup` hook then runs inside the
 * ambient facade scope, and the cleanup it returns is deferred onto the
 * services, so it runs after the units drained and before the plugin
 * cleanups. On any failure the services are closed before the error
 * propagates.
 */

import type { PageRenderer } from '../contracts/render.js';
import { withAppScope } from '../facades/app-scope.js';
import type { Services } from '../kernel/open-services.js';
import type {
  GenerateStaticSiteOptions,
  GenerateStaticSiteResult,
} from '../pages/static-site/index.js';
import { pageRendererToken, staticSiteToken } from '../pages/plugin.js';
import type { RouteManifest } from '../routing/routes.js';
import { routeManifestToken } from '../routing/token.js';
import { AppConfigError } from './config/index.js';
import type { ResolvedAppConfig } from './config/index.js';

/** Renders the static site into an output directory. */
export type StaticSiteGenerator = (
  options: GenerateStaticSiteOptions,
) => Promise<GenerateStaticSiteResult>;

/** The services an application is built on. */
export interface AssembledApplication {
  /** The route manifest the routing plugin discovered. */
  readonly manifest: RouteManifest;
  /** The default page renderer from the pages plugin. */
  readonly pageRenderer: PageRenderer;
  /** The static-site generator from the pages plugin. */
  readonly generateStaticSite: StaticSiteGenerator;
}

/**
 * Read the services every application requires from `services` and run the
 * app's own `setup` hook. Closes `services` when anything fails.
 */
export async function assembleApplication(
  config: ResolvedAppConfig,
  services: Services,
): Promise<AssembledApplication> {
  try {
    const registry = services.registry;
    const manifest = requireService(
      () => registry.get(routeManifestToken),
      'route discovery did not provide a manifest',
    );
    const pageRenderer = requireService(
      () => registry.get(pageRendererToken),
      'pages plugin did not provide a page renderer',
    );
    const generateStaticSite = requireService(
      () => registry.get(staticSiteToken),
      'pages plugin did not provide a static site generator',
    );
    // The health endpoint is framework infrastructure registered ahead of the
    // filesystem routes, so it must not claim a route that already belongs to
    // a page or API module.
    assertNoHealthRouteCollision(manifest, config.healthPath);
    const result = await withAppScope(registry, () => config.setup?.());
    if (typeof result === 'function') services.defer(result);
    return { manifest, pageRenderer, generateStaticSite };
  } catch (error) {
    let closeError: unknown;
    try {
      await services.close();
    } catch (cleanupError) {
      closeError = cleanupError;
    }
    if (closeError === undefined) throw error;
    throw new AggregateError([error, closeError], 'application setup failed', { cause: error });
  }
}

/** Read a service every app requires; a missing one is a value-free boot error. */
function requireService<T>(read: () => T, message: string): T {
  try {
    return read();
  } catch {
    throw new AppConfigError(message);
  }
}

/**
 * Reject a health endpoint path that collides with a discovered page or API
 * route. The message names the conflicting route and its source file, an
 * intentional exception to the value-free config-error convention: the file is
 * the actionable fix and is never attacker-controlled input.
 */
function assertNoHealthRouteCollision(
  manifest: RouteManifest,
  healthPath: string | undefined,
): void {
  if (healthPath === undefined) return;
  const entry = manifest.byRoute.get(healthPath);
  if (entry === undefined) return;
  throw new AppConfigError(
    `config.healthPath "${healthPath}" collides with the ${entry.kind} route "${entry.route}" (${entry.file})`,
  );
}
