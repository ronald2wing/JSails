/**
 * Tests for the portable relative path guard and the file/directory collision
 * check: every unsafe form is refused value-free, dotfile segments pass.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertPortablePath,
  findPathCollision,
  PortablePathErrors,
} from '../../src/support/portable-path.js';

describe('assertPortablePath', () => {
  const unsafePaths = [
    '',
    '/etc/passwd',
    'C:/windows/system32',
    'C:\\windows',
    'a\\b',
    '..',
    '../escape',
    'a/../b',
    '.',
    './a',
    'a/./b',
    'a//b',
    'a/',
    '__proto__',
    'a/__proto__/b',
    'a:b',
    'a*b',
    'a?b',
    'a<b',
    'a>b',
    'a|b',
    'a"b',
    'a\u0000b',
    'a\u001fb',
    'a\u007fb',
    '//server/share',
  ];

  // The messages name these forbidden segments themselves; any other input
  // appearing in a message would be an echo.
  const RULE_TOKENS = new Set(['..', '__proto__']);

  for (const path of unsafePaths) {
    it(`rejects ${JSON.stringify(path)} without echoing it`, () => {
      assert.throws(
        () => assertPortablePath(path),
        (error: unknown) =>
          PortablePathErrors.is(error, 'invalid_path') &&
          (RULE_TOKENS.has(path) || path.length < 2 || !error.message.includes(path)),
      );
    });
  }

  it('allows dotfile segments', () => {
    for (const path of ['.kamal/secrets', '.env.example', 'config/.hidden/file.txt']) {
      assert.doesNotThrow(() => assertPortablePath(path));
    }
  });
});

describe('findPathCollision', () => {
  it('finds a path used as both a file and a directory, in any order', () => {
    assert.equal(findPathCollision(['a', 'a/b']), 'a');
    assert.equal(findPathCollision(['a/b', 'a']), 'a');
    assert.equal(findPathCollision(['a/b/c', 'a/b']), 'a/b');
  });

  it('answers null when no path is a directory prefix of another', () => {
    assert.equal(findPathCollision(['a/b', 'a/c', 'ab']), null);
  });
});
