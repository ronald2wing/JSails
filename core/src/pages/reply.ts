/**
 * The answers a page's `load` may give besides plain props: `reply.*`.
 *
 * ```ts
 * export async function load(context: RequestContext) {
 *   if (context.session === null) return reply.redirect('/login?next=%2Faccount');
 *   const account = await findAccount(context.session);
 *   if (account === undefined) return reply.notFound();
 *   return reply.props({ account }, { cookies: [{ name: 'seen', value: '1' }] });
 * }
 * ```
 *
 * - `reply.props(props, { status, headers, cookies })` renders the page with
 *   those props, answering with `status` (a document status, 200 by
 *   default), the extra `headers`, and one `Set-Cookie` per cookie;
 * - `reply.redirect(path, { status })` redirects to a same-origin path (302
 *   by default; 303, 307 or 308 on request), percent-encoded for the header;
 * - `reply.redirectExternal(url, { status })` is the explicit form for an
 *   absolute http(s) URL on another origin;
 * - `reply.notFound()` answers with the app's not-found page; a static export
 *   writes nothing for the URL.
 *
 * Only a page's `load` may reply: a layout cannot redirect, and an error
 * boundary renders a document with the failure's status. A reply is a frozen
 * value this module minted (a module-private set records each one), so a
 * props object that happens to look like a reply is still props.
 *
 * Every argument is checked when the reply is built, with value-free codes
 * (`reply.*` and `redirect.*`): reserved headers (`Set-Cookie` has its own
 * option, `Location` its own helper, the cache policy is the route's
 * declaration, framing is the server's) and a malformed cookie fail before
 * anything renders.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { Cookie, type CookieSerializeOptions } from '../support/cookie.server.js';
import { externalLocation, RedirectErrors, sameOriginLocation } from '../url/redirect-target.js';

const REPLY_ERRORS = {
  invalid_status: {
    kind: 'internal',
    message: 'a page reply status must be 200 to 599 with a body, and not a redirect',
    suggestion:
      'redirect with reply.redirect; a document status is 200, 2xx with a body, 4xx or 5xx',
  },
  invalid_header: {
    kind: 'internal',
    message: 'a page reply header has an invalid name or value',
  },
  reserved_header: {
    kind: 'internal',
    message: 'a page reply may not set the {header} header',
    context: {
      header: [
        'set-cookie',
        'location',
        'cache-control',
        'surrogate-control',
        'content-type',
        'content-length',
        'content-encoding',
        'transfer-encoding',
      ],
    },
    suggestion:
      'set cookies with the cookies option, redirect with reply.redirect, and declare caching on the route',
  },
  invalid_cookie: {
    kind: 'internal',
    message: 'a page reply cookie has an invalid name, value or attribute',
  },
  invalid_options: {
    kind: 'internal',
    message: 'a page reply was given options that are not an object',
  },
} as const;

/**
 * The page reply codes, `reply.*`: a status that is not a document status,
 * a malformed or reserved header, a malformed cookie, and options that are
 * not an object. All are programming errors; none echoes a value.
 *
 * @public
 */
export const ReplyErrors: ErrorRegistry<'reply', typeof REPLY_ERRORS> = defineErrors(
  'reply',
  REPLY_ERRORS,
);

declare const PAGE_REPLY: unique symbol;

/**
 * A cookie a page reply sets: its name and value, plus `Set-Cookie`
 * attributes. Absent attributes default to `Path=/`, `HttpOnly`,
 * `SameSite=Lax`, and `Secure` when the request came over https.
 *
 * @public
 */
export interface CookieInit extends CookieSerializeOptions {
  readonly name: string;
  readonly value: string;
}

/**
 * A redirect status a page reply may choose.
 *
 * @public
 */
export type ReplyRedirectStatus = 302 | 303 | 307 | 308;

/**
 * Options of `reply.props`.
 *
 * @public
 */
export interface ReplyPropsOptions {
  /** The document status: 200 by default; any status from 200 to 599 with a body. */
  readonly status?: number;
  /** Extra response headers. */
  readonly headers?: Headers | readonly (readonly [string, string])[];
  /** Cookies to set, one `Set-Cookie` header each. */
  readonly cookies?: readonly CookieInit[];
}

/**
 * Options of `reply.redirect` and `reply.redirectExternal`.
 *
 * @public
 */
export interface ReplyRedirectOptions {
  /** 302 by default. */
  readonly status?: ReplyRedirectStatus;
}

/**
 * Render the page with `props`, the status, headers and cookies chosen.
 *
 * @public
 */
export interface PropsReply<P> {
  readonly [PAGE_REPLY]: 'props';
  readonly kind: 'props';
  readonly props: P;
  readonly status: number;
  /** Lower-cased header names with their values, in the order given. */
  readonly headers: readonly (readonly [string, string])[];
  readonly cookies: readonly CookieInit[];
}

/**
 * Redirect to `location`, already validated and encoded for the header.
 *
 * @public
 */
export interface RedirectReply {
  readonly [PAGE_REPLY]: 'redirect';
  readonly kind: 'redirect';
  readonly status: ReplyRedirectStatus;
  readonly location: string;
}

/**
 * Answer with the app's not-found page.
 *
 * @public
 */
export interface NotFoundReply {
  readonly [PAGE_REPLY]: 'not-found';
  readonly kind: 'not-found';
}

/**
 * Every reply a page's `load` may give for props of type `P`.
 *
 * @public
 */
export type PageReply<P = unknown> = PropsReply<P> | RedirectReply | NotFoundReply;

/**
 * What a page's `load` resolves to: its props, or a reply.
 *
 * @public
 */
export type LoadResult<P> = P | PageReply<P>;

/**
 * The props a page renders with, from what its `load` resolves to: the props
 * of a `reply.props`, plain props as they are, and nothing for a redirect or
 * a not-found reply (those never render).
 *
 * @public
 */
export type PagePropsOf<R> =
  R extends PropsReply<infer P> ? P : R extends RedirectReply | NotFoundReply ? never : R;

/**
 * The props of a page whose `load` is `L`: `PageProps<typeof load>`.
 *
 * @public
 */
export type PageProps<L extends (...args: never[]) => unknown> = PagePropsOf<
  Awaited<ReturnType<L>>
>;

const minted = new WeakSet<object>();

function mint<T extends object>(value: T): T {
  const reply = Object.freeze(value);
  minted.add(reply);
  return reply;
}

/** Whether `value` is a reply `reply.*` built. */
export function isPageReply(value: unknown): value is PageReply {
  return typeof value === 'object' && value !== null && minted.has(value);
}

const RESERVED_HEADERS: ReadonlySet<string> = new Set(REPLY_ERRORS.reserved_header.context.header);

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([302, 303, 307, 308]);

/**
 * Whether a document may carry `status`: an integer from 200 to 599 that
 * allows a body (not 204 or 205) and is not in the 3xx class (a redirect has
 * its own outcome, and the finalizer alone answers 304).
 */
export function isDocumentStatus(status: unknown): status is number {
  return (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 200 &&
    status <= 599 &&
    (status < 300 || status >= 400) &&
    status !== 204 &&
    status !== 205
  );
}

function optionsOf<T extends object>(options: T | undefined): Partial<T> {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null) {
    throw new ReplyErrors.Error('invalid_options');
  }
  return options;
}

function headerPairs(
  headers: ReplyPropsOptions['headers'] | undefined,
): readonly (readonly [string, string])[] {
  if (headers === undefined) return Object.freeze([]);
  let parsed: Headers;
  try {
    parsed = new Headers(headers as HeadersInit);
  } catch (error) {
    throw new ReplyErrors.Error('invalid_header', {}, { cause: error });
  }
  const pairs: (readonly [string, string])[] = [];
  for (const [name, value] of parsed) {
    if (RESERVED_HEADERS.has(name)) {
      throw new ReplyErrors.Error('reserved_header', {
        header: name as (typeof REPLY_ERRORS.reserved_header.context.header)[number],
      });
    }
    pairs.push(Object.freeze([name, value] as const));
  }
  return Object.freeze(pairs);
}

function cookieList(cookies: readonly CookieInit[] | undefined): readonly CookieInit[] {
  if (cookies === undefined) return Object.freeze([]);
  if (!Array.isArray(cookies)) throw new ReplyErrors.Error('invalid_cookie');
  return Object.freeze(
    cookies.map((cookie: unknown) => {
      if (typeof cookie !== 'object' || cookie === null) {
        throw new ReplyErrors.Error('invalid_cookie');
      }
      const copy = Object.freeze({ ...(cookie as CookieInit) });
      // Serialized once here so a malformed cookie fails when the reply is
      // built, not after the page rendered.
      serializeCookie(copy, true);
      return copy;
    }),
  );
}

/**
 * One `Set-Cookie` line for `cookie`, with the reply defaults for the
 * attributes it leaves out; `secure` is the default of its `Secure`
 * attribute.
 */
export function serializeCookie(cookie: CookieInit, secure: boolean): string {
  const { name, value, ...attributes } = cookie;
  if (typeof name !== 'string' || typeof value !== 'string') {
    throw new ReplyErrors.Error('invalid_cookie');
  }
  try {
    return Cookie.serialize(name, value, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      ...attributes,
    });
  } catch (error) {
    throw new ReplyErrors.Error('invalid_cookie', {}, { cause: error });
  }
}

function redirectStatus(status: unknown): ReplyRedirectStatus {
  if (status === undefined) return 302;
  if (typeof status !== 'number' || !REDIRECT_STATUSES.has(status)) {
    throw new RedirectErrors.Error('invalid_status', { allowed: '302, 303, 307, 308' });
  }
  return status as ReplyRedirectStatus;
}

/** Render the page with `props`; see the module comment. */
function props<P>(value: P, options?: ReplyPropsOptions): PropsReply<P> {
  const { status = 200, headers, cookies } = optionsOf(options);
  if (!isDocumentStatus(status)) throw new ReplyErrors.Error('invalid_status');
  return mint({
    kind: 'props',
    props: value,
    status,
    headers: headerPairs(headers),
    cookies: cookieList(cookies),
  } as PropsReply<P>);
}

/** Redirect to a same-origin path; see the module comment. */
function redirect(to: string, options?: ReplyRedirectOptions): RedirectReply {
  const location = sameOriginLocation(to);
  if (location === undefined) throw new RedirectErrors.Error('invalid_target');
  const status = redirectStatus(optionsOf(options).status);
  return mint({ kind: 'redirect', status, location } as RedirectReply);
}

/** Redirect to an absolute http(s) URL on any origin; see the module comment. */
function redirectExternal(to: string | URL, options?: ReplyRedirectOptions): RedirectReply {
  const location = externalLocation(to);
  if (location === undefined) throw new RedirectErrors.Error('invalid_external_target');
  const status = redirectStatus(optionsOf(options).status);
  return mint({ kind: 'redirect', status, location } as RedirectReply);
}

const NOT_FOUND: NotFoundReply = mint({ kind: 'not-found' } as NotFoundReply);

/** Answer with the app's not-found page; see the module comment. */
function notFound(): NotFoundReply {
  return NOT_FOUND;
}

/**
 * The page replies a `load` may return instead of plain props; see the
 * module comment.
 *
 * @public
 */
export const reply: Readonly<{
  props: typeof props;
  redirect: typeof redirect;
  redirectExternal: typeof redirectExternal;
  notFound: typeof notFound;
}> = Object.freeze({ props, redirect, redirectExternal, notFound });
