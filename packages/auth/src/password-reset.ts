/**
 * Password reset and email verification for the `auth` plugin.
 *
 * Both surfaces delegate to Better Auth: `handleRequestPasswordReset` /
 * `handleResetPassword` call `requestPasswordReset` / `resetPassword`, and
 * `handleSendVerificationEmail` calls `sendVerificationEmail`. The delivery
 * callbacks (`emailAndPassword.sendResetPassword` and
 * `emailVerification.sendVerificationEmail`) are built from an injected
 * {@link SendMailFn} by {@link createResetPasswordSender} and
 * {@link createVerificationSender}, so the plugin never hard-depends on any
 * mail transport — the app wires `sendMail` to whatever it uses. The exported
 * {@link sendMail} is the default seam over `@jsails/mail`'s ambient `Mail`
 * facade.
 *
 * Better Auth already answers "user not found" for a reset request and a
 * verification send with the same shape (and a timing floor) as a real send,
 * so these handlers add no enumeration signal of their own; they only
 * validate, rate-limit, and delegate.
 */

import { Mail } from '@jsails/mail';
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

/** Minimal mail delivery seam: recipient address, subject, and plain-text body. */
export type SendMailFn = (to: string, subject: string, text: string) => void | Promise<void>;

/**
 * The default {@link SendMailFn}: a plain-text message through the ambient
 * `Mail` facade from `@jsails/mail`, so reset and verification messages go
 * through whatever transport the mail plugin configured. Outside a live
 * application scope it rejects with the facade's `no_app_scope` error rather
 * than silently dropping mail.
 */
export const sendMail: SendMailFn = (to, subject, text) =>
  Mail.send({ to, subject, text }).then(() => undefined);

/** Options for the password-reset surface. */
export interface PasswordResetOptions {
  /** Mount `POST /api/password-reset` and `POST /api/password-reset/confirm`. Defaults to `false`. */
  readonly enabled?: boolean;
  /** Optional per-email rate-limit gate for the request step. */
  readonly rateLimit?: RateLimitHook;
}

/** Options for the email-verification surface. */
export interface VerificationOptions {
  /** Mount `POST /api/verification/send`. Defaults to `false`. */
  readonly enabled?: boolean;
  /** Optional per-email rate-limit gate. */
  readonly rateLimit?: RateLimitHook;
}

/** The shape Better Auth hands to a send-email callback. */
interface EmailPayload {
  readonly user: { readonly email: string };
  readonly url: string;
  readonly token: string;
}

/** Create Better Auth's `emailAndPassword.sendResetPassword` from a mail seam. */
export function createResetPasswordSender(send: SendMailFn) {
  return async (data: EmailPayload): Promise<void> => {
    await send(
      data.user.email,
      'Reset your password',
      `A password reset was requested for ${data.user.email}.\n\n` +
        `Reset your password here: ${data.url}\n\n` +
        'If you did not request this, you can ignore this email.',
    );
  };
}

/** Create Better Auth's `emailVerification.sendVerificationEmail` from a mail seam. */
export function createVerificationSender(send: SendMailFn) {
  return async (data: EmailPayload): Promise<void> => {
    await send(
      data.user.email,
      'Verify your email address',
      `Verify your email address here: ${data.url}\n\n` +
        'If you did not create an account, you can ignore this email.',
    );
  };
}

/** Handle `POST /api/password-reset` (form field `email`). */
export async function handleRequestPasswordReset(
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

  const email = body.email;
  if (!isEmail(email)) {
    return jsonError(400, 'invalid_email', 'a valid email address is required');
  }

  if (options.rateLimit !== undefined && !(await rateLimitAllows(options.rateLimit, email))) {
    return rateLimitedResponse();
  }

  try {
    // Better Auth answers unknown emails identically (and with a timing floor),
    // so this yields the same generic result whether or not the account exists.
    await options.auth.api.requestPasswordReset({ body: { email } });
  } catch {
    // A provider-level failure (e.g. the send callback is not wired) is a
    // server fault, not a user error; report it generically without leaking why.
    return jsonError(500, 'internal_error', 'the password reset could not be requested');
  }

  return jsonResponse({ status: 'ok' });
}

/** Handle `POST /api/password-reset/confirm` (form fields `token`, `newPassword`). */
export async function handleResetPassword(
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

  const { token, newPassword } = body;
  if (
    typeof token !== 'string' ||
    token === '' ||
    typeof newPassword !== 'string' ||
    newPassword === ''
  ) {
    return jsonError(422, 'invalid_form', 'token and new password are required');
  }

  try {
    // Single-use: Better Auth consumes the token and rejects reuse or expiry.
    await options.auth.api.resetPassword({ body: { newPassword, token } });
  } catch {
    return jsonError(422, 'invalid_token', 'invalid or expired token');
  }

  return jsonResponse({ status: 'ok' });
}

/** Handle `POST /api/verification/send` (form field `email`). */
export async function handleSendVerificationEmail(
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

  const email = body.email;
  if (!isEmail(email)) {
    return jsonError(400, 'invalid_email', 'a valid email address is required');
  }

  if (options.rateLimit !== undefined && !(await rateLimitAllows(options.rateLimit, email))) {
    return rateLimitedResponse();
  }

  try {
    await options.auth.api.sendVerificationEmail({ body: { email } });
  } catch {
    return jsonError(400, 'verification_failed', 'the verification email could not be sent');
  }

  return jsonResponse({ status: 'ok' });
}
