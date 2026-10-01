/**
 * The lease one attempt of an overlap-controlled job holds while it runs.
 *
 * The lease is acquired before the handler starts and renewed every third of
 * its TTL on the runtime's clock, at most one renewal in flight, so it lasts
 * as long as the code runs; the TTL only bounds how long a crashed holder
 * blocks the key. The lease is lost when a renewal answers false (another
 * run may hold the key), or when no renewal succeeded within a TTL of the
 * last request the store confirmed, counted from when that request was
 * sent, so the local deadline never outlives the store's. A renewal that
 * fails says nothing about the key, which the store keeps until that
 * deadline, so it is only tried again on the next tick. On a loss the
 * attempt is told once ({@link OverlapLease.watch}) and aborts
 * cooperatively, as a timeout does.
 *
 * The token is an unguessable owner token, never a fencing counter: overlap
 * is a scheduling guard, and a handler that needs fenced writes fences them
 * in its own database.
 */

import type { JobOverlap, LeaseCapability } from '../contract/index.js';
import { setLongInterval, setLongTimeout, type JobsClock } from '../timing/long-timer.js';
import { OVERLAP_LEASE_PREFIX } from './overlap-option.js';

/** The longest a release waits for the lease store before leaving the key to its TTL. */
export const MAX_RELEASE_WAIT_MS = 5_000;

/** A held overlap lease. */
export interface OverlapLease {
  /** Call `onLost` once when the lease is lost (at once, if it already was). */
  watch(onLost: () => void): void;
  /**
   * Stop renewing and give the key back. Bounded by the TTL and
   * {@link MAX_RELEASE_WAIT_MS}; never rejects; idempotent.
   */
  release(): Promise<void>;
}

/**
 * Acquire the lease of `overlap`, or `'held'` when another run holds it.
 *
 * @throws whatever the lease store's `acquire` rejects with.
 */
export async function acquireOverlapLease(
  leases: LeaseCapability,
  overlap: JobOverlap,
  clock: JobsClock,
): Promise<OverlapLease | 'held'> {
  const key = OVERLAP_LEASE_PREFIX + overlap.key;
  const { ttlMs } = overlap;
  const requestedAt = clock.now();
  const token = await leases.acquire(key, ttlMs);
  if (token === undefined) return 'held';

  let lost = false;
  let listener: (() => void) | undefined;
  let renewing = false;
  let releasing: Promise<void> | undefined;
  const lose = (): void => {
    if (lost || releasing !== undefined) return;
    lost = true;
    renewal.cancel();
    expiry.cancel();
    listener?.();
  };
  let confirmedAt = requestedAt;
  /** Fires when the store may have let the key go: a TTL after the last confirmed request was sent. */
  let expiry = setLongTimeout(lose, Math.max(0, requestedAt + ttlMs - clock.now()), clock);
  const renewal = setLongInterval(
    () => {
      if (renewing) return;
      renewing = true;
      const sentAt = clock.now();
      leases.renew(key, token, ttlMs).then(
        (held) => {
          renewing = false;
          if (!held) {
            lose();
            return;
          }
          if (lost || releasing !== undefined || sentAt <= confirmedAt) return;
          confirmedAt = sentAt;
          expiry.cancel();
          expiry = setLongTimeout(lose, Math.max(0, sentAt + ttlMs - clock.now()), clock);
        },
        () => {
          // Handled on purpose: a failed renewal leaves the key held until the
          // expiry deadline, which loses the lease if no later renewal lands.
          renewing = false;
        },
      );
    },
    Math.floor(ttlMs / 3),
    clock,
  );

  const giveBack = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setLongTimeout(resolve, Math.min(ttlMs, MAX_RELEASE_WAIT_MS), clock);
      const done = (): void => {
        timer.cancel();
        resolve();
      };
      leases.release(key, token).then(done, () => {
        // Swallowed on purpose: the TTL frees the key, and a lease store
        // outage must not fail an attempt that already settled.
        done();
      });
    });

  return {
    watch(onLost) {
      listener = onLost;
      if (lost) onLost();
    },
    release() {
      renewal.cancel();
      expiry.cancel();
      releasing ??= giveBack();
      return releasing;
    },
  };
}
