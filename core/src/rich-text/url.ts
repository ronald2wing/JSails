/**
 * URL predicates of the rich-text model: which strings a document may carry
 * as a link target ({@link isLinkHref}) and as an embedded frame source
 * ({@link isEmbedUrl}).
 *
 * The persisted schema brands both fields with these predicates, so a value
 * that reached a parsed document already passed them and renderers emit it
 * without a scheme check of their own. Both are allowlists over the raw
 * string, never a blocklist of dangerous schemes: anything not described
 * below is refused, including scheme-relative `//host` URLs, backslashes
 * (which WHATWG parsing turns into slashes for special schemes), userinfo
 * (`https://trusted@evil`), upper-case schemes, and any whitespace, control,
 * bidi-override or lone-surrogate character.
 */

import type { z } from 'zod';

/**
 * Maximum length of a link href or embed URL, in UTF-16 code units.
 *
 * @public
 */
export const MAX_URL_LENGTH = 2048;

/**
 * A string {@link isLinkHref} accepted. Only the predicate (directly or
 * through the schema) produces one.
 *
 * @public
 */
export type LinkHref = string & z.core.$brand<'LinkHref'>;

/**
 * A string {@link isEmbedUrl} accepted. Only the predicate (directly or
 * through the schema) produces one.
 *
 * @public
 */
export type EmbedUrl = string & z.core.$brand<'EmbedUrl'>;

/**
 * True for a character a URL may not contain anywhere: ASCII whitespace and
 * controls (C0, space, DEL), C1 controls, the bidi embedding, override and
 * isolate controls, and backslash.
 */
function isForbiddenUrlUnit(unit: number): boolean {
  return (
    unit <= 0x20 ||
    (unit >= 0x7f && unit <= 0x9f) ||
    (unit >= 0x202a && unit <= 0x202e) ||
    (unit >= 0x2066 && unit <= 0x2069) ||
    unit === 0x5c
  );
}

/** True when `value` is bounded, well-formed UTF-16 and free of forbidden characters. */
function hasUrlCharacters(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (isForbiddenUrlUnit(unit)) {
      return false;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * True for an absolute `http:`/`https:` URL written with its `//` authority,
 * a non-empty host and no userinfo. `schemes` limits which of the two count.
 */
function isWebUrl(value: string, schemes: readonly ('http' | 'https')[]): boolean {
  const scheme = schemes.find((name) => value.startsWith(`${name}://`));
  if (scheme === undefined) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === `${scheme}:` &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === ''
  );
}

/** `mailto:` followed by at least one address character. */
const MAILTO = /^mailto:[^?#]/;

/** `tel:` followed by a dialable number: digits, an optional leading `+`, and visual separators. */
const TEL = /^tel:\+?[0-9][0-9().-]*$/;

/**
 * True when `value` may be a link target in a rich-text document. Accepted:
 *
 * - a same-origin absolute path (`/pricing`, `/a?b#c`), never `//host`;
 * - a fragment (`#section`);
 * - an `http://` or `https://` URL with a host and no userinfo;
 * - a `mailto:` address or a `tel:` number.
 *
 * Schemes are matched case-sensitively in lower case, so `HTTPS://` is refused
 * rather than normalised: a stored document holds exactly one spelling.
 *
 * @public
 */
export function isLinkHref(value: string): value is LinkHref {
  if (typeof value !== 'string' || !hasUrlCharacters(value)) {
    return false;
  }
  if (value.startsWith('/')) {
    return !value.startsWith('//');
  }
  if (value.startsWith('#')) {
    return true;
  }
  return isWebUrl(value, ['http', 'https']) || MAILTO.test(value) || TEL.test(value);
}

/**
 * True when `value` may be the source of an embed block: an `https://` URL
 * with a host and no userinfo. Which hosts actually render as a frame is a
 * renderer policy (its host allowlist), not a property of the document.
 *
 * @public
 */
export function isEmbedUrl(value: string): value is EmbedUrl {
  return typeof value === 'string' && hasUrlCharacters(value) && isWebUrl(value, ['https']);
}
