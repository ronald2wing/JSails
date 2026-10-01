/**
 * Tests for the command-string tokenizer shared by the jamal CLI and planner.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitCommandLine } from '../../src/jamal/command-line.js';

describe('splitCommandLine', () => {
  it('splits plain tokens on whitespace', () => {
    assert.deepEqual(splitCommandLine('jsails jamal secrets fetch DB'), [
      'jsails',
      'jamal',
      'secrets',
      'fetch',
      'DB',
    ]);
  });

  it('collapses leading, trailing, and repeated whitespace', () => {
    assert.deepEqual(splitCommandLine('  jsails   jamal secrets   '), [
      'jsails',
      'jamal',
      'secrets',
    ]);
  });

  it('strips single and double quotes around an argument', () => {
    assert.deepEqual(splitCommandLine(`jsails jamal secrets fetch 'DB_PASSWORD'`), [
      'jsails',
      'jamal',
      'secrets',
      'fetch',
      'DB_PASSWORD',
    ]);
    assert.deepEqual(splitCommandLine('jsails jamal secrets fetch "DB PASSWORD"'), [
      'jsails',
      'jamal',
      'secrets',
      'fetch',
      'DB PASSWORD',
    ]);
  });

  it('unescapes a backslash before another character', () => {
    assert.deepEqual(splitCommandLine('jsails jamal secrets fetch DB\\_NAME'), [
      'jsails',
      'jamal',
      'secrets',
      'fetch',
      'DB_NAME',
    ]);
  });

  it('returns an empty list for a whitespace-only command', () => {
    assert.deepEqual(splitCommandLine('   \t '), []);
  });
});
