/**
 * WatcherRegistry tests: add, start, stop, seal, and error guards.
 * No connection, database, or external service is opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createWatcherRegistry,
  WatcherError,
  type Watcher,
  type WatcherContext,
} from '../../src/watchers/registry.js';
import { collectingContext } from '../fixtures.js';

function makeWatcher(
  name: string,
  onRegister?: (ctx: WatcherContext) => void,
): Watcher & { unsubscribeCalls: number; registerCalls: number } {
  let unsubscribeCalls = 0;
  let registerCalls = 0;

  return {
    name,
    register(ctx: WatcherContext) {
      registerCalls += 1;
      onRegister?.(ctx);
      return () => {
        unsubscribeCalls += 1;
      };
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    get registerCalls() {
      return registerCalls;
    },
  };
}

describe('createWatcherRegistry', () => {
  it('returns a WatcherRegistry with add, start, stop, and list', () => {
    const registry = createWatcherRegistry();

    assert.equal(typeof registry.add, 'function');
    assert.equal(typeof registry.start, 'function');
    assert.equal(typeof registry.stop, 'function');
    assert.equal(typeof registry.list, 'function');
    assert.deepEqual(registry.list(), []);
  });

  it('start invokes every watcher register, in registration order', () => {
    const registry = createWatcherRegistry();
    const calls: string[] = [];

    const a = makeWatcher('a', () => calls.push('a'));
    const b = makeWatcher('b', () => calls.push('b'));

    registry.add(a);
    registry.add(b);

    const { ctx } = collectingContext();
    registry.start(ctx);

    assert.equal(a.registerCalls, 1);
    assert.equal(b.registerCalls, 1);
    assert.deepEqual(calls, ['a', 'b']);
  });

  it('stop invokes every unsubscribe', () => {
    const registry = createWatcherRegistry();

    const a = makeWatcher('a');
    const b = makeWatcher('b');

    registry.add(a);
    registry.add(b);

    const { ctx } = collectingContext();
    registry.start(ctx);
    registry.stop();

    assert.equal(a.unsubscribeCalls, 1);
    assert.equal(b.unsubscribeCalls, 1);
  });

  it('stop is idempotent: a second call is a no-op', () => {
    const registry = createWatcherRegistry();

    const w = makeWatcher('w');
    registry.add(w);

    registry.start(collectingContext().ctx);
    registry.stop();
    assert.equal(w.unsubscribeCalls, 1);

    registry.stop();
    assert.equal(w.unsubscribeCalls, 1);
  });

  it('add after start throws WatcherError with code sealed', () => {
    const registry = createWatcherRegistry();

    registry.add(makeWatcher('a'));
    registry.start(collectingContext().ctx);

    assert.throws(
      () => registry.add(makeWatcher('b')),
      (err: unknown) => {
        assert.ok(err instanceof WatcherError);
        assert.equal(err.code, 'sealed');
        return true;
      },
    );
  });

  it('list returns names in registration order', () => {
    const registry = createWatcherRegistry();

    registry.add(makeWatcher('z'));
    registry.add(makeWatcher('a'));
    registry.add(makeWatcher('m'));

    assert.deepEqual(registry.list(), ['z', 'a', 'm']);
  });

  it('rejects a duplicate name with duplicate_watcher, without echoing it', () => {
    const registry = createWatcherRegistry();

    registry.add(makeWatcher('x-secret'));

    assert.throws(
      () => registry.add(makeWatcher('x-secret')),
      (err: unknown) => {
        assert.ok(err instanceof WatcherError);
        assert.equal(err.code, 'duplicate_watcher');
        assert.ok(!err.message.includes('x-secret'));
        return true;
      },
    );
  });

  it('rejects an empty name with invalid_watcher', () => {
    const registry = createWatcherRegistry();

    assert.throws(
      () => registry.add({ name: '', register: () => () => {} }),
      (err: unknown) => {
        assert.ok(err instanceof WatcherError);
        assert.equal(err.code, 'invalid_watcher');
        return true;
      },
    );
  });

  it('rejects a watcher missing register with invalid_watcher', () => {
    const registry = createWatcherRegistry();

    assert.throws(
      // @ts-expect-error deliberately invalid watcher
      () => registry.add({ name: 'no-register' }),
      (err: unknown) => {
        assert.ok(err instanceof WatcherError);
        assert.equal(err.code, 'invalid_watcher');
        return true;
      },
    );
  });

  it('rejects a non-object watcher with invalid_watcher', () => {
    const registry = createWatcherRegistry();

    assert.throws(
      // @ts-expect-error deliberately invalid watcher
      () => registry.add(null),
      (err: unknown) => {
        assert.ok(err instanceof WatcherError);
        assert.equal(err.code, 'invalid_watcher');
        return true;
      },
    );
  });

  it('provides a working record and now context to watchers', () => {
    const registry = createWatcherRegistry();
    let capturedNow = -1;

    registry.add({
      name: 'ctx-test',
      register(ctx: WatcherContext) {
        capturedNow = ctx.now();
        ctx.record({ type: 'test', data: { ok: true } });
        return () => {};
      },
    });

    const { ctx, recorded } = collectingContext();
    registry.start({ ...ctx, now: () => 42 });

    assert.equal(capturedNow, 42);
    assert.equal(recorded.length, 1);
  });
});
