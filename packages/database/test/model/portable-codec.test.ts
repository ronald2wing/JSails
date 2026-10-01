/**
 * The portable codecs offline: each type's bound form per dialect, its
 * canonical decoded form, the values every dialect refuses alike, and the
 * stored values a decoder rejects. The database round trip itself is the
 * fidelity suite's (`fidelity.database.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Dialect, SqlValue } from '../../src/engine/index.js';
import {
  ColumnValueError,
  compareCodePoints,
  compareValues,
  portableCodec,
  type PortableType,
} from '../../src/model/index.js';

const DIALECTS: readonly Dialect[] = ['postgres', 'mariadb', 'sqlite'];

function codec(type: PortableType, dialect: Dialect) {
  return portableCodec(type, dialect, 'field') as {
    encode(value: unknown): SqlValue;
    decode(value: SqlValue): unknown;
  };
}

function refuses(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(
      error instanceof ColumnValueError,
      `expected a ColumnValueError, got ${String(error)}`,
    );
    assert.equal(error.code, code);
    return true;
  });
}

function everywhere(type: PortableType, value: unknown, code: string): void {
  for (const dialect of DIALECTS) refuses(() => codec(type, dialect).encode(value), code);
}

describe('portable codecs', () => {
  it('binds each type in its dialect form', () => {
    const at = new Date('2024-02-29T23:59:59.007Z');
    const cases: [PortableType, unknown, Record<Dialect, SqlValue>][] = [
      [{ kind: 'boolean' }, true, { postgres: true, mariadb: 1, sqlite: 1 }],
      [
        { kind: 'timestamp' },
        at,
        {
          postgres: '2024-02-29T23:59:59.007Z',
          mariadb: '2024-02-29 23:59:59.007',
          sqlite: '2024-02-29T23:59:59.007Z',
        },
      ],
      [
        { kind: 'decimal', precision: 10, scale: 2 },
        '-12.5',
        { postgres: '-12.50', mariadb: '-12.50', sqlite: -1250n },
      ],
      [
        { kind: 'decimal', precision: 20, scale: 2 },
        '12.5',
        { postgres: '12.50', mariadb: '12.50', sqlite: '100000000000000001250' },
      ],
      [
        { kind: 'time' },
        '09:30:00',
        { postgres: '09:30:00.000', mariadb: '09:30:00.000', sqlite: '09:30:00.000' },
      ],
      [
        { kind: 'json' },
        { a: [1, 'x'] },
        { postgres: '{"a":[1,"x"]}', mariadb: '{"a":[1,"x"]}', sqlite: '{"a":[1,"x"]}' },
      ],
    ];
    for (const [type, value, expected] of cases) {
      for (const dialect of DIALECTS) {
        assert.deepEqual(
          codec(type, dialect).encode(value),
          expected[dialect],
          `${type.kind} ${dialect}`,
        );
      }
    }
    const uuid = '0F8FAD5B-D9CB-469F-A165-70867728950E';
    assert.equal(codec({ kind: 'uuid' }, 'postgres').encode(uuid), uuid.toLowerCase());
    assert.equal(codec({ kind: 'uuid' }, 'sqlite').encode(uuid), uuid.toLowerCase());
    const bytes = codec({ kind: 'uuid' }, 'mariadb').encode(uuid) as Uint8Array;
    assert.equal(bytes.length, 16);
    assert.equal(codec({ kind: 'uuid' }, 'mariadb').decode(bytes), uuid.toLowerCase());
  });

  it('decodes what each server returns to the canonical value', () => {
    const decimal: PortableType = { kind: 'decimal', precision: 10, scale: 2 };
    assert.equal(codec(decimal, 'postgres').decode('-0.00'), '0.00');
    assert.equal(codec(decimal, 'mariadb').decode('007.10'), '7.10');
    assert.equal(codec(decimal, 'sqlite').decode(-5), '-0.05');
    assert.equal(codec(decimal, 'sqlite').decode(0), '0.00');
    const whole: PortableType = { kind: 'decimal', precision: 5, scale: 0 };
    assert.equal(codec(whole, 'sqlite').decode(codec(whole, 'sqlite').encode('-99999')), '-99999');
    const wide: PortableType = { kind: 'decimal', precision: 20, scale: 2 };
    for (const value of ['0.00', '-0.01', '-999999999999999999.99', '999999999999999999.99']) {
      assert.equal(codec(wide, 'sqlite').decode(codec(wide, 'sqlite').encode(value)), value);
    }

    const time: PortableType = { kind: 'time' };
    assert.equal(codec(time, 'postgres').decode('12:00:00'), '12:00:00.000');
    assert.equal(codec(time, 'postgres').decode('12:00:00.5'), '12:00:00.500');
    assert.equal(codec(time, 'mariadb').decode('23:59:59.999'), '23:59:59.999');

    const timestamp: PortableType = { kind: 'timestamp' };
    const expected = Date.parse('2024-01-01T12:00:00.123Z');
    for (const stored of [
      '2024-01-01 12:00:00.123+00',
      '2024-01-01 17:30:00.123+05:30',
      '2024-01-01 12:00:00.123',
      '2024-01-01T12:00:00.123Z',
      '2024-01-01 12:00:00.123000',
    ]) {
      const decoded = codec(timestamp, 'postgres').decode(stored) as Date;
      assert.equal(decoded.getTime(), expected, stored);
    }
    assert.equal(
      (codec(timestamp, 'mariadb').decode('1000-01-01 00:00:00.000') as Date).toISOString(),
      '1000-01-01T00:00:00.000Z',
    );

    assert.equal(codec({ kind: 'id' }, 'postgres').decode(9007199254740991n), 9007199254740991);
    assert.equal(codec({ kind: 'bigint' }, 'sqlite').decode(5), 5n);
    assert.equal(codec({ kind: 'boolean' }, 'sqlite').decode(0), false);
    assert.equal(codec({ kind: 'float' }, 'sqlite').decode(-0), 0);

    const buffer = Buffer.from([1, 2, 3]);
    const plain = codec({ kind: 'binary' }, 'postgres').decode(buffer) as Uint8Array;
    assert.equal(Object.getPrototypeOf(plain), Uint8Array.prototype);
    assert.deepEqual(plain, new Uint8Array([1, 2, 3]));
  });

  it('refuses on every dialect what some dialect could not store unchanged', () => {
    const string: PortableType = { kind: 'string', length: 3 };
    everywhere(string, 'a\u0000b', 'invalid_value');
    everywhere(string, '\uD800', 'invalid_value');
    everywhere(string, 'abcd', 'too_long');
    // Length counts code points, as PostgreSQL and MariaDB do.
    for (const dialect of DIALECTS) assert.equal(codec(string, dialect).encode('a😀b'), 'a😀b');
    everywhere({ kind: 'text' }, 7, 'invalid_value');
    everywhere({ kind: 'integer' }, 2147483648, 'out_of_range');
    everywhere({ kind: 'integer' }, 1.5, 'invalid_value');
    everywhere({ kind: 'id' }, 2 ** 53, 'invalid_value');
    everywhere({ kind: 'bigint' }, 1, 'invalid_value');
    everywhere({ kind: 'bigint' }, 2n ** 63n, 'out_of_range');
    everywhere({ kind: 'float' }, Number.NaN, 'invalid_value');
    everywhere({ kind: 'float' }, Number.POSITIVE_INFINITY, 'invalid_value');
    const decimal: PortableType = { kind: 'decimal', precision: 4, scale: 2 };
    everywhere(decimal, '1.234', 'too_precise');
    everywhere(decimal, '100.00', 'out_of_range');
    everywhere(decimal, 1.5, 'invalid_value');
    everywhere(decimal, '1e3', 'invalid_value');
    for (const dialect of DIALECTS)
      assert.notEqual(codec(decimal, dialect).encode('1.230'), undefined);
    everywhere({ kind: 'boolean' }, 1, 'invalid_value');
    everywhere({ kind: 'timestamp' }, new Date(Number.NaN), 'invalid_value');
    everywhere({ kind: 'timestamp' }, new Date('0999-12-31T23:59:59.999Z'), 'out_of_range');
    everywhere({ kind: 'timestamp' }, '2024-01-01', 'invalid_value');
    everywhere({ kind: 'date' }, '2023-02-29', 'out_of_range');
    everywhere({ kind: 'date' }, '2023-2-28', 'invalid_value');
    everywhere({ kind: 'time' }, '24:00:00', 'out_of_range');
    everywhere({ kind: 'time' }, '12:00:00.1234', 'invalid_value');
    everywhere({ kind: 'json' }, null, 'invalid_value');
    everywhere({ kind: 'json' }, { a: undefined }, 'invalid_value');
    everywhere({ kind: 'json' }, { a: '\u0000' }, 'invalid_value');
    everywhere({ kind: 'json' }, { a: new Date() }, 'invalid_value');
    everywhere({ kind: 'json' }, [Number.NaN], 'invalid_value');
    everywhere({ kind: 'uuid' }, 'not-a-uuid', 'invalid_value');
    everywhere({ kind: 'binary', length: 2 }, new Uint8Array(3), 'too_long');
    everywhere({ kind: 'binary' }, [1, 2], 'invalid_value');
  });

  it('rejects stored values the type never writes', () => {
    refuses(() => codec({ kind: 'id' }, 'postgres').decode(2n ** 53n), 'unsafe_integer');
    refuses(() => codec({ kind: 'boolean' }, 'mariadb').decode(2), 'invalid_stored_value');
    refuses(() => codec({ kind: 'json' }, 'sqlite').decode('{'), 'invalid_stored_value');
    refuses(
      () => codec({ kind: 'timestamp' }, 'postgres').decode('yesterday'),
      'invalid_stored_value',
    );
    refuses(
      () => codec({ kind: 'timestamp' }, 'postgres').decode('2024-01-01 00:00:00.1234'),
      'invalid_stored_value',
    );
    refuses(
      () => codec({ kind: 'uuid' }, 'mariadb').decode(new Uint8Array(15)),
      'invalid_stored_value',
    );
    refuses(
      () => codec({ kind: 'decimal', precision: 20, scale: 2 }, 'sqlite').decode('12'),
      'invalid_stored_value',
    );
    refuses(() => codec({ kind: 'integer' }, 'sqlite').decode(2 ** 40), 'invalid_stored_value');
  });

  it('keeps the value out of the error', () => {
    const secret = 'hunter2-secret-value';
    assert.throws(
      () => codec({ kind: 'string', length: 3 }, 'postgres').encode(secret),
      (error: unknown) => {
        assert.ok(error instanceof ColumnValueError);
        assert.doesNotMatch(error.message, /hunter2/);
        assert.doesNotMatch(JSON.stringify(error.context), /hunter2/);
        assert.equal(error.field, 'field');
        return true;
      },
    );
    assert.throws(
      () => codec({ kind: 'json' }, 'postgres').decode(`{"token":"${secret}"`),
      (error: unknown) => error instanceof ColumnValueError && !error.message.includes('hunter2'),
    );
  });

  it('orders values as the binary collations and numeric types do', () => {
    // U+FF5E sorts before U+1F600 by code point, after it by UTF-16 unit.
    assert.equal(compareCodePoints('～', '😀'), -1);
    assert.equal('～' < '😀', false);
    assert.equal(compareCodePoints('a', 'a '), -1);
    assert.equal(compareCodePoints('B', 'a'), -1);
    const decimal: PortableType = { kind: 'decimal', precision: 10, scale: 2 };
    const sorted = ['-10.00', '-9.99', '-0.01', '0.00', '0.01', '2.00', '10.00'];
    assert.deepEqual(
      [...sorted].reverse().sort((a, b) => compareValues(decimal, a, b)),
      sorted,
    );
    assert.equal(
      compareValues({ kind: 'binary' }, new Uint8Array([1]), new Uint8Array([1, 0])),
      -1,
    );
    assert.equal(compareValues({ kind: 'bigint' }, -1n, 1n), -1);
    assert.equal(compareValues({ kind: 'boolean' }, false, true), -1);
  });
});
