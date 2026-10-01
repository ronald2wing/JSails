/**
 * The one redirect-target rule, for every surface that emits a `Location`
 * header or a client navigation: `Respond.redirect`, a page's
 * `reply.redirect`, a server-component action's `redirect`, and the Inertia
 * adapter.
 *
 * A redirect goes to a same-origin path unless the code says otherwise with
 * an explicit external form (`Respond.redirectExternal`,
 * `reply.redirectExternal`). {@link isSameOriginPath} is the check: a
 * root-relative path with no scheme, no authority (`//host`), no backslash
 * (browsers read `/\host` as `//host`), no control character, no `..` segment
 * (plain or percent-encoded) in the path, and well-formed UTF-16. Such a path
 * resolves against any request URL to that URL's origin.
 *
 * {@link sameOriginLocation} returns the path as a header carries it: every
 * character outside visible ASCII percent-encoded as UTF-8 (`/café` becomes
 * `/caf%C3%A9`, a space `%20`), because a header value is bytes, not text.
 * Nothing else is rewritten; in particular the path is not normalised, since
 * resolving `/.//host` would turn a same-origin path into `//host`.
 * {@link safeRedirectPath} is the form for a target that arrived with the
 * request (a `?next=` parameter): the encoded path, or a fallback.
 *
 * Browser-safe and dependency-free beyond the error kernel, so the client
 * bundle and the server share it.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

const REDIRECT_ERRORS = {
  invalid_target: {
    kind: 'internal',
    message: 'a redirect target is not a same-origin path',
    suggestion:
      'redirect to a root-relative path such as /dashboard; pass a target that came with the request through safeRedirectPath, and use redirectExternal for another origin',
  },
  invalid_external_target: {
    kind: 'internal',
    message: 'an external redirect target is not an absolute http(s) URL without credentials',
  },
  invalid_status: {
    kind: 'internal',
    message: 'a redirect status is not one of {allowed}',
    context: { allowed: ['301, 302, 303, 307, 308', '302, 303, 307, 308'] },
  },
  invalid_fallback: {
    kind: 'internal',
    message: 'the fallback of safeRedirectPath is not a same-origin path',
  },
} as const;

/**
 * The redirect codes, `redirect.*`: a target that is not a same-origin path,
 * an external target that is not an absolute http(s) URL, a status that is
 * not a redirect, and an invalid `safeRedirectPath` fallback. All are
 * programming errors (`internal`): none echoes the target.
 *
 * @public
 */
export const RedirectErrors: ErrorRegistry<'redirect', typeof REDIRECT_ERRORS> = defineErrors(
  'redirect',
  REDIRECT_ERRORS,
);

/** With the `u` flag, a surrogate range matches only an unpaired surrogate. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/**
 * Whether `value` is a root-relative path that cannot leave the origin it is
 * resolved against.
 *
 * @public
 */
export function isSameOriginPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value[0] !== '/') return false;
  // A lone surrogate has no UTF-8 form, so it could not be percent-encoded.
  if (value.startsWith('//') || LONE_SURROGATE.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x5c || code < 0x20 || code === 0x7f) return false;
  }
  const path = value.split(/[?#]/u, 1)[0] ?? '';
  return !path.split('/').some((segment) => DOT_DOT.has(segment.toLowerCase()));
}

/**
 * `value` as a `Location` header carries it when it is a same-origin path
 * (everything outside visible ASCII percent-encoded), else `undefined`.
 */
export function sameOriginLocation(value: unknown): string | undefined {
  if (!isSameOriginPath(value)) return undefined;
  return value.replace(OUTSIDE_VISIBLE_ASCII, (character) => encodeURIComponent(character));
}

/**
 * The redirect target for a value that came with the request (a `?next=`
 * parameter, a form field): `input` encoded for a header when it is a
 * same-origin path, otherwise `fallback`. A `fallback` that is not a
 * same-origin path is a `redirect.invalid_fallback` error.
 *
 * @public
 */
export function safeRedirectPath(input: unknown, fallback: string): string {
  const location = sameOriginLocation(fallback);
  if (location === undefined) throw new RedirectErrors.Error('invalid_fallback');
  return sameOriginLocation(input) ?? location;
}

/**
 * The `Location` of an explicit external redirect: the serialized `href` of
 * an absolute `http:` or `https:` URL that carries no credentials, else
 * `undefined`.
 */
export function externalLocation(value: unknown): string | undefined {
  if (typeof value !== 'string' && !(value instanceof URL)) return undefined;
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return undefined;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return undefined;
  if (target.username !== '' || target.password !== '') return undefined;
  return target.href;
}

/** Whether `status` is an HTTP redirect status that carries a `Location`. */
export function isRedirectStatus(status: unknown): status is 301 | 302 | 303 | 307 | 308 {
  return typeof status === 'number' && REDIRECT_STATUSES.has(status);
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Whether `value` is a `Location` either form produces. */
export function isRedirectLocation(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (sameOriginLocation(value) === value || externalLocation(value) === value)
  );
}

const OUTSIDE_VISIBLE_ASCII = /[^\x21-\x7e]/gu;

const DOT_DOT: ReadonlySet<string> = new Set(['..', '%2e%2e', '.%2e', '%2e.']);
