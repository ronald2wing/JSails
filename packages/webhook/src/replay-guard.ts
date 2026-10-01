/**
 * The replay guard: a delivery may be accepted once, and only once, within its
 * replay window (twice the tolerance for a timestamped scheme, longer for one
 * that signs no timestamp).
 *
 * The guard is the cache store's atomic `add`, not a read-then-write. Two
 * concurrent deliveries of the same request must not both observe "not seen
 * yet" — a `get` followed by a `set` has exactly that race, and a webhook is
 * the one place where a duplicate is a real duplicate (a double charge, a
 * double email). `add` stores the claim only while the key is free and says
 * whether it did, so exactly one caller wins. Every cache store implements
 * `add`, so the guard never degrades.
 *
 * A claim lives in a cache, which may evict it under pressure; the replay
 * window then ends early for that delivery. Give the webhook endpoint's cache
 * room (or a Valkey with an eviction policy that spares it) when replays must
 * be refused for the whole window.
 */

import type { CacheStore } from 'jsails/cache';

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
  return claimReplayKey(cache, replayKey(endpointId, signature), toleranceSeconds * 2);
}

/**
 * {@link claimSignature} for a key already built with {@link replayKey}, held
 * for `windowSeconds` (a whole number of seconds, at most the cache's longest
 * TTL). The caller picks the window: twice the tolerance for a timestamped
 * scheme, much longer for one that signs no timestamp.
 */
export async function claimReplayKey(
  cache: CacheStore,
  key: string,
  windowSeconds: number,
): Promise<boolean> {
  return cache.add(key, '1', windowSeconds * 1000);
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
