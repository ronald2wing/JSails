/**
 * Stage 5 of the kernel pipeline: starting the lifecycle units of
 * {@link Services} into a running {@link Kernel}, and shutting it down.
 *
 * `start(services, { units })` starts the plugin units of the process's roles
 * in their planned order, with any host units the caller passes judged with
 * them by the same plan rules. A unit whose
 * start throws aborts every unit already started, last first, and the start
 * fails; the services stay open for their owner to close.
 *
 * `kernel.adopt(unit)` starts a unit after the kernel (an HTTP listener once
 * its serve hooks ran): it depends on every unit started before it, so it
 * drains first. Its handle's `release()` drains it alone and forgets it (a
 * listener whose accept failed), so the kernel never reports it again.
 *
 * `kernel.shutdown({ deadlineMs, signal })` drains under one shared deadline.
 * A unit drains once every unit depending on it has drained, so dependents go
 * first and independent units drain together. Each `drain` receives the
 * deadline signal. When the deadline passes or `signal` aborts (the second
 * SIGINT/SIGTERM), every unit not yet idle is aborted at once, each abort
 * given at most {@link ABORT_GRACE_MS}; a drain that throws is aborted right
 * away. The services close last (their deferred cleanups, then the plugin
 * cleanups). The report says `drained`, or `aborted` with the units that were
 * not idle, and carries every error a drain, an abort or a cleanup threw.
 * Shutting down again returns the first report.
 */

import { invariant } from '../errors/registry.js';
import { isRecord } from '../json/shape.js';
import { PluginErrors } from '../plugins/contract/errors.js';
import {
  checkLifecycleRegistration,
  type LifecycleRegistration,
  type LifecycleTransport,
  type LifecycleUnit,
  type PluginRole,
} from '../plugins/contract/lifecycle.js';
import { KernelStageErrors } from './errors.js';
import { planUnits, type PlannedUnit } from './lifecycle-plan.js';
import { isLiveServices, type Services } from './open-services.js';

/** How long one unit's `abort` may take before the shutdown moves on. */
export const ABORT_GRACE_MS = 1000;

/** The shutdown deadline when none is given. */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 30_000;

/**
 * A unit the host starts beside the plugins', registered as the application's.
 *
 * @public
 */
export interface HostUnit {
  readonly roles: readonly PluginRole[];
  readonly unit: LifecycleUnit;
  readonly after?: readonly string[];
  readonly transport?: LifecycleTransport;
}

/**
 * Options for {@link start}.
 *
 * @public
 */
export interface StartOptions {
  /** Host units, started after the plugin units they do not precede. */
  readonly units?: readonly HostUnit[];
  /** The deadline {@link Kernel.shutdown} uses when called without one. */
  readonly deadlineMs?: number;
}

/**
 * Options for {@link Kernel.shutdown}.
 *
 * @public
 */
export interface ShutdownOptions {
  /** The shared drain deadline, in milliseconds. */
  readonly deadlineMs?: number;
  /** Aborting it cuts the drain short: every unit not idle is aborted at once. */
  readonly signal?: AbortSignal;
}

/**
 * What a shutdown did.
 *
 * @public
 */
export type ShutdownReport =
  | { readonly outcome: 'drained'; readonly errors: readonly unknown[] }
  | {
      readonly outcome: 'aborted';
      /** The units that were not idle and were aborted, in start order. */
      readonly units: readonly string[];
      readonly errors: readonly unknown[];
    };

/**
 * A unit adopted after the kernel started.
 *
 * @public
 */
export interface AdoptedUnit {
  /** Drain this unit alone now, then forget it; idempotent. */
  release(options?: ShutdownOptions): Promise<ShutdownReport>;
}

/**
 * The running units of a process: stage 5.
 *
 * @public
 */
export interface Kernel {
  /** The services the kernel was started from; it closes them on shutdown. */
  readonly services: Services;
  /** The names of the running units, in start order. */
  readonly units: readonly string[];
  /** Start `unit` now; it drains before every unit started earlier. */
  adopt(unit: LifecycleUnit): Promise<AdoptedUnit>;
  /** Drain every unit under one deadline, abort the rest, close the services. */
  shutdown(options?: ShutdownOptions): Promise<ShutdownReport>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** A running unit and the running units it depends on. */
interface Running {
  readonly unit: LifecycleUnit;
  readonly dependencies: readonly Running[];
}

/** Services a kernel was already started from. */
const started = new WeakSet<Services>();

/**
 * Start the units of `services` for its roles, then `options.units`.
 *
 * @public
 */
export async function start(services: Services, options: StartOptions = {}): Promise<Kernel> {
  if (!isLiveServices(services) || started.has(services)) {
    throw new KernelStageErrors.Error('invalid_stage', { stage: 'start' });
  }
  const host = (options.units ?? []).map(hostRegistration);
  const plan =
    host.length === 0
      ? services.units
      : planUnits([...services.registrations, ...host], new Set(services.roles));
  started.add(services);

  const running: Running[] = [];
  const byPlan = new Map<PlannedUnit, Running>();
  for (const planned of plan) {
    try {
      await planned.registration.unit.start();
    } catch (error) {
      const failures = await abortAll([...running].reverse());
      if (failures.length === 0) throw error;
      throw new AggregateError([error, ...failures], 'lifecycle start failed', { cause: error });
    }
    const entry: Running = Object.freeze({
      unit: planned.registration.unit,
      dependencies: Object.freeze(planned.dependencies.map((dep) => byPlan.get(dep) as Running)),
    });
    byPlan.set(planned, entry);
    running.push(entry);
  }
  return createKernel(services, running, options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS);
}

/** A host unit as a registration of the application. */
function hostRegistration(value: HostUnit): LifecycleRegistration {
  invariant(isRecord(value), PluginErrors, 'invalid_lifecycle_unit', {
    plugin: 'app',
    problem: 'invalid_unit',
  });
  return checkLifecycleRegistration('app', value.roles, value.unit, {
    ...(value.after === undefined ? {} : { after: value.after }),
    ...(value.transport === undefined ? {} : { transport: value.transport }),
  });
}

function createKernel(services: Services, running: Running[], defaultDeadlineMs: number): Kernel {
  /** Units started by `start`; an adopted unit depends on all of them. */
  const base: readonly Running[] = Object.freeze([...running]);
  let shutting: Promise<ShutdownReport> | undefined;
  const cut = new AbortController();
  const followers: (() => void)[] = [];

  const shutdown = (options: ShutdownOptions = {}): Promise<ShutdownReport> => {
    if (options.signal !== undefined) followers.push(follow(options.signal, cut));
    if (shutting !== undefined) return shutting;
    shutting = (async () => {
      const report = await drainUnits(
        [...running],
        options.deadlineMs ?? defaultDeadlineMs,
        cut.signal,
      );
      for (const unfollow of followers.splice(0)) unfollow();
      running.length = 0;
      const errors = [...report.errors];
      try {
        await services.close();
      } catch (error) {
        errors.push(error);
      }
      return Object.freeze({ ...report, errors: Object.freeze(errors) });
    })();
    return shutting;
  };

  const kernel: Kernel = Object.freeze({
    services,
    get units() {
      return Object.freeze(running.map((entry) => entry.unit.name));
    },
    async adopt(unit: LifecycleUnit): Promise<AdoptedUnit> {
      if (shutting !== undefined)
        throw new KernelStageErrors.Error('invalid_stage', { stage: 'adopt' });
      const registration = checkLifecycleRegistration('app', services.roles, unit, undefined);
      if (services.registrations.some((other) => other.unit.name === registration.unit.name)) {
        throw new KernelStageErrors.Error('duplicate_unit', { unit: registration.unit.name });
      }
      await unit.start();
      const entry: Running = Object.freeze({ unit, dependencies: base });
      if (shutting !== undefined) {
        await abortAll([entry]);
        throw new KernelStageErrors.Error('invalid_stage', { stage: 'adopt' });
      }
      running.push(entry);
      let released: Promise<ShutdownReport> | undefined;
      return Object.freeze({
        release(options: ShutdownOptions = {}): Promise<ShutdownReport> {
          released ??= (async () => {
            const index = running.indexOf(entry);
            if (index === -1) return Object.freeze({ outcome: 'drained', errors: [] });
            running.splice(index, 1);
            const controller = new AbortController();
            const unfollow =
              options.signal === undefined ? undefined : follow(options.signal, controller);
            try {
              return await drainUnits(
                [entry],
                options.deadlineMs ?? defaultDeadlineMs,
                controller.signal,
              );
            } finally {
              unfollow?.();
            }
          })();
          return released;
        },
      });
    },
    shutdown,
    async [Symbol.asyncDispose](): Promise<void> {
      await shutdown();
    },
  });
  return kernel;
}

/**
 * Abort `controller` when `signal` aborts (now, if it already has); returns
 * the disposer that stops following.
 */
function follow(signal: AbortSignal, controller: AbortController): () => void {
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = (): void => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Drain `units` in reverse dependency order under one deadline of
 * `deadlineMs`, aborting at the deadline (or when `cut` aborts) every unit not
 * idle.
 */
async function drainUnits(
  units: readonly Running[],
  deadlineMs: number,
  cut: AbortSignal,
): Promise<ShutdownReport> {
  const deadline = new AbortController();
  const errors: unknown[] = [];
  const idle = new Set<Running>();
  const aborted = new Set<Running>();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  const onCut = (): void => deadline.abort();
  if (cut.aborted) deadline.abort();
  else cut.addEventListener('abort', onCut, { once: true });

  const members = new Set(units);
  const dependents = new Map<Running, Running[]>();
  for (const unit of units) {
    for (const dependency of unit.dependencies) {
      if (!members.has(dependency)) continue;
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), unit]);
    }
  }

  const drains = new Map<Running, Promise<void>>();
  const drainOf = (unit: Running): Promise<void> => {
    let pending = drains.get(unit);
    if (pending === undefined) {
      pending = (async () => {
        await Promise.all((dependents.get(unit) ?? []).map(drainOf));
        if (deadline.signal.aborted) return;
        try {
          await unit.unit.drain(deadline.signal);
          if (!aborted.has(unit)) idle.add(unit);
        } catch (error) {
          errors.push(error);
          if (!aborted.has(unit)) {
            aborted.add(unit);
            errors.push(...(await abortAll([unit])));
          }
        }
      })();
      drains.set(unit, pending);
    }
    return pending;
  };

  const all = Promise.all(units.map(drainOf));
  let onDeadline: (() => void) | undefined;
  const deadlinePassed = new Promise<'deadline'>((resolve) => {
    onDeadline = () => resolve('deadline');
    if (deadline.signal.aborted) resolve('deadline');
    else deadline.signal.addEventListener('abort', onDeadline, { once: true });
  });
  try {
    if ((await Promise.race([all.then(() => 'drained' as const), deadlinePassed])) === 'deadline') {
      const late = units.filter((unit) => !idle.has(unit) && !aborted.has(unit));
      for (const unit of late) aborted.add(unit);
      // One grace for the aborts and the drains they end, so the shutdown is
      // over by the deadline plus ABORT_GRACE_MS whatever a unit does.
      const aborting = abortAll(late).then((failures) => {
        errors.push(...failures);
      });
      await settleWithin(Promise.all([aborting, all]), ABORT_GRACE_MS);
    }
  } finally {
    clearTimeout(timer);
    cut.removeEventListener('abort', onCut);
    if (onDeadline !== undefined) deadline.signal.removeEventListener('abort', onDeadline);
  }
  const frozenErrors = Object.freeze([...errors]);
  if (aborted.size === 0) return Object.freeze({ outcome: 'drained', errors: frozenErrors });
  return Object.freeze({
    outcome: 'aborted',
    units: Object.freeze(units.filter((unit) => aborted.has(unit)).map(({ unit }) => unit.name)),
    errors: frozenErrors,
  });
}

/** Abort every unit concurrently, each within the grace; returns the errors they threw. */
async function abortAll(units: readonly Running[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  await Promise.all(
    units.map(async ({ unit }) => {
      try {
        await settleWithin(
          Promise.resolve().then(() => unit.abort()),
          ABORT_GRACE_MS,
        );
      } catch (error) {
        errors.push(error);
      }
    }),
  );
  return errors;
}

/** Wait for `promise`, but no longer than `ms`; a rejection is rethrown. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
