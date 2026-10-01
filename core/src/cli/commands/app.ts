/**
 * App commands: `build` (static export into the configured output directory),
 * `serve` (the web role, and with `--with worker` the worker role too, until
 * SIGINT/SIGTERM), and `dev` (compile + watch + serve, with the worker role
 * in the served process). Host, port, and output directory are set in the app
 * config, not via flags.
 *
 * `build` and `serve` need the app stage: the dispatcher loads the app config
 * (`--config`, default `jsails.app.js`) and hands it over. `serve`'s
 * preflight refuses an unsupported platform before that, so a refused
 * platform loads no config. Each step imports what it runs when it runs: the
 * application assembler once an app is built, and the development toolchain
 * only for `dev`, whose own process never assembles an app (its serve child
 * does).
 */

import type { Application, CreateApplicationOptions } from '../../app/application.js';
import type { ResolvedAppConfig } from '../../app/config/index.js';
import { AppConfigError } from '../../app/config/errors.js';
import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/defaults.js';
import type { DevOptions } from '../../dev/runtime.js';
import type { GenerateStaticSiteResult } from '../../pages/static-site/index.js';

import type { LoadedApp } from '../../kernel/load-app.js';
import type { PluginRole } from '../../plugins/contract/lifecycle.js';
import type { CommandInvocation, CommandModule } from '../descriptor.js';
import type { APP_CONFIG_OPTIONS, SERVE_OPTIONS } from '../manifest.js';
import { isJsailsError } from '../../errors/jsails-error.js';
import { isRegistryError } from '../../errors/registry.js';
import { waitForShutdownSignal, type ShutdownSignal } from '../shutdown.js';
import { assertServeSupported } from '../platform-guard.js';

/**
 * Dependency seam for the app commands. Tests inject fakes so no HTTP server is
 * bound and no config module is imported; the defaults are the real factories.
 */
export interface AppDeps {
  createApplication(
    source: LoadedApp | ResolvedAppConfig,
    options?: CreateApplicationOptions,
  ): Promise<Application>;
  /** Install SIGINT/SIGTERM handlers: the first resolves, the second aborts the drain. */
  waitForShutdown?(): ShutdownSignal;
}

const defaultAppDeps: AppDeps = {
  async createApplication(source, options) {
    const { createApplication } = await import('../../app/application.js');
    return createApplication(source, options);
  },
  waitForShutdown: waitForShutdownSignal,
};

/**
 * Report one completed static build: outputs written, routes skipped, and
 * every page whose `load` answered not-found (nothing written, so it is
 * missing from the deployed site) or a redirect (which the host serves only
 * once `redirects.json` is translated into its rules), each named.
 */
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
  if (result.liveOnly.length > 0) {
    console.log(
      `Skipped ${result.liveOnly.length} live-only page(s): a page whose access is not public, or that only streams, is served by the live server alone.`,
    );
  }
  if (result.notFound.length > 0) {
    console.log(
      `Wrote nothing for ${result.notFound.length} page(s) whose load answered not-found:`,
    );
    for (const route of result.notFound) console.log(`  ${route}`);
  }
  if (result.redirects.length > 0) {
    console.log(
      `Recorded ${result.redirects.length} redirect(s) in redirects.json, each with a fallback document at its path; translate the table into your host's redirect rules:`,
    );
    for (const { from, status } of result.redirects) console.log(`  ${from} (${status})`);
  }
}

/**
 * `build`: assemble the app, render the static site, and close. The app is
 * closed exactly once in a `finally`, whether the build succeeds or throws. A
 * failed `createApplication` owns nothing the CLI must close (its extensions
 * are already torn down by the assembler).
 */
async function runBuildCommand(
  source: LoadedApp | ResolvedAppConfig,
  deps: AppDeps,
): Promise<number> {
  // A static build runs the declared plugins only: managed plugins live in
  // the database and cannot be activated without a live connection. `serve`
  // keeps them.
  const app = await deps.createApplication(source, { safeMode: true });
  try {
    printBuildResult(await app.build());
  } finally {
    await app.close();
  }
  return 0;
}

/** Options of `serve`. */
export interface ServeCommandOptions {
  /** Roles run beside `web` (`--with worker`). */
  readonly with?: readonly PluginRole[];
}

/**
 * `serve`: install shutdown signal handlers, assemble the app for the web role
 * (plus `--with` roles), listen, print the actual URL, and wait for
 * SIGINT/SIGTERM before closing.
 *
 * Signal handlers are installed before `createApplication` so a signal arriving
 * during startup (extension setup, unit start or listen) is captured and leads
 * to a clean shutdown instead of the default immediate termination. The first
 * signal drains under the app's `shutdownTimeoutMs`; a second one aborts
 * whatever is still draining. The handlers are disposed on every path
 * (shutdown and startup failure), and never at import time. The app is closed
 * exactly once in the `finally`.
 */
async function runServeCommand(
  config: LoadedApp | ResolvedAppConfig,
  deps: AppDeps,
  options: ServeCommandOptions,
): Promise<number> {
  const signal = (deps.waitForShutdown ?? waitForShutdownSignal)();
  let app: Application | undefined;
  try {
    app = await deps.createApplication(config, {
      roles: ['web', ...(options.with ?? []).filter((role) => role !== 'web')],
      purpose: 'serve',
    });
    const handle = await app.serve();
    console.log(`Serving at ${handle.url}`);
    await signal.promise;
  } finally {
    // The handlers stay installed while the app drains, so a second signal
    // aborts the drain instead of killing the process mid-cleanup.
    try {
      await app?.close({ signal: signal.abort });
    } finally {
      signal.dispose();
    }
  }
  return 0;
}

/**
 * Run an app command (`build` / `serve`) over a loaded app with the given
 * dependencies. Exported for tests: inject fake factories to exercise
 * lifecycle, close ordering, and signal disposal without a real server.
 */
export async function runAppCommand(
  command: 'build' | 'serve',
  source: LoadedApp | ResolvedAppConfig,
  deps: AppDeps = defaultAppDeps,
  options: ServeCommandOptions = {},
): Promise<number> {
  if (command === 'build') {
    return runBuildCommand(source, deps);
  }
  return runServeCommand(source, deps, options);
}

/**
 * What `serve` checks before its config loads: its arguments first (`--with`
 * names only `worker`, a usage error otherwise), then the platform (on
 * Windows only the development and test environments are served,
 * `unsupported_platform` otherwise).
 */
export function servePreflight(
  context: CommandInvocation<typeof SERVE_OPTIONS>,
  platform: NodeJS.Platform = process.platform,
): number | void {
  const roles = context.values.with ?? [];
  if (roles.some((role) => role !== 'worker')) {
    return context.usage('--with takes worker, the one role serve can add');
  }
  assertServeSupported(platform, context.env['NODE_ENV']);
}

/** `jsails build`. */
export const buildCommand: CommandModule<typeof APP_CONFIG_OPTIONS, 'app'> = {
  run: (context) => runAppCommand('build', context.app),
};

/** `jsails serve [--with worker]`. */
export const serveCommand: CommandModule<typeof SERVE_OPTIONS, 'app'> = {
  preflight: (context) => servePreflight(context),
  run: (context) =>
    runAppCommand('serve', context.app, defaultAppDeps, {
      with: (context.values.with ?? []).length === 0 ? [] : ['worker'],
    }),
};

/** Options for {@link reportAppFailure}. */
export interface AppFailureReportOptions {
  /** The environment `JSAILS_DEBUG` is read from: the command's. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The directory paths are shown relative to. Defaults to the working directory. */
  readonly cwd?: string;
}

/**
 * Report an app-command failure to `write` and resolve with exit code 1.
 * Framework errors carry value-free messages and are echoed; anything else (an
 * extension `setup`, a custom renderer, an API module) is untrusted user code
 * whose message may embed a payload or credentials, so it is replaced with a
 * generic line. Either way the cause chain follows, value-free unless
 * `JSAILS_DEBUG=1` is set: a config that failed to import says why.
 */
export async function reportAppFailure(
  error: unknown,
  write: (line: string) => void,
  options: AppFailureReportOptions,
): Promise<number> {
  const [valueFree, { writeFailure }] = await Promise.all([
    isValueFreeError(error),
    import('../report.js'),
  ]);
  await writeFailure(error, write, {
    ...options,
    allow: () => valueFree,
    fallback: 'the application command failed',
  });
  return 1;
}

/**
 * Whether `error`'s message is value-free by construction: a registry error,
 * or one of the hand-written framework errors whose messages are fixed text.
 * The route, page, and static-site errors live in the modules that assembling
 * and building load; a failure before assembly (a config error, a refused
 * platform) is decided without importing them, and anything that is not a
 * framework error at all never needs them.
 */
async function isValueFreeError(error: unknown): Promise<boolean> {
  if (isRegistryError(error) || error instanceof AppConfigError) return true;
  if (!isJsailsError(error)) return false;
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
 * `dev`: lazily invoke the development toolchain with the config path. No
 * host/port/output flags are accepted; those live in the app config. The
 * toolchain starts here, never at import time.
 */
export async function runDevCommand(
  configPath: string,
  deps: DevCommandDeps = defaultDevCommandDeps,
): Promise<number> {
  return deps.runDev({ configPath });
}

/**
 * `jsails dev`. It opens no app stage of its own (its serve child assembles
 * the app), so it reports its failures the way the app stages are reported.
 */
export const devCommand: CommandModule<typeof APP_CONFIG_OPTIONS, 'environment'> = {
  async run(context) {
    try {
      return await runDevCommand(context.values.config ?? DEFAULT_APP_CONFIG_PATH);
    } catch (error) {
      return reportAppFailure(error, (line) => context.stderr(line), {
        env: context.env,
        cwd: context.cwd,
      });
    }
  },
};
