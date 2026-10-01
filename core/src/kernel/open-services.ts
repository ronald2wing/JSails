/**
 * Stage 4 of the kernel pipeline: opening a {@link PluginGraph} into
 * {@link Services}.
 *
 * `openServices` runs every plugin's setup in graph order for the roles the
 * graph names (setup is connection-free: substrate resources open on first
 * use), collects the lifecycle units the plugins register, and validates the
 * lifecycle plan from those declarations (`lifecycle-plan.ts`) before anything
 * starts. Nothing listens and nothing connects: the units are the start
 * stage's (`start.ts`). A refused plan closes what setup opened and fails.
 *
 * `Services` is the stage value: frozen, disposable (`close()`, idempotent,
 * also `Symbol.asyncDispose`), and recognised by the later stage, which takes
 * no other value. `defer(cleanup)` adds a host cleanup (the app's own legacy
 * `setup` hook) that runs before the plugin cleanups.
 */

import type { Awaitable } from '../contracts/awaitable.js';
import { invariant } from '../errors/registry.js';
import { runExtensions, type ExtensionRuntime } from '../extensions/extension.js';
import type { ServiceRegistry } from '../extensions/services.js';
import type { LifecycleRegistration, PluginRole } from '../plugins/contract/lifecycle.js';
import { KernelStageErrors } from './errors.js';
import { planUnits, type PlannedUnit } from './lifecycle-plan.js';
import type { PluginGraph } from './resolve-plugins.js';

/**
 * Why a process opened its services: a label for logs, nothing branches on
 * it.
 *
 * @public
 */
export type ServicesPurpose =
  'serve' | 'worker' | 'export' | 'console' | 'task' | 'test' | 'release';

/**
 * Options for {@link openServices}.
 *
 * @public
 */
export interface OpenServicesOptions {
  /** The absolute application root every setup receives. */
  readonly rootDir: string;
  /** Why the process opens them; a logging label. */
  readonly purpose?: ServicesPurpose;
  /**
   * The environment plugin variables and the mode are read from. Defaults to
   * the process environment.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The plugins of a graph, set up, with their lifecycle plan: stage 4.
 *
 * @public
 */
export interface Services {
  /** The graph the services were opened from. */
  readonly graph: PluginGraph;
  /** The roles the process runs. */
  readonly roles: readonly PluginRole[];
  /** Why the process opened them. */
  readonly purpose: ServicesPurpose | undefined;
  /** The sealed service registry. */
  readonly registry: ServiceRegistry;
  /** The extension runtime: services, hooks and plugin cleanups. */
  readonly runtime: ExtensionRuntime;
  /** Every lifecycle unit the plugins registered, for every role. */
  readonly registrations: readonly LifecycleRegistration[];
  /** The units the process runs, in start order. */
  readonly units: readonly PlannedUnit[];
  /** Whether {@link close} was called. */
  readonly closed: boolean;
  /** Run `cleanup` when the services close, before the plugin cleanups (last deferred first). */
  defer(cleanup: () => Awaitable<void>): void;
  /** Run the deferred cleanups, then every plugin cleanup in reverse; idempotent. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Every Services value this module built and that is not closed yet. */
const live = new WeakSet<Services>();

/** Whether `value` is a Services value openServices built and nothing closed. */
export function isLiveServices(value: unknown): value is Services {
  return typeof value === 'object' && value !== null && live.has(value as Services);
}

/**
 * Open `graph`: run every plugin's setup for the graph's roles and validate
 * the lifecycle units they register. Nothing listens or connects.
 *
 * @public
 */
export async function openServices(
  graph: PluginGraph,
  options: OpenServicesOptions,
): Promise<Services> {
  const runtime = await runExtensions(graph.entries, {
    rootDir: options.rootDir,
    roles: graph.roles,
    units: 'collect',
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  let units: readonly PlannedUnit[];
  try {
    units = planUnits(runtime.units, new Set(graph.roles));
  } catch (error) {
    try {
      await runtime.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'services failed to open', { cause: error });
    }
    throw error;
  }

  const deferred: (() => Awaitable<void>)[] = [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      live.delete(services);
      const errors: unknown[] = [];
      for (const cleanup of deferred.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await runtime.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'services failed to close');
    })();
    return closing;
  };

  const services: Services = Object.freeze({
    graph,
    roles: Object.freeze([...graph.roles]),
    purpose: options.purpose,
    registry: runtime.services,
    runtime,
    registrations: runtime.units,
    units,
    get closed() {
      return closing !== undefined;
    },
    defer(cleanup: () => Awaitable<void>): void {
      invariant(typeof cleanup === 'function', KernelStageErrors, 'invalid_cleanup');
      invariant(closing === undefined, KernelStageErrors, 'invalid_stage', { stage: 'defer' });
      deferred.push(cleanup);
    },
    close,
    [Symbol.asyncDispose]: close,
  });
  live.add(services);
  return services;
}
