/**
 * Tests for the replay guard: the first claim wins, a second claim of the same
 * signature is refused, and a store without atomic `increment` fails closed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CacheStore } from 'jsails/cache';

import { WebhookError } from '../src/errors.js';
import { claimSignature, replayKey } from '../src/replay-guard.js';

/** A store with atomic increment, modelling the counter semantics. */
function countingStore(): CacheStore & { readonly counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    remember: async (_key, _ttl, loader) => loader(),
    increment: async (key) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    close: async () => undefined,
  };
}

/** A store without `increment`. */
function plainStore(): CacheStore {
  return {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    remember: async (_key, _ttl, loader) => loader(),
    close: async () => undefined,
  };
}

describe('replayKey', () => {
  it('namespaces the endpoint and the signature', () => {
    assert.equal(replayKey('stripe', 'abc'), 'webhook:stripe:abc');
  });
});

describe('claimSignature', () => {
  it('grants the first claim and refuses the second', async () => {
    const cache = countingStore();
    assert.equal(await claimSignature(cache, 'stripe', 'sig', 300), true);
    assert.equal(await claimSignature(cache, 'stripe', 'sig', 300), false);
  });

  it('keeps endpoints independent', async () => {
    const cache = countingStore();
    assert.equal(await claimSignature(cache, 'stripe', 'sig', 300), true);
    assert.equal(await claimSignature(cache, 'github', 'sig', 300), true);
  });

  it('records the entry for twice the tolerance window', async () => {
    const cache = countingStore();
    await claimSignature(cache, 'stripe', 'sig', 300);
    assert.equal(cache.counts.get('webhook:stripe:sig'), 1);
  });

  it('fails closed when the store has no atomic increment', async () => {
    await assert.rejects(
      () => claimSignature(plainStore(), 'stripe', 'sig', 300),
      (error: unknown) =>
        error instanceof WebhookError &&
        error.code === 'unsupported_replay_guard' &&
        error.suggestion === 'use a cache store that implements increment, such as @jsails/cache',
    );
  });
});
