/**
 * Tests for the Docker env-file encoder accessories read their credentials
 * from: verbatim values, ordering, and key and value validation, each refusal
 * naming only the key.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EnvFileErrors, MAX_ENV_FILE_LINE_BYTES, encodeEnvFile } from '../src/env-file.js';

/**
 * Docker's own env-file reading (`docker/cli` `parseKeyValueFile`): leading
 * whitespace trimmed, blank and `#` lines skipped, split at the first `=`, the
 * rest of the line taken byte for byte.
 */
function parseDockerEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trimStart();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    result[line.slice(0, at)] = line.slice(at + 1);
  }
  return result;
}

/** Tests for the Docker env-file encoder. */
describe('encodeEnvFile', () => {
  it('emits one KEY=VALUE line per entry, in insertion order', () => {
    assert.equal(encodeEnvFile({ B: '2', A: '1' }), 'B=2\nA=1\n');
  });

  it('emits a single newline for an empty map', () => {
    assert.equal(encodeEnvFile({}), '\n');
  });

  it('writes every value verbatim, since Docker reads the rest of the line literally', () => {
    const values = {
      BACKSLASH: 'path\\to\\n',
      DOUBLE: 'say "hi"',
      QUOTED: '"quoted"',
      SINGLE: "'single'",
      EQUALS: 'a=b==c',
      HASH: '#pass#word',
      SPACES: '  padded  ',
      UNICODE: 'héllo wörld',
      EMPTY: '',
    };
    assert.equal(
      encodeEnvFile(values),
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  });

  it('round-trips through the Docker env-file parse rule to the exact values', () => {
    const values = {
      A: 'p\\a\\\\ss',
      B: 'x="y" #z',
      C: '==',
      D: '\\n not a newline',
    };
    assert.deepEqual(parseDockerEnvFile(encodeEnvFile(values)), values);
  });

  for (const [label, value] of [
    ['a newline', 'line1\nline2'],
    ['a carriage return', 'a\rb'],
    ['a NUL', 'a\0b'],
    ['an unpaired surrogate', 'a\ud800b'],
  ] as const) {
    it(`refuses a value containing ${label}, naming only the key`, () => {
      assert.throws(
        () => encodeEnvFile({ SECRET_TOKEN: value }),
        (error: unknown) => {
          assert.ok(EnvFileErrors.is(error, 'invalid_value'));
          assert.match(error.message, /SECRET_TOKEN/);
          assert.ok(!error.message.includes(value), 'the value must not leak');
          return true;
        },
      );
    });
  }

  it('refuses a line longer than Docker reads, counting UTF-8 bytes, naming only the key', () => {
    const key = 'BIG';
    const room = MAX_ENV_FILE_LINE_BYTES - key.length - 1;
    assert.doesNotThrow(() => encodeEnvFile({ [key]: 'x'.repeat(room) }));
    // One two-byte character instead of an ASCII one tips the line over.
    const value = 'é' + 'x'.repeat(room - 1);
    assert.throws(
      () => encodeEnvFile({ [key]: value }),
      (error: unknown) => {
        assert.ok(EnvFileErrors.is(error, 'too_large'));
        assert.match(error.message, /BIG/);
        assert.ok(!error.message.includes('xxxx'), 'the value must not leak');
        return true;
      },
    );
  });

  it('rejects a key that is not an identifier', () => {
    assert.throws(
      () => encodeEnvFile({ 'not-a-key': '1' }),
      (error: unknown) => EnvFileErrors.is(error, 'invalid_key'),
    );
  });

  it('rejects a reserved key', () => {
    assert.throws(
      () => encodeEnvFile({ constructor: '1' }),
      (error: unknown) => EnvFileErrors.is(error, 'invalid_key'),
    );
  });
});
