/**
 * The stages the dispatcher runs to satisfy a command's `needs`, and their
 * teardown.
 *
 * `environment` resolves the command's environment and applies it to
 * `process.env` (`environment/resolve.ts`). The app levels build on it: `app`
 * installs the bare-name globals and loads the app config, `plugins` resolves
 * its plugin graph, `{ services }` sets the plugins up, `{ kernel }` starts
 * their units. {@link openStages} returns what it opened with one `close`,
 * which tears down the last stage first and rejects with whatever that
 * teardown failed at (a kernel's shutdown report included); a stage that
 * fails to open closes the ones before it, and a failure of that close
 * travels with the opening failure rather than replacing it. Each stage imports its module when it runs, so a
 * command that needs only the environment loads no kernel.
 */

import { dirname, resolve } from 'node:path';

import type { ResolvedEnvironment, SecretsRequirement } from '../environment/resolve.js';
import type { LoadedApp } from '../kernel/load-app.js';
import type { Services } from '../kernel/open-services.js';
import type { PluginGraph } from '../kernel/resolve-plugins.js';
import type { Kernel, ShutdownReport } from '../kernel/start.js';
import type { PluginRole } from '../plugins/contract/lifecycle.js';
import type { CommandNeeds } from './descriptor.js';

/** What {@link resolveCommandEnvironment} takes. */
export interface EnvironmentRequest {
  readonly rootDir: string;
  /** The name `--env` chose. */
  readonly name: string | undefined;
  /** The command's own default name (`test`). */
  readonly defaultName: string | undefined;
  readonly secrets: SecretsRequirement;
}

/** Resolve a command's environment and apply it to `process.env`. */
export async function resolveCommandEnvironment(
  request: EnvironmentRequest,
): Promise<ResolvedEnvironment> {
  const { applyEnvironment, resolveEnvironment } = await import('../environment/resolve.js');
  const resolved = resolveEnvironment({
    rootDir: request.rootDir,
    name: request.name,
    ...(request.defaultName === undefined ? {} : { defaultName: request.defaultName }),
    secrets: request.secrets,
  });
  applyEnvironment(resolved);
  return resolved;
}

/** The variables a resolution hands to the command. */
export async function commandVariables(
  resolved: ResolvedEnvironment,
): Promise<Readonly<Record<string, string | undefined>>> {
  const { environmentVariables } = await import('../environment/resolve.js');
  return environmentVariables(resolved);
}

/**
 * Install the framework globals, then the project's generated ones from
 * `rootDir`'s `.jsails/`. A bare identifier in app code (`ApplicationRecord`,
 * a user's `Author`) resolves against `globalThis` when its module evaluates,
 * so both sets precede any app import.
 */
export async function installGlobals(rootDir: string): Promise<void> {
  const { installFrameworkSymbols, installProjectSymbols } =
    await import('../symbols/install-server.js');
  await installFrameworkSymbols(rootDir);
  await installProjectSymbols(rootDir);
}

/**
 * Install the globals a legacy config module (`jsails.database.js`,
 * `jsails.runtime.js`, `jsails.seed.js`) and what it imports may reference by
 * bare name, from the directory the module lives in; resolves with the path.
 */
export async function prepareConfigModule(cwd: string, configPath: string): Promise<string> {
  await installGlobals(dirname(resolve(cwd, configPath)));
  return configPath;
}

/** The stages a command's needs opened. */
export interface OpenedStages {
  readonly app?: LoadedApp;
  readonly graph?: PluginGraph;
  readonly services?: Services;
  readonly kernel?: Kernel;
  /** Tear down what was opened, last stage first; idempotent. */
  close(): Promise<void>;
}

/** What {@link openStages} takes besides the needs. */
export interface StageRequest {
  /** The working directory, which a relative config path resolves against. */
  readonly cwd: string;
  /** The app config module, relative to `cwd`. */
  readonly configPath: string;
  /** The resolved environment's variables, which plugin setup reads. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

function rolesOf(needs: CommandNeeds): readonly PluginRole[] | undefined {
  if (typeof needs === 'string') return undefined;
  return 'services' in needs ? needs.services : needs.kernel;
}

/**
 * Throw what a kernel shutdown reports having failed at: a shutdown resolves
 * with its failures rather than rejecting, and a stage close that resolved
 * over them would swallow them.
 */
function throwShutdownErrors(report: ShutdownReport): void {
  const { errors } = report;
  if (errors.length > 1) throw new AggregateError(errors, 'the kernel shutdown failed');
  if (errors.length === 1) throw errors[0];
}

/** Open the app stages `needs` asks for; `nothing` and `environment` open none. */
export async function openStages(
  needs: CommandNeeds,
  request: StageRequest,
): Promise<OpenedStages> {
  const closed: OpenedStages = { close: () => Promise.resolve() };
  if (needs === 'nothing' || needs === 'environment') return closed;

  const configFile = resolve(request.cwd, request.configPath);
  await installGlobals(dirname(configFile));
  const { loadApp } = await import('../kernel/load-app.js');
  const app = await loadApp({ configPath: request.configPath, cwd: request.cwd });
  if (needs === 'app') return { app, close: closed.close };

  const { resolvePlugins } = await import('../kernel/resolve-plugins.js');
  const roles = rolesOf(needs);
  const graph = await resolvePlugins(app, roles === undefined ? {} : { roles });
  if (needs === 'plugins') return { app, graph, close: closed.close };

  const { openServices } = await import('../kernel/open-services.js');
  const services = await openServices(graph, {
    rootDir: app.config.rootDir,
    purpose: 'task',
    env: request.env,
  });
  if ('services' in needs) return { app, graph, services, close: () => services.close() };

  const { start } = await import('../kernel/start.js');
  let kernel: Kernel;
  try {
    kernel = await start(services);
  } catch (error) {
    try {
      await services.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'the kernel failed to start', {
        cause: error,
      });
    }
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    app,
    graph,
    services,
    kernel,
    close: () => {
      stopping ??= kernel.shutdown().then(throwShutdownErrors);
      return stopping;
    },
  };
}
