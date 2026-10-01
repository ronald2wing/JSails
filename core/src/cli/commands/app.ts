/**
 * App commands: `build` (static export into the configured output directory),
 * `serve` (HTTP server until SIGINT/SIGTERM), and `dev` (compile + watch +
 * serve). Their config module defaults to `jsails.app.js` and default-exports
 * an app config object; host, port, and output directory are set in the config,
 * not via extra flags.
 *
 * Each step imports what it runs when it runs: the config loader (and Zod)
 * once a config is read, the application assembler once an app is built, and
 * the development toolchain only for `dev`, whose own process never assembles
 * an app (its serve child does). A refused platform therefore loads neither.
 */

import type { Application } from '../../app/application.js';
import type { ResolvedAppConfig } from '../../app/config/index.js';
import { AppConfigError } from '../../app/config/errors.js';
import type { DevOptions } from '../../dev/runtime.js';
import type { GenerateStaticSiteResult } from '../../pages/static-site/index.js';

import { formatError } from '../../errors/inspect.js';
import { loadAppConfig } from '../config-loader.js';
import { JsailsError } from '../../errors/jsails-error.js';
import { waitForShutdownSignal, type ShutdownSignal } from '../shutdown.js';
import { assertServeSupported, UnsupportedPlatformError } from '../platform-guard.js';

/**
 * Dependency seam for the app commands. Tests inject fakes so no HTTP server is
 * bound and no config module is imported; the defaults are the real factories.
 */
export interface AppDeps {
  loadConfig(configPath: string): Promise<ResolvedAppConfig>;
  createApplication(config: ResolvedAppConfig): Promise<Application>;
  /** Install SIGINT/SIGTERM handlers and resolve on the first signal. */
  waitForShutdown?(): ShutdownSignal;
  /** The platform `serve` checks its scope against; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** The `NODE_ENV` `serve` runs under; defaults to `process.env.NODE_ENV`. */
  readonly nodeEnv?: string | undefined;
}

const defaultAppDeps: AppDeps = {
  loadConfig: (configPath) => loadAppConfig(configPath),
  async createApplication(config) {
    const { createApplication } = await import('../../app/application.js');
    return createApplication(config);
  },
  waitForShutdown: waitForShutdownSignal,
};

/** Report one completed static build: outputs written plus any skipped APIs. */
function printBuildResult(result: GenerateStaticSiteResult): void {
  const outputs = result.written.length + result.copied.length + result.raw.length;
  console.log(
    `Built ${outputs} output file(s) (${result.written.length} page(s), ${result.copied.length} asset(s), ${result.raw.length} generated file(s)).`,
  );
  if (result.skipped.length > 0) {
    console.log(
      `Skipped ${result.skipped.length} API route(s): a static site build does not serve API routes.`,
    );
  }
}

/**
 * `build`: load the config, assemble the app, render the static site, and close.
 * The app is closed exactly once in a `finally`, whether the build succeeds or
 * throws. A failed `createApplication` owns nothing the CLI must close (its
 * extensions are already torn down by the assembler).
 */
async function runBuildCommand(configPath: string, deps: AppDeps): Promise<number> {
  const config = await deps.loadConfig(configPath);
  // Static export is always non-managed: managed plugins live in the DB and
  // cannot be activated without a live connection. `serve` keeps them.
  const buildConfig =
    config.plugins?.managed === true
      ? {
          ...config,
          plugins: { ...config.plugins, managed: false, stateSource: undefined },
        }
      : config;
  const app = await deps.createApplication(buildConfig);
  try {
    printBuildResult(await app.build());
  } finally {
    await app.close();
  }
  return 0;
}

/**
 * `serve`: load the config, install shutdown signal handlers, assemble the app,
 * listen, print the actual URL, and wait for SIGINT/SIGTERM before closing.
 *
 * Signal handlers are installed before `createApplication` so a signal arriving
 * during startup (extension setup or listen) is captured and leads to a clean
 * shutdown instead of the default immediate termination. They are disposed on
 * every path (shutdown, startup failure, and config failure), and never at
 * import time. The app is closed exactly once in the `finally`.
 *
 * On Windows only the development and test environments are served
 * (`unsupported_platform` otherwise, before the config is loaded).
 */
async function runServeCommand(configPath: string, deps: AppDeps): Promise<number> {
  assertServeSupported(
    deps.platform ?? process.platform,
    'nodeEnv' in deps ? deps.nodeEnv : process.env.NODE_ENV,
  );
  const config = await deps.loadConfig(configPath);
  const signal = (deps.waitForShutdown ?? waitForShutdownSignal)();
  let app: Application | undefined;
  try {
    app = await deps.createApplication(config);
    const handle = await app.serve();
    console.log(`Serving at ${handle.url}`);
    await signal.promise;
  } finally {
    signal.dispose();
    if (app !== undefined) {
      await app.close();
    }
  }
  return 0;
}

/**
 * Dispatch an app command (`build` / `serve`) with the given dependencies.
 * Exported for tests: inject fake factories to exercise lifecycle, close
 * ordering, and signal disposal without a real server or config module.
 */
export async function runAppCommand(
  command: 'build' | 'serve',
  configPath: string,
  deps: AppDeps = defaultAppDeps,
): Promise<number> {
  if (command === 'build') {
    return runBuildCommand(configPath, deps);
  }
  return runServeCommand(configPath, deps);
}

/**
 * Sanitize an app-command failure for the CLI. Framework errors carry value-free
 * messages and are echoed; anything else (an extension `setup`, a custom
 * renderer, an API module) is untrusted user code whose message may embed a
 * payload or credentials, so it is replaced with a generic message.
 */
export async function formatAppError(error: unknown): Promise<string> {
  const valueFree = await isValueFreeError(error);
  return formatError(error, { allow: () => valueFree, fallback: 'the application command failed' });
}

/**
 * Whether `error` is one of the errors whose messages are value-free by
 * construction. The route, page, and static-site errors live in the modules
 * that assembling and building load; a failure before assembly (a config
 * error, a refused platform) is decided without importing them, and anything
 * that is not a framework error at all never needs them.
 */
async function isValueFreeError(error: unknown): Promise<boolean> {
  if (error instanceof AppConfigError || error instanceof UnsupportedPlatformError) return true;
  if (!(error instanceof JsailsError)) return false;
  const [{ RouteManifestError }, { StaticSiteError }, { PageRenderError }] = await Promise.all([
    import('../../routing/routes.js'),
    import('../../pages/static-site/index.js'),
    import('../../pages/page.js'),
  ]);
  return (
    error instanceof RouteManifestError ||
    error instanceof StaticSiteError ||
    error instanceof PageRenderError
  );
}

/** Dependency seam for the `dev` command: inject a fake toolchain for tests. */
export interface DevCommandDeps {
  runDev(options: DevOptions): Promise<number>;
}

const defaultDevCommandDeps: DevCommandDeps = {
  async runDev(options) {
    const { runDev } = await import('../../dev/runtime.js');
    return runDev(options);
  },
};

/**
 * `dev`: lazily invoke the development toolchain with the resolved config path.
 * No host/port/output flags are accepted; those live in the app config. The
 * toolchain starts here, never at import time.
 */
export async function runDevCommand(
  configPath: string,
  deps: DevCommandDeps = defaultDevCommandDeps,
): Promise<number> {
  return deps.runDev({ configPath });
}
