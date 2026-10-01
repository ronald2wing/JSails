/**
 * Fixtures for the kernel stage tests: a plugin graph built by hand (the
 * stages take any graph; resolving one is `resolvePlugins`' own test), plugins
 * that only register lifecycle units, and units that record what the kernel
 * did to them.
 */

import { createServiceToken, type ServiceToken } from '../../src/extensions/services.js';
import type { PluginGraph } from '../../src/kernel/resolve-plugins.js';
import { definePlugin } from '../../src/plugins/contract/define-plugin.js';
import type { PluginInstance } from '../../src/plugins/contract/instance.js';
import type {
  LifecycleRegisterOptions,
  LifecycleUnit,
  PluginRole,
} from '../../src/plugins/contract/lifecycle.js';

/** A locked graph of `entries` for `roles`. */
export function graphOf(
  entries: readonly PluginInstance[],
  roles: readonly PluginRole[],
): PluginGraph {
  return Object.freeze({
    entries,
    nodes: entries.map((entry) => ({ name: entry.name, origin: 'config' as const })),
    roles,
    mode: 'locked',
    liveOnly: [],
    schemaAuthority: undefined,
  });
}

/** One unit a fixture plugin registers. */
export interface UnitDeclaration {
  readonly roles: readonly PluginRole[];
  readonly unit: LifecycleUnit;
  readonly options?: LifecycleRegisterOptions;
}

/**
 * A plugin named `name` that provides its own token and registers `units`;
 * its cleanup records `cleanup:<name>` on `events` when given.
 */
export function unitPlugin(
  name: string,
  units: readonly UnitDeclaration[],
  events?: string[],
): { readonly instance: PluginInstance; readonly token: ServiceToken<{ readonly name: string }> } {
  const token = createServiceToken<{ readonly name: string }>(`fixture.${name}`);
  const factory = definePlugin({
    name,
    provides: [token],
    setup({ services, lifecycle }) {
      services.provide(token, { name });
      for (const { roles, unit, options } of units) lifecycle.register(roles, unit, options);
      return () => {
        events?.push(`cleanup:${name}`);
      };
    },
  });
  return { instance: factory(), token };
}

/** How a recording unit behaves. */
export interface RecordingBehaviour {
  /** The start throws this. */
  readonly startError?: Error;
  /** The drain settles only when the unit is aborted (never, with `stuckAbort`). */
  readonly neverIdle?: boolean;
  /** The drain throws this. */
  readonly drainError?: Error;
  /** The abort never settles. */
  readonly stuckAbort?: boolean;
}

/** A unit that records `start:<name>`, `drain:<name>`, `drained:<name>` and `abort:<name>`. */
export function recordingUnit(
  name: string,
  events: string[],
  behaviour: RecordingBehaviour = {},
): LifecycleUnit & { readonly deadlines: AbortSignal[] } {
  const deadlines: AbortSignal[] = [];
  let release: () => void = () => undefined;
  return {
    name,
    deadlines,
    start() {
      events.push(`start:${name}`);
      if (behaviour.startError !== undefined) throw behaviour.startError;
    },
    async drain(deadline: AbortSignal) {
      events.push(`drain:${name}`);
      deadlines.push(deadline);
      if (behaviour.drainError !== undefined) throw behaviour.drainError;
      if (behaviour.neverIdle === true) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return;
      }
      // Yield a turn, so units draining together are seen draining together.
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push(`drained:${name}`);
    },
    abort() {
      events.push(`abort:${name}`);
      if (behaviour.stuckAbort === true) return new Promise<void>(() => undefined);
      release();
      return undefined;
    },
  };
}
