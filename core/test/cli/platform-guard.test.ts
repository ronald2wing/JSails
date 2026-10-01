/**
 * Tests for the platform scope (`cli/platform-guard.ts`): on Windows `jsails
 * serve` runs only development and test and refuses with a value-free
 * `unsupported_platform` error. Other platforms are never refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertServeSupported, PlatformErrors } from '../../src/cli/platform-guard.js';
import { buildCommand, reportAppFailure, servePreflight } from '../../src/cli/commands/app.js';
import { NON_INTERACTIVE_PROMPTER } from '../../src/cli/prompter.js';

function isUnsupportedPlatform(error: unknown): boolean {
  return PlatformErrors.is(error, 'unsupported_platform');
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
            (error as Error & { suggestion?: string }).suggestion ?? '',
            /JSAILS_ENV=development/,
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
  function invocation(
    nodeEnv: string | undefined,
    roles: readonly string[] = [],
  ): { readonly context: Parameters<typeof servePreflight>[0]; readonly usage: string[] } {
    const usage: string[] = [];
    const context: Parameters<typeof servePreflight>[0] = {
      name: 'serve',
      values: roles.length === 0 ? {} : { with: roles },
      positionals: [],
      cwd: process.cwd(),
      env: nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv },
      environment: nodeEnv,
      interactive: false,
      prompter: NON_INTERACTIVE_PROMPTER,
      stdout: () => undefined,
      stderr: () => undefined,
      usage: (message) => {
        usage.push(message);
        return 2;
      },
    };
    return { context, usage };
  }

  it('refuses production with unsupported_platform, before any config loads', async () => {
    const { context } = invocation('production');
    const error: unknown = (() => {
      try {
        servePreflight(context, 'win32');
      } catch (thrown) {
        return thrown;
      }
      return assert.fail('serve should be refused');
    })();
    assert.ok(isUnsupportedPlatform(error));
    const lines: string[] = [];
    await reportAppFailure(error, (line) => lines.push(line), { env: {} });
    assert.match(lines[0] ?? '', /only the development and test environments on Windows/);
  });

  it('refuses the plain production command (NODE_ENV unset)', () => {
    assert.throws(
      () => servePreflight(invocation(undefined).context, 'win32'),
      isUnsupportedPlatform,
    );
  });

  it('lets development through', () => {
    assert.equal(servePreflight(invocation('development').context, 'win32'), undefined);
  });

  it('reports a usage error ahead of the platform refusal', () => {
    const { context, usage } = invocation('production', ['web']);
    assert.equal(servePreflight(context, 'win32'), 2);
    assert.deepEqual(usage, ['--with takes worker, the one role serve can add']);
  });

  it('does not guard build, which has no preflight', () => {
    assert.equal(buildCommand.preflight, undefined);
  });
});
