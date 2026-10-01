/**
 * Tests for the recursive project watcher: event coalescing, ignore rules, and
 * teardown.
 */

import assert from 'node:assert/strict';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ChangeClass } from '../../src/dev/change-classify.js';
import { watchProject } from '../../src/dev/project-watcher.js';

/** A fake recursive watcher that exposes the event callback to the test. */
function fakeWatch() {
  let listener: ((event: string, filename: string | Buffer | null) => void) | undefined;
  let closed = 0;
  const watcher = {
    on(event: string, callback: (error: unknown) => void) {
      if (event === 'error') {
        errorListener = callback;
      }
      return watcher;
    },
    close() {
      closed += 1;
    },
  } as unknown as FSWatcher;
  let errorListener: ((error: unknown) => void) | undefined;

  const watch = ((_path: string, _options: unknown, callback: typeof listener) => {
    listener = callback;
    return watcher;
  }) as unknown as typeof import('node:fs').watch;

  return {
    watch,
    emit(event: string, filename: string | Buffer | null) {
      listener?.(event, filename);
    },
    emitError(error: unknown) {
      errorListener?.(error);
    },
    closed: () => closed,
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Start a watcher that records every reported class. */
function startWatcher(debounceMs = 5, pathApi?: Pick<typeof path, 'sep'>) {
  const h = fakeWatch();
  const changes: ChangeClass[] = [];
  const paths: Array<readonly string[] | undefined> = [];
  const errors: unknown[] = [];
  const watcher = watchProject('/project', {
    onChange: (change, burstPaths) => {
      changes.push(change);
      paths.push(burstPaths);
    },
    onError: (error) => {
      errors.push(error);
    },
    debounceMs,
    watch: h.watch,
    ...(pathApi === undefined ? {} : { pathApi }),
  });
  return { h, changes, paths, errors, watcher };
}

describe('watchProject', () => {
  it('coalesces a burst into one change callback', async () => {
    const { h, changes, watcher } = startWatcher();

    h.emit('change', 'dist/a.js');
    h.emit('change', 'dist/b.js');
    await wait(20);
    assert.deepEqual(changes, ['server-restart']);

    watcher.close();
  });

  it('reports the non-ignored paths of a burst, deduplicated', async () => {
    const { h, paths, watcher } = startWatcher();

    h.emit('change', 'dist/a.js');
    h.emit('change', 'node_modules/pkg/index.js');
    h.emit('change', 'dist/a.js');
    h.emit('change', 'public/assets/app.css');
    await wait(20);
    assert.deepEqual(paths, [['dist/a.js', 'public/assets/app.css']]);

    h.emit('change', 'dist/b.js');
    await wait(20);
    assert.deepEqual(paths[1], ['dist/b.js'], 'paths do not leak across bursts');

    watcher.close();
  });

  it('turns Windows-separated filenames into / ids before classifying them', async () => {
    const { h, changes, paths, watcher } = startWatcher(5, path.win32);

    h.emit('change', 'public\\assets\\app.css');
    h.emit('change', 'dist\\src\\index.js');
    h.emit('change', 'node_modules\\x\\index.js');
    await wait(20);
    assert.deepEqual(changes, ['server-restart']);
    assert.deepEqual(paths, [['public/assets/app.css', 'dist/src/index.js']]);

    watcher.close();
  });

  it('keeps a backslash in a POSIX filename as part of the name', async () => {
    const { h, paths, watcher } = startWatcher(5, path.posix);

    h.emit('change', 'dist/a\\b.js');
    await wait(20);
    assert.deepEqual(paths, [['dist/a\\b.js']]);

    watcher.close();
  });

  it('reports a client-only burst as a reload, not a restart', async () => {
    const { h, changes, watcher } = startWatcher();

    h.emit('change', 'public/assets/app.css');
    h.emit('change', 'public/assets/app.js');
    await wait(20);
    assert.deepEqual(changes, ['client-reload']);

    watcher.close();
  });

  it('lets a restart subsume a reload in the same burst', async () => {
    const { h, changes, watcher } = startWatcher();

    h.emit('change', 'public/assets/app.css');
    h.emit('change', 'dist/src/index.js');
    await wait(20);
    assert.deepEqual(changes, ['server-restart']);

    watcher.close();
  });

  it('does not report an all-ignored burst', async () => {
    const { h, changes, watcher } = startWatcher();

    h.emit('change', 'node_modules/pkg/index.js');
    h.emit('change', 'src/page.ts');
    h.emit('change', 'public/favicon.ico');
    await wait(20);
    assert.deepEqual(changes, []);

    watcher.close();
  });

  it('reports a settled burst of scanned source edits once, apart from restarts', async () => {
    const h = fakeWatch();
    const changes: ChangeClass[] = [];
    let metaCalls = 0;
    const watcher = watchProject('/project', {
      onChange: (change) => changes.push(change),
      onMetaSourceChange: () => {
        metaCalls += 1;
      },
      onError: () => {},
      debounceMs: 5,
      watch: h.watch,
    });

    h.emit('change', 'models/post.ts');
    h.emit('change', 'components/card/card.tsx');
    h.emit('change', 'server/thing.ts');
    await wait(20);
    assert.equal(metaCalls, 1);
    assert.deepEqual(changes, [], 'a .ts source edit is not a restart');

    h.emit('change', 'src/other.ts');
    h.emit('change', 'models/post.d.ts');
    h.emit('change', 'node_modules/x/models/a.ts');
    h.emit('change', 'models/readme.md');
    await wait(20);
    assert.equal(metaCalls, 1, 'unscanned paths never re-run build:meta');

    h.emit('rename', null);
    await wait(20);
    assert.equal(metaCalls, 2, 'an unnamed event may have been a source edit');

    h.emit('change', 'models/post.ts');
    watcher.close();
    await wait(20);
    assert.equal(metaCalls, 2, 'close cancels a pending meta signal');
  });

  it('treats a missing filename as a server change', async () => {
    const { h, changes, paths, watcher } = startWatcher();

    h.emit('change', 'dist/a.js');
    h.emit('rename', null);
    await wait(20);
    assert.deepEqual(changes, ['server-restart']);
    assert.deepEqual(paths, [undefined], 'an unnamed event makes the burst incomplete');

    watcher.close();
  });

  it('reports watcher errors and stops dispatching after close', async () => {
    const { h, changes, errors, watcher } = startWatcher();

    h.emitError(new Error('watch failed'));
    assert.equal(errors.length, 1);

    watcher.close();
    watcher.close();
    assert.equal(h.closed(), 1, 'close is idempotent');

    h.emit('change', 'dist/a.js');
    await wait(20);
    assert.deepEqual(changes, []);
  });
});
