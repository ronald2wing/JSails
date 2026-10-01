/**
 * The DNS TXT lookup port used by domain verification, and its system adapter.
 *
 * {@link DnsTxtResolver} is the seam: tests and alternative transports supply
 * their own. A resolver resolves to an empty list when the name has no TXT
 * records (NXDOMAIN or NODATA) and rejects for every other failure.
 *
 * {@link systemDnsResolver} uses `node:dns/promises` with a fresh `Resolver`
 * per lookup. A resolver channel keeps its own query cache, so a new channel
 * per lookup guarantees the process never answers a verification from a
 * cached response; a record the user just published is seen as soon as the
 * configured upstream sees it. Point `servers` at a resolver with a low
 * negative-caching TTL, or at the zone's authoritative servers, to avoid
 * upstream caching too. Each lookup is bounded by `timeoutMs` and by the
 * caller's abort signal, which cancels the in-flight query.
 */

import { Resolver } from 'node:dns/promises';

import { TenancyError } from './tenancy-error.js';

/** Resolves the TXT records at a name; each record is its list of character-strings. */
export interface DnsTxtResolver {
  resolveTxt(name: string, signal: AbortSignal): Promise<readonly (readonly string[])[]>;
}

/** Options for {@link systemDnsResolver}. */
export interface SystemDnsResolverOptions {
  /** Resolver addresses (`1.1.1.1`, `[2001:db8::1]:53`); the system's when omitted. */
  readonly servers?: readonly string[];
  /** Per-attempt timeout in milliseconds; defaults to 5000. */
  readonly timeoutMs?: number;
  /** Attempts per server; defaults to 2. */
  readonly tries?: number;
}

/** DNS error codes meaning "no TXT records at this name". */
const NO_RECORDS = new Set(['ENOTFOUND', 'ENODATA']);

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : null;
  }
  return null;
}

/** Whether a resolver rejection means the name has no TXT records. */
export function isNoRecordsError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== null && NO_RECORDS.has(code);
}

/** Whether a resolver rejection is a timeout. */
export function isTimeoutError(error: unknown): boolean {
  return errorCode(error) === 'ETIMEOUT';
}

function positiveInteger(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new TenancyError('invalid_dns_options');
  }
  return value;
}

/**
 * A {@link DnsTxtResolver} on `node:dns/promises`. Throws `invalid_dns_options`
 * when the options are malformed, including a server address `node:dns`
 * rejects.
 */
export function systemDnsResolver(options: SystemDnsResolverOptions = {}): DnsTxtResolver {
  const timeout = positiveInteger(options.timeoutMs ?? 5000, 60_000);
  const tries = positiveInteger(options.tries ?? 2, 10);
  const servers = options.servers === undefined ? null : [...options.servers];
  const open = (): Resolver => {
    const resolver = new Resolver({ timeout, tries });
    if (servers !== null) {
      resolver.setServers(servers);
    }
    return resolver;
  };
  if (servers !== null) {
    if (servers.length === 0 || servers.some((server) => typeof server !== 'string')) {
      throw new TenancyError('invalid_dns_options');
    }
    try {
      open();
    } catch (error) {
      throw new TenancyError('invalid_dns_options', { cause: error });
    }
  }

  return Object.freeze({
    async resolveTxt(name: string, signal: AbortSignal): Promise<readonly (readonly string[])[]> {
      signal.throwIfAborted();
      const resolver = open();
      const cancel = (): void => resolver.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        return await resolver.resolveTxt(name);
      } catch (error) {
        if (isNoRecordsError(error)) {
          return [];
        }
        signal.throwIfAborted();
        throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
  });
}
