/**
 * Config loading, validation, and secret redaction for the application config.
 *
 * {@link loadAppConfig} imports the compiled config module (rejecting
 * TypeScript paths up front) and {@link validateAppConfig} resolves a
 * programmatic config object into a {@link ResolvedAppConfig}. Both are inert:
 * they never create a directory, load a `.env` file, open a database/Valkey
 * connection, install a signal handler, or invoke `setup`/`authorize`/
 * `resolveSession`, an extension's `setup`, a renderer's `render`, or a CLI
 * command's `run`. Callbacks, extensions, the renderer, and command objects are
 * passed through by identity, never cloned or rebound.
 *
 * Errors are always {@link AppConfigError}s with value-free messages: invalid
 * input values, credentials embedded in a URL, and arbitrary exceptions thrown
 * by the imported module are never echoed, and `.cause` is never populated.
 * The whole resolve pass runs inside {@link sanitizeAppConfigErrors} so a
 * throwing property accessor (or any other step) surfaces as a value-free
 * {@link AppConfigError}.
 */

import { dirname } from 'node:path';

import { isTypeScriptConfig } from '../../config-modules.js';
import {
  createOriginPolicy,
  parseTrustedProxies,
  RequestOriginConfigError,
  sameTrustedProxies,
  TRUSTED_PROXIES_ENV,
  type OriginPolicy,
  type TrustedProxies,
} from '../../security/request-origin.js';
import { mapZodIssues, type ZodIssueEntry } from '../../validation/zod-issues.js';

import type { IntrospectSection } from '../../introspect/sections.js';
import { bootstrapModels } from '../../models/bootstrap.js';
import { bootstrapComponents } from '../../server-components/bootstrap.js';
import {
  CliCommandError,
  collectConfigCommands,
  createCliCommandRegistry,
  type CliCommand,
} from '../../cli/command-registry.js';
import type { JsailsExtension } from '../../extensions/extension.js';
import { validateExtensionEntries, type ExtensionEntryError } from '../../extensions/validation.js';
import type { PageRenderer } from '../../contracts/render.js';
import type { PluginStateSource } from '../../plugins/state-store.js';
import type { RouteMiddleware, RouteMiddlewareRef } from '../../routing/middleware.js';
import type { Authorize, ResolveSession } from '../../contracts/http.js';
import { assertOrigin } from '../../seo/origin.js';
import { defineMetadata, type PageMetadata } from '../../seo/metadata.js';
import type { RobotsOptions } from '../../seo/robots.js';
import type { SystemCheckRegistry } from '../../database/system-checks.js';
import { DEFAULT_MAX_BODY_BYTES } from '../../server/default-body-limit.js';
import type { ErrorPageRenderer } from '../../server/error-pages.js';
import { resolveReadiness, type ReadinessOptions } from '../../server/readiness.js';
import type { RequestErrorHook } from '../../server/request-errors.js';
import { resolveServerTimeouts } from '../server-timeouts.js';
import {
  DEFAULT_APP_CONFIG_PATH,
  DEFAULT_APP_HOST,
  DEFAULT_APP_PORT,
  APP_HOST_ENV,
  APP_PORT_ENV,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from './defaults.js';
import { AppConfigError } from './errors.js';
import {
  appConfigSchema,
  type AppConfigLoadOptions,
  type AppConfigValidationOptions,
  type AppPluginsConfig,
  type AppRenderConfig,
  type AppServerConfig,
  type AppServerTimeouts,
  type AppSetup,
  type IntrospectConfig,
  type ResolvedAppConfig,
  type ResolvedI18nConfig,
  type ResolvedIntrospectConfig,
  type ResolvedSeoConfig,
  type ResolvedServerConfig,
  type I18nConfig,
  type SeoConfig,
} from './schema.js';
import {
  assertPublicDirIsolation,
  assertPluginsDirIsolation,
  assertStorageIsolation,
  resolveConfigPath,
  resolveDirectoryPaths,
  resolveHealthPath,
} from './paths.js';
import { importFile } from '../../support/project-paths.server.js';

/**
 * Load the config module and resolve it. TypeScript paths are rejected before
 * import (compile first). Import failures surface as a generic error: the
 * module's own exception text may embed secrets and is never re-thrown or
 * attached as a cause.
 *
 * `JSAILS_HOST` and `JSAILS_PORT`, when set, override the config's listen
 * host and port. They apply only here, where a deployed or containerized app
 * starts, and never to {@link validateAppConfig}, which reads nothing but its
 * argument.
 */
export async function loadAppConfig(
  configPath?: string,
  options: AppConfigLoadOptions = {},
): Promise<ResolvedAppConfig> {
  const cwd = options.cwd ?? process.cwd();
  const requested = configPath ?? DEFAULT_APP_CONFIG_PATH;
  const absolute = resolveConfigPath(cwd, configPath);
  if (isTypeScriptConfig(absolute)) {
    throw new AppConfigError(
      `app config "${requested}" is a TypeScript module; compile it to JavaScript first ` +
        `(e.g. tsc) and point the loader at the compiled output`,
      { code: 'unsupported_config' },
    );
  }
  let module: unknown;
  try {
    module = await importFile(absolute);
  } catch {
    throw new AppConfigError(`failed to load app config "${requested}"`, { code: 'load_failed' });
  }
  // Populate the compiler-generated registries before the config is validated
  // and extensions run, so models and components are registered with zero user
  // wiring. A project with no registry is a silent no-op.
  await bootstrapModels({ rootDir: dirname(absolute) });
  await bootstrapComponents({ rootDir: dirname(absolute) });
  const defaultExport = (module as { default?: unknown }).default;
  const resolved = validateAppConfig(defaultExport, { configPath: absolute, cwd });
  const env = options.env ?? process.env;
  return applyTrustedProxiesEnv(
    applyListenOverrides(resolved, env),
    configuresTrustedProxies(defaultExport),
    env,
  );
}

/** Whether the raw config states `server.trustedProxies` itself. */
function configuresTrustedProxies(value: unknown): boolean {
  const server = (value as { server?: unknown } | null | undefined)?.server;
  return (
    server !== null &&
    typeof server === 'object' &&
    (server as { trustedProxies?: unknown }).trustedProxies !== undefined
  );
}

/**
 * Apply `JSAILS_TRUSTED_PROXIES` when the config states no
 * `server.trustedProxies`: the deploy tool knows the proxy topology, so it
 * declares it in the environment, and the same image run without a proxy
 * keeps `'none'`. A config value wins; an environment value that disagrees
 * with it is reported, never applied. Errors never echo the value.
 */
function applyTrustedProxiesEnv(
  config: ResolvedAppConfig,
  configured: boolean,
  env: NodeJS.ProcessEnv,
): ResolvedAppConfig {
  const raw = env[TRUSTED_PROXIES_ENV];
  if (raw === undefined || raw.trim() === '') return config;
  let fromEnv: TrustedProxies;
  try {
    fromEnv = parseTrustedProxies(raw);
  } catch (error) {
    if (error instanceof RequestOriginConfigError) throw new AppConfigError(error.message);
    throw error;
  }
  if (configured) {
    if (!sameTrustedProxies(fromEnv, config.server.trustedProxies)) {
      process.emitWarning(
        `jsails: ${TRUSTED_PROXIES_ENV} differs from config.server.trustedProxies; the config value is used`,
        { code: 'JSAILS_TRUSTED_PROXIES_IGNORED' },
      );
    }
    return config;
  }
  const overridden = {
    ...config,
    server: Object.freeze({ ...config.server, trustedProxies: fromEnv }),
  };
  return Object.isFrozen(config) ? Object.freeze(overridden) : overridden;
}

/** Apply `JSAILS_HOST`/`JSAILS_PORT` over a resolved config. Errors never echo the value. */
function applyListenOverrides(
  config: ResolvedAppConfig,
  env: NodeJS.ProcessEnv,
): ResolvedAppConfig {
  const host = env[APP_HOST_ENV];
  const port = env[APP_PORT_ENV];
  const hasHost = host !== undefined && host !== '';
  const hasPort = port !== undefined && port !== '';
  if (!hasHost && !hasPort) return config;
  if (hasHost && (/\s/.test(host) || host.includes('/'))) {
    throw new AppConfigError(`${APP_HOST_ENV} must be a host without whitespace or a path`);
  }
  let listenPort = config.port;
  if (hasPort) {
    listenPort = /^[0-9]{1,5}$/.test(port) ? Number(port) : -1;
    if (listenPort < 0 || listenPort > 65535) {
      throw new AppConfigError(`${APP_PORT_ENV} must be an integer from 0 to 65535`);
    }
  }
  const overridden = { ...config, host: hasHost ? host : config.host, port: listenPort };
  return Object.isFrozen(config) ? Object.freeze(overridden) : overridden;
}

/**
 * Validate a programmatic config object and resolve it. No module execution and
 * no callback invocation: directories are computed lexically and only
 * `rootDir`/`pages`/`api`/`public`/`out`/`shutdownTimeoutMs` values are read.
 * Existing paths are resolved through `realpath` solely to harden the public
 * directory isolation check; the resolved config keeps the lexical paths.
 *
 * This is the value-free read/validate boundary: the whole pass runs inside
 * {@link sanitizeAppConfigErrors}, so a property accessor (or any other step)
 * that throws an arbitrary exception surfaces as an {@link AppConfigError}
 * whose message never echoes the thrown value and whose `.cause` is never set.
 * Framework {@link AppConfigError}s are preserved verbatim.
 */
export function validateAppConfig(
  value: unknown,
  options: AppConfigValidationOptions = {},
): ResolvedAppConfig {
  return sanitizeAppConfigErrors(() => resolveAppConfig(value, options));
}

/**
 * Convert any non-{@link AppConfigError} thrown during validation into a
 * value-free {@link AppConfigError}. A framework error is re-thrown unchanged;
 * an arbitrary exception (for example a throwing property getter whose message
 * embeds a credential) is replaced without a cause.
 */
function sanitizeAppConfigErrors<T>(resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof AppConfigError) {
      throw error;
    }
    throw new AppConfigError('the app config could not be read');
  }
}

/** Resolve a validated config; callers go through {@link validateAppConfig}. */
function resolveAppConfig(value: unknown, options: AppConfigValidationOptions): ResolvedAppConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppConfigError('the app config must default-export an object');
  }
  const result = appConfigSchema.safeParse(value);
  if (!result.success) {
    throw new AppConfigError(mapZodIssues(result.error).map(describeIssue).join('; '));
  }
  const config = result.data;

  const host = resolveHost(config.host);
  const authorize = requireFunction(config.authorize, 'authorize') as Authorize | undefined;
  const resolveSession = requireFunction(config.resolveSession, 'resolveSession') as
    ResolveSession | undefined;
  const setup = requireFunction(config.setup, 'setup') as AppSetup | undefined;
  const extensions = resolveExtensions(config.extensions);
  const commands = resolveCommands(config.commands, extensions);
  const renderer = resolveRenderer(config.renderer);
  const plugins = resolvePlugins((value as { plugins?: unknown }).plugins);
  const introspect = resolveIntrospect((value as { introspect?: IntrospectConfig }).introspect);
  const seo = resolveSeo((value as { seo?: SeoConfig }).seo);
  const i18n = resolveI18n((value as { i18n?: I18nConfig }).i18n);
  const middleware = resolveMiddleware(config.middleware);
  const globalMiddleware = resolveGlobalMiddleware(config.globalMiddleware);
  const onError = requireFunction(config.onError, 'onError') as RequestErrorHook | undefined;
  const errorPage = requireFunction(config.errorPage, 'errorPage') as ErrorPageRenderer | undefined;
  const readiness = resolveReadinessConfig(config.readiness);
  const systemChecks = resolveSystemChecks(config.systemChecks);
  const server = resolveServer(config.server as AppServerConfig | undefined);
  const render = resolveRender(config.render);

  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath(cwd, options.configPath);
  const configDir = dirname(configPath);
  const { rootDir, pagesDir, apiDir, publicDir, outDir, storageDir, pluginsDir } =
    resolveDirectoryPaths({
      configDir,
      rootDir: config.rootDir,
      pages: config.pages,
      api: config.api,
      public: config.public,
      out: config.out,
      storage: config.storage,
      pluginsDir: plugins?.pluginsDir,
    });
  const healthPath = resolveHealthPath(config.healthPath);
  if (readiness?.path !== undefined && readiness.path === healthPath) {
    throw new AppConfigError('config.readiness.path must differ from config.healthPath');
  }

  assertPublicDirIsolation({
    configPath,
    rootDir,
    pagesDir,
    apiDir,
    publicDir,
    outDir,
  });
  assertStorageIsolation({
    configPath,
    rootDir,
    publicDir,
    outDir,
    storageDir,
  });
  assertPluginsDirIsolation({
    configPath,
    rootDir,
    pagesDir,
    apiDir,
    publicDir,
    outDir,
    pluginsDir,
  });

  return {
    configPath,
    rootDir,
    pagesDir,
    apiDir,
    publicDir,
    outDir,
    storageDir,
    pluginsDir,
    host,
    port: config.port ?? DEFAULT_APP_PORT,
    shape: config.shape ?? 'full',
    healthPath,
    authorize,
    resolveSession,
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    setup,
    commands,
    extensions,
    renderer,
    plugins,
    introspect,
    seo,
    i18n,
    middleware,
    globalMiddleware,
    ...(onError === undefined ? {} : { onError }),
    ...(errorPage === undefined ? {} : { errorPage }),
    ...(readiness === undefined ? {} : { readiness }),
    ...(systemChecks === undefined ? {} : { systemChecks }),
    server,
    ...(render === undefined ? {} : { render }),
  };
}

/**
 * Prefix a mapped issue with its `config.` location. An unknown key is named
 * only generically: the key is author-provided and may be a typo of a secret
 * name.
 */
function describeIssue(entry: ZodIssueEntry): string {
  if (entry.code === 'unknown_field') {
    return 'unrecognized config field';
  }
  const field = entry.path.length > 0 ? `config.${entry.path.join('.')}` : 'the app config';
  return `${field}: ${entry.message}`;
}

/** Validate a host string: no whitespace or path separators, non-empty. */
function resolveHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_APP_HOST;
  if (value === '' || /\s/.test(value) || value.includes('/')) {
    throw new AppConfigError('config.host must be a non-empty host without whitespace or a path');
  }
  return value;
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
 * Validate the readiness options with the same rules `createApp` applies, so a
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
 * Resolve the `server` block: the origin, hosts, and trusted proxies through
 * the same compiler the request pipeline uses (so a bad value fails at load,
 * value-free), and the timeouts checked together (the schema checked each
 * field), so a combination Node would reject fails at load rather than at
 * `serve`.
 */
function resolveServer(value: AppServerConfig | undefined): ResolvedServerConfig {
  const { origin, hosts, trustedProxies, ...timeoutFields } = value ?? {};
  let policy: OriginPolicy;
  try {
    policy = createOriginPolicy({
      ...(origin === undefined ? {} : { origin }),
      ...(hosts === undefined ? {} : { hosts }),
      ...(trustedProxies === undefined ? {} : { trustedProxies }),
    });
  } catch (error) {
    if (error instanceof RequestOriginConfigError) {
      throw new AppConfigError(`config.${error.message}`);
    }
    throw error;
  }
  // An explicitly `undefined` field means "keep the default", so it must not
  // reach the spread over the defaults.
  const timeouts = Object.fromEntries(
    Object.entries(timeoutFields).filter(([, timeout]) => timeout !== undefined),
  ) as AppServerTimeouts;
  try {
    resolveServerTimeouts(timeouts);
  } catch (error) {
    if (error instanceof TypeError) throw new AppConfigError(`config.server: ${error.message}`);
    throw error;
  }
  return Object.freeze({
    origin: policy.origin,
    hosts: policy.hosts,
    trustedProxies: policy.trustedProxies,
    timeouts: Object.freeze(timeouts),
  });
}

/**
 * The render settings with explicitly `undefined` fields dropped (the schema
 * already checked each field and rejected unknown keys), frozen so the value
 * handed to `createApp` cannot change after load.
 */
function resolveRender(value: AppRenderConfig | undefined): AppRenderConfig | undefined {
  if (value === undefined) return undefined;
  return Object.freeze({
    ...(value.stream === undefined ? {} : { stream: value.stream }),
    ...(value.streamTimeoutMs === undefined ? {} : { streamTimeoutMs: value.streamTimeoutMs }),
  });
}

/**
 * Map a shared extension-entry validation error to a value-free message. The
 * messages keep the canonical `config.extensions` prefix and never echo an
 * entry's name.
 */
function describeConfigExtensionError(error: ExtensionEntryError): string {
  switch (error.code) {
    case 'not_object':
      return 'config.extensions entries must be extension objects';
    case 'missing_name':
      return 'config.extensions entries must have a non-empty name';
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
 * Validate extensions structurally without cloning them, then return the same
 * list instance. Names must be non-empty and unique, `setup` must be a
 * function, priorities/disabled flags must be well-shaped, and every `requires`
 * entry must be a token-shaped object. Nothing is invoked and no extension
 * value is echoed in an error. The structural check is shared with the
 * extension runner via `validateExtensionEntries`.
 */
function resolveExtensions(value: unknown): readonly JsailsExtension[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AppConfigError('config.extensions must be an array');
  }
  const error = validateExtensionEntries(value);
  if (error !== undefined) {
    throw new AppConfigError(describeConfigExtensionError(error));
  }
  return value as readonly JsailsExtension[];
}

/**
 * Validate CLI commands from the app and its extensions using the pure command
 * collector and registry, then return the app-level list by identity.
 *
 * Collection and registry validation are synchronous and side-effect free: they
 * read command metadata (`name`, `summary`, `usage`, `run`) exactly once and
 * never invoke a handler. The registry applies one namespace across both
 * sources, so a bad shape, an invalid name, a reserved builtin, or a duplicate
 * shared between the app and an extension is rejected here. A
 * {@link CliCommandError} is remapped to a value-free {@link AppConfigError};
 * extension commands stay on their extension, so the returned list is
 * app-level only and `collectConfigCommands(resolved)` never double-counts.
 */
function resolveCommands(
  appCommands: unknown,
  extensions: readonly JsailsExtension[],
): readonly CliCommand[] {
  try {
    createCliCommandRegistry(collectConfigCommands({ commands: appCommands, extensions }));
  } catch (error) {
    throw new AppConfigError(describeCommandError(error));
  }
  return appCommands === undefined ? [] : (appCommands as readonly CliCommand[]);
}

/** Map a command validation failure to a value-free app-config message. */
function describeCommandError(error: unknown): string {
  if (!(error instanceof CliCommandError)) {
    return 'config.commands is invalid';
  }
  switch (error.code) {
    case 'duplicate_name':
      return 'config.commands contains duplicate command names';
    case 'reserved_name':
      return 'config.commands contains a reserved command name';
    case 'invalid_name':
      return 'config.commands contains an invalid command name';
    case 'invalid_command':
      return 'config.commands contains an invalid command';
    default:
      return 'config.commands is invalid';
  }
}

/**
 * Validate that a renderer exposes a `render` function and return the same
 * object by identity. The function is never invoked, and no method is rebound
 * or copied, so a class renderer keeps its own `this` and instance state.
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
 * Resolve the plugin settings without mutating the input. The shape is already
 * validated by the strict nested schema, so this only applies the `enabled`
 * default and preserves identity: absent stays `undefined`, and a provided
 * object is returned by reference (never copied or frozen) with `enabled`
 * defaulted to an empty list when omitted. `downloads` and `managed` are
 * carried through verbatim (neither has a materialized default here; an unset
 * `managed` means non-managed, the default).
 */
function resolvePlugins(value: unknown): AppPluginsConfig | undefined {
  if (value === undefined) return undefined;
  const plugins = value as AppPluginsConfig;
  if (plugins.stateSource !== undefined) {
    const source = plugins.stateSource as Partial<PluginStateSource> | null;
    if (
      source === null ||
      typeof source !== 'object' ||
      typeof source.load !== 'function' ||
      typeof source.save !== 'function' ||
      typeof source.putEntry !== 'function' ||
      typeof source.removeEntry !== 'function'
    ) {
      throw new AppConfigError('config.plugins.stateSource must be a plugin state source');
    }
  }
  if (plugins.pluginsDir !== undefined && plugins.pluginsDir.trim() === '') {
    throw new AppConfigError('config.plugins.pluginsDir must be a non-empty string');
  }
  return plugins.enabled === undefined ? { ...plugins, enabled: [] } : plugins;
}

/**
 * Resolve the introspection config with safe defaults. The shape is already
 * validated by the strict nested schema; this layer applies policy:
 *
 * - absent → `undefined` (route never registered);
 * - `enabled !== true` → `undefined` (fail closed);
 * - `enabled === true` and no `authorize` → `AppConfigError` (the endpoint must
 *   be default-deny, and the loader rejects an insecure default);
 * - `sections` defaults to the safe subset `['routes', 'plugins', 'components',
 *   'health']`.
 */
function resolveIntrospect(
  value: IntrospectConfig | undefined,
): ResolvedIntrospectConfig | undefined {
  if (value === undefined) return undefined;
  if (value.enabled !== true) return undefined; // fail closed
  if (typeof value.authorize !== 'function') {
    throw new AppConfigError(
      'config.introspect.authorize is required when introspection is enabled',
    );
  }
  const sections = value.sections ?? SAFE_INTROSPECT_SECTIONS;
  return {
    enabled: true,
    authorize: value.authorize,
    sections,
  };
}

/** The safe subset of sections available by default when `sections` is omitted. */
const SAFE_INTROSPECT_SECTIONS: readonly IntrospectSection[] = [
  'routes',
  'plugins',
  'components',
  'health',
] as const;

/**
 * Resolve the SEO config. Absent → `undefined` (no defaults, no `robots.txt`).
 * `origin` is normalized and validated as an absolute `http(s)` origin;
 * `defaults` is validated through {@link defineMetadata} so a malformed default
 * fails at load time with a value-free error. `robots` is passed through by
 * identity (its own builder validates directive values at emission time).
 */
function resolveSeo(value: SeoConfig | undefined): ResolvedSeoConfig | undefined {
  if (value === undefined) return undefined;
  const origin = value.origin === undefined ? undefined : assertOrigin(value.origin);
  const defaults: PageMetadata | undefined =
    value.defaults === undefined ? undefined : defineMetadata(value.defaults);
  const robots: RobotsOptions | undefined = value.robots;
  return { siteName: value.siteName, origin, defaults, robots };
}

/** Locale pattern used for validation (same as in the catalog loader and i18n plugin). */
const LOCALE_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate and resolve the optional i18n config block. Locales are validated
 * against {@link LOCALE_PATTERN}; `loadPaths` entries are resolved relative to
 * the root directory (resolution happens later in `validateAppConfig`, so here
 * they stay as-is and become absolute in `resolveDirectoryPaths`). A malformed
 * locale, empty load path, or both `catalogs` and `loadPaths` set at once
 * throws a value-free {@link AppConfigError}.
 */
function resolveI18n(value: I18nConfig | undefined): ResolvedI18nConfig | undefined {
  if (value === undefined) return undefined;
  if (value.catalogs !== undefined && value.loadPaths !== undefined) {
    throw new AppConfigError(
      'config.i18n.catalogs and config.i18n.loadPaths are mutually exclusive',
    );
  }
  if (value.locale !== undefined) {
    if (
      typeof value.locale !== 'string' ||
      value.locale.length === 0 ||
      !LOCALE_PATTERN.test(value.locale)
    ) {
      throw new AppConfigError('config.i18n.locale is invalid');
    }
  }
  if (value.fallbackLocale !== undefined) {
    if (
      typeof value.fallbackLocale !== 'string' ||
      value.fallbackLocale.length === 0 ||
      !LOCALE_PATTERN.test(value.fallbackLocale)
    ) {
      throw new AppConfigError('config.i18n.fallbackLocale is invalid');
    }
  }
  if (value.loadPaths !== undefined) {
    for (const path of value.loadPaths) {
      if (typeof path !== 'string' || path.length === 0) {
        throw new AppConfigError('config.i18n.loadPaths entries must be non-empty strings');
      }
    }
  }
  if (value.locales !== undefined) {
    if (!Array.isArray(value.locales) || value.locales.length === 0) {
      throw new AppConfigError('config.i18n.locales must be a non-empty array');
    }
    const seen = new Set<string>();
    for (const locale of value.locales) {
      if (typeof locale !== 'string' || locale.length === 0 || !LOCALE_PATTERN.test(locale)) {
        throw new AppConfigError('config.i18n.locales contains an invalid locale');
      }
      if (seen.has(locale)) {
        throw new AppConfigError('config.i18n.locales contains a duplicate locale');
      }
      seen.add(locale);
    }
  }
  if (value.defaultLocale !== undefined) {
    if (
      typeof value.defaultLocale !== 'string' ||
      value.defaultLocale.length === 0 ||
      !LOCALE_PATTERN.test(value.defaultLocale)
    ) {
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
  const resolved: ResolvedI18nConfig = {
    locale: value.locale ?? 'en',
    fallbackLocale: value.fallbackLocale ?? 'en',
    ...(value.locales !== undefined ? { locales: Object.freeze([...value.locales]) } : {}),
    ...(value.defaultLocale !== undefined ? { defaultLocale: value.defaultLocale } : {}),
    catalogs: value.catalogs,
    loadPaths: value.loadPaths,
  };
  return resolved;
}

/**
 * Validate the named middleware map without mutating the input. Every value
 * must be a function and every key must be non-empty. Absent resolves to
 * `undefined` (no middleware registered). A valid map is returned by identity so
 * the map can be pre-built and passed through unchanged.
 *
 * Names and handler values are never echoed in errors — the caller's own
 * middleware key-names may embed sensitive identifiers, and the handler
 * functions may carry closures with secrets.
 */
function resolveMiddleware(value: unknown): Readonly<Record<string, RouteMiddleware>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppConfigError('config.middleware must be a plain object');
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AppConfigError('config.middleware must be a plain object');
  }
  for (const [key, handler] of Object.entries(value as Record<string, unknown>)) {
    // Names are validated (never echoed) before handlers so a bad name from an
    // otherwise-valid handler still fails value-free.
    if (key.length === 0) {
      throw new AppConfigError('config.middleware entries must have non-empty names');
    }
    if (typeof handler !== 'function') {
      throw new AppConfigError('config.middleware entries must be functions');
    }
  }
  return value as Readonly<Record<string, RouteMiddleware>>;
}

/**
 * Validate the global middleware array without mutating the input. Every entry
 * must be a function ({@link RouteMiddleware}) or a non-empty string (a name
 * registered in {@link middleware}). Absent resolves to `undefined` (no global
 * chain). A valid array is returned by identity.
 *
 * Entry values are never echoed in errors; the string names may reference
 * middleware registered under sensitive identifiers, and inline functions may
 * carry closures with secrets.
 */
function resolveGlobalMiddleware(value: unknown): readonly RouteMiddlewareRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AppConfigError('config.globalMiddleware must be an array');
  }
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as unknown;
    if (typeof entry !== 'function' && typeof entry !== 'string') {
      throw new AppConfigError('config.globalMiddleware entries must be functions or strings');
    }
    // Reject empty strings at load time so resolution never has to check again.
    if (typeof entry === 'string' && entry.length === 0) {
      throw new AppConfigError('config.globalMiddleware entries must be non-empty strings');
    }
  }
  return value as readonly RouteMiddlewareRef[];
}
