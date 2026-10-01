/**
 * The compat mapper: the one module that accepts the app config's legacy keys.
 *
 * A legacy key is one the kernel's {@link AppConfig} no longer has, kept only
 * until the package that provides its replacement removes it.
 * {@link LEGACY_CONFIG_SURFACES} lists every such key, with the replacement
 * it names. The `legacy-config` gate holds that list equal to its ledger
 * (`scripts/expected-failures/legacy-config.json`, which names the removing
 * package of each entry and only shrinks), so a key cannot become legacy
 * without review, and a removed key cannot stay listed.
 *
 * {@link splitLegacyConfig} splits a raw config into its kept keys (for the
 * typed schema) and its legacy keys. It refuses an option that has already
 * been removed (`config.removed_option`, which names the replacement).
 * {@link resolveLegacyConfig} validates and resolves the legacy keys. It
 * reads values and returns callbacks, extensions and renderers by identity;
 * it never invokes one. Its errors are value-free
 * `AppConfigError`s: no input value and no unknown key name appears in a
 * message.
 */

import { z } from 'zod';

import type { Authorize, ResolveSession } from '../../contracts/http.js';
import type { PageRenderer } from '../../contracts/render.js';
import type { SystemCheckRegistry } from '../../database/system-checks.js';
import type { ExtensionEntry } from '../../extensions/extension.js';
import { validateExtensionEntries, type ExtensionEntryError } from '../../extensions/validation.js';
import type { IntrospectSection } from '../../introspect/sections.js';
import { ConfigErrors } from '../../plugins/contract/errors.js';
import { isPluginInstance } from '../../plugins/contract/instance.js';
import { assertOrigin } from '../../seo/origin.js';
import { defineMetadata, type PageMetadata } from '../../seo/metadata.js';
import type { RobotsOptions } from '../../seo/robots.js';
import type { ErrorPageRenderer } from '../../server/error-pages.js';
import { resolveReadiness, type ReadinessOptions } from '../../server/readiness.js';
import type { RequestErrorHook } from '../../server/request-errors.js';
import type { IdentitySource } from '../../server/request-frame.js';
import { mapZodIssues, type ZodIssueEntry } from '../../validation/zod-issues.js';
import type { Awaitable } from '../../contracts/awaitable.js';
import { AppConfigError } from './errors.js';
import type { AppCleanup } from './schema.js';

/** One legacy config surface: the key path (or the legacy config root) and its replacement. */
export interface LegacyConfigSurface {
  /** A top-level key (`extensions`), a `plugins.` key, or the legacy root file. */
  readonly key: string;
  /** What replaces it, for the docs and the ledger. */
  readonly replacement: string;
}

/** The legacy config root, accepted by the loader beside `jsails.config.ts`. */
export const LEGACY_CONFIG_ROOT = 'jsails.app.js';

/** The `plugins.use` entry forms the mapper still accepts: a specifier, or a `[specifier, options]` tuple. */
const LEGACY_USE_SURFACE = 'plugins.use specifiers';

/**
 * Every legacy surface, in a stable order. The `legacy-config` gate compares
 * this list with its ledger.
 */
export const LEGACY_CONFIG_SURFACES: readonly LegacyConfigSurface[] = Object.freeze([
  { key: LEGACY_CONFIG_ROOT, replacement: 'jsails.config.ts with defineApp' },
  { key: 'pages', replacement: 'routes listed in the AppManifest' },
  { key: 'api', replacement: 'routes listed in the AppManifest' },
  { key: 'public', replacement: 'the build pipeline asset directory' },
  { key: 'out', replacement: 'the build pipeline export directory' },
  { key: 'shape', replacement: 'the roles a process runs (web, worker, export)' },
  { key: 'resolveSession', replacement: 'an authenticator providing the actor' },
  { key: 'identity', replacement: 'an authenticator providing the actor' },
  { key: 'setup', replacement: 'the setup of a definePlugin instance in plugins.use' },
  { key: 'extensions', replacement: 'definePlugin instances in plugins.use' },
  { key: 'renderer', replacement: 'the typed page outcome' },
  { key: 'introspect', replacement: 'the introspection plugin' },
  { key: 'seo', replacement: 'the seo plugin' },
  { key: 'i18n', replacement: 'the i18n plugin instance in plugins.use' },
  { key: 'onError', replacement: 'the app/error hook module' },
  { key: 'errorPage', replacement: 'the pages/_error hook module' },
  { key: 'readiness', replacement: 'readiness checks contributed by plugins' },
  { key: 'systemChecks', replacement: 'readiness checks contributed by plugins' },
  { key: LEGACY_USE_SURFACE, replacement: 'definePlugin instances in plugins.use' },
]);

/** The legacy top-level keys, derived from {@link LEGACY_CONFIG_SURFACES}. */
const LEGACY_KEYS: ReadonlySet<string> = new Set(
  LEGACY_CONFIG_SURFACES.map((surface) => surface.key).filter(
    (key) => key !== LEGACY_CONFIG_ROOT && !key.includes('.') && !key.includes(' '),
  ),
);

/**
 * A legacy `plugins.use` entry: a module specifier whose default export is a
 * plugin factory, or a `[specifier, options]` tuple passing the options to it.
 */
export type LegacyPluginUseEntry = string | readonly [string, Readonly<Record<string, unknown>>];

/**
 * Startup hook returned to the runtime, never invoked by the loader. It may do
 * its work synchronously, return a cleanup callback, or return a promise of
 * either.
 */
export type AppSetup = () => Awaitable<void | AppCleanup>;

/**
 * Runtime introspection config: an opt-in endpoint, off by default and
 * deny-by-default, exposing a machine-readable JSON snapshot of a running
 * app's state. Absent means the route is never registered.
 */
export interface IntrospectConfig {
  /** Whether the introspection endpoint is active. Defaults to `false` (off). */
  readonly enabled?: boolean;
  /**
   * Authorization callback, required when `enabled` is `true`. The request is
   * allowed only when the callback resolves to exactly `true`; any other
   * value, a throw, or a rejection denies.
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
   * Canonical site origin (e.g. `https://example.com`), validated as an
   * absolute `http(s)` origin. Relative canonical and alternate URLs and
   * sitemap `loc` entries resolve against it.
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

/**
 * i18n config block: the default and fallback locales, plus either inline
 * catalogs or filesystem load paths (mutually exclusive).
 */
export interface I18nConfig {
  /** Default active locale. Defaults to `'en'`. */
  readonly locale?: string;
  /** Fallback locale. Defaults to `'en'`. */
  readonly fallbackLocale?: string;
  /**
   * Supported locales for locale-prefixed routing (`/fr/about`). When set,
   * every page and API route is also registered under `/{locale}/<route>`
   * for each locale here, and a leading locale segment sets the ambient
   * locale. Absent disables prefix routing.
   */
  readonly locales?: readonly string[];
  /**
   * The locale in `locales` whose URLs stay un-prefixed. It must equal
   * `locale`, because the bare route is served in `locale`.
   */
  readonly defaultLocale?: string;
  /** Inline message catalogs keyed by locale; mutually exclusive with `loadPaths`. */
  readonly catalogs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Locale message file paths, relative to `rootDir`; mutually exclusive with `catalogs`. */
  readonly loadPaths?: readonly string[];
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
  /** The configured `loadPaths` entries, relative to `rootDir`. */
  readonly loadPaths?: readonly string[];
}

/**
 * The legacy keys a config may still state, each listed in
 * {@link LEGACY_CONFIG_SURFACES} with its replacement. Each key is
 * deprecated and is removed by the package its ledger entry names.
 *
 * @public
 */
export interface LegacyAppConfig {
  /** Pages directory, relative to `rootDir`. Defaults to `pages`. */
  readonly pages?: string;
  /** API directory, relative to `rootDir`. Defaults to `api`. */
  readonly api?: string;
  /** Static-assets directory, relative to `rootDir`. Defaults to `public`. */
  readonly public?: string;
  /** Build output directory, relative to `rootDir`. Defaults to `out`. */
  readonly out?: string;
  /**
   * Which plugins run: `'full'` (default), `'static'` (live-only plugins
   * dropped), or `'cli'`.
   */
  readonly shape?: 'static' | 'full' | 'cli';
  /** Session resolver callback; mutually exclusive with `identity`. */
  readonly resolveSession?: ResolveSession;
  /** The identity source; mutually exclusive with `resolveSession`. */
  readonly identity?: IdentitySource;
  /** Startup hook, run after every plugin's setup. */
  readonly setup?: AppSetup;
  /** Extensions and plugin instances, applied in dependency order after `plugins.use`. */
  readonly extensions?: readonly ExtensionEntry[];
  /** Page renderer replacing the default one. */
  readonly renderer?: PageRenderer;
  /** Runtime introspection endpoint. */
  readonly introspect?: IntrospectConfig;
  /** SEO defaults and build-time `robots.txt` directives. */
  readonly seo?: SeoConfig;
  /** Locale defaults, fallback, and catalog loading. */
  readonly i18n?: I18nConfig;
  /** Receives every unexpected request failure (for an error tracker). */
  readonly onError?: RequestErrorHook;
  /** Renders the HTML document for a 404 or a failed page navigation. */
  readonly errorPage?: ErrorPageRenderer;
  /** Readiness endpoint probes, timeout, cache and visibility. */
  readonly readiness?: ReadinessOptions;
  /** Synchronous system checks the readiness endpoint also runs. */
  readonly systemChecks?: SystemCheckRegistry;
}

/** What the legacy keys resolve to on a resolved app config. */
export interface ResolvedLegacyAppConfig {
  /** Absolute pages directory. */
  readonly pagesDir: string;
  /** Absolute API directory. */
  readonly apiDir: string;
  /** Absolute static-assets directory. The folder need not exist yet. */
  readonly publicDir: string;
  /** Absolute build output directory. */
  readonly outDir: string;
  /** Deployment shape; read as `?? 'full'`. */
  readonly shape?: 'static' | 'full' | 'cli';
  /** The session resolver, passed through and never invoked. */
  readonly resolveSession: ResolveSession | undefined;
  /** The identity source, validated by shape and never invoked. */
  readonly identity: IdentitySource | undefined;
  /** The setup hook, passed through and never invoked. */
  readonly setup: AppSetup | undefined;
  /** Extensions in declaration order; the same list instance passed in. */
  readonly extensions: readonly ExtensionEntry[];
  /** The page renderer, passed through by identity, when configured. */
  readonly renderer: PageRenderer | undefined;
  /** Introspection config; absent when omitted or not enabled (fail closed). */
  readonly introspect?: ResolvedIntrospectConfig;
  /** Resolved SEO config; absent when omitted. */
  readonly seo?: ResolvedSeoConfig;
  /** Resolved i18n config; absent when omitted. */
  readonly i18n?: ResolvedI18nConfig;
  /** The request-error hook, passed through by identity and never invoked here. */
  readonly onError?: RequestErrorHook;
  /** The error-page renderer, passed through by identity and never invoked here. */
  readonly errorPage?: ErrorPageRenderer;
  /** Readiness options, validated and passed through by identity. */
  readonly readiness?: ReadinessOptions;
  /** The system-check registry, passed through by identity and never run here. */
  readonly systemChecks?: SystemCheckRegistry;
}

/** The two halves of a raw config, and the order of its `plugins.use` entries. */
export interface SplitConfig {
  /** The kept keys, for the typed schema; `plugins.use` holds its plugin instances only. */
  readonly kept: Readonly<Record<string, unknown>>;
  /** The legacy keys, for {@link resolveLegacyConfig}. */
  readonly legacy: Readonly<Record<string, unknown>>;
  /** Every `plugins.use` entry in declaration order; `undefined` when the config states none. */
  readonly use: readonly unknown[] | undefined;
}

/**
 * Top-level options that have been removed, each with the replacement its
 * `config.removed_option` names. The names are the framework's own keys, so
 * the error stays value-free.
 */
const REMOVED_CONFIG_OPTIONS = {
  commands: 'a defineCommand module under commands/',
  authorize: 'the access each API module states',
  middleware: 'the middleware functions themselves in a route module middleware export',
  globalMiddleware: 'http.guards and routes.transform',
} as const;

/**
 * Split a raw config object into its kept and legacy keys. An option that has
 * been removed fails with `config.removed_option`, which names its
 * replacement. A key that is neither kept nor legacy stays with the kept keys,
 * where the strict schema rejects it without echoing its name.
 */
export function splitLegacyConfig(raw: Readonly<Record<string, unknown>>): SplitConfig {
  const kept: Record<string, unknown> = {};
  const legacy: Record<string, unknown> = {};
  let use: readonly unknown[] | undefined;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (Object.hasOwn(REMOVED_CONFIG_OPTIONS, key)) {
      const option = key as keyof typeof REMOVED_CONFIG_OPTIONS;
      throw new ConfigErrors.Error('removed_option', {
        option,
        replacement: REMOVED_CONFIG_OPTIONS[option],
      });
    }
    if (LEGACY_KEYS.has(key)) {
      legacy[key] = value;
    } else if (key === 'plugins' && isPlainRecord(value)) {
      const split = splitPlugins(value);
      kept['plugins'] = split.kept;
      if (Object.keys(split.legacy).length > 0) legacy['plugins'] = split.legacy;
      use = split.use;
    } else {
      kept[key] = value;
    }
  }
  return { kept, legacy, use };
}

/**
 * The `plugins` options that were removed, each with the context its
 * `config.removed_option` refusal names. The legacy managed bridge's options
 * (`enabled`, `downloads`, `stateSource`, `pluginsDir`, `allowLoadFailures`)
 * went with the installer and the plugin state store: a config that still
 * states one is refused rather than ignored, because accepting it would claim
 * a behaviour that no longer exists.
 */
const REMOVED_PLUGIN_OPTIONS = {
  managed: { option: 'plugins.managed', replacement: 'plugins.activation' },
  force: {
    option: 'plugins.force',
    replacement: 'the requires and provides of definePlugin instances',
  },
  enabled: { option: 'plugins.enabled', replacement: 'the marketplace plugin source' },
  downloads: { option: 'plugins.downloads', replacement: 'the marketplace plugin source' },
  stateSource: { option: 'plugins.stateSource', replacement: 'the marketplace plugin source' },
  pluginsDir: { option: 'plugins.pluginsDir', replacement: 'the marketplace plugin source' },
  allowLoadFailures: {
    option: 'plugins.allowLoadFailures',
    replacement: 'the marketplace plugin source',
  },
} as const;

type RemovedPluginOption = keyof typeof REMOVED_PLUGIN_OPTIONS;

/** Split the `plugins` block; `use` entries are partitioned by form, their order kept apart. */
function splitPlugins(plugins: Readonly<Record<string, unknown>>): {
  readonly kept: Record<string, unknown>;
  readonly legacy: Record<string, unknown>;
  readonly use: readonly unknown[] | undefined;
} {
  const kept: Record<string, unknown> = {};
  const legacy: Record<string, unknown> = {};
  let use: readonly unknown[] | undefined;
  for (const key of Object.keys(plugins)) {
    const value = plugins[key];
    const removed = Object.hasOwn(REMOVED_PLUGIN_OPTIONS, key)
      ? REMOVED_PLUGIN_OPTIONS[key as RemovedPluginOption]
      : undefined;
    if (removed !== undefined) throw new ConfigErrors.Error('removed_option', removed);
    if (key === 'use' && Array.isArray(value)) {
      const entries = value as readonly unknown[];
      for (const entry of entries) {
        if (isPlainRecord(entry) && 'specifier' in entry) {
          throw new ConfigErrors.Error('removed_option', {
            option: 'plugins.use descriptor',
            replacement: 'a definePlugin instance in plugins.use',
          });
        }
      }
      use = entries;
      kept['use'] = entries.filter((entry) => !isLegacyUseForm(entry));
      const legacyEntries = entries.filter(isLegacyUseForm);
      if (legacyEntries.length > 0) legacy['use'] = legacyEntries;
    } else {
      kept[key] = value;
    }
  }
  return { kept, legacy, use };
}

/** Whether a `plugins.use` entry has a legacy form: a string or an array (a tuple). */
function isLegacyUseForm(entry: unknown): boolean {
  return typeof entry === 'string' || (Array.isArray(entry) && !isPluginInstance(entry));
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The shape of the legacy keys. Callbacks and other opaque values are
 * `z.unknown()` here and checked by hand below, so their messages stay
 * value-free and name the key.
 */
const legacySchema = z
  .object({
    pages: z.string().min(1).optional(),
    api: z.string().min(1).optional(),
    public: z.string().min(1).optional(),
    out: z.string().min(1).optional(),
    shape: z.enum(['static', 'full', 'cli']).optional(),
    resolveSession: z.unknown().optional(),
    identity: z.unknown().optional(),
    setup: z.unknown().optional(),
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
    plugins: z
      .object({
        // A specifier, or a [specifier, options] tuple whose options are a
        // plain object (z.record rejects arrays and null).
        use: z
          .array(
            z.union([
              z.string().min(1),
              z.tuple([z.string().min(1), z.record(z.string(), z.unknown())]),
            ]),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type LegacyInput = z.infer<typeof legacySchema>;

/** The raw directory overrides the legacy keys carry, for the path resolver. */
export interface LegacyDirectories {
  readonly pages: string | undefined;
  readonly api: string | undefined;
  readonly public: string | undefined;
  readonly out: string | undefined;
}

/** The legacy keys resolved, except the directories, which the path resolver computes. */
export interface ResolvedLegacyKeys {
  readonly directories: LegacyDirectories;
  readonly values: Omit<ResolvedLegacyAppConfig, 'pagesDir' | 'apiDir' | 'publicDir' | 'outDir'>;
}

/**
 * Validate and resolve the legacy keys {@link splitLegacyConfig} returned.
 * Nothing is invoked; callbacks and objects are returned by identity.
 */
export function resolveLegacyConfig(legacy: Readonly<Record<string, unknown>>): ResolvedLegacyKeys {
  const result = legacySchema.safeParse(legacy);
  if (!result.success) {
    throw new AppConfigError(mapZodIssues(result.error).map(describeLegacyIssue).join('; '));
  }
  const config: LegacyInput = result.data;
  const resolveSession = requireFunction(config.resolveSession, 'resolveSession') as
    ResolveSession | undefined;
  const identity = resolveIdentitySource(config.identity, resolveSession);
  const setup = requireFunction(config.setup, 'setup') as AppSetup | undefined;
  const extensions = resolveExtensions(config.extensions);
  const renderer = resolveRenderer(config.renderer);
  const introspect = resolveIntrospect(legacy['introspect'] as IntrospectConfig | undefined);
  const seo = resolveSeo(legacy['seo'] as SeoConfig | undefined);
  const i18n = resolveI18n(legacy['i18n'] as I18nConfig | undefined);
  const onError = requireFunction(config.onError, 'onError') as RequestErrorHook | undefined;
  const errorPage = requireFunction(config.errorPage, 'errorPage') as ErrorPageRenderer | undefined;
  const readiness = resolveReadinessConfig(config.readiness);
  const systemChecks = resolveSystemChecks(config.systemChecks);
  return {
    directories: {
      pages: config.pages,
      api: config.api,
      public: config.public,
      out: config.out,
    },
    values: {
      shape: config.shape ?? 'full',
      resolveSession,
      identity,
      setup,
      extensions,
      renderer,
      introspect,
      seo,
      i18n,
      ...(onError === undefined ? {} : { onError }),
      ...(errorPage === undefined ? {} : { errorPage }),
      ...(readiness === undefined ? {} : { readiness }),
      ...(systemChecks === undefined ? {} : { systemChecks }),
    },
  };
}

/**
 * Prefix a mapped issue with its `config.` location. An unknown key is named
 * only by the block it is in: the key is author-provided and may be a typo
 * of a secret name.
 */
export function describeLegacyIssue(entry: ZodIssueEntry): string {
  if (entry.code === 'unknown_field') {
    const block = entry.path.slice(0, -1);
    return block.length === 0
      ? 'unrecognized config field'
      : `config.${block.join('.')}: unrecognized config field`;
  }
  const field = entry.path.length > 0 ? `config.${entry.path.join('.')}` : 'the app config';
  return `${field}: ${entry.message}`;
}

/**
 * Validate `identity`: an object with `hasCredential` and `resolve` functions,
 * never given beside `resolveSession`. Returned by identity.
 */
function resolveIdentitySource(
  value: unknown,
  resolveSession: ResolveSession | undefined,
): IdentitySource | undefined {
  if (value === undefined) return undefined;
  if (resolveSession !== undefined) {
    throw new AppConfigError('config.identity and config.resolveSession are mutually exclusive');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { hasCredential?: unknown }).hasCredential !== 'function' ||
    typeof (value as { resolve?: unknown }).resolve !== 'function'
  ) {
    throw new AppConfigError(
      'config.identity must implement hasCredential(request) and resolve(request)',
    );
  }
  return value as IdentitySource;
}

/** Return the callback unchanged, or throw when a provided value is not one. */
function requireFunction(value: unknown, name: string): unknown {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') {
    throw new AppConfigError(`config.${name} must be a function`);
  }
  return value;
}

/**
 * Validate the readiness options with the rules `createApp` applies, so a
 * bad option fails at load time; the object is passed on by identity. The
 * validator's messages name only the field, never a value.
 */
function resolveReadinessConfig(value: unknown): ReadinessOptions | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppConfigError('config.readiness must be an options object');
  }
  const options = value as ReadinessOptions;
  try {
    resolveReadiness(options);
  } catch (error) {
    if (error instanceof TypeError) throw new AppConfigError(`config.${error.message}`);
    throw error;
  }
  return options;
}

/** Validate that a system-check registry exposes `run`; returned by identity. */
function resolveSystemChecks(value: unknown): SystemCheckRegistry | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { run?: unknown }).run !== 'function'
  ) {
    throw new AppConfigError('config.systemChecks must be a system-check registry');
  }
  return value as SystemCheckRegistry;
}

/**
 * Map a shared extension-entry validation error to a value-free message under
 * the `config.extensions` prefix; an entry's name is never echoed.
 */
function describeConfigExtensionError(error: ExtensionEntryError): string {
  switch (error.code) {
    case 'not_object':
      return 'config.extensions entries must be extension objects';
    case 'invalid_name':
      return 'config.extensions entries must have an identifier name';
    case 'invalid_priority':
      return 'config.extensions entries must have a finite number priority';
    case 'invalid_disabled':
      return 'config.extensions entries must have a boolean disabled flag';
    case 'duplicate_name':
      return 'config.extensions contains duplicate names';
    case 'missing_setup':
      return 'config.extensions entries must define a setup function';
    case 'requires_not_array':
      return 'config.extensions requires must be an array of service or contract tokens';
    case 'invalid_token':
      return 'config.extensions requires an invalid service token';
    case 'provides_not_array':
      return 'config.extensions provides must be an array of contract token providers';
    case 'invalid_provides_entry':
      return 'config.extensions provides entry must have a contract token';
    case 'invalid_provides_override':
      return 'config.extensions provides entry override must be a boolean';
    case 'invalid_requires_union':
      return 'config.extensions requires an invalid token';
    case 'invalid_readiness':
      return 'config.extensions readiness must be an object of named probe functions';
    case 'duplicate_readiness_probe':
      return 'config.extensions declare the same readiness probe name twice';
  }
}

/**
 * Validate extensions structurally without cloning them (the check the
 * extension runner shares), then return the same list instance. Nothing is
 * invoked and no extension value is echoed in an error.
 */
function resolveExtensions(value: unknown): readonly ExtensionEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AppConfigError('config.extensions must be an array');
  }
  const error = validateExtensionEntries(value);
  if (error !== undefined) {
    throw new AppConfigError(describeConfigExtensionError(error));
  }
  return value as readonly ExtensionEntry[];
}

/**
 * Validate that a renderer exposes a `render` function and return the same
 * object by identity, so a class renderer keeps its own `this`.
 */
function resolveRenderer(value: unknown): PageRenderer | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new AppConfigError('config.renderer must be a renderer object');
  }
  if (typeof (value as { render?: unknown }).render !== 'function') {
    throw new AppConfigError('config.renderer must define a render function');
  }
  return value as PageRenderer;
}

/**
 * Resolve the introspection config:
 *
 * - absent → `undefined` (the route is never registered);
 * - `enabled !== true` → `undefined` (fail closed);
 * - enabled without `authorize` → an error (no public default);
 * - `sections` defaults to the safe subset.
 */
function resolveIntrospect(
  value: IntrospectConfig | undefined,
): ResolvedIntrospectConfig | undefined {
  if (value === undefined) return undefined;
  if (value.enabled !== true) return undefined;
  if (typeof value.authorize !== 'function') {
    throw new AppConfigError(
      'config.introspect.authorize is required when introspection is enabled',
    );
  }
  return {
    enabled: true,
    authorize: value.authorize,
    sections: value.sections ?? SAFE_INTROSPECT_SECTIONS,
  };
}

/** The sections available by default when `sections` is omitted. */
const SAFE_INTROSPECT_SECTIONS: readonly IntrospectSection[] = [
  'routes',
  'plugins',
  'components',
  'health',
] as const;

/**
 * Resolve the SEO config. `origin` is validated as an absolute `http(s)`
 * origin and `defaults` through `defineMetadata`, both value-free; `robots`
 * is passed through (its builder validates at emission time).
 */
function resolveSeo(value: SeoConfig | undefined): ResolvedSeoConfig | undefined {
  if (value === undefined) return undefined;
  const origin = value.origin === undefined ? undefined : assertOrigin(value.origin);
  const defaults: PageMetadata | undefined =
    value.defaults === undefined ? undefined : defineMetadata(value.defaults);
  return { siteName: value.siteName, origin, defaults, robots: value.robots };
}

/** Locale pattern, as in the catalog loader and the i18n plugin. */
const LOCALE_PATTERN = /^[A-Za-z0-9_-]+$/;

function isLocale(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && LOCALE_PATTERN.test(value);
}

/**
 * Validate and resolve the i18n block: locales match {@link LOCALE_PATTERN},
 * `catalogs` and `loadPaths` are mutually exclusive, and `defaultLocale` is
 * one of `locales` and equals `locale`. Load paths stay relative to `rootDir`.
 */
function resolveI18n(value: I18nConfig | undefined): ResolvedI18nConfig | undefined {
  if (value === undefined) return undefined;
  if (value.catalogs !== undefined && value.loadPaths !== undefined) {
    throw new AppConfigError(
      'config.i18n.catalogs and config.i18n.loadPaths are mutually exclusive',
    );
  }
  if (value.locale !== undefined && !isLocale(value.locale)) {
    throw new AppConfigError('config.i18n.locale is invalid');
  }
  if (value.fallbackLocale !== undefined && !isLocale(value.fallbackLocale)) {
    throw new AppConfigError('config.i18n.fallbackLocale is invalid');
  }
  if (value.locales !== undefined) {
    if (value.locales.length === 0) {
      throw new AppConfigError('config.i18n.locales must be a non-empty array');
    }
    const seen = new Set<string>();
    for (const locale of value.locales) {
      if (!isLocale(locale)) {
        throw new AppConfigError('config.i18n.locales contains an invalid locale');
      }
      if (seen.has(locale)) {
        throw new AppConfigError('config.i18n.locales contains a duplicate locale');
      }
      seen.add(locale);
    }
  }
  if (value.defaultLocale !== undefined) {
    if (!isLocale(value.defaultLocale)) {
      throw new AppConfigError('config.i18n.defaultLocale is invalid');
    }
    if (value.locales === undefined || !value.locales.includes(value.defaultLocale)) {
      throw new AppConfigError('config.i18n.defaultLocale must be one of config.i18n.locales');
    }
    // The bare route is served in `locale`, so a different un-prefixed locale
    // would answer its URLs in the wrong language.
    if (value.defaultLocale !== (value.locale ?? 'en')) {
      throw new AppConfigError('config.i18n.defaultLocale must equal config.i18n.locale');
    }
  }
  return {
    locale: value.locale ?? 'en',
    fallbackLocale: value.fallbackLocale ?? 'en',
    ...(value.locales !== undefined ? { locales: Object.freeze([...value.locales]) } : {}),
    ...(value.defaultLocale !== undefined ? { defaultLocale: value.defaultLocale } : {}),
    catalogs: value.catalogs,
    loadPaths: value.loadPaths,
  };
}
