/**
 * The connection layer every engine shares, against a scripted lease: the
 * released state, transaction control, savepoint order, a PostgreSQL commit
 * that rolled back, and discarding a connection whose rollback failed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createQueryLedger, DatabaseError, withQueryLedger } from '../../src/engine/index.js';
import {
  LeasedConn,
  LeasedTransaction,
  type LeaseHandle,
  type RawResult,
} from '../../src/engine/leased-conn.js';

/** The engine the scripted connections belong to, as far as the ledger is concerned. */
const ENGINE = Object.freeze({ name: 'scripted engine' });

interface Script {
  readonly sql: string[];
  readonly ends: boolean[];
  handle: LeaseHandle;
}

function scripted(
  respond: (sql: string) => RawResult | Error = () => ({ rows: [], affected: 0 }),
): Script {
  const script: Script = {
    sql: [],
    ends: [],
    handle: {
      run: async (sql) => {
        script.sql.push(sql);
        const outcome = respond(sql);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      end: async (discard) => {
        script.ends.push(discard);
      },
    },
  };
  return script;
}

describe('LeasedConn', () => {
  it('returns frozen results and keeps insertId only when present', async () => {
    const script = scripted((sql) =>
      sql.startsWith('INSERT')
        ? { rows: [], affected: 1, insertId: 7 }
        : { rows: [{ a: 1 }], affected: 0 },
    );
    const conn = new LeasedConn('sqlite', script.handle, ENGINE);
    const inserted = await conn.query('INSERT INTO t VALUES (1)');
    assert.deepEqual(inserted, { rows: [], affected: 1, insertId: 7 });
    assert.ok(Object.isFrozen(inserted));
    const selected = await conn.query('SELECT 1');
    assert.equal('insertId' in selected, false);
  });

  it('refuses empty SQL and unbindable parameters before running anything', async () => {
    const script = scripted();
    const conn = new LeasedConn('postgres', script.handle, ENGINE);
    await assert.rejects(conn.query('  '), { code: 'invalid_statement' });
    await assert.rejects(conn.query('SELECT $1', [undefined as never]), {
      code: 'invalid_parameter',
    });
    await assert.rejects(conn.query('SELECT $1', 'x' as never), { code: 'invalid_parameter' });
    assert.deepEqual(script.sql, []);
  });

  it('releases once and refuses statements afterwards', async () => {
    const script = scripted();
    const conn = new LeasedConn('mariadb', script.handle, ENGINE);
    await Promise.all([conn.release(), conn.release()]);
    assert.deepEqual(script.ends, [false]);
    await assert.rejects(conn.query('SELECT 1'), { code: 'released' });
  });

  it('ends the lease only after a statement still running has settled', async () => {
    const events: string[] = [];
    let finish: () => void = () => undefined;
    const handle: LeaseHandle = {
      run: () =>
        new Promise<RawResult>((resolve) => {
          finish = () => {
            events.push('query settled');
            resolve({ rows: [], affected: 0 });
          };
        }),
      end: async () => {
        events.push('ended');
      },
    };
    const conn = new LeasedConn('postgres', handle, ENGINE);
    const query = conn.query('SELECT pg_sleep(1)');
    const released = conn.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, []);
    finish();
    await Promise.all([query, released]);
    assert.deepEqual(events, ['query settled', 'ended']);
  });

  it('records failed statements in the ledger too', async () => {
    const conn = new LeasedConn(
      'sqlite',
      scripted(() => new DatabaseError('query_failed')).handle,
      ENGINE,
    );
    const ledger = createQueryLedger({ detail: true });
    await withQueryLedger(ledger, () =>
      assert.rejects(conn.query('SELEC 1', [], { origin: 'test' }), { code: 'query_failed' }),
    );
    assert.equal(ledger.count, 1);
    assert.equal(ledger.records[0]?.origin, 'test');
  });
});

describe('LeasedTransaction', () => {
  it('commits and releases the lease', async () => {
    const script = scripted();
    const tx = new LeasedTransaction('sqlite', script.handle, ENGINE);
    await tx.query('INSERT INTO t VALUES (1)');
    await tx.commit();
    assert.deepEqual(script.sql, ['INSERT INTO t VALUES (1)', 'COMMIT']);
    assert.deepEqual(script.ends, [false]);
    await assert.rejects(tx.commit(), { code: 'released' });
    await assert.rejects(tx.rollback(), { code: 'released' });
    await assert.rejects(tx.savepoint(), { code: 'released' });
  });

  it('reports a COMMIT answered with ROLLBACK as transaction_aborted', async () => {
    const script = scripted((sql) =>
      sql === 'COMMIT' ? { rows: [], affected: 0, command: 'ROLLBACK' } : { rows: [], affected: 0 },
    );
    const tx = new LeasedTransaction('postgres', script.handle, ENGINE);
    await assert.rejects(tx.commit(), { code: 'transaction_aborted' });
    assert.deepEqual(script.ends, [false]);
  });

  it('rolls back after a failed COMMIT, and discards when that fails too', async () => {
    const recoverable = scripted((sql) =>
      sql === 'COMMIT' ? new DatabaseError('foreign_key_violation') : { rows: [], affected: 0 },
    );
    const first = new LeasedTransaction('sqlite', recoverable.handle, ENGINE);
    await assert.rejects(first.commit(), { code: 'foreign_key_violation' });
    assert.deepEqual(recoverable.sql, ['COMMIT', 'ROLLBACK']);
    assert.deepEqual(recoverable.ends, [false]);

    const broken = scripted(() => new DatabaseError('connection_failed'));
    const second = new LeasedTransaction('postgres', broken.handle, ENGINE);
    await assert.rejects(second.commit(), { code: 'connection_failed' });
    assert.deepEqual(broken.ends, [true]);
  });

  it('discards the connection when ROLLBACK fails', async () => {
    const script = scripted(() => new DatabaseError('connection_failed'));
    const tx = new LeasedTransaction('mariadb', script.handle, ENGINE);
    await assert.rejects(tx.rollback(), { code: 'connection_failed' });
    assert.deepEqual(script.ends, [true]);
  });

  it('rolls back on release, once, however often it is called', async () => {
    const script = scripted();
    const tx = new LeasedTransaction('sqlite', script.handle, ENGINE);
    await Promise.all([tx.release(), tx.release()]);
    await tx.release();
    assert.deepEqual(script.sql, ['ROLLBACK']);
    assert.deepEqual(script.ends, [false]);
    await assert.rejects(tx.query('SELECT 1'), { code: 'released' });
  });

  it('names savepoints uniquely and ends inner ones with an outer one', async () => {
    const script = scripted();
    const tx = new LeasedTransaction('postgres', script.handle, ENGINE);
    const outer = await tx.savepoint();
    const inner = await tx.savepoint();
    await outer.rollback();
    await assert.rejects(inner.release(), { code: 'invalid_state' });
    const next = await tx.savepoint();
    await next.release();
    assert.deepEqual(script.sql, [
      'SAVEPOINT jsails_sp_1',
      'SAVEPOINT jsails_sp_2',
      'ROLLBACK TO SAVEPOINT jsails_sp_1',
      'RELEASE SAVEPOINT jsails_sp_1',
      'SAVEPOINT jsails_sp_3',
      'RELEASE SAVEPOINT jsails_sp_3',
    ]);
  });

  it('records transaction control with the engine origin', async () => {
    const ledger = createQueryLedger({ detail: true });
    const tx = new LeasedTransaction('sqlite', scripted().handle, ENGINE);
    await withQueryLedger(ledger, async () => {
      await (await tx.savepoint()).release();
      await tx.commit();
    });
    assert.deepEqual(
      ledger.records.map((record) => record.origin),
      ['engine', 'engine', 'engine'],
    );
  });

  it('runs nothing more once the engine reports the transaction lost, and refuses its commit', async () => {
    let open = true;
    const script = scripted((sql) => {
      if (sql.includes('fails')) {
        open = sql.includes('statement');
        return new DatabaseError('query_failed', { driverCode: '1213' });
      }
      return { rows: [], affected: 0 };
    });
    const handle: LeaseHandle = { ...script.handle, transactionLost: async () => !open };
    const survived = new LeasedTransaction('mariadb', handle, ENGINE);
    await assert.rejects(survived.query('UPDATE fails statement'), { code: 'query_failed' });
    await survived.query('INSERT INTO t VALUES (1)');
    await survived.commit();
    assert.deepEqual(script.sql.slice(-2), ['INSERT INTO t VALUES (1)', 'COMMIT']);

    const lost = new LeasedTransaction('mariadb', handle, ENGINE);
    await assert.rejects(lost.query('UPDATE fails transaction'), { code: 'query_failed' });
    const sent = script.sql.length;
    await assert.rejects(lost.query('INSERT INTO t VALUES (2)'), { code: 'transaction_aborted' });
    await assert.rejects(lost.savepoint(), { code: 'transaction_aborted' });
    await assert.rejects(lost.commit(), { code: 'transaction_aborted' });
    assert.equal(script.sql.length, sent, 'nothing reached the connection after the loss');
    assert.deepEqual(script.ends, [false, false]);
  });

  it('treats a failed loss probe as lost, and rolls back a lost transaction without SQL', async () => {
    const script = scripted((sql) =>
      sql.includes('fails') ? new DatabaseError('connection_failed') : { rows: [], affected: 0 },
    );
    const handle: LeaseHandle = {
      ...script.handle,
      transactionLost: () => Promise.reject(new DatabaseError('connection_failed')),
    };
    const tx = new LeasedTransaction('mariadb', handle, ENGINE);
    await assert.rejects(tx.query('SELECT fails'), { code: 'connection_failed' });
    await tx.rollback();
    assert.deepEqual(script.sql, ['SELECT fails']);
    assert.deepEqual(script.ends, [false]);
  });

  it('does not probe after a refusal that never reached the database', async () => {
    let probes = 0;
    const script = scripted();
    const handle: LeaseHandle = {
      ...script.handle,
      transactionLost: async () => {
        probes += 1;
        return true;
      },
    };
    const tx = new LeasedTransaction('sqlite', handle, ENGINE);
    await assert.rejects(tx.query('SELECT ?', [Number.NaN]), { code: 'invalid_parameter' });
    await tx.query('SELECT 1');
    await tx.commit();
    assert.equal(probes, 0);
  });
});
