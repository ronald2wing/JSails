/**
 * The leak harness: whether opening and closing something many times leaves
 * the process holding more than it did.
 *
 * `measureLeaks(cycle, { cycles, warmup, tolerance })` runs `cycle` `warmup`
 * times (module loads, lazily built singletons and pools settle there), takes
 * a snapshot, runs it `cycles` more times and takes another. A snapshot counts
 * the process's active resources by kind (`process.getActiveResourcesInfo()`:
 * timers, sockets, servers, file handles, child processes) and its listeners
 * per event (`process.eventNames()`), so a plugin that leaves a timer, a
 * connection or a `SIGTERM` handler behind each time grows one of them by
 * about `cycles`. A kind that grew by more than `tolerance` (default 2: an
 * idle keep-alive or a timer of the runtime itself may come and go) is a
 * leak; the report names each kind and its growth.
 *
 * `measurePluginLeaks(entries, options)` is the plugin case: each cycle runs
 * a fresh set of plugin instances and closes them. When the roles include
 * `web` it creates an application with them (`createApplication`), serves it
 * on an ephemeral loopback port, answers one request and closes it, so what
 * a plugin attaches to the HTTP server (an `onServe` hook's socket server) is
 * measured with its units; otherwise it opens them through the kernel stages
 * (`openServices`, then `start`) and shuts the kernel down. Setup is
 * connection-free and a unit's resources are its own to release, so a plugin
 * that passes holds nothing once its kernel shut down.
 */

import { get } from 'node:http';

import { createApplication } from '../app/application.js';
import type { ExtensionEntry } from '../extensions/extension.js';
import { createLoadedApp } from '../kernel/load-app.js';
import { openServices } from '../kernel/open-services.js';
import type { PluginGraph } from '../kernel/resolve-plugins.js';
import { start, type Kernel } from '../kernel/start.js';
import { isPluginInstance, type PluginInstance } from '../plugins/contract/instance.js';
import type { PluginRole } from '../plugins/contract/lifecycle.js';

/**
 * Options for {@link measureLeaks}.
 *
 * @public
 */
export interface LeakOptions {
  /** Measured cycles. Defaults to 50. */
  readonly cycles?: number;
  /** Cycles run before the first snapshot. Defaults to 5. */
  readonly warmup?: number;
  /** Growth of one kind tolerated before it counts as a leak. Defaults to 2. */
  readonly tolerance?: number;
}

/**
 * What {@link measureLeaks} found.
 *
 * @public
 */
export interface LeakReport {
  /** The measured cycles. */
  readonly cycles: number;
  /**
   * Each kind that grew, by how much: `resource:<kind>` for an active
   * resource, `listener:<event>` for a process listener.
   */
  readonly growth: Readonly<Record<string, number>>;
  /** Whether some kind grew by more than the tolerance. */
  readonly leaked: boolean;
}

/**
 * Options for {@link measurePluginLeaks}.
 *
 * @public
 */
export interface PluginLeakOptions extends LeakOptions {
  /** The absolute application root every setup receives. */
  readonly rootDir: string;
  /**
   * The roles the plugins are opened and started for. Defaults to `web` and
   * `worker`. With `web` among them every cycle serves the plugins too.
   */
  readonly roles?: readonly PluginRole[];
  /** The environment the plugins' variables are read from. Defaults to the process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The process's resources by kind and its listeners by event. */
function snapshot(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const kind of process.getActiveResourcesInfo()) {
    const key = `resource:${kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const event of process.eventNames()) {
    counts.set(`listener:${String(event)}`, process.listenerCount(event));
  }
  return counts;
}

/** A positive integer option, or its default. */
function count(value: number | undefined, fallback: number, label: string, min: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${label} must be an integer of at least ${min}`);
  }
  return value;
}

/**
 * Run `cycle` repeatedly and report what the process holds more of at the end
 * than after the warm-up.
 *
 * @public
 */
export async function measureLeaks(
  cycle: () => Promise<void>,
  options: LeakOptions = {},
): Promise<LeakReport> {
  if (typeof cycle !== 'function') throw new TypeError('measureLeaks requires a cycle function');
  const cycles = count(options.cycles, 50, 'cycles', 1);
  const warmup = count(options.warmup, 5, 'warmup', 0);
  const tolerance = count(options.tolerance, 2, 'tolerance', 0);
  for (let index = 0; index < warmup; index += 1) await cycle();
  const before = snapshot();
  for (let index = 0; index < cycles; index += 1) await cycle();
  // A closed socket or timer leaves the active list on a later turn of the
  // loop, not when its close resolves.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const after = snapshot();
  const growth: Record<string, number> = {};
  let leaked = false;
  for (const [key, value] of after) {
    const grown = value - (before.get(key) ?? 0);
    if (grown <= 0) continue;
    growth[key] = grown;
    if (grown > tolerance) leaked = true;
  }
  return Object.freeze({ cycles, growth: Object.freeze(growth), leaked });
}

/**
 * The origin a served cycle's application states, which serving outside the
 * development and test environments requires.
 */
const SERVED_ORIGIN = 'http://127.0.0.1';

/** Read one response to a GET on a connection of its own, closed after it. */
function requestOnce(url: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false }, (response) => {
      response.resume();
      response.on('end', resolve);
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

/**
 * One served cycle: an application with `instances` (kernel plugins in
 * `plugins.use`, legacy ones in `extensions`), served, asked for its health
 * route (the root without one), and closed.
 */
async function servedCycle(
  instances: readonly ExtensionEntry[],
  roles: readonly PluginRole[],
  options: PluginLeakOptions,
): Promise<void> {
  const use: PluginInstance[] = [];
  const legacy: ExtensionEntry[] = [];
  for (const entry of instances) {
    if (isPluginInstance(entry)) use.push(entry);
    else legacy.push(entry);
  }
  const app = await createApplication(
    createLoadedApp(
      {
        rootDir: options.rootDir,
        host: '127.0.0.1',
        port: 0,
        server: { origin: SERVED_ORIGIN },
        plugins: { use },
        extensions: legacy,
      },
      { cwd: options.rootDir },
    ),
    { roles, purpose: 'test', ...(options.env === undefined ? {} : { env: options.env }) },
  );
  try {
    const { url } = await app.serve();
    await requestOnce(new URL(app.config.healthPath ?? '/', url));
  } finally {
    await app.close();
  }
}

/**
 * Run a fresh set of plugin instances from `entries` and close them,
 * repeatedly (served, when the roles include `web`), and report what the
 * process holds more of at the end.
 *
 * @public
 */
export function measurePluginLeaks(
  entries: () => readonly ExtensionEntry[],
  options: PluginLeakOptions,
): Promise<LeakReport> {
  if (typeof entries !== 'function') {
    throw new TypeError('measurePluginLeaks requires a function returning fresh plugin instances');
  }
  const roles = options.roles ?? ['web', 'worker'];
  if (roles.includes('web')) {
    return measureLeaks(() => servedCycle(entries(), roles, options), options);
  }
  return measureLeaks(async () => {
    const instances = entries();
    const graph: PluginGraph = Object.freeze({
      entries: instances,
      nodes: instances.map((entry) => ({ name: entry.name, origin: 'config' as const })),
      roles,
      mode: 'locked',
      liveOnly: [],
      schemaAuthority: undefined,
    });
    const services = await openServices(graph, {
      rootDir: options.rootDir,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    let kernel: Kernel;
    try {
      kernel = await start(services);
    } catch (error) {
      await services.close();
      throw error;
    }
    const report = await kernel.shutdown();
    if (report.errors.length > 0) {
      throw new AggregateError(report.errors, 'the plugins failed to shut down');
    }
  }, options);
}
