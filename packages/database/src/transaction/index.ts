/**
 * Transactions on the data engine, bound at the lease: `transaction()` with
 * savepoint frames, one poisoned-frame rule on every driver, isolation,
 * read-only, opt-in retry and a timeout on the outermost call, afterCommit
 * and afterRollback callbacks, fail-closed after the end, `detached()` as
 * the way out, and `withTestTransaction()`, whose virtual root always rolls
 * back.
 */

export {
  transaction,
  withTestTransaction,
  type TransactionRetry,
  type TransactionRunOptions,
  type Tx,
} from './run-transaction.js';
export {
  TransactionErrors,
  type OutermostOption,
  type TransactionArgument,
} from './transaction-errors.js';
export type { TransactionTarget } from './engine-source.js';
export { detached } from './transaction-scope.js';
