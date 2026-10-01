/**
 * The leading keyword of a statement, past whitespace, comments and parentheses.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isWriteKeyword, leadingKeyword } from '../../src/engine/sql-keyword.js';

describe('leadingKeyword', () => {
  it('reads the first keyword, upper-cased', () => {
    assert.equal(leadingKeyword('select 1'), 'SELECT');
    assert.equal(leadingKeyword('  \n\tInsert INTO t'), 'INSERT');
    assert.equal(leadingKeyword('-- note\n/* block */ (SELECT 1)'), 'SELECT');
    assert.equal(leadingKeyword('WITH x AS (SELECT 1) DELETE FROM t'), 'WITH');
    assert.equal(leadingKeyword(''), '');
    assert.equal(leadingKeyword('-- only a comment'), '');
    assert.equal(leadingKeyword('/* unterminated'), '');
  });

  it('knows the writing keywords', () => {
    for (const keyword of ['INSERT', 'UPDATE', 'DELETE', 'REPLACE'])
      assert.ok(isWriteKeyword(keyword));
    for (const keyword of ['SELECT', 'WITH', 'BEGIN', 'CREATE', ''])
      assert.ok(!isWriteKeyword(keyword));
  });
});
