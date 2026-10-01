/**
 * MariaDB parameter binding: placeholders are found outside literals and
 * comments, and every value becomes a token no `sql_mode` can reinterpret.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bindMariadbParameters,
  mariadbLiteral,
  mariadbPlaceholderOffsets,
} from '../../../src/engine/server/mariadb-placeholders.js';

describe('mariadbPlaceholderOffsets', () => {
  it('finds placeholders outside literals and comments', () => {
    assert.deepEqual(mariadbPlaceholderOffsets('SELECT ?, ? FROM t WHERE a = ?'), [7, 10, 29]);
    assert.equal(mariadbPlaceholderOffsets("SELECT 'it''s', 'a\\'b', `we``ird`, ?")?.length, 1);
    assert.equal(mariadbPlaceholderOffsets('SELECT 1 -- trailing\n, ?')?.length, 1);
    assert.deepEqual(mariadbPlaceholderOffsets('SELECT 1'), []);
  });

  it('reports a ? inside a literal or comment', () => {
    assert.equal(mariadbPlaceholderOffsets("SELECT '?' , ?"), undefined);
    assert.equal(mariadbPlaceholderOffsets('SELECT "a?b"'), undefined);
    assert.equal(mariadbPlaceholderOffsets('SELECT `a?`'), undefined);
    assert.equal(mariadbPlaceholderOffsets('SELECT 1 /* why? */'), undefined);
    assert.equal(mariadbPlaceholderOffsets('SELECT 1 # what?'), undefined);
    assert.equal(mariadbPlaceholderOffsets('SELECT 1 -- what?'), undefined);
  });
});

describe('mariadbLiteral', () => {
  it('writes strings and binary as hexadecimal, with no quote to escape', () => {
    const hostile = "x\\' OR 1=1 -- ";
    const literal = mariadbLiteral(hostile);
    assert.equal(literal, ` _utf8mb4 X'${Buffer.from(hostile).toString('hex')}' `);
    assert.doesNotMatch(literal.slice(literal.indexOf("'") + 1, -2), /['\\]/);
    assert.equal(mariadbLiteral(''), " _utf8mb4 X'' ");
    assert.equal(mariadbLiteral('é'), " _utf8mb4 X'c3a9' ");
    assert.equal(mariadbLiteral(new Uint8Array([0, 255])), "X'00ff'");
    assert.equal(mariadbLiteral(Buffer.from('ab')), "X'6162'");
  });

  it('writes integers as digits and parenthesises negatives', () => {
    assert.equal(mariadbLiteral(42), '42');
    assert.equal(mariadbLiteral(-1), '(-1)');
    assert.equal(mariadbLiteral(-0), '0');
    assert.equal(mariadbLiteral(1.5), '1.5');
    assert.equal(mariadbLiteral(9223372036854775807n), '9223372036854775807');
    assert.equal(mariadbLiteral(-5n), '(-5)');
    assert.equal(mariadbLiteral(true), 'TRUE');
    assert.equal(mariadbLiteral(false), 'FALSE');
    assert.equal(mariadbLiteral(null), 'NULL');
    assert.throws(() => mariadbLiteral(Number.NaN), { code: 'invalid_parameter' });
  });
});

describe('bindMariadbParameters', () => {
  it('replaces each placeholder in order and leaves parameterless SQL alone', () => {
    assert.equal(
      bindMariadbParameters('SELECT a FROM t WHERE b = ? AND c-? LIMIT ?', ['x', -2, 5]),
      "SELECT a FROM t WHERE b =  _utf8mb4 X'78'  AND c-(-2) LIMIT 5",
    );
    assert.equal(bindMariadbParameters("SELECT '?'", []), "SELECT '?'");
  });

  it('refuses a ? in a literal and a count mismatch', () => {
    assert.throws(() => bindMariadbParameters("SELECT '?', ?", [1]), {
      code: 'invalid_statement',
    });
    assert.throws(() => bindMariadbParameters('SELECT ?, ?', [1]), { code: 'invalid_parameter' });
  });
});
