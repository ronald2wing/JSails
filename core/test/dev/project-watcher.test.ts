import assert from 'node:assert/strict';
import type { FSWatcher } from 'node:fs';
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
function startWatcher(debounceMs = 5) {
  const h = fakeWatch();
  const changes: ChangeClass[] = [];
  const errors: unknown[] = [];
  const watcher = watchProject('/project', {
    onChange: (change) => {
      changes.push(change);
    },
    onError: (error) => {
      errors.push(error);
    },
    debounceMs,
    watch: h.watch,
  });
  return { h, changes, errors, watcher };
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

  it('treats a missing filename as a server change', async () => {
    const { h, changes, watcher } = startWatcher();

    h.emit('rename', null);
    await wait(20);
    assert.deepEqual(changes, ['server-restart']);

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
