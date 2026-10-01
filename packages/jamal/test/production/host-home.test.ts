/**
 * Tests for reading the ssh user's home on the server: the one `host.home`
 * op, the output it accepts, the value-free refusals, and the absolute
 * bind-mount paths built on it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HostHomeErrors, assertHostHome, readHostHome } from '../../src/production/host-home.js';
import { absoluteHostPath } from '../../src/production/host-layout.js';
import type { CommandResult } from '../../src/production/process-runner.js';
import { decodeRemoteOp } from '../../src/production/remote-op.js';
import type { RemoteRunner } from '../../src/production/transport.js';

/** A server that answers every command with `result`, recording the argv it got. */
function server(result: CommandResult): { remote: RemoteRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    remote: {
      async run(_server, remoteArgv) {
        calls.push([...remoteArgv]);
        return result;
      },
    },
  };
}

describe('readHostHome', () => {
  it('sends the host.home op once and returns its one line', async () => {
    const { remote, calls } = server({ exitCode: 0, stdout: '/home/deploy\n', stderr: '' });
    assert.equal(await readHostHome(remote, 'srv'), '/home/deploy');
    assert.equal(calls.length, 1);
    assert.deepEqual(decodeRemoteOp(calls[0]!), { kind: 'host.home' });
  });

  it('accepts a root home and a home with a space', async () => {
    for (const home of ['/', '/root', '/srv/deploy home']) {
      const { remote } = server({ exitCode: 0, stdout: `${home}\n`, stderr: '' });
      assert.equal(await readHostHome(remote, 'srv'), home);
    }
  });

  it('reports a failed read by its exit code alone', async () => {
    const { remote } = server({ exitCode: 255, stdout: '', stderr: 'ssh: secret-host refused' });
    await assert.rejects(
      () => readHostHome(remote, 'srv'),
      (error: unknown) =>
        HostHomeErrors.is(error, 'read_failed') &&
        /code 255/.test(error.message) &&
        !error.message.includes('secret-host'),
    );
  });

  it('refuses output that cannot start a bind-mount source, without echoing it', async () => {
    for (const stdout of [
      'Welcome to prod-db-7!\n/home/deploy\n',
      'home/deploy\n',
      '/home/odd:name\n',
      '/home/tab\there\n',
      '\n',
      '',
    ]) {
      const { remote } = server({ exitCode: 0, stdout, stderr: '' });
      await assert.rejects(
        () => readHostHome(remote, 'srv'),
        (error: unknown) =>
          HostHomeErrors.is(error, 'unusable_home') && !/prod-db-7|odd|tab/.test(error.message),
        JSON.stringify(stdout),
      );
    }
  });
});

describe('assertHostHome and absoluteHostPath', () => {
  it('passes a usable home through and joins a path below it once', () => {
    assert.equal(assertHostHome('/home/deploy'), '/home/deploy');
    assert.equal(absoluteHostPath('/home/deploy', '.jamal/x'), '/home/deploy/.jamal/x');
    assert.equal(absoluteHostPath('/', '.jamal/x'), '/.jamal/x');
  });
});
