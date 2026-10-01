/**
 * The bound engine: it forwards the dialect engine's facts and statements,
 * leases inside a transaction take no connection of their own and route each
 * statement to the frame of that transaction bound to the caller's async
 * context, a lease never moves to another physical connection (checked on a
 * stub dialect engine that names its sessions), `begin()` is refused inside
 * a transaction of the same engine, and released connections refuse
 * statements.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BIND_LIMITS,
  isDatabaseError,
  type Conn,
  type Engine,
  type QueryResult,
  type TransactionConn,
} from '../../src/engine/index.js';
import { bindEngine } from '../../src/transaction/bound-engine.js';
import { detached, transaction, TransactionErrors } from '../../src/transaction/index.js';
import { labels, note, openNotesEngine } from './fixtures/sqlite-transaction-engine.js';

const FAILURE = new Error('roll back');

/**
 * A bound engine over a stub dialect engine whose every physical connection
 * answers each statement with its own session number, as `pg_backend_pid()`
 * or `CONNECTION_ID()` would.
 */
function sessionEngine(): Engine {
  let sessions = 0;
  const answer = (session: number) => (): Promise<QueryResult> =>
    Promise.resolve({ rows: [{ session }], affected: 0 });
  const conn = (session: number): Conn => ({
    dialect: 'postgres',
    query: answer(session),
    release: () => Promise.resolve(),
  });
  const transactionConn = (session: number): TransactionConn => ({
    ...conn(session),
    savepoint: () =>
      Promise.resolve({ rollback: () => Promise.resolve(), release: () => Promise.resolve() }),
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
  });
  const dialectEngine: Engine = {
    dialect: 'postgres',
    serverVersion: '17.0',
    bindLimit: BIND_LIMITS.postgres,
    lease: () => Promise.resolve(conn((sessions += 1))),
    begin: () => Promise.resolve(transactionConn((sessions += 1))),
    compile: () => {
      throw new Error('not used');
    },
    close: () => Promise.resolve(),
  };
  return bindEngine(dialectEngine, { acquireTimeoutMs: 1_000 });
}

async function sessionOf(conn: Conn): Promise<unknown> {
  const { rows } = await conn.query('SELECT session');
  return rows[0]?.session;
}

describe('bound engine', () => {
  it("forwards the dialect engine's facts and compiler", async (t) => {
    const engine = await openNotesEngine(t);
    assert.equal(engine.dialect, 'sqlite');
    assert.match(engine.serverVersion, /^3\./);
    assert.equal(engine.bindLimit, BIND_LIMITS.sqlite);
    assert.deepEqual(
      engine.compile({ kind: 'select', from: { table: 'notes' }, columns: '*' }).params,
      [],
    );
  });

  it('refuses begin() inside its own transaction, and allows it from detached work', async (t) => {
    const engine = await openNotesEngine(t);
    await transaction(engine, async () => {
      await assert.rejects(engine.begin(), (error: unknown) =>
        TransactionErrors.is(error, 'nested_begin'),
      );
      const independent = await detached(() => engine.begin({ readOnly: true }));
      await independent.rollback();
    });
  });

  it('a lease inside a transaction releases as a no-op and then refuses statements', async (t) => {
    const engine = await openNotesEngine(t);
    await transaction(engine, async () => {
      const conn = await engine.lease();
      await conn.query("INSERT INTO notes (label) VALUES ('kept')");
      await conn.release();
      await conn.release();
      await assert.rejects(conn.query('SELECT 1'), (error: unknown) =>
        isDatabaseError(error, 'released'),
      );
      await note(engine, 'still open');
    });
    assert.deepEqual(await labels(engine), ['kept', 'still open']);
  });

  it('a released autocommit lease refuses statements', async (t) => {
    const engine = await openNotesEngine(t);
    const conn = await engine.lease();
    await conn.release();
    await conn.release();
    await assert.rejects(conn.query('SELECT 1'), (error: unknown) =>
      isDatabaseError(error, 'released'),
    );
  });

  it('a lease taken in the outer frame and used in a nested body joins the nested frame', async (t) => {
    const engine = await openNotesEngine(t);
    await transaction(engine, async () => {
      const outer = await engine.lease();
      await assert.rejects(
        transaction(engine, async () => {
          await outer.query("INSERT INTO notes (label) VALUES ('nested')");
          throw FAILURE;
        }),
        (error) => error === FAILURE,
      );
      await outer.query("INSERT INTO notes (label) VALUES ('outer')");
    });
    assert.deepEqual(await labels(engine), ['outer']);
  });

  it('a lease taken outside every transaction keeps its own connection inside one', async () => {
    const engine = sessionEngine();
    const outside = await engine.lease();
    const own = await sessionOf(outside);
    const [fromInside, ofTheTransaction] = await transaction(engine, async () => [
      await sessionOf(outside),
      await sessionOf(await engine.lease()),
    ]);
    assert.equal(fromInside, own);
    assert.notEqual(ofTheTransaction, own);
  });

  it("a lease taken in one transaction stays on its connection inside another's body", async () => {
    const engine = sessionEngine();
    await transaction(engine, async () => {
      const mine = await engine.lease();
      const session = await sessionOf(mine);
      await detached(() =>
        transaction(engine, async () => {
          assert.notEqual(await sessionOf(await engine.lease()), session);
          assert.equal(await sessionOf(mine), session);
        }),
      );
    });
  });

  it('a lease taken in a frame keeps to it when used from detached work', async (t) => {
    const engine = await openNotesEngine(t);
    await assert.rejects(
      transaction(engine, async () => {
        const conn = await engine.lease();
        await detached(() => conn.query("INSERT INTO notes (label) VALUES ('frame')"));
        throw FAILURE;
      }),
      (error) => error === FAILURE,
    );
    assert.deepEqual(await labels(engine), []);
  });
});
