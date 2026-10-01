/**
 * Application runtime assembly.
 *
 * `createApplication` turns a {@link ResolvedAppConfig} into a runnable
 * {@link Application}. It is deliberately inert about infrastructure: it never
 * initializes a database or a Valkey connection itself. Extensions own their
 * services, and route discovery happens during extension setup, so
 * {@link assembleExtensions} opens every extension first and hands back the
 * route manifest, the default page renderer, and the static-site generator.
 *
 * {@link Application.build} renders the static site through the resolved
 * generator (the configured renderer or the default Preact renderer from the
 * `pages` plugin, plus the extension services) and never listens on a port.
 * {@link Application.serve} assembles the Hono app, mounts the public-files
 * middleware, and opens one HTTP server through {@link openServer}, which runs
 * each collected serve hook (e.g. the broadcast plugin's, which attaches its
 * transport to that same server) before listening.
 *
 * {@link Application.fetch} routes a single {@link Request} through the same
 * assembled Hono pipeline without constructing an HTTP server, listening, or
 * running a serve hook. The pipeline (`createApp` plus the public-files
 * middleware, including every `configureHttp` hook) is assembled lazily and
 * memoized once, so `fetch` and `serve` share one app and the hooks run exactly
 * once per successful assembly. A failed assembly is forgotten so a later
 * request retries it from scratch. `fetch` calls are independent: they run
 * concurrently like a real server rather than behind the build/serve lock.
 *
 * `close()` tears down in reverse: the HTTP servers first, then the app
 * cleanup, then the extensions (the broadcast plugin stops its transport
 * there); every step is attempted even when earlier ones fail, and `close()`
 * is idempotent and safe for concurrent callers. Before the teardown it waits
 * for any in-flight `fetch` handler to return its `Response`, so a running
 * handler never races the extension cleanups. Only handler completion is
 * drained: the returned `Response`'s body may still be streaming and is the
 * caller's to consume. Server teardown is bounded by
 * `config.shutdownTimeoutMs` (see {@link closeServer}); the app's own cleanup
 * and the extensions' cleanups are trusted and awaited without a deadline.
 */

import type { Server as NodeHttpServer } from 'node:http';
import { basename } from 'node:path';

import type { Hono } from 'hono';

import { diagnosticsToken } from '../diagnostics/index.js';
import { JsailsError } from '../errors/jsails-error.js';
import type { ServiceRegistry, ServiceToken } from '../extensions/services.js';
import { withAppScope } from '../facades/app-scope.js';
import { i18nToken } from '../i18n/plugin.js';
import { jobMetricsToken, failedJobStoreToken } from '../introspect/builtin-providers.js';
import {
  createBuiltinIntrospectProviders,
  type IntrospectRouteConfig,
} from '../introspect/index.js';
import type { GenerateStaticSiteResult } from '../pages/static-site/index.js';
import { resolvePluginEnablement } from '../plugins/enablement.js';
import type { RouteMiddlewareRef } from '../routing/middleware.js';
import type { RouteManifest } from '../routing/routes.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import { serverComponentsToken } from '../server-components/extension.js';
import { createApp } from '../server/app.js';
import type { AppEnv, AppMiddlewareHandler } from '../server/env.js';
import { assembleExtensions } from './assemble.js';
import { createAssetUrlResolver } from './asset-urls.js';
import { AppConfigError } from './config/index.js';
import type { ResolvedAppConfig, ResolvedSeoConfig } from './config/index.js';
import { createPublicFilesMiddleware } from './public-files.js';
import { closeServer, openServer, type ServedServer } from './serve.js';

/** The failures an {@link Application} raises itself. */
export type ApplicationErrorCode = 'closed';

/** Raised by `build`, `serve`, and `fetch` once the application is closed. */
export class ApplicationError extends JsailsError {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A runnable application assembled from a {@link ResolvedAppConfig}. */
export interface Application {
  /** The resolved config this application is assembled from. */
  readonly config: ResolvedAppConfig;
  /** The discovered route manifest (pages and API routes). */
  readonly manifest: RouteManifest;
  /** Read-only services provided by the applied extensions. */
  readonly services: ServiceRegistry;
  /** Render the static site into `config.outDir`; never opens a port. */
  build(): Promise<GenerateStaticSiteResult>;
  /** Assemble and listen the HTTP server, running every serve hook first. */
  serve(): Promise<ServeHandle>;
  /**
   * Route one request through the shared Hono pipeline. No HTTP server is
   * constructed, nothing listens, and no serve hook runs. Requests
   * are independent and may run concurrently. The returned `Response`'s body
   * is the caller's to consume; `close` does not drain streamed bodies.
   */
  fetch(request: Request): Promise<Response>;
  /** Stop the HTTP server, then app cleanup, then reverse extensions. */
  close(): Promise<void>;
}

/** A listening HTTP server owned by {@link Application.serve}. */
export interface ServeHandle {
  /** The bound `node:http.Server`; serve hooks (e.g. broadcast) share it. */
  readonly server: NodeHttpServer;
  /** The actual bound port (resolved when `config.port` is `0`). */
  readonly port: number;
  /** The server's origin URL, e.g. `http://127.0.0.1:3000/`. */
  readonly url: string;
  /** Shut the whole application down; delegates to {@link Application.close}. */
  close(): Promise<void>;
}

/**
 * Assemble an {@link Application} from a resolved config. Route discovery and
 * extension setup run before any port is opened; the returned application owns
 * no connection until `serve()` (or an extension's own `setup`) creates one.
 */
export async function createApplication(config: ResolvedAppConfig): Promise<Application> {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('createApplication requires a resolved app config');
  }

  // One shared asset-URL resolver for HTTP and static generation. It performs no
  // filesystem access until first used, so building it is inert.
  const assetUrl = createAssetUrlResolver(config.publicDir);

  const { runtime, manifest, pageRenderer, generateStaticSite, appCleanup } =
    await assembleExtensions(config);

  // The introspection config captures the route manifest, the plugin
  // enablement, and the live services from the extension registry. The
  // middleware-derived inputs only exist inside `buildApp`, and are static per
  // application lifecycle, so the config is computed once and reused.
  let introspectRouteConfig: IntrospectRouteConfig | undefined;
  const resolveIntrospectRouteConfig = (
    middlewareNames: readonly string[],
    globalMiddlewareCount: number,
  ): IntrospectRouteConfig | undefined => {
    introspectRouteConfig ??= createIntrospectRouteConfig({
      config,
      manifest,
      services: runtime.services,
      middlewareNames,
      globalMiddlewareCount,
    });
    return introspectRouteConfig;
  };

  const served: ServedServer[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  let opTail: Promise<void> = Promise.resolve();

  // The shared Hono pipeline (createApp + public middleware), assembled lazily
  // on the first fetch/serve and memoized for both. A failed assembly is
  // forgotten so a later request retries it from scratch.
  let assembledApp: Hono<AppEnv> | undefined;
  let assemblingApp: Promise<Hono<AppEnv>> | undefined;

  // In-flight `fetch` requests. `close` waits for these to return their
  // `Response` before tearing down extensions. Only handler completion is
  // drained: a streamed body is the caller's to consume and is never waited on.
  let inflightFetches = 0;
  let fetchesDrained: Promise<void> = Promise.resolve();
  let resolveFetchesDrained: (() => void) | undefined;

  /** Serialize build/serve/close so they never interleave shared state. */
  const withLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = opTail.then(operation);
    opTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const closedError = (): ApplicationError =>
    new ApplicationError('closed', 'application is closed');

  const assertOpen = (): void => {
    if (closed) throw closedError();
  };

  /** Assemble (and memoize) the shared Hono pipeline once per application. */
  const assembleApp = (): Promise<Hono<AppEnv>> => {
    if (assembledApp !== undefined) return Promise.resolve(assembledApp);
    if (assemblingApp === undefined) {
      assemblingApp = buildApp().then(
        (app) => {
          assembledApp = app;
          assemblingApp = undefined;
          return app;
        },
        (error: unknown) => {
          // A failed assembly produced nothing reusable: forget it so the next
          // request re-runs createApp and the HTTP hooks from scratch.
          assemblingApp = undefined;
          throw error;
        },
      );
    }
    return assemblingApp;
  };

  /** Run `createApp`, then mount the public-files middleware onto it. */
  async function buildApp(): Promise<Hono<AppEnv>> {
    // The named middleware map is validated by the config loader (every key
    // non-empty, every value a function); pass it through by identity. String
    // refs in route exports and config globalMiddleware are resolved here at
    // assembly time so an unknown name fails at boot, never per-request.
    const middlewareMap: Readonly<Record<string, AppMiddlewareHandler>> = config.middleware ?? {};

    // The combined global chain: config-defined handlers first, then
    // extension-defined handlers in setup order.
    const resolvedConfigGlobal = resolveGlobalMiddlewareRefs(
      config.globalMiddleware,
      middlewareMap,
    );
    const globalMiddleware = [...resolvedConfigGlobal, ...runtime.middleware];

    const app = await createApp({
      manifest,
      authorize: config.authorize,
      resolveSession: config.resolveSession,
      renderer: config.renderer ?? pageRenderer,
      services: runtime.services,
      httpHooks: runtime.httpHooks,
      maxBodyBytes: config.maxBodyBytes,
      publicOrigin: config.publicOrigin,
      assetUrl,
      healthPath: config.healthPath,
      storagePath: config.storageDir,
      seo: toSeoRuntimeOptions(config.seo),
      introspect: resolveIntrospectRouteConfig(
        Object.keys(middlewareMap).sort(),
        globalMiddleware.length,
      ),
      globalMiddleware,
      middlewareMap,
      ...(config.i18n?.locales !== undefined
        ? {
            localeOptions: {
              locales: config.i18n.locales,
              ...(config.i18n.defaultLocale !== undefined
                ? { defaultLocale: config.i18n.defaultLocale }
                : {}),
            },
          }
        : {}),
    });

    const publicMiddleware = await createPublicFilesMiddleware(config.publicDir);
    if (publicMiddleware !== undefined) {
      app.use('*', publicMiddleware);
    }

    return app;
  }

  const build = (): Promise<GenerateStaticSiteResult> =>
    withLock(async () => {
      assertOpen();
      // Static export does not traverse the Hono pipeline, so open the scope
      // around the render pass explicitly.
      return withAppScope(runtime.services, () =>
        generateStaticSite({
          manifest,
          outDir: config.outDir,
          publicDir: config.publicDir,
          baseUrl: config.publicOrigin ?? config.seo?.origin,
          renderer: config.renderer ?? pageRenderer,
          services: runtime.services,
          assetUrl,
          storagePath: config.storageDir,
          seo: config.seo,
        }),
      );
    });

  const serve = (): Promise<ServeHandle> =>
    withLock(async () => {
      assertOpen();
      const app = await assembleApp();
      const entry = await openServer({ app, config, runtime });
      served.push(entry);
      return { server: entry.server, port: entry.port, url: entry.url, close: () => close() };
    });

  const fetchRequest = (request: Request): Promise<Response> => {
    if (request === null || typeof request !== 'object') {
      return Promise.reject(new TypeError('fetch requires a Request'));
    }
    if (closed) {
      return Promise.reject(closedError());
    }
    enterFetch();
    return (async () => {
      try {
        const app = await assembleApp();
        if (closed) {
          throw closedError();
        }
        return await app.fetch(request);
      } finally {
        exitFetch();
      }
    })();
  };

  /** Track a `fetch` handler as in-flight so `close` can drain it. */
  const enterFetch = (): void => {
    if (inflightFetches === 0) {
      fetchesDrained = new Promise<void>((resolve) => {
        resolveFetchesDrained = resolve;
      });
    }
    inflightFetches += 1;
  };

  /** Release one in-flight `fetch`; resolve the drain gate when none remain. */
  const exitFetch = (): void => {
    inflightFetches -= 1;
    if (inflightFetches === 0 && resolveFetchesDrained !== undefined) {
      resolveFetchesDrained();
      resolveFetchesDrained = undefined;
    }
  };

  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    // Reject future build/serve/fetch immediately; teardown runs behind any
    // in-flight op and waits for in-flight fetch handlers to settle first.
    closed = true;
    closing = withLock(async () => {
      await fetchesDrained;
      await teardown();
    });
    return closing;
  };

  async function teardown(): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of [...served].reverse()) {
      try {
        await closeServer(entry, config.shutdownTimeoutMs);
      } catch (error) {
        errors.push(error);
      }
    }
    if (appCleanup !== undefined) {
      try {
        await appCleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await runtime.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'application close failed');
  }

  return {
    config,
    manifest,
    services: runtime.services,
    build,
    serve,
    fetch: fetchRequest,
    close,
  };
}

/** Inputs to {@link createIntrospectRouteConfig}. */
interface IntrospectRouteConfigInputs {
  readonly config: ResolvedAppConfig;
  readonly manifest: RouteManifest;
  readonly services: ServiceRegistry;
  readonly middlewareNames: readonly string[];
  readonly globalMiddlewareCount: number;
}

/**
 * The introspection route's providers over the assembled app, or `undefined`
 * when `config.introspect` is unset. The app-config projection is redacted:
 * booleans for callbacks and directory basenames only, so introspection never
 * leaks absolute paths, secrets, or callback identities.
 */
function createIntrospectRouteConfig(
  inputs: IntrospectRouteConfigInputs,
): IntrospectRouteConfig | undefined {
  const { config, manifest, services, middlewareNames, globalMiddlewareCount } = inputs;
  if (config.introspect === undefined) return undefined;
  const plugins = resolvePluginEnablement({
    codeEnabled: config.plugins?.enabled,
  });
  const providers = createBuiltinIntrospectProviders({
    manifest,
    plugins,
    componentsRuntime: resolveService(services, serverComponentsToken),
    diagnosticsService: resolveService(services, diagnosticsToken),
    jobMetrics: resolveService(services, jobMetricsToken),
    failedJobStore: resolveService(services, failedJobStoreToken),
    i18nService: resolveService(services, i18nToken),
    middlewareNames,
    globalMiddlewareCount,
    appConfig: {
      host: config.host,
      port: config.port,
      ...(config.publicOrigin === undefined ? {} : { publicOrigin: config.publicOrigin }),
      ...(config.healthPath === undefined ? {} : { healthPath: config.healthPath }),
      maxBodyBytes: config.maxBodyBytes,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      dirs: {
        root: basename(config.rootDir) || '.',
        pages: basename(config.pagesDir),
        api: basename(config.apiDir),
        public: basename(config.publicDir),
        out: basename(config.outDir),
        storage: basename(config.storageDir),
      },
      hasAuthorize: config.authorize !== undefined,
      hasResolveSession: config.resolveSession !== undefined,
      hasSetup: config.setup !== undefined,
      hasRenderer: config.renderer !== undefined,
      hasBroadcast: config.extensions.some((extension) => extension.name === 'broadcast'),
      commandCount: config.commands.length,
      extensionCount: config.extensions.length,
      deploymentCount: config.deployments.length,
      pluginEnabled: config.plugins?.enabled ?? [],
      middlewareNames,
      globalMiddlewareCount,
      introspectEnabled: config.introspect?.enabled === true,
    },
  });
  return {
    enabled: config.introspect.enabled,
    authorize: config.introspect.authorize,
    sections: config.introspect.sections,
    providers,
  };
}

/** Resolve a single typed service from the registry, failing closed to undefined. */
function resolveService<T>(services: ServiceRegistry, token: ServiceToken<T>): T | undefined {
  try {
    return services.tryGet(token);
  } catch {
    return undefined;
  }
}

/**
 * Project the resolved SEO config onto the runtime options attached to every
 * page request context. `robots` is build-time only and is deliberately not
 * carried here. Returns `undefined` when no SEO config is set.
 */
function toSeoRuntimeOptions(seo: ResolvedSeoConfig | undefined): SeoRuntimeOptions | undefined {
  if (seo === undefined) return undefined;
  return { siteName: seo.siteName, origin: seo.origin, defaults: seo.defaults };
}

/**
 * Resolve config `globalMiddleware` refs (inline functions pass through by
 * identity; strings resolve against the named map) into concrete handlers.
 * An unknown name fails here at assembly with a value-free error that reports
 * the position, never the name or handler.
 */
function resolveGlobalMiddlewareRefs(
  refs: readonly RouteMiddlewareRef[] | undefined,
  map: Readonly<Record<string, AppMiddlewareHandler>>,
): readonly AppMiddlewareHandler[] {
  if (refs === undefined) return [];
  const result: AppMiddlewareHandler[] = [];
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index];
    if (typeof ref === 'function') {
      result.push(ref);
      continue;
    }
    // A non-string ref is unreachable after config validation; the branch
    // satisfies noUncheckedIndexedAccess and keeps the failure value-free.
    const resolved = typeof ref === 'string' ? map[ref] : undefined;
    if (resolved === undefined) {
      throw new AppConfigError(
        `config.globalMiddleware references an unknown middleware at index ${index}`,
      );
    }
    result.push(resolved);
  }
  return result;
}
