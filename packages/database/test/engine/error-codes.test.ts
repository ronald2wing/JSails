/**
 * Driver error classification on error shapes captured from the real drivers
 * (pg against PostgreSQL 17, mysql2 against MariaDB 11.4, node:sqlite 3.54);
 * the conformance suite triggers the same errors live on each leg.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DatabaseError, type DatabaseErrorCode, type Dialect } from '../../src/engine/index.js';
import { classifyDriverError, isSqliteBusy } from '../../src/engine/error-codes.js';

interface Captured {
  readonly dialect: Dialect;
  readonly error: object;
  readonly code: DatabaseErrorCode;
  readonly driverCode?: string;
  readonly constraint?: string;
}

const CAPTURED: readonly Captured[] = [
  // pg
  {
    dialect: 'postgres',
    error: {
      code: '23505',
      constraint: 'spike_v_key',
      message: 'duplicate key value violates unique constraint "spike_v_key"',
    },
    code: 'unique_violation',
    driverCode: '23505',
    constraint: 'spike_v_key',
  },
  {
    dialect: 'postgres',
    error: {
      code: '23503',
      constraint: 'tags_item_fk',
      message: 'insert or update on table "tags" violates foreign key constraint',
    },
    code: 'foreign_key_violation',
    constraint: 'tags_item_fk',
  },
  {
    dialect: 'postgres',
    error: {
      code: '23502',
      message: 'null value in column "n" of relation "spike" violates not-null constraint',
    },
    code: 'not_null_violation',
  },
  {
    dialect: 'postgres',
    error: { code: '23514', constraint: 'checked_positive' },
    code: 'check_violation',
    constraint: 'checked_positive',
  },
  { dialect: 'postgres', error: { code: '40P01' }, code: 'deadlock' },
  { dialect: 'postgres', error: { code: '40001' }, code: 'serialization_failure' },
  { dialect: 'postgres', error: { code: '55P03' }, code: 'lock_timeout' },
  {
    dialect: 'postgres',
    error: { code: '57014', message: 'canceling statement due to statement timeout' },
    code: 'statement_timeout',
  },
  { dialect: 'postgres', error: { code: '25006' }, code: 'read_only' },
  { dialect: 'postgres', error: { code: '25P02' }, code: 'transaction_aborted' },
  { dialect: 'postgres', error: { code: '28P01' }, code: 'connection_failed' },
  { dialect: 'postgres', error: { code: '08006' }, code: 'connection_failed' },
  {
    dialect: 'postgres',
    error: { code: 'ECONNREFUSED' },
    code: 'connection_failed',
    driverCode: 'ECONNREFUSED',
  },
  {
    dialect: 'postgres',
    error: { code: '42601', message: 'syntax error at or near "SELEC"' },
    code: 'query_failed',
    driverCode: '42601',
  },
  // mysql2
  {
    dialect: 'mariadb',
    error: {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      message: "Duplicate entry 'secret@example.com' for key 'users_email_unique'",
    },
    code: 'unique_violation',
    driverCode: '1062',
    constraint: 'users_email_unique',
  },
  {
    dialect: 'mariadb',
    error: {
      errno: 1452,
      message:
        'Cannot add or update a child row: a foreign key constraint fails (`db`.`tags`, CONSTRAINT `tags_item_fk` FOREIGN KEY (`item_id`) REFERENCES `items` (`id`))',
    },
    code: 'foreign_key_violation',
    constraint: 'tags_item_fk',
  },
  {
    dialect: 'mariadb',
    error: { code: 'ER_BAD_NULL_ERROR', errno: 1048, message: "Column 'n' cannot be null" },
    code: 'not_null_violation',
  },
  {
    dialect: 'mariadb',
    error: { errno: 4025, message: 'CONSTRAINT `checked_positive` failed for `db`.`checked`' },
    code: 'check_violation',
    constraint: 'checked_positive',
  },
  { dialect: 'mariadb', error: { errno: 1213 }, code: 'deadlock' },
  { dialect: 'mariadb', error: { errno: 1205 }, code: 'lock_timeout' },
  {
    dialect: 'mariadb',
    error: {
      errno: 1969,
      sqlState: '70100',
      message: 'Query execution was interrupted (max_statement_time exceeded)',
    },
    code: 'statement_timeout',
    driverCode: '1969',
  },
  { dialect: 'mariadb', error: { errno: 1792 }, code: 'read_only' },
  {
    dialect: 'mariadb',
    error: { errno: 1045, code: 'ER_ACCESS_DENIED_ERROR' },
    code: 'connection_failed',
  },
  {
    dialect: 'mariadb',
    error: { code: 'PROTOCOL_CONNECTION_LOST' },
    code: 'connection_failed',
    driverCode: 'PROTOCOL_CONNECTION_LOST',
  },
  {
    dialect: 'mariadb',
    error: {
      code: 'ER_PARSE_ERROR',
      errno: 1064,
      message: "You have an error in your SQL syntax near 'SELEC 1'",
    },
    code: 'query_failed',
    driverCode: '1064',
  },
  // node:sqlite
  {
    dialect: 'sqlite',
    error: {
      code: 'ERR_SQLITE_ERROR',
      errcode: 2067,
      errstr: 'constraint failed',
      message: 'UNIQUE constraint failed: t.v',
    },
    code: 'unique_violation',
    driverCode: '2067',
    constraint: 't.v',
  },
  {
    dialect: 'sqlite',
    error: {
      code: 'ERR_SQLITE_ERROR',
      errcode: 1555,
      message: 'UNIQUE constraint failed: t.a, t.b',
    },
    code: 'unique_violation',
    constraint: 't.a,t.b',
  },
  {
    dialect: 'sqlite',
    error: { code: 'ERR_SQLITE_ERROR', errcode: 787, message: 'FOREIGN KEY constraint failed' },
    code: 'foreign_key_violation',
  },
  {
    dialect: 'sqlite',
    error: { code: 'ERR_SQLITE_ERROR', errcode: 1299, message: 'NOT NULL constraint failed: c.p' },
    code: 'not_null_violation',
    constraint: 'c.p',
  },
  {
    dialect: 'sqlite',
    error: {
      code: 'ERR_SQLITE_ERROR',
      errcode: 275,
      message: 'CHECK constraint failed: checked_positive',
    },
    code: 'check_violation',
    constraint: 'checked_positive',
  },
  {
    dialect: 'sqlite',
    error: { code: 'ERR_SQLITE_ERROR', errcode: 5, message: 'database is locked' },
    code: 'busy',
  },
  {
    dialect: 'sqlite',
    error: { code: 'ERR_SQLITE_ERROR', errcode: 517 },
    code: 'serialization_failure',
  },
  {
    dialect: 'sqlite',
    error: {
      code: 'ERR_SQLITE_ERROR',
      errcode: 8,
      message: 'attempt to write a readonly database',
    },
    code: 'read_only',
  },
  {
    dialect: 'sqlite',
    error: { code: 'ERR_SQLITE_ERROR', errcode: 1, message: 'no such column: nope' },
    code: 'query_failed',
    driverCode: '1',
  },
];

describe('classifyDriverError', () => {
  for (const captured of CAPTURED) {
    const label = `${captured.dialect} ${JSON.stringify(captured.error).slice(0, 60)}`;
    it(`maps ${label} to ${captured.code}`, () => {
      const classified = classifyDriverError(captured.error, captured.dialect);
      assert.ok(classified instanceof DatabaseError);
      assert.equal(classified.code, captured.code);
      if (captured.driverCode !== undefined)
        assert.equal(classified.driverCode, captured.driverCode);
      assert.equal(classified.constraint, captured.constraint);
      const message = (captured.error as { message?: string }).message;
      if (message !== undefined) assert.ok(!classified.message.includes(message));
    });
  }

  it('never copies a value from the driver message', () => {
    const classified = classifyDriverError(
      { errno: 1062, message: "Duplicate entry 'secret@example.com' for key 'users_email_unique'" },
      'mariadb',
    );
    assert.ok(!classified.message.includes('secret'));
    assert.ok(!JSON.stringify(classified.context).includes('secret'));
  });

  it('unwraps a TypeORM QueryFailedError to the driver error it carries', () => {
    const wrapped = { message: 'wrapped', parameters: ['secret'], driverError: { code: '23505' } };
    assert.equal(classifyDriverError(wrapped, 'postgres').code, 'unique_violation');
  });

  it('passes a DatabaseError through and classifies the unknown by phase', () => {
    const original = new DatabaseError('closed');
    assert.equal(classifyDriverError(original, 'sqlite'), original);
    assert.equal(classifyDriverError(new Error('boom'), 'postgres').code, 'query_failed');
    assert.equal(
      classifyDriverError(new Error('boom'), 'mariadb', 'connect').code,
      'connection_failed',
    );
    assert.equal(
      classifyDriverError('not an error', 'sqlite', 'connect').code,
      'connection_failed',
    );
  });

  it('marks the concurrency failures transient', () => {
    for (const code of ['40P01', '40001', '55P03'] as const) {
      assert.equal(classifyDriverError({ code }, 'postgres').transient, true);
    }
    assert.equal(classifyDriverError({ code: '23505' }, 'postgres').transient, false);
  });
});

describe('isSqliteBusy', () => {
  it('treats BUSY, BUSY_RECOVERY and LOCKED as retryable, and BUSY_SNAPSHOT as not', () => {
    assert.equal(isSqliteBusy({ errcode: 5 }), true);
    assert.equal(isSqliteBusy({ errcode: 261 }), true);
    assert.equal(isSqliteBusy({ errcode: 6 }), true);
    assert.equal(isSqliteBusy({ errcode: 517 }), false);
    assert.equal(isSqliteBusy({ errcode: 2067 }), false);
    assert.equal(isSqliteBusy(new Error('x')), false);
  });
});
