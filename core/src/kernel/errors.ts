/**
 * The kernel stages' codes, `kernel.*`: a lifecycle plan refused from its
 * declarations (an unknown or cyclic dependency, two units with one name, a
 * process-local transport split across processes), a stage value that the
 * kernel did not build or that is already disposed, a process with nothing
 * to run, and a shutdown that passed its deadline. Every message names units,
 * transports and roles by identifier only.
 */

import { defineErrors, type ErrorRegistry, type Payload } from '../errors/registry.js';

const KERNEL_ERRORS = {
  duplicate_unit: {
    kind: 'internal',
    message: 'two lifecycle units are named {unit}',
    context: { unit: 'identifier' },
    suggestion: 'give every lifecycle unit of an application its own name',
  },
  unknown_unit: {
    kind: 'internal',
    message: 'lifecycle unit {unit} starts after {after}, which no plugin registers',
    context: { unit: 'identifier', after: 'identifier' },
    suggestion: 'name a unit some plugin registers in after, or add the plugin that registers it',
  },
  unit_cycle: {
    kind: 'internal',
    message: 'lifecycle unit {unit} depends on itself through its after list',
    context: { unit: 'identifier' },
    suggestion: 'remove one after entry so the units form an order',
  },
  adapter_not_shared: {
    kind: 'internal',
    message:
      'transport {transport} is process-local, but this process runs only some of the roles that use it ({role} is elsewhere)',
    context: { transport: 'identifier', role: ['web', 'worker', 'export'] },
    suggestion:
      'run those roles in one process (jsails serve --with worker), or use a transport whose reach is shared, such as the Valkey adapter',
  },
  invalid_stage: {
    kind: 'internal',
    message: 'the {stage} stage received a value the kernel did not build, or one already disposed',
    context: { stage: ['start', 'adopt', 'defer'] },
    suggestion: 'pass the Services openServices returned, before closing them',
  },
  invalid_cleanup: {
    kind: 'internal',
    message: 'services.defer was given a cleanup that is not a function',
    suggestion: 'pass a function that releases what it registered, as () => pool.end()',
  },
  no_units: {
    kind: 'internal',
    message:
      'this process runs the {role} role, but no lifecycle unit is registered for that role alone',
    context: { role: ['web', 'worker', 'export'] },
    suggestion:
      'add the plugin that does the work for this role to the app config, such as jobsPlugin for the job workers',
  },
  shutdown_timeout: {
    kind: 'timeout',
    message: '{count} lifecycle units were not idle at the shutdown deadline and were aborted',
    context: { count: 'count' },
    suggestion:
      'let each unit finish its work within shutdownTimeoutMs, or raise shutdownTimeoutMs',
    payload: {} as Payload<{ readonly units: readonly string[] }>,
  },
} as const;

/**
 * The kernel stages' codes, `kernel.*`:
 *
 * - `duplicate_unit`, `unknown_unit`, `unit_cycle`: a lifecycle plan refused
 *   from its declarations, before any unit starts;
 * - `adapter_not_shared`: a process-local transport (the in-memory jobs
 *   adapter) used by roles this process runs and by roles it does not, so
 *   work sent on it would never arrive;
 * - `invalid_stage`: a stage given a value the kernel did not build, or one
 *   already disposed (`defer` on closed services);
 * - `invalid_cleanup`: `services.defer` given something other than a function;
 * - `no_units`: a worker process with nothing to run: every unit it would
 *   start (a connection, the job producer) also runs in the other roles'
 *   processes;
 * - `shutdown_timeout`: units aborted at the shutdown deadline (its payload
 *   names them).
 *
 * @public
 */
export const KernelStageErrors: ErrorRegistry<'kernel', typeof KERNEL_ERRORS> = defineErrors(
  'kernel',
  KERNEL_ERRORS,
);
