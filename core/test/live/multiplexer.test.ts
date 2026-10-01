/**
 * Tests for the live layer's multiplexer.
 *
 * Identical keys share one driver; distinct keys never do. Because the key is
 * built by the live service and includes the resolved identity, two users of
 * the same publication are two distinct keys and therefore two distinct slots —
 * the identity-isolation guarantee (LIVE-PLAN.md §4.7, §14 blocker 3). The
 * `size` getter observes the active driver (slot) count, so a sharing collapse
 * and an identity split are both externally assertable without reaching for
 * Phase 5's fan-out path.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMultiplexer } from '../../src/live/multiplexer.js';

describe('createMultiplexer', () => {
  it('shares one driver across identical keys', () => {
    const multiplexer = createMultiplexer();
    const key = 'blog.posts:{}:user-1';

    multiplexer.register(key, () => {});
    multiplexer.register(key, () => {});
    assert.equal(multiplexer.size, 1, 'two handlers under one key are one slot');

    // Removing one of two handlers keeps the shared slot alive.
    const third = multiplexer.register(key, () => {});
    assert.equal(multiplexer.size, 1);
    third();
    assert.equal(multiplexer.size, 1, 'the slot survives while a handler remains');
  });

  it('does not share a driver across different identities (blocker 3)', () => {
    const multiplexer = createMultiplexer();
    multiplexer.register('blog.posts:{}:user-1', () => {});
    multiplexer.register('blog.posts:{}:user-2', () => {});

    assert.equal(multiplexer.size, 2, 'two identities are two independent slots');
  });

  it('tears down a slot once its last handler unsubscribes', () => {
    const multiplexer = createMultiplexer();
    const a = multiplexer.register('k1', () => {});
    const b = multiplexer.register('k2', () => {});
    assert.equal(multiplexer.size, 2);

    b();
    assert.equal(multiplexer.size, 1);

    a();
    assert.equal(multiplexer.size, 0);
  });

  it('unsubscribe is idempotent and does not over-release', () => {
    const multiplexer = createMultiplexer();
    const unregister = multiplexer.register('k', () => {});
    unregister();
    unregister();
    assert.equal(multiplexer.size, 0);
  });

  it('close clears every slot and rejects further register', async () => {
    const multiplexer = createMultiplexer();
    multiplexer.register('k1', () => {});
    multiplexer.register('k2', () => {});

    await multiplexer.close();
    assert.equal(multiplexer.size, 0);
    assert.throws(() => multiplexer.register('k3', () => {}), /closed/);
  });
});
