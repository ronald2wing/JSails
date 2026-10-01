/**
 * The change feed of a data source, `ds.changes`: key-only records of every
 * committed write the pipeline made, for the models a subscriber names.
 *
 * ```ts
 * const unsubscribe = ds.changes.subscribe(
 *   (records) => publish(records),
 *   { models: () => publishedModels, onError: (error) => log.error(error) },
 * );
 * ```
 *
 * - Records are built only while a subscription exists, buffered in the
 *   transaction frame that made them (a nested frame's records merge into
 *   its parent when it releases and are dropped when it rolls back), and
 *   delivered once the outermost transaction commits, coalesced
 *   (`coalesce.ts`). A write outside a transaction is delivered when its
 *   statement returns.
 * - Each subscription receives only the records of the models its `models()`
 *   returns at delivery, and nothing when that leaves none.
 * - The listener is called synchronously and is never awaited. Whatever it
 *   throws, and the rejection of a promise it returns, goes to its `onError`:
 *   a listener failure never reaches the write, which has committed.
 * - Rows are never read again for a record; a consumer that needs a row reads
 *   it under its own access rules.
 */

import type { Engine } from '../engine/contract.js';
import { modelDefinition } from '../model/define-model.js';
import type { ModelTarget } from '../model/model-spec.js';
import { DataSourceErrors } from '../record/record-errors.js';
import { createCommitBuffer, type CommitBuffer } from '../transaction/commit-buffer.js';
import type { ChangeRecord } from './change-record.js';
import { coalesceChanges } from './coalesce.js';

/**
 * Receives the coalesced records of one commit. It is called synchronously
 * and never awaited; what it returns is ignored, except that a promise is
 * watched for a rejection, which goes to the subscription's `onError`.
 */
export type ChangeListener = (records: readonly ChangeRecord[]) => unknown;

/** What a subscription is scoped to, and where its failures go. */
export interface ChangeSubscriptionOptions {
  /** The models whose records the subscription receives, read at each delivery. */
  readonly models: () => ReadonlySet<ModelTarget>;
  /** Receives what the listener throws or rejects with. */
  readonly onError: (error: unknown) => void;
}

/** Ends a subscription; calling it again does nothing. */
export type Unsubscribe = () => void;

/** The change feed of one data source. */
export interface ChangeFeed {
  /**
   * Receive the records of `options.models()` after each commit.
   *
   * @throws `data_source.invalid_options` (`listener`, `subscription`) for a
   *   listener that is not a function or options without both functions.
   */
  subscribe(listener: ChangeListener, options: ChangeSubscriptionOptions): Unsubscribe;
}

/** The write side of a feed, which the pipeline holds. */
export interface ChangeEmitter {
  /** Whether any subscription exists, so records are worth building. */
  readonly active: boolean;
  /** Add `records` of a write on `engine` to its transaction, or deliver them now. */
  emit(engine: Engine, records: readonly ChangeRecord[]): Promise<void>;
}

interface Subscription {
  readonly listener: ChangeListener;
  readonly options: ChangeSubscriptionOptions;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

/** Hand `error` to the subscription's reporter, which must not fail the write either. */
function report(subscription: Subscription, error: unknown): void {
  try {
    subscription.options.onError(error);
  } catch {
    // The reporter is the subscriber's own; a reporter that throws has
    // nowhere further to go, and the write it reports on has committed.
  }
}

/** The tables of the models a subscription names now. */
function tablesOf(subscription: Subscription): ReadonlySet<string> | undefined {
  let models: ReadonlySet<ModelTarget>;
  try {
    models = subscription.options.models();
  } catch (error) {
    report(subscription, error);
    return undefined;
  }
  const tables = new Set<string>();
  for (const model of models) {
    const table = modelDefinition(model)?.spec.table;
    if (table !== undefined) tables.add(table);
  }
  return tables;
}

class DataChangeFeed implements ChangeFeed, ChangeEmitter {
  readonly #subscriptions = new Set<Subscription>();
  readonly #buffer: CommitBuffer<readonly ChangeRecord[]> = createCommitBuffer((batches) => {
    this.#deliver(batches.flat());
  });

  get active(): boolean {
    return this.#subscriptions.size > 0;
  }

  subscribe(listener: ChangeListener, options: ChangeSubscriptionOptions): Unsubscribe {
    if (typeof listener !== 'function') {
      throw new DataSourceErrors.Error('invalid_options', { field: 'listener' });
    }
    if (
      options === null ||
      typeof options !== 'object' ||
      typeof options.models !== 'function' ||
      typeof options.onError !== 'function'
    ) {
      throw new DataSourceErrors.Error('invalid_options', { field: 'subscription' });
    }
    const subscription: Subscription = Object.freeze({
      listener,
      options: Object.freeze({ models: options.models, onError: options.onError }),
    });
    this.#subscriptions.add(subscription);
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  async emit(engine: Engine, records: readonly ChangeRecord[]): Promise<void> {
    if (records.length === 0 || !this.active) return;
    await this.#buffer.add(engine, records);
  }

  #deliver(records: readonly ChangeRecord[]): void {
    if (records.length === 0) return;
    const coalesced = coalesceChanges(records);
    for (const subscription of [...this.#subscriptions]) {
      const tables = tablesOf(subscription);
      if (tables === undefined) continue;
      const scoped = Object.freeze(coalesced.filter((record) => tables.has(record.collection)));
      if (scoped.length === 0) continue;
      try {
        const result: unknown = subscription.listener(scoped);
        // A returned promise is watched only for its rejection, which goes
        // to the subscriber's reporter; the write never waits for it.
        if (isThenable(result)) {
          Promise.resolve(result).then(undefined, (error: unknown) => {
            report(subscription, error);
          });
        }
      } catch (error) {
        report(subscription, error);
      }
    }
  }
}

/** A new feed: the public side for the data source, the emitter for the pipeline. */
export function createChangeFeed(): { readonly feed: ChangeFeed; readonly emitter: ChangeEmitter } {
  const feed = new DataChangeFeed();
  return Object.freeze({ feed, emitter: feed });
}
