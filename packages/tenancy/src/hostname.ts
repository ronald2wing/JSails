/**
 * Hostname normalisation for tenant routing and custom domains.
 *
 * {@link normalizeHostname} turns a `Host` header value (or any configured
 * hostname) into the single canonical form every tenancy comparison uses:
 * lower-case ASCII, IDNA A-labels (UTS-46 through WHATWG `domainToASCII`), no
 * port and no trailing dot. Anything that is not a DNS host name in the
 * RFC 1035/1123 sense is refused with `null` rather than repaired:
 *
 * - IP literals (IPv4 in any WHATWG-accepted spelling, bracketed or bare IPv6),
 *   because a tenant is never addressed by address;
 * - percent-encoding, user info, paths, whitespace and control characters,
 *   which the URL host parser would otherwise decode or split silently;
 * - a port that no connection can carry: one outside 1-65535 (the WHATWG
 *   parser refuses anything above 65535; port 0 cannot be connected to), or
 *   one written with more than five digits;
 * - labels outside letters-digits-hyphen (so `_`, `*` and empty labels), labels
 *   over 63 octets and names over 253 octets;
 * - labels with `--` in the third and fourth position (RFC 5891 reserved
 *   labels) unless they are well-formed `xn--` A-labels.
 *
 * The result is idempotent: a normalised name normalises to itself.
 */

import { domainToASCII, domainToUnicode } from 'node:url';

/** The longest host name, in octets, RFC 1035 allows in presentation form. */
export const MAX_HOSTNAME_LENGTH = 253;

/** The longest DNS label, in octets. */
export const MAX_LABEL_LENGTH = 63;

/** Upper bound on raw input, so hostile headers cost bounded work. */
const MAX_INPUT_LENGTH = 1024;

/** Characters that never belong in a host (with optional port) as sent on the wire. */
const FORBIDDEN_INPUT = /[\s\p{Cc}%/\\?#@[\]]/u;

const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The WHATWG "ends in a number" test: such a host is parsed as IPv4. */
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/;

const PORT_SUFFIX = /:([0-9]{1,5})$/;

const MAX_PORT = 65_535;

function validLabel(label: string): boolean {
  if (!LDH_LABEL.test(label)) {
    return false;
  }
  if (label.slice(2, 4) !== '--') {
    return true;
  }
  if (!label.startsWith('xn--')) {
    return false;
  }
  // An A-label is valid only when it decodes to a U-label that encodes back
  // to itself; an undecodable label is returned unchanged by domainToUnicode.
  const unicode = domainToUnicode(label);
  return unicode !== label && domainToASCII(unicode) === label;
}

/**
 * Normalise a host name, or a `host[:port]` value, to its canonical ASCII form.
 * Returns `null` for anything that is not a DNS host name.
 */
export function normalizeHostname(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT_LENGTH) {
    return null;
  }
  if (FORBIDDEN_INPUT.test(input)) {
    return null;
  }
  let host = input;
  const port = PORT_SUFFIX.exec(input);
  if (port !== null) {
    const value = Number(port[1]);
    if (value < 1 || value > MAX_PORT) {
      return null;
    }
    host = input.slice(0, port.index);
  }
  if (host.includes(':')) {
    return null;
  }
  if (host.endsWith('.')) {
    host = host.slice(0, -1);
  }
  if (host.length === 0) {
    return null;
  }
  const ascii = domainToASCII(host);
  if (ascii.length === 0 || ascii.length > MAX_HOSTNAME_LENGTH) {
    return null;
  }
  const labels = ascii.split('.');
  const last = labels[labels.length - 1] ?? '';
  if (NUMERIC_LABEL.test(last)) {
    return null;
  }
  return labels.every(validLabel) ? ascii : null;
}

/** Whether `hostname` equals `parent` or is a subdomain of it (both normalised). */
export function isHostnameWithin(hostname: string, parent: string): boolean {
  return hostname === parent || hostname.endsWith(`.${parent}`);
}
