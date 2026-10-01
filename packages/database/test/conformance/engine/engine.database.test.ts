/**
 * Engine conformance on the run's driver: SQLite in the default suite, and
 * MariaDB and PostgreSQL in the database suite's legs. Every statement shape
 * the engine compiles round-trips; generated keys, matched-row counts,
 * savepoints, read-only transactions, value normalisation and error
 * classification behave the same on all three; 50 interleaved transfers
 * conserve their total; an autocommit read is not blocked by an open write
 * transaction; the acquire and statement timeouts fire; close fails closed.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  createEngine,
  createQueryLedger,
  isDatabaseError,
  withQueryLedger,
  type Engine,
  type Row,
  type SqlValue,
  type Statement,
} from '../../../src/engine/index.js';
import { forEachDriver } from '../../../src/testing/index.js';
import { exec, matrixEngineConfig, openMatrixEngine, serialKey } from './fixtures/matrix-engine.js';

async function run(engine: Engine, statement: Statement) {
  const { sql, params } = engine.compile(statement);
  const conn = await engine.lease();
  try {
    return await conn.query(sql, params);
  } finally {
    await conn.release();
  }
}

async function rawRows(
  engine: Engine,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<readonly Row[]> {
  const conn = await engine.lease();
  try {
    return (await conn.query(sql, params)).rows;
  } finally {
    await conn.release();
  }
}

function plain(rows: readonly Row[]): Record<string, SqlValue>[] {
  return rows.map((row) => ({ ...row }));
}

function types(engine: Engine) {
  switch (engine.dialect) {
    case 'postgres':
      return {
        text: 'VARCHAR(50)',
        big: 'BIGINT',
        time: 'TIMESTAMP(3)',
        blob: 'BYTEA',
        bool: 'BOOLEAN',
      };
    case 'mariadb':
      return {
        text: 'VARCHAR(50)',
        big: 'BIGINT',
        time: 'DATETIME(3)',
        blob: 'VARBINARY(32)',
        bool: 'BOOLEAN',
      };
    case 'sqlite':
      return { text: 'TEXT', big: 'INTEGER', time: 'TEXT', blob: 'BLOB', bool: 'INTEGER' };
  }
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isDatabaseError(error), `expected a DatabaseError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

void forEachDriver('engine conformance', ({ driver }) => {
  let engine: Engine;
  // Registered while the suite is declared: node:test's after() called from
  // inside a running before() hook would not attach to this suite.
  const cleanup: (() => unknown)[] = [];
  after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });

  before(async () => {
    engine = await openMatrixEngine({ after: (callback) => cleanup.push(callback) });
    const t = types(engine);
    await exec(
      engine,
      `CREATE TABLE items (${serialKey(engine)}, name ${t.text} NOT NULL, kind ${t.text}, rank INTEGER NOT NULL DEFAULT 0, CONSTRAINT items_name_unique UNIQUE (name))`,
      `CREATE TABLE tags (${serialKey(engine)}, item_id INTEGER NOT NULL, label ${t.text} NOT NULL, CONSTRAINT tags_item_fk FOREIGN KEY (item_id) REFERENCES items (id))`,
      `CREATE TABLE checked (${serialKey(engine)}, amount INTEGER NOT NULL, CONSTRAINT checked_positive CHECK (amount > 0))`,
      `CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL)`,
      `CREATE TABLE samples (${serialKey(engine)}, big ${t.big}, price DECIMAL(10,2), at ${t.time}, bytes ${t.blob}, flag ${t.bool})`,
    );
  });

  async function reset(): Promise<void> {
    await exec(
      engine,
      'DELETE FROM tags',
      'DELETE FROM items',
      'DELETE FROM checked',
      'DELETE FROM accounts',
      'DELETE FROM samples',
    );
  }

  async function seedItems(): Promise<number[]> {
    await reset();
    const { rows } = await run(engine, {
      kind: 'insert',
      table: 'items',
      columns: ['name', 'kind', 'rank'],
      rows: [
        ['alpha', 'a', 1],
        ['beta', 'a', 2],
        ['gamma', 'b', 3],
        ['delta', null, 4],
        ['epsilon', 'b', 5],
      ],
      returning: ['id'],
    });
    return rows.map((row) => Number(row.id));
  }

  it('reports its dialect, server version and bind limit', () => {
    assert.equal(engine.dialect, driver);
    assert.match(engine.serverVersion, /^\d+\.\d+/);
    assert.ok(engine.bindLimit >= 32766);
  });

  describe('statement shapes', () => {
    it('insert returns every generated key through RETURNING, in order', async () => {
      const ids = await seedItems();
      assert.equal(ids.length, 5);
      assert.deepEqual(
        [...ids].sort((a, b) => a - b),
        ids,
      );
      assert.equal(new Set(ids).size, 5);
    });

    it('an insert without RETURNING reports affected rows, and insertId where the driver has one', async () => {
      await reset();
      const result = await run(engine, {
        kind: 'insert',
        table: 'items',
        columns: ['name'],
        rows: [['solo']],
      });
      assert.equal(result.affected, 1);
      assert.deepEqual(result.rows, []);
      if (driver === 'postgres') assert.equal(result.insertId, undefined);
      else assert.equal(typeof result.insertId, 'number');
    });

    it('select filters, orders, limits and offsets', async () => {
      await seedItems();
      const { rows, affected } = await run(engine, {
        kind: 'select',
        from: { table: 'items', alias: 'i' },
        columns: [{ column: { table: 'i', column: 'name' } }, { column: 'rank', as: 'position' }],
        where: { op: 'compare', column: 'rank', comparison: '>=', value: 2 },
        orderBy: [{ column: 'rank', direction: 'desc' }],
        limit: 2,
        offset: 1,
      });
      assert.equal(affected, 0);
      assert.deepEqual(plain(rows), [
        { name: 'delta', position: 4 },
        { name: 'gamma', position: 3 },
      ]);
    });

    it('an offset without a limit skips rows on every dialect', async () => {
      await seedItems();
      const { rows } = await run(engine, {
        kind: 'select',
        from: { table: 'items' },
        columns: [{ column: 'name' }],
        orderBy: [{ column: 'rank' }],
        offset: 3,
      });
      assert.deepEqual(
        rows.map((row) => row.name),
        ['delta', 'epsilon'],
      );
    });

    it('update counts the rows it matched, even when no value changes', async () => {
      await seedItems();
      const result = await run(engine, {
        kind: 'update',
        table: 'items',
        set: [{ column: 'kind', value: 'a' }],
        where: { op: 'compare', column: 'kind', comparison: '=', value: 'a' },
      });
      assert.equal(result.affected, 2);
    });

    it('update increments in place', async () => {
      await seedItems();
      await run(engine, {
        kind: 'update',
        table: 'items',
        set: [{ column: 'rank', add: 10 }],
        where: { op: 'in', column: 'name', values: ['alpha', 'beta'] },
      });
      const { rows } = await run(engine, {
        kind: 'select',
        from: { table: 'items' },
        columns: [{ column: 'rank' }],
        where: { op: 'compare', column: 'name', comparison: '=', value: 'beta' },
      });
      assert.equal(rows[0]?.rank, 12);
    });

    it('update ... RETURNING runs where the dialect has it, and is refused on MariaDB', async () => {
      await seedItems();
      const statement: Statement = {
        kind: 'update',
        table: 'items',
        set: [{ column: 'rank', value: 0 }],
        where: { op: 'compare', column: 'name', comparison: '=', value: 'alpha' },
        returning: ['name'],
      };
      if (driver === 'mariadb') {
        assert.throws(() => engine.compile(statement), { code: 'unsupported_statement' });
        return;
      }
      const result = await run(engine, statement);
      assert.deepEqual(plain(result.rows), [{ name: 'alpha' }]);
      assert.equal(result.affected, 1);
    });

    it('delete removes the matched rows and returns them', async () => {
      await seedItems();
      const result = await run(engine, {
        kind: 'delete',
        table: 'items',
        where: { op: 'compare', column: 'kind', comparison: '=', value: 'b' },
        returning: ['name'],
      });
      assert.equal(result.affected, 2);
      assert.deepEqual(result.rows.map((row) => row.name).sort(), ['epsilon', 'gamma']);
    });

    it('upsert does nothing, or updates, on a unique conflict', async () => {
      await seedItems();
      const nothing = await run(engine, {
        kind: 'insert',
        table: 'items',
        columns: ['name', 'rank'],
        rows: [['alpha', 99]],
        onConflict: { target: ['name'], action: 'nothing' },
      });
      assert.equal(nothing.rows.length, 0);
      // MariaDB counts a row left as it was (its ON DUPLICATE KEY UPDATE).
      assert.equal(nothing.affected, driver === 'mariadb' ? 1 : 0);
      if (driver === 'mariadb') {
        assert.throws(
          () =>
            engine.compile({
              kind: 'insert',
              table: 'items',
              columns: ['name'],
              rows: [['alpha']],
              onConflict: { target: ['name'], action: 'nothing' },
              returning: ['id'],
            }),
          { code: 'unsupported_statement' },
        );
      } else {
        const fresh = await run(engine, {
          kind: 'insert',
          table: 'items',
          columns: ['name'],
          rows: [['alpha'], ['omega']],
          onConflict: { target: ['name'], action: 'nothing' },
          returning: ['name'],
        });
        assert.deepEqual(
          fresh.rows.map((row) => row.name),
          ['omega'],
        );
      }
      const updated = await run(engine, {
        kind: 'insert',
        table: 'items',
        columns: ['name', 'rank'],
        rows: [
          ['alpha', 42],
          ['zeta', 7],
        ],
        onConflict: { target: ['name'], action: 'update', update: ['rank'] },
        returning: ['name', 'rank'],
      });
      assert.deepEqual(
        plain(updated.rows).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        [
          { name: 'alpha', rank: 42 },
          { name: 'zeta', rank: 7 },
        ],
      );
    });

    it('a keyset page continues after the last row by row-value comparison', async () => {
      await seedItems();
      const { rows } = await run(engine, {
        kind: 'select',
        from: { table: 'items' },
        columns: [{ column: 'name' }],
        where: {
          op: 'row-compare',
          columns: ['rank', 'name'],
          comparison: '>',
          values: [2, 'beta'],
        },
        orderBy: [{ column: 'rank' }, { column: 'name' }],
        limit: 2,
      });
      assert.deepEqual(
        rows.map((row) => row.name),
        ['gamma', 'delta'],
      );
    });

    it('a window limit keeps the first rows of each partition', async () => {
      await seedItems();
      const { rows } = await run(engine, {
        kind: 'select',
        from: { table: 'items' },
        columns: [{ column: 'kind' }, { column: 'name' }],
        where: { op: 'null', column: 'kind', negate: true },
        orderBy: [{ column: 'rank', direction: 'desc' }],
        windowLimit: { partitionBy: ['kind'], limit: 1 },
      });
      assert.deepEqual(plain(rows), [
        { kind: 'a', name: 'beta' },
        { kind: 'b', name: 'epsilon' },
      ]);
    });

    it('EXISTS and IN subqueries filter on related rows', async () => {
      const [alpha, , gamma] = await seedItems();
      await run(engine, {
        kind: 'insert',
        table: 'tags',
        columns: ['item_id', 'label'],
        rows: [
          [alpha as number, 'red'],
          [gamma as number, 'blue'],
        ],
      });
      const exists = await run(engine, {
        kind: 'select',
        from: { table: 'items', alias: 'i' },
        columns: [{ column: 'name' }],
        where: {
          op: 'exists',
          select: {
            kind: 'select',
            from: { table: 'tags', alias: 't' },
            columns: [{ column: 'id' }],
            where: {
              op: 'and',
              items: [
                {
                  op: 'compare-columns',
                  left: { table: 't', column: 'item_id' },
                  comparison: '=',
                  right: { table: 'i', column: 'id' },
                },
                {
                  op: 'compare',
                  column: { table: 't', column: 'label' },
                  comparison: '=',
                  value: 'blue',
                },
              ],
            },
          },
        },
      });
      assert.deepEqual(
        exists.rows.map((row) => row.name),
        ['gamma'],
      );
      const inSelect = await run(engine, {
        kind: 'select',
        from: { table: 'items' },
        columns: [{ column: 'name' }],
        where: {
          op: 'in-select',
          columns: ['id'],
          negate: true,
          select: { kind: 'select', from: { table: 'tags' }, columns: [{ column: 'item_id' }] },
        },
        orderBy: [{ column: 'rank' }],
      });
      assert.deepEqual(
        inSelect.rows.map((row) => row.name),
        ['beta', 'delta', 'epsilon'],
      );
    });

    it('an empty IN list matches nothing, and its negation everything', async () => {
      await seedItems();
      const none = await run(engine, {
        kind: 'select',
        from: { table: 'items' },
        columns: [{ aggregate: 'count', as: 'n' }],
        where: { op: 'in', column: 'id', values: [] },
      });
      const all = await run(engine, {
        kind: 'select',
        from: { table: 'items' },
        columns: [{ aggregate: 'count', as: 'n' }],
        where: { op: 'in', column: 'id', values: [], negate: true },
      });
      assert.equal(none.rows[0]?.n, 0);
      assert.equal(all.rows[0]?.n, 5);
    });

    it('LIKE treats the backslash as its escape character on every dialect', async () => {
      await reset();
      await run(engine, {
        kind: 'insert',
        table: 'items',
        columns: ['name'],
        rows: [['50%_off'], ['50 percent']],
      });
      const { rows } = await run(engine, {
        kind: 'select',
        from: { table: 'items' },
        columns: [{ column: 'name' }],
        where: { op: 'like', column: 'name', pattern: '50\\%\\_%' },
      });
      assert.deepEqual(
        rows.map((row) => row.name),
        ['50%_off'],
      );
    });

    it('nulls sort first or last as asked, on every dialect', async () => {
      await seedItems();
      const order = async (nulls: 'first' | 'last') =>
        (
          await run(engine, {
            kind: 'select',
            from: { table: 'items' },
            columns: [{ column: 'name' }],
            orderBy: [{ column: 'kind', nulls }, { column: 'rank' }],
          })
        ).rows.map((row) => row.name);
      assert.deepEqual(await order('first'), ['delta', 'alpha', 'beta', 'gamma', 'epsilon']);
      assert.deepEqual(await order('last'), ['alpha', 'beta', 'gamma', 'epsilon', 'delta']);
    });

    it('aggregates group and count as plain numbers', async () => {
      await seedItems();
      const { rows } = await run(engine, {
        kind: 'select',
        from: { table: 'items' },
        columns: [
          { column: 'kind' },
          { aggregate: 'count', as: 'n' },
          { aggregate: 'max', column: 'rank', as: 'top' },
        ],
        where: { op: 'null', column: 'kind', negate: true },
        groupBy: ['kind'],
        orderBy: [{ column: 'kind' }],
      });
      assert.deepEqual(plain(rows), [
        { kind: 'a', n: 2, top: 2 },
        { kind: 'b', n: 2, top: 5 },
      ]);
    });

    it('a locking select runs inside a write transaction', async () => {
      await seedItems();
      const tx = await engine.begin();
      try {
        for (const wait of ['wait', 'nowait', 'skip-locked'] as const) {
          for (const mode of ['update', 'share'] as const) {
            const { sql, params } = engine.compile({
              kind: 'select',
              from: { table: 'items' },
              columns: [{ column: 'id' }],
              where: { op: 'compare', column: 'name', comparison: '=', value: 'alpha' },
              lock: { mode, wait },
            });
            assert.equal((await tx.query(sql, params)).rows.length, 1);
          }
        }
        await tx.commit();
      } finally {
        await tx.release();
      }
    });
  });

  describe('values', () => {
    it('round-trip without loss and come back normalised', async () => {
      await reset();
      const big = 9_007_199_254_740_993n;
      const bytes = new Uint8Array([0, 1, 254, 255]);
      await run(engine, {
        kind: 'insert',
        table: 'samples',
        columns: ['big', 'price', 'at', 'bytes', 'flag'],
        rows: [[big, '12.50', '2026-03-04 05:06:07.089', bytes, true]],
      });
      const [row] = await rawRows(engine, 'SELECT big, price, at, bytes, flag FROM samples');
      assert.ok(row !== undefined);
      assert.equal(row.big, big);
      assert.equal(String(row.price), driver === 'sqlite' ? '12.5' : '12.50');
      assert.equal(typeof row.at, 'string');
      assert.match(String(row.at), /^2026-03-04[ T]05:06:07\.089/);
      assert.ok(row.bytes instanceof Uint8Array);
      assert.deepEqual([...row.bytes], [...bytes]);
      assert.equal(Number(row.flag), 1);
    });

    it('a bound string is data whatever the session quoting mode', async () => {
      await reset();
      const hostile = "x\\' OR 1=1 -- \\";
      const tx = await engine.begin();
      try {
        // The mode in which a backslash stops being an escape character.
        if (driver === 'mariadb') {
          await tx.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')");
        }
        const insert = engine.compile({
          kind: 'insert',
          table: 'items',
          columns: ['name'],
          rows: [['plain'], [hostile]],
        });
        await tx.query(insert.sql, insert.params);
        const select = engine.compile({
          kind: 'select',
          from: { table: 'items' },
          columns: [{ column: 'name' }],
          where: { op: 'compare', column: 'name', comparison: '=', value: hostile },
        });
        const { rows } = await tx.query(select.sql, select.params);
        assert.deepEqual(
          rows.map((row) => row.name),
          [hostile],
        );
        if (driver === 'mariadb') {
          await tx.query("SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')");
        }
        await tx.commit();
      } finally {
        await tx.release();
      }
    });

    it('a 64-bit integer survives arithmetic with a bound integer', async () => {
      await reset();
      const big = 9_007_199_254_740_993n;
      await run(engine, { kind: 'insert', table: 'samples', columns: ['big'], rows: [[big]] });
      await run(engine, {
        kind: 'update',
        table: 'samples',
        set: [{ column: 'big', add: 0 }],
        where: { op: 'true' },
      });
      const [row] = await rawRows(engine, 'SELECT big FROM samples');
      assert.equal(row?.big, big);
    });

    it('safe integers come back as numbers, counts included', async () => {
      await seedItems();
      const [row] = await rawRows(engine, 'SELECT COUNT(*) AS n, SUM(rank) AS total FROM items');
      assert.equal(row?.n, 5);
      assert.equal(Number(row?.total), 15);
    });

    it('rejects a parameter the engine does not bind, before the driver sees it', async () => {
      const conn = await engine.lease();
      try {
        for (const bad of [undefined, Number.NaN, Infinity, new Date(0), {}, [1]]) {
          await rejectsWith(
            conn.query('SELECT 1', [bad as unknown as SqlValue]),
            'invalid_parameter',
          );
        }
      } finally {
        await conn.release();
      }
    });
  });

  describe('transactions', () => {
    it('commit keeps the writes and rollback discards them', async () => {
      await reset();
      const kept = await engine.begin();
      await kept.query('INSERT INTO checked (amount) VALUES (1)');
      await kept.commit();
      const dropped = await engine.begin();
      await dropped.query('INSERT INTO checked (amount) VALUES (2)');
      await dropped.rollback();
      const rows = await rawRows(engine, 'SELECT amount FROM checked');
      assert.deepEqual(
        rows.map((row) => row.amount),
        [1],
      );
    });

    it('releasing an open transaction rolls it back', async () => {
      await reset();
      const tx = await engine.begin();
      await tx.query('INSERT INTO checked (amount) VALUES (3)');
      await tx.release();
      await tx.release();
      assert.equal((await rawRows(engine, 'SELECT amount FROM checked')).length, 0);
      await rejectsWith(tx.query('SELECT 1'), 'released');
      await rejectsWith(tx.commit(), 'released');
    });

    it('a savepoint rolls back only what followed it, and savepoints nest', async () => {
      await reset();
      const tx = await engine.begin();
      try {
        await tx.query('INSERT INTO checked (amount) VALUES (1)');
        const outer = await tx.savepoint();
        await tx.query('INSERT INTO checked (amount) VALUES (2)');
        const inner = await tx.savepoint();
        await tx.query('INSERT INTO checked (amount) VALUES (3)');
        await inner.rollback();
        await tx.query('INSERT INTO checked (amount) VALUES (4)');
        await outer.release();
        await rejectsWith(inner.release(), 'invalid_state');
        const again = await tx.savepoint();
        await tx.query('INSERT INTO checked (amount) VALUES (5)');
        await again.rollback();
        await tx.commit();
      } finally {
        await tx.release();
      }
      const rows = await rawRows(engine, 'SELECT amount FROM checked ORDER BY amount');
      assert.deepEqual(
        rows.map((row) => row.amount),
        [1, 2, 4],
      );
    });

    it('a savepoint recovers from a failed statement', async () => {
      await reset();
      const tx = await engine.begin();
      try {
        await tx.query('INSERT INTO checked (amount) VALUES (1)');
        const attempt = await tx.savepoint();
        await rejectsWith(tx.query('INSERT INTO checked (amount) VALUES (0)'), 'check_violation');
        await attempt.rollback();
        await tx.query('INSERT INTO checked (amount) VALUES (2)');
        await tx.commit();
      } finally {
        await tx.release();
      }
      const rows = await rawRows(engine, 'SELECT amount FROM checked ORDER BY amount');
      assert.deepEqual(
        rows.map((row) => row.amount),
        [1, 2],
      );
    });

    it('a transaction the server ended runs nothing more, and its commit is refused', async () => {
      await reset();
      if (driver === 'sqlite') {
        await exec(
          engine,
          "CREATE TRIGGER IF NOT EXISTS checked_abort BEFORE INSERT ON checked WHEN NEW.amount = 13 BEGIN SELECT RAISE(ROLLBACK, 'abort'); END",
        );
      }
      await exec(engine, 'INSERT INTO accounts (id, balance) VALUES (1, 1), (2, 2)');
      const victim = await engine.begin();
      try {
        await victim.query('UPDATE accounts SET balance = 11 WHERE id = 1');
        if (driver === 'sqlite') {
          // RAISE(ROLLBACK) ends the whole transaction, not just the statement.
          await rejectsWith(
            victim.query('INSERT INTO checked (amount) VALUES (13)'),
            'query_failed',
          );
        } else {
          // Each transaction waits for the other's row. The other one has
          // written more, so InnoDB picks the victim; PostgreSQL aborts the
          // waiter whose deadlock check runs first, which is also the victim.
          const other = await engine.begin();
          try {
            for (let id = 100; id < 110; id += 1) {
              await other.query(`INSERT INTO accounts (id, balance) VALUES (${id}, 0)`);
            }
            await other.query('UPDATE accounts SET balance = 20 WHERE id = 2');
            const blocked = victim.query('UPDATE accounts SET balance = 21 WHERE id = 2');
            await new Promise((resolve) => setTimeout(resolve, 200));
            const crossing = other.query('UPDATE accounts SET balance = 10 WHERE id = 1');
            const [lost, won] = await Promise.allSettled([blocked, crossing]);
            assert.equal(won?.status, 'fulfilled');
            assert.ok(lost?.status === 'rejected');
            const reason: unknown = lost.reason;
            assert.ok(isDatabaseError(reason, 'deadlock'), String(reason));
            assert.ok(reason.transient);
            await other.commit();
          } finally {
            await other.release();
          }
        }
        // Nothing runs in autocommit in the lost transaction's place.
        await rejectsWith(
          victim.query('INSERT INTO checked (amount) VALUES (7)'),
          'transaction_aborted',
        );
        await rejectsWith(victim.savepoint(), 'transaction_aborted');
        await rejectsWith(victim.commit(), 'transaction_aborted');
      } finally {
        await victim.release();
      }
      assert.equal((await rawRows(engine, 'SELECT amount FROM checked')).length, 0);
      // The victim's update is gone; on a server the other transaction's stands.
      const [first] = await rawRows(engine, 'SELECT balance FROM accounts WHERE id = 1');
      assert.equal(first?.balance, driver === 'sqlite' ? 1 : 10);
    });

    it('a commit the server turns into a rollback is reported, never as committed', async (t) => {
      if (driver !== 'postgres') {
        t.skip('only PostgreSQL aborts a transaction on a failed statement');
        return;
      }
      await reset();
      const tx = await engine.begin();
      await tx.query('INSERT INTO checked (amount) VALUES (1)');
      await rejectsWith(tx.query('INSERT INTO checked (amount) VALUES (0)'), 'check_violation');
      await rejectsWith(tx.query('SELECT 1'), 'transaction_aborted');
      await rejectsWith(tx.commit(), 'transaction_aborted');
      assert.equal((await rawRows(engine, 'SELECT amount FROM checked')).length, 0);
    });

    it('a read-only transaction refuses writes', async () => {
      await seedItems();
      const tx = await engine.begin({ readOnly: true });
      try {
        assert.equal((await tx.query('SELECT name FROM items')).rows.length, 5);
        await rejectsWith(tx.query('INSERT INTO checked (amount) VALUES (1)'), 'read_only');
      } finally {
        await tx.release();
      }
    });

    it('accepts every isolation level', async () => {
      for (const isolation of ['read committed', 'repeatable read', 'serializable'] as const) {
        const tx = await engine.begin({ isolation });
        await tx.query('SELECT 1 AS one');
        await tx.commit();
      }
    });

    it('fifty interleaved transfers conserve the total', async () => {
      await reset();
      const accounts = 10;
      await run(engine, {
        kind: 'insert',
        table: 'accounts',
        columns: ['id', 'balance'],
        rows: Array.from({ length: accounts }, (_, index) => [index + 1, 100]),
      });
      const transfer = async (index: number): Promise<void> => {
        const from = (index % accounts) + 1;
        const to = ((index * 7 + 3) % accounts) + 1;
        if (from === to) return;
        // Lock in key order so the server dialects cannot deadlock.
        const [first, second] = from < to ? [from, to] : [to, from];
        for (let attempt = 0; ; attempt += 1) {
          const tx = await engine.begin();
          try {
            for (const id of [first, second]) {
              const { sql, params } = engine.compile({
                kind: 'select',
                from: { table: 'accounts' },
                columns: [{ column: 'balance' }],
                where: { op: 'compare', column: 'id', comparison: '=', value: id },
                lock: { mode: 'update' },
              });
              await tx.query(sql, params);
            }
            await new Promise((resolve) => setImmediate(resolve));
            for (const [id, add] of [
              [from, -5],
              [to, 5],
            ] as const) {
              const { sql, params } = engine.compile({
                kind: 'update',
                table: 'accounts',
                set: [{ column: 'balance', add }],
                where: { op: 'compare', column: 'id', comparison: '=', value: id },
              });
              await tx.query(sql, params);
              await new Promise((resolve) => setImmediate(resolve));
            }
            await tx.commit();
            return;
          } catch (error) {
            await tx.release();
            if (!(isDatabaseError(error) && error.transient) || attempt >= 5) throw error;
          }
        }
      };
      await Promise.all(Array.from({ length: 50 }, (_, index) => transfer(index)));
      const [row] = await rawRows(
        engine,
        'SELECT SUM(balance) AS total, COUNT(*) AS n FROM accounts',
      );
      assert.equal(Number(row?.total), accounts * 100);
      assert.equal(row?.n, accounts);
    });

    it('an autocommit read is not blocked by an open write transaction', async () => {
      await reset();
      await exec(engine, 'INSERT INTO checked (amount) VALUES (1)');
      const tx = await engine.begin();
      try {
        await tx.query('INSERT INTO checked (amount) VALUES (2)');
        const read = rawRows(engine, 'SELECT amount FROM checked');
        const outcome = await Promise.race([
          read.then((rows) => rows.map((row) => row.amount)),
          new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 2000).unref()),
        ]);
        assert.deepEqual(outcome, [1]);
        await tx.commit();
      } finally {
        await tx.release();
      }
    });
  });

  describe('errors', () => {
    it('classifies constraint violations from the real driver error', async () => {
      const [alpha] = await seedItems();
      await rejectsWith(
        run(engine, { kind: 'insert', table: 'items', columns: ['name'], rows: [['alpha']] }),
        'unique_violation',
      );
      await assert.rejects(
        run(engine, { kind: 'insert', table: 'items', columns: ['name'], rows: [['alpha']] }),
        (error: unknown) => {
          assert.ok(isDatabaseError(error));
          assert.ok(error.driverCode !== undefined);
          // The duplicate value never appears; the constraint's name may.
          assert.doesNotMatch(error.message, /alpha/);
          assert.doesNotMatch(JSON.stringify(error.context), /alpha/);
          if (driver === 'postgres') assert.equal(error.constraint, 'items_name_unique');
          if (driver === 'mariadb') assert.equal(error.constraint, 'items_name_unique');
          if (driver === 'sqlite') assert.equal(error.constraint, 'items.name');
          return true;
        },
      );
      await rejectsWith(
        run(engine, {
          kind: 'insert',
          table: 'tags',
          columns: ['item_id', 'label'],
          rows: [[999_999, 'x']],
        }),
        'foreign_key_violation',
      );
      await rejectsWith(
        run(engine, { kind: 'insert', table: 'items', columns: ['name'], rows: [[null]] }),
        'not_null_violation',
      );
      await rejectsWith(
        run(engine, { kind: 'insert', table: 'checked', columns: ['amount'], rows: [[0]] }),
        'check_violation',
      );
      assert.ok(alpha !== undefined);
    });

    it('reports other statement failures as query_failed with the driver code', async () => {
      const conn = await engine.lease();
      try {
        await assert.rejects(conn.query('SELEC 1'), (error: unknown) => {
          assert.ok(isDatabaseError(error, 'query_failed'));
          assert.ok(error.driverCode !== undefined);
          assert.doesNotMatch(error.message, /SELEC/);
          return true;
        });
        await rejectsWith(conn.query('SELECT * FROM no_such_table'), 'query_failed');
      } finally {
        await conn.release();
      }
      await rejectsWith(conn.query('SELECT 1'), 'released');
    });
  });

  describe('query ledger', () => {
    it('records every statement, with no parameter values, in each active ledger', async () => {
      await seedItems();
      const outer = createQueryLedger({ detail: true });
      const inner = createQueryLedger();
      await withQueryLedger(outer, async () => {
        await run(engine, {
          kind: 'select',
          from: { table: 'items' },
          columns: '*',
          where: { op: 'compare', column: 'name', comparison: '=', value: 'secret-value' },
        });
        await withQueryLedger(inner, async () => {
          const tx = await engine.begin();
          await tx.query('SELECT 1 AS one', [], { origin: 'unguarded' });
          await tx.commit();
        });
      });
      assert.equal(inner.count, 2);
      assert.equal(inner.records.length, 0);
      assert.ok(outer.count >= 3);
      assert.ok(outer.totalMs >= 0);
      const origins = outer.records.map((record) => record.origin);
      assert.ok(origins.includes('app'));
      assert.ok(origins.includes('unguarded'));
      assert.ok(origins.includes('engine'));
      for (const record of outer.records) assert.doesNotMatch(record.sql, /secret-value/);
    });
  });

  describe('timeouts and close', () => {
    it('a lease waiting past the acquire timeout fails with acquire_timeout', async (t) => {
      const busy = await openMatrixEngine(t, { pool: { max: 1 }, acquireTimeoutMs: 150 });
      const held = await busy.begin();
      try {
        await rejectsWith(busy.begin(), 'acquire_timeout');
      } finally {
        await held.release();
      }
      const next = await busy.begin();
      await next.commit();
    });

    it('a statement past the statement timeout is cancelled and the connection stays usable', async (t) => {
      if (driver === 'sqlite') {
        t.skip('SQLite statements run synchronously and have no statement timeout');
        return;
      }
      const slow = await openMatrixEngine(t, { statementTimeoutMs: 200, pool: { max: 1 } });
      const conn = await slow.lease();
      try {
        const sleep = driver === 'postgres' ? 'SELECT pg_sleep(2)' : 'SELECT SLEEP(2)';
        const started = Date.now();
        await rejectsWith(conn.query(sleep), 'statement_timeout');
        assert.ok(Date.now() - started < 1500);
        assert.equal((await conn.query('SELECT 1 AS one')).rows[0]?.one, 1);
      } finally {
        await conn.release();
      }
    });

    it('discards a connection the server dropped, and the pool recovers', async (t) => {
      if (driver === 'sqlite') {
        t.skip('SQLite has no server to drop a connection');
        return;
      }
      const pooled = await openMatrixEngine(t, { pool: { max: 1 } });
      const pidSql =
        driver === 'postgres' ? 'SELECT pg_backend_pid() AS pid' : 'SELECT CONNECTION_ID() AS pid';
      const victim = await pooled.lease();
      const pid = Number((await victim.query(pidSql)).rows[0]?.pid);
      const killer = await openMatrixEngine(t);
      const kill = await killer.lease();
      await kill.query(
        driver === 'postgres' ? 'SELECT pg_terminate_backend($1)' : `KILL CONNECTION ${pid}`,
        driver === 'postgres' ? [pid] : [],
      );
      await kill.release();
      await assert.rejects(victim.query('SELECT 1 AS one'), (error: unknown) =>
        isDatabaseError(error),
      );
      await victim.release();
      const fresh = await pooled.lease();
      try {
        const next = Number((await fresh.query(pidSql)).rows[0]?.pid);
        assert.notEqual(next, pid);
      } finally {
        await fresh.release();
      }
    });

    it('reports an idle pooled connection the server dropped, without crashing', async (t) => {
      if (driver === 'sqlite') {
        t.skip('SQLite has no pool');
        return;
      }
      const reported: string[] = [];
      const pooled = await openMatrixEngine(
        t,
        { pool: { max: 1 } },
        { onConnectionError: (error) => reported.push(error.code) },
      );
      const pidSql =
        driver === 'postgres' ? 'SELECT pg_backend_pid() AS pid' : 'SELECT CONNECTION_ID() AS pid';
      const idle = await pooled.lease();
      const pid = Number((await idle.query(pidSql)).rows[0]?.pid);
      await idle.release();
      const killer = await openMatrixEngine(t);
      const kill = await killer.lease();
      await kill.query(
        driver === 'postgres' ? 'SELECT pg_terminate_backend($1)' : `KILL CONNECTION ${pid}`,
        driver === 'postgres' ? [pid] : [],
      );
      await kill.release();
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (driver === 'postgres') assert.deepEqual(reported, ['connection_failed']);
      // The pool replaces the dropped connection on the next lease.
      for (let attempt = 0; ; attempt += 1) {
        const next = await pooled.lease();
        try {
          assert.notEqual(Number((await next.query(pidSql)).rows[0]?.pid), pid);
          break;
        } catch (error) {
          // mysql2 notices a dropped idle connection only when it is next used.
          if (attempt > 0 || !isDatabaseError(error)) throw error;
        } finally {
          await next.release();
        }
      }
    });

    it('close rejects waiters, fails leased connections closed, and rolls back open transactions', async (t) => {
      const config = await matrixEngineConfig(t, { pool: { max: 1 }, acquireTimeoutMs: 0 });
      const first = await createEngine(config);
      await exec(first, 'CREATE TABLE closing (n INTEGER NOT NULL)');
      const tx = await first.begin();
      await tx.query('INSERT INTO closing (n) VALUES (1)');
      const waiting = first.begin();
      await first.close();
      await rejectsWith(waiting, 'closed');
      await rejectsWith(tx.query('SELECT 1'), 'closed');
      await rejectsWith(first.lease(), 'closed');
      const second = await createEngine(config);
      try {
        assert.equal((await rawRows(second, 'SELECT n FROM closing')).length, 0);
      } finally {
        await second.close();
      }
    });

    it('a migration engine opens one connection with no statement timeout', async (t) => {
      const config = await matrixEngineConfig(t, { statementTimeoutMs: 100 });
      const migration = await createEngine(config, { purpose: 'migration' });
      try {
        await exec(migration, 'CREATE TABLE migrated (n INTEGER)');
        if (driver !== 'sqlite') {
          const sleep = driver === 'postgres' ? 'SELECT pg_sleep(0.3)' : 'SELECT SLEEP(0.3)';
          await rawRows(migration, sleep);
        }
      } finally {
        await migration.close();
      }
    });
  });
});
