/**
 * The CLI's shutdown signals: the first SIGINT/SIGTERM resolves the wait, the
 * second aborts its `abort` signal, and `dispose()` removes every listener;
 * `onProcessSignals` forwards each signal until disposed, and
 * `onFirstProcessSignal` only the first. A structural scan
 * holds that `cli/shutdown.ts` is the only module in core that listens for a
 * process signal, so every command shares one shutdown owner.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  onFirstProcessSignal,
  onProcessSignals,
  waitForShutdownSignal,
  type SignalSource,
} from '../../src/cli/shutdown.js';
import { toPosixId } from '../../src/support/project-paths.server.js';

/** A process stand-in: emits signals to its listeners and counts them. */
function fakeProcess(): EventEmitter & SignalSource {
  return new EventEmitter() as EventEmitter & SignalSource;
}

describe('waitForShutdownSignal', () => {
  it('resolves on the first signal and aborts on the second', async () => {
    const source = fakeProcess();
    const shutdown = waitForShutdownSignal(source);
    assert.equal(source.listenerCount('SIGINT'), 1);
    assert.equal(source.listenerCount('SIGTERM'), 1);

    source.emit('SIGTERM', 'SIGTERM');
    await shutdown.promise;
    assert.equal(shutdown.abort.aborted, false, 'the first signal drains');

    source.emit('SIGINT', 'SIGINT');
    assert.equal(shutdown.abort.aborted, true, 'the second signal aborts the drain');

    shutdown.dispose();
    shutdown.dispose();
    assert.equal(source.listenerCount('SIGINT'), 0);
    assert.equal(source.listenerCount('SIGTERM'), 0);
  });

  it('leaves the abort signal alone while only one signal arrived', () => {
    const source = fakeProcess();
    const shutdown = waitForShutdownSignal(source);
    source.emit('SIGINT', 'SIGINT');
    assert.equal(shutdown.abort.aborted, false);
    shutdown.dispose();
  });
});

describe('onProcessSignals', () => {
  it('forwards each listed signal until disposed', () => {
    const source = fakeProcess();
    const seen: string[] = [];
    const dispose = onProcessSignals(['SIGINT', 'SIGTERM'], (signal) => seen.push(signal), source);
    source.emit('SIGINT', 'SIGINT');
    source.emit('SIGTERM', 'SIGTERM');
    source.emit('SIGHUP', 'SIGHUP');
    dispose();
    source.emit('SIGINT', 'SIGINT');
    assert.deepEqual(seen, ['SIGINT', 'SIGTERM']);
    assert.equal(source.listenerCount('SIGINT'), 0);
  });
});

describe('onFirstProcessSignal', () => {
  it('forwards the first signal and leaves the next to the default handling', () => {
    const source = fakeProcess();
    const seen: string[] = [];
    const dispose = onFirstProcessSignal(
      ['SIGINT', 'SIGTERM'],
      (signal) => seen.push(signal),
      source,
    );
    source.emit('SIGTERM', 'SIGTERM');
    assert.equal(source.listenerCount('SIGINT'), 0);
    assert.equal(source.listenerCount('SIGTERM'), 0);
    source.emit('SIGTERM', 'SIGTERM');
    dispose();
    assert.deepEqual(seen, ['SIGTERM']);
  });

  it('stops listening when disposed before any signal', () => {
    const source = fakeProcess();
    const dispose = onFirstProcessSignal(['SIGINT'], () => assert.fail('no signal'), source);
    dispose();
    assert.equal(source.listenerCount('SIGINT'), 0);
    source.emit('SIGINT', 'SIGINT');
  });
});

describe('the one signal owner', () => {
  const srcRoot = fileURLToPath(new URL('../../../src', import.meta.url));
  const OWNER = 'cli/shutdown.ts';

  /** Every TypeScript source under core/src, as POSIX paths relative to it, with comments removed. */
  function sources(): readonly { readonly path: string; readonly text: string }[] {
    return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'),
      )
      .map((entry) => {
        const absolute = join(entry.parentPath, entry.name);
        const text = readFileSync(absolute, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        return { path: toPosixId(relative(srcRoot, absolute)), text };
      });
  }

  /** A listener installed on the process, or on anything, for a named signal. */
  const LISTENS = [
    /\bprocess\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(/,
    /\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*['"`]SIG[A-Z]+['"`]/,
  ];

  /** The modules among `files` that install a signal listener, other than the owner. */
  function listeners(files: readonly { readonly path: string; readonly text: string }[]): string[] {
    return files
      .filter(({ path, text }) => path !== OWNER && LISTENS.some((pattern) => pattern.test(text)))
      .map(({ path }) => path);
  }

  it('reads the shipped sources, the owner among them', () => {
    const files = sources();
    assert.ok(files.length > 100);
    assert.ok(files.some(({ path }) => path === OWNER));
  });

  it('lets no module but cli/shutdown.ts listen for a process signal', () => {
    assert.deepEqual(listeners(sources()), []);
  });

  it('finds the listener shapes the check above refuses', () => {
    assert.deepEqual(
      listeners([
        { path: 'a.ts', text: "process.on('SIGTERM', stop);" },
        { path: 'b.ts', text: 'process.once(signal, stop);' },
        { path: 'c.ts', text: "terminal.once('SIGINT', abort);" },
        { path: 'd.ts', text: "child.on('exit', done);" },
        { path: OWNER, text: "process.on('SIGINT', stop);" },
      ]),
      ['a.ts', 'b.ts', 'c.ts'],
    );
  });
});
