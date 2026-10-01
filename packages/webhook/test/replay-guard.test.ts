/**
 * Tests for the replay guard: the first claim wins through the store's atomic
 * `add`, a second claim of the same signature is refused, concurrent claims
 * admit one, a released claim is granted again, and the claim lives for its
 * window.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  claimReplayKey,
  claimSignature,
  releaseSignature,
  replayKey,
} from '../src/replay-guard.js';
import { claimStore } from './claim-store.js';

describe('replayKey', () => {
  it('namespaces the endpoint and the signature', () => {
    assert.equal(replayKey('stripe', 'abc'), 'webhook:stripe:abc');
  });
});

describe('claimSignature', () => {
  it('grants the first claim and refuses the second', async () => {
    const cache = claimStore();
    assert.equal(await claimSignature(cache, 'stripe', 'sig', 300), true);
    assert.equal(await claimSignature(cache, 'stripe', 'sig', 300), false);
  });

  it('keeps endpoints independent', async () => {
    const cache = claimStore();
    assert.equal(await claimSignature(cache, 'stripe', 'sig', 300), true);
    assert.equal(await claimSignature(cache, 'github', 'sig', 300), true);
  });

  it('records the entry for twice the tolerance window', async () => {
    const cache = claimStore();
    await claimSignature(cache, 'stripe', 'sig', 300);
    assert.deepEqual(cache.adds, [{ key: 'webhook:stripe:sig', ttlMs: 600_000 }]);
    cache.advance(599_999);
    assert.equal(await claimSignature(cache, 'stripe', 'sig', 300), false);
    cache.advance(1);
    assert.equal(await claimSignature(cache, 'stripe', 'sig', 300), true);
  });

  it('admits exactly one of many concurrent claims', async () => {
    const cache = claimStore();
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => claimSignature(cache, 'stripe', 'sig', 300)),
    );
    assert.equal(claims.filter(Boolean).length, 1);
  });
});

describe('claimReplayKey and releaseSignature', () => {
  it('holds a claim for the given window and frees it on release', async () => {
    const cache = claimStore();
    const key = replayKey('github', 'sig');
    assert.equal(await claimReplayKey(cache, key, 7 * 24 * 60 * 60), true);
    assert.equal(cache.adds[0]?.ttlMs, 604_800_000);
    assert.equal(await claimReplayKey(cache, key, 60), false);
    await releaseSignature(cache, key);
    assert.equal(await claimReplayKey(cache, key, 60), true);
  });
});
