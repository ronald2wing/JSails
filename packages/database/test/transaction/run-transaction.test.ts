/**
 * `transaction()` and `withTestTransaction()` on SQLite: argument and option
 * validation, frame depth, afterCommit and afterRollback ordering and their
 * failures, the order of a frame's undos, where callbacks run (the enclosing
 * open frame, a virtual root, another engine's open transaction), a failed
 * COMMIT, a transaction the database ended under a nested frame, the
 * bounded wait for a frame held by a nested one, opt-in retry, the timeout,
 * and the virtual root's rules.
 */

import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { DatabaseError, isDatabaseError, type Engine } from '../../src/engine/index.js';
import { createCommitBuffer } from '../../src/transaction/commit-buffer.js';
import {
  detached,
  transaction,
  TransactionErrors,
  withTestTransaction,
  type TransactionArgument,
  type TransactionRunOptions,
} from '../../src/transaction/index.js';
import { boundFrame } from '../../src/transaction/transaction-scope.js';
import { labels, note, openNotesEngine } from './fixtures/sqlite-transaction-engine.js';

const FAILURE = new Error('body failed');
/** Short enough that a write waiting on a lock held by its own test fails fast. */
const SHORT_ACQUIRE = { acquireTimeoutMs: 500 } as const;

/** `promise`, or a rejection when it is still pending after `ms`: a hang fails the test. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, pending]);
  } finally {
    clearTimeout(timer);
  }
}

function transactionError(
  code: Parameters<typeof TransactionErrors.is>[1],
  argument?: TransactionArgument,
) {
  return (error: unknown): boolean => {
    assert.ok(
      TransactionErrors.is(error, code),
      `expected transaction.${code}, got ${String(error)}`,
    );
    if (argument !== undefined) {
      assert.deepEqual((error as { context: unknown }).context, { argument });
    }
    return true;
  };
}

describe('transaction arguments', () => {
  it('refuses an engine createEngine did not open', async (t) => {
    const engine = await openNotesEngine(t);
    const foreign: Engine = {
      dialect: engine.dialect,
      serverVersion: engine.serverVersion,
      bindLimit: engine.bindLimit,
      lease: () => engine.lease(),
      begin: (options) => engine.begin(options),
      compile: (statement) => engine.compile(statement),
      close: () => engine.close(),
    };
    await assert.rejects(
      transaction(foreign, () => 1),
      transactionError('unbound_engine'),
    );
    await assert.rejects(
      withTestTransaction(foreign, () => 1),
      transactionError('unbound_engine'),
    );
  });

  it('refuses a body that is not a function', async (t) => {
    const engine = await openNotesEngine(t);
    const body = 'not a function' as unknown as () => unknown;
    await assert.rejects(transaction(engine, body), transactionError('invalid_arguments', 'body'));
    await assert.rejects(
      withTestTransaction(engine, body),
      transactionError('invalid_arguments', 'body'),
    );
  });

  it('names the malformed option without echoing its value', async (t) => {
    const engine = await openNotesEngine(t);
    const cases: [unknown, TransactionArgument][] = [
      ['serializable', 'options'],
      [{ timeout: 5 }, 'options'],
      [{ isolation: 'snapshot' }, 'isolation'],
      [{ readOnly: 'yes' }, 'readOnly'],
      [{ timeoutMs: 0 }, 'timeoutMs'],
      [{ timeoutMs: 1.5 }, 'timeoutMs'],
      [{ timeoutMs: 2 ** 31 }, 'timeoutMs'],
      [{ retry: 3 }, 'retry'],
      [{ retry: { attempts: 2, delay: 1 } }, 'retry'],
      [{ retry: { attempts: 0 } }, 'retry.attempts'],
      [{ retry: { attempts: 21 } }, 'retry.attempts'],
      [{ retry: { attempts: 2, on: true } }, 'retry.on'],
      [{ retry: { attempts: 2, backoffMs: -1 } }, 'retry.backoffMs'],
    ];
    for (const [options, argument] of cases) {
      await assert.rejects(
        transaction(engine, () => undefined, options as TransactionRunOptions),
        transactionError('invalid_arguments', argument),
      );
    }
    assert.deepEqual(await labels(engine), []);
  });

  it('refuses outermost-only options on a nested call, naming the first', async (t) => {
    const engine = await openNotesEngine(t);
    await transaction(engine, async () => {
      await assert.rejects(
        transaction(engine, () => undefined, { readOnly: false, retry: { attempts: 2 } }),
        transactionError('outermost_only', 'readOnly'),
      );
      await assert.rejects(
        transaction(engine, () => undefined, { retry: { attempts: 2 } }),
        transactionError('outermost_only', 'retry'),
      );
    });
  });
});

describe('frames and callbacks', () => {
  it('reports the depth of each frame', async (t) => {
    const engine = await openNotesEngine(t);
    const depths = await transaction(engine, (outer) =>
      transaction(engine, (middle) =>
        transaction(engine, (inner) => [outer.depth, middle.depth, inner.depth]),
      ),
    );
    assert.deepEqual(depths, [1, 2, 3]);
  });

  it('runs afterCommit callbacks after the commit, in order, with the scope removed', async (t) => {
    const engine = await openNotesEngine(t);
    const seen: string[] = [];
    await transaction(engine, async (tx) => {
      tx.afterCommit(async () => {
        seen.push(`first:${(await labels(engine)).join(',')}`);
        // A new outermost transaction, not a nested frame of the ended one.
        seen.push(`depth:${await transaction(engine, (inner) => inner.depth)}`);
      });
      tx.afterCommit(() => {
        seen.push('second');
      });
      tx.afterRollback(() => {
        seen.push('rollback');
      });
      await note(engine, 'committed');
      seen.push('body');
    });
    assert.deepEqual(seen, ['body', 'first:committed', 'depth:1', 'second']);
  });

  it("keeps a released nested frame's callbacks for the outermost end", async (t) => {
    const engine = await openNotesEngine(t);
    const seen: string[] = [];
    await transaction(engine, async () => {
      await transaction(engine, (tx) => {
        tx.afterCommit(() => seen.push('released:commit'));
        tx.afterRollback(() => seen.push('released:rollback'));
      });
      await assert.rejects(
        transaction(engine, (tx) => {
          tx.afterCommit(() => seen.push('rolled-back:commit'));
          tx.afterRollback(() => seen.push('rolled-back:rollback'));
          throw FAILURE;
        }),
        (error) => error === FAILURE,
      );
      seen.push('outer body');
    });
    assert.deepEqual(seen, ['rolled-back:rollback', 'outer body', 'released:commit']);

    seen.length = 0;
    await assert.rejects(
      transaction(engine, async () => {
        await transaction(engine, (tx) => {
          tx.afterCommit(() => seen.push('released:commit'));
          tx.afterRollback(() => seen.push('released:rollback'));
        });
        throw FAILURE;
      }),
      (error) => error === FAILURE,
    );
    assert.deepEqual(seen, ['released:rollback']);
  });

  it('runs the undos of a rolled-back frame newest first, before its afterRollback callbacks', async (t) => {
    const engine = await openNotesEngine(t);
    const seen: string[] = [];
    const undo = (label: string) => () => {
      const frame = boundFrame(engine);
      assert.ok(frame !== undefined);
      frame.registerUndo(() => seen.push(label));
    };
    await assert.rejects(
      transaction(engine, async (tx) => {
        tx.afterRollback(() => seen.push('afterRollback'));
        undo('first')();
        // A released nested frame's undos join its parent's, in order.
        await transaction(engine, undo('nested'));
        undo('last')();
        throw FAILURE;
      }),
      (error) => error === FAILURE,
    );
    assert.deepEqual(seen, ['last', 'nested', 'first', 'afterRollback']);

    seen.length = 0;
    await transaction(engine, async () => {
      undo('committed')();
      await assert.rejects(
        transaction(engine, () => {
          undo('savepoint')();
          throw FAILURE;
        }),
        (error) => error === FAILURE,
      );
    });
    assert.deepEqual(seen, ['savepoint'], 'a commit drops the undos');

    const ended = await transaction(engine, () => boundFrame(engine));
    assert.throws(() => ended?.registerUndo(() => undefined), transactionError('closed'));
    await transaction(engine, () => {
      assert.throws(
        () => boundFrame(engine)?.registerUndo('later' as unknown as () => void),
        transactionError('invalid_arguments', 'callback'),
      );
    });
  });

  it('refuses a callback that is not a function', async (t) => {
    const engine = await openNotesEngine(t);
    await transaction(engine, (tx) => {
      assert.throws(
        () => tx.afterCommit('later' as unknown as () => unknown),
        transactionError('invalid_arguments', 'callback'),
      );
    });
  });

  it('reports failed afterCommit callbacks as after_commit_failed, with the data committed', async (t) => {
    const engine = await openNotesEngine(t);
    const callbackFailure = new Error('callback failed');
    await assert.rejects(
      transaction(engine, async (tx) => {
        tx.afterCommit(() => {
          throw callbackFailure;
        });
        await note(engine, 'one');
      }),
      (error: unknown) => {
        assert.ok(TransactionErrors.is(error, 'after_commit_failed'));
        assert.deepEqual(error.context, { count: 1 });
        assert.equal(error.cause, callbackFailure);
        return true;
      },
    );
    await assert.rejects(
      transaction(engine, async (tx) => {
        tx.afterCommit(() => Promise.reject(callbackFailure));
        tx.afterCommit(() => {
          throw callbackFailure;
        });
        await note(engine, 'two');
      }),
      (error: unknown) => {
        assert.ok(TransactionErrors.is(error, 'after_commit_failed'));
        assert.ok(error.cause instanceof AggregateError);
        assert.deepEqual(error.cause.errors, [callbackFailure, callbackFailure]);
        return true;
      },
    );
    assert.deepEqual(await labels(engine), ['one', 'two']);
  });

  it('reports failed afterRollback callbacks with the original failure first', async (t) => {
    const engine = await openNotesEngine(t);
    const callbackFailure = new Error('callback failed');
    await assert.rejects(
      transaction(engine, (tx) => {
        tx.afterRollback(() => {
          throw callbackFailure;
        });
        throw FAILURE;
      }),
      (error: unknown) => {
        assert.ok(TransactionErrors.is(error, 'after_rollback_failed'));
        assert.ok(error.cause instanceof AggregateError);
        assert.deepEqual(error.cause.errors, [FAILURE, callbackFailure]);
        return true;
      },
    );
  });

  it('reports a failed COMMIT as the rejection, runs afterRollback, and keeps nothing', async (t) => {
    const engine = await openNotesEngine(t);
    const conn = await engine.lease();
    await conn.query(
      'CREATE TABLE children (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES notes (id) DEFERRABLE INITIALLY DEFERRED)',
    );
    await conn.release();
    const seen: string[] = [];
    await assert.rejects(
      transaction(engine, async (tx) => {
        tx.afterRollback(() => seen.push('rollback'));
        tx.afterCommit(() => seen.push('commit'));
        await note(engine, 'parent');
        const inside = await engine.lease();
        await inside.query('INSERT INTO children (note_id) VALUES (999)');
      }),
      (error: unknown) => isDatabaseError(error, 'foreign_key_violation'),
    );
    assert.deepEqual(seen, ['rollback']);
    assert.deepEqual(await labels(engine), []);
  });

  it('poisons every enclosing frame when the database ended the transaction under a nested one', async (t) => {
    const engine = await openNotesEngine(t);
    const conn = await engine.lease();
    await conn.query(
      "CREATE TRIGGER notes_abort BEFORE INSERT ON notes WHEN NEW.label = 'abort' BEGIN SELECT RAISE(ROLLBACK, 'abort'); END",
    );
    await conn.release();
    const seen: string[] = [];
    await assert.rejects(
      transaction(engine, async () => {
        await note(engine, 'outer');
        await assert.rejects(
          transaction(engine, async (tx) => {
            tx.afterRollback(() => seen.push('nested rollback'));
            await note(engine, 'abort');
          }),
          (error: unknown) => isDatabaseError(error, 'query_failed'),
        );
        await note(engine, 'after');
      }),
      transactionError('aborted'),
    );
    assert.deepEqual(seen, ['nested rollback']);
    assert.deepEqual(await labels(engine), []);

    seen.length = 0;
    await withTestTransaction(engine, async () => {
      await assert.rejects(
        transaction(engine, async (tx) => {
          tx.afterRollback(() => seen.push('first-level rollback'));
          await note(engine, 'abort');
        }),
        (error: unknown) => isDatabaseError(error, 'query_failed'),
      );
      await assert.rejects(note(engine, 'after'), transactionError('aborted'));
    });
    assert.deepEqual(seen, ['first-level rollback']);
  });
});

describe('where callbacks run', () => {
  it('afterRollback writes of a rolled-back nested frame join the enclosing transaction', async (t) => {
    const engine = await openNotesEngine(t, SHORT_ACQUIRE);
    await transaction(engine, async () => {
      await assert.rejects(
        transaction(engine, async (tx) => {
          tx.afterRollback(() => note(engine, 'compensated'));
          await note(engine, 'attempt');
          throw FAILURE;
        }),
        (error) => error === FAILURE,
      );
    });
    assert.deepEqual(await labels(engine), ['compensated']);

    await assert.rejects(
      transaction(engine, async () => {
        await assert.rejects(
          transaction(engine, (tx) => {
            tx.afterRollback(() => note(engine, 'lost with the outer'));
            throw FAILURE;
          }),
          (error) => error === FAILURE,
        );
        throw FAILURE;
      }),
      (error) => error === FAILURE,
    );
    assert.deepEqual(await labels(engine), ['compensated']);
  });

  it("afterCommit callbacks and buffer deliveries keep another engine's open transaction bound", async (t) => {
    const a = await openNotesEngine(t, SHORT_ACQUIRE);
    const b = await openNotesEngine(t, SHORT_ACQUIRE);
    const buffer = createCommitBuffer<string>(async (items) => {
      for (const item of items) await note(a, item);
    });
    await transaction(a, async () => {
      await note(a, 'a-body');
      await transaction(b, async (tx) => {
        await note(b, 'b-body');
        await buffer.add(b, 'a-from-b-buffer');
        tx.afterCommit(() => note(a, 'a-from-b-callback'));
      });
    });
    assert.deepEqual(await labels(a), ['a-body', 'a-from-b-buffer', 'a-from-b-callback']);
    assert.deepEqual(await labels(b), ['b-body']);

    await assert.rejects(
      transaction(a, async () => {
        await transaction(b, (tx) => {
          tx.afterCommit(() => note(a, 'lost with a'));
        });
        throw FAILURE;
      }),
      (error) => error === FAILURE,
    );
    await withTestTransaction(a, () =>
      transaction(b, (tx) => {
        tx.afterCommit(() => note(a, 'rolled back with the test'));
      }),
    );
    assert.deepEqual(await labels(a), ['a-body', 'a-from-b-buffer', 'a-from-b-callback']);
  });

  it('under withTestTransaction, afterRollback writes stay inside the test transaction', async (t) => {
    const engine = await openNotesEngine(t, SHORT_ACQUIRE);
    await withTestTransaction(engine, async () => {
      await assert.rejects(
        transaction(engine, async (tx) => {
          tx.afterRollback(() => note(engine, 'compensated'));
          await note(engine, 'attempt');
          throw FAILURE;
        }),
        (error) => error === FAILURE,
      );
      assert.deepEqual(await labels(engine), ['compensated']);
    });
    assert.deepEqual(await labels(engine), []);
  });

  it('under withTestTransaction, afterRollback writes of a timed-out transaction stay inside it', async (t) => {
    const engine = await openNotesEngine(t, SHORT_ACQUIRE);
    const resume = new AbortController();
    t.after(() => resume.abort());
    await withTestTransaction(engine, async () => {
      await assert.rejects(
        transaction(
          engine,
          async (tx) => {
            tx.afterRollback(() => note(engine, 'timed out'));
            await pause(10_000, undefined, { signal: resume.signal }).catch(() => {
              // Aborted when the test ends; the transaction expired long before.
            });
          },
          { timeoutMs: 30 },
        ),
        transactionError('timeout'),
      );
      assert.deepEqual(await labels(engine), ['timed out']);
    });
    assert.deepEqual(await labels(engine), []);
  });

  it('under withTestTransaction, afterRollback writes after the database ended the test transaction fail aborted', async (t) => {
    const engine = await openNotesEngine(t, SHORT_ACQUIRE);
    const conn = await engine.lease();
    await conn.query(
      "CREATE TRIGGER notes_abort BEFORE INSERT ON notes WHEN NEW.label = 'abort' BEGIN SELECT RAISE(ROLLBACK, 'abort'); END",
    );
    await conn.release();
    await withTestTransaction(engine, async () => {
      await assert.rejects(
        transaction(engine, async (tx) => {
          tx.afterRollback(() => note(engine, 'escaped'));
          await note(engine, 'abort');
        }),
        (error: unknown) => {
          assert.ok(TransactionErrors.is(error, 'after_rollback_failed'));
          assert.ok(error.cause instanceof AggregateError);
          assert.ok(isDatabaseError(error.cause.errors[0], 'query_failed'));
          assert.ok(TransactionErrors.is(error.cause.errors[1], 'aborted'));
          return true;
        },
      );
    });
    assert.deepEqual(await labels(engine), []);
  });
});

describe('waiting for a frame', () => {
  it('a statement started in a frame and awaited inside a nested one fails with frame_busy', async (t) => {
    const engine = await openNotesEngine(t, SHORT_ACQUIRE);
    await assert.rejects(
      within(
        transaction(engine, async () => {
          const read = labels(engine);
          await transaction(engine, async () => {
            await read;
          });
        }),
        5_000,
      ),
      transactionError('frame_busy'),
    );

    await withTestTransaction(engine, async () => {
      const read = labels(engine);
      await assert.rejects(
        within(
          transaction(engine, async () => {
            await read;
          }),
          5_000,
        ),
        transactionError('frame_busy'),
      );
      await note(engine, 'the test goes on');
    });
  });

  it('a nested frame awaiting a sibling opened after it fails with frame_busy', async (t) => {
    const engine = await openNotesEngine(t, SHORT_ACQUIRE);
    await transaction(engine, async () => {
      let later: Promise<unknown> | undefined;
      const first = transaction(engine, async () => {
        await pause(1);
        await later;
      });
      later = transaction(engine, () => note(engine, 'later'));
      await assert.rejects(within(first, 5_000), transactionError('frame_busy'));
      await assert.rejects(later, transactionError('frame_busy'));
      await note(engine, 'outer goes on');
    });
    assert.deepEqual(await labels(engine), ['outer goes on']);
  });
});

describe('retry', () => {
  it('re-runs the body on a transient failure until it succeeds', async (t) => {
    const engine = await openNotesEngine(t);
    let runs = 0;
    const value = await transaction(
      engine,
      async () => {
        runs += 1;
        await note(engine, `run-${runs}`);
        if (runs < 3) throw new DatabaseError('deadlock');
        return runs;
      },
      { retry: { attempts: 5, backoffMs: 1 } },
    );
    assert.equal(value, 3);
    assert.deepEqual(await labels(engine), ['run-3']);
  });

  it('stops at the attempt limit, on a failure that is not transient, and after a commit', async (t) => {
    const engine = await openNotesEngine(t);
    let runs = 0;
    await assert.rejects(
      transaction(
        engine,
        () => {
          runs += 1;
          throw new DatabaseError('serialization_failure');
        },
        { retry: { attempts: 2, backoffMs: 0 } },
      ),
      (error: unknown) => isDatabaseError(error, 'serialization_failure'),
    );
    assert.equal(runs, 2);

    runs = 0;
    await assert.rejects(
      transaction(
        engine,
        () => {
          runs += 1;
          throw new DatabaseError('unique_violation');
        },
        { retry: { attempts: 3 } },
      ),
      (error: unknown) => isDatabaseError(error, 'unique_violation'),
    );
    assert.equal(runs, 1);

    runs = 0;
    await assert.rejects(
      transaction(
        engine,
        (tx) => {
          runs += 1;
          tx.afterCommit(() => {
            throw new DatabaseError('deadlock');
          });
        },
        { retry: { attempts: 3, on: () => true } },
      ),
      transactionError('after_commit_failed'),
    );
    assert.equal(runs, 1);
  });

  it('asks a custom predicate', async (t) => {
    const engine = await openNotesEngine(t);
    let runs = 0;
    const value = await transaction(
      engine,
      () => {
        runs += 1;
        if (runs === 1) throw FAILURE;
        return 'second run';
      },
      { retry: { attempts: 2, backoffMs: 0, on: (error) => error === FAILURE } },
    );
    assert.equal(value, 'second run');
  });

  it('under withTestTransaction re-runs on a fresh savepoint', async (t) => {
    const engine = await openNotesEngine(t);
    await withTestTransaction(engine, async () => {
      let runs = 0;
      await transaction(
        engine,
        async () => {
          runs += 1;
          await note(engine, 'same');
          if (runs === 1) throw new DatabaseError('busy');
        },
        { retry: { attempts: 2, backoffMs: 0 } },
      );
      assert.equal(runs, 2);
      assert.deepEqual(await labels(engine), ['same']);
    });
  });
});

describe('timeout', () => {
  it('does nothing to a transaction that ends in time', async (t) => {
    const engine = await openNotesEngine(t);
    assert.equal(
      await transaction(
        engine,
        async () => {
          await note(engine, 'fast');
          return 'done';
        },
        { timeoutMs: 60_000 },
      ),
      'done',
    );
    await assert.rejects(
      transaction(
        engine,
        () => {
          throw FAILURE;
        },
        { timeoutMs: 60_000 },
      ),
      (error) => error === FAILURE,
    );
    assert.deepEqual(await labels(engine), ['fast']);
  });

  it('runs afterRollback callbacks on expiry and reports their failures with the timeout', async (t) => {
    const engine = await openNotesEngine(t);
    const callbackFailure = new Error('callback failed');
    const resume = new AbortController();
    t.after(() => resume.abort());
    await assert.rejects(
      transaction(
        engine,
        async (tx) => {
          tx.afterRollback(() => {
            throw callbackFailure;
          });
          await pause(10_000, undefined, { signal: resume.signal }).catch(() => {
            // Aborted when the test ends; the transaction expired long before.
          });
        },
        { timeoutMs: 30 },
      ),
      (error: unknown) => {
        assert.ok(TransactionErrors.is(error, 'after_rollback_failed'));
        assert.ok(error.cause instanceof AggregateError);
        assert.ok(TransactionErrors.is(error.cause.errors[0], 'timeout'));
        assert.equal(error.cause.errors[1], callbackFailure);
        return true;
      },
    );
  });

  it('under withTestTransaction rolls back the timed-out frame and lets the test go on', async (t) => {
    const engine = await openNotesEngine(t);
    await withTestTransaction(engine, async () => {
      const resume = new AbortController();
      let nested: Promise<unknown> | undefined;
      const seen: string[] = [];
      await assert.rejects(
        transaction(
          engine,
          async (tx) => {
            tx.afterRollback(() => seen.push('rollback'));
            await note(engine, 'timed-out');
            await pause(10_000, undefined, { signal: resume.signal }).catch(() => {
              // Aborted below, after the frame expired.
            });
            nested = transaction(engine, () => note(engine, 'nested'));
            await nested;
          },
          { timeoutMs: 30 },
        ),
        transactionError('timeout'),
      );
      assert.deepEqual(seen, ['rollback']);
      await note(engine, 'after');
      assert.deepEqual(await labels(engine), ['after']);
      resume.abort();
      await pause(5);
      await assert.rejects(nested as Promise<unknown>, transactionError('timeout'));
    });
    assert.deepEqual(await labels(engine), []);
  });
});

describe('withTestTransaction', () => {
  it("resolves with the body's value and rejects with its failure, rolling back both times", async (t) => {
    const engine = await openNotesEngine(t);
    assert.equal(
      await withTestTransaction(engine, async () => {
        await note(engine, 'kept-for-now');
        return 'value';
      }),
      'value',
    );
    await assert.rejects(
      withTestTransaction(engine, async () => {
        await note(engine, 'dropped');
        throw FAILURE;
      }),
      (error) => error === FAILURE,
    );
    assert.deepEqual(await labels(engine), []);
  });

  it('refuses to start inside a transaction of the same engine', async (t) => {
    const engine = await openNotesEngine(t);
    await transaction(engine, async () => {
      await assert.rejects(
        withTestTransaction(engine, () => 1),
        transactionError('nested_begin'),
      );
    });
    await withTestTransaction(engine, async () => {
      await assert.rejects(
        withTestTransaction(engine, () => 1),
        transactionError('nested_begin'),
      );
    });
  });

  it('refuses isolation and readOnly on the first transaction, which a savepoint cannot apply', async (t) => {
    const engine = await openNotesEngine(t);
    await withTestTransaction(engine, async () => {
      await assert.rejects(
        transaction(engine, () => note(engine, 'read-only write'), { readOnly: true }),
        transactionError('unsupported_in_test', 'readOnly'),
      );
      await assert.rejects(
        transaction(engine, () => undefined, { isolation: 'read committed' }),
        transactionError('unsupported_in_test', 'isolation'),
      );
      await transaction(
        engine,
        async (tx) => {
          assert.equal(tx.depth, 1);
          await note(engine, 'written');
          await assert.rejects(
            transaction(engine, () => undefined, { isolation: 'serializable' }),
            transactionError('outermost_only', 'isolation'),
          );
        },
        { readOnly: false, retry: { attempts: 2 }, timeoutMs: 60_000 },
      );
      assert.deepEqual(await labels(engine), ['written']);
    });
  });
});

describe('detached', () => {
  it('runs outside every transaction and returns what its function returns', async (t) => {
    const engine = await openNotesEngine(t);
    await transaction(engine, async (outer) => {
      assert.equal(outer.depth, 1);
      const depth = await detached(() =>
        transaction(engine, (inner) => inner.depth, { readOnly: true }),
      );
      assert.equal(depth, 1);
    });
  });
});
