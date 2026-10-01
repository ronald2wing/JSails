/**
 * Whole-verb scenarios of the release lifecycle against the fake host:
 * deploys from one and from several checkouts, rollback, image retention,
 * dirty trees, and secret values. Each states correct behaviour; the ones
 * today's engine fails are listed in `scripts/expected-failures/jamal.json`
 * with the package that fixes them.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  CACHE_PROXY_CONTAINER_NAME,
  CACHE_PROXY_HOST_VCL_FILE,
} from '../../src/production/cache-proxy.js';
import {
  hostReleaseDir,
  hostReleasesDir,
  hostStateFile,
} from '../../src/production/host-layout.js';
import { PROXY_CONTAINER_NAME } from '../../src/production/proxy.js';
import { WRITE_TEMPORARY_PREFIX } from '../../src/production/remote-op.js';
import { imageDigest } from '../../src/testing/fake-registry.js';
import {
  IMAGE,
  RETAIN,
  SERVICE,
  appImages,
  appValue,
  createWorld,
  lockHeld,
  releaseOf,
  runningAppContainers,
  serverVerbs,
  type World,
} from './world.js';

let world: World;

/** Deploy from `checkout`, failing the test with the verb's own report when it fails. */
async function deploy(name: ReturnType<World['checkout']>): Promise<void> {
  const run = await name.jamal(['deploy']);
  assert.equal(run.code, 0, `jamal deploy failed: ${run.err}`);
}

describe('release lifecycle as a deploy user with an unusual home', serverVerbs, () => {
  it('mounts from the home the server reports, a root home or one with a space alike', async () => {
    for (const sshUser of [
      { name: 'root', home: '/root' },
      { name: 'ops', home: '/srv/deploy home' },
    ]) {
      const host = await createWorld({ sshUser, cacheProxy: true });
      try {
        await deploy(host.checkout('a'));

        assert.equal(host.host.docker.serving(SERVICE)?.name, CACHE_PROXY_CONTAINER_NAME);
        const [app] = runningAppContainers(host);
        assert.ok(app !== undefined);
        const release = hostReleaseDir(SERVICE, undefined, releaseOf(app));
        assert.deepEqual(app.mounts, [`${sshUser.home}/${release}/secrets:/run/jsails/secrets:ro`]);
        assert.equal(appValue(host, app.name, 'APP_SECRET'), 'first-secret');
        assert.deepEqual(host.host.docker.container(CACHE_PROXY_CONTAINER_NAME)?.mounts, [
          `${sshUser.home}/.jamal/cache-proxy:/etc/varnish:ro`,
        ]);
      } finally {
        host.close();
      }
    }
  });
});

describe('release lifecycle on one host', serverVerbs, () => {
  beforeEach(async () => {
    world = await createWorld();
  });

  afterEach(() => {
    world.close();
  });

  it('a first deploy serves the release with its secrets and leaves no lock', async () => {
    const a = world.checkout('a');
    await deploy(a);

    const running = runningAppContainers(world);
    assert.equal(running.length, 1);
    const serving = world.host.docker.serving(SERVICE);
    assert.ok(serving !== undefined, 'kamal-proxy routes the service');
    assert.equal(serving.name, running[0]?.name);
    assert.equal(serving.imageDigest, a.builtDigest());
    assert.deepEqual(world.host.docker.route(SERVICE), {
      service: SERVICE,
      target: `${serving.name}:3000`,
      host: 'myapp.example',
      tls: true,
      healthCheckPath: '/up',
    });
    assert.equal(appValue(world, serving.name, 'APP_SECRET'), 'first-secret');
    assert.equal(appValue(world, serving.name, 'NODE_ENV'), 'production');
    assert.equal(lockHeld(world), false);
  });

  it('checks the release config with the environment the release runs with, before it starts', async () => {
    const a = world.checkout('a');
    await deploy(a);

    const serving = world.host.docker.serving(SERVICE);
    assert.ok(serving !== undefined);
    const checks = world.host.docker.oneOffRuns();
    assert.equal(checks.length, 1);
    const [check] = checks;
    assert.deepEqual(check?.command, ['node', 'node_modules/.bin/jsails', 'check', '--deploy']);
    assert.equal(check?.network, 'none');
    assert.equal(check?.imageDigest, serving.imageDigest);
    // The secrets, the environment, and the proxy trust the release sees.
    assert.ok(check !== undefined);
    assert.deepEqual(check.env, serving.env);
    assert.deepEqual(check.mounts, serving.mounts);
    assert.equal(check.env['JSAILS_TRUSTED_PROXIES'], 'hops=1');
    assert.equal(world.host.docker.appEnvironment(check)['APP_SECRET'], 'first-secret');
  });

  it('delivers the secrets in a per-release file only the ssh user can reach on the host', async () => {
    const a = world.checkout('a');
    await deploy(a);

    const serving = world.host.docker.serving(SERVICE);
    assert.ok(serving !== undefined);
    // No secret is a variable of the container; the file is mounted read-only.
    assert.equal(serving.env['APP_SECRET'], undefined);
    assert.equal(serving.env['JSAILS_SECRETS_FILE'], '/run/jsails/secrets/secrets.json');
    const release = hostReleaseDir(SERVICE, undefined, releaseOf(serving));
    // Mounted by absolute path: a Docker CLI before 23 (the fake host's
    // engine) refuses a `./` source as an invalid volume name.
    assert.deepEqual(serving.mounts, [
      `${world.host.fs.home}/${release}/secrets:/run/jsails/secrets:ro`,
    ]);
    const { files, directories } = world.host.fs.snapshot(release);
    assert.deepEqual(directories, { secrets: 0o755 });
    assert.deepEqual(files['secrets/secrets.json'], {
      mode: 0o444,
      text: '{"v":1,"values":{"APP_SECRET":"first-secret"}}\n',
    });
    // Beside it, only the release's immutable manifest, which holds no value.
    assert.deepEqual(Object.keys(files), ['manifest.json', 'secrets/secrets.json']);
    assert.equal(files['manifest.json']?.mode, 0o444);
    assert.ok(!files['manifest.json']?.text.includes('first-secret'));
    // The release directory is new to each release, so the write always
    // creates it private: no other user on the host reaches the file, and the
    // container reads it through the mount, not through the host path.
    assert.equal(world.host.fs.directory(release)?.mode, 0o700);
    assert.equal(world.host.fs.directory(release)?.owner, 'deploy');
  });

  it('a host with no SHA-256 tool refuses the release before it starts, and the previous one keeps serving', async () => {
    const a = world.checkout('a');
    await deploy(a);
    const before = world.host.docker.serving(SERVICE)?.name;
    world.host.hashers.clear();
    a.commit('release 2', { 'app.js': 'export const version = 2;\n' });

    const run = await a.jamal(['deploy']);
    assert.equal(run.code, 1);
    assert.match(run.err, /secrets-file failed: jamal_remote_file\.no_hasher/);
    assert.ok(!run.err.includes('first-secret'), 'no secret value in the report');
    assert.equal(world.host.docker.serving(SERVICE)?.name, before);
    assert.deepEqual(
      runningAppContainers(world).map((container) => container.name),
      [before],
    );
    const live = releaseOf(runningAppContainers(world)[0]!);
    const releases = world.host.fs.snapshot(hostReleasesDir(SERVICE, undefined)).directories;
    const refused = Object.keys(releases).filter((name) => !name.includes('/') && name !== live);
    assert.equal(refused.length, 1, 'the refused release left one directory');
    assert.deepEqual(world.host.fs.snapshot(hostReleaseDir(SERVICE, undefined, refused[0]!)), {
      directories: { secrets: 0o755 },
      files: {},
    });
    assert.equal(lockHeld(world), false);
  });

  it('a deploy from a second checkout leaves exactly one live release', async () => {
    const a = world.checkout('a');
    await deploy(a);
    const b = world.checkout('b');
    b.commit('b changes', { 'app.js': 'export const version = 2;\n' });
    await deploy(b);

    const serving = world.host.docker.serving(SERVICE);
    assert.ok(serving !== undefined, 'kamal-proxy routes the service');
    assert.equal(serving.imageDigest, b.builtDigest());
    const running = runningAppContainers(world).map((container) => container.name);
    assert.deepEqual(
      running,
      [serving.name],
      `expected exactly one running app container, the live one; found ${running.length}`,
    );
  });

  it(`consecutive deploys keep at most retain + 1 (${RETAIN + 1}) app images`, async () => {
    const a = world.checkout('a');
    for (let release = 1; release <= RETAIN + 3; release += 1) {
      a.commit(`release ${release}`, { 'app.js': `export const version = ${release + 1};\n` });
      await deploy(a);
    }
    const kept = appImages(world).length;
    assert.ok(
      kept <= RETAIN + 1,
      `the host keeps ${kept} app images after ${RETAIN + 3} deploys; at most ${RETAIN + 1} are allowed`,
    );
  });

  it('rollback after a secret change runs the previous release with its own secrets', async () => {
    const a = world.checkout('a');
    await deploy(a);
    world.secrets.APP_SECRET = 'second-secret';
    a.commit('release 2', { 'app.js': 'export const version = 2;\n' });
    await deploy(a);

    const rollback = await a.jamal(['rollback']);
    assert.equal(rollback.code, 0, `jamal rollback failed: ${rollback.err}`);
    const serving = world.host.docker.serving(SERVICE);
    assert.ok(serving !== undefined);
    assert.equal(
      appValue(world, serving.name, 'APP_SECRET'),
      'first-secret',
      'the rolled-back release must read the secrets it was deployed with',
    );
  });

  it('rollback restores the image digest the previous release ran after its tag moved', async () => {
    const a = world.checkout('a');
    await deploy(a);
    const first = releaseOf(runningAppContainers(world)[0]!);
    const firstDigest = world.registry.digestOf(`${IMAGE}:${first}`);
    a.commit('release 2', { 'app.js': 'export const version = 2;\n' });
    await deploy(a);
    // Another machine rebuilds the first release and pushes it under the same tag.
    world.registry.push(`${IMAGE}:${first}`, {
      digest: imageDigest('a rebuild of the first commit'),
      repository: IMAGE,
      healthy: true,
    });

    const rollback = await a.jamal(['rollback']);
    assert.equal(rollback.code, 0, `jamal rollback failed: ${rollback.err}`);
    assert.equal(
      world.host.docker.serving(SERVICE)?.imageDigest,
      firstDigest,
      'the rolled-back release must run the digest it ran before, not what its tag points at now',
    );
  });

  it('while kamal-proxy is stopped, the app verbs reach the recorded release, and a deploy or rollback changes nothing', async () => {
    const a = world.checkout('a');
    await deploy(a);
    a.commit('release 2', { 'app.js': 'export const version = 2;\n' });
    await deploy(a);
    const live = world.host.docker.serving(SERVICE);
    assert.ok(live !== undefined);
    const state = world.host.fs.file(hostStateFile(SERVICE, undefined))?.data;
    assert.ok(state !== undefined);
    assert.ok(world.host.docker.stop(PROXY_CONTAINER_NAME));

    const stop = await a.jamal(['app', 'stop']);
    assert.equal(stop.code, 0, `jamal app stop failed: ${stop.err}`);
    assert.equal(world.host.docker.container(live.name)?.state, 'exited');
    const boot = await a.jamal(['app', 'boot']);
    assert.equal(boot.code, 0, `jamal app boot failed: ${boot.err}`);
    assert.equal(world.host.docker.container(live.name)?.state, 'running');

    a.commit('release 3', { 'app.js': 'export const version = 3;\n' });
    for (const verb of ['deploy', 'rollback']) {
      const run = await a.jamal([verb]);
      assert.equal(run.code, 1, `jamal ${verb} must be refused while kamal-proxy is stopped`);
      assert.match(run.err, /kamal-proxy is not running on the server/);
      assert.deepEqual(world.host.fs.file(hostStateFile(SERVICE, undefined))?.data, state);
      assert.deepEqual(
        runningAppContainers(world).map((container) => container.name),
        [live.name],
      );
    }
  });

  it('a same-commit dirty redeploy is refused without --allow-dirty', async () => {
    const a = world.checkout('a');
    await deploy(a);
    const live = world.host.docker.serving(SERVICE);
    a.edit({ 'app.js': 'export const version = "uncommitted";\n' });

    const run = await a.jamal(['deploy']);
    assert.notEqual(run.code, 0, 'a deploy from a dirty tree must be refused');
    assert.equal(world.host.docker.serving(SERVICE)?.id, live?.id);
  });

  it('a secret with backslash, dollar, quotes, a PEM block and non-ASCII reaches the app byte for byte', async () => {
    const value =
      'back\\slash $HOME "double" \'single\' `tick` ünïcødé ✓\n' +
      '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA\n-----END PRIVATE KEY-----\n';
    world.secrets.APP_SECRET = value;
    const a = world.checkout('a');

    const run = await a.jamal(['deploy']);
    assert.equal(run.code, 0, `jamal deploy failed: ${run.err}`);
    const serving = world.host.docker.serving(SERVICE);
    assert.ok(serving !== undefined);
    assert.equal(appValue(world, serving.name, 'APP_SECRET'), value);
  });
});

describe('release lifecycle behind the cache proxy', serverVerbs, () => {
  beforeEach(async () => {
    world = await createWorld({ cacheProxy: true });
  });

  afterEach(() => {
    world.close();
  });

  it('routes the service through Varnish, whose VCL names the new release', async () => {
    const a = world.checkout('a');
    await deploy(a);
    a.commit('release 2', { 'app.js': 'export const version = 2;\n' });
    await deploy(a);

    assert.equal(world.host.docker.serving(SERVICE)?.name, CACHE_PROXY_CONTAINER_NAME);
    const [app] = runningAppContainers(world);
    assert.equal(runningAppContainers(world).length, 1);
    const vcl = world.host.fs.file(CACHE_PROXY_HOST_VCL_FILE);
    assert.ok(vcl !== undefined && app !== undefined);
    assert.match(vcl.data.toString('utf8'), new RegExp(`"${app.name}"`));
    assert.equal(vcl.mode, 0o644);
    const left = Object.keys(world.host.fs.snapshot('.jamal/cache-proxy').files);
    assert.deepEqual(left, ['default.vcl'], `no ${WRITE_TEMPORARY_PREFIX}* file is left behind`);
    assert.ok(
      world.host.docker
        .container(CACHE_PROXY_CONTAINER_NAME)
        ?.mounts.includes(`${world.host.fs.home}/.jamal/cache-proxy:/etc/varnish:ro`),
      'Varnish mounts the VCL directory, so a renamed VCL reaches varnishreload',
    );
  });
});

describe('the release environment a config file declares', serverVerbs, () => {
  afterEach(() => {
    world.close();
  });

  it('a clear JSAILS_ENV entry runs the release as that environment, NODE_ENV derived', async () => {
    world = await createWorld({ configFileEnv: { JSAILS_ENV: 'staging' } });
    const a = world.checkout('a');
    await deploy(a);
    const serving = world.host.docker.serving(SERVICE);
    assert.ok(serving !== undefined);
    assert.equal(appValue(world, serving.name, 'JSAILS_ENV'), 'staging');
    assert.equal(appValue(world, serving.name, 'NODE_ENV'), 'production');
  });

  it('a JSAILS_ENV of test boots the release with the NODE_ENV it derives', async () => {
    world = await createWorld({ configFileEnv: { JSAILS_ENV: 'test' } });
    const a = world.checkout('a');
    await deploy(a);
    const serving = world.host.docker.serving(SERVICE);
    assert.ok(serving !== undefined);
    assert.equal(appValue(world, serving.name, 'NODE_ENV'), 'test');
  });

  for (const key of ['NODE_ENV', 'JSAILS_ENV_RESOLVED', 'JSAILS_SECRETS_FILE', 'JSAILS_DEBUG']) {
    it(`a config.env that sets ${key} is refused when the verb loads it, before the host hears of it`, async () => {
      world = await createWorld({ configFileEnv: { [key]: 'reserved-value-marker' } });
      const a = world.checkout('a');
      const run = await a.jamal(['deploy']);
      assert.equal(run.code, 1);
      assert.match(run.err, new RegExp(`^jamal: config\\.env must not name ${key}: `));
      assert.ok(!run.err.includes('reserved-value-marker'), 'the value is never echoed');
      assert.deepEqual(
        world.host.log.filter((command) => command.client === 'a'),
        [],
        'no command reached the server',
      );
      assert.equal(world.registry.hasRepository(IMAGE), false, 'nothing was built or pushed');
    });
  }
});
