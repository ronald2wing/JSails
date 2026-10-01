/**
 * Scenarios of a deploy cut short at every point: an operator's Ctrl-C at
 * each remote command, a jamal process that loses the server at each remote
 * command, and an ssh connection that drops at each byte of a file write.
 * Each loops over every point and reports all the points where the host was
 * left wrong in one assertion.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { remoteWriteFileStdin, writeRemoteFile } from '../../src/production/remote-file.js';
import { WRITE_TEMPORARY_PREFIX, type RemoteOp } from '../../src/production/remote-op.js';
import { FakeRegistry } from '../../src/testing/fake-registry.js';
import { FakeHost } from '../../src/testing/fake-host.js';
import {
  SERVICE,
  createWorld,
  lockHeld,
  runningAppContainers,
  serverVerbs,
  signalSource,
  type World,
} from './world.js';

/** How a release's secrets file is written. */
const SECRETS = { mode: 0o444, directoryMode: 0o755 } as const;

function utf8(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

/** The temporary files a write left beside `path`. */
function leftovers(host: FakeHost, path: string): readonly string[] {
  const directory = path.slice(0, path.lastIndexOf('/'));
  return Object.keys(host.fs.snapshot(directory).files).filter((name) =>
    name.startsWith(WRITE_TEMPORARY_PREFIX),
  );
}

/** A short name for an op in a failure report. */
function label(op: RemoteOp | undefined): string {
  if (op === undefined) return 'unmodelled';
  if (op.kind !== 'docker') return op.kind;
  const [, verb, ...rest] = op.argv;
  return verb === 'exec' ? `docker exec ${rest.slice(1, 3).join(' ')}` : `docker ${verb}`;
}

/**
 * Run `body` in a world where checkout `a` has deployed once and committed a
 * second release. The checkouts are removed however `body` ends; only after
 * it succeeds is every command required to have been modelled, so a failure
 * keeps its own message.
 */
async function inSecondRelease<T>(
  body: (world: World, a: ReturnType<World['checkout']>) => Promise<T>,
): Promise<T> {
  const world = await createWorld();
  try {
    const a = world.checkout('a');
    const first = await a.jamal(['deploy']);
    assert.equal(first.code, 0, `the first deploy failed: ${first.err}`);
    a.commit('release 2', { 'app.js': 'export const version = 2;\n' });
    const result = await body(world, a);
    assert.deepEqual(world.unmodelled(), [], 'the engine sent only modelled commands');
    return result;
  } finally {
    world.dispose();
  }
}

/** The ops checkout `a` sends for its second release when nothing goes wrong. */
function referenceOps(
  release: (a: ReturnType<World['checkout']>) => Promise<unknown>,
): Promise<readonly (RemoteOp | undefined)[]> {
  return inSecondRelease(async (world, a) => {
    const from = world.host.log.length;
    await release(a);
    return world.host.log
      .slice(from)
      .filter((command) => command.client === 'a')
      .map((command) => command.op);
  });
}

/**
 * What is wrong with the host after a deploy was cut short: a held lock, no
 * serving release, or a running app container that never took traffic.
 */
function problems(world: World): string[] {
  const found: string[] = [];
  if (lockHeld(world)) found.push('the deploy lock is still held');
  const serving = world.host.docker.serving(SERVICE);
  if (serving?.state !== 'running') found.push('no running release is serving');
  for (const container of runningAppContainers(world)) {
    if (container.name !== serving?.name && !world.host.docker.hasServed(container.name)) {
      found.push(`${container.name} runs but never took traffic`);
    }
  }
  return found;
}

describe('a deploy cut short', serverVerbs, () => {
  it('an interrupt at any remote command leaves one serving release and no lock', async () => {
    const reference = await referenceOps((a) =>
      a.deployWithSignals(signalSource(), () => undefined),
    );
    const failures: string[] = [];
    for (let at = 1; at <= reference.length; at += 1) {
      await inSecondRelease(async (world, a) => {
        const signals = signalSource();
        let markInterrupted!: () => void;
        const interrupted = new Promise<void>((resolve) => {
          markInterrupted = resolve;
        });
        const end = (): void => {
          a.client.kill();
          markInterrupted();
        };
        let seen = 0;
        world.host.onCommand((event) => {
          if (event.client !== 'a') return;
          seen += 1;
          // A signal nothing handles ends the process at once, as SIGINT does.
          if (seen === at && !signals.fire('SIGINT')) end();
        });
        // The interrupted deploy rejects or resolves depending on where the
        // signal landed; only the state it leaves on the host is judged.
        await a.deployWithSignals(signals, end).catch(() => undefined);
        await interrupted;
        for (const problem of problems(world)) {
          failures.push(`${at} (${label(reference[at - 1])}): ${problem}`);
        }
      });
    }
    assert.deepEqual(failures, [], `an interrupt left the host wrong at ${failures.join('; ')}`);
  });

  it('a deploy killed at any remote command converges on the next deploy once its lock is released', async () => {
    const reference = await referenceOps((a) => a.jamal(['deploy']));
    const failures: string[] = [];
    for (let at = 1; at <= reference.length; at += 1) {
      await inSecondRelease(async (world, a) => {
        world.host.crashAfter({ commands: at }, 'a');
        await a.jamal(['deploy']);
        world.host.restoreLink('a');
        const release = await a.jamal(['lock', 'release']);
        assert.equal(release.code, 0, `jamal lock release failed: ${release.err}`);

        const redeploy = await a.jamal(['deploy']);
        const where = `${at} (${label(reference[at - 1])})`;
        if (redeploy.code !== 0) {
          failures.push(`${where}: the next deploy failed`);
        } else {
          const serving = world.host.docker.serving(SERVICE);
          if (serving?.imageDigest !== a.builtDigest()) {
            failures.push(`${where}: the next deploy does not serve its release`);
          }
          const others = runningAppContainers(world).filter((c) => c.name !== serving?.name);
          if (others.length > 0) failures.push(`${where}: ${others.length} stale containers run`);
          if (lockHeld(world)) failures.push(`${where}: the deploy lock is still held`);
        }
      });
    }
    assert.deepEqual(failures, [], `a killed deploy did not converge at ${failures.join('; ')}`);
  });

  it('an ssh drop at any byte of a file write leaves the previous file, never a partial one', async () => {
    const host = new FakeHost({ registry: new FakeRegistry() });
    const client = host.connect('writer');
    const path = '.jamal/apps/myapp/releases/r1/secrets/secrets.json';
    const old = utf8('{"v":1,"values":{"APP_SECRET":"old"}}\n');
    await writeRemoteFile(client, 'server', path, old, SECRETS);
    const contents = utf8('{"v":1,"values":{"APP_SECRET":"new","OTHER":"ünïcødé\\nvalue"}}\n');
    const stdinBytes = remoteWriteFileStdin(contents).length;

    const failures: number[] = [];
    for (let at = 0; at < stdinBytes; at += 1) {
      host.crashAfter({ stdinBytes: at }, 'writer');
      const rejected = await writeRemoteFile(client, 'server', path, contents, SECRETS).then(
        () => false,
        () => true,
      );
      host.restoreLink('writer');
      const file = host.fs.file(path);
      if (!rejected || !file?.data.equals(old) || leftovers(host, path).length > 0) {
        failures.push(at);
      }
    }
    assert.deepEqual(failures, [], 'a dropped write changed the destination');

    await writeRemoteFile(client, 'server', path, contents, SECRETS);
    assert.ok(host.fs.file(path)?.data.equals(contents));
    assert.equal(host.fs.file(path)?.mode, 0o444);
    assert.equal(host.fs.directory('.jamal/apps/myapp/releases/r1/secrets')?.mode, 0o755);
    assert.equal(host.fs.directory('.jamal/apps/myapp/releases/r1')?.mode, 0o700);
  });

  it('a write the connection loses after it ran leaves the whole new file, never a partial one', async () => {
    const host = new FakeHost({ registry: new FakeRegistry() });
    const client = host.connect('writer');
    const path = '.jamal/apps/myapp/accessories/db.env';
    const contents = utf8('MARIADB_PASSWORD=p"a$s\\w\n');
    host.crashAfter({ commands: 1 }, 'writer');
    await assert.rejects(writeRemoteFile(client, 'server', path, contents, { mode: 0o600 }));
    host.restoreLink('writer');
    // The server finished the write; only its answer was lost.
    assert.ok(host.fs.file(path)?.data.equals(contents));
    assert.deepEqual(leftovers(host, path), []);
  });

  it('an ssh drop at any byte of a first write leaves no file at all', async () => {
    const host = new FakeHost({ registry: new FakeRegistry() });
    const client = host.connect('writer');
    const path = '.jamal/apps/myapp/accessories/db.env';
    const contents = utf8('MARIADB_PASSWORD=p"a$s\\w\n');
    const failures: number[] = [];
    const stdinBytes = remoteWriteFileStdin(contents).length;
    for (let at = 0; at < stdinBytes; at += 1) {
      host.crashAfter({ stdinBytes: at }, 'writer');
      await writeRemoteFile(client, 'server', path, contents, { mode: 0o600 }).catch(
        () => undefined,
      );
      host.restoreLink('writer');
      if (host.fs.exists(path) || leftovers(host, path).length > 0) failures.push(at);
    }
    assert.deepEqual(failures, [], 'a dropped first write left a file behind');
  });
});
