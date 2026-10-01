/**
 * Process roles and lifecycle units: the long-running work a plugin declares
 * from `setup` instead of starting it there.
 *
 * A process runs a set of roles: `web` serves HTTP, `worker` processes jobs,
 * `export` renders a static site. A plugin registers a {@link LifecycleUnit}
 * (`start`, `drain`, `abort`, and optionally `ready`) for the roles it belongs
 * to; the kernel's start stage starts the units of the roles its process runs
 * in dependency order (`after`) and drains them in reverse on shutdown, under
 * one deadline. Setup itself stays connection-free.
 *
 * A registration may name the transport its work travels on and that
 * transport's reach (`process` or `shared`): the kernel refuses a process that
 * runs only some of the roles using a process-local transport, because work
 * sent on it would never reach the roles running elsewhere.
 *
 * This module validates a registration; what a host does with it is the
 * host's policy (`host.ts`, `kernel/lifecycle-plan.ts`).
 */

import { isIdentifier } from '../../errors/context-schema.js';
import type { Awaitable } from '../../contracts/awaitable.js';
import { isRecord } from '../../json/shape.js';
import { PluginErrors } from './errors.js';

/**
 * A role a process runs.
 *
 * @public
 */
export type PluginRole = 'web' | 'worker' | 'export';

/**
 * Every role, in a stable order.
 *
 * @public
 */
export const PLUGIN_ROLES: readonly PluginRole[] = Object.freeze(['web', 'worker', 'export']);

/**
 * Whether `value` is a {@link PluginRole}.
 *
 * @public
 */
export function isPluginRole(value: unknown): value is PluginRole {
  return value === 'web' || value === 'worker' || value === 'export';
}

/**
 * Long-running work a plugin owns: started once its host runs, drained on a
 * graceful shutdown, aborted when it is not idle at the drain deadline (or
 * when a second shutdown signal arrives).
 *
 * @public
 */
export interface LifecycleUnit {
  /** An identifier, unique within the application (`jobs.producer`). */
  readonly name: string;
  /** Begin the work; resolves once it is running. */
  start(): Awaitable<void>;
  /**
   * Stop taking new work and finish what is in flight. `deadline` aborts when
   * the shutdown's shared deadline passes or the shutdown is cut short; the
   * kernel then calls {@link abort} unless this drain already settled.
   */
  drain(deadline: AbortSignal): Awaitable<void>;
  /** Stop now, abandoning what is in flight. Given at most one second. */
  abort(): Awaitable<void>;
  /**
   * An optional readiness probe, run by the readiness endpoint under the
   * unit's name while the process runs one of the unit's roles: resolving is
   * ready, rejecting or resolving `false` is not.
   */
  ready?(signal: AbortSignal): Awaitable<unknown>;
}

/**
 * How far a transport carries work: `process` only within the process that
 * holds it (the in-memory jobs adapter), `shared` between processes (Valkey).
 *
 * @public
 */
export type TransportReach = 'process' | 'shared';

/**
 * The transport a unit's work travels on.
 *
 * @public
 */
export interface LifecycleTransport {
  /** The transport's identifier, shared by every unit that uses it (`jobs`). */
  readonly name: string;
  readonly reach: TransportReach;
}

/**
 * Options for {@link PluginLifecycle.register}.
 *
 * @public
 */
export interface LifecycleRegisterOptions {
  /** Names of units that must start before this one (and drain after it). */
  readonly after?: readonly string[];
  /** The transport the unit's work travels on, checked for reach. */
  readonly transport?: LifecycleTransport;
}

/**
 * The lifecycle surface of a plugin's setup context.
 *
 * @public
 */
export interface PluginLifecycle {
  /** Register `unit` for `roles`. */
  register(
    roles: readonly PluginRole[],
    unit: LifecycleUnit,
    options?: LifecycleRegisterOptions,
  ): void;
}

/**
 * A validated registration: who registered which unit, for which roles, and
 * after which units.
 *
 * @public
 */
export interface LifecycleRegistration {
  readonly owner: string;
  readonly roles: readonly PluginRole[];
  readonly unit: LifecycleUnit;
  readonly after: readonly string[];
  readonly transport: LifecycleTransport | undefined;
}

function isUnit(value: unknown): value is LifecycleUnit {
  if (value === null || typeof value !== 'object') return false;
  const unit = value as Record<string, unknown>;
  return (
    typeof unit['start'] === 'function' &&
    typeof unit['drain'] === 'function' &&
    typeof unit['abort'] === 'function' &&
    (unit['ready'] === undefined || typeof unit['ready'] === 'function')
  );
}

function isTransport(value: unknown): value is LifecycleTransport {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value['name']) && (value['reach'] === 'process' || value['reach'] === 'shared')
  );
}

/**
 * Validate one `register` call of plugin `owner` and freeze it. Throws
 * `plugin.invalid_lifecycle_unit` naming the problem.
 */
export function checkLifecycleRegistration(
  owner: string,
  roles: unknown,
  unit: unknown,
  options: unknown,
): LifecycleRegistration {
  const reject = (
    problem:
      'invalid_roles' | 'invalid_unit' | 'invalid_name' | 'invalid_after' | 'invalid_transport',
  ) => new PluginErrors.Error('invalid_lifecycle_unit', { plugin: owner, problem });
  if (!Array.isArray(roles) || roles.length === 0 || !roles.every(isPluginRole)) {
    throw reject('invalid_roles');
  }
  if (!isUnit(unit)) throw reject('invalid_unit');
  if (!isIdentifier(unit.name)) throw reject('invalid_name');
  let after: readonly string[] = [];
  let transport: LifecycleTransport | undefined;
  if (options !== undefined) {
    if (!isRecord(options)) throw reject('invalid_after');
    const declared = options['after'];
    if (declared !== undefined) {
      if (!Array.isArray(declared) || !declared.every(isIdentifier)) throw reject('invalid_after');
      after = declared;
    }
    const declaredTransport = options['transport'];
    if (declaredTransport !== undefined) {
      if (!isTransport(declaredTransport)) throw reject('invalid_transport');
      transport = Object.freeze({ name: declaredTransport.name, reach: declaredTransport.reach });
    }
  }
  return Object.freeze({
    owner,
    roles: Object.freeze([...new Set(roles)]),
    unit,
    after: Object.freeze([...after]),
    transport,
  });
}
