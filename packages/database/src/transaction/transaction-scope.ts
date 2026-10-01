/**
 * The ambient transaction binding: which frame of which engine the current
 * async context runs in. `transaction()` binds its body to its frame, and a
 * bound engine's leases read the binding to join it.
 *
 * The store is the data layer's own `AsyncLocalStorage`, not a key of the
 * execution context: a transaction never travels in a context carrier into a
 * job, `runInContext` (which replaces the execution context whole) must not
 * drop it, and opening one outside a request must not start a trace. It
 * lives on `globalThis` under a `Symbol.for` key, so duplicate copies of this
 * package in one process see one binding, as they share one query ledger.
 *
 * A binding is a chain, innermost first, with one entry per engine the
 * context is inside; a nested frame of the same engine shadows its parent.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Engine } from '../engine/contract.js';
import type { Frame } from './frame.js';

interface Binding {
  readonly engine: Engine;
  readonly frame: Frame;
  readonly next: Binding | undefined;
}

const SHARED_KEY = Symbol.for('jsails.database.transactionScope.v1');
const holder = globalThis as unknown as Record<
  symbol,
  AsyncLocalStorage<Binding | undefined> | undefined
>;
const store: AsyncLocalStorage<Binding | undefined> = (holder[SHARED_KEY] ??= new AsyncLocalStorage<
  Binding | undefined
>());

/**
 * The frame of `engine` the current async context is bound to, ended or not;
 * `undefined` outside every transaction of that engine.
 */
export function boundFrame(engine: Engine): Frame | undefined {
  for (let binding = store.getStore(); binding !== undefined; binding = binding.next) {
    if (binding.engine === engine) return binding.frame;
  }
  return undefined;
}

/** Run `fn` bound to `frame` of `engine`, keeping the bindings of other engines. */
export function runBound<T>(engine: Engine, frame: Frame, fn: () => T): T {
  return store.run({ engine, frame, next: store.getStore() }, fn);
}

/** The chain without any entry of `engine`, sharing the unchanged tail. */
function without(binding: Binding | undefined, engine: Engine): Binding | undefined {
  if (binding === undefined) return undefined;
  const next = without(binding.next, engine);
  if (binding.engine === engine) return next;
  return next === binding.next ? binding : { engine: binding.engine, frame: binding.frame, next };
}

/**
 * Run `fn` outside every transaction of `engine`, keeping the bindings of
 * other engines: where a transaction's callbacks run once it ended, so their
 * statements on another engine still join that engine's open transaction.
 */
export function runUnbound<T>(engine: Engine, fn: () => T): T {
  return store.run(without(store.getStore(), engine), fn);
}

/**
 * Run `fn` outside every transaction: statements it issues, and those of the
 * promises it starts, run on their own connections in autocommit mode. The
 * sanctioned way out of a transaction, for work that must outlive it or
 * commit independently of it.
 */
export function detached<T>(fn: () => T): T {
  return store.run(undefined, fn);
}
