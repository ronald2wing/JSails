/**
 * Process-wide traps for side effects a plugin's setup must not have, active
 * only inside the async context of the setup being watched.
 *
 * A plugin's setup is connection-free and inert: it wires services, and the
 * kernel opens connections and starts long-running work later. The traps
 * wrap the Node APIs through which a setup would break that rule: opening a
 * socket, listening, sending a datagram, resolving a name or fetching
 * (network); writing, creating, removing or renaming a file, or opening one
 * for writing (file writes); starting a subprocess; and starting a recurring
 * timer. Each wrapper looks for a {@link SetupProbe} in the current execution
 * context (a key of `jsails/context`, so no second AsyncLocalStorage) and,
 * when one is there, records the operation and throws; everywhere else it
 * calls the original. Module objects are patched in place and the change is
 * mirrored into ES module bindings with `syncBuiltinESMExports`, so a named
 * `import { writeFile } from 'node:fs/promises'` is trapped too.
 *
 * Work a setup leaves behind is deferred work, and it is reported, not left to
 * act: every one-shot timer and immediate (`setTimeout`, `setImmediate`) a
 * watched setup schedules is tracked until it runs or is cleared. When setup
 * resolves, {@link endSetup} cancels each one still pending and records it as
 * a violation, and from then on anything the setup's work schedules is
 * recorded as it is scheduled and cancelled by {@link cancelDeferredWork}.
 * A trap that fires inside a tracked callback is recorded and not rethrown, so
 * it fails the harness run instead of surfacing as an uncaught exception in
 * whatever code runs next. Work that waits on I/O the setup did not await is
 * still caught by the traps while they are installed (and recorded on the
 * probe, which the harness checks again when the run closes), but not once
 * the last holder has released them.
 *
 * The traps are installed on the first {@link acquireSetupTraps} and removed
 * when the last holder releases them.
 */

import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import timers from 'node:timers';
import timersPromises from 'node:timers/promises';
import { promisify } from 'node:util';

import { createContextKey, getContext, withContext } from '../context/execution-context.js';

/**
 * The kind of side effect a trap caught.
 */
export type SetupViolationKind = 'network' | 'fs_write' | 'subprocess' | 'timer' | 'substrate';

/**
 * One trapped operation: its kind and a fixed operation name
 * (`net.connect`, `fs.writeFile`), never an argument.
 */
export interface SetupViolation {
  readonly kind: SetupViolationKind;
  readonly operation: string;
}

/** What the traps record into while a setup runs. */
export interface SetupProbe {
  readonly plugin: string;
  readonly violations: SetupViolation[];
  /** Build the error a trap throws for `violation`. */
  readonly reject: (violation: SetupViolation) => Error;
  /** Whether the setup has resolved: deferred work scheduled from now on is a violation at once. */
  settled: boolean;
}

const probeKey = createContextKey<SetupProbe>('jsails.plugin-harness.probe');

/** The errors traps threw, so a tracked callback can tell a recorded violation from its own failure. */
const violationErrors = new WeakSet<object>();

/** A one-shot timer or immediate a watched setup scheduled that has neither run nor been cleared. */
interface DeferredWork {
  readonly probe: SetupProbe;
  readonly operation: string;
  readonly cancel: () => void;
}

/** Pending deferred work by the handle `setTimeout`/`setImmediate` returned. */
const deferred = new Map<object, DeferredWork>();

function recordViolation(
  probe: SetupProbe,
  kind: SetupViolationKind,
  operation: string,
): SetupViolation {
  const violation = Object.freeze({ kind, operation });
  probe.violations.push(violation);
  return violation;
}

/**
 * Mark `probe`'s setup as resolved: cancel each one-shot timer and immediate
 * it scheduled that is still pending, recording each as a violation. Work the
 * setup left running is recorded as it schedules more.
 */
export function endSetup(probe: SetupProbe): void {
  probe.settled = true;
  for (const [handle, work] of deferred) {
    if (work.probe !== probe) continue;
    deferred.delete(handle);
    work.cancel();
    recordViolation(probe, 'timer', work.operation);
  }
}

/** Cancel the deferred work `probe`'s setup scheduled after {@link endSetup}; it is already recorded. */
export function cancelDeferredWork(probe: SetupProbe): void {
  for (const [handle, work] of deferred) {
    if (work.probe !== probe) continue;
    deferred.delete(handle);
    work.cancel();
  }
}

/** Run `call` with `probe` watching every side effect it starts. */
export function watchSetup<T>(probe: SetupProbe, call: () => T): T {
  return withContext(probeKey, probe, call);
}

/**
 * Record `kind`/`operation` against the probe of the current context and
 * throw its error; a no-op outside a watched setup.
 */
export function trapSideEffect(kind: SetupViolationKind, operation: string): void {
  const probe = getContext(probeKey);
  if (probe === undefined) return;
  const error = probe.reject(recordViolation(probe, kind, operation));
  violationErrors.add(error);
  throw error;
}

/** A patched property and the value it replaced. */
interface Patch {
  readonly target: object;
  readonly property: string;
  readonly original: unknown;
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Give `wrapper` the `util.promisify` form of `original`, so promisifying a
 * patched function (`exec`, `setTimeout`) while the traps are installed still
 * yields the original's promise shape.
 */
function keepPromisified(wrapper: AnyFunction, original: AnyFunction): AnyFunction {
  const custom: unknown = (original as unknown as Record<symbol, unknown>)[promisify.custom];
  if (custom !== undefined) Object.defineProperty(wrapper, promisify.custom, { value: custom });
  return wrapper;
}

function wrap(
  target: object,
  property: string,
  kind: SetupViolationKind,
  operation: string,
  allowed?: (args: readonly unknown[]) => boolean,
): Patch | undefined {
  const record = target as Record<string, unknown>;
  const original = record[property];
  if (typeof original !== 'function') return undefined;
  const fn = original as AnyFunction;
  record[property] = keepPromisified(function trapped(this: unknown, ...args: unknown[]): unknown {
    if (allowed === undefined || !allowed(args)) trapSideEffect(kind, operation);
    return fn.apply(this, args);
  }, fn);
  return { target, property, original };
}

/**
 * Run a tracked timer callback. A trap it trips is recorded on the probe and
 * not rethrown: the harness reports it, and rethrowing would turn a recorded
 * failure into an uncaught exception in whatever runs next. Any other failure
 * propagates as it would have.
 */
function runTracked(callback: AnyFunction, self: unknown, args: unknown[]): unknown {
  let result: unknown;
  try {
    result = callback.apply(self, args);
  } catch (error) {
    if (error !== null && typeof error === 'object' && violationErrors.has(error)) return undefined;
    throw error;
  }
  if (result instanceof Promise) {
    return result.catch((error: unknown) => {
      // A recorded violation is the harness's failure to report; any other
      // rejection stays a rejection, as it was before the callback was wrapped.
      if (error === null || typeof error !== 'object' || !violationErrors.has(error)) throw error;
    });
  }
  return result;
}

/**
 * Track the one-shot timers `target[property]` schedules inside a watched
 * setup: each is pending until its callback runs or `clear` cancels it.
 */
function trackDeferred(
  target: object,
  property: string,
  operation: string,
  clear: (handle: object) => void,
): Patch | undefined {
  const fields = target as Record<string, unknown>;
  const original = fields[property];
  if (typeof original !== 'function') return undefined;
  const fn = original as AnyFunction;
  fields[property] = keepPromisified(function deferredTracked(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    const probe = getContext(probeKey);
    const callback = args[0];
    if (probe === undefined || typeof callback !== 'function') return fn.apply(this, args);
    let handle: object | undefined;
    args[0] = function trackedCallback(this: unknown, ...callbackArgs: unknown[]): unknown {
      if (handle !== undefined) deferred.delete(handle);
      return runTracked(callback as AnyFunction, this, callbackArgs);
    };
    const scheduled = fn.apply(this, args);
    if (scheduled === null || typeof scheduled !== 'object') return scheduled;
    handle = scheduled;
    deferred.set(scheduled, { probe, operation, cancel: () => clear(scheduled) });
    if (probe.settled) recordViolation(probe, 'timer', operation);
    return scheduled;
  }, fn);
  return { target, property, original };
}

/** Stop tracking the timer `clearTimeout`/`clearImmediate` received (a handle or a timer id). */
function forgetDeferred(handle: unknown): void {
  if (deferred.size === 0) return;
  if (handle !== null && typeof handle === 'object') {
    deferred.delete(handle);
    return;
  }
  if (typeof handle !== 'number' && typeof handle !== 'string') return;
  for (const key of deferred.keys()) {
    if (Symbol.toPrimitive in key && String(Number(key)) === String(handle)) deferred.delete(key);
  }
}

/** Wrap a clear function so a cleared timer stops counting as pending. */
function forgetOnClear(target: object, property: string): Patch | undefined {
  const fields = target as Record<string, unknown>;
  const original = fields[property];
  if (typeof original !== 'function') return undefined;
  const fn = original as AnyFunction;
  fields[property] = function clearTracked(this: unknown, ...args: unknown[]): unknown {
    forgetDeferred(args[0]);
    return fn.apply(this, args);
  };
  return { target, property, original };
}

/** File system calls that write, create, remove or rename. */
const FS_WRITES = [
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'cp',
  'lchown',
  'link',
  'lutimes',
  'mkdir',
  'mkdtemp',
  'rename',
  'rm',
  'rmdir',
  'symlink',
  'truncate',
  'unlink',
  'utimes',
  'writeFile',
] as const;

const WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_APPEND |
  fs.constants.O_TRUNC;

/** Whether an `open` call's flags (its second argument) only read. */
function opensForReading(args: readonly unknown[]): boolean {
  const flags = args[1];
  if (flags === undefined || flags === null || typeof flags === 'function') return true;
  if (typeof flags === 'number') return (flags & WRITE_FLAGS) === 0;
  return typeof flags === 'string' && !/[wa+]/.test(flags);
}

const SUBPROCESS = [
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
] as const;

function installTraps(): readonly Patch[] {
  const patches: (Patch | undefined)[] = [];
  for (const name of FS_WRITES) {
    patches.push(wrap(fs, name, 'fs_write', `fs.${name}`));
    patches.push(wrap(fs, `${name}Sync`, 'fs_write', `fs.${name}`));
    patches.push(wrap(fs.promises, name, 'fs_write', `fs.${name}`));
  }
  patches.push(wrap(fs, 'createWriteStream', 'fs_write', 'fs.createWriteStream'));
  patches.push(wrap(fs, 'open', 'fs_write', 'fs.open', opensForReading));
  patches.push(wrap(fs, 'openSync', 'fs_write', 'fs.open', opensForReading));
  patches.push(wrap(fs.promises, 'open', 'fs_write', 'fs.open', opensForReading));

  patches.push(wrap(net.Socket.prototype, 'connect', 'network', 'net.connect'));
  patches.push(wrap(net.Server.prototype, 'listen', 'network', 'net.listen'));
  patches.push(wrap(dgram.Socket.prototype, 'bind', 'network', 'dgram.bind'));
  patches.push(wrap(dgram.Socket.prototype, 'send', 'network', 'dgram.send'));
  patches.push(wrap(dns, 'lookup', 'network', 'dns.lookup'));
  patches.push(wrap(dns, 'resolve', 'network', 'dns.resolve'));
  patches.push(wrap(dns.promises, 'lookup', 'network', 'dns.lookup'));
  patches.push(wrap(dns.promises, 'resolve', 'network', 'dns.resolve'));
  patches.push(wrap(globalThis, 'fetch', 'network', 'fetch'));

  for (const name of SUBPROCESS) {
    patches.push(wrap(childProcess, name, 'subprocess', `child_process.${name}`));
  }

  patches.push(wrap(globalThis, 'setInterval', 'timer', 'timers.setInterval'));
  patches.push(wrap(timers, 'setInterval', 'timer', 'timers.setInterval'));
  patches.push(wrap(timersPromises, 'setInterval', 'timer', 'timers.setInterval'));

  // The originals, captured before any patch, cancel what the trackers scheduled.
  const clearTimer = timers.clearTimeout;
  const clearImmediateTimer = timers.clearImmediate;
  for (const target of [globalThis, timers]) {
    patches.push(
      trackDeferred(target, 'setTimeout', 'timers.setTimeout', (handle) => {
        clearTimer(handle as NodeJS.Timeout);
      }),
    );
    patches.push(
      trackDeferred(target, 'setImmediate', 'timers.setImmediate', (handle) => {
        clearImmediateTimer(handle as NodeJS.Immediate);
      }),
    );
    patches.push(forgetOnClear(target, 'clearTimeout'));
    patches.push(forgetOnClear(target, 'clearImmediate'));
  }

  syncBuiltinESMExports();
  return patches.filter((patch): patch is Patch => patch !== undefined);
}

let installed: readonly Patch[] | undefined;
let holders = 0;

/**
 * Install the traps (on the first call) and return the release for this
 * holder; the traps are removed when every holder has released.
 */
export function acquireSetupTraps(): () => void {
  installed ??= installTraps();
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0 || installed === undefined) return;
    for (const patch of [...installed].reverse()) {
      (patch.target as Record<string, unknown>)[patch.property] = patch.original;
    }
    installed = undefined;
    deferred.clear();
    syncBuiltinESMExports();
  };
}
