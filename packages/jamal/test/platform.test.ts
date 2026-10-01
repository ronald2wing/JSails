/**
 * Tests for jamal's platform scope (`platform.ts`): on Windows the
 * local-services verbs run and every server-facing verb refuses with a
 * value-free `unsupported_platform` error. Other platforms are never refused.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../src/command.js';
import { assertVerbSupported, UnsupportedPlatformError } from '../src/platform.js';

const cwd = mkdtempSync(join(tmpdir(), 'jamal-platform-'));
after(() => rmSync(cwd, { recursive: true, force: true }));

function isUnsupportedPlatform(error: unknown): boolean {
  return error instanceof UnsupportedPlatformError && error.code === 'unsupported_platform';
}

describe('assertVerbSupported', () => {
  it('runs the local-services verbs on Windows', () => {
    for (const verb of ['up', 'down', 'logs', 'ps', 'exec', 'npm', 'shell', undefined]) {
      assert.doesNotThrow(() => assertVerbSupported(verb, 'win32'));
    }
  });

  it('refuses every server-facing verb on Windows', () => {
    for (const verb of [
      'deploy',
      'rollback',
      'status',
      'lock',
      'prune',
      'secrets',
      'accessory',
      'app',
      'domain',
      'cache-proxy',
    ]) {
      assert.throws(() => assertVerbSupported(verb, 'win32'), isUnsupportedPlatform);
    }
  });

  it('never refuses on Linux or macOS', () => {
    assert.doesNotThrow(() => assertVerbSupported('deploy', 'linux'));
    assert.doesNotThrow(() => assertVerbSupported('deploy', 'darwin'));
  });
});

describe('jamal on a faked win32', () => {
  const run = async (args: string[]): Promise<{ status: number; err: string[] }> => {
    const err: string[] = [];
    const deps: JamalDeps = {
      cwd,
      platform: 'win32',
      stdout: () => undefined,
      stderr: (text) => err.push(text),
    };
    return { status: await runJamalCommand(args, deps), err };
  };
  const refusal = /this jamal command does not run on Windows/;

  it('refuses deploy, rollback, lock, prune and the other server verbs with exit 1', async () => {
    for (const args of [
      ['deploy'],
      ['deploy', '--dry-run'],
      ['--allow-dirty', 'deploy'],
      ['--destination', 'up', 'deploy'],
      ['--destination', 'logs', 'rollback'],
      ['--secrets-path', 'ps', 'status'],
      ['--keep', 'down', 'prune'],
      ['rollback'],
      ['lock', 'status'],
      ['prune'],
      ['accessory', 'boot', 'db'],
    ]) {
      const { status, err } = await run(args);
      assert.equal(status, 1, args.join(' '));
      assert.match(err.join('\n'), refusal);
    }
  });

  it('lets the local verbs through to their own handling', async () => {
    for (const args of [['up'], ['down'], ['logs', 'app'], ['ps']]) {
      const { err } = await run(args);
      assert.doesNotMatch(err.join('\n'), refusal, args.join(' '));
    }
  });

  it('judges the verb dispatch runs, not a flag value that spells one', async () => {
    for (const args of [
      ['--keep', 'deploy', 'up'],
      ['--destination', 'rollback', 'logs'],
    ]) {
      const { err } = await run(args);
      assert.doesNotMatch(err.join('\n'), refusal, args.join(' '));
    }
  });

  it('does not take a --help after -- as a help request', async () => {
    const { status, err } = await run(['accessory', 'exec', 'db', '--', '--help']);
    assert.equal(status, 1);
    assert.match(err.join('\n'), refusal);
  });

  it('prints help for a refused verb', async () => {
    const { status, err } = await run(['deploy', '--help']);
    assert.equal(status, 0);
    assert.deepEqual(err, []);
  });
});
