import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_JAMAL_SECRETS_PATH,
  JamalSecretsError,
  hasSecret,
  loadJamalSecrets,
  requireSecret,
  secretsFilenames,
} from '../../src/jamal/secrets.js';

/**
 * Tests for the Jamal secrets loader. Every fixture is a real file under the
 * project tree (so it inherits `"type": "module"`), and every command
 * substitution is injected — no shell is ever spawned.
 */

const fixturesRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'jamal-secrets-fixture-'),
);

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

let counter = 0;

/** Create a fixture directory and write the given files into it. */
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

/** A command runner that records what it was asked to run. */
function recordingRunner(output: string): {
  run: (command: string) => string;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    run: (command) => {
      calls.push(command);
      return output;
    },
  };
}

describe('secretsFilenames', () => {
  it('reads the common file then the plain file when no destination is set', () => {
    assert.deepEqual(secretsFilenames('.jamal/secrets'), [
      '.jamal/secrets-common',
      '.jamal/secrets',
    ]);
  });

  it('reads the common file then the destination file, skipping the plain one', () => {
    assert.deepEqual(secretsFilenames('.jamal/secrets', 'staging'), [
      '.jamal/secrets-common',
      '.jamal/secrets.staging',
    ]);
  });
});

describe('loadJamalSecrets', () => {
  it('defaults to .jamal/secrets', () => {
    assert.equal(DEFAULT_JAMAL_SECRETS_PATH, '.jamal/secrets');
  });

  it('treats a missing file as an empty set', () => {
    const dir = fixture({});
    const secrets = loadJamalSecrets({ rootDir: dir });
    assert.deepEqual(secrets.values, {});
    assert.deepEqual(secrets.files, []);
  });

  it('merges the common file first and lets the plain file win', () => {
    const dir = fixture({
      '.jamal/secrets-common': 'SHARED=common\nONLY_COMMON=yes\n',
      '.jamal/secrets': 'SHARED=plain\nONLY_PLAIN=yes\n',
    });
    const secrets = loadJamalSecrets({ rootDir: dir });
    assert.equal(secrets.values.SHARED, 'plain');
    assert.equal(secrets.values.ONLY_COMMON, 'yes');
    assert.equal(secrets.values.ONLY_PLAIN, 'yes');
    assert.equal(secrets.files.length, 2);
  });

  it('selects the destination file and ignores the plain one', () => {
    const dir = fixture({
      '.jamal/secrets-common': 'SHARED=common\n',
      '.jamal/secrets': 'PLAIN=plain\n',
      '.jamal/secrets.staging': 'STAGING=yes\n',
    });
    const secrets = loadJamalSecrets({ rootDir: dir, destination: 'staging' });
    assert.equal(secrets.values.STAGING, 'yes');
    assert.equal(secrets.values.SHARED, 'common');
    assert.equal(secrets.values.PLAIN, undefined);
  });

  it('honors a custom secrets path', () => {
    const dir = fixture({ 'config/secrets': 'A=1\n' });
    const secrets = loadJamalSecrets({ rootDir: dir, secretsPath: 'config/secrets' });
    assert.equal(secrets.values.A, '1');
  });

  it('freezes the resolved values', () => {
    const dir = fixture({ '.jamal/secrets': 'A=1\n' });
    const secrets = loadJamalSecrets({ rootDir: dir });
    assert.equal(Object.isFrozen(secrets.values), true);
  });
});

describe('substitution', () => {
  it('expands $NAME from a value already loaded in the same file', () => {
    const dir = fixture({ '.jamal/secrets': 'HOST=db\nURL=postgres://$HOST/app\n' });
    const secrets = loadJamalSecrets({ rootDir: dir });
    assert.equal(secrets.values.URL, 'postgres://db/app');
  });

  it('expands ${NAME} braces', () => {
    const dir = fixture({ '.jamal/secrets': 'HOST=db\nURL=postgres://${HOST}/app\n' });
    const secrets = loadJamalSecrets({ rootDir: dir });
    assert.equal(secrets.values.URL, 'postgres://db/app');
  });

  it('falls back to the injected environment', () => {
    const dir = fixture({ '.jamal/secrets': 'TOKEN=$FROM_ENV\n' });
    const secrets = loadJamalSecrets({ rootDir: dir, env: { FROM_ENV: 'env-value' } });
    assert.equal(secrets.values.TOKEN, 'env-value');
  });

  it('prefers a file value over the environment', () => {
    const dir = fixture({ '.jamal/secrets': 'NAME=file\nCOPY=$NAME\n' });
    const secrets = loadJamalSecrets({ rootDir: dir, env: { NAME: 'env' } });
    assert.equal(secrets.values.COPY, 'file');
  });

  it('replaces an unknown name with an empty string', () => {
    const dir = fixture({ '.jamal/secrets': 'A=$NOPE\n' });
    const secrets = loadJamalSecrets({ rootDir: dir, env: {} });
    assert.equal(secrets.values.A, '');
  });

  it('runs a command substitution and strips trailing newlines', () => {
    const dir = fixture({ '.jamal/secrets': 'TOKEN=$(openssl rand -hex 8)\n' });
    const runner = recordingRunner('abc123\n');
    const secrets = loadJamalSecrets({ rootDir: dir, runCommand: runner.run });
    assert.equal(secrets.values.TOKEN, 'abc123');
    assert.deepEqual(runner.calls, ['openssl rand -hex 8']);
  });

  it('supports balanced parentheses inside a command', () => {
    const dir = fixture({ '.jamal/secrets': 'V=$(echo $(echo hi))\n' });
    const runner = recordingRunner('hi');
    const secrets = loadJamalSecrets({ rootDir: dir, runCommand: runner.run });
    assert.equal(secrets.values.V, 'hi');
    assert.deepEqual(runner.calls, ['echo $(echo hi)']);
  });

  it('leaves an escaped command literal and drops the backslash', () => {
    const dir = fixture({ '.jamal/secrets': 'V=\\$(echo no)\n' });
    const runner = recordingRunner('should-not-run');
    const secrets = loadJamalSecrets({ rootDir: dir, runCommand: runner.run });
    assert.equal(secrets.values.V, '$(echo no)');
    assert.deepEqual(runner.calls, []);
  });

  it('leaves an escaped variable literal and drops the backslash', () => {
    const dir = fixture({ '.jamal/secrets': 'V=\\$HOME\n' });
    const secrets = loadJamalSecrets({ rootDir: dir, env: { HOME: '/root' } });
    assert.equal(secrets.values.V, '$HOME');
  });

  it('expands a variable inside a command before running it', () => {
    const dir = fixture({ '.jamal/secrets': 'V=$(echo $HOST)\n' });
    const runner = recordingRunner('ok');
    const secrets = loadJamalSecrets({
      rootDir: dir,
      runCommand: runner.run,
      env: { HOST: 'db' },
    });
    assert.equal(secrets.values.V, 'ok');
    assert.deepEqual(runner.calls, ['echo db']);
  });

  it('prefers a file value over the environment when expanding a command', () => {
    const dir = fixture({ '.jamal/secrets': 'HOST=file\nV=$(echo $HOST)\n' });
    const runner = recordingRunner('ok');
    loadJamalSecrets({
      rootDir: dir,
      runCommand: runner.run,
      env: { HOST: 'env' },
    });
    assert.deepEqual(runner.calls, ['echo file']);
  });

  it('rescans a command result for variable substitution', () => {
    const dir = fixture({ '.jamal/secrets': 'V=$(echo x)\n' });
    const runner = recordingRunner('$HOME');
    const secrets = loadJamalSecrets({
      rootDir: dir,
      runCommand: runner.run,
      env: { HOME: '/r' },
    });
    assert.equal(secrets.values.V, '/r');
  });

  it('inlines a jsails jamal secrets command instead of shelling out', () => {
    const dir = fixture({ '.jamal/secrets': 'TOKEN=$(jsails jamal secrets fetch DB)\nDB=x\n' });
    const runner = recordingRunner('should-not-run');
    const inline = (command: string): string =>
      command === 'jsails jamal secrets fetch DB' ? 'inline-value' : 'unexpected';
    const secrets = loadJamalSecrets({
      rootDir: dir,
      runCommand: runner.run,
      inlineSecrets: inline,
    });
    assert.equal(secrets.values.TOKEN, 'inline-value');
    assert.deepEqual(runner.calls, []);
  });

  it('shells out when no inline seam is provided', () => {
    const dir = fixture({ '.jamal/secrets': 'TOKEN=$(jsails jamal secrets fetch DB)\n' });
    const runner = recordingRunner('shelled-out');
    const secrets = loadJamalSecrets({ rootDir: dir, runCommand: runner.run });
    assert.equal(secrets.values.TOKEN, 'shelled-out');
    assert.deepEqual(runner.calls, ['jsails jamal secrets fetch DB']);
  });

  it('does not resolve a reference to a key defined later in the file', () => {
    const dir = fixture({ '.jamal/secrets': 'URL=$HOST\nHOST=db\n' });
    const secrets = loadJamalSecrets({ rootDir: dir, env: {} });
    assert.equal(secrets.values.URL, '');
    assert.equal(secrets.values.HOST, 'db');
  });

  it('resolves a cross-file reference from the environment, not the other file', () => {
    const dir = fixture({
      '.jamal/secrets-common': 'HOST=db\n',
      '.jamal/secrets': 'URL=$HOST\n',
    });
    const shared = loadJamalSecrets({ rootDir: dir, env: {} });
    assert.equal(shared.values.URL, '');
    assert.equal(shared.values.HOST, 'db');

    const withEnv = loadJamalSecrets({ rootDir: dir, env: { HOST: 'from-env' } });
    assert.equal(withEnv.values.URL, 'from-env');
  });
});

describe('validation', () => {
  it('rejects an absolute secrets path', () => {
    const dir = fixture({});
    assert.throws(
      () => loadJamalSecrets({ rootDir: dir, secretsPath: '/etc/secrets' }),
      (error: unknown) => error instanceof JamalSecretsError && error.code === 'invalid_path',
    );
  });

  it('rejects a secrets path that escapes the root', () => {
    const dir = fixture({});
    assert.throws(
      () => loadJamalSecrets({ rootDir: dir, secretsPath: '../secrets' }),
      (error: unknown) => error instanceof JamalSecretsError && error.code === 'invalid_path',
    );
  });

  it('rejects an unsafe destination', () => {
    const dir = fixture({});
    assert.throws(
      () => loadJamalSecrets({ rootDir: dir, destination: '../evil' }),
      (error: unknown) =>
        error instanceof JamalSecretsError && error.code === 'invalid_destination',
    );
  });

  it('rejects a secret name that is not an identifier', () => {
    const dir = fixture({ '.jamal/secrets': 'not-a-name=1\n' });
    assert.throws(
      () => loadJamalSecrets({ rootDir: dir }),
      (error: unknown) => error instanceof JamalSecretsError && error.code === 'invalid_key',
    );
  });

  it('rejects a reserved secret name', () => {
    const dir = fixture({ '.jamal/secrets': '__proto__=1\n' });
    assert.throws(
      () => loadJamalSecrets({ rootDir: dir }),
      (error: unknown) => error instanceof JamalSecretsError && error.code === 'invalid_key',
    );
  });

  it('reports a failed command substitution without echoing the command', () => {
    const dir = fixture({ '.jamal/secrets': 'V=$(false)\n' });
    assert.throws(
      () =>
        loadJamalSecrets({
          rootDir: dir,
          runCommand: () => {
            throw new JamalSecretsError('command_failed', 'a secrets command substitution failed');
          },
        }),
      (error: unknown) =>
        error instanceof JamalSecretsError &&
        error.code === 'command_failed' &&
        !error.message.includes('false'),
    );
  });
});

describe('requireSecret / hasSecret', () => {
  it('returns a defined value', () => {
    const dir = fixture({ '.jamal/secrets': 'A=1\n' });
    const secrets = loadJamalSecrets({ rootDir: dir });
    assert.equal(requireSecret(secrets, 'A'), '1');
  });

  it('names the secret and the searched files when it is missing', () => {
    const dir = fixture({ '.jamal/secrets': 'A=1\n' });
    const secrets = loadJamalSecrets({ rootDir: dir });
    assert.throws(
      () => requireSecret(secrets, 'MISSING'),
      (error: unknown) =>
        error instanceof JamalSecretsError &&
        error.code === 'missing_secret' &&
        error.message.includes('MISSING') &&
        error.message.includes('.jamal/secrets'),
    );
  });

  it('reports when no secrets file was found at all', () => {
    const dir = fixture({});
    const secrets = loadJamalSecrets({ rootDir: dir });
    assert.throws(
      () => requireSecret(secrets, 'MISSING'),
      (error: unknown) =>
        error instanceof JamalSecretsError && error.message.includes('no secrets files were found'),
    );
  });

  it('treats an empty value as absent for hasSecret', () => {
    const dir = fixture({ '.jamal/secrets': 'EMPTY=\nSET=1\n' });
    const secrets = loadJamalSecrets({ rootDir: dir });
    assert.equal(hasSecret(secrets, 'EMPTY'), false);
    assert.equal(hasSecret(secrets, 'SET'), true);
    assert.equal(hasSecret(secrets, 'NOPE'), false);
  });
});
