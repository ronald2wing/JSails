/**
 * The memory adapter's leases: owner-token leases on the adapter's clock, the
 * in-process form of `SET NX PX` plus compare-and-set renew and release.
 * Every operation is a synchronous check-and-set, so it is atomic in the
 * process. Tokens are random UUIDs, never reused; an expired lease is
 * treated as absent and swept when its key is acquired again.
 */

import { randomUUID } from 'node:crypto';

import type { LeaseCapability } from '../contract/index.js';
import { checkLeaseKey, checkLeaseToken, checkLeaseTtl } from '../overlap/lease-bounds.js';
import type { JobsClock } from '../timing/long-timer.js';
import { promised } from './promised.js';

/** Owner-token leases held in this process. */
export class LeaseTable implements LeaseCapability {
  readonly #clock: JobsClock;
  readonly #leases = new Map<string, { readonly token: string; expiresAt: number }>();

  constructor(clock: JobsClock) {
    this.#clock = clock;
  }

  acquire(key: string, ttlMs: number): Promise<string | undefined> {
    return promised(() => {
      checkLeaseKey(key);
      checkLeaseTtl(ttlMs);
      const now = this.#clock.now();
      const held = this.#leases.get(key);
      if (held !== undefined && now < held.expiresAt) return undefined;
      const token = randomUUID();
      this.#leases.set(key, { token, expiresAt: now + ttlMs });
      return token;
    });
  }

  renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    return promised(() => {
      checkLeaseKey(key);
      checkLeaseToken(token);
      checkLeaseTtl(ttlMs);
      const held = this.#owned(key, token);
      if (held === undefined) return false;
      held.expiresAt = this.#clock.now() + ttlMs;
      return true;
    });
  }

  release(key: string, token: string): Promise<boolean> {
    return promised(() => {
      checkLeaseKey(key);
      checkLeaseToken(token);
      if (this.#owned(key, token) === undefined) return false;
      this.#leases.delete(key);
      return true;
    });
  }

  #owned(key: string, token: string): { readonly token: string; expiresAt: number } | undefined {
    const held = this.#leases.get(key);
    return held !== undefined && held.token === token && this.#clock.now() < held.expiresAt
      ? held
      : undefined;
  }
}
