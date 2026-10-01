/**
 * What `transaction()` and `withTestTransaction()` run on: an engine from
 * `createEngine`, or a data source, which takes part without handing its
 * engine out. A data source registers how to reach its engine here when it
 * is constructed; the registry is module-private, so nothing outside the
 * package can read an engine back through it, and a data source another copy
 * of the package made is refused rather than taken for an engine.
 *
 * A source hands back its engine synchronously once it is open, and
 * `transaction()` takes an engine without awaiting: a transaction then
 * begins in the same turn whatever it was given, so a statement started
 * before a nested `transaction()` meets the nested frame the same way on an
 * engine and on a data source.
 */

import type { Engine } from '../engine/contract.js';
import type { JsailsDataSource } from '../record/data-source.js';
import { duplicatePackage, isMarkedDataSource } from '../record/data-source-mark.js';

/** What a transaction runs on: an engine, or a data source. */
export type TransactionTarget = Engine | JsailsDataSource;

const SOURCES = new WeakMap<object, () => Engine | Promise<Engine>>();

/** Register how `source` reaches its engine: the engine once open, or the promise of opening it. */
export function registerEngineSource(source: object, engine: () => Engine | Promise<Engine>): void {
  SOURCES.set(source, engine);
}

/**
 * The engine of `target`: itself, its source's open engine, or the promise of
 * its opening.
 *
 * @throws `data_source.duplicate_package` for a data source another copy of
 *   this package made, whose engine this copy cannot reach.
 */
export function engineOf(target: TransactionTarget): Engine | Promise<Engine> {
  const source = SOURCES.get(target);
  if (source !== undefined) return source();
  if (isMarkedDataSource(target)) throw duplicatePackage();
  return target as Engine;
}
