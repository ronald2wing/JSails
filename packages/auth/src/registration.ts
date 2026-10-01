/**
 * Self-registration for the `auth` plugin.
 *
 * `handleRegister` is mounted at `POST /api/register` by `authPlugin` only when
 * `registration.enabled` is `true`. It is a trusted hook route (not a
 * filesystem API route) that owns its same-origin check. It delegates to Better
 * Auth's `signUpEmail` with `autoSignIn` disabled, so a successful registration
 * creates the account without a session, and a duplicate email is answered
 * identically to a fresh one — the response never leaks which addresses exist.
 */

import { jsonError } from 'jsails/api';
import { forbiddenResponse, isSameOriginRequest } from 'jsails/plugin-sdk';
import {
  invalidBodyResponse,
  isEmail,
  jsonResponse,
  rateLimitAllows,
  rateLimitedResponse,
  readBody,
  type AuthHandlerOptions,
  type RateLimitHook,
} from './routes.js';

/** Options for the self-registration surface. */
export interface RegistrationOptions {
  /** Mount `POST /api/register` and allow self sign-up. Defaults to `false` (fail closed). */
  readonly enabled?: boolean;
  /** Optional per-email rate-limit gate; a non-`true` (or throwing) result yields a generic 429. */
  readonly rateLimit?: RateLimitHook;
}

/**
 * Handle a `POST /api/register` form (`name`, `email`, `password`). On success
 * it returns `200 { status: 'ok' }` with no session cookie; every failure — an
 * invalid email/password, a duplicate account, or a provider error — collapses
 * to a value-free `422` so the response never distinguishes a new account from
 * an existing one.
 */
export async function handleRegister(
  request: Request,
  options: AuthHandlerOptions,
): Promise<Response> {
  if (!isSameOriginRequest(request, options.publicOrigin)) {
    return forbiddenResponse();
  }

  let body: Record<string, string>;
  try {
    body = await readBody(request);
  } catch {
    return invalidBodyResponse();
  }

  const { name, email, password } = body;
  if (
    typeof name !== 'string' ||
    name.trim() === '' ||
    !isEmail(email) ||
    typeof password !== 'string' ||
    password === ''
  ) {
    return jsonError(422, 'invalid_form', 'name, email, and password are required');
  }

  if (options.rateLimit !== undefined && !(await rateLimitAllows(options.rateLimit, email))) {
    return rateLimitedResponse();
  }

  try {
    await options.auth.api.signUpEmail({ body: { name, email, password } });
    return jsonResponse({ status: 'ok' });
  } catch {
    // Never distinguish a duplicate email from a provider failure.
    return jsonError(422, 'registration_failed', 'registration failed');
  }
}
