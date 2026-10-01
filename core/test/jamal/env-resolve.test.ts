import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SecretRef, secret, type JamalConfig } from '../../src/jamal/config.js';
import { clearEnvFlags, resolveJamalEnv } from '../../src/jamal/env-resolve.js';
import { JamalSecretsError, type JamalSecrets } from '../../src/jamal/secrets.js';

/** Tests for the clear/secret split (Kamal's `Configuration::Env`). */

/** A minimal config carrying only the fields the resolver reads. */
function configWithEnv(env: JamalConfig['env']): JamalConfig {
  return {
    service: 'app',
    image: 'app',
    command: undefined,
    health: undefined,
    env,
    services: {},
    volumes: {},
    local: { ports: {}, build: false },
    production: undefined,
    logging: undefined,
    cacheProxy: undefined,
  };
}

/** A frozen secrets map. */
function secretsWith(values: Record<string, string>): JamalSecrets {
  return { values: Object.freeze(values), files: Object.freeze([]) };
}

describe('resolveJamalEnv', () => {
  it('sends a literal string to the clear channel', () => {
    const env = resolveJamalEnv(
      configWithEnv({ LOG_LEVEL: { value: 'info', alias: undefined, clear: false } }),
      secretsWith({}),
    );
    assert.deepEqual(env.clear, [{ name: 'LOG_LEVEL', value: 'info', secret: false }]);
    assert.deepEqual(env.secret, []);
    assert.equal(env.envFile, '\n');
  });

  it('sends a SecretRef to the secret channel and resolves its value', () => {
    const env = resolveJamalEnv(
      configWithEnv({
        DB_PASSWORD: { value: secret('DB_PASSWORD'), alias: undefined, clear: false },
      }),
      secretsWith({ DB_PASSWORD: 'hunter2' }),
    );
    assert.deepEqual(env.clear, []);
    assert.deepEqual(env.secret, [{ name: 'DB_PASSWORD', value: 'hunter2', secret: true }]);
    assert.equal(env.envFile, 'DB_PASSWORD=hunter2\n');
  });

  it('honors clear: true on a SecretRef, putting it on the command line', () => {
    const env = resolveJamalEnv(
      configWithEnv({ DB_HOST: { value: secret('DB_HOST'), alias: undefined, clear: true } }),
      secretsWith({ DB_HOST: 'db.internal' }),
    );
    assert.deepEqual(env.clear, [{ name: 'DB_HOST', value: 'db.internal', secret: false }]);
    assert.deepEqual(env.secret, []);
  });

  it('renames the container variable through alias', () => {
    const env = resolveJamalEnv(
      configWithEnv({
        DB_PASS: { value: secret('DB_PASS'), alias: 'DATABASE_PASSWORD', clear: false },
      }),
      secretsWith({ DB_PASS: 'pw' }),
    );
    assert.deepEqual(env.secret, [{ name: 'DATABASE_PASSWORD', value: 'pw', secret: true }]);
    assert.equal(env.envFile, 'DATABASE_PASSWORD=pw\n');
  });

  it('sorts both channels by name', () => {
    const env = resolveJamalEnv(
      configWithEnv({
        ZED: { value: 'z', alias: undefined, clear: false },
        ALPHA: { value: 'a', alias: undefined, clear: false },
        Z_SECRET: { value: secret('Z_SECRET'), alias: undefined, clear: false },
        A_SECRET: { value: secret('A_SECRET'), alias: undefined, clear: false },
      }),
      secretsWith({ Z_SECRET: 'z', A_SECRET: 'a' }),
    );
    assert.deepEqual(
      env.clear.map((entry) => entry.name),
      ['ALPHA', 'ZED'],
    );
    assert.deepEqual(
      env.secret.map((entry) => entry.name),
      ['A_SECRET', 'Z_SECRET'],
    );
    assert.equal(env.envFile, 'A_SECRET=a\nZ_SECRET=z\n');
  });

  it('throws a missing_secret error naming the secret, never a value', () => {
    assert.throws(
      () =>
        resolveJamalEnv(
          configWithEnv({ X: { value: secret('ABSENT'), alias: undefined, clear: false } }),
          secretsWith({}),
        ),
      (error: unknown) =>
        error instanceof JamalSecretsError &&
        error.code === 'missing_secret' &&
        error.message.includes('ABSENT'),
    );
  });

  it('does not resolve a clear: true SecretRef through the secrets map', () => {
    // A clear entry still needs its value, so a missing secret is still an error.
    assert.throws(
      () =>
        resolveJamalEnv(
          configWithEnv({ X: { value: secret('ABSENT'), alias: undefined, clear: true } }),
          secretsWith({}),
        ),
      (error: unknown) => error instanceof JamalSecretsError,
    );
  });
});

describe('clearEnvFlags', () => {
  it('flattens the clear channel into -e flags', () => {
    const env = resolveJamalEnv(
      configWithEnv({
        A: { value: '1', alias: undefined, clear: false },
        B: { value: '2', alias: undefined, clear: false },
      }),
      secretsWith({}),
    );
    assert.deepEqual(clearEnvFlags(env), ['-e', 'A=1', '-e', 'B=2']);
  });

  it('returns no flags when the clear channel is empty', () => {
    const env = resolveJamalEnv(
      configWithEnv({ S: { value: secret('S'), alias: undefined, clear: false } }),
      secretsWith({ S: 'v' }),
    );
    assert.deepEqual(clearEnvFlags(env), []);
  });
});

describe('SecretRef identity', () => {
  it('is branded by class, so a plain object is not a secret', () => {
    assert.equal(secret('X') instanceof SecretRef, true);
    assert.equal({ name: 'X' } instanceof SecretRef, false);
  });
});
