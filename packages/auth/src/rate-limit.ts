/**
 * Credential-endpoint throttling for the `auth` plugin: the hook contract,
 * email normalization, client-address discovery, and the in-memory fixed-window
 * limiter the plugin installs by default.
 *
 * A hook receives the normalized email (trimmed, lowercased, as Better Auth
 * looks the account up) and an {@link RateLimitAttempt} carrying the client
 * address when one is known. Keying on the raw form value would hand an
 * attacker a fresh bucket per case variant of one address.
 */

/** Which credential surface an attempt targets. */
export type RateLimitRoute =
  'login' | 'register' | 'password-reset' | 'verification' | 'magic-link';

/** What a rate-limit hook is told about one attempt. */
export interface RateLimitAttempt {
  /** The trimmed, lowercased email. */
  readonly email: string;
  /** The client address, or `null` when the transport does not expose one. */
  readonly ip: string | null;
  /** The credential surface the attempt targets. */
  readonly route: RateLimitRoute;
  /** The incoming request. */
  readonly request: Request;
}

/**
 * A rate-limit gate: an exact `true` allows, anything else (or a throw) denies.
 * `email` is the normalized address, the same value as `attempt.email`.
 */
export type RateLimitHook = (
  email: string,
  attempt: RateLimitAttempt,
) => boolean | Promise<boolean>;

/** Normalize an email the way the account lookup does: trimmed and lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The peer address of a request served by the Node adapter, read from the Hono
 * context's `env.incoming.socket`. Behind a reverse proxy this is the proxy;
 * an app there supplies `clientAddress` to read its trusted forwarding header.
 */
export function socketAddress(env: unknown): string | null {
  if (!isRecord(env) || !isRecord(env.incoming) || !isRecord(env.incoming.socket)) {
    return null;
  }
  const address = env.incoming.socket.remoteAddress;
  return typeof address === 'string' && address !== '' ? address : null;
}

/** Options for {@link createMemoryRateLimiter}. */
export interface MemoryRateLimiterOptions {
  /** Attempts allowed per route, email, and client address per window. Defaults to `10`. */
  readonly limit?: number;
  /**
   * Attempts allowed per route and client address per window, across every
   * email. Defaults to `100`. Ignored when the address is unknown.
   */
  readonly perAddressLimit?: number;
  /** Window length in milliseconds. Defaults to 15 minutes. */
  readonly windowMs?: number;
  /** Most keys tracked at once; the least recently used is evicted past it. Defaults to `10_000`. */
  readonly maxKeys?: number;
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Ten attempts per fifteen minutes per account and client, and a hundred per
 * client across all accounts, which stops one address spraying a password over
 * many emails while leaving room for a shared office or NAT address.
 */
const DEFAULT_LIMIT = 10;
const DEFAULT_PER_ADDRESS_LIMIT = 100;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_KEYS = 10_000;

/**
 * An in-process fixed-window limiter with two buckets per attempt: one keyed on
 * route, normalized email, and client address, and one keyed on route and
 * client address alone. An attempt is denied when either is exhausted. The
 * per-email bucket includes the address so a stranger cannot lock a user out
 * from elsewhere; the per-address bucket stops password spraying, where one
 * client tries a password against many accounts. When no address is known the
 * per-email key degrades to the email alone and the per-address bucket is
 * skipped. State is per process, so a multi-instance deployment should supply a
 * shared limiter (for example one backed by `@jsails/cache`) instead.
 */
export function createMemoryRateLimiter(options: MemoryRateLimiterOptions = {}): RateLimitHook {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const perAddressLimit = options.perAddressLimit ?? DEFAULT_PER_ADDRESS_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? Date.now;
  for (const [name, value] of [
    ['limit', limit],
    ['perAddressLimit', perAddressLimit],
    ['windowMs', windowMs],
    ['maxKeys', maxKeys],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive integer`);
    }
  }
  const windows = new Map<string, { start: number; count: number }>();

  /** Count one attempt against `key` and report whether it is still within `max`. */
  const hit = (key: string, max: number, at: number): boolean => {
    const current = windows.get(key);
    if (current !== undefined && at - current.start < windowMs) {
      current.count += 1;
      // Re-inserting moves the key to the end, so eviction drops the least
      // recently used window: a client spraying fresh emails cannot push its own
      // per-address bucket out of the map.
      windows.delete(key);
      windows.set(key, current);
      return current.count <= max;
    }
    windows.delete(key);
    if (windows.size >= maxKeys) {
      for (const [stale, window] of windows) {
        if (at - window.start >= windowMs) windows.delete(stale);
      }
      // Map iteration is insertion order, so the first key is the least recently used.
      const oldest = windows.keys().next();
      if (windows.size >= maxKeys && oldest.done !== true) windows.delete(oldest.value);
    }
    windows.set(key, { start: at, count: 1 });
    return true;
  };

  return (email, attempt) => {
    const at = now();
    const perEmail = hit(
      `${attempt.route}\u0000${normalizeEmail(email)}\u0000${attempt.ip ?? ''}`,
      limit,
      at,
    );
    // A distinct prefix keeps the per-address key from colliding with any per-email key.
    const perAddress =
      attempt.ip === null
        ? true
        : hit(`ip\u0000${attempt.route}\u0000${attempt.ip}`, perAddressLimit, at);
    return perEmail && perAddress;
  };
}

/**
 * Evaluate a rate-limit hook for one attempt. Returns `true` only for an exact
 * `true` result; `false`, a truthy non-boolean, or a throw all deny (fail
 * closed).
 */
export async function rateLimitAllows(
  hook: RateLimitHook,
  email: string,
  attempt: Omit<RateLimitAttempt, 'email'>,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  try {
    return (await hook(normalized, { ...attempt, email: normalized })) === true;
  } catch {
    return false;
  }
}
