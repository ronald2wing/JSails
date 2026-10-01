import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { JamalSecretsError } from '../../src/jamal/secrets.js';
import { resolveSecretValueInline, splitCommandLine } from '../../src/jamal/secrets-command.js';

/**
 * Tests for the inline `$(jsails jamal secrets ...)` helpers: the command-line
 * splitter and the value resolver the deploy path wires into the secrets loader.
 */

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'jamal-inline-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

let counter = 0;

/** Create a fixture directory with the given files and return its path. */
function fixture(files: Readonly<Record<string, string>>): string {
  counter += 1;
  const dir = join(fixturesRoot, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
  }
  return dir;
}

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

describe('resolveSecretValueInline', () => {
  it('fetch resolves one secret by name', () => {
    const dir = fixture({ '.jamal/secrets': 'DB=secret\n' });
    assert.equal(resolveSecretValueInline({ rootDir: dir, verb: 'fetch', name: 'DB' }), 'secret');
  });

  it('extract walks a path inside a JSON secret', () => {
    const dir = fixture({ '.jamal/secrets': 'VAULT={"db":{"password":"pw"}}\n' });
    assert.equal(
      resolveSecretValueInline({ rootDir: dir, verb: 'extract', name: 'VAULT/db/password' }),
      'pw',
    );
  });

  it('extract stringifies a non-string JSON value', () => {
    const dir = fixture({ '.jamal/secrets': 'VAULT={"port":5432}\n' });
    assert.equal(
      resolveSecretValueInline({ rootDir: dir, verb: 'extract', name: 'VAULT/port' }),
      '5432',
    );
  });

  it('honors a secrets path and destination override', () => {
    const dir = fixture({ 'config/secrets.staging': 'DB=staged\n' });
    assert.equal(
      resolveSecretValueInline({
        rootDir: dir,
        verb: 'fetch',
        name: 'DB',
        secretsPath: 'config/secrets',
        destination: 'staging',
      }),
      'staged',
    );
  });

  it('throws a value-free error for a missing secret', () => {
    const dir = fixture({ '.jamal/secrets': 'DB=secret\n' });
    assert.throws(
      () => resolveSecretValueInline({ rootDir: dir, verb: 'fetch', name: 'NOPE' }),
      (error: unknown) => error instanceof JamalSecretsError && error.code === 'missing_secret',
    );
  });

  it('throws a value-free error when the JSON path has no value', () => {
    const dir = fixture({ '.jamal/secrets': 'VAULT={"db":{}}\n' });
    assert.throws(
      () => resolveSecretValueInline({ rootDir: dir, verb: 'extract', name: 'VAULT/nope' }),
      (error: unknown) =>
        error instanceof JamalSecretsError &&
        error.code === 'missing_secret' &&
        error.message.includes('nope'),
    );
  });
});
