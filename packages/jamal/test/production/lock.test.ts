/**
 * Tests for the remote deploy lock: acquire/release argv, contention, status,
 * and validation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireLock,
  forceReleaseLock,
  lockStatus,
  LockContentionError,
  LockError,
  type LockHandle,
} from '../../src/production/lock.js';
import type { CommandResult } from '../../src/production/process-runner.js';
import { remoteCommandLine, type RemoteRunner } from '../../src/production/transport.js';

/**
 * Tests for the remote deploy lock. Everything runs against a recording fake
 * {@link RemoteRunner}, so no ssh command is ever spawned: assertions target the
 * exact remote argv, contention vs release behavior, idempotent release, and
 * the value-free errors for contention and invalid lock directories.
 */

interface RecordedCall {
  server: string;
  remoteArgv: string[];
}

function makeRemote(script: (server: string, remoteArgv: string[]) => CommandResult): {
  remote: RemoteRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const remote: RemoteRunner = {
    async run(server, remoteArgv) {
      calls.push({ server, remoteArgv: [...remoteArgv] });
      return script(server, [...remoteArgv]);
    },
  };
  return { remote, calls };
}

const ok: CommandResult = { exitCode: 0, stdout: '', stderr: '' };

/**
 * A remote runner that executes the command line in a real local `sh`, in a
 * scratch directory standing in for the ssh user's home, exactly as the
 * server's login shell would receive it from ssh.
 */
function localShellRemote(home: string): RemoteRunner {
  return {
    async run(_server, remoteArgv, options) {
      const stdin = typeof options === 'string' ? options : options?.stdin;
      const result = spawnSync('sh', ['-c', remoteCommandLine(remoteArgv)], {
        cwd: home,
        input: stdin ?? '',
        encoding: 'utf8',
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

describe('acquireLock/release: through a real shell', () => {
  it('creates the lock with its parent and an owner line, then removes it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jamal-lock-'));
    const remote = localShellRemote(home);
    const lockDir = '.jamal/locks/my-app.deploy.lock';

    const handle = await acquireLock(remote, { server: 's', lockDir, owner: 'ann@box since t' });
    assert.ok(existsSync(join(home, lockDir)));
    assert.equal(readFileSync(join(home, lockDir, 'owner'), 'utf8'), 'ann@box since t\n');
    assert.deepEqual(await lockStatus(remote, { server: 's', lockDir }), {
      held: true,
      owner: 'ann@box since t',
    });

    await handle.release();
    assert.ok(!existsSync(join(home, lockDir)));
    assert.deepEqual(await lockStatus(remote, { server: 's', lockDir }), { held: false });
  });

  it('reports contention when the lock already exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jamal-lock-'));
    const remote = localShellRemote(home);
    await acquireLock(remote, { server: 's', lockDir: 'locks/x.lock' });

    await assert.rejects(
      () => acquireLock(remote, { server: 's', lockDir: 'locks/x.lock' }),
      (error: unknown) => error instanceof LockContentionError,
    );
  });

  it('force-releases a lock a killed deploy left behind, and tolerates no lock', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jamal-lock-'));
    const remote = localShellRemote(home);
    await acquireLock(remote, { server: 's', lockDir: 'locks/x.lock' });

    await forceReleaseLock(remote, { server: 's', lockDir: 'locks/x.lock' });
    assert.ok(!existsSync(join(home, 'locks/x.lock')));
    await forceReleaseLock(remote, { server: 's', lockDir: 'locks/x.lock' });
  });

  it('a released-by-force holder never removes the lock a later deploy took', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jamal-lock-'));
    const remote = localShellRemote(home);
    const lockDir = 'locks/x.lock';
    const first = await acquireLock(remote, { server: 's', lockDir, owner: 'first' });
    assert.match(readFileSync(join(home, lockDir, 'token'), 'utf8'), /^[0-9a-f]{32}\n$/);

    await forceReleaseLock(remote, { server: 's', lockDir });
    const second = await acquireLock(remote, { server: 's', lockDir, owner: 'second' });

    await assert.rejects(
      () => first.release(),
      (error: unknown) => {
        assert.ok(error instanceof LockError);
        assert.equal(error.code, 'not_owner');
        assert.ok(!error.message.includes(lockDir), 'lock directory must not leak');
        return true;
      },
    );
    assert.deepEqual(await lockStatus(remote, { server: 's', lockDir }), {
      held: true,
      owner: 'second',
    });

    await second.release();
    assert.ok(!existsSync(join(home, lockDir)));
  });

  it('a holder whose lock was force-released and not retaken releases quietly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jamal-lock-'));
    const remote = localShellRemote(home);
    const handle = await acquireLock(remote, { server: 's', lockDir: 'locks/x.lock' });

    await forceReleaseLock(remote, { server: 's', lockDir: 'locks/x.lock' });
    await handle.release();
    assert.ok(!existsSync(join(home, 'locks/x.lock')));
  });

  it('release is idempotent: a second release runs nothing', async () => {
    const { remote, calls } = makeRemote(() => ok);

    const handle = await acquireLock(remote, { server: 's', lockDir: '/lock' });
    await handle.release();
    await handle.release();

    assert.equal(calls.length, 2);
  });
});

describe('acquireLock: failure classes', () => {
  it('raises a value-free LockContentionError on exit 1', async () => {
    const { remote } = makeRemote(() => ({ exitCode: 1, stdout: '', stderr: 'exists' }));

    await assert.rejects(
      () => acquireLock(remote, { server: '1.2.3.4', lockDir: '/var/lock/jamal' }),
      (error: unknown) => {
        assert.ok(error instanceof LockContentionError);
        assert.match(error.message, /already held/);
        assert.match(error.message, /jamal lock release/);
        assert.ok(!error.message.includes('1.2.3.4'), 'server must not leak');
        assert.ok(!error.message.includes('/var/lock'), 'lock directory must not leak');
        return true;
      },
    );
  });

  it('reports an ssh failure (exit 255) as unreachable, not as contention', async () => {
    const { remote } = makeRemote(() => ({ exitCode: 255, stdout: '', stderr: 'denied' }));

    await assert.rejects(
      () => acquireLock(remote, { server: 's', lockDir: '/lock' }),
      (error: unknown) => {
        assert.ok(error instanceof LockError);
        assert.ok(!(error instanceof LockContentionError));
        assert.equal(error.code, 'unreachable');
        return true;
      },
    );
  });

  it('reports any other failure as io_failed', async () => {
    const { remote } = makeRemote(() => ({ exitCode: 3, stdout: '', stderr: '' }));

    await assert.rejects(
      () => acquireLock(remote, { server: 's', lockDir: '/lock' }),
      (error: unknown) => error instanceof LockError && error.code === 'io_failed',
    );
  });

  it('reports a status the script did not produce as io_failed, never as not held', async () => {
    for (const exitCode of [3, 126, 127]) {
      const { remote } = makeRemote(() => ({ exitCode, stdout: '', stderr: 'denied' }));
      await assert.rejects(
        () => lockStatus(remote, { server: 's', lockDir: '/lock' }),
        (error: unknown) => error instanceof LockError && error.code === 'io_failed',
      );
    }
  });
});

describe('lock validation and release failures', () => {
  it('rejects an empty or unsafe lock directory before any ssh call, value-free', async () => {
    for (const bad of ['', '-f', 'has space', 'tab\tx', 'ctrl\u0001']) {
      const { remote, calls } = makeRemote(() => ok);
      await assert.rejects(
        () => acquireLock(remote, { server: '1.2.3.4', lockDir: bad }),
        (error: unknown) => {
          assert.ok(error instanceof LockError);
          assert.ok(!(error instanceof LockContentionError));
          if (bad.length > 0) {
            assert.ok(!error.message.includes(bad), `lockDir ${JSON.stringify(bad)} must not leak`);
          }
          return true;
        },
      );
      assert.equal(calls.length, 0, 'no ssh command may run for an invalid lock directory');
    }
  });

  it('release raises a value-free LockError when rmdir exits non-zero', async () => {
    let calls = 0;
    const { remote } = makeRemote(() => {
      calls += 1;
      return calls === 1 ? ok : { exitCode: 1, stdout: '', stderr: '' };
    });

    const handle: LockHandle = await acquireLock(remote, { server: 's', lockDir: '/lock' });
    await assert.rejects(
      () => handle.release(),
      (error: unknown) => {
        assert.ok(error instanceof LockError);
        assert.equal(error.message, 'the deploy lock could not be released');
        return true;
      },
    );
  });
});
