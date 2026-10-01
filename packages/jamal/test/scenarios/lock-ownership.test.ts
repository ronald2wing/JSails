/**
 * Scenarios of the deploy lock shared by two machines: a deploy whose lock
 * was force-released while it ran, and a deploy started while a backup holds
 * the lock.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { hostLockDir, hostReleasesDir } from '../../src/production/host-layout.js';
import { acquireLock, parseLockOwner } from '../../src/production/lock.js';
import { isMutatingOp } from '../../src/testing/fake-host.js';
import { SERVICE, createWorld, lockHeld, serverVerbs, type Checkout, type World } from './world.js';

const LOCK_DIR = hostLockDir(SERVICE, undefined);

/** Who machine `b` takes the lock as. */
const B_OWNER = { who: 'b', host: 'machine', since: '2026-11-23T10:30:00.000Z' } as const;

let world: World;

/** The owner document the host's lock holds now, if it holds one. */
function lockOwner(): ReturnType<typeof parseLockOwner> {
  const text = world.host.fs.file(`${LOCK_DIR}/owner.json`)?.data.toString('utf8');
  return text === undefined ? undefined : parseLockOwner(text);
}

/**
 * Checkout `a` deploys a second release; when it reaches its image pull, an
 * operator on machine `b` force-releases the lock and `b` takes it. Resolves
 * with the log position at which `b` holds the lock.
 */
async function deployLosingTheLock(a: Checkout, b: Checkout): Promise<number> {
  let takenAt = -1;
  const off = world.host.onCommand(async (event) => {
    if (event.client !== 'a' || event.op?.kind !== 'docker' || event.op.argv[1] !== 'pull') return;
    off();
    const release = await b.jamal(['lock', 'release']);
    assert.equal(release.code, 0, `jamal lock release failed: ${release.err}`);
    await acquireLock(b.client, { server: 'server', lockDir: LOCK_DIR, owner: B_OWNER });
    takenAt = world.host.log.length;
  });
  a.commit('release 2', { 'app.js': 'export const version = 2;\n' });
  await a.jamal(['deploy']);
  assert.ok(takenAt > 0, 'b took the lock while a deployed');
  return takenAt;
}

describe('the deploy lock across machines', serverVerbs, () => {
  beforeEach(async () => {
    world = await createWorld();
  });

  afterEach(() => {
    world.close();
  });

  it("a deploy whose lock was force-released does not remove the next holder's lock", async () => {
    const a = world.checkout('a');
    assert.equal((await a.jamal(['deploy'])).code, 0);
    await deployLosingTheLock(a, world.checkout('b'));

    assert.equal(lockHeld(world), true);
    assert.equal(lockOwner()?.who, 'b');
    assert.equal(lockOwner()?.host, 'machine');
  });

  it('a deploy whose lock was force-released writes no release file and starts no release', async () => {
    const a = world.checkout('a');
    assert.equal((await a.jamal(['deploy'])).code, 0);
    const before = world.host.docker.serving(SERVICE)?.name;
    const off = world.host.onCommand(async (event) => {
      if (event.client !== 'a' || event.op?.kind !== 'docker' || event.op.argv[1] !== 'pull')
        return;
      off();
      const b = world.checkout('b');
      assert.equal((await b.jamal(['lock', 'release'])).code, 0);
      await acquireLock(b.client, { server: 'server', lockDir: LOCK_DIR, owner: B_OWNER });
    });
    a.commit('release 2', { 'app.js': 'export const version = 2;\n' });
    const run = await a.jamal(['deploy']);

    assert.equal(run.code, 1);
    // The fence refuses the pull itself: the lock no longer holds a's token.
    assert.match(run.err, /failed at step "pull": pull failed: jamal_lock\.lock_lost/);
    const releases = Object.keys(world.host.fs.snapshot(hostReleasesDir(SERVICE, undefined)).files);
    assert.equal(
      releases.filter((path) => path.endsWith('/secrets/secrets.json')).length,
      1,
      'only the first release has a secrets file',
    );
    assert.equal(world.host.docker.serving(SERVICE)?.name, before);
    assert.equal(lockOwner()?.who, 'b');
  });

  it('a deploy whose lock was force-released stops mutating the host', async () => {
    const a = world.checkout('a');
    assert.equal((await a.jamal(['deploy'])).code, 0);
    const takenAt = await deployLosingTheLock(a, world.checkout('b'));

    const lateMutations = world.host.log.slice(takenAt).flatMap(({ client, executed, op }) => {
      if (client !== 'a' || !executed || op === undefined) return [];
      if (!isMutatingOp(op) || op.kind.startsWith('lock.')) return [];
      return [op.kind === 'docker' ? op.argv.slice(0, 2).join(' ') : op.kind];
    });
    assert.deepEqual(
      lateMutations,
      [],
      `a kept mutating the host after losing its lock: ${lateMutations.join(', ')}`,
    );
  });
});

describe('the deploy lock and backups', serverVerbs, () => {
  beforeEach(async () => {
    world = await createWorld({ accessories: true });
  });

  afterEach(() => {
    world.close();
  });

  it('a deploy started while a backup runs is refused by the lock', async () => {
    const a = world.checkout('a');
    assert.equal((await a.jamal(['deploy'])).code, 0);
    world.host.docker.setVolumeData('mariadb-data', Buffer.from('rows'));
    const b = world.checkout('b');
    let during: Awaited<ReturnType<Checkout['jamal']>> | undefined;
    const off = world.host.onCommand(async (event) => {
      if (event.client !== 'a' || event.op?.kind !== 'docker' || event.op.argv[1] !== 'exec')
        return;
      if (!event.op.argv.includes('sh')) return;
      off();
      during = await b.jamal(['deploy']);
    });

    const backup = await a.jamal(['backup', 'db']);
    assert.equal(backup.code, 0, `jamal backup failed: ${backup.err}`);
    assert.ok(during !== undefined, 'b tried to deploy during the dump');
    assert.equal(during.code, 1);
    assert.match(during.err, /already held/);
    assert.equal(lockHeld(world), false);
  });
});
