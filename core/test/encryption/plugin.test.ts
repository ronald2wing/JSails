/**
 * Encryption plugin tests: the `definePlugin` contract (no options, keys from
 * declared environment variables), service wiring through the extension
 * runner, the inert-setup harness, and value-free failures. No connection,
 * database, or external service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from '../../src/extensions/index.js';
import { EncryptionError } from '../../src/encryption/errors.js';
import { encryptionPlugin, encryptionToken } from '../../src/encryption/plugin.js';
import type { Encrypter } from '../../src/encryption/encrypter-types.js';
import { ConfigErrors } from '../../src/plugins/contract/errors.js';
import { describePluginEnv } from '../../src/plugins/contract/env-variables.js';
import { testPlugin } from '../../src/testing/plugin-harness.js';

const KEY = 'k'.repeat(32);
const OLD_KEY = 'o'.repeat(32);

/** Assert `error` is `config.<code>` and that no `secret` substring appears anywhere in it. */
function assertValueFree(error: unknown, code: 'invalid_options' | 'invalid_env', secret: string) {
  assert.ok(ConfigErrors.is(error, code), `expected config.${code}, got ${String(error)}`);
  const rendered = [String(error), JSON.stringify(error.payload)].join('\n');
  assert.ok(!rendered.includes(secret), 'the error repeats an input value');
}

describe('encryptionPlugin', () => {
  it('is named encryption, takes no options and declares its key variables', () => {
    const instance = encryptionPlugin();
    assert.equal(instance.name, 'encryption');
    assert.deepEqual(instance.provides, [encryptionToken]);
    assert.deepEqual(describePluginEnv('encryption', encryptionPlugin.definition.env!), [
      { name: 'JSAILS_ENCRYPTION_KEY', kind: 'secret', required: true, generate: true },
      {
        name: 'JSAILS_ENCRYPTION_PREVIOUS_KEYS',
        kind: 'string',
        required: false,
        generate: false,
      },
    ]);
  });

  it('provides an encrypter that round-trips, inertly', async () => {
    const run = await testPlugin(encryptionPlugin(), { env: { JSAILS_ENCRYPTION_KEY: KEY } });
    try {
      assert.deepEqual(run.provided, [encryptionToken]);
      const encrypter: Encrypter = run.services.get(encryptionToken);
      assert.equal(encrypter.decrypt(encrypter.encrypt('plugin secret')), 'plugin secret');
    } finally {
      await run.close();
      await run.close();
    }
  });

  it('decrypts with a previous key', async () => {
    const old = await testPlugin(encryptionPlugin(), { env: { JSAILS_ENCRYPTION_KEY: OLD_KEY } });
    const rotated = await testPlugin(encryptionPlugin(), {
      env: { JSAILS_ENCRYPTION_KEY: KEY, JSAILS_ENCRYPTION_PREVIOUS_KEYS: ` , ${OLD_KEY}, ` },
    });
    try {
      const token = old.services.get(encryptionToken).encrypt('rotated');
      assert.equal(rotated.services.get(encryptionToken).decrypt(token), 'rotated');
    } finally {
      await old.close();
      await rotated.close();
    }
  });

  it('runs on the extension runner, ordered before a consumer that requires the token', async () => {
    let seen: string | undefined;
    const consumer = {
      name: 'consumer',
      requires: [encryptionToken],
      setup({ services }: { services: { get(token: typeof encryptionToken): Encrypter } }) {
        const encrypter = services.get(encryptionToken);
        seen = encrypter.decrypt(encrypter.encrypt('via requires'));
      },
    };
    const runtime = await runExtensions([consumer, encryptionPlugin()], {
      rootDir: import.meta.dirname,
      env: { JSAILS_ENCRYPTION_KEY: KEY },
    });
    await runtime.close();
    assert.equal(seen, 'via requires');
  });
});

describe('invalid configuration', () => {
  const options: readonly { readonly name: string; readonly input: unknown }[] = [
    { name: 'a key in the options', input: { key: 'sk_live_options_secret_value_123' } },
    { name: 'a non-object', input: 'sk_live_string_secret_value_1234' },
  ];
  for (const { name, input } of options) {
    it(`refuses ${name} with config.invalid_options before any setup`, () => {
      const factory = encryptionPlugin as unknown as (input: unknown) => unknown;
      assert.throws(
        () => factory(input),
        (error: unknown) => {
          assertValueFree(error, 'invalid_options', 'sk_live');
          return true;
        },
      );
    });
  }

  it('refuses a short key with config.invalid_env naming the variable only', async () => {
    await assert.rejects(
      testPlugin(encryptionPlugin(), { env: { JSAILS_ENCRYPTION_KEY: 'short-secret' } }),
      (error: unknown) => {
        assertValueFree(error, 'invalid_env', 'short-secret');
        assert.match(String(error), /JSAILS_ENCRYPTION_KEY/);
        return true;
      },
    );
  });

  it('refuses a missing key before any setup on the runner', async () => {
    await assert.rejects(
      runExtensions([encryptionPlugin()], { rootDir: import.meta.dirname, env: {} }),
      (error: unknown) => ConfigErrors.is(error, 'invalid_env'),
    );
  });

  it('fails setup with a value-free EncryptionError for a malformed previous key', async () => {
    await assert.rejects(
      testPlugin(encryptionPlugin(), {
        env: { JSAILS_ENCRYPTION_KEY: KEY, JSAILS_ENCRYPTION_PREVIOUS_KEYS: 'tiny-old-key' },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EncryptionError);
        assert.equal(error.code, 'invalid_key');
        assert.ok(!error.message.includes('tiny-old-key'));
        return true;
      },
    );
  });
});
