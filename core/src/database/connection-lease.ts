/**
 * One transaction at a time on a single-connection data source.
 *
 * TypeORM's `sqljs` driver hands every caller the same query runner, so two
 * units of work that overlap share one connection and one transaction state:
 * a bare `save()` issued while another request's transaction is open runs
 * inside that transaction (its `BEGIN` sees a transaction already active) and
 * vanishes when it rolls back, and a second `BEGIN` becomes a savepoint inside
 * the first. {@link leaseSharedQueryRunner} wraps each runner the data source
 * hands out in a lease of the connection guarded by a per-data-source FIFO
 * lock. A lease holds the lock from its `BEGIN` until its transaction ends
 * (commit or rollback back to depth zero), and a statement outside any
 * transaction holds it for that one statement, so it autocommits between
 * transactions rather than inside one. A runner that is merely held, idle and
 * outside a transaction, blocks nobody. Every TypeORM entry point
 * (repositories, the entity manager, query builders, `DataSource.query`,
 * `transaction()`) goes through such a runner.
 *
 * Work that runs on behalf of a holder joins it instead of queuing behind it,
 * which would deadlock: code inside a `transaction()` body for the same data
 * source (the caller passes the open transaction's runner), and code that a
 * holder's statements or entity events call back into (subscribers and entity
 * hooks run inside an AsyncLocalStorage mark of the lease that fired them).
 * A joined runner runs on the holder's connection and its `release()` leaves
 * the holder alone.
 *
 * Code that opens a transaction on a runner it created itself and, inside
 * that transaction, calls code that writes through another runner of the same
 * data source waits for its own commit; such code must use the held runner
 * (or its `manager`). A runner released with its transaction still open rolls
 * it back, so the next holder never inherits it, and refuses further use.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { QueryRunnerAlreadyReleasedError } from 'typeorm';
import type { EntityManager, QueryRunner } from 'typeorm';

/** The data source surface a lease needs: an entity manager bound to a runner. */
export interface LeaseHost {
  createEntityManager(queryRunner?: QueryRunner): EntityManager;
}

/** The tail of each data source's lock queue; settles when the last holder releases. */
const queues = new WeakMap<object, Promise<void>>();

/** The lease behind each runner proxy this module handed out. */
const leases = new WeakMap<object, Lease>();

/** Per data source, the lease whose statements or events the current async context runs inside. */
const holders = new AsyncLocalStorage<ReadonlyMap<object, Lease>>();

/** Queue for `owner`'s connection; resolves with the function that gives it back. */
function lock(owner: object): Promise<() => void> {
  const previous = queues.get(owner) ?? Promise.resolve();
  let unlock: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => held);
  queues.set(owner, tail);
  return previous.then(() => () => {
    unlock();
    if (queues.get(owner) === tail) queues.delete(owner);
  });
}

class Lease {
  /** The lock, held across this lease's own transaction. */
  #transaction: (() => void) | undefined;
  /** Statements of this lease running under a lock of their own. */
  #statements = 0;
  released = false;

  constructor(
    readonly owner: object,
    readonly parent: Lease | undefined,
  ) {}

  /** Whether this lease may use the connection right now without queuing. */
  get active(): boolean {
    return (
      this.#transaction !== undefined || this.#statements > 0 || (this.parent?.active ?? false)
    );
  }

  /** Whether this lease holds the lock for a transaction it opened. */
  get ownsTransaction(): boolean {
    return this.#transaction !== undefined;
  }

  #assertOpen(): void {
    if (this.released) throw new QueryRunnerAlreadyReleasedError();
  }

  /** Run one statement: on the connection already held, or under the lock for just this statement. */
  async statement<R>(run: () => Promise<R>): Promise<R> {
    this.#assertOpen();
    if (this.active) return run();
    const unlock = await lock(this.owner);
    this.#statements += 1;
    try {
      return await run();
    } finally {
      this.#statements -= 1;
      unlock();
    }
  }

  /** Open a transaction: join the one held, or take the lock until it ends. */
  async begin(run: () => Promise<void>): Promise<void> {
    this.#assertOpen();
    if (this.active) return run();
    const unlock = await lock(this.owner);
    this.#transaction = unlock;
    try {
      await run();
    } catch (error) {
      this.#transaction = undefined;
      unlock();
      throw error;
    }
  }

  /** Commit or roll back; give the lock back once the transaction it guards is over. */
  async end(run: () => Promise<void>, stillOpen: () => boolean): Promise<void> {
    try {
      await run();
    } finally {
      const unlock = this.#transaction;
      if (unlock !== undefined && !stillOpen()) {
        this.#transaction = undefined;
        unlock();
      }
    }
  }

  /**
   * Release the runner. A transaction this lease left open is rolled back
   * first, so the next holder does not inherit it. A joined runner leaves the
   * shared runner to its holder.
   */
  async release(
    rollbackOpen: () => Promise<void>,
    releaseRunner: () => Promise<void>,
  ): Promise<void> {
    if (this.released) return;
    this.released = true;
    const unlock = this.#transaction;
    if (unlock !== undefined) {
      try {
        await rollbackOpen();
      } finally {
        this.#transaction = undefined;
        try {
          await releaseRunner();
        } finally {
          unlock();
        }
      }
      return;
    }
    if (this.parent?.active === true) return;
    await releaseRunner();
  }
}

type Method = (...args: unknown[]) => Promise<unknown>;

/**
 * Wrap `runner`, the shared runner of single-connection `host`, in a lease.
 * `transactionRunner` is the runner of a transaction open on `host` in the
 * caller's async context, which the new runner joins.
 */
export function leaseSharedQueryRunner(
  host: LeaseHost,
  runner: QueryRunner,
  transactionRunner: QueryRunner | undefined,
): QueryRunner {
  const parent =
    holders.getStore()?.get(host) ??
    (transactionRunner === undefined ? undefined : leases.get(transactionRunner));
  const lease = new Lease(host, parent);
  const insideLease = <R>(fn: () => R): R =>
    holders.run(new Map(holders.getStore()).set(host, lease), fn);
  const call = (target: QueryRunner, name: string, args: unknown[]): Promise<unknown> =>
    insideLease(() => Reflect.apply(Reflect.get(target, name) as Method, proxy, args));

  let manager: EntityManager | undefined;
  let broadcaster: object | undefined;
  const proxy: QueryRunner = new Proxy(runner, {
    get(target, property) {
      switch (property) {
        case 'query':
          return (...args: unknown[]) => lease.statement(() => call(target, property, args));
        case 'startTransaction':
          return (...args: unknown[]) =>
            lease.begin(async () => {
              await call(target, property, args);
            });
        case 'commitTransaction':
        case 'rollbackTransaction':
          return (...args: unknown[]) =>
            lease.end(
              async () => {
                await call(target, property, args);
              },
              () => target.isTransactionActive,
            );
        case 'release':
          return () =>
            lease.release(
              async () => {
                while (target.isTransactionActive) await target.rollbackTransaction();
              },
              () => target.release.call(proxy),
            );
        case 'isReleased':
          return lease.released;
        case 'isTransactionActive':
          // Unless this lease uses the connection, the shared runner's flag
          // describes another holder's transaction, not this caller's.
          return lease.active && target.isTransactionActive;
        case 'manager':
          return (manager ??= host.createEntityManager(proxy));
        case 'broadcaster':
          return (broadcaster ??= leaseBroadcaster(target.broadcaster, proxy, insideLease));
        default:
          return Reflect.get(target, property, proxy) as unknown;
      }
    },
    set(target, property, value) {
      return Reflect.set(target, property, value);
    },
  });
  leases.set(proxy, lease);
  return proxy;
}

/**
 * The runner's broadcaster, seen through the lease: events name the lease as
 * their `queryRunner` (so a hook's `event.manager` uses this lease), and every
 * subscriber runs inside the lease's mark, so what it opens joins the lease.
 */
function leaseBroadcaster(
  broadcaster: object,
  queryRunner: QueryRunner,
  insideLease: <R>(fn: () => R) => R,
): object {
  const view: object = new Proxy(broadcaster, {
    get(target, property) {
      if (property === 'queryRunner') return queryRunner;
      const value: unknown = Reflect.get(target, property, view);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => insideLease(() => Reflect.apply(method, view, args));
    },
  });
  return view;
}
