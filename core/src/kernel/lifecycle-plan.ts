/**
 * The lifecycle plan: which registered units a process starts, in which
 * order, decided from the registrations alone before any unit starts.
 *
 * Every registration of the application is judged, whatever its roles, so a
 * plan is refused the same way in every process: two units with one name
 * (`kernel.duplicate_unit`), an `after` naming a unit nobody registers
 * (`kernel.unknown_unit`), and a dependency cycle (`kernel.unit_cycle`).
 * A dependency on a unit of a role the process does not run is dropped: that
 * unit runs elsewhere.
 *
 * The reach rule: a transport whose reach is `process` (any one unit saying
 * so makes it so) carries work only inside the process holding it, so the
 * roles of every unit using it must all run here or none of them may
 * (`kernel.adapter_not_shared` otherwise). Serving without the worker over the
 * in-memory jobs adapter is refused; serving with it, or running a console
 * with no role at all, is not.
 *
 * The units the process runs are those registered for one of its roles, in
 * dependency order, registration order breaking ties. Its dedicated units
 * are the ones among them registered for no role it leaves out: what a
 * process of exactly these roles adds to every other process of the app. A
 * worker's are the job workers; a connection unit every role registers (the
 * Valkey client) is not one of them, and neither is the producer a web
 * process runs too.
 */

import type { LifecycleRegistration, PluginRole } from '../plugins/contract/lifecycle.js';
import { PLUGIN_ROLES } from '../plugins/contract/lifecycle.js';
import { KernelStageErrors } from './errors.js';

/** A unit the process runs, with the planned units it starts after. */
export interface PlannedUnit {
  readonly registration: LifecycleRegistration;
  /** The planned units this one starts after (and drains before). */
  readonly dependencies: readonly PlannedUnit[];
}

/**
 * Validate `registrations` (every role's), then return the units a process
 * running `roles` starts, in start order.
 */
export function planUnits(
  registrations: readonly LifecycleRegistration[],
  roles: ReadonlySet<PluginRole>,
): readonly PlannedUnit[] {
  const byName = new Map<string, LifecycleRegistration>();
  for (const registration of registrations) {
    if (byName.has(registration.unit.name)) {
      throw new KernelStageErrors.Error('duplicate_unit', { unit: registration.unit.name });
    }
    byName.set(registration.unit.name, registration);
  }
  for (const registration of registrations) {
    for (const name of registration.after) {
      if (!byName.has(name)) {
        throw new KernelStageErrors.Error('unknown_unit', {
          unit: registration.unit.name,
          after: name,
        });
      }
    }
  }
  assertAcyclic(registrations, byName);
  checkReach(registrations, roles);
  return order(
    registrations.filter((registration) => registration.roles.some((role) => roles.has(role))),
  );
}

/**
 * The names of the planned `units` registered for no role outside `roles`,
 * in start order.
 */
export function dedicatedUnits(
  units: readonly PlannedUnit[],
  roles: ReadonlySet<PluginRole>,
): readonly string[] {
  return Object.freeze(
    units
      .filter(({ registration }) => registration.roles.every((role) => roles.has(role)))
      .map(({ registration }) => registration.unit.name),
  );
}

/** Depth-first search over the `after` edges; a back edge is a cycle. */
function assertAcyclic(
  registrations: readonly LifecycleRegistration[],
  byName: ReadonlyMap<string, LifecycleRegistration>,
): void {
  const state = new Map<LifecycleRegistration, 'visiting' | 'done'>();
  const visit = (registration: LifecycleRegistration): void => {
    const seen = state.get(registration);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      throw new KernelStageErrors.Error('unit_cycle', { unit: registration.unit.name });
    }
    state.set(registration, 'visiting');
    for (const name of registration.after) visit(byName.get(name) as LifecycleRegistration);
    state.set(registration, 'done');
  };
  for (const registration of registrations) visit(registration);
}

/** Refuse a process-local transport whose units straddle this process's roles. */
function checkReach(
  registrations: readonly LifecycleRegistration[],
  roles: ReadonlySet<PluginRole>,
): void {
  const transports = new Map<string, { local: boolean; roles: Set<PluginRole> }>();
  for (const { transport, roles: used } of registrations) {
    if (transport === undefined) continue;
    const entry = transports.get(transport.name) ?? { local: false, roles: new Set() };
    entry.local ||= transport.reach === 'process';
    for (const role of used) entry.roles.add(role);
    transports.set(transport.name, entry);
  }
  for (const [name, entry] of transports) {
    if (!entry.local) continue;
    const here = [...entry.roles].some((role) => roles.has(role));
    if (!here) continue;
    const elsewhere = PLUGIN_ROLES.find((role) => entry.roles.has(role) && !roles.has(role));
    if (elsewhere !== undefined) {
      throw new KernelStageErrors.Error('adapter_not_shared', { transport: name, role: elsewhere });
    }
  }
}

/** Topological order over the `after` edges among `active`, ties in registration order. */
function order(active: readonly LifecycleRegistration[]): readonly PlannedUnit[] {
  const names = new Set(active.map((registration) => registration.unit.name));
  const planned = new Map<string, PlannedUnit>();
  const result: PlannedUnit[] = [];
  const pending = [...active];
  while (pending.length > 0) {
    const index = pending.findIndex((registration) =>
      registration.after.every((name) => !names.has(name) || planned.has(name)),
    );
    // The graph is acyclic, so some pending unit always has its dependencies planned.
    const [registration] = pending.splice(index, 1) as [LifecycleRegistration];
    const unit: PlannedUnit = Object.freeze({
      registration,
      dependencies: Object.freeze(
        registration.after
          .filter((name) => names.has(name))
          .map((name) => planned.get(name) as PlannedUnit),
      ),
    });
    planned.set(registration.unit.name, unit);
    result.push(unit);
  }
  return Object.freeze(result);
}
