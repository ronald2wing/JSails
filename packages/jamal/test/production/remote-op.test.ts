/**
 * Tests for the remote op layer: every op round-trips through its argv, a
 * command that is not an op decodes to nothing, and every command a full
 * production plan and the backup and lock builders send is an op.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeJamalConfig, secret } from '../../src/config/index.js';
import { valkeyRestoreArgv } from '../../src/production/backup.js';
import { lockReleaseArgv, lockStatusArgv } from '../../src/production/lock.js';
import { ensureNetworkArgv } from '../../src/production/network.js';
import { remoteWriteFileArgv } from '../../src/production/remote-file.js';
import { decodeRemoteOp, remoteOpArgv, type RemoteOp } from '../../src/production/remote-op.js';
import { deployPlan, observation, rollbackPlan, stateOf } from './host-observation.js';

const OPS: readonly RemoteOp[] = [
  {
    kind: 'file.write',
    path: '.jamal/apps/my app/releases/r/secrets/secrets.json',
    mode: 0o444,
    directoryMode: 0o755,
    lockDir: '.jamal/apps/x/lock',
    expect: 'absent',
  },
  {
    kind: 'file.write',
    path: '.jamal/apps/my app/accessories/db.env',
    mode: 0o600,
    directoryMode: undefined,
    lockDir: undefined,
    expect: undefined,
  },
  {
    kind: 'file.write',
    path: '.jamal/apps/x/state.json',
    mode: 0o600,
    directoryMode: 0o700,
    lockDir: undefined,
    expect: 'e'.repeat(64),
  },
  { kind: 'lock.acquire', dir: '.jamal/apps/x/lock', owner: '"who":"o\'wner $x"}', token: 'ab' },
  { kind: 'lock.release', dir: '.jamal/apps/x/lock', token: 'ab' },
  { kind: 'lock.force-release', dir: '.jamal/apps/x/lock' },
  { kind: 'lock.status', dir: '.jamal/apps/x/lock' },
  { kind: 'host.home' },
  { kind: 'host.read-state', dir: '.jamal/apps/my app', extra: [] },
  { kind: 'host.read-state', dir: '.jamal/apps/x', extra: ['.jamal/cache-proxy/default.vcl'] },
  { kind: 'container.image-digest', name: 'kamal-proxy' },
  { kind: 'fenced', lockDir: '.jamal/apps/x/lock', op: { kind: 'host.home' } },
  {
    kind: 'fenced',
    lockDir: '.jamal/apps/x/lock',
    op: { kind: 'docker', argv: ['docker', 'pull', 'img@sha256:abc'] },
  },
  {
    kind: 'fenced',
    lockDir: '.jamal/apps/x/lock',
    op: { kind: 'container.run-fresh', name: 'app-web-1', run: ['docker', 'run', '-d', 'img'] },
  },
  { kind: 'network.ensure', connect: [] },
  { kind: 'network.ensure', connect: ['kamal-proxy', 'db'] },
  { kind: 'container.run-fresh', name: 'app-web-1', run: ['docker', 'run', '-d', 'img'] },
  { kind: 'container.retire', name: 'app-web-1' },
  {
    kind: 'cache-proxy.load',
    name: 'jamal-cache-proxy',
    image: 'varnish@sha256:abc',
    boot: ['docker', 'run', '-d', 'varnish@sha256:abc'],
  },
  { kind: 'valkey.replace', container: 'cache', mount: 'v:/data', image: 'valkey', swap: 'set -e' },
  { kind: 'docker', argv: ['docker', 'ps'] },
];

describe('remoteOpArgv and decodeRemoteOp', () => {
  it('decode every op back from its argv', () => {
    for (const op of OPS) {
      assert.deepEqual(decodeRemoteOp(remoteOpArgv(op)), op, op.kind);
    }
  });

  it('decode no fence inside a fence, and no fence around what is no op', () => {
    const inner = remoteOpArgv({ kind: 'fenced', lockDir: 'l', op: { kind: 'host.home' } });
    const fence = remoteOpArgv({ kind: 'fenced', lockDir: 'l', op: { kind: 'host.home' } });
    const prefix = fence.slice(0, fence.length - remoteOpArgv({ kind: 'host.home' }).length);
    assert.equal(decodeRemoteOp([...prefix, ...inner]), undefined);
    assert.equal(decodeRemoteOp([...prefix, 'ls', '-la']), undefined);
  });

  it('decode nothing that is neither a known script nor docker', () => {
    assert.equal(decodeRemoteOp(['ls', '-la']), undefined);
    assert.equal(decodeRemoteOp(['sh', '-c', 'rm -rf /', 'sh']), undefined);
    assert.equal(decodeRemoteOp([]), undefined);
    assert.equal(decodeRemoteOp([...remoteOpArgv({ kind: 'host.home' }), 'x']), undefined);
    const status = remoteOpArgv({ kind: 'lock.status', dir: 'd' });
    assert.equal(decodeRemoteOp([...status, 'extra']), undefined, 'a wrong parameter count');
    assert.equal(decodeRemoteOp(['bash', ...status.slice(1)]), undefined, 'another shell');
    const fresh = remoteOpArgv({ kind: 'container.run-fresh', name: 'n', run: ['docker', 'run'] });
    assert.equal(decodeRemoteOp([...fresh.slice(0, 5), 'rm', '-rf']), undefined);
  });

  it('decode what the lock, file, network, cache-proxy, and backup builders send', () => {
    assert.deepEqual(decodeRemoteOp(lockStatusArgv('l')), { kind: 'lock.status', dir: 'l' });
    assert.deepEqual(decodeRemoteOp(lockReleaseArgv('l')), {
      kind: 'lock.force-release',
      dir: 'l',
    });
    assert.deepEqual(decodeRemoteOp(remoteWriteFileArgv('p', { mode: 0o640 })), {
      kind: 'file.write',
      path: 'p',
      mode: 0o640,
      directoryMode: undefined,
      lockDir: undefined,
      expect: undefined,
    });
    const write = remoteWriteFileArgv('p', { mode: 0o640 });
    assert.equal(
      decodeRemoteOp([...write.slice(0, -4), '9999', '', '', '']),
      undefined,
      'a bad mode',
    );
    assert.equal(decodeRemoteOp([...write.slice(0, -1), 'maybe']), undefined, 'a bad precondition');
    assert.deepEqual(decodeRemoteOp(ensureNetworkArgv(['a'])), {
      kind: 'network.ensure',
      connect: ['a'],
    });
    assert.equal(decodeRemoteOp(valkeyRestoreArgv('cache').replace)?.kind, 'valkey.replace');
  });

  it('decode every remote command of a full production plan', () => {
    const config = normalizeJamalConfig({
      service: 'myapp',
      image: 'ghcr.io/acme/myapp',
      env: { DATABASE_PASSWORD: secret('DATABASE_PASSWORD') },
      services: { db: { type: 'mariadb' }, cache: { type: 'valkey' } },
      cacheProxy: { enabled: true },
      production: { server: '203.0.113.7', domain: 'example.com' },
    });
    const observed = observation(config, {
      releases: [1, [2, 1]],
      state: stateOf(2, 1),
      containers: [{ n: 0, state: 'exited' }, 2],
      serving: 2,
    });
    for (const plan of [deployPlan(config, 3, { observed }), rollbackPlan(config, observed)]) {
      const remote = plan.steps.flatMap((step) => (step.argv?.[0] === 'ssh' ? [step.argv] : []));
      assert.ok(remote.length > 8);
      for (const argv of [...remote, plan.cleanupArgv]) {
        assert.notEqual(decodeRemoteOp(argv.slice(2)), undefined, argv.slice(2, 4).join(' '));
      }
    }
  });
});
