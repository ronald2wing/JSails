/**
 * Loading, normalization, and redaction of the Jamal config.
 *
 * The config is a single ESM module, `jamal.config.ts` (or `jamal.config.js`
 * for a project without TypeScript), whose default export drives both local
 * development and production; environment-specific settings live in the
 * non-destructive `local` and `production` overlay sections. Nothing here
 * reads an environment variable, writes a file, or resolves a
 * {@link SecretRef}.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { explainModuleImportFailure } from 'jsails/internal';

import { isPlainObject } from '../object-shape.js';

import { JamalConfigError } from '../error.js';
import { CACHE_PROXY_IMAGE_DEFAULT, CACHE_PROXY_SIZE_DEFAULT } from '../production/cache-proxy.js';
import type { JamalConfig, RedactedJamalConfig } from './model.js';
import { assertNoDangerousKeys, assertSafeConfig } from './safety.js';
import { describeIssues, jamalConfigSchema, type ParsedJamalConfig } from './schema.js';
import { SecretRef } from './secret-ref.js';
import { parseVolumeSpec } from './volume-spec.js';

/**
 * The config module names, in the order they are looked up against the
 * working directory. A project holds exactly one of them.
 */
export const JAMAL_CONFIG_FILENAMES: readonly string[] = Object.freeze([
  'jamal.config.ts',
  'jamal.config.js',
]);

/**
 * The config module in `cwd`: its file name and absolute path. Two config
 * modules are refused rather than one silently shadowing the other.
 */
export function findJamalConfig(cwd: string): { readonly name: string; readonly path: string } {
  const found = JAMAL_CONFIG_FILENAMES.filter((name) => existsSync(resolve(cwd, name)));
  const name = found[0];
  if (name === undefined) {
    throw new JamalConfigError(`jamal config not found (${JAMAL_CONFIG_FILENAMES.join(' or ')})`, {
      suggestion: 'Create jamal.config.ts in the project root, or run jamal from that directory',
    });
  }
  if (found.length > 1) {
    throw new JamalConfigError('the project has both jamal.config.ts and jamal.config.js', {
      suggestion: 'Keep one jamal config file',
    });
  }
  return { name, path: resolve(cwd, name) };
}

/**
 * Import the project's config module and return the normalized model. A
 * missing module, an import failure, or a module without a default export
 * each raise a distinct, value-free {@link JamalConfigError}. Importing the
 * module runs its own top-level code (inherent to ESM); this loader never
 * invokes a callback and never opens a connection. Node strips the types of a
 * `.ts` config itself, so the file must use erasable TypeScript only.
 */
export async function loadJamalConfig(cwd: string = process.cwd()): Promise<JamalConfig> {
  const { name, path } = findJamalConfig(cwd);
  let module: unknown;
  try {
    // A file URL, never a path: `import()` reads `C:\...` as a URL scheme and
    // a POSIX path holding `#` or `%` as a fragment or an escape.
    module = await import(pathToFileURL(path).href);
  } catch (error) {
    // The module's own exception text may embed secrets, so it stays on
    // `cause`, where a report prints only its value-free facts (a syntax
    // error wrapped in the error naming its place).
    throw new JamalConfigError(`failed to load jamal config "${name}"`, {
      cause: await explainModuleImportFailure(path, error, cwd),
    });
  }
  const defaultExport = (module as { default?: unknown }).default;
  if (defaultExport === undefined) {
    throw new JamalConfigError(`jamal config "${name}" must default-export a config object`);
  }
  return normalizeJamalConfig(defaultExport);
}

/**
 * Validate `raw` and return the normalized, deeply frozen model. The input is
 * never mutated. Base fields and the `local`/`production` overlays are merged
 * non-destructively. The overlays currently carry fields disjoint from the base
 * (`local` = ports/app, `production` = server/domain/registry/ssh), so the
 * merge is additive; should an overlay ever repeat a base field, the overlay
 * wins and every other base field is retained.
 *
 * Any non-{@link JamalConfigError} thrown while reading `raw` (for example a
 * throwing property getter) is replaced by a value-free error with no cause.
 */
export function normalizeJamalConfig(raw: unknown): JamalConfig {
  try {
    return resolveJamalConfig(raw);
  } catch (error) {
    if (error instanceof JamalConfigError) {
      throw error;
    }
    throw new JamalConfigError('the jamal config could not be read');
  }
}

function resolveJamalConfig(raw: unknown): JamalConfig {
  if (!isPlainObject(raw)) {
    throw new JamalConfigError('the jamal config must be a plain object');
  }
  // Zod's record parser assigns `result[key] = value`, so an own `__proto__`
  // key (for example from JSON.parse'd input) is silently dropped before the
  // post-parse safety checks run. Scan the raw input first to reject it.
  assertNoDangerousKeys(raw);
  const result = jamalConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new JamalConfigError(describeIssues(result.error));
  }
  assertSafeConfig(result.data);
  return deepFreeze(buildModel(result.data));
}

/** Assemble the normalized model from parsed data, applying defaults. */
function buildModel(config: ParsedJamalConfig): JamalConfig {
  return {
    service: config.service,
    image: config.image,
    command: config.command,
    health:
      config.health === undefined
        ? undefined
        : {
            path: config.health.path,
            timeoutMs: config.health.timeoutMs,
            intervalMs: config.health.intervalMs,
            retries: config.health.retries,
            retryDelayMs: config.health.retryDelayMs,
            readinessDelayMs: config.health.readinessDelayMs,
          },
    env: Object.freeze(
      Object.fromEntries(
        Object.entries(config.env ?? {}).map(([name, value]) => {
          if (typeof value === 'string' || value instanceof SecretRef) {
            return [name, Object.freeze({ value, alias: undefined, clear: false })];
          }
          return [
            name,
            Object.freeze({
              value: value.value,
              alias: value.alias,
              clear: value.clear ?? false,
            }),
          ];
        }),
      ),
    ),
    services: { ...(config.services ?? {}) },
    volumes: Object.freeze(
      Object.fromEntries(
        Object.entries(config.volumes ?? {}).map(([name, value]) => {
          const spec = parseVolumeSpec(value);
          // A bare container path names no source; the volume's key is the source.
          if (!spec.host && spec.source === '') {
            return [name, Object.freeze({ ...spec, source: name })];
          }
          return [name, spec];
        }),
      ),
    ),
    local: {
      ports: { ...(config.local?.ports ?? {}) },
      app: config.local?.app ?? 'host',
    },
    logging:
      config.logging === undefined
        ? undefined
        : {
            driver: config.logging.driver,
            options: { ...(config.logging.options ?? {}) },
          },
    production:
      config.production === undefined
        ? undefined
        : {
            server: config.production.server,
            domain: config.production.domain,
            onDemandTlsUrl: config.production.onDemandTlsUrl,
            destination: config.production.destination,
            secretsPath: config.production.secretsPath,
            registry:
              config.production.registry === undefined
                ? undefined
                : { ...config.production.registry },
            ssh:
              config.production.ssh === undefined
                ? undefined
                : {
                    user: config.production.ssh.user,
                    port: config.production.ssh.port,
                    proxyCommand: config.production.ssh.proxyCommand,
                    logLevel: config.production.ssh.logLevel,
                    keysOnly: config.production.ssh.keysOnly ?? false,
                    keys: [...(config.production.ssh.keys ?? [])],
                    config: config.production.ssh.config,
                    forwardAgent: config.production.ssh.forwardAgent ?? false,
                  },
          },
    cacheProxy:
      config.cacheProxy === undefined
        ? undefined
        : {
            enabled: config.cacheProxy.enabled ?? false,
            image: config.cacheProxy.image ?? CACHE_PROXY_IMAGE_DEFAULT,
            size: config.cacheProxy.size ?? CACHE_PROXY_SIZE_DEFAULT,
            cookieAllowlist:
              config.cacheProxy.cookieAllowlist === undefined
                ? undefined
                : [...config.cacheProxy.cookieAllowlist],
          },
    proxy: {
      forwardHeaders: config.proxy?.forwardHeaders ?? false,
      upstreamCidrs:
        config.proxy?.upstreamCidrs === undefined ? undefined : [...config.proxy.upstreamCidrs],
    },
  };
}

/**
 * Return a plan-safe deep copy of the model in which every {@link SecretRef} in
 * `env` is rendered as `secret(<name>)`. The output never contains a resolved
 * secret value (it never held one), so `JSON.stringify` of the result is safe
 * to print, persist, or hand to a plan. The model itself is not mutated.
 */
export function redactJamalConfig(model: JamalConfig): RedactedJamalConfig {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(model.env)) {
    const v = value.value;
    env[key] = v instanceof SecretRef ? v.toString() : v;
  }
  return deepFreeze({
    service: model.service,
    image: model.image,
    command: model.command,
    health:
      model.health === undefined
        ? undefined
        : {
            path: model.health.path,
            timeoutMs: model.health.timeoutMs,
            intervalMs: model.health.intervalMs,
            retries: model.health.retries,
            retryDelayMs: model.health.retryDelayMs,
            readinessDelayMs: model.health.readinessDelayMs,
          },
    env,
    services: { ...model.services },
    volumes: { ...model.volumes },
    local: { ports: { ...model.local.ports }, app: model.local.app },
    logging:
      model.logging === undefined
        ? undefined
        : { driver: model.logging.driver, options: { ...model.logging.options } },
    production:
      model.production === undefined
        ? undefined
        : {
            server: model.production.server,
            domain: model.production.domain,
            onDemandTlsUrl: model.production.onDemandTlsUrl,
            destination: model.production.destination,
            secretsPath: model.production.secretsPath,
            registry:
              model.production.registry === undefined
                ? undefined
                : { ...model.production.registry },
            ssh:
              model.production.ssh === undefined
                ? undefined
                : {
                    user: model.production.ssh.user,
                    port: model.production.ssh.port,
                    proxyCommand: model.production.ssh.proxyCommand,
                    logLevel: model.production.ssh.logLevel,
                    keysOnly: model.production.ssh.keysOnly,
                    keys: [...model.production.ssh.keys],
                    config: model.production.ssh.config,
                    forwardAgent: model.production.ssh.forwardAgent,
                  },
          },
    cacheProxy:
      model.cacheProxy === undefined
        ? undefined
        : {
            enabled: model.cacheProxy.enabled,
            image: model.cacheProxy.image,
            size: model.cacheProxy.size,
            cookieAllowlist:
              model.cacheProxy.cookieAllowlist === undefined
                ? undefined
                : [...model.cacheProxy.cookieAllowlist],
          },
    proxy: {
      forwardHeaders: model.proxy.forwardHeaders,
      upstreamCidrs:
        model.proxy.upstreamCidrs === undefined ? undefined : [...model.proxy.upstreamCidrs],
    },
  });
}

/** Deep-freeze a value, recursing into plain objects but leaving SecretRefs alone. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || value instanceof SecretRef) {
    return value;
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
