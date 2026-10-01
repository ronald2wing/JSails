/**
 * What every Valkey-backed store of the package shares: checking the app's
 * connection provider and a key prefix, reaching the `command` connection,
 * and turning any backend failure into a value-free `cache.unavailable` that
 * keeps the original error only as `cause`.
 */

import { CacheErrors } from 'jsails/cache';
import type { ValkeyClient, ValkeyConnections } from 'jsails/plugin-sdk';

/** Which store a backend failure is reported for. */
export type BackendStore = 'cache' | 'lease' | 'rate_limit';

/** A Valkey key prefix: printable, no whitespace, so it never splits a key. */
export const VALKEY_KEY_PREFIX: RegExp = /^[A-Za-z0-9._:@/{}-]{1,128}$/;

/** The value-free error a failed backend call becomes. */
export function backendError(store: BackendStore, cause: unknown): Error {
  return new CacheErrors.Error('unavailable', { store }, { cause });
}

/** Validate a store's `connections` option. */
export function assertConnections(value: unknown): ValkeyConnections {
  const candidate = value as Partial<ValkeyConnections> | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.shared !== 'function' ||
    typeof candidate.script !== 'function' ||
    typeof candidate.prefix !== 'string'
  ) {
    throw new CacheErrors.Error('invalid_option', { option: 'connections' });
  }
  return candidate as ValkeyConnections;
}

/** `prefix` when given and well formed, else `fallback`. */
export function resolvePrefix(prefix: unknown, fallback: string): string {
  if (prefix === undefined) return fallback;
  if (typeof prefix !== 'string' || !VALKEY_KEY_PREFIX.test(prefix)) {
    throw new CacheErrors.Error('invalid_option', { option: 'prefix' });
  }
  return prefix;
}

/** The connected `command` client, or `unavailable`. */
export async function commandClient(
  connections: ValkeyConnections,
  store: BackendStore,
): Promise<ValkeyClient> {
  try {
    return await connections.shared('command');
  } catch (error) {
    throw backendError(store, error);
  }
}
