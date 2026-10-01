/**
 * `testPlugin`: run one plugin instance's setup the way the application runner
 * does, and prove it inert.
 *
 * The harness takes the steps of `plugins/contract/host.ts`, the module the
 * runner uses, so it checks exactly what the runner runs: it validates the
 * instance's environment variables (from the test, never from the process
 * environment), asks for its substrate declaration, registers the substrate
 * resources as lazy handles, and runs setup with the declared-only service
 * view, with the services the test passes standing in for the plugin's
 * requirements. The substrate declaration, the setup module's evaluation and
 * setup itself run under the traps of `setup-traps.ts`: a socket, a listener,
 * a name lookup, a fetch, a file write, a subprocess, a recurring timer, or
 * opening a substrate resource fails the run with
 * `plugin_harness.inert_violation`, even when the setup caught what the trap
 * threw. Lifecycle units are recorded for every role, never started. The
 * instance gets the HTTP registrar a code plugin gets from the runner, and
 * what it registered is returned; the process's mode is derived from the
 * test's environment as the runner derives it from the process's.
 *
 * Setup must also leave nothing behind. When it resolves, every one-shot timer
 * or immediate it scheduled and that is still pending is cancelled and fails
 * the run, so the result never depends on how soon the test closes it; the
 * harness then lets one macrotask turn pass, so promise chains setup did not
 * await run under the traps, and fails the run on what they did or scheduled.
 * A side effect such work commits later, while the run is open, is recorded
 * and fails `close()`.
 */

import { resolve } from 'node:path';

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import type { LazyResource } from '../extensions/lazy-resource.js';
import {
  createServiceRegistry,
  type ServiceRegistry,
  type ServiceToken,
} from '../extensions/services.js';
import { readPluginMode } from '../plugins/contract/env-variables.js';
import {
  declareSubstrate,
  openSubstrate,
  readPluginEnv,
  runPluginSetup,
} from '../plugins/contract/host.js';
import {
  isPluginInstance,
  type PluginCleanup,
  type PluginInstance,
  type SubstrateResource,
} from '../plugins/contract/instance.js';
import type { LifecycleRegistration, PluginRole } from '../plugins/contract/lifecycle.js';
import {
  createHttpRoutes,
  type HttpContributions,
  type HttpRoutesRegistrar,
} from '../server/http-routes.js';
import {
  acquireSetupTraps,
  cancelDeferredWork,
  endSetup,
  trapSideEffect,
  watchSetup,
  type SetupProbe,
  type SetupViolation,
} from './setup-traps.js';

const PLUGIN_HARNESS_ERRORS = {
  not_a_plugin: {
    kind: 'internal',
    message: 'testPlugin takes a plugin instance, the value a definePlugin factory returns',
  },
  inert_violation: {
    kind: 'internal',
    message:
      'plugin {plugin} is not inert: its setup used {operation} ({kind}); {count} violations in all',
    context: {
      plugin: 'identifier',
      operation: 'identifier',
      kind: ['network', 'fs_write', 'subprocess', 'timer', 'substrate'],
      count: 'count',
    },
    suggestion:
      'open connections in a substrate resource, and schedule no work from setup: it only wires services',
  },
} as const;

/**
 * The plugin harness's codes, `plugin_harness.*`: a value that is not a plugin
 * instance, and a setup that is not inert. The context names the plugin and a
 * fixed operation, never an argument.
 *
 * @public
 */
export const PluginHarnessErrors: ErrorRegistry<'plugin_harness', typeof PLUGIN_HARNESS_ERRORS> =
  defineErrors('plugin_harness', PLUGIN_HARNESS_ERRORS);

/**
 * Options for {@link testPlugin}.
 *
 * @public
 */
export interface TestPluginOptions {
  /** Services registered before setup: stand-ins for what the plugin requires. */
  readonly services?: Iterable<readonly [ServiceToken<unknown>, unknown]>;
  /**
   * The environment the plugin's declared variables, and the mode its setup
   * sees (`NODE_ENV`: `development`, `test`, else `production`), are read
   * from. Defaults to none, so the mode is `production`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The roles the run reports to setup. Defaults to none. */
  readonly roles?: readonly PluginRole[];
  /** The absolute application root substrate and setup receive. Defaults to a path that does not exist. */
  readonly rootDir?: string;
}

/**
 * A finished, inert setup.
 *
 * @public
 */
export interface PluginTestRun {
  /** Every registered service: the stand-ins, the substrate handles, and what setup provided. */
  readonly services: ServiceRegistry;
  /** The tokens setup provided, in order. */
  readonly provided: readonly ServiceToken<unknown>[];
  /** The tokens of the substrate resources the plugin declared, none of them opened. */
  readonly substrate: readonly ServiceToken<unknown>[];
  /** The lifecycle units setup registered, for any role, none of them started. */
  readonly units: readonly LifecycleRegistration[];
  /** The routes, mounts, guards and transforms setup registered, none of them served. */
  readonly http: HttpContributions;
  /**
   * Run setup's cleanup and close the opened substrate resources; then fail
   * with `plugin_harness.inert_violation` if work setup left running committed
   * a side effect since the run returned. Idempotent.
   */
  close(): Promise<void>;
}

const DEFAULT_ROOT = resolve('/', 'jsails-plugin-harness');

const EMPTY_HTTP: HttpContributions = Object.freeze({
  routes: Object.freeze([]),
  transforms: Object.freeze([]),
  guards: Object.freeze([]),
});

function violationError(plugin: string, violations: readonly SetupViolation[]): Error {
  const first = violations[0]!;
  return new PluginHarnessErrors.Error('inert_violation', {
    plugin,
    operation: first.operation,
    kind: first.kind,
    count: violations.length,
  });
}

/** Substrate resources whose `create` is a trapped side effect while setup runs. */
function trappedSubstrate(
  resources: readonly SubstrateResource<unknown>[],
): readonly SubstrateResource<unknown>[] {
  return resources.map((resource) =>
    Object.freeze({
      token: resource.token,
      create: () => {
        trapSideEffect('substrate', 'substrate.open');
        return resource.create();
      },
      close: (value: unknown) => resource.close(value),
    }),
  );
}

/** Let one macrotask turn pass, so every promise chain already queued runs to its end. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function closeAll(
  cleanup: PluginCleanup | undefined,
  opened: readonly LazyResource<unknown>[],
): Promise<void> {
  const errors: unknown[] = [];
  if (cleanup !== undefined) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const resource of [...opened].reverse()) {
    try {
      await resource.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'plugin test cleanup failed');
}

/**
 * Run `instance`'s setup in isolation and prove it inert. Throws what the
 * runner would throw (`config.invalid_env`, `plugin.missing_service`,
 * `plugin.missing_provision`, ...) or `plugin_harness.inert_violation`; on
 * any failure the setup's cleanup has run and the opened resources are
 * closed.
 *
 * @public
 */
export async function testPlugin(
  instance: PluginInstance,
  options: TestPluginOptions = {},
): Promise<PluginTestRun> {
  if (!isPluginInstance(instance)) throw new PluginHarnessErrors.Error('not_a_plugin');
  const plugin = instance.name;
  const release = acquireSetupTraps();
  const probe: SetupProbe = {
    plugin,
    violations: [],
    reject: (violation) => violationError(plugin, [violation]),
    settled: false,
  };
  const controller = createServiceRegistry();
  const opened: LazyResource<unknown>[] = [];
  const provided: ServiceToken<unknown>[] = [];
  const units: LifecycleRegistration[] = [];
  let registrar: HttpRoutesRegistrar | undefined;
  let substrate: readonly SubstrateResource<unknown>[] = [];
  let cleanup: PluginCleanup | undefined;
  try {
    for (const [token, value] of options.services ?? []) controller.registrar.provide(token, value);
    const env = readPluginEnv(instance, options.env ?? {});
    const rootDir = options.rootDir ?? DEFAULT_ROOT;
    substrate = watchSetup(probe, () => declareSubstrate(instance, env, rootDir));
    opened.push(...openSubstrate(controller.registrar, trappedSubstrate(substrate)));
    const registry = {
      ...controller.registrar,
      provide<T>(token: ServiceToken<T>, value: T): void {
        controller.registrar.provide(token, value);
        provided.push(token);
      },
    };
    cleanup = await watchSetup(probe, () =>
      runPluginSetup(instance, env, substrate, {
        registry,
        roles: new Set(options.roles ?? []),
        mode: readPluginMode(options.env ?? {}),
        rootDir,
        registerUnit: (registration) => {
          units.push(registration);
        },
        routes: (owner) => {
          registrar = createHttpRoutes({
            owner: owner.name,
            origin: 'code-plugin',
            allow: { mount: true, guard: true, transform: true },
          });
          return registrar.routes;
        },
        run: (call) => call(),
      }),
    );
    endSetup(probe);
    await settle();
    cancelDeferredWork(probe);
    if (probe.violations.length > 0) throw violationError(plugin, probe.violations);
  } catch (error) {
    endSetup(probe);
    cancelDeferredWork(probe);
    let cleanupError: unknown;
    try {
      await closeAll(cleanup, opened);
    } catch (caught) {
      cleanupError = caught;
    }
    controller.clear();
    release();
    // A trap's error may have been caught and replaced by setup; the recorded
    // violation is the failure either way.
    const primary = probe.violations.length > 0 ? violationError(plugin, probe.violations) : error;
    if (cleanupError === undefined) throw primary;
    throw new AggregateError([primary, cleanupError], 'plugin setup failed', { cause: primary });
  }
  controller.seal();

  let closing: Promise<void> | undefined;
  return Object.freeze({
    services: controller.services,
    provided: Object.freeze([...provided]),
    substrate: Object.freeze(substrate.map((resource) => resource.token)),
    units: Object.freeze([...units]),
    http: registrar?.contributions() ?? EMPTY_HTTP,
    close(): Promise<void> {
      closing ??= (async () => {
        let cleanupFailure: { readonly error: unknown } | undefined;
        try {
          await closeAll(cleanup, opened);
        } catch (error) {
          cleanupFailure = { error };
        } finally {
          cancelDeferredWork(probe);
          controller.clear();
          release();
        }
        // The run returned with no violation, so any recorded now came from
        // work setup left running.
        if (probe.violations.length > 0) {
          const late = violationError(plugin, probe.violations);
          if (cleanupFailure === undefined) throw late;
          throw new AggregateError([late, cleanupFailure.error], 'plugin test cleanup failed', {
            cause: late,
          });
        }
        if (cleanupFailure !== undefined) throw cleanupFailure.error;
      })();
      return closing;
    },
  });
}
