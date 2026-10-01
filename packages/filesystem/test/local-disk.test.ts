/**
 * `LocalDisk` beyond the shared contract: lazy and eager roots, symlink
 * containment (an escaping link, a file swapped between the check and the
 * open), directories that are not objects, empty-directory pruning, the
 * startup sweep of stale temp files, the exact quota under concurrency and a
 * stalled upload, a read-only directory, the Windows key rules, and bounded
 * memory for a 64 MiB write.
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  promises as fsPromises,
  readdirSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { DiskErrors, readBytes, readText } from 'jsails/filesystem';
import { tempDir } from 'jsails/testing';

import { LocalDisk } from '../src/index.js';

const IS_WINDOWS = process.platform === 'win32';
const MIB = 1024 * 1024;

/** A full garbage collection, without starting the test process with `--expose-gc`. */
function exposeGc(): () => void {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(DiskErrors.is(error), `expected disk.${code}, got ${String(error)}`);
    assert.equal(error.code, `disk.${code}`);
    return true;
  };
}

async function put(disk: LocalDisk, key: string, text: string): Promise<void> {
  await disk.write(key, bytes(text), { maxBytes: 1024 });
}

function tempFilesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) =>
    /\.[0-9a-f]{12}\.tmp$/.test(name),
  );
}

describe('LocalDisk roots', () => {
  it('creates nothing until the first write', async (t) => {
    const root = join(tempDir(t), 'lazy');
    const disk = new LocalDisk({ root });
    assert.equal(await disk.stat('a'), null);
    assert.deepEqual((await disk.list('', { limit: 10 })).keys, []);
    assert.equal(existsSync(root), false);
    await put(disk, 'nested/a.txt', 'a');
    assert.equal(await readText(disk, 'nested/a.txt', { maxBytes: 10 }), 'a');
  });

  it('creates the root at construction with createRoot', (t) => {
    const root = join(tempDir(t), 'eager');
    new LocalDisk({ root, createRoot: true });
    assert.equal(existsSync(root), true);
  });

  it('leaves the root untouched after createRoot until the first write', async (t) => {
    const root = tempDir(t);
    const stale = join(root, '.0123456789ab.tmp');
    writeFileSync(stale, 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const disk = new LocalDisk({ root, createRoot: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(stale), true);
    await put(disk, 'a.txt', 'a');
    assert.equal(existsSync(stale), false);
  });

  it('refuses malformed options with disk.invalid_option', () => {
    for (const options of [
      { root: '' },
      { root: 'x', maxBytes: -1 },
      { root: 'x', staleTempMs: 0 },
    ]) {
      assert.throws(() => new LocalDisk(options), isCode('invalid_option'));
    }
  });
});

describe('LocalDisk containment', () => {
  it('refuses reads and writes through a symlinked directory escaping the root', async (t) => {
    if (IS_WINDOWS) return t.skip('symlinks need elevated rights on Windows');
    const root = tempDir(t);
    const outside = tempDir(t, 'jsails-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(outside, join(root, 'link'));
    const disk = new LocalDisk({ root });
    await assert.rejects(disk.read('link/secret.txt'), isCode('invalid_key'));
    await assert.rejects(put(disk, 'link/new.txt', 'x'), isCode('invalid_key'));
    await assert.rejects(disk.stat('link/secret.txt'), isCode('invalid_key'));
    assert.deepEqual((await disk.list('', { limit: 10 })).keys, []);
    assert.equal(existsSync(join(outside, 'new.txt')), false);
  });

  it('refuses a stored file that is a symlink outside the root', async (t) => {
    if (IS_WINDOWS) return t.skip('symlinks need elevated rights on Windows');
    const root = tempDir(t);
    const outside = tempDir(t, 'jsails-outside-');
    writeFileSync(join(outside, 'leak.txt'), 'SECRET');
    symlinkSync(join(outside, 'leak.txt'), join(root, 'leak.txt'));
    const disk = new LocalDisk({ root });
    await assert.rejects(disk.read('leak.txt'), isCode('invalid_key'));
    await assert.rejects(disk.stat('leak.txt'), isCode('invalid_key'));
  });

  it('refuses a file swapped between the containment check and the open', async (t) => {
    if (IS_WINDOWS) return t.skip('symlinks need elevated rights on Windows');
    const root = tempDir(t);
    const outside = tempDir(t, 'jsails-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    writeFileSync(join(root, 'public.txt'), 'public');
    writeFileSync(join(root, 'swap.txt'), 'public');
    const disk = new LocalDisk({ root });
    // `syncBuiltinESMExports` makes the disk's imported `lstat` see the patch.
    const realLstat = fsPromises.lstat;
    let swap: ((path: string) => void) | undefined;
    t.mock.method(fsPromises, 'lstat', async (...args: Parameters<typeof realLstat>) => {
      const stats = await realLstat(...args);
      const action = swap;
      if (action !== undefined) {
        swap = undefined;
        action(String(args[0]));
      }
      return stats;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    swap = () => {
      renameSync(join(root, 'public.txt'), join(root, 'moved.txt'));
      symlinkSync(join(outside, 'secret.txt'), join(root, 'public.txt'));
    };
    await assert.rejects(disk.read('public.txt'), isCode('not_found'));
    swap = () => {
      // Another regular file renamed into place: same path, other inode.
      writeFileSync(join(root, 'replacement.txt'), 'REPLACED');
      renameSync(join(root, 'replacement.txt'), join(root, 'swap.txt'));
    };
    await assert.rejects(disk.read('swap.txt'), isCode('not_found'));
  });

  it('refuses keys that use the reserved temp-file name', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });
    await assert.rejects(put(disk, 'a/.0123456789ab.tmp', 'x'), isCode('invalid_key'));
  });

  it('refuses the names Windows reserves, on Windows', { skip: !IS_WINDOWS }, async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });
    for (const key of ['a:stream', 'CON', 'nul.txt', 'com1', 'trailing.', 'space ', 'q?']) {
      await assert.rejects(put(disk, key, 'x'), isCode('invalid_key'));
    }
  });
});

describe('LocalDisk directories', () => {
  it('reports a directory as absent and refuses to write over one', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });
    await put(disk, 'photos/cat.jpg', 'cat');
    assert.equal(await disk.stat('photos'), null);
    await assert.rejects(disk.read('photos'), isCode('not_found'));
    await assert.rejects(put(disk, 'photos', 'x'), isCode('key_collision'));
    await assert.rejects(put(disk, 'photos/cat.jpg/whiskers', 'x'), isCode('key_collision'));
    await disk.delete('photos');
    assert.equal(await readText(disk, 'photos/cat.jpg', { maxBytes: 10 }), 'cat');
  });

  it('prunes directories a delete leaves empty, so the key can become an object', async (t) => {
    const root = tempDir(t);
    const disk = new LocalDisk({ root });
    await put(disk, 'a/b/c.txt', 'c');
    await put(disk, 'a/d.txt', 'd');
    await disk.delete('a/b/c.txt');
    assert.equal(existsSync(join(root, 'a', 'b')), false);
    assert.equal(existsSync(join(root, 'a')), true);
    await disk.deletePrefix('a');
    assert.deepEqual(readdirSync(root), []);
    await put(disk, 'a', 'now a file');
    assert.equal(await readText(disk, 'a', { maxBytes: 20 }), 'now a file');
  });

  it('neither lists nor counts a temp file, and sweeps stale ones at the first write', async (t) => {
    const root = tempDir(t);
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, '.0123456789ab.tmp'), 'xxxxxxxx');
    writeFileSync(join(root, 'dir', '.ba9876543210.tmp'), 'yyyyyyyy');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(join(root, '.0123456789ab.tmp'), old, old);
    const disk = new LocalDisk({ root, maxBytes: 4 });
    assert.deepEqual((await disk.list('', { limit: 10 })).keys, []);
    await put(disk, 'a.txt', 'abcd'); // a fresh temp file does not count against the quota
    assert.deepEqual(tempFilesIn(root), [join('dir', '.ba9876543210.tmp')]);
  });
});

describe('LocalDisk quota', () => {
  it('frees space on delete', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t), maxBytes: 5 });
    await put(disk, 'a.txt', 'ab');
    await put(disk, 'b.txt', 'abc');
    await assert.rejects(put(disk, 'c.txt', 'd'), isCode('too_large'));
    await disk.delete('a.txt');
    await put(disk, 'c.txt', 'de');
  });

  it('stays exact under concurrent writes and deletes', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t), maxBytes: 10 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => put(disk, `f${index}.txt`, 'abc')),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
    const { keys } = await disk.list('', { limit: 100 });
    assert.equal(keys.length, 3);
    await Promise.all(keys.map((key) => disk.delete(key)));
    await put(disk, 'big.txt', 'abcdefghij');
    await assert.rejects(put(disk, 'one-more.txt', 'x'), isCode('too_large'));
  });

  it('does not let a stalled upload hold up other writes', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t), maxBytes: 100 });
    let release: (() => void) | undefined;
    const stalled = disk.write(
      'slow.txt',
      (async function* () {
        yield bytes('abc');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })(),
      { maxBytes: 100 },
    );
    const outcome = await Promise.race([
      put(disk, 'fast.txt', 'hello').then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500)),
    ]);
    assert.equal(outcome, 'done');
    while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.equal((await stalled).size, 3);
  });

  it('re-checks the quota at commit against writes that landed mid-stream', async (t) => {
    const root = tempDir(t);
    const disk = new LocalDisk({ root, maxBytes: 10 });
    let release: (() => void) | undefined;
    const streaming = disk.write(
      'stream.txt',
      (async function* () {
        yield bytes('123456');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })(),
      { maxBytes: 100 },
    );
    while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
    await put(disk, 'other.txt', '12345678');
    release();
    await assert.rejects(streaming, isCode('too_large'));
    assert.deepEqual((await disk.list('', { limit: 10 })).keys, ['other.txt']);
    assert.deepEqual(tempFilesIn(root), []);
  });
});

describe('LocalDisk failures', () => {
  it('refuses a write into a read-only directory and leaves nothing', async (t) => {
    if (IS_WINDOWS) return t.skip('directory modes are POSIX-only');
    if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
    const root = tempDir(t);
    const disk = new LocalDisk({ root });
    await put(disk, 'kept.txt', 'kept');
    chmodSync(root, 0o555);
    try {
      await assert.rejects(put(disk, 'blocked.txt', 'abc'), (error: unknown) => {
        isCode('io_failed')(error);
        assert.ok(!(error as Error).message.includes(root));
        return true;
      });
    } finally {
      // Restored here, not in `t.after`: the temp directory's own cleanup was
      // registered first and would run before a later hook.
      chmodSync(root, 0o755);
    }
    assert.deepEqual(readdirSync(root), ['kept.txt']);
  });

  it('streams a whole file and a range without buffering it', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });
    await put(disk, 'a.txt', 'hello world');
    const part = await disk.read('a.txt', { range: { start: 6, end: 99 } });
    assert.equal(await new Response(part.stream).text(), 'world');
    assert.deepEqual(
      Buffer.from(await readBytes(disk, 'a.txt', { maxBytes: 11 })).toString(),
      'hello world',
    );
  });
});

describe('LocalDisk memory', () => {
  it('writes 64 MiB in bounded memory', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });
    const gc = exposeGc();
    // Retained memory after a full collection: a fresh chunk per step means a
    // disk that kept chunks (or copies) alive would grow by each one.
    const retained = (): number => {
      gc();
      const { heapUsed, arrayBuffers } = process.memoryUsage();
      return heapUsed + arrayBuffers;
    };
    const baseline = retained();
    let peak = baseline;
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < 64; index += 1) {
        peak = Math.max(peak, retained());
        yield new Uint8Array(MIB).fill(index);
      }
    }
    const result = await disk.write('big.bin', source(), { maxBytes: 64 * MIB });
    assert.equal(result.size, 64 * MIB);
    assert.ok(peak - baseline < 16 * MIB, `peak grew by ${peak - baseline} bytes`);
  });
});
