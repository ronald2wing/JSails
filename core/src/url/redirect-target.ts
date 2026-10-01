/**
 * Shared redirect-target validation for every surface that emits a `Location`
 * header or a client navigation: server-component actions and HTTP responses.
 *
 * A redirect target must be a non-empty string without control characters or
 * whitespace. `javascript:`, `data:`, and `vbscript:` schemes are rejected —
 * they turn a caller-composed URL into script execution. Relative paths,
 * absolute `http(s)` URLs, and other safe schemes remain allowed.
 */

const FORBIDDEN_SCHEMES = new Set(['javascript', 'data', 'vbscript']);

/** Validate and return a trimmed redirect target. Throws a value-free `TypeError`. */
export function assertRedirectTarget(url: string): string {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new TypeError('redirect url must be a non-empty string');
  }
  if (/[\x00-\x1f\x7f\s]/.test(url)) {
    throw new TypeError('redirect url must not contain control characters or whitespace');
  }

  const trimmed = url.trim();
  const schemeEnd = trimmed.indexOf(':');
  if (schemeEnd !== -1) {
    const scheme = trimmed.slice(0, schemeEnd).toLowerCase();
    if (FORBIDDEN_SCHEMES.has(scheme)) {
      throw new TypeError('redirect url must not use a javascript:, data:, or vbscript: scheme');
    }
  }

  return trimmed;
}
