/**
 * Tests for the inline `jamal secrets` value resolution.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { JamalSecretsError } from '../../src/jamal/secrets.js';
import { resolveSecretValueInline } from '../../src/jamal/secrets-command.js';

/**
 * Tests for the inline `$(jsails jamal secrets ...)` value resolver the deploy
 * path wires into the secrets loader.
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
