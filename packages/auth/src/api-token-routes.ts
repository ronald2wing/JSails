/**
 * The `/api/tokens` route handlers the `auth` plugin registers when
 * `apiTokens.enabled` is set.
 *
 * Token management requires a signed-in *browser* session: the routes admit
 * only a session resolved from the cookie alone, and the handlers resolve it
 * the same way, so a leaked token cannot list or mint further tokens for its
 * user. The routes accept the cookie, so core's access chain has refused an
 * unsafe request from another origin before a handler runs. Every failure is
 * answered with core's problem document (`application/problem+json`:
 * `type`, `title`, `status`, `detail`, `code`).
 */

import type { RequestContext, Session } from 'jsails';
import { jsonError } from 'jsails/api';
import { isRecord } from 'jsails/plugin-sdk';

import {
  ApiTokenError,
  type ApiTokenService,
  type CreateApiTokenInput,
} from './api-token-service.js';
import { jsonResponse } from './routes.js';

/** The `/api/tokens` handlers, registered by the plugin when enabled. */
export interface ApiTokenHandlers {
  create(request: Request): Promise<Response>;
  list(request: Request): Promise<Response>;
  remove(request: Request, id: string): Promise<Response>;
}

/** What {@link createApiTokenHandlers} needs. */
export interface ApiTokenHandlerOptions {
  readonly service: ApiTokenService;
  /**
   * The cookie-only browser-session resolver: tokens are managed by a signed-in
   * browser, never by another token; the handlers drop an `Authorization`
   * header before calling it ({@link browserSession}).
   */
  readonly resolveSession: (request: Request) => Promise<Session | null>;
}

/** Create the `/api/tokens` route handlers. */
export function createApiTokenHandlers(options: ApiTokenHandlerOptions): ApiTokenHandlers {
  const { service } = options;
  const resolveSession = browserSession(options.resolveSession);

  return {
    async create(request) {
      const session = await resolveSession(request);
      if (session === null) {
        return unauthorizedResponse();
      }
      try {
        const input = await readCreateInput(request);
        const created = await service.createApiToken(contextFor(request, session), input);
        return jsonResponse(created, 201);
      } catch (error) {
        return toApiTokenErrorResponse(error);
      }
    },

    async list(request) {
      const session = await resolveSession(request);
      if (session === null) {
        return unauthorizedResponse();
      }
      try {
        return jsonResponse(await service.listApiTokens(contextFor(request, session)));
      } catch (error) {
        return toApiTokenErrorResponse(error);
      }
    },

    async remove(request, id) {
      const session = await resolveSession(request);
      if (session === null) {
        return unauthorizedResponse();
      }
      try {
        const revoked = await service.revokeApiToken(contextFor(request, session), id);
        return revoked
          ? jsonResponse({ revoked: true })
          : jsonError(404, 'not_found', 'token not found');
      } catch (error) {
        return toApiTokenErrorResponse(error);
      }
    },
  };
}

function unauthorizedResponse(): Response {
  return jsonError(401, 'unauthorized', 'authentication required');
}

/** A minimal request context carrying only what the service reads. */
function contextFor(request: Request, session: Session): RequestContext {
  return { request, url: new URL(request.url), params: {}, session };
}

/** Parse the JSON `{ name, expiresInDays? }` body, or throw `invalid_body`. */
async function readCreateInput(request: Request): Promise<CreateApiTokenInput> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ApiTokenError('invalid_body', 'request body must be valid JSON', 400);
  }
  if (!isRecord(parsed)) {
    throw new ApiTokenError('invalid_body', 'request body must be a JSON object', 400);
  }
  if (typeof parsed.name !== 'string') {
    throw new ApiTokenError('invalid_name', 'token name is required', 400);
  }
  const { expiresInDays } = parsed;
  if (expiresInDays === undefined) {
    return { name: parsed.name };
  }
  if (typeof expiresInDays !== 'number') {
    throw new ApiTokenError('invalid_expiry', 'expiresInDays must be a number of days', 400);
  }
  return { name: parsed.name, expiresInDays };
}

/** Map a thrown error to a value-free JSON response. */
function toApiTokenErrorResponse(error: unknown): Response {
  if (error instanceof ApiTokenError) {
    return jsonError(error.status, error.code, error.message);
  }
  return jsonError(500, 'internal_error', 'the token request could not be completed');
}

/**
 * `resolveSession` reading the cookie alone: an `Authorization` header is
 * removed first, since Better Auth's bearer plugin would otherwise honour
 * `Authorization: Bearer <token>`, letting an API token act as its user's
 * browser session (list and mint tokens, approve a device code).
 */
export function browserSession(
  resolveSession: (request: Request) => Promise<Session | null>,
): (request: Request) => Promise<Session | null> {
  return (request) => {
    if (!request.headers.has('authorization')) {
      return resolveSession(request);
    }
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    return resolveSession(new Request(request.url, { method: request.method, headers }));
  };
}
