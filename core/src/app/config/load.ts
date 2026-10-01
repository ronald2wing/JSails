/**
 * Resolving an app config object, and applying the environment overrides.
 *
 * {@link resolveAppSource} turns a raw config object into a
 * {@link ResolvedAppConfig} and the {@link ActivationMode} it states. The
 * compat mapper (`legacy.ts`) splits off the legacy keys first. The kept keys
 * are checked by the typed schema, the legacy ones by the mapper. Only the
 * kernel loader calls it, and the kernel seals the mode on the loaded app.
 * {@link validateAppConfig} is the same pass without the mode, for a
 * programmatic config. {@link applyEnvironmentOverrides} applies
 * `JSAILS_HOST`, `JSAILS_PORT` and `JSAILS_TRUSTED_PROXIES` from the
 * environment the loader is handed; nothing here reads the process
 * environment.
 *
 * Every pass is inert. It never creates a directory, opens a connection or
 * invokes a callback, an extension's `setup`, a renderer or a command;
 * callbacks and objects pass through by identity.
 *
 * Errors are value-free: `AppConfigError`s from the resolver, and the
 * `config.removed_option` registry error for an option already removed. The
 * whole pass runs inside {@link sanitizeAppConfigErrors}, so a throwing
 * property accessor (or any other step) surfaces as a value-free
 * `AppConfigError`.
 */

import { dirname } from 'node:path';

import { isRegistryError } from '../../errors/registry.js';
import { isPlainObject } from '../../json/shape.js';
import {
  createOriginPolicy,
  parseTrustedProxies,
  RequestOriginConfigError,
  sameTrustedProxies,
  TRUSTED_PROXIES_ENV,
  type OriginPolicy,
  type TrustedProxies,
} from '../../security/request-origin.js';
import { mapZodIssues } from '../../validation/zod-issues.js';
import { DEFAULT_HANDLER_TIMEOUT_MS, DEFAULT_MAX_BODY_BYTES } from '../../server/route-limits.js';
import type { Guard } from '../../server/request-frame.js';
import { resolveServerTimeouts } from '../server-timeouts.js';
import {
  DEFAULT_APP_HOST,
  DEFAULT_APP_PORT,
  APP_HOST_ENV,
  APP_PORT_ENV,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from './defaults.js';
import { AppConfigError } from './errors.js';
import { describeLegacyIssue, resolveLegacyConfig, splitLegacyConfig } from './legacy.js';
import {
  appConfigSchema,
  type ActivationMode,
  type AppConfigValidationOptions,
  type AppRenderConfig,
  type AppServerConfig,
  type AppServerTimeouts,
  type ResolvedAppConfig,
  type ResolvedServerConfig,
  type ResolvedHttpConfig,
} from './schema.js';
import {
  assertPublicDirIsolation,
  assertStorageIsolation,
  resolveConfigPath,
  resolveDirectoryPaths,
  resolveHealthPath,
} from './paths.js';

/** A resolved config and the activation mode its source states. */
export interface ResolvedAppSource {
  readonly config: ResolvedAppConfig;
  readonly activation: ActivationMode;
}

/**
 * The variables a loader is handed, by name.
 *
 * @public
 */
export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Validate a programmatic config object and resolve it. No module runs and no
 * callback is invoked. Directories are computed lexically; existing paths are
 * resolved through `realpath` only to harden the isolation checks.
 *
 * The activation mode the object states is validated and then dropped: only
 * the kernel loader (`loadApp`, `createLoadedApp`) seals a mode, and an
 * application built from a bare resolved config runs locked.
 */
export function validateAppConfig(
  value: unknown,
  options: AppConfigValidationOptions = {},
): ResolvedAppConfig {
  return resolveAppSource(value, options).config;
}

/**
 * Resolve a raw config object into its {@link ResolvedAppConfig} and the
 * activation mode it states (`'locked'` when absent). Called by the kernel
 * loader, which seals the mode.
 */
export function resolveAppSource(
  value: unknown,
  options: AppConfigValidationOptions = {},
): ResolvedAppSource {
  return sanitizeAppConfigErrors(() => resolveSource(value, options));
}

/**
 * Convert any thrown value that is not a framework error into a value-free
 * {@link AppConfigError}. An `AppConfigError` or a registry error is
 * re-thrown unchanged. An arbitrary exception (for example a throwing
 * property getter whose message embeds a credential) is replaced, without a
 * cause.
 */
function sanitizeAppConfigErrors<T>(resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof AppConfigError || isRegistryError(error)) {
      throw error;
    }
    throw new AppConfigError('the app config could not be read');
  }
}

function resolveSource(value: unknown, options: AppConfigValidationOptions): ResolvedAppSource {
  if (isObservedThenable(value)) {
    throw new AppConfigError('the app config must be an object, not a promise');
  }
  // A strict object schema accepts any object without own keys, so a class
  // instance (a Map, a Date) would otherwise load as an empty config.
  if (!isPlainObject(value)) {
    throw new AppConfigError('the app config must default-export a plain object');
  }
  const split = splitLegacyConfig(value);
  const result = appConfigSchema.safeParse(split.kept);
  if (!result.success) {
    throw new AppConfigError(mapZodIssues(result.error).map(describeLegacyIssue).join('; '));
  }
  const config = result.data;
  const legacy = resolveLegacyConfig(split.legacy);

  const host = resolveHost(config.host);
  const server = resolveServer(config.server);
  const render = resolveRender(config.render);
  const telemetry =
    config.telemetry?.trustInbound === undefined
      ? undefined
      : Object.freeze({ trustInbound: config.telemetry.trustInbound });
  const http = resolveHttp(config.http?.guards);

  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath(cwd, options.configPath);
  const configDir = dirname(configPath);
  const { rootDir, pagesDir, apiDir, publicDir, outDir, storageDir } = resolveDirectoryPaths({
    configDir,
    rootDir: config.rootDir,
    pages: legacy.directories.pages,
    api: legacy.directories.api,
    public: legacy.directories.public,
    out: legacy.directories.out,
    storage: config.storage,
  });
  const healthPath = resolveHealthPath(config.healthPath);
  const readiness = legacy.values.readiness;
  if (readiness?.path !== undefined && readiness.path === healthPath) {
    throw new AppConfigError('config.readiness.path must differ from config.healthPath');
  }

  assertPublicDirIsolation({ configPath, rootDir, pagesDir, apiDir, publicDir, outDir });
  assertStorageIsolation({ configPath, rootDir, publicDir, outDir, storageDir });

  const plugins = Object.freeze({
    use: Object.freeze([...(split.use ?? [])]) as ResolvedAppConfig['plugins']['use'],
  });
  const resolved: ResolvedAppConfig = {
    configPath,
    rootDir,
    pagesDir,
    apiDir,
    publicDir,
    outDir,
    storageDir,
    host,
    port: config.port ?? DEFAULT_APP_PORT,
    healthPath,
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ...legacy.values,
    plugins,
    server,
    ...(render === undefined ? {} : { render }),
    ...(telemetry === undefined ? {} : { telemetry }),
    http,
  };
  return { config: resolved, activation: config.plugins?.activation?.mode ?? 'locked' };
}

/**
 * Whether `value` is a promise (a thenable), which a loader refuses as a
 * config without awaiting it. Its rejection is observed first: it may embed
 * a secret, and must not surface later as an unhandled rejection.
 */
export function isObservedThenable(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  if (typeof (value as { then?: unknown }).then !== 'function') return false;
  // The refusal is the report; the rejection's reason is never read.
  Promise.resolve(value).catch(() => undefined);
  return true;
}

/**
 * Apply the environment overrides a deployed app takes from the environment
 * its loader is handed:
 *
 * - `JSAILS_HOST` and `JSAILS_PORT` replace the listen host and port.
 * - `JSAILS_TRUSTED_PROXIES` applies when the raw config states no
 *   `server.trustedProxies`. The deploy tool knows the proxy topology, so it
 *   declares it in the environment, and the same image run without a proxy
 *   keeps `'none'`. A config value wins; an environment value that disagrees
 *   with it is reported, never applied.
 *
 * Errors never echo a value.
 */
export function applyEnvironmentOverrides(
  config: ResolvedAppConfig,
  raw: unknown,
  env: ConfigEnvironment,
): ResolvedAppConfig {
  return applyTrustedProxiesEnv(
    applyListenOverrides(config, env),
    configuresTrustedProxies(raw),
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

function applyTrustedProxiesEnv(
  config: ResolvedAppConfig,
  configured: boolean,
  env: ConfigEnvironment,
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
  env: ConfigEnvironment,
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

/** Freeze the `http.guards` list; the schema checked each entry is a function. */
function resolveHttp(guards: readonly Guard[] | undefined): ResolvedHttpConfig {
  return Object.freeze({ guards: Object.freeze([...(guards ?? [])]) });
}

/** Validate a host string: no whitespace or path separators, non-empty. */
function resolveHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_APP_HOST;
  if (value === '' || /\s/.test(value) || value.includes('/')) {
    throw new AppConfigError('config.host must be a non-empty host without whitespace or a path');
  }
  return value;
}

/**
 * Resolve the `server` block: the origin, hosts, and trusted proxies through
 * the same compiler the request pipeline uses (so a bad value fails at load,
 * value-free), and the timeouts checked together (the schema checked each
 * field), so a combination Node would reject fails at load rather than at
 * `serve`.
 */
function resolveServer(value: AppServerConfig | undefined): ResolvedServerConfig {
  const { origin, hosts, trustedProxies, handlerTimeoutMs, ...timeoutFields } = value ?? {};
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
    handlerTimeoutMs: handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
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
    ...(value.streamTimeoutMs === undefined ? {} : { streamTimeoutMs: value.streamTimeoutMs }),
  });
}
