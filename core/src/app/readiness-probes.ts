/**
 * Built-in readiness probes for the two backends a JSails app usually depends
 * on: a `JsailsDataSource` (`SELECT 1`) and a lazily connected Valkey client
 * (`PING`). Each returns a {@link ReadinessProbe} for the app config's
 * `readiness.probes` or an extension's declared `readiness`.
 *
 * Both are typed structurally, so this module imports neither TypeORM nor
 * ioredis. A probe gives up when the readiness deadline's signal aborts, or at
 * its own `timeoutMs` when it runs outside the readiness endpoint. A data
 * source that is not initialized fails without being initialized here: a
 * readiness check must never open the pool it is meant to observe.
 */

import type { ReadinessProbe } from '../server/readiness.js';

/** The slice of a TypeORM data source the database probe uses. */
export interface QueryableDataSource {
  readonly isInitialized: boolean;
  query(sql: string): Promise<unknown>;
}

/** The slice of a connected Valkey client the Valkey probe uses. */
export interface PingableValkeyClient {
  ping(): Promise<unknown>;
}

/** The slice of a lazy Valkey handle (`createLazyValkeyClient`) the Valkey probe uses. */
export interface LazyPingableValkey {
  get(): Promise<PingableValkeyClient>;
}

/** Options shared by the built-in probes. */
export interface ReadinessProbeOptions {
  /**
   * The probe's own deadline in milliseconds, applied on top of the readiness
   * endpoint's per-probe timeout. Defaults to none.
   */
  readonly timeoutMs?: number;
}

/** A probe that runs `SELECT 1` on `dataSource`; an uninitialized source fails. */
export function createDataSourceReadinessProbe(
  dataSource: QueryableDataSource,
  options: ReadinessProbeOptions = {},
): ReadinessProbe {
  if (
    dataSource === null ||
    typeof dataSource !== 'object' ||
    typeof dataSource.query !== 'function'
  ) {
    throw new TypeError('createDataSourceReadinessProbe requires a data source');
  }
  const timeoutMs = resolveTimeout(options.timeoutMs);
  return async (signal) => {
    if (!dataSource.isInitialized) return false;
    await bounded(dataSource.query('SELECT 1'), signal, timeoutMs);
    return true;
  };
}

/**
 * A probe that sends `PING` through a lazy Valkey handle and passes only on
 * `PONG`. The first probe connects the handle, which is the handle's own
 * contract: it connects on first use and retries a failed connect next time.
 */
export function createValkeyReadinessProbe(
  client: LazyPingableValkey,
  options: ReadinessProbeOptions = {},
): ReadinessProbe {
  if (client === null || typeof client !== 'object' || typeof client.get !== 'function') {
    throw new TypeError('createValkeyReadinessProbe requires a lazy Valkey client');
  }
  const timeoutMs = resolveTimeout(options.timeoutMs);
  return async (signal) => {
    const reply = await bounded(
      client.get().then((connected) => connected.ping()),
      signal,
      timeoutMs,
    );
    return reply === 'PONG';
  };
}

function resolveTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('readiness probe timeoutMs must be a positive integer');
  }
  return value;
}

/**
 * Settle with `work`, or reject once `signal` aborts or `timeoutMs` passes.
 * Neither driver can cancel the round trip, so a late result is dropped and a
 * late rejection is swallowed rather than reported as unhandled.
 */
function bounded<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number | undefined,
): Promise<T> {
  const combined =
    timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  // Marked handled: a rejection inside the bound reaches the caller through the
  // promise below; one after it has nobody left to tell (see above).
  work.catch(() => undefined);
  if (combined.aborted) return Promise.reject(new Error('readiness probe aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('readiness probe aborted'));
    combined.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        combined.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        combined.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('readiness probe failed'));
      },
    );
  });
}
