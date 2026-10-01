/**
 * Config schema and type surface for the JSails application runtime.
 *
 * This module owns the shape contract only: the Zod schema that rejects unknown
 * keys and mistyped fields up front, and the option/resolved types that
 * {@link loadAppConfig}/{@link validateAppConfig} produce. The default
 * constants live in `defaults.ts` and the value-free `AppConfigError` in
 * `errors.ts`, both free of Zod. Callbacks
 * (`authorize`/`resolveSession`/`setup`/`onError`/`errorPage`), `readiness`,
 * `systemChecks`, `commands`, `extensions`, and `renderer` are marked opaque
 * here and validated by hand in `load.ts` so their error messages stay value-free.
 */

import { z } from 'zod';

import type { CliCommand } from '../../cli/command-registry.js';
import type { JsailsExtension } from '../../extensions/extension.js';
import { PLUGIN_ID_PATTERN } from '../../plugins/manifest/index.js';
import type { PageRenderer } from '../../contracts/render.js';
import type { IntrospectSection } from '../../introspect/sections.js';
import type { PluginStateSource } from '../../plugins/state-store.js';
import type { RouteMiddleware, RouteMiddlewareRef } from '../../routing/middleware.js';
import type { Authorize, ResolveSession } from '../../contracts/http.js';
import type { PageMetadata } from '../../seo/metadata.js';
import type { RobotsOptions } from '../../seo/robots.js';
import type { Awaitable } from '../../contracts/awaitable.js';
import type { SystemCheckRegistry } from '../../database/system-checks.js';
import type { ErrorPageRenderer } from '../../server/error-pages.js';
import type { ReadinessOptions } from '../../server/readiness.js';
import type { RequestErrorHook } from '../../server/request-errors.js';
import type { HostPattern, TrustedProxies } from '../../security/request-origin.js';
import { MAX_SHUTDOWN_TIMEOUT_MS } from './defaults.js';

/**
 * Node HTTP server timeouts for `Application.serve`, in milliseconds. Each
 * unset field keeps its load-balancer-friendly default (keep-alive 65 s,
 * headers 66 s, whole request 300 s).
 */
export interface AppServerTimeouts {
  /** Idle time before a keep-alive socket closes; keep it above the proxy's idle timeout. */
  readonly keepAliveTimeoutMs?: number;
  /** Time allowed to receive the request headers; must not exceed a non-zero `requestTimeoutMs`. */
  readonly headersTimeoutMs?: number;
  /** Time allowed to receive the whole request; `0` disables it. */
  readonly requestTimeoutMs?: number;
}

/**
 * The `server` config: the public origin and hosts the app answers on, who
 * may speak for the client, and the HTTP server timeouts.
 */
export interface AppServerConfig extends AppServerTimeouts {
  /**
   * The canonical public `http(s)` origin, e.g. `https://example.com`. The
   * cross-site check compares a request's `Origin` with the origin the request
   * was addressed to, and a request for a host that is neither this origin's
   * nor one of {@link hosts} is answered 421. Required to serve outside the
   * development and test environments; absent, every host is its own origin.
   */
  readonly origin?: string;
  /**
   * Hosts the app also answers on, each its own origin: `example.org`,
   * `example.org:8443`, or `*.example.com` (exactly one label, e.g. tenant
   * subdomains). Requires {@link origin}.
   */
  readonly hosts?: readonly HostPattern[];
  /**
   * Who may speak for the client in `X-Forwarded-For`: `'none'` (the socket
   * peer is the client), `{ hops: n }` (exactly n proxies in front of the
   * app), or `{ cidrs: [...] }` (peers inside these ranges are proxies). Unset,
   * a file-loaded config takes `JSAILS_TRUSTED_PROXIES` (`none`, `hops=<n>`,
   * or a CIDR list), else `'none'`.
   */
  readonly trustedProxies?: TrustedProxies;
}

/** The resolved `server` config: every request-origin field set, timeouts as given. */
export interface ResolvedServerConfig {
  /** The canonical origin, or `undefined` when none is configured. */
  readonly origin: string | undefined;
  /** The additional host patterns; empty when none. */
  readonly hosts: readonly HostPattern[];
  /** The trusted-proxy setting; `'none'` unless configured or set by the environment. */
  readonly trustedProxies: TrustedProxies;
  /** Timeout overrides with unset fields dropped; empty keeps every default. */
  readonly timeouts: AppServerTimeouts;
}

/**
 * Page rendering settings, passed to `createApp({ render })`. `stream: true`
 * streams every page the built-in renderer serves (the shell first, each
 * suspended subtree as it resolves); a page's own `stream` export overrides
 * it, and a page with a public `cacheControl` stays buffered.
 * `streamTimeoutMs` bounds how long a streamed page's suspended subtrees may
 * take after the shell (30 seconds by default).
 */
export interface AppRenderConfig {
  /** Stream every page by default. Defaults to `false` (buffered pages). */
  readonly stream?: boolean;
  /**
   * Milliseconds suspended subtrees have after the shell; a positive integer
   * up to 2147483647, the largest delay a Node timer honours.
   */
  readonly streamTimeoutMs?: number;
}

/** Cleanup callback a `setup` callback may return. */
export type AppCleanup = () => Awaitable<void>;

/**
 * Startup hook returned to the runtime, never invoked by the loader. It may do
 * its work synchronously, return a cleanup callback, or return a promise of
 * either.
 */
export type AppSetup = () => Awaitable<void | AppCleanup>;

/**
 * A plugin specifier, optionally paired with its options. A bare string names
 * the plugin; a `[specifier, options]` tuple also carries the options passed to
 * the plugin factory. The loader resolves the specifier (a framework subpath
 * like `jsails/auth`, or an npm package) and calls the factory.
 */
export interface PluginUseDescriptor {
  /** Module specifier to import (or a `file://` URL). */
  readonly specifier: string;
  /** Options passed to the default-export factory. */
  readonly options?: Readonly<Record<string, unknown>>;
  /** Stable module id used by `requires`/`conflicts`; defaults to the specifier. */
  readonly id?: string;
  /** Whether this module is enabled. Defaults to `true` (Magento `config.php`). */
  readonly enabled?: boolean;
  /** Module ids that must be present and enabled when this module is enabled. */
  readonly requires?: readonly string[];
  /** Module ids that cannot also be enabled at the same time. */
  readonly conflicts?: readonly string[];
}

export type PluginUseEntry =
  string | readonly [string, Readonly<Record<string, unknown>>] | PluginUseDescriptor;

/**
 * Plugin system settings. `enabled` lists the plugin ids enabled out of the
 * box (each must match {@link PLUGIN_ID_PATTERN}); `use` lists plugins to load
 * as specifiers or `[specifier, options]` tuples; `downloads` gates whether
 * the admin Directory install surface may download plugin bundles; `managed`
 * switches plugin state persistence from the JSON document to the database.
 * Validated strictly (unknown keys rejected) with value-free errors; passed
 * through by identity.
 */
export interface AppPluginsConfig {
  /** Plugin ids enabled out of the box; each matches {@link PLUGIN_ID_PATTERN}. */
  readonly enabled?: readonly string[];
  /**
   * Plugins to load. Entries are specifiers, `[specifier, options]` tuples, or
   * module descriptors (`id`, `enabled`, `requires`, `conflicts`). Disabled
   * descriptors are skipped before import; dependency/conflict validation runs
   * before any import unless {@link AppPluginsConfig.force} is true. Absent
   * means no declaratively-loaded plugins.
   */
  readonly use?: readonly PluginUseEntry[];
  /** Bypass module dependency/conflict validation (Magento's `--force`). */
  readonly force?: boolean;
  /** Whether admin Directory installs may download plugin bundles. */
  readonly downloads?: boolean;
  /**
   * Persisted managed-plugin state. Required when {@link AppPluginsConfig.managed}
   * is true; the app owns the source (typically a lazy DB store).
   */
  readonly stateSource?: PluginStateSource;
  /**
   * Storage-backed plugins folder, resolved against `rootDir`. Defaults to
   * `<storageDir>/plugins`; the resolved absolute path is
   * {@link ResolvedAppConfig.pluginsDir}. It must not overlap the public, out,
   * pages, or api directories.
   */
  readonly pluginsDir?: string;
  /**
   * Whether installed-plugin state is managed in the database (`jsails_plugins`
   * table). Defaults to `false`: a non-managed deployment reads only the code
   * plugin list and never opens the database for plugins. The static export is
   * always non-managed.
   */
  readonly managed?: boolean;
  /**
   * Boot even when an enabled managed plugin fails to load (missing, an invalid
   * entry, a failed import, an ambiguous or missing active version). Defaults
   * to `false`: such a failure is a boot error naming the plugin ids and
   * value-free failure codes, because a silently missing auth or audit plugin
   * is worse than a failed deploy. When `true`, each failure is reported as a
   * process warning instead.
   */
  readonly allowLoadFailures?: boolean;
}

/**
 * Runtime introspection config: an opt-in, default-off, default-deny endpoint
 * exposing a machine-readable JSON snapshot of a running app's state. Absent
 * means the route is never registered.
 */
export interface IntrospectConfig {
  /** Whether the introspection endpoint is active. Defaults to `false` (off). */
  readonly enabled?: boolean;
  /**
   * Authorization callback required when `enabled` is `true`. Default-deny:
   * the request is allowed only when the callback resolves to exactly `true`;
   * any other value, a throw, or a rejection denies. There is no implicit
   * public default — the loader rejects `enabled: true` without `authorize`.
   */
  readonly authorize?: Authorize;
  /** Sections to make available. Defaults to the safe subset. */
  readonly sections?: readonly IntrospectSection[];
}

/** Resolved introspection config after validation and defaults are applied. */
export interface ResolvedIntrospectConfig {
  readonly enabled: true;
  readonly authorize: Authorize;
  readonly sections: readonly IntrospectSection[];
}

/**
 * SEO config: site-wide defaults applied to every page's metadata, plus the
 * build-time `robots.txt` directives. Absent means no SEO defaults and no
 * `robots.txt` emission.
 */
export interface SeoConfig {
  /** Site name, used to fill a missing `openGraph.siteName`. */
  readonly siteName?: string;
  /**
   * Canonical site origin (e.g. `https://example.com`). Used to resolve
   * relative canonical/alternate URLs and sitemap `loc` entries. Validated as
   * an absolute `http(s)` origin.
   */
  readonly origin?: string;
  /** Default metadata merged under every page's own metadata (page wins). */
  readonly defaults?: PageMetadata;
  /** Build-time `robots.txt` directives. */
  readonly robots?: RobotsOptions;
}

/** Resolved SEO config after validation. */
export interface ResolvedSeoConfig {
  readonly siteName: string | undefined;
  readonly origin: string | undefined;
  readonly defaults: PageMetadata | undefined;
  readonly robots: RobotsOptions | undefined;
}

/** Resolved i18n config after validation and path resolution. */
export interface ResolvedI18nConfig {
  readonly locale: string;
  readonly fallbackLocale: string;
  /** Supported locales for prefix routing; empty/absent disables it. */
  readonly locales?: readonly string[];
  /** The un-prefixed locale; absent means every configured locale is prefixed. */
  readonly defaultLocale?: string;
  readonly catalogs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Absolute load paths resolved from the config's `loadPaths` entries. */
  readonly loadPaths?: readonly string[];
}

/**
 * The shape an application config module default-exports. Every field is
 * optional; defaults are applied during resolution.
 */
export interface JsailsAppConfig {
  /** Project root. Defaults to `.` (the config file's directory). */
  readonly rootDir?: string;
  /** Pages directory, relative to `rootDir`. Defaults to `pages`. */
  readonly pages?: string;
  /** API directory, relative to `rootDir`. Defaults to `api`. */
  readonly api?: string;
  /** Static-assets directory, relative to `rootDir`. Defaults to `public`. */
  readonly public?: string;
  /** Build output directory, relative to `rootDir`. Defaults to `out`. */
  readonly out?: string;
  /**
   * Persistent-storage directory, relative to `rootDir`. Defaults to `storage`.
   * Created by `Application.serve` before listening; never created by build or
   * fetch. Must not equal the project root, contain the config module, or
   * overlap the public/out directories.
   */
  readonly storage?: string;
  /** Listen host. Defaults to `127.0.0.1`. */
  readonly host?: string;
  /** Listen port in `0..65535`. Defaults to `3000`; `0` requests ephemeral. */
  readonly port?: number;
  /**
   * Deployment shape: which plugins run. `'full'` (default) includes live-only
   * plugins; `'static'` excludes plugins declared `runtime: 'live'` (the static
   * closure, derived from each plugin's `describe().runtime`); `'cli'` is
   * command/job-only. Sugar over `plugins.use` — the only thing a shape switch
   * changes; the file structure is identical across shapes.
   */
  readonly shape?: 'static' | 'full' | 'cli';
  /**
   * Health endpoint path, or `false` to disable. Defaults to
   * {@link DEFAULT_HEALTH_PATH}. Served for both GET and HEAD as a plain-text
   * `200` with `Cache-Control: no-store`, independent of the default-deny API
   * pipeline. Collision with a discovered page/API route is rejected when the
   * application is assembled.
   */
  readonly healthPath?: string | false;
  /** Global API authorization callback, passed through untouched. */
  readonly authorize?: Authorize;
  /** Session resolver callback, passed through untouched. */
  readonly resolveSession?: ResolveSession;
  /** Request-body cap in bytes. Defaults to the server body-limit default. */
  readonly maxBodyBytes?: number;
  /**
   * Shutdown grace period in milliseconds. Bounds how long `Application.close`
   * waits for the HTTP/broadcast transport to stop before it destroys lingering
   * sockets owned by the created server. Defaults to
   * {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}; bounded by {@link MAX_SHUTDOWN_TIMEOUT_MS}.
   */
  readonly shutdownTimeoutMs?: number;
  /** Startup hook, passed through untouched and never invoked here. */
  readonly setup?: AppSetup;
  /**
   * Application-level CLI commands. Validated structurally (name, summary,
   * `run`) through the pure command registry and passed through by identity;
   * `run` is never invoked here. Extension-declared commands stay on their
   * extension so the two sources are never double-counted.
   */
  readonly commands?: readonly CliCommand[];
  /**
   * Extensions applied in declaration order. Validated structurally and passed
   * through by identity; their `setup` callbacks are never invoked here.
   */
  readonly extensions?: readonly JsailsExtension[];
  /**
   * Page renderer. Validated for a `render` function and passed through by
   * identity; its `render` is never invoked here.
   */
  readonly renderer?: PageRenderer;
  /**
   * Plugin system settings: which plugin ids are enabled out of the box and
   * whether the admin Directory install surface may download bundles. Validated
   * strictly (unknown keys rejected) with value-free errors and passed through
   * by identity. Absent means no plugins are enabled.
   */
  readonly plugins?: AppPluginsConfig;
  /**
   * Runtime introspection endpoint. Default-off, default-deny. When absent the
   * route is never registered. When `enabled: true` the loader requires an
   * `authorize` callback; `sections` defaults to the safe subset.
   */
  readonly introspect?: IntrospectConfig;
  /**
   * SEO defaults and build-time `robots.txt` directives. Absent means no SEO
   * defaults and no `robots.txt` emission. Validated by hand in load.ts so
   * errors stay value-free.
   */
  readonly seo?: SeoConfig;
  /**
   * Named middleware registry: handlers referenced by name from route-level
   * `middleware` exports. Every value must be a function and every key must be
   * non-empty. Validated by hand in load.ts so errors stay value-free.
   */
  readonly middleware?: Readonly<Record<string, RouteMiddleware>>;
  /**
   * Global middleware chain applied to every request before per-route handlers.
   * Each entry is either a handler function (passed through by identity) or a
   * string naming a handler registered in {@link middleware}. Validated by hand
   * in load.ts so errors stay value-free.
   */
  readonly globalMiddleware?: readonly RouteMiddlewareRef[];
  /**
   * Internationalization (i18n) config: locale defaults, fallback, and loader
   * paths. Validated by hand in load.ts so errors stay value-free.
   */
  readonly i18n?: I18nConfig;
  /**
   * Receives every unexpected request failure with its route pattern and
   * request id (for an error tracker). Omitted means the failure is logged to
   * stderr. It cannot change the response, which stays a value-free 500.
   */
  readonly onError?: RequestErrorHook;
  /**
   * Renders the HTML document for a 404 or a failed browser navigation to a
   * page path. Omitted (or throwing) means the framework's minimal page.
   */
  readonly errorPage?: ErrorPageRenderer;
  /**
   * Readiness endpoint: async probes (merged with every extension's declared
   * `readiness` probes), their timeout and cache, who may see per-check
   * results, and an optional dedicated path. Served at `<healthPath>?deep=1`
   * and at `readiness.path`; anonymous callers see only the aggregate status.
   */
  readonly readiness?: ReadinessOptions;
  /** Synchronous system checks the readiness endpoint also runs. */
  readonly systemChecks?: SystemCheckRegistry;
  /** Public origin, hosts, trusted proxies, and the HTTP server timeouts. */
  readonly server?: AppServerConfig;
  /** Page rendering settings (streaming), passed through to `createApp`. */
  readonly render?: AppRenderConfig;
}

/**
 * i18n config block: defines the default and fallback locales, plus either
 * inline catalogs or filesystem load paths (mutually exclusive).
 */
export interface I18nConfig {
  /** Default active locale. Defaults to `'en'`. */
  readonly locale?: string;
  /** Fallback locale. Defaults to `'en'`. */
  readonly fallbackLocale?: string;
  /**
   * Supported locales for locale-prefixed routing (`/fr/about`). When set, each
   * page/API route is additionally registered under `/{locale}/<route>` for
   * every locale here, and a leading locale segment sets the ambient locale.
   * `defaultLocale` (when set) matches the bare path too. Absent disables
   * prefix routing (URLs carry no locale).
   */
  readonly locales?: readonly string[];
  /**
   * The locale in `locales` whose URLs stay un-prefixed; it must equal
   * `locale`, because the bare route is served in `locale`. When absent, every
   * entry in `locales` gets a prefix alongside the bare route.
   */
  readonly defaultLocale?: string;
  /**
   * Inline message catalogs keyed by locale. For tests and demos; mutually
   * exclusive with `loadPaths`.
   */
  readonly catalogs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Filesystem load paths for locale message files. For production;
   * mutually exclusive with `catalogs`. Each path is relative to `rootDir`.
   */
  readonly loadPaths?: readonly string[];
}

/** A validated config with absolute directories and resolved defaults. */
export interface ResolvedAppConfig {
  /** Absolute path of the config module used as the resolution anchor. */
  readonly configPath: string;
  /** Absolute project root. */
  readonly rootDir: string;
  /** Absolute pages directory. */
  readonly pagesDir: string;
  /** Absolute API directory. */
  readonly apiDir: string;
  /** Absolute static-assets directory. The folder need not exist yet. */
  readonly publicDir: string;
  /** Absolute build output directory. */
  readonly outDir: string;
  /** Absolute persistent-storage directory. The folder need not exist yet. */
  readonly storageDir: string;
  /**
   * Absolute storage-backed plugins folder (`plugins.pluginsDir` resolved
   * against `rootDir`, default `<storageDir>/plugins`). Always set by
   * `validateAppConfig`; optional only so hand-built configs stay valid.
   */
  readonly pluginsDir?: string;
  /** Listen host. */
  readonly host: string;
  /** Listen port; `0` is preserved as an ephemeral-port request. */
  readonly port: number;
  /** Deployment shape; defaults to `'full'` (read as `?? 'full'`). */
  readonly shape?: 'static' | 'full' | 'cli';
  /** Health endpoint path, or `undefined` when disabled. */
  readonly healthPath: string | undefined;
  /** The authorization callback, passed through and never invoked. */
  readonly authorize: Authorize | undefined;
  /** The session resolver, passed through and never invoked. */
  readonly resolveSession: ResolveSession | undefined;
  /** Request-body cap in bytes. */
  readonly maxBodyBytes: number;
  /** Shutdown grace period in milliseconds. */
  readonly shutdownTimeoutMs: number;
  /** The setup hook, passed through and never invoked. */
  readonly setup: AppSetup | undefined;
  /**
   * Application-level CLI commands, passed through by identity and defaulted to
   * an empty list. Extension-declared commands are not flattened here; they stay
   * on {@link ResolvedAppConfig.extensions} so `collectConfigCommands` sees each
   * command exactly once.
   */
  readonly commands: readonly CliCommand[];
  /** Extensions in declaration order; the same list instance passed in. */
  readonly extensions: readonly JsailsExtension[];
  /** The page renderer, passed through by identity, when configured. */
  readonly renderer: PageRenderer | undefined;
  /**
   * Plugin settings, passed through by identity. Absent when the config omitted
   * `plugins`; otherwise `enabled` defaults to `[]` (no plugins enabled) and
   * `downloads`/`managed` are `undefined` when unset (an unset `managed` means
   * non-managed, the default).
   */
  readonly plugins: AppPluginsConfig | undefined;
  /**
   * Introspection config, passed through by identity. Absent when the config
   * omitted `introspect` or when its `enabled` is not `true` (fail closed).
   */
  readonly introspect?: ResolvedIntrospectConfig;
  /**
   * Resolved SEO config. Absent when the config omitted `seo`. The
   * `siteName`/`origin`/`defaults` subset is what reaches every page request
   * context as `RequestContext.seo`; `robots` is consumed by the static
   * exporter only.
   */
  readonly seo?: ResolvedSeoConfig;
  /**
   * Named middleware registry, passed through by identity. Absent when the
   * config omitted `middleware`; every value is a function with a non-empty
   * key (validated during resolution).
   */
  readonly middleware?: Readonly<Record<string, RouteMiddleware>>;
  /**
   * Global middleware chain, passed through by identity. Absent when the config
   * omitted `globalMiddleware`; every entry is a function or a non-empty
   * string (validated during resolution).
   */
  readonly globalMiddleware?: readonly RouteMiddlewareRef[];
  /**
   * Resolved i18n config. Absent when the config omitted `i18n`.
   */
  readonly i18n?: ResolvedI18nConfig;
  /** The request-error hook, passed through by identity and never invoked here. */
  readonly onError?: RequestErrorHook;
  /** The error-page renderer, passed through by identity and never invoked here. */
  readonly errorPage?: ErrorPageRenderer;
  /** Readiness options, validated and passed through by identity. */
  readonly readiness?: ReadinessOptions;
  /** The system-check registry, passed through by identity and never run here. */
  readonly systemChecks?: SystemCheckRegistry;
  /** The resolved `server` config: origin, hosts, trusted proxies, and timeouts. */
  readonly server: ResolvedServerConfig;
  /** Page rendering settings with unset fields dropped; absent keeps every default. */
  readonly render?: AppRenderConfig;
}

/** Options for {@link loadAppConfig}. */
export interface AppConfigLoadOptions {
  /** Working directory a relative config path is resolved against. */
  readonly cwd?: string;
  /** Environment read for the listen overrides. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Options for {@link validateAppConfig}. */
export interface AppConfigValidationOptions {
  /** Config path anchoring `rootDir`; defaults to `<cwd>/jsails.app.js`. */
  readonly configPath?: string;
  /** Working directory a relative `configPath` is resolved against. */
  readonly cwd?: string;
}

/**
 * Top-level shape check. Unknown keys are rejected (`.strict()`); callbacks and
 * broadcast are opaque here and validated by hand so their error messages stay
 * value-free.
 */
export const appConfigSchema: z.ZodObject<
  {
    rootDir: z.ZodOptional<z.ZodString>;
    pages: z.ZodOptional<z.ZodString>;
    api: z.ZodOptional<z.ZodString>;
    public: z.ZodOptional<z.ZodString>;
    out: z.ZodOptional<z.ZodString>;
    storage: z.ZodOptional<z.ZodString>;
    host: z.ZodOptional<z.ZodString>;
    port: z.ZodOptional<z.ZodNumber>;
    shape: z.ZodOptional<
      z.ZodEnum<{
        cli: 'cli';
        full: 'full';
        static: 'static';
      }>
    >;
    healthPath: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<false>, z.ZodString]>>;
    authorize: z.ZodOptional<z.ZodUnknown>;
    resolveSession: z.ZodOptional<z.ZodUnknown>;
    maxBodyBytes: z.ZodOptional<z.ZodNumber>;
    shutdownTimeoutMs: z.ZodOptional<z.ZodNumber>;
    setup: z.ZodOptional<z.ZodUnknown>;
    commands: z.ZodOptional<z.ZodUnknown>;
    extensions: z.ZodOptional<z.ZodUnknown>;
    renderer: z.ZodOptional<z.ZodUnknown>;
    introspect: z.ZodOptional<
      z.ZodObject<
        {
          enabled: z.ZodOptional<z.ZodBoolean>;
          authorize: z.ZodOptional<z.ZodUnknown>;
          sections: z.ZodOptional<
            z.ZodArray<
              z.ZodEnum<{
                components: 'components';
                config: 'config';
                diagnostics: 'diagnostics';
                health: 'health';
                i18n: 'i18n';
                jobs: 'jobs';
                pipeline: 'pipeline';
                plugins: 'plugins';
                routes: 'routes';
              }>
            >
          >;
        },
        z.core.$strict
      >
    >;
    plugins: z.ZodOptional<
      z.ZodObject<
        {
          enabled: z.ZodOptional<z.ZodArray<z.ZodString>>;
          use: z.ZodOptional<
            z.ZodArray<
              z.ZodUnion<
                readonly [
                  z.ZodString,
                  z.ZodTuple<[z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>], null>,
                  z.ZodObject<
                    {
                      specifier: z.ZodString;
                      options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                      id: z.ZodOptional<z.ZodString>;
                      enabled: z.ZodOptional<z.ZodBoolean>;
                      requires: z.ZodOptional<z.ZodArray<z.ZodString>>;
                      conflicts: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    },
                    z.core.$strict
                  >,
                ]
              >
            >
          >;
          downloads: z.ZodOptional<z.ZodBoolean>;
          stateSource: z.ZodOptional<z.ZodUnknown>;
          pluginsDir: z.ZodOptional<z.ZodString>;
          managed: z.ZodOptional<z.ZodBoolean>;
          allowLoadFailures: z.ZodOptional<z.ZodBoolean>;
          force: z.ZodOptional<z.ZodBoolean>;
        },
        z.core.$strict
      >
    >;
    middleware: z.ZodOptional<z.ZodUnknown>;
    globalMiddleware: z.ZodOptional<z.ZodUnknown>;
    seo: z.ZodOptional<
      z.ZodObject<
        {
          siteName: z.ZodOptional<z.ZodString>;
          origin: z.ZodOptional<z.ZodString>;
          defaults: z.ZodOptional<z.ZodUnknown>;
          robots: z.ZodOptional<z.ZodUnknown>;
        },
        z.core.$strict
      >
    >;
    i18n: z.ZodOptional<
      z.ZodObject<
        {
          locale: z.ZodOptional<z.ZodString>;
          fallbackLocale: z.ZodOptional<z.ZodString>;
          locales: z.ZodOptional<z.ZodArray<z.ZodString>>;
          defaultLocale: z.ZodOptional<z.ZodString>;
          catalogs: z.ZodOptional<z.ZodUnknown>;
          loadPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
        },
        z.core.$strict
      >
    >;
    onError: z.ZodOptional<z.ZodUnknown>;
    errorPage: z.ZodOptional<z.ZodUnknown>;
    readiness: z.ZodOptional<z.ZodUnknown>;
    systemChecks: z.ZodOptional<z.ZodUnknown>;
    server: z.ZodOptional<
      z.ZodObject<
        {
          keepAliveTimeoutMs: z.ZodOptional<z.ZodNumber>;
          headersTimeoutMs: z.ZodOptional<z.ZodNumber>;
          requestTimeoutMs: z.ZodOptional<z.ZodNumber>;
          origin: z.ZodOptional<z.ZodString>;
          hosts: z.ZodOptional<z.ZodArray<z.ZodString>>;
          trustedProxies: z.ZodOptional<z.ZodUnknown>;
        },
        z.core.$strict
      >
    >;
    render: z.ZodOptional<
      z.ZodObject<
        {
          stream: z.ZodOptional<z.ZodBoolean>;
          streamTimeoutMs: z.ZodOptional<z.ZodNumber>;
        },
        z.core.$strict
      >
    >;
  },
  z.core.$strict
> = z
  .object({
    rootDir: z.string().min(1).optional(),
    pages: z.string().min(1).optional(),
    api: z.string().min(1).optional(),
    public: z.string().min(1).optional(),
    out: z.string().min(1).optional(),
    storage: z.string().min(1).optional(),
    host: z.string().optional(),
    port: z.number().int().min(0).max(65535).optional(),
    shape: z.enum(['static', 'full', 'cli']).optional(),
    healthPath: z.union([z.literal(false), z.string().min(1)]).optional(),
    authorize: z.unknown().optional(),
    resolveSession: z.unknown().optional(),
    maxBodyBytes: z.number().int().positive().optional(),
    shutdownTimeoutMs: z.number().int().positive().max(MAX_SHUTDOWN_TIMEOUT_MS).optional(),
    setup: z.unknown().optional(),
    commands: z.unknown().optional(),
    extensions: z.unknown().optional(),
    renderer: z.unknown().optional(),
    introspect: z
      .object({
        enabled: z.boolean().optional(),
        authorize: z.unknown().optional(),
        sections: z
          .array(
            z.enum([
              'routes',
              'plugins',
              'components',
              'pipeline',
              'config',
              'diagnostics',
              'jobs',
              'i18n',
              'health',
            ]),
          )
          .optional(),
      })
      .strict()
      .optional(),
    plugins: z
      .object({
        enabled: z.array(z.string().regex(PLUGIN_ID_PATTERN)).optional(),
        // Each entry is a non-empty string specifier or a 2-element
        // [specifier, options] tuple. The second element of a tuple must be a
        // plain object (z.record rejects arrays and null). Extra tuple elements
        // and wrong arity are rejected by the tuple constraint.
        use: z
          .array(
            z.union([
              z.string().min(1),
              z.tuple([z.string().min(1), z.record(z.string(), z.unknown())]),
              z
                .object({
                  specifier: z.string().min(1),
                  options: z.record(z.string(), z.unknown()).optional(),
                  id: z.string().regex(PLUGIN_ID_PATTERN).optional(),
                  enabled: z.boolean().optional(),
                  requires: z.array(z.string().regex(PLUGIN_ID_PATTERN)).optional(),
                  conflicts: z.array(z.string().regex(PLUGIN_ID_PATTERN)).optional(),
                })
                .strict(),
            ]),
          )
          .optional(),
        downloads: z.boolean().optional(),
        stateSource: z.unknown().optional(),
        pluginsDir: z.string().min(1).optional(),
        managed: z.boolean().optional(),
        allowLoadFailures: z.boolean().optional(),
        force: z.boolean().optional(),
      })
      .strict()
      .optional(),
    middleware: z.unknown().optional(),
    globalMiddleware: z.unknown().optional(),
    seo: z
      .object({
        siteName: z.string().min(1).optional(),
        origin: z.string().min(1).optional(),
        defaults: z.unknown().optional(),
        robots: z.unknown().optional(),
      })
      .strict()
      .optional(),
    i18n: z
      .object({
        locale: z.string().min(1).optional(),
        fallbackLocale: z.string().min(1).optional(),
        locales: z.array(z.string().min(1)).optional(),
        defaultLocale: z.string().min(1).optional(),
        catalogs: z.unknown().optional(),
        loadPaths: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    onError: z.unknown().optional(),
    errorPage: z.unknown().optional(),
    readiness: z.unknown().optional(),
    systemChecks: z.unknown().optional(),
    server: z
      .object({
        keepAliveTimeoutMs: z.number().int().positive().optional(),
        headersTimeoutMs: z.number().int().positive().optional(),
        requestTimeoutMs: z.number().int().nonnegative().optional(),
        // Validated by hand (createOriginPolicy) so errors stay value-free.
        origin: z.string().optional(),
        hosts: z.array(z.string()).optional(),
        trustedProxies: z.unknown().optional(),
      })
      .strict()
      .optional(),
    render: z
      .object({
        stream: z.boolean().optional(),
        streamTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
