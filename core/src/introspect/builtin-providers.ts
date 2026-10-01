/**
 * Built-in introspection providers for every section.
 *
 * These providers are assembled deterministically from the inputs the
 * application runtime already holds at assembly time — the route manifest,
 * the plugin graph, the component runtime's `describe()` surface, process
 * health, and optional live sources (diagnostics service, job metrics/failed
 * store). Each provider is self-contained and reports `unavailable` when its
 * source is absent; a provider that throws is caught by the route and yields
 * an `error` section without failing the rest.
 *
 * Providers that require a data source or external service never open a
 * connection or call a factory at construction time — those happen lazily
 * inside `collect`.
 */

import type { IntrospectProvider } from './sections.js';
import type { RouteManifest } from '../routing/routes.js';
import type { PluginGraphNode } from '../kernel/resolve-plugins.js';
import type { ServerComponentsRuntime } from '../server-components/runtime/index.js';
import type { Diagnostics } from '../diagnostics/index.js';
import type { FailedJobStore, FailedJobEntry } from '../jobs/failed-jobs.js';
import type { JobMetrics } from '../jobs/metrics.js';
import type { I18nService } from '../i18n/token.js';
import type { JsonValue } from '../contracts/http.js';
import type { TrustedProxies } from '../security/request-origin.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';

/**
 * The fixed request-pipeline stages in order, as a request to a route meets
 * them. Must change in lockstep with the pipeline implementation: the request
 * handler (`server/request-handler.ts`) opens the frame (request id, origin,
 * a 421 for a host the app does not serve, the request body bound to its
 * budget) and runs the guard tier; the router (`server/app.ts`) runs the
 * matched route's boundary (`server/route-boundary.ts`: the declared body
 * length against the route's limit, the route's deadline, the rate-limit
 * hook, the claim, the access chain's cross-site check and access gate,
 * the route's middleware, the handler, the response transforms, the
 * body budget's verdict), or the not-found answer
 * when no route matched (a 404, or a 405 with `Allow` when the route table
 * says the path answers other methods). Any failure is rendered once
 * (`server/failure-renderer.ts`), and every answer leaves through the
 * finalizer (`server/output.ts`). `not-found` stands in for the route's
 * stages (`body-length` to `body-verdict`) when no route matched, and
 * `failure-render` runs only for a failure. This is the single
 * source an AI agent reads to understand the runtime pipeline shape without
 * a live request or browser.
 */
export const PIPELINE_STAGES: readonly string[] = Object.freeze([
  'request-frame',
  'guards',
  'body-length',
  'deadline',
  'rate-limit',
  'claim',
  'cross-site',
  'access',
  'middleware',
  'handler',
  'transforms',
  'body-verdict',
  'not-found',
  'failure-render',
  'finalize',
]);

/**
 * Redacted projection of the resolved application configuration for the
 * `config` introspection section. Carries booleans for callbacks and
 * directory basenames only — never absolute filesystem paths, secrets, or
 * callback identities.
 */
export interface AppConfigIntrospectInput {
  readonly host: string;
  readonly port: number;
  /** The canonical origin (`server.origin`), when configured. */
  readonly origin?: string;
  /** The trusted-proxy setting (`server.trustedProxies`). */
  readonly trustedProxies: TrustedProxies;
  readonly healthPath?: string;
  readonly maxBodyBytes: number;
  /** The route deadline of a route that declares none (`server.handlerTimeoutMs`; `0`: none). */
  readonly handlerTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  /** Directory basenames only — never absolute paths. */
  readonly dirs: {
    readonly root: string;
    readonly pages: string;
    readonly api: string;
    readonly public: string;
    readonly out: string;
    readonly storage: string;
  };
  readonly hasResolveSession: boolean;
  readonly hasSetup: boolean;
  readonly hasRenderer: boolean;
  readonly hasBroadcast: boolean;
  readonly extensionCount: number;
  readonly introspectEnabled: boolean;
}

/**
 * Shape of the `pipeline` section data. All fields are always present when
 * status is `ok`.
 */
export interface PipelineSectionData {
  /** The fixed pipeline stages in execution order. */
  readonly stages: readonly string[];
  /** Static export never runs middleware, so this is always `false`. */
  readonly staticExportRunsMiddleware: false;
}

/**
 * Service token for a {@link JobMetrics} instance the introspection route
 * reads for the `jobs` section. Registered by the jobs plugin or a custom
 * extension; when absent, the `jobs` section reports `unavailable`.
 */
export const jobMetricsToken: ServiceToken<JobMetrics> =
  createServiceToken<JobMetrics>('job-metrics');

/**
 * Service token for a {@link FailedJobStore} instance the introspection route
 * reads for the `jobs` section. Registered together with
 * {@link jobMetricsToken}; when either is absent the section reports
 * `unavailable`.
 */
export const failedJobStoreToken: ServiceToken<FailedJobStore> =
  createServiceToken<FailedJobStore>('failed-job-store');

/** Inputs the factory needs; all are optional because their sources may be absent. */
export interface BuiltinIntrospectProviderInput {
  /** Route manifest from `discoverRoutes`. Omitted means routes are unavailable. */
  readonly manifest?: RouteManifest;
  /** The plugin graph's nodes, in setup order. Omitted means plugins are unavailable. */
  readonly plugins?: readonly PluginGraphNode[];
  /**
   * Server-components runtime resolved from the extension system. When absent
   * the components section reports `unavailable`.
   */
  readonly componentsRuntime?: ServerComponentsRuntime;
  /**
   * Diagnostics service from the extension registry. When absent the
   * diagnostics section reports `unavailable`.
   */
  readonly diagnosticsService?: Diagnostics;
  /**
   * Job metrics collector for per-job counts and durations. When absent the
   * jobs section reports `unavailable` (both metrics and failed store must be
   * present for the section to be available).
   */
  readonly jobMetrics?: JobMetrics;
  /**
   * Failed-job store for the most recent failures. The provider strips the
   * `data` (payload) field from every entry before serializing.
   */
  readonly failedJobStore?: FailedJobStore;
  /**
   * I18n service from the extension registry. When absent the i18n section
   * reports `unavailable`.
   */
  readonly i18nService?: I18nService;
  /**
   * Redacted application config projection for the `config` section. When
   * absent the section reports `unavailable`. Carries booleans for callbacks
   * and directory basenames only — never absolute paths, secrets, or
   * callback identities.
   */
  readonly appConfig?: AppConfigIntrospectInput;
}

/**
 * Build every recognized built-in provider (routes, plugins, components,
 * health, diagnostics, jobs). Each provider is self-contained and returns
 * its data synchronously or from already-available references; the live
 * sections (diagnostics, jobs) open no connection and call no factory at
 * construction time.
 */
export function createBuiltinIntrospectProviders(
  input: BuiltinIntrospectProviderInput,
): readonly IntrospectProvider[] {
  return [
    routesProvider(input.manifest),
    pluginsProvider(input.plugins),
    componentsProvider(input.componentsRuntime),
    pipelineProvider(),
    configProvider(input.appConfig),
    healthProvider(),
    diagnosticsProvider(input.diagnosticsService),
    jobsProvider(input.jobMetrics, input.failedJobStore),
    i18nProvider(input.i18nService),
  ];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function routesProvider(manifest?: RouteManifest): IntrospectProvider {
  return {
    section: 'routes',
    collect(): JsonValue {
      if (manifest === undefined) {
        return { status: 'unavailable' };
      }
      return {
        status: 'ok',
        data: manifest.entries.map((entry) => ({
          kind: entry.kind,
          route: entry.route,
          dynamic: entry.dynamic,
          catchAll: entry.catchAll,
          params: [...entry.params],
          // Observability without leaking absolute paths.
          layoutCount: entry.layouts?.length ?? 0,
          // `file` and `layouts` are deliberately omitted — they leak the
          // filesystem layout.
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

function pluginsProvider(plugins?: readonly PluginGraphNode[]): IntrospectProvider {
  return {
    section: 'plugins',
    collect(): JsonValue {
      if (plugins === undefined) {
        return { status: 'unavailable' };
      }
      return {
        status: 'ok',
        data: { graph: plugins.map(({ name, origin }) => ({ name, origin })) },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function componentsProvider(runtime?: ServerComponentsRuntime): IntrospectProvider {
  return {
    section: 'components',
    collect(): JsonValue {
      if (runtime === undefined) {
        return { status: 'unavailable' };
      }
      try {
        const desc = runtime.describe();
        return { status: 'ok', data: [...desc.components] } as unknown as JsonValue;
      } catch {
        return {
          status: 'error',
          error: { code: 'components_error', message: 'Failed to describe components' },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function healthProvider(): IntrospectProvider {
  return {
    section: 'health',
    collect(): JsonValue {
      return {
        status: 'ok',
        data: {
          status: 'ok',
          uptimeMs: Math.floor(process.uptime() * 1000),
          nodeVersion: process.version,
          pid: process.pid,
          // No env, no config values, no paths, no secrets.
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function diagnosticsProvider(service?: Diagnostics): IntrospectProvider {
  return {
    section: 'diagnostics',
    collect(): JsonValue {
      if (service === undefined) {
        return { status: 'unavailable' };
      }
      try {
        // stats() returns aggregate counts and durations only — never raw
        // entries, which can carry request-derived metadata.
        const stats = service.stats();
        return { status: 'ok', data: stats as unknown as JsonValue };
      } catch {
        return {
          status: 'error',
          error: { code: 'diagnostics_error', message: 'Failed to read diagnostics stats' },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Job introspection data: per-job metrics (counts + durations) and the most
 * recent failed-job entries with payloads stripped. Never includes raw job
 * data or stack traces.
 */
interface JobsIntrospectData {
  metrics: Readonly<Record<string, unknown>>;
  failed: Array<{
    id: string;
    name: string;
    failedAt: number;
    attempts: number;
    error: string;
  }>;
}

function jobsProvider(metrics?: JobMetrics, failedStore?: FailedJobStore): IntrospectProvider {
  return {
    section: 'jobs',
    collect(): JsonValue {
      if (metrics === undefined || failedStore === undefined) {
        return { status: 'unavailable' };
      }
      try {
        const snapshot = metrics.snapshot();
        const failed = failedStore.list();

        // Strip the `data` (payload) field from every failed entry — job
        // payloads can carry user data and must never leak through
        // introspection.
        const safeFailed = failed.map((entry: FailedJobEntry) => ({
          id: entry.id,
          name: entry.name,
          failedAt: entry.failedAt.getTime(),
          attempts: entry.attempts,
          error: entry.error,
        }));

        const data: JobsIntrospectData = {
          metrics: snapshot,
          failed: safeFailed,
        };
        return { status: 'ok', data } as unknown as JsonValue;
      } catch {
        return {
          status: 'error',
          error: { code: 'jobs_error', message: 'Failed to read job metrics' },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * The pipeline provider is always available — the stage ordering is fixed.
 * Unlike the live sections (migrations, diagnostics, jobs) there is no
 * external dependency that can be absent.
 */
function pipelineProvider(): IntrospectProvider {
  return {
    section: 'pipeline',
    collect(): JsonValue {
      const data: PipelineSectionData = {
        stages: PIPELINE_STAGES,
        // Static export assembles no middleware chain and runs none.
        staticExportRunsMiddleware: false,
      };
      return { status: 'ok', data } as unknown as JsonValue;
    },
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The config provider returns a redacted projection of the resolved
 * application configuration. It carries booleans for callbacks (so an
 * agent knows whether `authorize`, `resolveSession`, `setup`, `renderer`,
 * or `broadcast` is configured) and directory basenames only (so the
 * agent sees the layout without absolute filesystem paths). Secrets,
 * the raw config-module string, and callback identities are never included.
 */
function configProvider(appConfig?: AppConfigIntrospectInput): IntrospectProvider {
  return {
    section: 'config',
    collect(): JsonValue {
      if (appConfig === undefined) {
        return { status: 'unavailable' };
      }
      return { status: 'ok', data: appConfig as unknown as JsonValue };
    },
  };
}

// ---------------------------------------------------------------------------
// I18n
// ---------------------------------------------------------------------------

/**
 * Data returned by the i18n section: locale metadata and available catalogs.
 * Locale strings only — never translation content, messages, or config paths.
 */
interface I18nIntrospectData {
  activeLocale: string;
  fallbackLocale: string;
  availableLocales: readonly string[];
}

function i18nProvider(service?: I18nService): IntrospectProvider {
  return {
    section: 'i18n',
    async collect(): Promise<JsonValue> {
      if (service === undefined) {
        return { status: 'unavailable' };
      }
      try {
        const availableLocales = service.availableLocales();
        const data: I18nIntrospectData = {
          activeLocale: service.locale(),
          fallbackLocale: service.fallbackLocale(),
          availableLocales,
        };
        return { status: 'ok', data } as unknown as JsonValue;
      } catch {
        return {
          status: 'error',
          error: { code: 'i18n_error', message: 'Failed to read i18n metadata' },
        };
      }
    },
  };
}
