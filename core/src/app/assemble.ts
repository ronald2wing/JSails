/**
 * Plugin and extension assembly for `createApplication`.
 *
 * `assembleExtensions` turns a {@link ResolvedAppConfig} into the opened
 * extension runtime and the services every application needs: it activates
 * managed plugins, resolves declarative `plugins.use` entries into constructed
 * {@link JsailsPlugin} objects (a failed entry is a value-free
 * {@link AppConfigError}), injects the framework plugins (`routing` first so
 * every app gets filesystem route discovery, `pages` second for the default
 * Preact renderer and static-site generator, then `i18n` when configured),
 * drops live-only plugins for a `static` shape, and runs every extension's
 * `setup` in declaration order. The route manifest, page renderer, and
 * static-site generator are then resolved from the sealed service registry; a
 * plugin that did not provide its service is a fatal boot error. The app's own
 * `setup` hook runs last, inside the ambient facade scope; when it throws, the
 * extensions that already opened are closed again before the error propagates.
 *
 * Developer plugins always run in full: `config.plugins.enabled` is a
 * marketplace/managed-only gate for plugins installed through the admin
 * directory, never a developer filter at boot time.
 */

import { resolve as resolvePath } from 'node:path';

import type { PageRenderer } from '../contracts/render.js';
import { runExtensions, type ExtensionRuntime } from '../extensions/extension.js';
import type { JsailsPlugin } from '../extensions/plugin-contract.js';
import { withAppScope } from '../facades/app-scope.js';
import { i18nPlugin, type I18nPluginOptions } from '../i18n/plugin.js';
import type { Messages } from '../i18n/translator.js';
import type {
  GenerateStaticSiteOptions,
  GenerateStaticSiteResult,
} from '../pages/static-site/index.js';
import { pagesPlugin, pageRendererToken, staticSiteToken } from '../pages/plugin.js';
import { activatePlugins } from '../plugins/activation.js';
import { isLiveOnlyPlugin } from '../plugins/live-only.js';
import { resolvePluginUse } from '../plugins/use.js';
import type { RouteManifest } from '../routing/routes.js';
import { routingPlugin, routeManifestToken } from '../routing/plugin.js';
import { AppConfigError } from './config/index.js';
import type { AppCleanup, PluginUseEntry, ResolvedAppConfig } from './config/index.js';

/** Renders the static site into an output directory. */
export type StaticSiteGenerator = (
  options: GenerateStaticSiteOptions,
) => Promise<GenerateStaticSiteResult>;

/** The opened extension runtime and the services an application is built on. */
export interface AssembledExtensions {
  /** Every extension's services, hooks, and reverse-order teardown. */
  readonly runtime: ExtensionRuntime;
  /** The route manifest the routing plugin discovered. */
  readonly manifest: RouteManifest;
  /** The default page renderer from the pages plugin. */
  readonly pageRenderer: PageRenderer;
  /** The static-site generator from the pages plugin. */
  readonly generateStaticSite: StaticSiteGenerator;
  /** The cleanup the app's own `setup` hook returned, if any. */
  readonly appCleanup: AppCleanup | undefined;
}

/** Open every extension and resolve the services the application requires. */
export async function assembleExtensions(config: ResolvedAppConfig): Promise<AssembledExtensions> {
  const extensions = await resolveExtensions(config);
  const runtime = await runExtensions(extensions);

  const manifest = requireService(
    () => runtime.services.get(routeManifestToken),
    'route discovery did not provide a manifest',
  );
  const pageRenderer = requireService(
    () => runtime.services.get(pageRendererToken),
    'pages plugin did not provide a page renderer',
  );
  const generateStaticSite = requireService(
    () => runtime.services.get(staticSiteToken),
    'pages plugin did not provide a static site generator',
  );

  // The health endpoint is framework infrastructure registered ahead of the
  // filesystem routes, so it must not claim a route that already belongs to a
  // page or API module.
  assertNoHealthRouteCollision(manifest, config.healthPath);

  const appCleanup = await runAppSetup(config, runtime);
  return { runtime, manifest, pageRenderer, generateStaticSite, appCleanup };
}

/**
 * The full extension list in setup order: the framework plugins, then managed
 * plugins, then `plugins.use`, then `config.extensions`. An app with no plugins
 * at all still gets route discovery and page rendering.
 */
async function resolveExtensions(config: ResolvedAppConfig): Promise<readonly JsailsPlugin[]> {
  const extensions: JsailsPlugin[] = [
    routingPlugin({
      rootDir: config.rootDir,
      pagesDir: config.pagesDir,
      apiDir: config.apiDir,
    }),
    pagesPlugin(),
  ];

  // Wired from `config.i18n` so user plugins can declare `requires: [i18nToken]`.
  if (config.i18n !== undefined) {
    const resolved = config.i18n;
    const options: I18nPluginOptions = {
      locale: resolved.locale,
      fallbackLocale: resolved.fallbackLocale,
      catalogs: resolved.catalogs as Record<string, Messages> | undefined,
      loadPaths: resolved.loadPaths?.map((path) => resolvePath(config.rootDir, path)),
    };
    extensions.push(i18nPlugin(options));
  }

  extensions.push(
    ...(await resolveManagedPlugins(config)),
    ...(await resolveUsePlugins(config.plugins?.use, config.plugins?.force)),
    ...config.extensions,
  );

  // A `static` shape excludes every plugin that declares `needsLive: true`
  // through its own `describe()`. This is the one thing a shape switch
  // changes; the file structure is identical across shapes.
  if ((config.shape ?? 'full') === 'static') {
    return extensions.filter((extension) => !isLiveOnlyPlugin(extension));
  }
  return extensions;
}

/**
 * Managed plugins are discovered from the plugins folder and activated from
 * the persisted state. A static export never consults managed state.
 */
async function resolveManagedPlugins(config: ResolvedAppConfig): Promise<readonly JsailsPlugin[]> {
  const stateSource = config.plugins?.stateSource;
  if (
    config.plugins?.managed !== true ||
    stateSource === undefined ||
    (config.shape ?? 'full') === 'static'
  ) {
    return [];
  }
  try {
    const activation = await activatePlugins({
      rootDir: config.rootDir,
      codeEnabled: config.plugins.enabled,
      managed: true,
      stateSource,
      pluginsDir: config.plugins.pluginsDir,
    });
    return activation.plugins;
  } catch {
    throw new AppConfigError('managed plugins could not be activated');
  }
}

/**
 * Resolve `plugins.use` entries into constructed plugins. A use entry that
 * fails to load is a fatal boot error: the developer asked for it explicitly,
 * so a missing or broken plugin is a misconfiguration, not a warning.
 */
async function resolveUsePlugins(
  entries: readonly PluginUseEntry[] | undefined,
  force: boolean | undefined,
): Promise<readonly JsailsPlugin[]> {
  if (entries === undefined || entries.length === 0) return [];

  const result = await resolvePluginUse({ entries, force });
  if (result.issues.length > 0) {
    // The specifier is the value the developer wrote in their config, not a
    // secret: it is the actionable identifier. Options and error details are
    // never echoed.
    const specifiers = result.issues.map((issue) => issue.path ?? 'unknown').join(', ');
    throw new AppConfigError(`plugin(s) failed to load: ${specifiers}`);
  }
  return result.plugins;
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
 * Run the app's own `setup` hook inside the ambient scope so it may call
 * facades. When it throws, the already-open extensions are closed first.
 */
async function runAppSetup(
  config: ResolvedAppConfig,
  runtime: ExtensionRuntime,
): Promise<AppCleanup | undefined> {
  try {
    const result = await withAppScope(runtime.services, () => config.setup?.());
    return typeof result === 'function' ? result : undefined;
  } catch (error) {
    let closeError: unknown;
    try {
      await runtime.close();
    } catch (cleanupError) {
      closeError = cleanupError;
    }
    if (closeError === undefined) throw error;
    throw new AggregateError([error, closeError], 'application setup failed', { cause: error });
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
