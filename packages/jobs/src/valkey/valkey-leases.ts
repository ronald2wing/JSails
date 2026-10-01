/**
 * Owner-token leases on the Valkey transport: `SET NX PX` with a random
 * token to acquire, and a compare of the token in one script to renew or
 * release, so a holder never touches another holder's lease. Expiry is the
 * server's. Keys live under the adapter's namespace, past the transport's
 * `_lease:` prefix.
 */

import { randomUUID } from 'node:crypto';

import type { LeaseCapability } from '../contract/index.js';
import { checkLeaseKey, checkLeaseToken, checkLeaseTtl } from '../overlap/lease-bounds.js';
import type { KeyLayout } from './key-layout.js';
import { guarded } from './transport-error.js';
import type { ValkeyScripts } from './valkey-scripts.js';

/** The leases of one adapter. */
export class ValkeyLeases implements LeaseCapability {
  readonly #scripts: ValkeyScripts;
  readonly #layout: KeyLayout;

  constructor(scripts: ValkeyScripts, layout: KeyLayout) {
    this.#scripts = scripts;
    this.#layout = layout;
  }

  async acquire(key: string, ttlMs: number): Promise<string | undefined> {
    checkLeaseKey(key);
    checkLeaseTtl(ttlMs);
    const token = randomUUID();
    const acquired = await guarded(() =>
      this.#scripts.leaseAcquire.run([this.#layout.lease(key)], [token, ttlMs]),
    );
    return acquired === 1 ? token : undefined;
  }

  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    checkLeaseKey(key);
    checkLeaseToken(token);
    checkLeaseTtl(ttlMs);
    const renewed = await guarded(() =>
      this.#scripts.leaseRenew.run([this.#layout.lease(key)], [token, ttlMs]),
    );
    return renewed === 1;
  }

  async release(key: string, token: string): Promise<boolean> {
    checkLeaseKey(key);
    checkLeaseToken(token);
    const released = await guarded(() =>
      this.#scripts.leaseRelease.run([this.#layout.lease(key)], [token]),
    );
    return released === 1;
  }
}
