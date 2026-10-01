/**
 * Tests for encrypted credentials: key resolution, the environment binding of
 * the ciphertext, value-free failures, and the bootstrap layering where real
 * variables and `.env` files win over the credentials file.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  CREDENTIALS_KEY_ENV,
  CREDENTIALS_LOADED_ENV,
  CredentialsError,
  credentialsEnvironment,
  credentialsPaths,
  decryptCredentials,
  encryptCredentials,
  generateCredentialsKey,
  loadCredentials,
  resolveCredentialsKey,
} from '../src/credentials.js';
import { assembleEnvironment } from '../src/dotenv.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-credentials-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

/** A project directory holding an encrypted file (and optionally its key file). */
function project(
  environment: string,
  plaintext: string,
  options: { keyFile?: boolean } = {},
): { dir: string; key: string } {
  const dir = join(root, `case-${seq++}`);
  const key = generateCredentialsKey();
  const paths = credentialsPaths(dir, environment);
  mkdirSync(join(dir, 'config', 'credentials'), { recursive: true });
  writeFileSync(paths.file, encryptCredentials(plaintext, key, environment));
  if (options.keyFile !== false) writeFileSync(paths.keyFile, `${key}\n`);
  return { dir, key };
}

describe('credentials', () => {
  it('round-trips plaintext for the environment it was encrypted for', () => {
    const key = generateCredentialsKey();
    const sealed = encryptCredentials('API_TOKEN=abc\n', key, 'production');
    assert.ok(!sealed.includes('abc'));
    assert.equal(decryptCredentials(sealed, key, 'production'), 'API_TOKEN=abc\n');
  });

  it('refuses a file encrypted for another environment or with another key', () => {
    const key = generateCredentialsKey();
    const sealed = encryptCredentials('API_TOKEN=abc\n', key, 'development');
    for (const attempt of [
      () => decryptCredentials(sealed, key, 'production'),
      () => decryptCredentials(sealed, generateCredentialsKey(), 'development'),
      () => decryptCredentials(`${sealed.slice(0, -5)}AAAA\n`, key, 'development'),
    ]) {
      assert.throws(
        attempt,
        (error: unknown) =>
          error instanceof CredentialsError &&
          error.code === 'decryption_failed' &&
          !error.message.includes(key),
      );
    }
  });

  it('rejects a key shorter than 32 bytes without echoing it', () => {
    assert.throws(
      () => encryptCredentials('A=1', 'short-key-value', 'development'),
      (error: unknown) =>
        error instanceof CredentialsError &&
        error.code === 'invalid_key' &&
        !error.message.includes('short-key-value'),
    );
  });

  it('defaults the environment to development and rejects path-like names', () => {
    assert.equal(credentialsEnvironment(undefined), 'development');
    assert.equal(credentialsEnvironment(''), 'development');
    assert.equal(credentialsEnvironment('staging-eu'), 'staging-eu');
    for (const name of ['../prod', 'a/b', 'prod.old']) {
      assert.throws(
        () => credentialsEnvironment(name),
        (error: unknown) =>
          error instanceof CredentialsError && error.code === 'invalid_environment',
      );
    }
  });

  it('prefers the key variable for the running environment only', () => {
    const { dir } = project('production', 'A=1\n');
    const override = generateCredentialsKey();
    const fileKey = resolveCredentialsKey(dir, 'production', {}, undefined);
    // A key set for development, say in .env, is never tried for production.
    assert.equal(
      resolveCredentialsKey(dir, 'production', { [CREDENTIALS_KEY_ENV]: override }, 'development'),
      fileKey,
    );
    assert.equal(
      resolveCredentialsKey(dir, 'staging', { [CREDENTIALS_KEY_ENV]: override }, 'development'),
      undefined,
    );
    assert.equal(
      resolveCredentialsKey(dir, 'production', { [CREDENTIALS_KEY_ENV]: override }, 'production'),
      override,
    );
    assert.notEqual(fileKey, undefined);
    assert.equal(resolveCredentialsKey(dir, 'staging', {}, 'staging'), undefined);
  });

  it('fills only unset keys and reports how many it applied', () => {
    const { dir } = project('production', 'API_TOKEN=secret\nDATABASE_HOST=db.internal\n');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', DATABASE_HOST: 'override' };
    const result = loadCredentials({ rootDir: dir, env });
    assert.deepEqual(result, { status: 'loaded', environment: 'production', applied: 1 });
    assert.equal(env.API_TOKEN, 'secret');
    assert.equal(env.DATABASE_HOST, 'override');
  });

  it('is absent without a file or with an unusable NODE_ENV, and reports a missing key', () => {
    const { dir } = project('production', 'A=1\n', { keyFile: false });
    assert.deepEqual(loadCredentials({ rootDir: dir, env: { NODE_ENV: 'staging' } }), {
      status: 'absent',
    });
    assert.deepEqual(loadCredentials({ rootDir: dir, env: { NODE_ENV: '../x' } }), {
      status: 'absent',
    });
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    assert.deepEqual(loadCredentials({ rootDir: dir, env }), {
      status: 'missing_key',
      environment: 'production',
    });
    assert.equal(env.A, undefined);
  });

  it('throws when the file does not decrypt', () => {
    const { dir } = project('production', 'A=1\n', { keyFile: false });
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      [CREDENTIALS_KEY_ENV]: generateCredentialsKey(),
    };
    assert.throws(() => loadCredentials({ rootDir: dir, env }), CredentialsError);
  });

  it('removes the key from the environment on every outcome', () => {
    const { dir, key } = project('production', 'API_TOKEN=secret\n', { keyFile: false });
    const loaded: NodeJS.ProcessEnv = { NODE_ENV: 'production', [CREDENTIALS_KEY_ENV]: key };
    assert.equal(loadCredentials({ rootDir: dir, env: loaded }).status, 'loaded');
    assert.equal(loaded.API_TOKEN, 'secret');
    assert.equal(CREDENTIALS_KEY_ENV in loaded, false);

    const wrong: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      [CREDENTIALS_KEY_ENV]: generateCredentialsKey(),
    };
    assert.throws(() => loadCredentials({ rootDir: dir, env: wrong }), CredentialsError);
    assert.equal(CREDENTIALS_KEY_ENV in wrong, false);

    const absent: NodeJS.ProcessEnv = { NODE_ENV: 'staging', [CREDENTIALS_KEY_ENV]: key };
    assert.deepEqual(loadCredentials({ rootDir: dir, env: absent }), { status: 'absent' });
    assert.equal(CREDENTIALS_KEY_ENV in absent, false);
  });

  it('marks the loaded environment so a child process does not load it again', () => {
    const { dir, key } = project('production', 'API_TOKEN=secret\n', { keyFile: false });
    const parent: NodeJS.ProcessEnv = { NODE_ENV: 'production', [CREDENTIALS_KEY_ENV]: key };
    loadCredentials({ rootDir: dir, env: parent });
    assert.equal(parent[CREDENTIALS_LOADED_ENV], 'production');

    // A child starts from the parent's environment: the values, the marker, no key.
    const child: NodeJS.ProcessEnv = { ...parent };
    assert.deepEqual(loadCredentials({ rootDir: dir, env: child }), {
      status: 'inherited',
      environment: 'production',
    });
    assert.equal(child.API_TOKEN, 'secret');
  });

  it('loads normally when the marker names another environment', () => {
    const { dir } = project('test', 'FROM_TEST=1\n');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', [CREDENTIALS_LOADED_ENV]: 'development' };
    assert.deepEqual(loadCredentials({ rootDir: dir, env }), {
      status: 'loaded',
      environment: 'test',
      applied: 1,
    });
    assert.equal(env.FROM_TEST, '1');
    assert.equal(env[CREDENTIALS_LOADED_ENV], 'test');
  });

  it('loads as the lowest layer of the bootstrap, after the .env files', () => {
    const { dir, key } = project('development', 'FROM_CREDENTIALS=1\nSHARED=credentials\n', {
      keyFile: false,
    });
    // The key itself may come from a .env file, which is why credentials load last.
    writeFileSync(join(dir, '.env.local'), `${CREDENTIALS_KEY_ENV}=${key}\nSHARED=dotenv\n`);
    const env: NodeJS.ProcessEnv = {};
    const result = assembleEnvironment({ rootDir: dir, nodeEnv: 'development', env });
    assert.equal(result.status, 'loaded');
    assert.equal(env.FROM_CREDENTIALS, '1');
    assert.equal(env.SHARED, 'dotenv');
    assert.equal(CREDENTIALS_KEY_ENV in env, false);
  });

  it('skips credentials when the bootstrap is told to', () => {
    const { dir } = project('development', 'FROM_CREDENTIALS=1\n');
    const env: NodeJS.ProcessEnv = {};
    const result = assembleEnvironment({
      rootDir: dir,
      nodeEnv: 'development',
      env,
      credentials: false,
    });
    assert.deepEqual(result, { status: 'absent' });
    assert.equal(env.FROM_CREDENTIALS, undefined);
  });
});
