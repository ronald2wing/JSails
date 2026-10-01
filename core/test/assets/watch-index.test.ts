/**
 * The development asset index: lazy hashing, per-request freshness, and
 * invalidation by a watcher.
 *
 * The watcher is injected, so every platform runs the same invalidation
 * cases: a test fires its events and errors by hand. One case uses the real
 * recursive `fs.watch` and waits for the index's own change notification up
 * to a deadline that fails it with the reason. Its one fixed wait outlasts
 * the default watcher's late event, so that the second file it adds can only
 * show through a real platform event.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AssetErrors } from '../../src/assets/asset-errors.js';
import { createAssetIndex, type WatchAssetRoot } from '../../src/assets/asset-index.js';
import { withSettleEvent } from '../../src/assets/watch-index.js';

const workspace = mkdtempSync(join(tmpdir(), 'jsails-watch-index-'));
after(() => rmSync(workspace, { recursive: true, force: true }));

/** A permission bit denies this process a read: not as root, and not on Windows. */
const permissionsHold =
  process.platform === 'win32'
    ? 'Windows ignores the POSIX read bits'
    : process.getuid?.() === 0
      ? 'root reads any file'
      : false;

/**
 * How long the platform-watcher case waits for each change: far past the
 * default watcher's late event a second after it opens, far under the test
 * timeout.
 */
const WATCH_DEADLINE_MS = 30_000;

/**
 * The default watcher's settle time (`WATCH_SETTLE_MS` in asset-index.ts):
 * past it, that watcher has reported its one late event.
 */
const DEFAULT_WATCH_SETTLE_MS = 1000;

function caseDir(): string {
  return mkdtempSync(join(workspace, 'case-'));
}

function write(dir: string, relative: string, contents: string): string {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function hashOf(contents: string): string {
  return createHash('sha256').update(contents).digest('base64url').slice(0, 16);
}

/** A hand-driven watcher: `fire` and `fail` stand for the platform's events. */
function manualWatch(): {
  readonly watch: WatchAssetRoot;
  fire(): void;
  fail(): void;
  readonly opened: number;
  readonly closed: number;
  unwatchable: boolean;
} {
  let onEvent: (() => void) | undefined;
  let onError: ((error: unknown) => void) | undefined;
  const state = {
    opened: 0,
    closed: 0,
    unwatchable: false,
    watch: ((_dir, event, error) => {
      if (state.unwatchable) throw new Error('no watch handles left');
      state.opened += 1;
      onEvent = event;
      onError = error;
      return {
        close: () => {
          state.closed += 1;
        },
      };
    }) as WatchAssetRoot,
    fire: () => onEvent?.(),
    fail: () => onError?.(new Error('watcher failed')),
  };
  return state;
}

describe('createAssetIndex (watch)', () => {
  it('hashes a file on first use, and again when its size or mtime changes', async () => {
    const pub = caseDir();
    const file = write(pub, 'app.js', 'alpha');
    const watcher = manualWatch();
    const index = await createAssetIndex({
      roots: [{ dir: pub }],
      mode: 'watch',
      watch: watcher.watch,
    });
    try {
      assert.equal(index.source, 'watch');
      assert.equal(index.url('/app.js'), `/app.js?v=${hashOf('alpha')}`);

      // No watcher event: the request itself sees the new size.
      writeFileSync(file, 'bravo-echo');
      assert.equal(index.url('/app.js'), `/app.js?v=${hashOf('bravo-echo')}`);

      // The same size, a new mtime.
      writeFileSync(file, 'charlie-ec');
      const future = new Date(Date.now() + 5_000);
      utimesSync(file, future, future);
      const entry = index.get('/app.js');
      assert.equal(entry?.hash, hashOf('charlie-ec'));
      assert.equal(entry?.inline, undefined, 'a development entry is always read from its file');
    } finally {
      index.close();
    }
  });

  it('finds added and removed files after a watch event, and tells its listeners', async () => {
    const pub = caseDir();
    write(pub, 'a.txt', 'a');
    const watcher = manualWatch();
    const index = await createAssetIndex({
      roots: [{ dir: pub }],
      mode: 'watch',
      watch: watcher.watch,
    });
    let changes = 0;
    index.onChange(() => {
      changes += 1;
    });
    try {
      write(pub, 'b.txt', 'b');
      // Without an event the index has not looked.
      assert.deepEqual([...index.paths()], ['/a.txt']);
      watcher.fire();
      assert.deepEqual([...index.paths()], ['/a.txt', '/b.txt']);
      assert.equal(index.get('/b.txt')?.hash, hashOf('b'));
      assert.equal(changes, 1);

      unlinkSync(join(pub, 'a.txt'));
      // A removed file is gone for the request that asks for it, event or not.
      assert.equal(index.get('/a.txt'), undefined);
      assert.deepEqual([...index.paths()], ['/b.txt']);
      assert.equal(changes, 2);

      // A content change alone does not change the set of paths.
      writeFileSync(join(pub, 'b.txt'), 'bb');
      watcher.fire();
      assert.deepEqual([...index.paths()], ['/b.txt']);
      assert.equal(changes, 2);
    } finally {
      index.close();
    }
  });

  it('reopens a failed watcher and walks again', async () => {
    const pub = caseDir();
    write(pub, 'a.txt', 'a');
    const watcher = manualWatch();
    const index = await createAssetIndex({
      roots: [{ dir: pub }],
      mode: 'watch',
      watch: watcher.watch,
    });
    try {
      assert.equal(watcher.opened, 1);
      write(pub, 'b.txt', 'b');
      watcher.fail();
      assert.equal(watcher.closed, 1);
      assert.deepEqual([...index.paths()], ['/a.txt', '/b.txt']);
      assert.equal(watcher.opened, 2);
    } finally {
      index.close();
    }
    assert.equal(watcher.closed, 2);
  });

  it('walks on every access while a root cannot be watched', async () => {
    const pub = caseDir();
    write(pub, 'a.txt', 'a');
    const watcher = manualWatch();
    watcher.unwatchable = true;
    const index = await createAssetIndex({
      roots: [{ dir: pub }],
      mode: 'watch',
      watch: watcher.watch,
    });
    try {
      write(pub, 'b.txt', 'b');
      assert.deepEqual([...index.paths()], ['/a.txt', '/b.txt']);
      watcher.unwatchable = false;
      write(pub, 'c.txt', 'c');
      assert.deepEqual([...index.paths()], ['/a.txt', '/b.txt', '/c.txt']);
      assert.equal(watcher.opened, 1);
    } finally {
      index.close();
    }
  });

  it('closes every watcher it opened when the first walk fails', async () => {
    const first = caseDir();
    const second = caseDir();
    write(first, 'same.txt', '1');
    write(second, 'same.txt', '2');
    const watcher = manualWatch();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await assert.rejects(
        () =>
          createAssetIndex({
            roots: [{ dir: first }, { dir: second }],
            mode: 'watch',
            watch: watcher.watch,
          }),
        (error: unknown) => AssetErrors.is(error, 'duplicate_asset'),
      );
      assert.equal(watcher.opened, 2 * attempt);
      assert.equal(watcher.closed, watcher.opened, 'no watcher outlives the failed build');
    }
  });

  it('walks again on the next access after a walk that failed', async () => {
    const first = caseDir();
    const second = caseDir();
    write(first, 'a.txt', 'a');
    const watcher = manualWatch();
    const index = await createAssetIndex({
      roots: [{ dir: first }, { dir: second }],
      mode: 'watch',
      watch: watcher.watch,
    });
    try {
      const duplicate = write(second, 'a.txt', 'again');
      write(first, 'c.txt', 'c');
      watcher.fire();
      assert.throws(
        () => index.get('/a.txt'),
        (error: unknown) => AssetErrors.is(error, 'duplicate_asset'),
      );
      // No event reports the fix: the failed walk left the index stale.
      unlinkSync(duplicate);
      assert.deepEqual([...index.paths()], ['/a.txt', '/c.txt']);
    } finally {
      index.close();
    }
  });

  it('misses a file it may not read, and serves it once it can be read', async (t) => {
    if (permissionsHold) return t.skip(permissionsHold);
    const pub = caseDir();
    const file = write(pub, 'locked.txt', 'secret');
    const watcher = manualWatch();
    const index = await createAssetIndex({
      roots: [{ dir: pub }],
      mode: 'watch',
      watch: watcher.watch,
    });
    try {
      chmodSync(file, 0o000);
      assert.equal(index.get('/locked.txt'), undefined);
      assert.deepEqual([...index.paths()], ['/locked.txt']);
      chmodSync(file, 0o644);
      assert.equal(index.get('/locked.txt')?.hash, hashOf('secret'));
    } finally {
      chmodSync(file, 0o644);
      index.close();
    }
  });

  it('stops watching and notifying when closed', async () => {
    const pub = caseDir();
    write(pub, 'a.txt', 'a');
    const watcher = manualWatch();
    const index = await createAssetIndex({
      roots: [{ dir: pub }],
      mode: 'watch',
      watch: watcher.watch,
    });
    let changes = 0;
    index.onChange(() => {
      changes += 1;
    });
    index.close();
    assert.equal(watcher.closed, 1);
    write(pub, 'b.txt', 'b');
    watcher.fire();
    assert.deepEqual([...index.paths()], ['/a.txt']);
    assert.equal(changes, 0);
  });

  it('sees a change made before the platform watcher was live, once it settles', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pub = caseDir();
    write(pub, 'a.txt', 'a');
    // The inner watcher never fires: the change below lands before its stream
    // is live, as on macOS right after `fs.watch` returns.
    const watcher = manualWatch();
    const index = await createAssetIndex({
      roots: [{ dir: pub }],
      mode: 'watch',
      watch: withSettleEvent(watcher.watch, 1000),
    });
    let changes = 0;
    index.onChange(() => {
      changes += 1;
    });
    try {
      write(pub, 'nested/b.txt', 'b');
      t.mock.timers.tick(999);
      assert.deepEqual([...index.paths()], ['/a.txt']);
      t.mock.timers.tick(1);
      assert.deepEqual([...index.paths()], ['/a.txt', '/nested/b.txt']);
      assert.equal(changes, 1);
    } finally {
      index.close();
    }
    assert.equal(watcher.closed, 1);
  });

  it('reports no late event after its watcher closes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let events = 0;
    const watcher = manualWatch();
    const watch = withSettleEvent(watcher.watch, 1000);
    watch(
      caseDir(),
      () => {
        events += 1;
      },
      () => undefined,
    ).close();
    t.mock.timers.tick(1000);
    assert.equal(events, 0);
    assert.equal(watcher.closed, 1);
  });

  it('follows new files through the platform watcher', async () => {
    const pub = caseDir();
    write(pub, 'a.txt', 'a');
    const index = await createAssetIndex({ roots: [{ dir: pub }], mode: 'watch' });
    try {
      let found = false;
      index.onChange(() => {
        found = true;
      });
      // The index looks again on access; ask until an event has marked it
      // stale (each ask is one walk of a small tree).
      const shows = async (added: string): Promise<void> => {
        const deadline = Date.now() + WATCH_DEADLINE_MS;
        while (!found) {
          if (Date.now() > deadline) {
            assert.fail(
              `the index did not see ${added} ${WATCH_DEADLINE_MS} ms after it was added under a watched root`,
            );
          }
          index.paths();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      // Added while the platform watcher may not be live yet: the default
      // watcher's late event alone can make this file show.
      write(pub, 'nested/b.txt', 'b');
      await shows('a file');
      assert.deepEqual([...index.paths()], ['/a.txt', '/nested/b.txt']);
      // Wait out the late event, so only the platform watcher can report the
      // next file. This timer starts after the watcher opened and is not
      // shorter, so node runs the late event's timer first.
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_WATCH_SETTLE_MS));
      index.paths();
      found = false;
      write(pub, 'nested/c.txt', 'c');
      await shows('a second file');
      assert.deepEqual([...index.paths()], ['/a.txt', '/nested/b.txt', '/nested/c.txt']);
    } finally {
      index.close();
    }
  });
});
