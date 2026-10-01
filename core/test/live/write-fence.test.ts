/**
 * Tests for the live layer's write fence.
 *
 * The fence coordinates the snapshot reader and the capture flush: a write that
 * begins before `arm()` still blocks queued callbacks until it ends, and
 * callbacks registered after the fence is already armed-and-idle fire
 * immediately. Both sides participate — a reader-only fence counts nothing
 * (LIVE-PLAN.md §4.6, §6.4, §14 correction 9).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWriteFence } from '../../src/live/write-fence.js';

describe('createWriteFence', () => {
  it('holds queued callbacks until armed AND outstanding reaches zero', () => {
    const fence = createWriteFence();
    let fired = false;
    fence.onAllCommitted(() => {
      fired = true;
    });

    assert.equal(fired, false);

    fence.beginWrite();
    assert.equal(fence.outstanding, 1);
    fence.arm(); // armed, but a write is still open
    assert.equal(fired, false);

    fence.endWrite();
    assert.equal(fence.outstanding, 0);
    assert.equal(fired, true);
  });

  it('fires immediately when already armed and idle', () => {
    const fence = createWriteFence();
    fence.arm();
    let fired = false;
    fence.onAllCommitted(() => {
      fired = true;
    });
    assert.equal(fired, true);
  });

  it('a write begun before arm still blocks the flush until it ends', () => {
    const fence = createWriteFence();
    fence.beginWrite();
    const fired: string[] = [];
    fence.onAllCommitted(() => {
      fired.push('queued');
    });

    fence.arm();
    assert.deepEqual(fired, [], 'armed but the open write still blocks');

    fence.endWrite();
    assert.deepEqual(fired, ['queued']);
  });

  it('endWrite decrements outstanding; nested writes require matching ends', () => {
    const fence = createWriteFence();
    fence.beginWrite();
    fence.beginWrite();
    assert.equal(fence.outstanding, 2);

    fence.endWrite();
    assert.equal(fence.outstanding, 1);

    fence.endWrite();
    assert.equal(fence.outstanding, 0);
  });

  it('drains multiple queued callbacks in registration order', () => {
    const fence = createWriteFence();
    fence.beginWrite();
    const fired: string[] = [];
    fence.onAllCommitted(() => fired.push('first'));
    fence.onAllCommitted(() => fired.push('second'));

    fence.arm();
    fence.endWrite();
    assert.deepEqual(fired, ['first', 'second']);
  });

  it('throws on an unmatched endWrite rather than silently corrupting the count', () => {
    const fence = createWriteFence();
    assert.throws(() => fence.endWrite(), /without a matching beginWrite/);
  });
});
