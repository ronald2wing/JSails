/**
 * Stage 2 of the kernel pipeline: loading the app config into a
 * {@link LoadedApp}.
 *
 * {@link loadApp} loads a config file. Two roots are accepted:
 *
 * - `jsails.config.ts`, a `defineApp` module. It is scanned statically first
 *   (`config-scan.ts`: the import graph, erasable syntax and the activation
 *   literal), then imported by Node's type stripping. Its environment
 *   declaration is parsed from the environment the loader is handed, and its
 *   `config` function is called with the values.
 * - the legacy `jsails.app.js`, whose default export is the config object (or
 *   a `defineApp` definition). Only its activation literal is scanned.
 *
 * {@link createLoadedApp} does the same for a config object built in code.
 *
 * The loaded app is frozen and branded. Its activation mode is sealed beside
 * it (`activation/mode.ts`), never stored on it, and the config the module
 * returns must state the mode the scan read.
 *
 * The environment is the one the caller hands in. Absent, it is the one the
 * `jsails` bin resolved and applied for this process; outside the bin (a test
 * file under `jsails test` or plain `node --test`, a custom server script) it
 * is resolved here exactly as the bin resolves it (`environment/resolve.ts`:
 * the real variables, the inherited `JSAILS_ENV_RESOLVED` resolution of a
 * parent JSails process, the `.env` files and the sealed credentials), and
 * never applied to `process.env`. Nothing here reads `process.env` itself.
 */

import { readFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';

import {
  applyEnvironmentOverrides,
  isObservedThenable,
  resolveAppSource,
} from '../app/config/load.js';
import type { ConfigEnvironment } from '../app/config/load.js';
import { AppConfigError } from '../app/config/errors.js';
import { resolveConfigPath } from '../app/config/paths.js';
import type { ActivationMode, JsailsAppConfig, ResolvedAppConfig } from '../app/config/schema.js';
import { bootstrapModels } from '../models/bootstrap.js';
import { parsePluginEnv } from '../plugins/contract/env-variables.js';
import { ConfigErrors } from '../plugins/contract/errors.js';
import { importFile, relativePathSlot } from '../support/project-paths.server.js';
import { sealActivationMode } from './activation/mode.js';
import { scanConfigGraph, type ActivationLiteral, type ConfigScan } from './config-scan.js';
import { isAppDefinition, type AppDefinition } from './define-app.js';

/**
 * An app config, loaded and resolved: the input of `resolvePlugins` and
 * `createApplication`.
 *
 * @public
 */
export interface LoadedApp {
  /** The resolved config: absolute directories and defaults applied. */
  readonly config: ResolvedAppConfig;
  /** Absolute path of the config module (or the anchor of a config built in code). */
  readonly configPath: string;
}

/**
 * Options for {@link loadApp}.
 *
 * @public
 */
export interface LoadAppOptions {
  /** The config module, relative to `cwd`. Defaults to `jsails.app.js`. */
  readonly configPath?: string;
  /** The working directory. Defaults to the process's. */
  readonly cwd?: string;
  /**
   * The environment the config reads: its declared variables, and the
   * `JSAILS_HOST`, `JSAILS_PORT` and `JSAILS_TRUSTED_PROXIES` overrides.
   * Absent means the environment the `jsails` bin resolved and applied for
   * this process or, in a process the bin did not start, the environment
   * resolved for `cwd` the way the bin resolves it.
   */
  readonly env?: ConfigEnvironment;
}

/**
 * Options for {@link createLoadedApp}.
 *
 * @public
 */
export interface CreateLoadedAppOptions {
  /** The path `rootDir` resolves against. Defaults to `<cwd>/jsails.app.js`. */
  readonly configPath?: string;
  /** The working directory. Defaults to the process's. */
  readonly cwd?: string;
}

const LOADED = new WeakSet<object>();

/**
 * Whether `value` is an app {@link loadApp} or {@link createLoadedApp} made.
 *
 * @public
 */
export function isLoadedApp(value: unknown): value is LoadedApp {
  return typeof value === 'object' && value !== null && LOADED.has(value);
}

/**
 * Load the app config at `configPath` into a {@link LoadedApp}.
 *
 * Errors are value-free. A missing or unimportable module is an
 * `AppConfigError` (`load_failed`) whose cause holds only located facts. A
 * module outside its graph, an invalid environment or a throwing config
 * function is a `config.*` registry error.
 *
 * @public
 */
export async function loadApp(options: LoadAppOptions = {}): Promise<LoadedApp> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? (await defaultEnvironment(cwd));
  const absolute = resolveConfigPath(cwd, options.configPath);
  // Named relative to the working directory, as every error path is: an
  // absolute `--config` would otherwise put the home directory in the report.
  const requested = relativePathSlot(absolute, cwd);
  let rootSource: string;
  try {
    rootSource = readFileSync(absolute, 'utf8');
  } catch {
    // A missing file or a directory: the file system's message would echo the path.
    throw new AppConfigError(`failed to load app config "${requested}"`, { code: 'load_failed' });
  }
  const typed = isTypeScriptRoot(absolute);
  const scan = await scanRoot(absolute, rootSource, cwd, typed);
  let module: unknown;
  try {
    module = await importFile(absolute);
  } catch (error) {
    const { explainModuleImportFailure } = await import('../support/syntax-location.server.js');
    throw new AppConfigError(`failed to load app config "${requested}"`, {
      code: 'load_failed',
      cause: await explainModuleImportFailure(absolute, error),
    });
  }
  // Populate the compiler-generated model registry before the config is
  // validated and plugins run, so models are registered with zero user
  // wiring. A project with no registry is a silent no-op.
  await bootstrapModels({ rootDir: dirname(absolute) });
  const exported = (module as { default?: unknown }).default;
  if (typed && !isAppDefinition(exported)) {
    throw new ConfigErrors.Error('invalid_app_definition', { path: requested });
  }
  const raw = isAppDefinition(exported) ? runDefinition(exported, env, requested) : exported;
  const source = resolveAppSource(raw, { configPath: absolute, cwd });
  assertStatedActivation(source.activation, scan.activation, requested);
  return seal(applyEnvironmentOverrides(source.config, raw, env), absolute, source.activation);
}

/**
 * Require the mode the config returned to be the literal the scan read
 * (`locked` when the graph states none). A disagreement means something other
 * than the literal chose the mode: a spread, a condition, a value from a
 * package. The error points at the literal, or says that none states it.
 */
function assertStatedActivation(
  returned: ActivationMode,
  literal: ActivationLiteral | undefined,
  path: string,
): void {
  if (returned === (literal?.mode ?? 'locked')) return;
  if (literal === undefined) throw new ConfigErrors.Error('activation_unstated', { path });
  throw new ConfigErrors.Error('activation_mismatch', literal.at);
}

/**
 * Resolve a config object built in code into a {@link LoadedApp}. The mode it
 * states is sealed as given: code config is the authority on activation. No
 * environment override applies.
 *
 * @public
 */
export function createLoadedApp(
  config: JsailsAppConfig,
  options: CreateLoadedAppOptions = {},
): LoadedApp {
  const source = resolveAppSource(config, options);
  return seal(source.config, source.config.configPath, source.activation);
}

/**
 * The loaded app for `source`: itself when it is one, else a locked app
 * around a bare resolved config. Only the loader can seal managed, so a
 * resolved config that skipped it fails closed.
 */
export function asLoadedApp(source: LoadedApp | ResolvedAppConfig): LoadedApp {
  if (isLoadedApp(source)) return source;
  return seal(source, source.configPath, 'locked');
}

function seal(config: ResolvedAppConfig, configPath: string, mode: ActivationMode): LoadedApp {
  const app: LoadedApp = Object.freeze({ config, configPath });
  LOADED.add(app);
  sealActivationMode(app, mode);
  return app;
}

/** Whether the root is a TypeScript module, loaded by type stripping. */
function isTypeScriptRoot(path: string): boolean {
  const extension = extname(path);
  return extension === '.ts' || extension === '.mts';
}

/**
 * Scan the root: the whole graph for a TypeScript root, the activation
 * literal alone for a legacy root. A legacy root that does not parse is left
 * to the import, which reports the syntax error at its place.
 */
async function scanRoot(
  absolute: string,
  rootSource: string,
  cwd: string,
  typed: boolean,
): Promise<ConfigScan> {
  if (typed) return scanConfigGraph(absolute, { cwd, rootSource });
  try {
    return await scanConfigGraph(absolute, { cwd, rules: 'activation', rootSource });
  } catch (error) {
    if (ConfigErrors.is(error, 'invalid_syntax')) {
      return { modules: [absolute], activation: undefined };
    }
    throw error;
  }
}

/** Parse the definition's environment and call its config function. */
function runDefinition(definition: AppDefinition, env: ConfigEnvironment, path: string): unknown {
  let values: Readonly<Record<string, unknown>>;
  try {
    values = parsePluginEnv('app', definition.env, env);
  } catch (error) {
    if (!ConfigErrors.is(error, 'invalid_env')) throw error;
    const { problem, variable, count } = error.context;
    throw new ConfigErrors.Error(
      'invalid_app_env',
      { problem, variable, count },
      { payload: error.payload },
    );
  }
  let result: unknown;
  try {
    result = definition.config(values);
  } catch {
    // The thrown value may embed a variable's value, so only the fact that
    // the function threw is reported.
    throw new ConfigErrors.Error('config_failed', { path });
  }
  if (isObservedThenable(result)) throw new ConfigErrors.Error('async_config', { path });
  return result;
}

/**
 * The environment of a loader handed none: the variables the bin resolved and
 * applied for this process, or, in a process the bin did not start, those
 * resolved for `rootDir` as the bin resolves them, without applying them. The
 * resolver loads only here, so a caller that states its environment (a test,
 * an embedding host) never loads it.
 */
async function defaultEnvironment(rootDir: string): Promise<ConfigEnvironment> {
  const { appliedEnvironment, environmentVariables, resolveEnvironment } =
    await import('../environment/resolve.js');
  return environmentVariables(
    appliedEnvironment() ?? resolveEnvironment({ rootDir, secrets: 'required' }),
  );
}
