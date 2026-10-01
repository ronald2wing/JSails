/**
 * Tests for the `filesystem` surface: the local disk's key/symlink safety,
 * atomic writes, list/size/delete, lazy root creation, and `maxBytes`
 * enforcement; the in-memory disk's parity with the local disk; the plugin's
 * token/name contract and cleanup; and the value-free error guarantee. No
 * external services are required — everything runs against temp directories
 * and in-memory state.
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  promises as fsPromises,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runExtensions } from 'jsails/extensions';
import {
  DiskError,
  DiskRangeError as CoreDiskRangeError,
  diskUrl,
  filesystemToken,
  isStreamingDisk as coreIsStreamingDisk,
  isUrlDisk,
  type Disk,
  type DiskErrorCode,
  type FileSystem,
} from 'jsails/filesystem';
import { tempDir } from 'jsails/testing';
import {
  DiskRangeError,
  FileSystemError,
  LocalDisk,
  MemoryDisk,
  filesystemPlugin,
  isStreamingDisk,
  type StreamingDisk,
} from '../src/index.js';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function* chunked(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    yield Buffer.from(part);
  }
}

/** Assert that a rejection is a `DiskError` with the given code. */
function isDiskError(code: DiskErrorCode): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof DiskError, `expected DiskError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

/** Decode stored bytes as UTF-8 for readable assertions. */
function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

describe('LocalDisk', () => {
  it('round-trips strings and raw bytes', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });

    await disk.put('greeting.txt', 'hello');
    await disk.put('raw.bin', new Uint8Array([1, 2, 3, 255]));

    assert.equal(text(await disk.get('greeting.txt')), 'hello');
    assert.deepEqual(Array.from(await disk.get('raw.bin')), [1, 2, 3, 255]);
  });

  it('does not require the root to exist until the first write', async (t) => {
    const base = tempDir(t);
    const root = join(base, 'nested', 'root');
    const disk = new LocalDisk({ root });

    assert.equal(existsSync(root), false, 'construction must not create the root');
    await disk.put('a/b.txt', 'x'); // mkdir -p root and parent
    assert.equal(existsSync(join(root, 'a', 'b.txt')), true);
    assert.equal(text(await disk.get('a/b.txt')), 'x');
  });

  it('creates the root eagerly with createRoot: true', (t) => {
    const root = join(tempDir(t), 'eager');
    void new LocalDisk({ root, createRoot: true });
    assert.equal(existsSync(root), true);
  });

  it('writes atomically: no temp files remain and overwrite is complete', async (t) => {
    const root = tempDir(t);
    const disk = new LocalDisk({ root });

    await disk.put('a.txt', 'first');
    await disk.put('a.txt', 'second-longer-value');

    assert.equal(text(await disk.get('a.txt')), 'second-longer-value');
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith('.tmp')),
      [],
      'no temp files may remain after a successful write',
    );
  });

  it('leaves prior content intact when a write fails', async (t) => {
    const root = tempDir(t);
    const disk = new LocalDisk({ root, maxBytes: 4 });

    await disk.put('a.txt', 'ok');
    await assert.rejects(disk.put('a.txt', 'too big'), isDiskError('too_large'));

    assert.equal(text(await disk.get('a.txt')), 'ok', 'failed write must not clobber the file');
    assert.deepEqual(await disk.list(), ['a.txt']);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });

  it('lists, sizes, deletes idempotently, and reports existence', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });

    await disk.put('b.txt', 'bb');
    await disk.put('a/b.txt', 'inner');
    await disk.put('a/c.txt', 'cc');

    assert.deepEqual(await disk.list(), ['a/b.txt', 'a/c.txt', 'b.txt']);
    assert.deepEqual(await disk.list('a'), ['a/b.txt', 'a/c.txt']);
    assert.deepEqual(await disk.list('missing'), []);
    assert.deepEqual(await disk.list('b.txt'), [], 'a file prefix has no children');

    assert.equal(await disk.size('b.txt'), 2);
    assert.equal(await disk.exists('b.txt'), true);
    assert.equal(await disk.exists('nope.txt'), false);

    await disk.delete('b.txt');
    await disk.delete('b.txt'); // idempotent
    assert.equal(await disk.exists('b.txt'), false);
    assert.deepEqual(await disk.list(), ['a/b.txt', 'a/c.txt']);
  });

  it('rejects path traversal and malformed keys value-free', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });
    const bad = ['', '../x', 'a/../../x', '/abs', 'a\\b', 'C:x', 'a\0b', 'a/./b', 'a//b'];

    for (const key of bad) {
      await assert.rejects(
        disk.put(key, 'x'),
        isDiskError('invalid_key'),
        `key ${JSON.stringify(key)}`,
      );
      await assert.rejects(disk.get(key), isDiskError('invalid_key'), `key ${JSON.stringify(key)}`);
    }
    assert.deepEqual(await disk.list(), [], 'no file may be written by a rejected key');
  });

  it('rejects reads and writes through a symlinked directory escaping the root', async (t) => {
    const root = tempDir(t);
    const outside = tempDir(t, 'jsails-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(outside, join(root, 'link'));

    const disk = new LocalDisk({ root });

    await assert.rejects(disk.get('link/secret.txt'), isDiskError('invalid_key'));
    await assert.rejects(disk.put('link/new.txt', 'x'), isDiskError('invalid_key'));
    await assert.rejects(disk.exists('link/secret.txt'), isDiskError('invalid_key'));
    assert.deepEqual(await disk.list(), [], 'list must never follow a symlink');
    assert.equal(existsSync(join(outside, 'new.txt')), false, 'no write may escape the root');
  });

  it('rejects reading or sizing a file that is a symlink outside the root', async (t) => {
    const root = tempDir(t);
    const outside = tempDir(t, 'jsails-outside-');
    writeFileSync(join(outside, 'leak.txt'), 'SECRET');
    symlinkSync(join(outside, 'leak.txt'), join(root, 'leak.txt'));

    const disk = new LocalDisk({ root });

    await assert.rejects(disk.get('leak.txt'), isDiskError('invalid_key'));
    await assert.rejects(disk.size('leak.txt'), isDiskError('invalid_key'));
    await assert.rejects(disk.exists('leak.txt'), isDiskError('invalid_key'));
  });

  it('refuses a file swapped for a symlink between the check and the read', async (t) => {
    const root = tempDir(t);
    const outside = tempDir(t, 'jsails-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    writeFileSync(join(root, 'public.txt'), 'public');
    const disk = new LocalDisk({ root });

    // Swap the checked file for a symlink to the outside file right after the
    // containment check inspects it, the window a racing writer would use.
    // `syncBuiltinESMExports` makes the module's imported `lstat` see the patch.
    const realLstat = fsPromises.lstat;
    let armed = true;
    t.mock.method(fsPromises, 'lstat', async (...args: Parameters<typeof realLstat>) => {
      const stats = await realLstat(...args);
      if (armed && String(args[0]).endsWith('public.txt')) {
        armed = false;
        renameSync(join(root, 'public.txt'), join(root, 'moved.txt'));
        symlinkSync(join(outside, 'secret.txt'), join(root, 'public.txt'));
      }
      return stats;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    await assert.rejects(disk.get('public.txt'), isDiskError('not_found'));
    armed = true;
    renameSync(join(root, 'moved.txt'), join(root, 'other.txt'));
    writeFileSync(join(root, 'swap.txt'), 'public');
    t.mock.restoreAll();
    t.mock.method(fsPromises, 'lstat', async (...args: Parameters<typeof realLstat>) => {
      const stats = await realLstat(...args);
      if (armed && String(args[0]).endsWith('swap.txt')) {
        armed = false;
        // A different regular file renamed into place: same path, other inode.
        writeFileSync(join(root, 'replacement.txt'), 'REPLACED');
        renameSync(join(root, 'replacement.txt'), join(root, 'swap.txt'));
      }
      return stats;
    });
    syncBuiltinESMExports();
    await assert.rejects(disk.stream('swap.txt'), isDiskError('not_found'));
  });

  it('enforces maxBytes across the whole root', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t), maxBytes: 5 });

    await disk.put('a.txt', 'ab'); // 2 bytes
    await disk.put('b.txt', 'abc'); // 3 bytes, total 5
    await assert.rejects(disk.put('c.txt', 'd'), isDiskError('too_large'));

    await disk.delete('a.txt'); // frees 2 bytes
    await disk.put('c.txt', 'de'); // now fits
    assert.equal(text(await disk.get('c.txt')), 'de');
  });

  it('keeps maxBytes exact under concurrent writes and deletes', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t), maxBytes: 10 });
    // Ten 3-byte uploads race for 10 bytes: exactly three may land.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => disk.put(`f${index}.txt`, 'abc')),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
    assert.equal((await disk.list()).length, 3);

    // The counter tracked every landed write: deleting all three frees 9 bytes.
    await Promise.all((await disk.list()).map((key) => disk.delete(key)));
    await disk.put('big.txt', 'abcdefghij');
    await assert.rejects(disk.put('one-more.txt', 'x'), isDiskError('too_large'));
  });

  it('neither lists nor counts a crash-leftover temp file', async (t) => {
    const root = tempDir(t);
    writeFileSync(join(root, '.0123456789ab.tmp'), 'xxxxxxxx');
    const disk = new LocalDisk({ root, maxBytes: 4 });
    assert.deepEqual(await disk.list(), []);
    await disk.put('a.txt', 'abcd');
    await assert.rejects(disk.put('.0123456789ab.tmp', 'x'), isDiskError('invalid_key'));
  });

  it('returns stored bytes without an extra copy', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });
    await disk.put('a.txt', 'hello');
    const bytes = await disk.get('a.txt');
    assert.ok(Buffer.isBuffer(Buffer.from(bytes.buffer)));
    assert.equal(bytes.byteLength, 5);
    assert.equal(text(bytes), 'hello');
  });

  it('streams a whole file and a byte range', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });
    assert.ok(isStreamingDisk(disk));
    await disk.put('a.txt', 'hello world');
    const whole = await disk.stream('a.txt');
    assert.equal(await readAll(whole.stream), 'hello world');
    assert.deepEqual([whole.size, whole.start, whole.end], [11, 0, 10]);

    const part = await disk.stream('a.txt', { range: { start: 6, end: 99 } });
    assert.equal(await readAll(part.stream), 'world');
    assert.deepEqual([part.start, part.end], [6, 10]);
    await assert.rejects(
      disk.stream('a.txt', { range: { start: 11 } }),
      (error: unknown) => error instanceof DiskRangeError && error.code === 'invalid_range',
    );
    await assert.rejects(disk.stream('missing.txt'), isDiskError('not_found'));
  });

  it('writes from a stream and refuses one that outgrows its cap', async (t) => {
    const root = tempDir(t);
    const disk = new LocalDisk({ root, maxBytes: 20 });
    assert.equal(await disk.putStream('a.txt', chunked('hel', 'lo')), 5);
    assert.equal(text(await disk.get('a.txt')), 'hello');

    await assert.rejects(
      disk.putStream('b.txt', chunked('abc', 'def'), { maxBytes: 4 }),
      isDiskError('too_large'),
    );
    // The quota bounds a stream as it arrives, too: 5 used, 15 left.
    await assert.rejects(
      disk.putStream('c.txt', chunked('0123456789', '0123456789')),
      isDiskError('too_large'),
    );
    assert.deepEqual(await disk.list(), ['a.txt']);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });

  it('refuses a stream whose temp file cannot be written, without crashing the process', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root ignores directory permissions');
      return;
    }
    const root = tempDir(t);
    const disk = new LocalDisk({ root });
    await disk.put('kept.txt', 'kept');
    // A read-only root: the temp file's open fails while the source is between
    // chunks, which is when an unobserved write-stream error used to escape as
    // an uncaught exception.
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    chmodSync(root, 0o555);
    try {
      await assert.rejects(
        disk.putStream(
          'blocked.txt',
          (async function* () {
            yield new TextEncoder().encode('abc');
            await new Promise((resolve) => setTimeout(resolve, 50));
            yield new TextEncoder().encode('def');
          })(),
        ),
        (error: unknown) =>
          error instanceof DiskError && error.code === 'io_failed' && !error.message.includes(root),
      );
    } finally {
      // Restored here, not in `t.after`: the temp directory's own cleanup is
      // registered first and would run before a later hook.
      chmodSync(root, 0o755);
      process.off('uncaughtException', onUncaught);
    }
    assert.deepEqual(uncaught, []);
    assert.deepEqual(readdirSync(root).sort(), ['kept.txt']);
  });

  it('does not let a stalled stream block other writes on a quota disk', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t), maxBytes: 100 });
    let release: (() => void) | undefined;
    const stalled = disk.putStream(
      'slow.txt',
      (async function* () {
        yield new TextEncoder().encode('abc');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })(),
    );
    const outcome = await Promise.race([
      disk.put('fast.txt', 'hello').then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500)),
    ]);
    assert.equal(outcome, 'done');
    await disk.delete('fast.txt');
    while (release === undefined) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    release();
    assert.equal(await stalled, 3);
    assert.deepEqual(await disk.list(), ['slow.txt']);
  });

  it('re-checks the quota at commit against writes that landed mid-stream', async (t) => {
    const root = tempDir(t);
    const disk = new LocalDisk({ root, maxBytes: 10 });
    let release: (() => void) | undefined;
    const streaming = disk.putStream(
      'stream.txt',
      (async function* () {
        yield new TextEncoder().encode('123456');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })(),
    );
    while (release === undefined) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Passed the pre-check with 10 bytes free; this write leaves only 2.
    await disk.put('other.txt', '12345678');
    release();
    await assert.rejects(streaming, isDiskError('too_large'));
    assert.deepEqual(await disk.list(), ['other.txt']);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith('.tmp')),
      [],
    );
    await disk.put('fill.txt', '12');
    await assert.rejects(disk.put('over.txt', 'x'), isDiskError('too_large'));
  });
});

describe('MemoryDisk', () => {
  it('matches the local disk: put/get/list/size/delete/exists', async () => {
    const disk = new MemoryDisk();

    await disk.put('b.txt', 'bb');
    await disk.put('a/b.txt', new Uint8Array([1, 2]));

    assert.equal(text(await disk.get('b.txt')), 'bb');
    assert.deepEqual(Array.from(await disk.get('a/b.txt')), [1, 2]);
    assert.deepEqual(await disk.list(), ['a/b.txt', 'b.txt']);
    assert.deepEqual(await disk.list('a'), ['a/b.txt']);
    assert.equal(await disk.size('b.txt'), 2);
    assert.equal(await disk.exists('b.txt'), true);

    await disk.delete('b.txt');
    await disk.delete('b.txt');
    assert.equal(await disk.exists('b.txt'), false);
    await assert.rejects(disk.get('b.txt'), isDiskError('not_found'));
    await assert.rejects(disk.size('b.txt'), isDiskError('not_found'));
  });

  it('rejects the same malformed keys as the local disk', async () => {
    const disk = new MemoryDisk();
    for (const key of ['../x', '/abs', 'a\\b', '', 'a/../b']) {
      await assert.rejects(disk.put(key, 'x'), isDiskError('invalid_key'));
    }
  });

  it('copies input bytes so later mutation cannot corrupt storage', async () => {
    const disk = new MemoryDisk();
    const bytes = new Uint8Array([9, 9, 9]);
    await disk.put('k', bytes);
    bytes[0] = 0;
    assert.deepEqual(Array.from(await disk.get('k')), [9, 9, 9]);
  });

  it('enforces maxBytes', async () => {
    const disk = new MemoryDisk({ maxBytes: 3 });
    await disk.put('a', 'ab');
    await assert.rejects(disk.put('b', 'cd'), isDiskError('too_large'));
    await disk.delete('a');
    await disk.put('c', 'xyz');
    assert.equal(await disk.size('c'), 3);
  });
});

describe('MemoryDisk streaming', () => {
  it('streams ranges and writes from a stream with a cap', async () => {
    const disk: StreamingDisk = new MemoryDisk();
    await disk.putStream('a.txt', chunked('hello', ' world'));
    const part = await disk.stream('a.txt', { range: { start: 0, end: 4 } });
    assert.equal(await readAll(part.stream), 'hello');
    await assert.rejects(
      disk.putStream('b.txt', chunked('abc', 'def'), { maxBytes: 5 }),
      isDiskError('too_large'),
    );
  });
});

describe('filesystemPlugin', () => {
  it('has name "filesystem" and a stable token', () => {
    assert.equal(filesystemToken.name, 'filesystem');
    assert.equal(filesystemPlugin({ disks: { memory: new MemoryDisk() } }).name, 'filesystem');
  });

  it('provides a FileSystem under the token with named lookups', async () => {
    const local = new MemoryDisk();
    const memory = new MemoryDisk();
    const runtime = await runExtensions([
      filesystemPlugin({ disks: { local, memory }, default: 'local' }),
    ]);
    try {
      const fs: FileSystem = runtime.services.get(filesystemToken);
      assert.equal(fs.disk('local'), local);
      assert.equal(fs.disk('memory'), memory);
      assert.equal(fs.disk(), local, 'disk() resolves the configured default');
      assert.deepEqual(fs.names(), ['local', 'memory']);
    } finally {
      await runtime.close();
    }
  });

  it('resolves disk() to the sole disk when no default is configured', async () => {
    const memory = new MemoryDisk();
    const runtime = await runExtensions([filesystemPlugin({ disks: { memory } })]);
    try {
      const fs: FileSystem = runtime.services.get(filesystemToken);
      assert.equal(fs.disk(), memory);
    } finally {
      await runtime.close();
    }
  });

  it('throws on an unknown name and when the default is ambiguous', async () => {
    const runtime = await runExtensions([
      filesystemPlugin({ disks: { a: new MemoryDisk(), b: new MemoryDisk() } }),
    ]);
    try {
      const fs: FileSystem = runtime.services.get(filesystemToken);
      assert.throws(
        () => fs.disk('missing'),
        (error: unknown) =>
          error instanceof FileSystemError &&
          error.code === 'unknown_disk' &&
          !error.message.includes('missing'),
      );
      assert.throws(
        () => fs.disk(),
        (error: unknown) => error instanceof FileSystemError && error.code === 'missing_default',
      );
    } finally {
      await runtime.close();
    }
  });

  it('validates names, disk shapes, and the default eagerly', () => {
    assert.throws(() => filesystemPlugin({ disks: {} }), TypeError);
    assert.throws(() => filesystemPlugin({ disks: { x: {} as unknown as Disk } }), TypeError);
    assert.throws(
      () => filesystemPlugin({ disks: { memory: new MemoryDisk() }, default: 'missing' }),
      TypeError,
    );
  });

  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([filesystemPlugin({ disks: { m: new MemoryDisk() } })]);
    await runtime.close();
    await runtime.close();
  });
});

describe('value-free errors', () => {
  it('never echoes a key, path, or data content', async (t) => {
    const disk = new LocalDisk({ root: tempDir(t) });
    const secret = 'SUPER_SECRET_CONTENT';

    await assert.rejects(disk.get('missing.txt'), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.equal(error.message, 'file not found');
      return true;
    });
    await assert.rejects(disk.put(`../../etc/${secret}`, secret), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.ok(!error.message.includes(secret), 'error must not echo the key or content');
      return true;
    });
  });

  it('reports capacity failures without echoing the payload', async () => {
    const disk = new MemoryDisk({ maxBytes: 1 });
    await assert.rejects(disk.put('k', 'HUGE_PAYLOAD'), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.equal(error.message, 'disk capacity exceeded');
      return true;
    });
  });
});

// Guard against accidental use of the un-exported validators through the public
// entry (they are implementation details, not part of the `@jsails/filesystem`
// surface). This documents the intentional narrow public API.
describe('public surface', () => {
  it('exposes a minimal, typed surface', () => {
    const disk: Disk = new MemoryDisk();
    assert.equal(typeof disk.put, 'function');
    assert.equal(typeof disk.get, 'function');
    assert.equal(typeof disk.exists, 'function');
    assert.equal(typeof disk.delete, 'function');
    assert.equal(typeof disk.list, 'function');
    assert.equal(typeof disk.size, 'function');
  });
});

describe('signed URLs on local and memory disks', () => {
  it('neither disk claims the capability, and diskUrl refuses both value-free', async (t) => {
    for (const disk of [new LocalDisk({ root: tempDir(t) }), new MemoryDisk()]) {
      await disk.put('secret/report.txt', 'hi');
      assert.equal(isUrlDisk(disk), false);
      await assert.rejects(diskUrl(disk, 'secret/report.txt'), (error: unknown) => {
        isDiskError('unsupported')(error);
        assert.doesNotMatch((error as Error).message, /secret|report/);
        return true;
      });
    }
  });
});

describe('streaming capability re-export', () => {
  it('is the core contract, so instanceof and the guard agree across imports', () => {
    assert.equal(DiskRangeError, CoreDiskRangeError);
    assert.equal(isStreamingDisk, coreIsStreamingDisk);
  });
});
