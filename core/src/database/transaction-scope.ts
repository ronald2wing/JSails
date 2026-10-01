/**
 * The ambient transaction scope behind `transaction()`: an AsyncLocalStorage
 * map from data source to its open transaction's manager and callbacks.
 *
 * `transaction()` (transaction.ts) opens and closes scopes; the Active Record
 * surface (`ApplicationRecord.getRepository`, and through it `save`, `find*`,
 * `query()`, and the relation loaders) reads {@link activeTransactionManager}
 * so a call made inside a transaction body runs on the transaction's
 * connection instead of another pooled one. Its own module so the base model
 * class can read the scope without importing the data source, which imports
 * the model registry.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { EntityManager } from 'typeorm';

import type { Awaitable } from '../contracts/awaitable.js';

/** An async-or-sync callback run on commit or rollback. */
export type TransactionCallback = () => Awaitable<void>;

/** One data source's open transaction. */
export interface TransactionScope {
  /** The transaction-scoped manager; `undefined` before the transaction starts. */
  txManager: EntityManager | undefined;
  /** False once the transaction committed or rolled back. */
  active: boolean;
  afterCommitCallbacks: TransactionCallback[];
  afterRollbackCallbacks: TransactionCallback[];
}

/** ALS map keyed by data source identity so nested calls join the right scope. */
export const transactionScopes = new AsyncLocalStorage<Map<object, TransactionScope>>();

/**
 * The manager of the transaction open on `dataSource` in the current async
 * context, or `undefined` outside one. A finished transaction no longer
 * counts: its connection has been released, so an `afterCommit` callback or a
 * promise that outlived the body falls back to the data source's own manager.
 */
export function activeTransactionManager(
  dataSource: object | undefined,
): EntityManager | undefined {
  if (dataSource === undefined) return undefined;
  const scope = transactionScopes.getStore()?.get(dataSource);
  return scope !== undefined && scope.active ? scope.txManager : undefined;
}
