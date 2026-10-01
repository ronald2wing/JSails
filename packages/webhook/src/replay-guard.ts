/**
 * The replay guard: a signature may be accepted once, and only once, within the
 * tolerance window.
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
  const count = await cache.increment(
    replayKey(endpointId, signature),
    toleranceSeconds * 2 * 1000,
  );
  return count === 1;
}
