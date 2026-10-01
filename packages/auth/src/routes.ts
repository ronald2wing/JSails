/**
 * Login/logout and device-approval handlers for the `auth` plugin, plus the
 * request and response helpers every auth handler shares.
 *
 * These are NOT filesystem API routes. They are mounted as trusted extension
 * hook routes by {@link authPlugin}, which bypasses the filesystem API
 * default-deny `authorize` pipeline and its session CSRF middleware. A plain
 * form POST therefore works even while a session cookie is present (the
 * framework would otherwise demand a matching `X-CSRF-Token` for a
 * cookie-authenticated mutation). Each handler owns its own same-origin check
 * instead.
 *
 * The Better Auth instance is passed in by the caller (the plugin owns the
 * memoized construction), so these handlers open no connection and create no
 * state of their own.
 */

import { jsonError, Respond } from 'jsails/api';
import { forbiddenResponse, isSameOriginRequest } from 'jsails/plugin-sdk';
import { deviceApi, type Auth } from './better-auth.js';

/** A per-email rate-limit gate: an exact `true` allows, anything else (or a throw) denies. */
export type RateLimitHook = (email: string) => boolean | Promise<boolean>;

/** What every auth hook-route handler is given besides the request. */
export interface AuthHandlerOptions {
  /** The Better Auth instance; the plugin resolves it lazily per request. */
  readonly auth: Auth;
  /**
   * The same-origin boundary. Prefer the configured `publicOrigin`; `undefined`
   * falls back to the request URL's own origin. A request whose `Origin` header
   * does not match is rejected with `403`.
   */
  readonly publicOrigin?: string;
  /** Per-email rate-limit gate; a non-`true` (or throwing) result yields a generic 429. */
  readonly rateLimit?: RateLimitHook;
}

/** 303 redirect with the given `Set-Cookie` values forwarded individually. */
function redirectWithCookies(location: string, cookies: readonly string[] = []): Response {
  const response = Respond.redirect(location, { status: 303 });
  for (const cookie of cookies) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}

/** Sentinel origin used only to resolve a candidate path; never navigated to. */
const NEXT_PATH_ORIGIN = 'https://sentinel.invalid';

/**
 * Validate a post-login redirect target. Only a local, root-relative path is
 * accepted; anything else — including an absent value — falls back to
 * `/dashboard`, so a hostile `next` can never redirect off-origin.
 *
 * Backslashes are rejected outright because browsers normalize them to `/` in
 * HTTP URLs, so `/\host` would otherwise resolve off-origin. Percent-encoded
 * backslashes are rejected for the same reason. Resolving against a sentinel
 * origin catches every remaining absolute/protocol-relative form.
 */
function safeNextPath(value: string): string {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f\u007f\s]/.test(value) ||
    /%5c/i.test(value)
  ) {
    return '/dashboard';
  }

  let resolved: URL;
  try {
    resolved = new URL(value, NEXT_PATH_ORIGIN);
  } catch {
    return '/dashboard';
  }

  if (resolved.origin !== NEXT_PATH_ORIGIN || !resolved.pathname.startsWith('/')) {
    return '/dashboard';
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * Email/password login: parse the `application/x-www-form-urlencoded` form,
 * delegate to Better Auth's `signInEmail`, forward the `Set-Cookie` header, and
 * redirect. On any failure it redirects back to `/login?error=1` without
 * echoing the credentials or the underlying error.
 */
export async function handleLogin(
  request: Request,
  options: AuthHandlerOptions,
): Promise<Response> {
  if (!isSameOriginRequest(request, options.publicOrigin)) {
    return forbiddenResponse();
  }

  let email: unknown;
  let password: unknown;
  let next: string;
  try {
    const form = await request.formData();
    email = form.get('email');
    password = form.get('password');
    const nextValue = form.get('next');
    next = safeNextPath(typeof nextValue === 'string' ? nextValue : '');
  } catch {
    return redirectWithCookies('/login?error=1');
  }

  if (
    typeof email !== 'string' ||
    email === '' ||
    typeof password !== 'string' ||
    password === ''
  ) {
    return redirectWithCookies(errorRedirect(next));
  }

  // `auth.api.signInEmail` bypasses Better Auth's HTTP-level rate limiter, so
  // the throttle for password guessing is this hook.
  if (options.rateLimit !== undefined && !(await rateLimitAllows(options.rateLimit, email))) {
    return rateLimitedResponse();
  }

  try {
    const result = await options.auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    return redirectWithCookies(next, result.headers.getSetCookie());
  } catch {
    // Never echo the credentials or the raw error back to the client.
    return redirectWithCookies(errorRedirect(next));
  }
}

/** Login failure redirect, preserving a non-default `next` for the retry. */
function errorRedirect(next: string): string {
  if (next === '/dashboard') {
    return '/login?error=1';
  }
  return `/login?error=1&next=${encodeURIComponent(next)}`;
}

/**
 * Logout: call Better Auth's `signOut` with the request headers (the session
 * cookie identifies the session), forward the cleared-cookie headers, and
 * redirect to `/login`. Signing out a stale or absent session is a no-op that
 * still redirects.
 */
export async function handleLogout(
  request: Request,
  options: AuthHandlerOptions,
): Promise<Response> {
  if (!isSameOriginRequest(request, options.publicOrigin)) {
    return forbiddenResponse();
  }

  try {
    const result = await options.auth.api.signOut({
      headers: request.headers,
      returnHeaders: true,
    });
    return redirectWithCookies('/login', result.headers.getSetCookie());
  } catch {
    // The session could not be cleared (no cookie, already expired, or a
    // transport failure); redirecting is still the right outcome.
    return redirectWithCookies('/login');
  }
}

/**
 * Approve or deny a pending device authorization (RFC 8628).
 *
 * Mounted as trusted hook routes at `/api/device/approve` and
 * `/api/device/deny`, so it bypasses the filesystem default-deny `authorize`
 * and the session CSRF middleware — the `/device` page's form POST must work
 * even while the session cookie is present. It owns its own same-origin check.
 *
 * The `action` form field (`approve` | `deny`) is authoritative; the two mount
 * points are aliases. The handler delegates to Better Auth's `deviceApprove` /
 * `deviceDeny` endpoints with the request headers (the session cookie
 * identifies the caller), which enforce the claim/ownership/expiry state
 * machine server-side. It always redirects back to `/device?user_code=...`,
 * where the page's `load` re-reads the code through `deviceVerify` to show the
 * resulting state; a failure (stale, already processed, wrong user) is
 * swallowed rather than echoed because the re-read is authoritative.
 */
export async function handleDeviceAction(
  request: Request,
  options: AuthHandlerOptions,
): Promise<Response> {
  if (!isSameOriginRequest(request, options.publicOrigin)) {
    return forbiddenResponse();
  }

  let userCode: unknown;
  let action: unknown;
  try {
    const form = await request.formData();
    userCode = form.get('user_code');
    action = form.get('action');
  } catch {
    return redirectWithCookies('/device');
  }

  if (typeof userCode !== 'string' || userCode === '') {
    return redirectWithCookies('/device');
  }

  const back = `/device?user_code=${encodeURIComponent(userCode)}`;
  const deny = action === 'deny';

  try {
    if (deny) {
      await deviceApi(options.auth).deviceDeny({ body: { userCode }, headers: request.headers });
    } else {
      await deviceApi(options.auth).deviceApprove({
        body: { userCode },
        headers: request.headers,
      });
    }
  } catch {
    // Stale, already-processed, or claimed by another session. Never echo the
    // underlying error; the review page re-reads the code and shows the state.
  }
  return redirectWithCookies(back);
}

// --- Shared helpers for the registration/reset/verification/token handlers. ---

/** A JSON response body with the given status (default 200). */
export function jsonResponse(data: unknown, status = 200): Response {
  return Respond.json(data, { status });
}

/** The generic 429 every rate-limited auth handler answers with. */
export function rateLimitedResponse(): Response {
  return jsonError(429, 'rate_limited', 'too many requests');
}

/** The 400 for a body that is not a readable form. */
export function invalidBodyResponse(): Response {
  return jsonError(400, 'invalid_body', 'request body must be a form');
}

/**
 * Parse a form body into flat string fields. Non-string entries (file uploads)
 * are skipped; a body that is not `application/x-www-form-urlencoded` or
 * `multipart/form-data` throws, which callers map to {@link invalidBodyResponse}.
 */
export async function readBody(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const body: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      body[key] = value;
    }
  }
  return body;
}

/** Whether `value` is a non-empty, plausibly well-formed email address. */
export function isEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Evaluate a rate-limit hook. Returns `true` only for an exact `true` result;
 * `false`, a truthy non-boolean, or a throw all deny (fail closed).
 */
export async function rateLimitAllows(hook: RateLimitHook, email: string): Promise<boolean> {
  try {
    return (await hook(email)) === true;
  } catch {
    return false;
  }
}
