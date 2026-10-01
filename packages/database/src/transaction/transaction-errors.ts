/**
 * The transaction layer's error codes, `transaction.*`. Every message is
 * fixed text; the only context is an argument name from a fixed list or a
 * count, so no SQL, value or row ever reaches a message.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const TRANSACTION_ERRORS = {
  aborted: {
    kind: 'conflict',
    message: 'the transaction frame was aborted by an earlier failed statement',
    suggestion:
      'run a statement that may fail inside a nested transaction() and catch its rejection there',
  },
  closed: {
    kind: 'internal',
    message: 'the transaction this code ran in has already ended',
    suggestion:
      'await database work inside the transaction body, or start independent work with detached()',
  },
  timeout: {
    kind: 'timeout',
    message: 'the transaction ran past its timeout and was rolled back',
  },
  frame_busy: {
    kind: 'timeout',
    message:
      'a statement or nested transaction waited past the acquire timeout for its transaction frame',
    suggestion:
      'await work started in a transaction before opening a nested transaction() that depends on it',
  },
  after_commit_failed: {
    kind: 'internal',
    message: '{count} after-commit callback(s) failed; the transaction itself committed',
    context: { count: 'count' },
  },
  after_rollback_failed: {
    kind: 'internal',
    message: '{count} after-rollback callback(s) failed after the transaction rolled back',
    context: { count: 'count' },
  },
  nested_begin: {
    kind: 'internal',
    message: 'a new transaction was begun on an engine inside one of its own transactions',
    suggestion: 'nest with transaction(), or start an independent transaction inside detached()',
  },
  outermost_only: {
    kind: 'internal',
    message: 'transaction option {argument} applies only to the outermost transaction',
    context: { argument: ['isolation', 'readOnly', 'retry', 'timeoutMs'] },
  },
  unsupported_in_test: {
    kind: 'internal',
    message:
      'transaction option {argument} cannot apply inside withTestTransaction, where the transaction is a savepoint',
    suggestion: 'run this test outside withTestTransaction, against real commits',
    context: { argument: ['isolation', 'readOnly'] },
  },
  invalid_arguments: {
    kind: 'internal',
    message: 'transaction argument {argument} is invalid',
    context: {
      argument: [
        'body',
        'callback',
        'options',
        'isolation',
        'readOnly',
        'retry',
        'retry.attempts',
        'retry.on',
        'retry.backoffMs',
        'timeoutMs',
      ],
    },
  },
  unbound_engine: {
    kind: 'internal',
    message: 'the engine was not opened by createEngine, so its leases cannot join a transaction',
    suggestion: 'open the engine with createEngine()',
  },
} as const;

/**
 * The transaction layer's codes: a frame poisoned by a failed statement
 * (`aborted`), work from an ended transaction (`closed`), an expired
 * `timeoutMs`, a frame held past the acquire timeout (`frame_busy`), failed
 * commit or rollback callbacks, a transaction begun inside its own engine's
 * scope, misused options (an option `withTestTransaction` cannot honour among
 * them), and an engine `transaction()` cannot bind.
 */
export const TransactionErrors: ErrorRegistry<'transaction', typeof TRANSACTION_ERRORS> =
  defineErrors('transaction', TRANSACTION_ERRORS);

/** An argument name a `transaction.*` error may report. */
export type TransactionArgument =
  (typeof TRANSACTION_ERRORS)['invalid_arguments']['context']['argument'][number];

/** An option that applies only to the outermost transaction. */
export type OutermostOption =
  (typeof TRANSACTION_ERRORS)['outermost_only']['context']['argument'][number];
