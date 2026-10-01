/**
 * One ambient context: `core/src/context/execution-context.ts` holds
 * the framework's one `AsyncLocalStorage`, and every value that follows a unit
 * of work (the request id and span, the locale, the tenant, the application
 * scope, a server component's frame) is a key in it, so a request enters one
 * context and a job carries one carrier.
 *
 * `jsails/no-new-async-local-storage` bans `new AsyncLocalStorage` (and an
 * alias that would hide one: a renamed import or destructuring, or the class
 * assigned to another name) in every framework source outside that
 * module and the data layer's own scopes, which are deliberately separate and
 * never propagated:
 *
 * - `core/src/database/transaction-scope.ts`: the ambient transaction per data
 *   source; a transaction never outlives the process or follows a job.
 * - `core/src/database/connection-lease.ts`: which lease fired a driver hook;
 *   bookkeeping inside one query, not context.
 * - `packages/database/src/engine/query-ledger.ts`: the per-frame query ledger
 *   the bench and the N+1 guard read; measurement, not context.
 * - `packages/database/src/transaction/transaction-scope.ts`: the new data
 *   layer's ambient transaction per engine; it must never travel in a context
 *   carrier, `runInContext` must not drop it, and opening a transaction
 *   outside a request must not start a trace.
 * - `packages/blog/src/cms/memory-repository.ts`: the in-memory repository's
 *   transaction marker, the test double of a database transaction.
 *
 * `AsyncLocalStorage.snapshot()` stays allowed: it captures the current
 * context for a later callback and creates no store.
 */

const FRAMEWORK_SOURCE = ['core/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'];

const ALLOWED = [
  'core/src/context/execution-context.ts',
  'core/src/database/transaction-scope.ts',
  'core/src/database/connection-lease.ts',
  'packages/database/src/engine/query-ledger.ts',
  'packages/database/src/transaction/transaction-scope.ts',
  'packages/blog/src/cms/memory-repository.ts',
];

export const restrictedSyntax = [
  {
    name: 'no-new-async-local-storage',
    files: FRAMEWORK_SOURCE,
    ignores: ALLOWED,
    selector: [
      "NewExpression[callee.name='AsyncLocalStorage']",
      "NewExpression[callee.property.name='AsyncLocalStorage']",
      "ImportSpecifier[imported.name='AsyncLocalStorage'][local.name!='AsyncLocalStorage']",
      "ObjectPattern > Property[key.name='AsyncLocalStorage'][value.name!='AsyncLocalStorage']",
      "VariableDeclarator[init.name='AsyncLocalStorage']",
      "VariableDeclarator[init.property.name='AsyncLocalStorage']",
    ].join(', '),
    message:
      'The framework has one AsyncLocalStorage: declare a key with createContextKey from core/src/context and set it with withContext instead.',
  },
];

export default [];
