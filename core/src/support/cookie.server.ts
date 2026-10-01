/**
 * Cookie header handling (server-only): the `Cookie` request header is parsed
 * and `Set-Cookie` serialized through the `cookie` package, while `Set-Cookie`
 * response headers are parsed here, one header per entry, because commas are
 * legal inside `Expires` and so a combined header is treated as one cookie.
 */

import { parseCookie, stringifySetCookie } from 'cookie';

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

const COOKIE_ERRORS = {
  expected_string: {
    kind: 'internal',
    message: 'Cookie.parse: expected a string header',
  },
  malformed_set_cookie: {
    kind: 'invalid',
    message: 'Cookie.parseSetCookie: malformed Set-Cookie header',
  },
} as const;

/**
 * The `Cookie` namespace's codes, `cookie.*`: a header that does not parse
 * (`invalid`) and an argument of the wrong type (`internal`). None echoes the
 * header.
 *
 * @public
 */
export const CookieErrors: ErrorRegistry<'cookie', typeof COOKIE_ERRORS> = defineErrors(
  'cookie',
  COOKIE_ERRORS,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CookieParseOptions {
  /**
   * Custom decoder for a cookie value. Receives the raw value and returns the
   * decoded string (or `undefined` to skip the cookie). Defaults to
   * `decodeURIComponent`.
   */
  readonly decode?: (value: string) => string | undefined;
}

export interface CookieSerializeOptions {
  readonly domain?: string;
  readonly path?: string;
  readonly expires?: Date;
  readonly maxAge?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly partitioned?: boolean;
  readonly priority?: 'low' | 'medium' | 'high';
  readonly sameSite?: boolean | 'lax' | 'strict' | 'none';
}

export interface SetCookieParseOptions {
  /** Decode the value with `decodeURIComponent`. Defaults to true. */
  readonly decodeValues?: boolean;
}

/** One parsed `Set-Cookie` response header. */
export interface ParsedSetCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly domain?: string;
  readonly expires?: Date;
  readonly maxAge?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: string;
}

interface MutableSetCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseOne(header: string, options: { readonly decodeValues: boolean }): ParsedSetCookie {
  const parts = header.split(';');
  const pair = parts.shift()?.trim() ?? '';
  const separator = pair.indexOf('=');
  if (separator <= 0) throw new CookieErrors.Error('malformed_set_cookie');

  const name = pair.slice(0, separator).trim();
  let value = pair.slice(separator + 1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  if (options.decodeValues) value = decodeValue(value);

  const cookie: MutableSetCookie = { name, value };

  for (const part of parts) {
    const attribute = part.trim();
    if (attribute === '') continue;
    const equals = attribute.indexOf('=');
    const key = (equals === -1 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
    const raw = equals === -1 ? '' : attribute.slice(equals + 1).trim();

    switch (key) {
      case 'path':
        cookie.path = raw;
        break;
      case 'domain':
        cookie.domain = raw;
        break;
      case 'expires': {
        const date = new Date(raw);
        if (!Number.isNaN(date.getTime())) cookie.expires = date;
        break;
      }
      case 'max-age': {
        const seconds = Number(raw);
        if (Number.isFinite(seconds)) cookie.maxAge = seconds;
        break;
      }
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'samesite':
        cookie.sameSite = raw.toLowerCase();
        break;
      default:
        break;
    }
  }

  return cookie;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a `Cookie` request header into a name→value record. */
export function parse(
  header: string,
  options: CookieParseOptions = {},
): Record<string, string | undefined> {
  if (typeof header !== 'string') {
    throw new CookieErrors.Error('expected_string');
  }
  // `parseCookie` returns a null-prototype object; spread it into a plain one
  // so callers get ordinary object ergonomics (`hasOwnProperty`, `deepEqual`).
  return { ...parseCookie(header, options) };
}

/** Serialize a `Set-Cookie` header value from a name, value, and options. */
export function serialize(
  name: string,
  value: string,
  options: CookieSerializeOptions = {},
): string {
  return stringifySetCookie({ name, value, ...options });
}

/** Parse one or more `Set-Cookie` response headers into structured objects. */
export function parseSetCookie(
  header: string | readonly string[],
  options: SetCookieParseOptions = {},
): ParsedSetCookie[] {
  const headers = Array.isArray(header) ? [...header] : [header as string];
  try {
    return headers.map((entry) => parseOne(entry, { decodeValues: options.decodeValues ?? true }));
  } catch (error) {
    if (CookieErrors.is(error)) throw error;
    throw new CookieErrors.Error('malformed_set_cookie', {}, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Cookie: Readonly<{
  parse: typeof parse;
  serialize: typeof serialize;
  parseSetCookie: typeof parseSetCookie;
}> = Object.freeze({
  parse,
  serialize,
  parseSetCookie,
});
