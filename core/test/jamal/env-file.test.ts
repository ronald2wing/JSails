import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JamalEnvFileError, encodeEnvFile } from '../../src/jamal/env-file.js';

/** Tests for the Docker env-file encoder (Kamal's `EnvFile` port). */
describe('encodeEnvFile', () => {
  it('emits one KEY=VALUE line per entry, in insertion order', () => {
    assert.equal(encodeEnvFile({ B: '2', A: '1' }), 'B=2\nA=1\n');
  });

  it('emits a single newline for an empty map', () => {
    assert.equal(encodeEnvFile({}), '\n');
  });

  it('preserves an interior double quote literally', () => {
    assert.equal(encodeEnvFile({ A: 'say "hi"' }), 'A=say "hi"\n');
  });

  it('strips leading and trailing double quotes, as Kamal does', () => {
    assert.equal(encodeEnvFile({ A: '"quoted"' }), 'A="quoted"\n');
  });

  it('preserves a hash inside a value', () => {
    assert.equal(encodeEnvFile({ A: 'pass#word' }), 'A=pass#word\n');
  });

  it('preserves non-ASCII runs untouched', () => {
    assert.equal(encodeEnvFile({ A: 'héllo wörld' }), 'A=héllo wörld\n');
  });

  it('preserves an empty value', () => {
    assert.equal(encodeEnvFile({ A: '' }), 'A=\n');
  });

  it('escapes a newline to a literal backslash-n, never a second line', () => {
    assert.equal(encodeEnvFile({ A: 'line1\nline2' }), 'A=line1\\nline2\n');
  });

  it('escapes a control character to its literal form', () => {
    assert.equal(encodeEnvFile({ A: 'a\u0001b' }), 'A=a\\u0001b\n');
  });

  it('escapes a backslash so the container reads it back', () => {
    assert.equal(encodeEnvFile({ A: 'path\\to' }), 'A=path\\\\to\n');
  });

  it('rejects a key that is not an identifier', () => {
    assert.throws(
      () => encodeEnvFile({ 'not-a-key': '1' }),
      (error: unknown) => error instanceof JamalEnvFileError && error.code === 'invalid_key',
    );
  });

  it('rejects a reserved key', () => {
    assert.throws(
      () => encodeEnvFile({ constructor: '1' }),
      (error: unknown) => error instanceof JamalEnvFileError && error.code === 'invalid_key',
    );
  });
});
