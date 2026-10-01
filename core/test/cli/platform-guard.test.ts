/**
 * Tests for the platform scope (`cli/platform-guard.ts`): on Windows `jsails
 * serve` runs only development and test and refuses with a value-free
 * `unsupported_platform` error. Other platforms are never refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertServeSupported, UnsupportedPlatformError } from '../../src/cli/platform-guard.js';
import { formatAppError, runAppCommand, type AppDeps } from '../../src/cli/commands/app.js';

function isUnsupportedPlatform(error: unknown): boolean {
  return error instanceof UnsupportedPlatformError && error.code === 'unsupported_platform';
}

describe('assertServeSupported', () => {
  it('serves exactly NODE_ENV=development and NODE_ENV=test on Windows', () => {
    for (const nodeEnv of ['development', 'test']) {
      assert.doesNotThrow(() => assertServeSupported('win32', nodeEnv));
    }
  });

  it('refuses an unset or empty NODE_ENV on Windows, which the runtime serves as production', () => {
    for (const nodeEnv of [undefined, '']) {
      assert.throws(
        () => assertServeSupported('win32', nodeEnv),
        (error: unknown) => {
          assert.ok(isUnsupportedPlatform(error));
          assert.match(
            (error as UnsupportedPlatformError).suggestion ?? '',
            /NODE_ENV=development/,
          );
          return true;
        },
      );
    }
  });

  it('refuses every other environment on Windows, value-free', () => {
    for (const nodeEnv of ['production', 'staging', 'not a name', 'Development', ' test']) {
      assert.throws(
        () => assertServeSupported('win32', nodeEnv),
        (error: unknown) => {
          assert.ok(isUnsupportedPlatform(error));
          assert.doesNotMatch((error as Error).message, /staging|not a name/);
          return true;
        },
      );
    }
  });

  it('never refuses on Linux or macOS', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      assert.doesNotThrow(() => assertServeSupported(platform, 'production'));
    }
  });
});

describe('jsails serve on a faked win32', () => {
  const deps = (nodeEnv: string | undefined, loaded: string[]): AppDeps => ({
    platform: 'win32',
    nodeEnv,
    loadConfig: (path) => {
      loaded.push(path);
      return Promise.reject(new Error('config reached'));
    },
    createApplication: () => Promise.reject(new Error('unreachable')),
  });

  it('exits with unsupported_platform in production before loading the config', async () => {
    const loaded: string[] = [];
    const error: unknown = await runAppCommand(
      'serve',
      'jsails.app.js',
      deps('production', loaded),
    ).then(
      () => assert.fail('serve should be refused'),
      (rejection: unknown) => rejection,
    );
    assert.ok(isUnsupportedPlatform(error));
    assert.match(
      await formatAppError(error),
      /only the development and test environments on Windows/,
    );
    assert.deepEqual(loaded, []);
  });

  it('exits with unsupported_platform for the plain production command (NODE_ENV unset)', async () => {
    const loaded: string[] = [];
    await assert.rejects(
      runAppCommand('serve', 'jsails.app.js', deps(undefined, loaded)),
      isUnsupportedPlatform,
    );
    assert.deepEqual(loaded, []);
  });

  it('goes on to load the config in development', async () => {
    const loaded: string[] = [];
    await assert.rejects(
      runAppCommand('serve', 'jsails.app.js', deps('development', loaded)),
      /config reached/,
    );
    assert.deepEqual(loaded, ['jsails.app.js']);
  });

  it('does not guard build', async () => {
    const loaded: string[] = [];
    await assert.rejects(
      runAppCommand('build', 'jsails.app.js', deps('production', loaded)),
      /config reached/,
    );
    assert.deepEqual(loaded, ['jsails.app.js']);
  });
});
