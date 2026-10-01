/**
 * The replay guard: a delivery may be accepted once, and only once, within its
 * replay window (twice the tolerance for a timestamped scheme, longer for one
 * that signs no timestamp).
 *
 * The guard is an atomic `increment` on the cache store, not a read-then-write.
 * Two concurrent deliveries of the same request must not both observe "not
 * seen yet" — a `get` followed by a `set` has exactly that race, and a webhook
 * is the one place where a duplicate is a real duplicate (a double charge, a
 * double email). `increment` returns the new count, so the first caller sees
 * `1` and every later caller sees `> 1`.
 *
 * A store without `increment` cannot provide that guarantee. The guard fails
 * closed with `unsupported_replay_guard` rather than degrading to a racy
 * read-then-write: a webhook endpoint that silently accepts replays is worse
 * than one that refuses to start.
 */

import type { CacheStore } from 'jsails/cache';

import { WebhookError } from './errors.js';

/** The key a signature is recorded under. */
export function replayKey(endpointId: string, signature: string): string {
  return `webhook:${endpointId}:${signature}`;
}

/**
 * Record `signature` for `endpointId` and report whether this is its first
 * sighting. The entry lives twice the tolerance window, so a request that is
 * still inside the window can never find its record expired.
 */
export async function claimSignature(
  cache: CacheStore,
  endpointId: string,
  signature: string,
  toleranceSeconds: number,
): Promise<boolean> {
  return claimReplayKey(cache, endpointId, replayKey(endpointId, signature), toleranceSeconds * 2);
}

/**
 * {@link claimSignature} for a key already built with {@link replayKey}, held
 * for `windowSeconds`. The caller picks the window: twice the tolerance for a
 * timestamped scheme, much longer for one that signs no timestamp.
 */
export async function claimReplayKey(
  cache: CacheStore,
  endpointId: string,
  key: string,
  windowSeconds: number,
): Promise<boolean> {
  if (typeof cache.increment !== 'function') {
    throw new WebhookError(
      'unsupported_replay_guard',
      'the cache store cannot guard against replayed webhooks because it has no atomic increment',
      {
        context: { endpoint: endpointId },
        suggestion: 'use a cache store that implements increment, such as @jsails/cache',
      },
    );
  }
  const count = await cache.increment(key, windowSeconds * 1000);
  return count === 1;
}

/**
 * Forget a claim so the same signed request is accepted again. Called when a
 * claimed delivery could not be processed: the sender will retry it verbatim,
 * and holding the claim would answer every retry with `replayed` and lose the
 * event. A concurrent duplicate that arrives while the first attempt is still
 * running is still refused; only a failed attempt gives its slot back.
 */
export async function releaseSignature(cache: CacheStore, key: string): Promise<void> {
  await cache.delete(key);
}
