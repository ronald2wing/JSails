/**
 * The HTTP pipeline of an application: `createApp` over the discovered routes,
 * the extensions' services, and the asset index.
 *
 * It is apart from `application.ts` because it loads the request stack (Hono,
 * the route and page handlers, the asset responder, the server-components
 * runtime, introspection), none of which a static `build` uses. `createApplication` imports this module on the first `fetch`
 * or `serve`, so `jsails build` assembles and renders an application without
 * loading the server.
 *
 * The config's `onError`, `errorPage`, `systemChecks`, and `readiness` reach
 * `createApp` unchanged, except that every extension's declared readiness
 * probes, and the probes of the lifecycle units the process runs, are added
 * to `readiness.probes`.
 */

import { basename } from 'node:path';

import type { Hono } from 'hono';

import type { AssetIndex } from '../assets/asset-index.js';
import { diagnosticsToken } from '../diagnostics/index.js';
import type { ExtensionRuntime } from '../extensions/extension.js';
import type { ServiceRegistry, ServiceToken } from '../extensions/services.js';
import { i18nToken } from '../i18n/token.js';
import { jobMetricsToken, failedJobStoreToken } from '../introspect/builtin-providers.js';
import {
  createBuiltinIntrospectProviders,
  type IntrospectRouteConfig,
} from '../introspect/index.js';
import type { PageRenderer } from '../contracts/render.js';
import type { RouteManifest } from '../routing/routes.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import { serverComponentsToken } from '../server-components/extension.js';
import type { PluginGraphNode } from '../kernel/resolve-plugins.js';
import { createApp } from '../server/app.js';
import type { AppEnv } from '../server/env.js';
import type { ReadinessOptions, ReadinessProbe } from '../server/readiness.js';
import { AppConfigError } from './config/index.js';
import type { ResolvedAppConfig, ResolvedSeoConfig } from './config/index.js';

/** What {@link createHttpPipeline} assembles an application's pipeline from. */
export interface HttpPipelineInputs {
  readonly config: ResolvedAppConfig;
  readonly manifest: RouteManifest;
  /** The opened extension runtime: services, HTTP contributions, scopes, probes. */
  readonly runtime: ExtensionRuntime;
  /** The pages plugin's renderer, used when the config names none. */
  readonly pageRenderer: PageRenderer;
  /** The asset index static generation shares. */
  readonly assets: AssetIndex;
  /** Whether a managed plugin's route may be served: only in managed mode. */
  readonly pluginOrigins: 'allow-managed' | 'code-only';
  /** The plugin graph's nodes, in setup order, for the introspection `plugins` section. */
  readonly plugins: readonly PluginGraphNode[];
  /** The readiness probes of the lifecycle units the process runs, by unit name. */
  readonly unitProbes?: readonly (readonly [string, ReadinessProbe])[];
}

/**
 * An assembler of one application's HTTP pipeline. Each call runs `createApp`
 * with the registrars' contributions and the asset index; the caller
 * memoizes a successful result. The introspection
 * config is computed on the first call and reused, since its inputs are fixed
 * for the application's lifetime.
 */
export function createHttpPipeline(inputs: HttpPipelineInputs): () => Promise<Hono<AppEnv>> {
  const { config, manifest, runtime, pageRenderer, assets, pluginOrigins } = inputs;

  let introspectRouteConfig: IntrospectRouteConfig | undefined;
  const resolveIntrospectRouteConfig = (): IntrospectRouteConfig | undefined => {
    introspectRouteConfig ??= createIntrospectRouteConfig({
      config,
      manifest,
      services: runtime.services,
      plugins: inputs.plugins,
    });
    return introspectRouteConfig;
  };

  return () =>
    createApp({
      manifest,
      resolveSession: config.resolveSession,
      identity: config.identity,
      renderer: config.renderer ?? pageRenderer,
      services: runtime.services,
      contributions: { routes: runtime.routes, transforms: runtime.transforms },
      pluginOrigins,
      requestScopes: runtime.requestScopes,
      guards: [...config.http.guards, ...runtime.guards],
      maxBodyBytes: config.maxBodyBytes,
      handlerTimeoutMs: config.server.handlerTimeoutMs,
      server: {
        ...(config.server.origin === undefined ? {} : { origin: config.server.origin }),
        hosts: config.server.hosts,
        trustedProxies: config.server.trustedProxies,
      },
      assets,
      healthPath: config.healthPath,
      ...optionalAppOptions(config, [...runtime.readinessProbes, ...(inputs.unitProbes ?? [])]),
      ...(config.render !== undefined ? { render: config.render } : {}),
      ...(config.telemetry !== undefined ? { telemetry: config.telemetry } : {}),
      storagePath: config.storageDir,
      seo: toSeoRuntimeOptions(config.seo),
      introspect: resolveIntrospectRouteConfig(),
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
}

/**
 * The error, readiness, and system-check options `createApp` takes from the
 * config, each omitted when unset so createApp keeps its own defaults.
 */
function optionalAppOptions(
  config: ResolvedAppConfig,
  extensionProbes: readonly (readonly [string, ReadinessProbe])[],
): {
  onError?: ResolvedAppConfig['onError'];
  errorPage?: ResolvedAppConfig['errorPage'];
  readiness?: ReadinessOptions;
  systemChecks?: ResolvedAppConfig['systemChecks'];
} {
  const readiness = mergeReadiness(config.readiness, extensionProbes);
  return {
    ...(config.onError === undefined ? {} : { onError: config.onError }),
    ...(config.errorPage === undefined ? {} : { errorPage: config.errorPage }),
    ...(readiness === undefined ? {} : { readiness }),
    ...(config.systemChecks === undefined ? {} : { systemChecks: config.systemChecks }),
  };
}

/**
 * The config's readiness options with every extension's probes added. Probes
 * from extensions alone switch the readiness endpoint on with its defaults. A
 * name used by both the config and an extension is an error rather than a
 * silent override, because a dropped probe would leave a dependency unchecked.
 */
function mergeReadiness(
  options: ReadinessOptions | undefined,
  extensionProbes: readonly (readonly [string, ReadinessProbe])[],
): ReadinessOptions | undefined {
  if (extensionProbes.length === 0) return options;
  const configProbes = Object.entries(options?.probes ?? {});
  const configNames = new Set(configProbes.map(([name]) => name));
  if (extensionProbes.some(([name]) => configNames.has(name))) {
    throw new AppConfigError(
      'config.readiness.probes uses a probe name an extension already declares',
    );
  }
  return { ...options, probes: Object.fromEntries([...configProbes, ...extensionProbes]) };
}

/** Inputs to {@link createIntrospectRouteConfig}. */
interface IntrospectRouteConfigInputs {
  readonly config: ResolvedAppConfig;
  readonly manifest: RouteManifest;
  readonly services: ServiceRegistry;
  readonly plugins: readonly PluginGraphNode[];
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
  const { config, manifest, services } = inputs;
  if (config.introspect === undefined) return undefined;
  const providers = createBuiltinIntrospectProviders({
    manifest,
    plugins: inputs.plugins,
    componentsRuntime: resolveService(services, serverComponentsToken),
    diagnosticsService: resolveService(services, diagnosticsToken),
    jobMetrics: resolveService(services, jobMetricsToken),
    failedJobStore: resolveService(services, failedJobStoreToken),
    i18nService: resolveService(services, i18nToken),
    appConfig: {
      host: config.host,
      port: config.port,
      ...(config.server.origin === undefined ? {} : { origin: config.server.origin }),
      trustedProxies: config.server.trustedProxies,
      ...(config.healthPath === undefined ? {} : { healthPath: config.healthPath }),
      maxBodyBytes: config.maxBodyBytes,
      handlerTimeoutMs: config.server.handlerTimeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      dirs: {
        root: basename(config.rootDir) || '.',
        pages: basename(config.pagesDir),
        api: basename(config.apiDir),
        public: basename(config.publicDir),
        out: basename(config.outDir),
        storage: basename(config.storageDir),
      },
      hasResolveSession: config.resolveSession !== undefined || config.identity !== undefined,
      hasSetup: config.setup !== undefined,
      hasRenderer: config.renderer !== undefined,
      hasBroadcast: config.extensions.some((extension) => extension.name === 'broadcast'),
      extensionCount: config.extensions.length,
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
