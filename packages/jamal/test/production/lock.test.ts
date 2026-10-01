/**
 * Tests for the remote deploy lock: acquisition with its sequence number and
 * owner document, contention, status, release by token and by force, the
 * fenced runner a holder sends every command through, and the value-free
 * failures. The shell cases run the real scripts in a local `sh` standing in
 * for the server's login shell.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  LockErrors,
  acquireLock,
  forceReleaseLock,
  formatLockOwner,
  lockStatus,
  parseLockOwner,
  type LockOwner,
} from '../../src/production/lock.js';
import type { CommandResult } from '../../src/production/process-runner.js';
import { writeRemoteFile } from '../../src/production/remote-file.js';
import { remoteOpArgv } from '../../src/production/remote-op.js';
import { remoteCommandLine, type RemoteRunner } from '../../src/production/transport.js';

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
/** What a successful acquisition prints: its sequence number. */
const acquired: CommandResult = { exitCode: 0, stdout: '1\n', stderr: '' };

const ANN: LockOwner = { who: 'ann', host: 'box', since: '2026-11-23T10:00:00.000Z' };
const BEN: LockOwner = { who: 'ben', host: 'desk', since: '2026-11-23T10:05:00.000Z' };

const LOCK_DIR = '.jamal/apps/my-app/lock';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * A remote runner that executes the command line in a real local `sh`, in a
 * scratch directory standing in for the ssh user's home, exactly as the
 * server's login shell would receive it from ssh (stdin bytes included).
 */
function localShell(): { remote: RemoteRunner; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'jamal-lock-'));
  homes.push(home);
  const remote: RemoteRunner = {
    async run(_server, remoteArgv, options) {
      const call = typeof options === 'string' ? { stdin: options } : (options ?? {});
      let input: Uint8Array | string = call.stdin ?? '';
      if (call.stdinFrom !== undefined) {
        const chunks: Buffer[] = [];
        for await (const chunk of call.stdinFrom) chunks.push(Buffer.from(chunk as Buffer));
        input = Buffer.concat(chunks);
      }
      const result = spawnSync('sh', ['-c', remoteCommandLine(remoteArgv)], {
        cwd: home,
        input,
        encoding: 'utf8',
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  };
  return { remote, home };
}

const posixOnly = {
  skip: process.platform === 'win32' && 'the lock scripts need a POSIX shell',
};

describe('the deploy lock through a real shell', posixOnly, () => {
  it('records the owner and a sequence number privately, then removes the lock', async () => {
    const { remote, home } = localShell();
    const handle = await acquireLock(remote, { server: 's', lockDir: LOCK_DIR, owner: ANN });
    assert.equal(handle.seq, 1);
    assert.equal(handle.fence.dir, LOCK_DIR);
    assert.equal(statSync(join(home, LOCK_DIR)).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, LOCK_DIR, 'owner.json')).mode & 0o777, 0o600);
    assert.match(readFileSync(join(home, LOCK_DIR, 'token'), 'utf8'), /^[0-9a-f]{32}\n$/);
    assert.deepEqual(JSON.parse(readFileSync(join(home, LOCK_DIR, 'owner.json'), 'utf8')), {
      seq: 1,
      ...ANN,
    });
    assert.deepEqual(await lockStatus(remote, { server: 's', lockDir: LOCK_DIR }), {
      held: true,
      owner: { seq: 1, ...ANN },
    });

    await handle.release();
    assert.ok(!existsSync(join(home, LOCK_DIR)));
    assert.deepEqual(await lockStatus(remote, { server: 's', lockDir: LOCK_DIR }), {
      held: false,
    });
  });

  it('hands every acquisition the next sequence number, across releases of any kind', async () => {
    const { remote, home } = localShell();
    const options = { server: 's', lockDir: LOCK_DIR };
    const first = await acquireLock(remote, { ...options, owner: ANN });
    await first.release();
    await acquireLock(remote, { ...options, owner: BEN });
    await forceReleaseLock(remote, options);
    const third = await acquireLock(remote, { ...options, owner: ANN });
    assert.equal(third.seq, 3);
    assert.equal(readFileSync(join(home, '.jamal/apps/my-app/lock.seq'), 'utf8'), '3\n');
  });

  it('records an owner field with control characters replaced, as one JSON document', async () => {
    const { remote } = localShell();
    await acquireLock(remote, {
      server: 's',
      lockDir: LOCK_DIR,
      owner: { who: 'a\nb"c', host: 'h\u0001', since: 't', for: 'backup db' },
    });
    assert.deepEqual((await lockStatus(remote, { server: 's', lockDir: LOCK_DIR })).owner, {
      seq: 1,
      who: 'a b"c',
      host: 'h ',
      since: 't',
      for: 'backup db',
    });
  });

  it('reports contention when the lock is held', async () => {
    const { remote } = localShell();
    await acquireLock(remote, { server: 's', lockDir: LOCK_DIR, owner: ANN });
    await assert.rejects(
      () => acquireLock(remote, { server: 's', lockDir: LOCK_DIR, owner: BEN }),
      (error: unknown) => LockErrors.is(error, 'contended'),
    );
  });

  it('force-releases a lock a killed run left behind, and tolerates no lock', async () => {
    const { remote, home } = localShell();
    await acquireLock(remote, { server: 's', lockDir: LOCK_DIR, owner: ANN });
    await forceReleaseLock(remote, { server: 's', lockDir: LOCK_DIR });
    assert.ok(!existsSync(join(home, LOCK_DIR)));
    await forceReleaseLock(remote, { server: 's', lockDir: LOCK_DIR });
  });

  it('a force-released holder never removes the lock a later run took', async () => {
    const { remote, home } = localShell();
    const options = { server: 's', lockDir: LOCK_DIR };
    const first = await acquireLock(remote, { ...options, owner: ANN });
    await forceReleaseLock(remote, options);
    const second = await acquireLock(remote, { ...options, owner: BEN });

    await assert.rejects(
      () => first.release(),
      (error: unknown) => LockErrors.is(error, 'not_owner') && !String(error).includes(LOCK_DIR),
    );
    assert.equal((await lockStatus(remote, options)).owner?.who, 'ben');
    await second.release();
    assert.ok(!existsSync(join(home, LOCK_DIR)));
  });

  it('a holder whose lock was force-released and not retaken releases quietly', async () => {
    const { remote, home } = localShell();
    const handle = await acquireLock(remote, { server: 's', lockDir: LOCK_DIR, owner: ANN });
    await forceReleaseLock(remote, { server: 's', lockDir: LOCK_DIR });
    await handle.release();
    assert.ok(!existsSync(join(home, LOCK_DIR)));
  });
});

describe('the fenced runner of a lock holder', posixOnly, () => {
  it('runs each command while the lock holds its token, with the command its own stdin', async () => {
    const { remote, home } = localShell();
    const handle = await acquireLock(remote, { server: 's', lockDir: LOCK_DIR, owner: ANN });
    const result = await handle.remote.run('s', remoteOpArgv({ kind: 'host.home' }));
    assert.equal(result.exitCode, 0);
    // A write fenced by another lock, or by none, is fenced by this one too.
    await writeRemoteFile(handle.remote, 's', 'data/a.txt', Buffer.from('one\n'), { mode: 0o600 });
    assert.equal(readFileSync(join(home, 'data/a.txt'), 'utf8'), 'one\n');
  });

  it('refuses every command once another run holds the lock, and runs none of it', async () => {
    const { remote, home } = localShell();
    const options = { server: 's', lockDir: LOCK_DIR };
    const handle = await acquireLock(remote, { ...options, owner: ANN });
    await forceReleaseLock(remote, options);
    await acquireLock(remote, { ...options, owner: BEN });

    await assert.rejects(
      () =>
        writeRemoteFile(handle.remote, 's', 'data/a.txt', Buffer.from('late\n'), { mode: 0o600 }),
      (error: unknown) => LockErrors.is(error, 'lock_lost'),
    );
    assert.ok(!existsSync(join(home, 'data')));
    await assert.rejects(
      () => handle.remote.run('s', remoteOpArgv({ kind: 'host.home' })),
      (error: unknown) => LockErrors.is(error, 'lock_lost'),
    );
  });

  it('refuses a command it cannot fence before sending it', async () => {
    const { remote, calls } = makeRemote(() => acquired);
    const handle = await acquireLock(remote, { server: 's', lockDir: LOCK_DIR, owner: ANN });
    await assert.rejects(
      () => handle.remote.run('s', ['rm', '-rf', 'x']),
      (error: unknown) => LockErrors.is(error, 'unfenced_command') && !String(error).includes('rm'),
    );
    assert.equal(calls.length, 1, 'only the acquisition was sent');
  });

  it('sends the lock’s own ops and its own fenced writes unwrapped', async () => {
    const { remote, calls } = makeRemote(() => acquired);
    const handle = await acquireLock(remote, { server: 's', lockDir: LOCK_DIR, owner: ANN });
    const own = remoteOpArgv({ kind: 'lock.status', dir: LOCK_DIR });
    await handle.remote.run('s', own);
    assert.deepEqual(calls.at(-1)?.remoteArgv, [...own]);
  });
});

describe('acquireLock: failure classes', () => {
  it('raises a value-free contended error on exit 1', async () => {
    const { remote } = makeRemote(() => ({ exitCode: 1, stdout: '', stderr: 'exists' }));
    await assert.rejects(
      () => acquireLock(remote, { server: '1.2.3.4', lockDir: '/var/lock/jamal', owner: ANN }),
      (error: unknown) => {
        assert.ok(LockErrors.is(error, 'contended'));
        assert.match(error.message, /already held/);
        assert.ok(!error.message.includes('1.2.3.4'), 'server must not leak');
        assert.ok(!error.message.includes('/var/lock'), 'lock directory must not leak');
        return true;
      },
    );
  });

  it('reports an ssh failure (exit 255) as unreachable, not as contention', async () => {
    const { remote } = makeRemote(() => ({ exitCode: 255, stdout: '', stderr: 'denied' }));
    await assert.rejects(
      () => acquireLock(remote, { server: 's', lockDir: '/lock', owner: ANN }),
      (error: unknown) => LockErrors.is(error, 'unreachable'),
    );
  });

  it('reports any other failure, or an acquisition without a sequence number, as io_failed', async () => {
    for (const result of [
      { exitCode: 3, stdout: '', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: 'banner\n', stderr: '' },
      { exitCode: 0, stdout: '0\n', stderr: '' },
    ]) {
      const { remote } = makeRemote(() => result);
      await assert.rejects(
        () => acquireLock(remote, { server: 's', lockDir: '/lock', owner: ANN }),
        (error: unknown) => LockErrors.is(error, 'io_failed'),
      );
    }
  });

  it('reports a status the script did not produce as io_failed, never as not held', async () => {
    for (const exitCode of [3, 126, 127]) {
      const { remote } = makeRemote(() => ({ exitCode, stdout: '', stderr: 'denied' }));
      await assert.rejects(
        () => lockStatus(remote, { server: 's', lockDir: '/lock' }),
        (error: unknown) => LockErrors.is(error, 'io_failed'),
      );
    }
  });

  it('reports a held lock whose owner document does not parse as held, owner unknown', async () => {
    const { remote } = makeRemote(() => ({ exitCode: 0, stdout: 'ann@box since t\n', stderr: '' }));
    assert.deepEqual(await lockStatus(remote, { server: 's', lockDir: '/lock' }), { held: true });
  });
});

describe('lock validation, release, and owners', () => {
  it('rejects an empty or unsafe lock directory before any ssh call, value-free', async () => {
    for (const bad of ['', '-f', 'has space', 'tab\tx', 'ctrl\u0001']) {
      const { remote, calls } = makeRemote(() => ok);
      await assert.rejects(
        () => acquireLock(remote, { server: '1.2.3.4', lockDir: bad, owner: ANN }),
        (error: unknown) =>
          LockErrors.is(error, 'invalid_directory') &&
          (bad.length === 0 || !error.message.includes(bad)),
      );
      assert.equal(calls.length, 0, 'no ssh command may run for an invalid lock directory');
    }
  });

  it('release is idempotent: a second release runs nothing', async () => {
    const { remote, calls } = makeRemote(() => acquired);
    const handle = await acquireLock(remote, { server: 's', lockDir: '/lock', owner: ANN });
    await handle.release();
    await handle.release();
    assert.equal(calls.length, 2);
  });

  it('release raises a value-free io_failed when the script fails', async () => {
    let calls = 0;
    const { remote } = makeRemote(() => {
      calls += 1;
      return calls === 1 ? acquired : { exitCode: 3, stdout: '', stderr: '' };
    });
    const handle = await acquireLock(remote, { server: 's', lockDir: '/lock', owner: ANN });
    await assert.rejects(
      () => handle.release(),
      (error: unknown) =>
        LockErrors.is(error, 'io_failed') &&
        error.message === 'the deploy lock could not be released',
    );
  });

  it('parses only a whole owner document, and formats one on a line', () => {
    assert.equal(parseLockOwner('not json'), undefined);
    assert.equal(parseLockOwner('{"seq":"1","who":"a","host":"b","since":"c"}'), undefined);
    assert.equal(parseLockOwner('{"seq":1,"who":"a","host":"b"}'), undefined);
    const owner = parseLockOwner(
      '{"seq":4,"who":"ann","host":"box","since":"t","for":"backup db"}',
    );
    assert.ok(owner !== undefined);
    assert.deepEqual(owner, { seq: 4, who: 'ann', host: 'box', since: 't', for: 'backup db' });
    assert.equal(formatLockOwner(owner), 'ann@box since t (seq 4, backup db)');
    assert.equal(formatLockOwner({ seq: 1, ...ANN }), `ann@box since ${ANN.since} (seq 1)`);
  });
});
