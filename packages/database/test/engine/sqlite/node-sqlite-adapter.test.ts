/**
 * The node:sqlite adapter: the better-sqlite3 surface TypeORM uses, binding
 * that keeps integers integral, lossless 64-bit reads, and the affected count
 * and insert id only where they belong to the statement.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NodeSqliteDatabase } from '../../../src/engine/sqlite/node-sqlite-adapter.js';

function memory(): NodeSqliteDatabase {
  const db = new NodeSqliteDatabase(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v ANY, n INTEGER)');
  return db;
}

describe('NodeSqliteDatabase', () => {
  it('binds integral numbers as INTEGER, fractions as REAL and booleans as 0/1', () => {
    const db = memory();
    const { rows } = db.execute(
      'SELECT typeof(?) AS a, typeof(?) AS b, ? AS c, ? AS d, 7 / ? AS e',
      [1, 1.5, true, false, 2],
    );
    assert.deepEqual({ ...rows[0] }, { a: 'integer', b: 'real', c: 1, d: 0, e: 3 });
    db.close();
  });

  it('reads 64-bit integers without rounding and safe ones as numbers', () => {
    const db = memory();
    const { rows } = db.execute(
      "SELECT 9007199254740993 AS big, -9007199254740993 AS small, 5 AS five, 1.5 AS real, NULL AS empty, x'00ff' AS bytes",
      [],
    );
    const row = rows[0];
    assert.equal(row?.big, 9007199254740993n);
    assert.equal(row?.small, -9007199254740993n);
    assert.equal(row?.five, 5);
    assert.equal(row?.real, 1.5);
    assert.equal(row?.empty, null);
    assert.deepEqual([...(row?.bytes as Uint8Array)], [0, 255]);
    db.close();
  });

  it('counts a write and its insert id, but not a stale count after DDL', () => {
    const db = memory();
    const inserted = db.execute('INSERT INTO t (v) VALUES (?), (?)', ['a', 'b']);
    assert.deepEqual(inserted, { rows: [], affected: 2, insertId: 2 });
    assert.deepEqual(db.execute('UPDATE t SET v = v', []), { rows: [], affected: 2 });
    assert.deepEqual(db.execute('CREATE TABLE u (x)', []), { rows: [], affected: 0 });
    assert.deepEqual(db.execute('DELETE FROM t WHERE id = ?', [99]), { rows: [], affected: 0 });
    const returned = db.execute('DELETE FROM t RETURNING id', []);
    assert.equal(returned.affected, 2);
    assert.equal(returned.rows.length, 2);
    db.close();
  });

  it('exposes the better-sqlite3 statement surface with a derived reader flag', () => {
    const db = memory();
    assert.equal(db.prepare('SELECT 1').reader, true);
    assert.equal(db.prepare('INSERT INTO t (v) VALUES (?) RETURNING id').reader, true);
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    assert.equal(insert.reader, false);
    assert.equal(Number(insert.run(true).changes), 1);
    assert.deepEqual(
      db
        .prepare('SELECT v FROM t')
        .all()
        .map((row) => ({ ...(row as object) })),
      [{ v: 1 }],
    );
    db.close();
  });

  it('implements pragma reads and writes', () => {
    const db = memory();
    assert.deepEqual(
      db.pragma('foreign_keys').map((row) => ({ ...(row as object) })),
      [{ foreign_keys: 1 }],
    );
    assert.deepEqual(db.pragma('foreign_keys = OFF'), []);
    assert.deepEqual(
      db.pragma('foreign_keys').map((row) => ({ ...(row as object) })),
      [{ foreign_keys: 0 }],
    );
    db.close();
  });

  it('keeps working past the statement cache size', () => {
    const db = memory();
    for (let index = 0; index < 250; index += 1) {
      assert.equal(db.execute(`SELECT ${index} AS n`, []).rows[0]?.n, index);
    }
    assert.equal(db.execute('SELECT 0 AS n', []).rows[0]?.n, 0);
    db.close();
    assert.equal(db.open, false);
    db.close();
  });

  it('reports transaction state and opens read-only handles that refuse writes', () => {
    const db = memory();
    assert.equal(db.inTransaction, false);
    db.exec('BEGIN');
    assert.equal(db.inTransaction, true);
    db.exec('ROLLBACK');
    db.close();
    const readOnly = new NodeSqliteDatabase(':memory:', { readonly: true });
    assert.throws(() => readOnly.execute('CREATE TABLE x (a)', []), { errcode: 8 });
    readOnly.close();
  });
});
