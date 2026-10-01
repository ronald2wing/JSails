/**
 * Tests for the local build and push steps: argv shapes and failure
 * propagation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertDockerfile,
  BuildError,
  DEFAULT_BUILD_CONTEXT,
  runBuild,
  runPush,
} from '../../src/production/build.js';
import type { CommandResult, ProcessRunner } from '../../src/production/process-runner.js';

/**
 * Tests for the local build/push steps. Both functions take an injected
 * {@link ProcessRunner}, so these run against a recording fake and never spawn
 * docker: assertions target the exact argv, the default build context, and the
 * value-free error produced for a non-zero exit.
 */

interface Recorder {
  calls: string[][];
  run: ProcessRunner;
}

function makeRunner(
  result: CommandResult | Error = { exitCode: 0, stdout: '', stderr: '' },
): Recorder {
  const calls: string[][] = [];
  const run: ProcessRunner = async (argv) => {
    calls.push([...argv]);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  return { calls, run };
}

describe('runBuild/runPush: argv shapes', () => {
  it('builds the fixed docker buildx argv with an explicit context', async () => {
    const r = makeRunner();

    await runBuild('ghcr.io/acme/myapp:1.0.0', '.', r.run);

    assert.deepEqual(r.calls[0], [
      'docker',
      'buildx',
      'build',
      '-t',
      'ghcr.io/acme/myapp:1.0.0',
      '.',
    ]);
  });

  it('defaults the build context to "." when omitted', async () => {
    const r = makeRunner();

    await runBuild('ghcr.io/acme/myapp:1.0.0', r.run);

    assert.deepEqual(r.calls[0], [
      'docker',
      'buildx',
      'build',
      '-t',
      'ghcr.io/acme/myapp:1.0.0',
      '.',
    ]);
  });

  it('exposes the default context constant as "."', () => {
    assert.equal(DEFAULT_BUILD_CONTEXT, '.');
  });

  it('pushes the fixed docker push argv', async () => {
    const r = makeRunner();

    await runPush('ghcr.io/acme/myapp:1.0.0', r.run);

    assert.deepEqual(r.calls[0], ['docker', 'push', 'ghcr.io/acme/myapp:1.0.0']);
  });
});

describe('runBuild/runPush: non-zero exit propagation', () => {
  it('throws a value-free BuildError naming only build and the exit code', async () => {
    const r = makeRunner({
      exitCode: 5,
      stdout: 'build output',
      stderr: 'denied: auth failed',
    });

    await assert.rejects(
      () => runBuild('ghcr.io/acme/myapp:1.0.0', '.', r.run),
      (error: unknown) => {
        assert.ok(error instanceof BuildError);
        assert.equal(error.message, 'docker buildx build exited with code 5');
        assert.ok(!error.message.includes('ghcr.io'), 'image reference must not leak');
        return true;
      },
    );
  });

  it('throws a value-free BuildError naming only push and the exit code', async () => {
    const r = makeRunner({ exitCode: 1, stdout: '', stderr: 'denied' });

    await assert.rejects(
      () => runPush('ghcr.io/acme/myapp:1.0.0', r.run),
      (error: unknown) => {
        assert.ok(error instanceof BuildError);
        assert.equal(error.message, 'docker push exited with code 1');
        return true;
      },
    );
  });

  it('resolves with the CommandResult on a zero exit', async () => {
    const result: CommandResult = { exitCode: 0, stdout: 'pushed', stderr: '' };
    const r = makeRunner(result);

    assert.equal(await runPush('img:1.0.0', r.run), result);
  });
});

describe('runBuild/runPush: runner failure propagation', () => {
  it('propagates a runner rejection (e.g. a timeout) unchanged', async () => {
    const r = makeRunner(new Error('the command timed out after 1000 ms'));

    await assert.rejects(
      () => runPush('img:1.0.0', r.run),
      (error: unknown) =>
        error instanceof Error && error.message === 'the command timed out after 1000 ms',
    );
  });
});

describe('assertDockerfile', () => {
  it('accepts a context holding a Dockerfile or a lowercase dockerfile', () => {
    for (const name of ['Dockerfile', 'dockerfile']) {
      const dir = mkdtempSync(join(tmpdir(), 'jamal-build-'));
      writeFileSync(join(dir, name), 'FROM scratch\n');
      assert.doesNotThrow(() => assertDockerfile(dir));
    }
  });

  it('refuses a context without one, or with a directory of that name, value-free', () => {
    const empty = mkdtempSync(join(tmpdir(), 'jamal-build-'));
    const withDirectory = mkdtempSync(join(tmpdir(), 'jamal-build-'));
    mkdirSync(join(withDirectory, 'Dockerfile'));
    for (const dir of [empty, withDirectory]) {
      assert.throws(
        () => assertDockerfile(dir),
        (error: unknown) => {
          assert.ok(error instanceof BuildError);
          assert.equal(error.code, 'missing_dockerfile');
          assert.match(error.message, /add a Dockerfile/);
          assert.ok(!error.message.includes(dir), 'the path must not leak');
          return true;
        },
      );
    }
  });
});
