/**
 * Tests for the Docker model's own fidelity on the points scenarios depend
 * on: Docker's env-file format, `-e` over `--env-file`, a run that uses the
 * digest last pulled rather than the registry's, and kamal-proxy refusing a
 * target it cannot reach or that is unhealthy.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseDockerEnvFile } from '../../src/testing/fake-docker.js';
import { FakeHost } from '../../src/testing/fake-host.js';
import { FakeRegistry, imageDigest } from '../../src/testing/fake-registry.js';

const REF = 'ghcr.io/acme/app:v1';

function hostWith(healthy = true): { host: FakeHost; registry: FakeRegistry } {
  const registry = new FakeRegistry();
  registry.push(REF, { digest: imageDigest('v1'), repository: 'ghcr.io/acme/app', healthy });
  return { host: new FakeHost({ registry }), registry };
}

describe('parseDockerEnvFile', () => {
  it('reads values verbatim after the first "=", with no quoting or escaping', () => {
    assert.deepEqual(parseDockerEnvFile(Buffer.from('A="q" \\n $B\nC=x=y\n')), {
      A: '"q" \\n $B',
      C: 'x=y',
    });
  });

  it('trims the leading space Go counts as space, not what JavaScript does', () => {
    assert.deepEqual(parseDockerEnvFile(Buffer.from('\u0085\u00a0A=1\n')), { A: '1' });
  });

  it('skips blank and comment lines, trims leading space, and drops one CR per line', () => {
    assert.deepEqual(parseDockerEnvFile(Buffer.from('\n# c\n  A=1\r\nB=2\r\r\n')), {
      A: '1',
      B: '2\r',
    });
  });

  it('takes a bare name from an empty environment, so it sets nothing', () => {
    assert.deepEqual(parseDockerEnvFile(Buffer.from('ONLY_NAME\n')), {});
  });

  it('drops a byte order mark from the first line only', () => {
    assert.deepEqual(parseDockerEnvFile(Buffer.from('\uFEFFA=1\n\uFEFFB=2\n')), {
      A: '1',
      '\uFEFFB': '2',
    });
  });

  it('refuses invalid UTF-8, a key with whitespace, a missing name, and an overlong line', () => {
    assert.equal(typeof parseDockerEnvFile(Buffer.from([0x41, 0x3d, 0xff, 0x0a])), 'string');
    assert.equal(typeof parseDockerEnvFile(Buffer.from('A B=1\n')), 'string');
    assert.equal(typeof parseDockerEnvFile(Buffer.from('A\tB=1\n')), 'string');
    assert.equal(typeof parseDockerEnvFile(Buffer.from('=1\n')), 'string');
    assert.equal(typeof parseDockerEnvFile(Buffer.from(`A=${'x'.repeat(64 * 1024)}\n`)), 'string');
  });
});

describe('FakeDocker', () => {
  it('lets -e win over --env-file whatever their order', async () => {
    const { host } = hostWith();
    host.fs.mkdirp('e', 0o700);
    host.fs.write('e/env', Buffer.from('A=file\nB=file\n'), 0o600);
    const run = await host.run('s', [
      'docker',
      'run',
      '-d',
      '-e',
      'A=flag',
      '--name',
      'c',
      '--env-file',
      'e/env',
      REF,
    ]);
    assert.equal(run.exitCode, 0);
    assert.deepEqual(host.docker.container('c')?.env, { A: 'flag', B: 'file' });
  });

  it('binds only an absolute source, as a Docker CLI before 23 does, and reads it below the home', async () => {
    const { host } = hostWith();
    const run = (name: string, source: string) =>
      host.run('s', ['docker', 'run', '-d', '--name', name, '-v', `${source}:/data:ro`, REF]);
    // A `./` source reaches an old daemon as a volume name it refuses.
    for (const source of ['./.jamal/data', '.jamal/data', '<home>/.jamal/data']) {
      const refused = await run(`r${source.length}`, source);
      assert.equal(refused.exitCode, 125, source);
      assert.match(refused.stderr, /invalid characters for a local volume name/);
    }
    assert.equal((await run('abs', `${host.fs.home}/.jamal/data`)).exitCode, 0);
    assert.equal((await run('vol', 'named_volume')).exitCode, 0);
    host.fs.mkdirp(`${host.fs.home}/.jamal`, 0o700);
    assert.ok(
      host.fs.directory('.jamal') !== undefined,
      'an absolute path below the home is the same entry',
    );
  });

  it('runs the digest last pulled, not the one the tag points at now', async () => {
    const { host, registry } = hostWith();
    assert.equal((await host.run('s', ['docker', 'pull', REF])).exitCode, 0);
    registry.push(REF, {
      digest: imageDigest('v1 again'),
      repository: 'ghcr.io/acme/app',
      healthy: true,
    });
    await host.run('s', ['docker', 'run', '-d', '--name', 'c', REF]);
    assert.equal(host.docker.container('c')?.imageDigest, imageDigest('v1'));
  });

  it('refuses a name in use with 125 and a missing env file with 125', async () => {
    const { host } = hostWith();
    await host.run('s', ['docker', 'run', '-d', '--name', 'c', REF]);
    assert.equal((await host.run('s', ['docker', 'run', '-d', '--name', 'c', REF])).exitCode, 125);
    const missing = ['docker', 'run', '-d', '--name', 'd', '--env-file', 'nope', REF];
    assert.equal((await host.run('s', missing)).exitCode, 125);
  });

  it('routes kamal-proxy only to a reachable, healthy target', async () => {
    for (const [healthy, network, expected] of [
      [true, 'shared', 0],
      [false, 'shared', 1],
      [true, 'alone', 1],
    ] as const) {
      const { host } = hostWith(healthy);
      host.docker.createNetwork('shared');
      host.docker.createNetwork('alone');
      await host.run('s', [
        'docker',
        'run',
        '-d',
        '--name',
        'kamal-proxy',
        '--network',
        'shared',
        'basecamp/kamal-proxy:v0.10.0',
        'kamal-proxy',
        'run',
      ]);
      await host.run('s', ['docker', 'run', '-d', '--name', 'app', '--network', network, REF]);
      const deploy = await host.run('s', [
        'docker',
        'exec',
        'kamal-proxy',
        'kamal-proxy',
        'deploy',
        'svc',
        '--target',
        'app:3000',
      ]);
      assert.equal(deploy.exitCode, expected, `${healthy} ${network}`);
      assert.equal(host.docker.serving('svc')?.name, expected === 0 ? 'app' : undefined);
    }
  });

  it('records a command it does not model and answers 127', async () => {
    const { host } = hostWith();
    assert.equal((await host.run('s', ['docker', 'system', 'df'])).exitCode, 127);
    assert.equal((await host.run('s', ['uname', '-a'])).exitCode, 127);
    assert.deepEqual(host.unmodelled, [
      ['docker', 'system', 'df'],
      ['uname', '-a'],
    ]);
  });
});
