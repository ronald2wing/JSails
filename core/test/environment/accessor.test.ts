/**
 * Tests for the config accessor: `env.require` fails on the exact missing
 * name, except under a command that skipped the sealed credentials, and
 * `env.optional` reads absent and empty alike.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { env } from '../../src/environment/accessor.js';
import { EnvironmentErrors } from '../../src/environment/errors.js';

const NAME = 'JSAILS_ACCESSOR_TEST_VALUE';
const MARKER = 'JSAILS_ENV_RESOLVED';
const savedMarker = process.env[MARKER];

afterEach(() => {
  delete process.env[NAME];
  if (savedMarker === undefined) delete process.env[MARKER];
  else process.env[MARKER] = savedMarker;
});

describe('env accessor', () => {
  it('reads a set variable through both methods', () => {
    process.env[NAME] = 'value';
    assert.equal(env.require(NAME), 'value');
    assert.equal(env.optional(NAME), 'value');
  });

  it('treats an empty variable as unset', () => {
    process.env[NAME] = '';
    assert.equal(env.optional(NAME), undefined);
    assert.throws(() => env.require(NAME), /JSAILS_ACCESSOR_TEST_VALUE is required/);
  });

  it('names the missing variable when the command uses secrets', () => {
    process.env[MARKER] = `production:${'a'.repeat(16)}:${'b'.repeat(64)}:${'c'.repeat(64)}`;
    assert.throws(
      () => env.require(NAME),
      (error: unknown) =>
        EnvironmentErrors.is(error) &&
        error.code === 'environment.missing_variable' &&
        error.message === `the environment variable ${NAME} is required but not set`,
    );
  });

  it('reads a missing variable as empty under a command that skipped the sealed credentials', () => {
    process.env[MARKER] = `production:skipped:${'b'.repeat(64)}:${'c'.repeat(64)}`;
    assert.equal(env.require(NAME), '');
    assert.equal(env.optional(NAME), undefined);
  });

  it('rejects a name that cannot be a variable', () => {
    for (const name of ['', 'has space', '1ABC', '__proto__']) {
      assert.throws(
        () => env.require(name),
        (error: unknown) =>
          EnvironmentErrors.is(error) && error.code === 'environment.invalid_variable_name',
      );
    }
  });
});
