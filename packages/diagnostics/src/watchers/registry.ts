/**
 * The watcher contract and registry: a setup-scoped home for pluggable
 * diagnostic watchers.
 *
 * A {@link Watcher} owns its own subscription and returns an unsubscribe from
 * `register`. The {@link WatcherRegistry} collects watchers during setup,
 * starts them, and invokes every unsubscribe on stop. The registry is sealed
 * after {@link WatcherRegistry.start} — no new watchers can be added — matching
 * the seal discipline of the shared interceptor registry (`jsails/extensions`).
 */

import type { DiagnosticsEntry } from 'jsails/diagnostics';
import { isRecord, JsailsError } from 'jsails/plugin-sdk';

/** Stable failure codes carried by {@link WatcherError}. */
export type WatcherErrorCode = 'sealed' | 'invalid_watcher' | 'duplicate_watcher';

/** Raised for every watcher-registry invariant: a malformed watcher, a duplicate name, a late registration. */
export class WatcherError extends JsailsError {
  constructor(
    readonly code: WatcherErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Context handed to each watcher's `register` during {@link WatcherRegistry.start}. */
export interface WatcherContext {
  /** Record a diagnostic entry (the recorder supplies the `at` timestamp). */
  readonly record: (entry: Omit<DiagnosticsEntry, 'at'>) => void;
  /** Clock returning milliseconds since epoch. */
  readonly now: () => number;
}

/**
 * A diagnostic watcher that subscribes to one or more sources (signals,
 * TypeORM subscribers, ...) and records entries through {@link WatcherContext}.
 */
export interface Watcher {
  /** Unique name for this watcher (e.g. `request`, `query`, `exception`). */
  readonly name: string;
  /** Subscribe to diagnostic sources and return an unsubscribe. Called exactly once during `start`. */
  register(ctx: WatcherContext): () => void;
}

/**
 * A setup-scoped registry of {@link Watcher} instances.
 *
 * - `add` registers a watcher; rejects a malformed watcher, a duplicate name,
 *   and an addition after `start` with a value-free {@link WatcherError}.
 * - `start` runs every watcher's `register` in registration order,
 *   collecting the returned unsubscribes, and seals the registry.
 * - `stop` invokes every collected unsubscribe. Idempotent — a second call is
 *   a no-op.
 * - `list` returns the registered names in registration order.
 */
export interface WatcherRegistry {
  add(watcher: Watcher): void;
  start(ctx: WatcherContext): void;
  stop(): void;
  list(): readonly string[];
}

/** Create an empty, unsealed {@link WatcherRegistry}. */
export function createWatcherRegistry(): WatcherRegistry {
  const watchers: Watcher[] = [];
  const unsubscribes: Array<() => void> = [];
  let sealed = false;
  let stopped = false;

  return {
    add(watcher: Watcher): void {
      if (sealed) {
        throw new WatcherError('sealed', 'the watcher registry is sealed once started');
      }
      if (!isRecord(watcher)) {
        throw new WatcherError('invalid_watcher', 'a watcher must be an object');
      }
      if (typeof watcher.name !== 'string' || watcher.name.length === 0) {
        throw new WatcherError('invalid_watcher', 'a watcher name must be a non-empty string');
      }
      if (typeof watcher.register !== 'function') {
        throw new WatcherError('invalid_watcher', 'a watcher must have a register function');
      }
      if (watchers.some((registered) => registered.name === watcher.name)) {
        throw new WatcherError('duplicate_watcher', 'watcher names must be unique');
      }
      watchers.push(watcher);
    },

    start(ctx: WatcherContext): void {
      for (const watcher of watchers) {
        unsubscribes.push(watcher.register(ctx));
      }
      sealed = true;
    },

    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    },

    list(): readonly string[] {
      return watchers.map((watcher) => watcher.name);
    },
  };
}
