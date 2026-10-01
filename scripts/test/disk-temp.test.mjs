/**
 * Tests for `scripts/disk-temp.mjs`: a tmpfs temporary directory is replaced
 * by one under the user's cache directory (outside the repository), anything
 * else is used as is, a root named for later creation lands in the same place,
 * a sweep removes only old directories of runs whose process is gone, and the
 * free-space watch keeps the lowest reading.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  STALE_AGE_MS,
  TMPFS_MAGIC,
  diskBackedTempRoot,
  diskTempBase,
  diskTempPath,
  sweepStaleTempRoots,
  watchFreeSpace,
} from '../disk-temp.mjs';
import { repoRoot } from '../workspaces.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'jsails-disk-temp-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const tmpfs = () => ({ type: TMPFS_MAGIC });
const ext4 = () => ({ type: 0xef53 });

/**
 * Whether `path` lies outside the repository: above it, or on another drive,
 * where `relative` returns the absolute path itself (a Windows checkout on
 * `D:` with the profile and temporary directory on `C:`).
 */
function outsideRepository(path) {
  const rel = relative(repoRoot, path);
  return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
}

describe('diskTempBase', () => {
  it('moves a tmpfs temporary directory to the cache directory, outside the repository', () => {
    const base = diskTempBase({ platform: 'linux', statfs: tmpfs, env: {}, home: '/home/u' });
    assert.equal(base, join('/home/u', '.cache', 'jsails', 'tmp'));
    assert.equal(
      diskTempBase({ platform: 'linux', statfs: tmpfs, env: { XDG_CACHE_HOME: '/c' } }),
      join('/c', 'jsails', 'tmp'),
    );
    assert.ok(outsideRepository(diskTempBase({ platform: 'linux', statfs: tmpfs })));
  });

  it('keeps a disk-backed temporary directory, and every non-Linux one', () => {
    assert.equal(diskTempBase({ platform: 'linux', statfs: ext4 }), undefined);
    assert.equal(diskTempBase({ platform: 'darwin', statfs: tmpfs }), undefined);
    assert.equal(diskTempBase({ platform: 'win32', statfs: tmpfs }), undefined);
    const broken = () => {
      throw new Error('ENOSYS');
    };
    assert.equal(diskTempBase({ platform: 'linux', statfs: broken }), undefined);
  });
});

describe('diskBackedTempRoot', () => {
  it('creates a fresh directory named for the label and this process', () => {
    const cache = join(scratch, 'cache');
    const root = diskBackedTempRoot('coverage', {
      platform: 'linux',
      statfs: tmpfs,
      env: { XDG_CACHE_HOME: cache },
    });
    assert.ok(existsSync(root));
    assert.equal(join(root, '..'), join(cache, 'jsails', 'tmp'));
    assert.match(basename(root), new RegExp(`^coverage-${process.pid}-[A-Za-z0-9]{6}$`));
    const plain = diskBackedTempRoot('verify', { platform: 'linux', statfs: ext4, tmp: scratch });
    assert.equal(join(plain, '..'), scratch);
  });
});

describe('diskTempPath', () => {
  it('names a root to create later, in the same place, outside the repository', () => {
    const cache = join(scratch, 'later-cache');
    const now = Date.UTC(2026, 0, 1);
    const path = diskTempPath('jsails-verify', {
      platform: 'linux',
      statfs: tmpfs,
      env: { XDG_CACHE_HOME: cache },
      now,
      pid: 42,
    });
    assert.equal(path, join(cache, 'jsails', 'tmp', `jsails-verify-42-${now.toString(36)}`));
    assert.equal(existsSync(path), false, 'the caller creates it');
    assert.ok(outsideRepository(path));
    // A root it names is one the sweep recognises once its run is gone.
    mkdirSync(path, { recursive: true });
    utimesSync(path, new Date(now), new Date(now));
    assert.deepEqual(
      sweepStaleTempRoots(join(cache, 'jsails', 'tmp'), {
        now: now + STALE_AGE_MS + 1,
        alive: () => false,
      }),
      [basename(path)],
    );
    assert.equal(
      diskTempPath('v', { platform: 'darwin', tmp: scratch, now, pid: 7 }),
      join(scratch, `v-7-${now.toString(36)}`),
    );
  });
});

describe('sweepStaleTempRoots', () => {
  it('removes old directories of dead runs only', async () => {
    const base = join(scratch, 'sweep');
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((resolve) => child.on('exit', resolve));
    const dead = child.pid;
    const old = new Date(Date.now() - STALE_AGE_MS - 60_000);
    const make = (name, mtime) => {
      mkdirSync(join(base, name), { recursive: true });
      if (mtime !== undefined) utimesSync(join(base, name), mtime, mtime);
    };
    make(`coverage-${dead}-aaaaaa`, old);
    make(`coverage-${dead}-bbbbbb`);
    make(`verify-${process.pid}-cccccc`, old);
    make('unrelated', old);
    assert.deepEqual(sweepStaleTempRoots(base), [`coverage-${dead}-aaaaaa`]);
    assert.ok(existsSync(join(base, `coverage-${dead}-bbbbbb`)), 'a recent directory was removed');
    assert.ok(existsSync(join(base, `verify-${process.pid}-cccccc`)), 'a live run lost its root');
    assert.ok(existsSync(join(base, 'unrelated')));
    assert.deepEqual(sweepStaleTempRoots(join(scratch, 'missing')), []);
  });
});

describe('watchFreeSpace', () => {
  it('keeps the lowest free space seen until stopped, across failed readings', async () => {
    const mib = 1024 * 1024;
    // Free space falls as dumps pile up, a reading fails, then the run frees it again.
    const readings = [900, 300, undefined, 40, 700];
    let calls = 0;
    const statfs = () => {
      const mb = readings[Math.min(calls, readings.length - 1)];
      calls += 1;
      if (mb === undefined) throw new Error('ENOENT');
      return { bavail: (mb * mib) / 4096, bsize: 4096 };
    };
    const watch = watchFreeSpace('/coverage', { statfs, intervalMs: 1 });
    while (calls < readings.length) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(watch.stop(), 40);
    const stopped = calls;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, stopped, 'sampled after stop');
  });

  it('reads nothing where the file system cannot be read, and a real one otherwise', () => {
    const broken = () => {
      throw new Error('ENOSYS');
    };
    assert.equal(watchFreeSpace('/x', { statfs: broken }).stop(), undefined);
    const real = watchFreeSpace(scratch).stop();
    assert.ok(Number.isInteger(real) && real >= 0, String(real));
  });
});
