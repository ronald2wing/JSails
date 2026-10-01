/**
 * The API-token service for the `auth` plugin: the plugin options, the
 * per-request {@link ApiTokenService}, its service token, and the
 * `RequestContext` helpers that read the service from `context.services`.
 *
 * The service wraps an {@link ApiTokenStore} with the policy the store does not
 * know: who may mint (only a signed-in session), what a valid name and lifetime
 * are, and the credential resolution order — the cookie session first, then
 * the `Bearer` token in the configured header, and never a token when the
 * surface is disabled. The token secret is returned exactly once, from
 * `createApiToken`; the list and resolve paths never expose it.
 */

import type { RequestContext, Session } from 'jsails';
import { createServiceToken, type ServiceToken } from 'jsails/extensions';
import { isPositiveInteger, JsailsError } from 'jsails/plugin-sdk';
import { CONTROL_CHARS } from 'jsails/support';

import type { ApiToken, ApiTokenStore, CreatedApiToken } from './api-token-store.js';
import { deriveCsrfToken } from './better-auth.js';

/** Default lifetime for a freshly minted token, in days. */
const DEFAULT_EXPIRES_IN_DAYS = 30;

/** Upper bound on a token lifetime, in days (ten years). */
const MAX_EXPIRES_IN_DAYS = 3650;

/** Maximum display-name length, in characters. */
const MAX_NAME_LENGTH = 200;

/** Default header carrying the token credential. */
const DEFAULT_HEADER_NAME = 'authorization';

/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Longest credential accepted from a request header. */
const MAX_CREDENTIAL_LENGTH = 512;

/** Options for the `apiTokens` plugin surface. */
export interface ApiTokensOptions {
  /** Enable the token store, service, and `/api/tokens` routes. Defaults to `false`. */
  readonly enabled?: boolean;
  /** Header carrying the `Bearer <token>` credential. Defaults to `authorization`. */
  readonly headerName?: string;
  /** Default token lifetime in days. Defaults to `30`; bounded `1..3650`. */
  readonly expiresInDays?: number;
  /** Injected token store (tests/custom backends); defaults to the DB-backed store. */
  readonly store?: ApiTokenStore;
}

/** Resolved scalar options for the token surface (the `store` seam is separate). */
export interface ResolvedApiTokensOptions {
  readonly enabled: boolean;
  readonly headerName: string;
  readonly expiresInDays: number;
}

/**
 * Resolve and validate the `apiTokens` option. Invalid values (a header name
 * with control characters, or an out-of-range lifetime) are programmer errors
 * in the plugin options, so they throw a `TypeError` at construction time.
 */
export function resolveApiTokensOptions(options?: ApiTokensOptions): ResolvedApiTokensOptions {
  const enabled = options?.enabled === true;

  const headerName = options?.headerName ?? DEFAULT_HEADER_NAME;
  if (
    typeof headerName !== 'string' ||
    headerName.trim() === '' ||
    CONTROL_CHARS.test(headerName)
  ) {
    throw new TypeError(
      'apiTokens.headerName must be a non-empty string without control characters',
    );
  }

  const expiresInDays = options?.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
  if (!isValidExpiresInDays(expiresInDays)) {
    throw new TypeError(
      `apiTokens.expiresInDays must be an integer between 1 and ${MAX_EXPIRES_IN_DAYS}`,
    );
  }

  return { enabled, headerName: headerName.trim(), expiresInDays };
}

/** Input for minting a token. */
export interface CreateApiTokenInput {
  /** Display name; trimmed, non-empty, at most 200 chars, no control chars. */
  readonly name: string;
  /** Lifetime override in days (1..3650); defaults to the configured value. */
  readonly expiresInDays?: number;
}

/**
 * The per-request API-token service the plugin provides under
 * {@link apiTokensToken} when `apiTokens.enabled` is set.
 */
export interface ApiTokenService {
  createApiToken(context: RequestContext, input: CreateApiTokenInput): Promise<CreatedApiToken>;
  listApiTokens(context: RequestContext): Promise<ApiToken[]>;
  revokeApiToken(context: RequestContext, id: string): Promise<boolean>;
  /** Cookie session first, then the `Bearer` token; `null` when neither holds. */
  resolveSessionWithApiToken(request: Request): Promise<Session | null>;
}

/** What {@link createApiTokenService} needs. */
export interface ApiTokenServiceOptions {
  readonly store: ApiTokenStore;
  /** Resolves the browser session from the cookie only. */
  readonly cookieSession: (request: Request) => Promise<Session | null>;
  /** Keys the per-session CSRF token derived for a token-backed session. */
  readonly secret?: string;
  readonly headerName: string;
  readonly expiresInDays: number;
}

/**
 * Create the per-request API-token service. `cookieSession` resolves the
 * browser session (cookie only); the token credential is only consulted after
 * it yields `null`.
 */
export function createApiTokenService(options: ApiTokenServiceOptions): ApiTokenService {
  const { store, cookieSession, secret, headerName, expiresInDays } = options;

  return {
    async createApiToken(context, input) {
      const userId = requireUserId(context);
      const name = validateName(input.name);
      const expiresAt = resolveExpiry(input.expiresInDays, expiresInDays);
      return store.create(userId, name, expiresAt);
    },

    async listApiTokens(context) {
      return store.list(requireUserId(context));
    },

    async revokeApiToken(context, id) {
      const userId = requireUserId(context);
      if (typeof id !== 'string' || id === '') return false;
      return store.revoke(userId, id);
    },

    async resolveSessionWithApiToken(request) {
      const cookie = await cookieSession(request);
      if (cookie !== null) return cookie;

      const token = extractToken(request, headerName);
      if (token === null) return null;

      const resolved = await store.resolve(token);
      if (resolved === null) return null;

      return {
        id: resolved.sessionId,
        csrfToken: deriveCsrfToken(resolved.sessionId, secret),
        data: { user: { id: resolved.userId, name: resolved.name, email: resolved.email } },
        expiresAt: resolved.expiresAt,
      };
    },
  };
}

/** Opaque token for the {@link ApiTokenService}, provided when tokens are enabled. */
export const apiTokensToken: ServiceToken<ApiTokenService> =
  createServiceToken<ApiTokenService>('auth.api-tokens');

/** Machine-readable reason for an {@link ApiTokenError}. */
export type ApiTokenErrorCode =
  'unauthorized' | 'invalid_name' | 'invalid_expiry' | 'invalid_body' | 'disabled';

/** A value-free failure from the API-token surface. */
export class ApiTokenError extends JsailsError {
  constructor(
    readonly code: ApiTokenErrorCode,
    message: string,
    /** Suggested HTTP status for the failure. */
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Mint a token for the session on `context`. Reads the service from
 * `context.services`; throws {@link ApiTokenError} (`disabled`) when the
 * `apiTokens` surface is not enabled.
 */
export function createApiToken(
  context: RequestContext,
  input: CreateApiTokenInput,
): Promise<CreatedApiToken> {
  return requireApiTokenService(context).createApiToken(context, input);
}

/** List the tokens owned by the session on `context` (no secrets). */
export function listApiTokens(context: RequestContext): Promise<ApiToken[]> {
  return requireApiTokenService(context).listApiTokens(context);
}

/** Revoke the token `id` owned by the session on `context`. */
export function revokeApiToken(context: RequestContext, id: string): Promise<boolean> {
  return requireApiTokenService(context).revokeApiToken(context, id);
}

function requireApiTokenService(context: RequestContext): ApiTokenService {
  const service = context.services?.tryGet(apiTokensToken);
  if (service === undefined) {
    throw new ApiTokenError('disabled', 'API tokens are not enabled', 404);
  }
  return service;
}

/** Read the owning user id from a resolved session, or throw `unauthorized`. */
function requireUserId(context: RequestContext): string {
  const userId = sessionUserId(context.session);
  if (userId === null) {
    throw new ApiTokenError('unauthorized', 'authentication required', 401);
  }
  return userId;
}

/** Extract a non-empty string user id from `session.data.user.id`, or `null`. */
function sessionUserId(session: Session | null): string | null {
  if (session === null) return null;
  const user = session.data.user;
  if (typeof user !== 'object' || user === null || Array.isArray(user)) return null;
  const id = user.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Whether `value` is a token lifetime within the allowed day range. */
function isValidExpiresInDays(value: unknown): value is number {
  return isPositiveInteger(value) && value <= MAX_EXPIRES_IN_DAYS;
}

/** Validate a token display name, returning the trimmed name or throwing. */
function validateName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiTokenError('invalid_name', 'token name is required', 400);
  }
  const name = value.trim();
  if (name === '') {
    throw new ApiTokenError('invalid_name', 'token name is required', 400);
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiTokenError(
      'invalid_name',
      `token name must be at most ${MAX_NAME_LENGTH} characters`,
      400,
    );
  }
  if (CONTROL_CHARS.test(name)) {
    throw new ApiTokenError('invalid_name', 'token name must not contain control characters', 400);
  }
  return name;
}

/** Resolve a token expiry date from an optional day count, or throw. */
function resolveExpiry(expiresInDays: unknown, defaultDays: number): Date {
  const days = expiresInDays === undefined ? defaultDays : expiresInDays;
  if (!isValidExpiresInDays(days)) {
    throw new ApiTokenError(
      'invalid_expiry',
      `expiresInDays must be an integer between 1 and ${MAX_EXPIRES_IN_DAYS}`,
      400,
    );
  }
  return new Date(Date.now() + days * DAY_MS);
}

/** Extract a `Bearer <token>` credential from the configured header, or `null`. */
function extractToken(request: Request, headerName: string): string | null {
  const header = request.headers.get(headerName);
  if (header === null) return null;
  const value = header.trim();
  if (value === '' || value.length > MAX_CREDENTIAL_LENGTH) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(value);
  return match?.[1] ?? null;
}
