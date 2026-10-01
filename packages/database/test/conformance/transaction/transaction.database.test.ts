/**
 * Transaction conformance on the run's driver: SQLite in the default suite,
 * MariaDB and PostgreSQL in the database suite's legs. Concurrent commits
 * and rollbacks keep exactly the committed rows; every lease taken inside the
 * body joins the transaction, and one taken before it keeps its own
 * connection and session; a caught nested failure leaves no nested writes;
 * catch-and-continue without a savepoint is `aborted` on every driver; the
 * isolation level is observable; conflicting serializable transactions
 * succeed with retry; work after the end fails closed; nested siblings never
 * interleave savepoints; a timeout frees the lease; nothing written inside
 * `withTestTransaction` survives it, afterRollback writes included; and it
 * refuses the isolation and read-only options a savepoint cannot apply.
 */

import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  createQueryLedger,
  isDatabaseError,
  withQueryLedger,
  type Conn,
  type Engine,
  type IsolationLevel,
} from '../../../src/engine/index.js';
import { forEachDriver } from '../../../src/testing/index.js';
import {
  detached,
  transaction,
  TransactionErrors,
  withTestTransaction,
} from '../../../src/transaction/index.js';
import { exec, openMatrixEngine, serialKey } from '../engine/fixtures/matrix-engine.js';

const ROLLBACK = new Error('roll back');

function isTransactionError(code: Parameters<typeof TransactionErrors.is>[1]) {
  return (error: unknown): boolean => {
    assert.ok(
      TransactionErrors.is(error, code),
      `expected transaction.${code}, got ${String(error)}`,
    );
    return true;
  };
}

/** Resolves when `release` is called; lets a test hold work until a point it picks. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

void forEachDriver('transaction conformance', ({ driver }) => {
  let engine: Engine;
  const cleanup: (() => unknown)[] = [];
  after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });

  before(async () => {
    engine = await openMatrixEngine({ after: (callback) => cleanup.push(callback) });
    await exec(
      engine,
      `CREATE TABLE notes (${serialKey(engine)}, label VARCHAR(50) NOT NULL, CONSTRAINT notes_label_unique UNIQUE (label))`,
      'CREATE TABLE oncall (id INTEGER PRIMARY KEY, active INTEGER NOT NULL)',
    );
  });

  beforeEach(async () => {
    await exec(engine, 'DELETE FROM notes', 'DELETE FROM oncall');
  });

  async function labels(): Promise<string[]> {
    const conn = await engine.lease();
    try {
      const { rows } = await conn.query('SELECT label FROM notes ORDER BY label');
      return rows.map((row) => String(row.label));
    } finally {
      await conn.release();
    }
  }

  async function note(label: string): Promise<void> {
    const conn = await engine.lease();
    try {
      await conn.query(`INSERT INTO notes (label) VALUES ('${label}')`);
    } finally {
      await conn.release();
    }
  }

  describe('commit and rollback', () => {
    it('commits when the body fulfils and rolls back with its failure when it rejects', async () => {
      assert.equal(
        await transaction(engine, async () => {
          await note('kept');
          return 'value';
        }),
        'value',
      );
      await assert.rejects(
        transaction(engine, async () => {
          await note('dropped');
          throw ROLLBACK;
        }),
        (error) => error === ROLLBACK,
      );
      assert.deepEqual(await labels(), ['kept']);
    });

    it('with concurrent transactions, one rollback and one commit keep exactly the committed rows', async () => {
      const committed = transaction(engine, async () => {
        await note('committed-1');
        await pause(20);
        await note('committed-2');
      });
      const rolledBack = transaction(engine, async () => {
        await note('rolled-back-1');
        await pause(10);
        await note('rolled-back-2');
        throw ROLLBACK;
      });
      const [first, second] = await Promise.allSettled([committed, rolledBack]);
      assert.equal(first.status, 'fulfilled');
      assert.equal(second.status, 'rejected');
      assert.deepEqual(await labels(), ['committed-1', 'committed-2']);
    });

    it('every lease taken inside the body joins the transaction', async () => {
      await assert.rejects(
        transaction(engine, async () => {
          const inside = await engine.lease();
          await inside.query("INSERT INTO notes (label) VALUES ('view')");
          await inside.release();
          await Promise.all([note('parallel-1'), note('parallel-2')]);
          throw ROLLBACK;
        }),
        (error) => error === ROLLBACK,
      );
      assert.deepEqual(await labels(), []);
    });

    it('a lease taken before the transaction keeps its own connection and session inside it', async () => {
      const sessionSql =
        driver === 'postgres'
          ? 'SELECT pg_backend_pid() AS session'
          : driver === 'mariadb'
            ? 'SELECT CONNECTION_ID() AS session'
            : undefined;
      const sessionOf = async (conn: Conn): Promise<unknown> =>
        sessionSql === undefined ? undefined : (await conn.query(sessionSql)).rows[0]?.session;
      const early = await engine.lease();
      try {
        const own = await sessionOf(early);
        await transaction(engine, async () => {
          await note('uncommitted');
          // Its own connection reads only what committed.
          assert.deepEqual((await early.query('SELECT label FROM notes')).rows, []);
          assert.equal(await sessionOf(early), own);
          if (sessionSql !== undefined) {
            assert.notEqual(await sessionOf(await engine.lease()), own);
          }
        });
      } finally {
        await early.release();
      }
      assert.deepEqual(await labels(), ['uncommitted']);
    });
  });

  describe('nested frames', () => {
    it('a caught nested failure leaves no nested writes', async () => {
      await transaction(engine, async () => {
        await note('outer-before');
        await assert.rejects(
          transaction(engine, async (tx) => {
            assert.equal(tx.depth, 2);
            await note('nested');
            await note('outer-before');
          }),
          (error: unknown) => isDatabaseError(error, 'unique_violation'),
        );
        await note('outer-after');
      });
      assert.deepEqual(await labels(), ['outer-after', 'outer-before']);
    });

    it('a Promise.all pair of nested transactions does not interleave savepoints', async () => {
      const ledger = createQueryLedger({ detail: true });
      await withQueryLedger(ledger, () =>
        transaction(engine, () =>
          Promise.all(
            ['first', 'second'].map((label) =>
              transaction(engine, async () => {
                await note(`${label}-a`);
                await pause(15);
                await note(`${label}-b`);
              }),
            ),
          ),
        ),
      );
      const savepoints = ledger.records
        .map((record) => record.sql)
        .filter((sql) => /SAVEPOINT/.test(sql))
        .map((sql) => sql.replace(/jsails_sp_\d+/, 'sp'));
      assert.deepEqual(savepoints, [
        'SAVEPOINT sp',
        'RELEASE SAVEPOINT sp',
        'SAVEPOINT sp',
        'RELEASE SAVEPOINT sp',
      ]);
      const inserts = ledger.records
        .map((record) => record.sql)
        .filter((sql) => sql.startsWith('INSERT'))
        .map((sql) => /'([a-z-]+)'/.exec(sql)?.[1]);
      // One sibling's statements all run before the other's.
      assert.ok(
        ['first-a,first-b,second-a,second-b', 'second-a,second-b,first-a,first-b'].includes(
          inserts.join(','),
        ),
        inserts.join(','),
      );
      assert.equal((await labels()).length, 4);
    });

    it("a parent's statement issued while a nested frame is open waits for it, outside its savepoint", async () => {
      await transaction(engine, async () => {
        const nested = transaction(engine, async () => {
          await note('nested');
          await pause(20);
          throw ROLLBACK;
        });
        const parent = note('parent');
        await assert.rejects(nested, (error) => error === ROLLBACK);
        await parent;
      });
      assert.deepEqual(await labels(), ['parent']);
    });
  });

  describe('the poisoned-frame rule', () => {
    it('catch-and-continue without a savepoint throws aborted identically on every driver', async () => {
      let duplicate: unknown;
      await assert.rejects(
        transaction(engine, async () => {
          await note('first');
          try {
            await note('first');
          } catch (error) {
            duplicate = error;
          }
          await note('second');
        }),
        isTransactionError('aborted'),
      );
      assert.ok(isDatabaseError(duplicate, 'unique_violation'));
      assert.deepEqual(await labels(), []);
    });

    it('a body that swallows a failure still rolls back, with aborted', async () => {
      await assert.rejects(
        transaction(engine, async () => {
          await note('first');
          await note('first').catch(() => {
            // Swallowed on purpose: the rule must hold anyway.
          });
          return 'unreachable';
        }),
        (error: unknown) => {
          assert.ok(TransactionErrors.is(error, 'aborted'));
          assert.ok(isDatabaseError(error.cause, 'unique_violation'));
          return true;
        },
      );
      assert.deepEqual(await labels(), []);
    });
  });

  describe('isolation, read-only and retry', () => {
    /** Read twice inside the transaction while a detached write commits in between. */
    async function rereads(isolation: IsolationLevel): Promise<[number, number]> {
      await exec(engine, 'DELETE FROM oncall', 'INSERT INTO oncall (id, active) VALUES (1, 1)');
      const read = async (): Promise<number> => {
        const conn = await engine.lease();
        const { rows } = await conn.query('SELECT active FROM oncall WHERE id = 1');
        await conn.release();
        return Number(rows[0]?.active);
      };
      return transaction(
        engine,
        async () => {
          const first = await read();
          await detached(async () => {
            const conn = await engine.lease();
            await conn.query('UPDATE oncall SET active = 2 WHERE id = 1');
            await conn.release();
          });
          return [first, await read()];
        },
        { isolation, readOnly: true },
      );
    }

    it('the isolation level is observable', async () => {
      // SQLite transactions are serializable, which satisfies every level.
      assert.deepEqual(await rereads('read committed'), driver === 'sqlite' ? [1, 1] : [1, 2]);
      assert.deepEqual(await rereads('repeatable read'), [1, 1]);
      if (driver !== 'mariadb') {
        // InnoDB's serializable reads take shared locks, so the detached
        // write would wait for this very transaction.
        assert.deepEqual(await rereads('serializable'), [1, 1]);
      }
      if (driver === 'postgres') {
        const level = await transaction(
          engine,
          async () => {
            const conn = await engine.lease();
            const { rows } = await conn.query('SHOW transaction_isolation');
            return rows[0]?.transaction_isolation;
          },
          { isolation: 'serializable' },
        );
        assert.equal(level, 'serializable');
      }
    });

    it('a read-only transaction refuses writes', async () => {
      await assert.rejects(
        transaction(engine, () => note('refused'), { readOnly: true }),
        (error: unknown) => isDatabaseError(error, 'read_only'),
      );
      assert.deepEqual(await labels(), []);
    });

    it('two conflicting serializable transactions succeed with retry', async () => {
      await exec(engine, 'INSERT INTO oncall (id, active) VALUES (1, 1), (2, 1)');
      const bothRead = { count: 0, gate: gate() };
      let runs = 0;
      const attempts = 8;
      // Write skew: each doctor goes off call if another is still on call.
      const goOffCall = (id: number) =>
        transaction(
          engine,
          async () => {
            runs += 1;
            const conn = await engine.lease();
            const { rows } = await conn.query(
              'SELECT COUNT(*) AS active FROM oncall WHERE active = 1',
            );
            if (driver !== 'sqlite') {
              // On a server both read before either writes; SQLite writers
              // run one at a time, so there is nothing to wait for.
              bothRead.count += 1;
              if (bothRead.count === 2) bothRead.gate.open();
              const timeout = new AbortController();
              await Promise.race([
                bothRead.gate.opened,
                pause(2000, undefined, { signal: timeout.signal }).catch(() => {
                  // Aborted once the gate opened; nothing to wait for.
                }),
              ]);
              timeout.abort();
            }
            if (Number(rows[0]?.active) >= 2) {
              await conn.query(`UPDATE oncall SET active = 0 WHERE id = ${id}`);
            }
          },
          // A wide jittered backoff, so two bodies that both failed do not
          // retry in step and meet again on a loaded server.
          { isolation: 'serializable', retry: { attempts, backoffMs: 50 } },
        );
      await Promise.all([goOffCall(1), goOffCall(2)]);
      const conn = await engine.lease();
      const { rows } = await conn.query('SELECT COUNT(*) AS active FROM oncall WHERE active = 1');
      await conn.release();
      assert.equal(Number(rows[0]?.active), 1);
      if (driver === 'sqlite') {
        assert.equal(runs, 2);
      } else {
        // At least one body re-ran. How many re-run is the server's choice:
        // InnoDB rolls back one deadlock victim, while PostgreSQL's
        // serializable checks may abort both transactions, and their retries
        // may meet again, so only the attempt limit bounds the count.
        assert.ok(runs >= 3 && runs <= 2 * attempts, `${runs} runs`);
      }
    });

    it('outermost-only options on a nested transaction are refused', async () => {
      await transaction(engine, async () => {
        await assert.rejects(
          transaction(engine, () => undefined, { isolation: 'serializable' }),
          isTransactionError('outermost_only'),
        );
        await assert.rejects(
          transaction(engine, () => undefined, { timeoutMs: 100 }),
          isTransactionError('outermost_only'),
        );
      });
    });
  });

  describe('fail closed after the end', () => {
    it('a statement after close throws, and detached work runs on its own', async () => {
      const later = gate();
      let leaked: Promise<unknown> | undefined;
      let escaped: Promise<unknown> | undefined;
      let tx: { afterCommit(callback: () => unknown): void } | undefined;
      await transaction(engine, async (handle) => {
        tx = handle;
        leaked = later.opened.then(() => note('leaked'));
        escaped = detached(() => later.opened.then(() => note('detached')));
        await note('inside');
      });
      later.open();
      const [leakedResult, escapedResult] = await Promise.allSettled([leaked, escaped]);
      assert.equal(leakedResult?.status, 'rejected');
      isTransactionError('closed')(leakedResult.reason);
      assert.equal(escapedResult?.status, 'fulfilled');
      assert.throws(() => tx?.afterCommit(() => undefined), isTransactionError('closed'));
      assert.deepEqual(await labels(), ['detached', 'inside']);
    });

    it('a lease, a nested transaction and begin() from an ended transaction all throw closed', async () => {
      const later = gate();
      let attempts: Promise<unknown>[] = [];
      await transaction(engine, () => {
        attempts = [
          later.opened.then(() => engine.lease()),
          later.opened.then(() => transaction(engine, () => undefined)),
          later.opened.then(() => engine.begin()),
        ];
      });
      later.open();
      const settled = await Promise.allSettled(attempts);
      for (const result of settled) {
        assert.equal(result.status, 'rejected');
        isTransactionError('closed')(result.reason);
      }
    });

    it('a timeout rolls back, frees the lease and fails the late statements', async () => {
      const resume = gate();
      const issued = gate();
      let late: Promise<unknown> | undefined;
      const started = Date.now();
      await assert.rejects(
        transaction(
          engine,
          async () => {
            await note('timed-out');
            await resume.opened;
            late = note('too-late');
            issued.open();
            await late;
          },
          { timeoutMs: 150 },
        ),
        isTransactionError('timeout'),
      );
      assert.ok(Date.now() - started < 2000);
      // The lease is free: on SQLite the writer lock, on a server the pool slot.
      await transaction(engine, () => note('next'));
      resume.open();
      await issued.opened;
      await assert.rejects(late as Promise<unknown>, isTransactionError('timeout'));
      assert.deepEqual(await labels(), ['next']);
    });
  });

  describe('withTestTransaction', () => {
    it('a raw Conn write made through a lease inside it is gone afterwards', async () => {
      const value = await withTestTransaction(engine, async () => {
        const conn = await engine.lease();
        await conn.query("INSERT INTO notes (label) VALUES ('raw')");
        await conn.release();
        await transaction(engine, () => note('in-transaction'));
        assert.deepEqual(await labels(), ['in-transaction', 'raw']);
        return 'done';
      });
      assert.equal(value, 'done');
      assert.deepEqual(await labels(), []);
    });

    it("runs a committed transaction's afterCommit callbacks inside it, so their writes roll back too", async () => {
      const ran: number[] = [];
      await withTestTransaction(engine, async () => {
        await transaction(engine, async (tx) => {
          assert.equal(tx.depth, 1);
          tx.afterCommit(async () => {
            await note('after-commit');
            ran.push(tx.depth);
          });
          await note('body');
        });
        assert.deepEqual(ran, [1]);
        assert.deepEqual(await labels(), ['after-commit', 'body']);
      });
      assert.deepEqual(await labels(), []);
    });

    it("rolls back a rolled-back transaction's afterRollback writes with it too", async () => {
      await withTestTransaction(engine, async () => {
        await assert.rejects(
          transaction(engine, async (tx) => {
            tx.afterRollback(() => note('after-rollback'));
            await note('attempt');
            throw ROLLBACK;
          }),
          (error) => error === ROLLBACK,
        );
        assert.deepEqual(await labels(), ['after-rollback']);
      });
      assert.deepEqual(await labels(), []);
    });

    it('refuses isolation and readOnly on the transaction inside it', async () => {
      await withTestTransaction(engine, async () => {
        await assert.rejects(
          transaction(engine, () => note('read-only'), { readOnly: true }),
          isTransactionError('unsupported_in_test'),
        );
        await assert.rejects(
          transaction(engine, () => note('isolated'), { isolation: 'serializable' }),
          isTransactionError('unsupported_in_test'),
        );
        assert.deepEqual(await labels(), []);
      });
    });

    it('a caught failure outside any transaction leaves later statements working', async () => {
      await withTestTransaction(engine, async () => {
        await note('one');
        await assert.rejects(note('one'), (error: unknown) =>
          isDatabaseError(error, 'unique_violation'),
        );
        await note('two');
        assert.deepEqual(await labels(), ['one', 'two']);
      });
      assert.deepEqual(await labels(), []);
    });
  });
});
