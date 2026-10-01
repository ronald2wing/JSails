/**
 * Shared value guards for the proxy and cache-proxy configuration planners.
 *
 * Both planners turn config strings into argv tokens, so both must reject a
 * value that could be read as a flag, split a token, or inject control bytes.
 * The caller supplies its domain error class; the check and message shape stay
 * identical.
 */

import { CONTROL_CHARS } from '../../support/strings.js';

export { CONTROL_CHARS };

/** Highest valid TCP port. */
export const MAX_PORT = 65535;

/** A value-free error constructor for one proxy domain. */
export type ProxyErrorConstructor = new (message: string) => Error;

/** Validate a non-empty, single-token config value. */
export function assertProxyValue(
  value: string | undefined,
  label: string,
  ErrorType: ProxyErrorConstructor,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ErrorType(`${label} must be a non-empty string`);
  }
  if (/\s/.test(value) || CONTROL_CHARS.test(value)) {
    throw new ErrorType(`${label} must not contain whitespace or control characters`);
  }
  if (value.startsWith('-')) {
    throw new ErrorType(`${label} must not start with "-"`);
  }
  return value;
}

/** Validate a TCP port. */
export function assertProxyPort(
  port: number,
  label: string,
  ErrorType: ProxyErrorConstructor,
): number {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new ErrorType(`${label} must be an integer between 1 and ${MAX_PORT}`);
  }
  return port;
}
