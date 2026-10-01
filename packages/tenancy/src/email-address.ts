/**
 * Email normalisation for invitation matching.
 *
 * An invitation is addressed to an email and accepted by a user whose
 * verified email must match it, so both sides go through
 * {@link normalizeEmail} and compare equal strings. The form is: Unicode NFC,
 * surrounding whitespace trimmed, the local part lower-cased (address case is
 * not used to tell mailboxes apart in practice), and the domain in canonical
 * A-label form through {@link normalizeHostname}, so `bücher.de` and
 * `xn--bcher-kva.de` are the same address.
 *
 * The local part is a dot-atom whose characters are the RFC 5322 `atext` or,
 * as RFC 6531 extends it, any non-ASCII character (`UTF8-non-ascii`), so
 * scripts written with combining marks (Devanagari, Thai, Arabic harakat) are
 * accepted. Of the non-ASCII characters, those that are invisible or not text
 * are refused: controls, format characters (zero-width and bidi controls),
 * surrogates, private-use and unassigned code points, and separators. Lower-
 * casing can produce a combining mark (`İ` becomes `i` and U+0307, which NFC
 * leaves as two code points); it is a mark, so the address stays valid.
 *
 * It is deliberately not a provider-aware canonicaliser: dots and `+tags`
 * are kept, because removing them would merge mailboxes some providers keep
 * apart. Quoted local parts, comments, IP-literal domains and single-label
 * domains are refused.
 */

import { normalizeHostname } from './hostname.js';

/** The longest address accepted, in UTF-8 octets (RFC 5321 path limit less the angle brackets). */
export const MAX_EMAIL_LENGTH = 254;

/** The longest local part, in UTF-8 octets (RFC 5321 §4.5.3.1.1). */
const MAX_LOCAL_LENGTH = 64;

/**
 * A dot-atom local part: runs of ASCII atext (RFC 5322) or visible non-ASCII
 * text (RFC 6531), separated by single dots.
 */
const LOCAL_PART =
  /^(?:[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]|[^\p{ASCII}\p{C}\p{Z}])+(?:\.(?:[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]|[^\p{ASCII}\p{C}\p{Z}])+)*$/u;

/** Normalise an email address, or return `null` when it is not one. */
export function normalizeEmail(input: string): string | null {
  if (typeof input !== 'string' || input.length > MAX_EMAIL_LENGTH * 4) {
    return null;
  }
  const value = input.normalize('NFC').trim();
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) {
    return null;
  }
  // Lower-casing can leave a sequence NFC would compose, so compose again.
  const local = value.slice(0, at).toLowerCase().normalize('NFC');
  const domain = value.slice(at + 1);
  if (Buffer.byteLength(local, 'utf8') > MAX_LOCAL_LENGTH || !LOCAL_PART.test(local)) {
    return null;
  }
  const hostname = domain.includes(':') ? null : normalizeHostname(domain);
  if (hostname === null || !hostname.includes('.')) {
    return null;
  }
  const address = `${local}@${hostname}`;
  return Buffer.byteLength(address, 'utf8') <= MAX_EMAIL_LENGTH ? address : null;
}
