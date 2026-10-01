/**
 * Credential-endpoint throttling for the `auth` plugin: the hook contract,
 * email normalization, and the in-memory fixed-window limiter the plugin
 * installs by default.
 *
 * A hook receives the normalized email (trimmed, lowercased, as Better Auth
 * looks the account up) and an {@link RateLimitAttempt} carrying the client
 * address when one is known. Keying on the raw form value would hand an
 * attacker a fresh bucket per case variant of one address. An attempt whose
 * body names no email (a reset confirmation, a two-factor code, or a body the
 * parser cannot read) still counts, against the client address alone.
 *
 * The client address is never read here: it is the bucket of the client
 * core's first pipeline stage resolved (`c.var.client`, from the socket peer
 * and only the forwarding headers `server.trustedProxies` vouches for), so an
 * IPv4 client is keyed on its address and an IPv6 client on its /64.
 */

/** Which credential surface an attempt targets. */
export type RateLimitRoute =
  | 'login'
  | 'register'
  | 'password-reset'
  | 'password-reset-confirm'
  | 'verification'
  | 'magic-link'
  | 'magic-link-verify'
  | 'two-factor'
  | 'email-otp';

/** What a rate-limit hook is told about one attempt. */
export interface RateLimitAttempt {
  /** The trimmed, lowercased email, or `null` when the request names none. */
  readonly email: string | null;
  /**
   * The client's bucket as core resolved it (`ClientAddress.bucket`: an IPv4
   * address, or an IPv6 `/64` network), or `null` when the client is unknown.
   */
  readonly ip: string | null;
  /** The credential surface the attempt targets. */
  readonly route: RateLimitRoute;
  /** The incoming request. */
  readonly request: Request;
}

/**
 * A rate-limit gate: an exact `true` allows, anything else (or a throw) denies.
 * `email` is the normalized address, the same value as `attempt.email`; it is
 * `null` for an attempt that names no email, which a hook must still count
 * (against `attempt.ip`), or a malformed body becomes a free attempt.
 */
export type RateLimitHook = (
  email: string | null,
  attempt: RateLimitAttempt,
) => boolean | Promise<boolean>;

/** Normalize an email the way the account lookup does: trimmed and lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
 * client address alone. An attempt is denied when either is exhausted, and a
 * denied attempt is not counted. The per-email bucket includes the address so
 * a stranger cannot lock a user out from elsewhere; the per-address bucket
 * stops password spraying, where one client tries a password against many
 * accounts. When no address is known the per-email key degrades to the email
 * alone and the per-address bucket is skipped; an attempt with neither an
 * email nor an address is counted in one bucket per route. State is per process, so a multi-instance deployment should supply a
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

  /** The window `key` is counting in now, or `undefined` when none is open. */
  const open = (key: string, at: number): { start: number; count: number } | undefined => {
    const current = windows.get(key);
    return current !== undefined && at - current.start < windowMs ? current : undefined;
  };

  /**
   * Count one allowed attempt against `key`. Re-inserting moves the key to the
   * end, so eviction drops the least recently used window: a client spraying
   * fresh emails cannot push its own per-address bucket out of the map.
   */
  const record = (
    key: string,
    current: { start: number; count: number } | undefined,
    at: number,
  ) => {
    windows.delete(key);
    if (windows.size >= maxKeys) {
      for (const [stale, window] of windows) {
        if (at - window.start >= windowMs) windows.delete(stale);
      }
      // Map iteration is insertion order, so the first key is the least recently used.
      const oldest = windows.keys().next();
      if (windows.size >= maxKeys && oldest.done !== true) windows.delete(oldest.value);
    }
    windows.set(
      key,
      current === undefined
        ? { start: at, count: 1 }
        : { start: current.start, count: current.count + 1 },
    );
  };

  return (email, attempt) => {
    const at = now();
    // An attempt naming no email counts against the address alone; with no
    // address either, every such attempt on the route shares one bucket.
    const emailKey =
      email === null
        ? undefined
        : `${attempt.route}\u0000${normalizeEmail(email)}\u0000${attempt.ip ?? ''}`;
    // A distinct prefix keeps the per-address key from colliding with any per-email key.
    const addressKey =
      attempt.ip === null && email !== null
        ? undefined
        : `ip\u0000${attempt.route}\u0000${attempt.ip ?? ''}`;
    const emailWindow = emailKey === undefined ? undefined : open(emailKey, at);
    const addressWindow = addressKey === undefined ? undefined : open(addressKey, at);
    // A denied attempt changes nothing: it neither opens a window nor refreshes
    // one's recency, so hammering an exhausted bucket cannot reset or pin it.
    if ((emailWindow?.count ?? 0) >= limit || (addressWindow?.count ?? 0) >= perAddressLimit) {
      return false;
    }
    if (emailKey !== undefined) record(emailKey, emailWindow, at);
    if (addressKey !== undefined) record(addressKey, addressWindow, at);
    return true;
  };
}

/**
 * Evaluate a rate-limit hook for one attempt. Returns `true` only for an exact
 * `true` result; `false`, a truthy non-boolean, or a throw all deny (fail
 * closed).
 */
export async function rateLimitAllows(
  hook: RateLimitHook,
  email: string | null,
  attempt: Omit<RateLimitAttempt, 'email'>,
): Promise<boolean> {
  const normalized = email === null ? null : normalizeEmail(email);
  try {
    return (await hook(normalized, { ...attempt, email: normalized })) === true;
  } catch {
    return false;
  }
}
