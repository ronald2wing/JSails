/**
 * Tests for the `jamal lock status|release` verbs over an injected remote
 * runner: the remote argv, the owner report, dry-run, and value-free failures.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runJamalCommand, type JamalDeps } from '../src/command.js';
import { normalizeJamalConfig } from '../src/config/index.js';
import { lockReleaseArgv, lockStatusArgv } from '../src/production/lock.js';
import type { CommandResult } from '../src/production/process-runner.js';

const LOCK_DIR = '.jamal/apps/myapp/lock';

function makeDeps(result: CommandResult = { exitCode: 0, stdout: '', stderr: '' }): {
  deps: JamalDeps;
  out: string[];
  err: string[];
  calls: { server: string; remoteArgv: string[] }[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { server: string; remoteArgv: string[] }[] = [];
  const deps: JamalDeps = {
    loadJamalConfig: async () =>
      normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp',
        production: { server: '1.2.3.4' },
      }),
    remoteRunner: {
      async run(server, remoteArgv) {
        calls.push({ server, remoteArgv: [...remoteArgv] });
        return result;
      },
    },
    cwd: '/project',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { deps, out, err, calls };
}

/**
 * `jamal lock` is a server-facing verb, so Windows refuses it with
 * `unsupported_platform` (`cli/platform-guard.ts`;
 * `core/test/cli/platform-guard.test.ts` proves the refusal): the tests of
 * what it does run on POSIX only.
 */
const serverVerb = {
  skip: process.platform === 'win32' && 'jamal lock is a server-facing verb, which Windows refuses',
};

describe('jamal lock status', serverVerb, () => {
  it('reports the recorded owner of a held lock', async () => {
    const { deps, out, calls } = makeDeps({
      exitCode: 0,
      stdout: '{"seq":12,"who":"ana","host":"laptop","since":"2026-01-01T00:00:00.000Z"}\n',
      stderr: '',
    });
    const code = await runJamalCommand(['lock', 'status'], deps);
    assert.equal(code, 0);
    assert.deepEqual(calls, [{ server: '1.2.3.4', remoteArgv: [...lockStatusArgv(LOCK_DIR)] }]);
    assert.deepEqual(out, [
      'the deploy lock is held by ana@laptop since 2026-01-01T00:00:00.000Z (seq 12)',
    ]);
  });

  it('names the lock of a destination by its app directory', async () => {
    const { deps, calls } = makeDeps({ exitCode: 1, stdout: '', stderr: '' });
    deps.loadJamalConfig = async () =>
      normalizeJamalConfig({
        service: 'myapp',
        image: 'ghcr.io/acme/myapp',
        production: { server: '1.2.3.4', destination: 'staging' },
      });
    assert.equal(await runJamalCommand(['lock', 'status'], deps), 0);
    assert.deepEqual(calls[0]?.remoteArgv, [...lockStatusArgv('.jamal/apps/myapp.staging/lock')]);
  });

  it('reports a held lock whose owner it cannot read', async () => {
    const { deps, out } = makeDeps({ exitCode: 0, stdout: 'garbage\n', stderr: '' });
    assert.equal(await runJamalCommand(['lock', 'status'], deps), 0);
    assert.equal(out.length, 1);
    assert.match(out[0] ?? '', /^the deploy lock is held/);
  });

  it('reports a free lock', async () => {
    const { deps, out } = makeDeps({ exitCode: 1, stdout: '', stderr: '' });
    assert.equal(await runJamalCommand(['lock', 'status'], deps), 0);
    assert.deepEqual(out, ['the deploy lock is not held']);
  });

  it('fails value-free when the server is unreachable', async () => {
    const { deps, err } = makeDeps({ exitCode: 255, stdout: '', stderr: 'host 1.2.3.4' });
    assert.equal(await runJamalCommand(['lock', 'status'], deps), 1);
    assert.match(err.join('\n'), /could not be reached/);
    assert.ok(!err.join('\n').includes('1.2.3.4'));
  });
});

describe('jamal lock release', serverVerb, () => {
  it('removes the lock directory', async () => {
    const { deps, out, calls } = makeDeps();
    assert.equal(await runJamalCommand(['lock', 'release'], deps), 0);
    assert.deepEqual(calls[0]?.remoteArgv, [...lockReleaseArgv(LOCK_DIR)]);
    assert.deepEqual(out, ['the deploy lock is released']);
  });

  it('--dry-run prints the ssh command and runs nothing', async () => {
    const { deps, out, calls } = makeDeps();
    assert.equal(await runJamalCommand(['lock', 'release', '--dry-run'], deps), 0);
    assert.equal(calls.length, 0);
    assert.match(out.join('\n'), /\[dry-run\] ssh 1\.2\.3\.4 'sh -c /);
  });

  it('rejects a missing or unknown verb as a usage error', async () => {
    assert.equal(await runJamalCommand(['lock'], makeDeps().deps), 2);
    assert.equal(await runJamalCommand(['lock', 'steal'], makeDeps().deps), 2);
  });
});
