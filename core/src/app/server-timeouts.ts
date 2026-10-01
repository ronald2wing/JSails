/**
 * The Node HTTP server timeouts `Application.serve` applies: the proxy-friendly
 * defaults and the validation of an app's overrides.
 *
 * Apart from the server lifecycle in `serve.ts` so the app config loader can
 * validate `server.timeouts` without loading the HTTP server: a command that
 * reads a config never serves it.
 */

/** Node HTTP server timeouts, in milliseconds. */
export interface ServerTimeouts {
  /** Idle time before a keep-alive socket is closed. Keep it above the proxy's idle timeout. */
  readonly keepAliveTimeoutMs: number;
  /** Time allowed to receive the request headers. Must exceed `keepAliveTimeoutMs`. */
  readonly headersTimeoutMs: number;
  /** Time allowed to receive the whole request; `0` disables it. */
  readonly requestTimeoutMs: number;
}

/**
 * Defaults chosen for running behind a load balancer: AWS ALB and nginx keep
 * idle upstream sockets for 60 s, so a 5 s Node keep-alive (the Node default)
 * races them into intermittent 502s.
 */
export const DEFAULT_SERVER_TIMEOUTS: ServerTimeouts = Object.freeze({
  keepAliveTimeoutMs: 65_000,
  headersTimeoutMs: 66_000,
  requestTimeoutMs: 300_000,
});

/** Validate timeout overrides against the defaults and Node's own constraints. */
export function resolveServerTimeouts(
  overrides: Partial<ServerTimeouts> | undefined,
): ServerTimeouts {
  const merged = { ...DEFAULT_SERVER_TIMEOUTS, ...overrides };
  for (const [name, value] of Object.entries(merged)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new TypeError(`server timeout ${name} must be a non-negative integer`);
    }
  }
  if (merged.keepAliveTimeoutMs === 0 || merged.headersTimeoutMs === 0) {
    throw new TypeError('keepAliveTimeoutMs and headersTimeoutMs must be positive');
  }
  if (merged.requestTimeoutMs > 0 && merged.headersTimeoutMs > merged.requestTimeoutMs) {
    throw new TypeError('headersTimeoutMs must not exceed requestTimeoutMs');
  }
  return merged;
}
