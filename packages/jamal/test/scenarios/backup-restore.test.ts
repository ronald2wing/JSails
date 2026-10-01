/**
 * Scenarios of `jamal backup` and `jamal restore` against accessories a
 * deploy booted on the fake host: a round trip per kind, and an upload that
 * drops midway.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createWorld, serverVerbs, type Checkout, type World } from './world.js';

let world: World;
let a: Checkout;

/** Back up `accessory` and return the written file's path. */
async function backup(accessory: string): Promise<string> {
  const run = await a.jamal(['backup', accessory]);
  assert.equal(run.code, 0, `jamal backup failed: ${run.err}`);
  const written = /^Wrote (\S+) /m.exec(run.out)?.[1];
  assert.ok(written !== undefined, 'the backup names its file');
  return written;
}

describe('backup and restore', serverVerbs, () => {
  beforeEach(async () => {
    world = await createWorld({ accessories: true });
    a = world.checkout('a');
    const deploy = await a.jamal(['deploy']);
    assert.equal(deploy.code, 0, `jamal deploy failed: ${deploy.err}`);
  });

  afterEach(() => {
    world.close();
  });

  for (const [accessory, volume] of [
    ['db', 'mariadb-data'],
    ['cache', 'valkey-data'],
  ] as const) {
    it(`a ${accessory} backup restores the data it was taken from`, async () => {
      world.host.docker.setVolumeData(volume, Buffer.from('state at backup time'));
      const file = await backup(accessory);
      world.host.docker.setVolumeData(volume, Buffer.from('state written later'));

      const restore = await a.jamal(['restore', accessory, file, '--yes']);
      assert.equal(restore.code, 0, `jamal restore failed: ${restore.err}`);
      assert.equal(world.host.docker.volumeData(volume)?.toString(), 'state at backup time');
      assert.equal(world.host.docker.container(accessory)?.state, 'running');
    });
  }

  it("a restore whose upload drops midway leaves the accessory's data untouched", async () => {
    world.host.docker.setVolumeData('mariadb-data', Buffer.from('backed up rows'));
    const file = await backup('db');
    world.host.docker.setVolumeData('mariadb-data', Buffer.from('live rows'));

    world.host.crashAfter({ stdinBytes: 10 }, 'a');
    const restore = await a.jamal(['restore', 'db', file, '--yes']);
    assert.notEqual(restore.code, 0);
    assert.equal(world.host.docker.volumeData('mariadb-data')?.toString(), 'live rows');
  });
});
