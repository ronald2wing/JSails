/**
 * The trusted `/api/tokens` route handlers the `auth` plugin mounts when
 * `apiTokens.enabled` is set.
 *
 * Token management requires a signed-in *browser* session: the handlers
 * resolve the session from the cookie alone, so a leaked token cannot list or
 * mint further tokens for its user. Mutations additionally require the
 * same-origin boundary and the session-bound CSRF token, and every failure is
 * answered in core's `{ error: { status, code, message } }` envelope.
 */

import type { RequestContext, Session } from 'jsails';
import { jsonError } from 'jsails/api';
import {
  csrfTokenValid,
  forbiddenResponse,
  isRecord,
  isSameOriginRequest,
} from 'jsails/plugin-sdk';
import { CSRF_HEADER } from 'jsails/security';

import {
  ApiTokenError,
  type ApiTokenService,
  type CreateApiTokenInput,
} from './api-token-service.js';
import { jsonResponse } from './routes.js';

/** The trusted `/api/tokens` handlers, mounted by the plugin when enabled. */
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
   * browser, never by another token.
   */
  readonly resolveSession: (request: Request) => Promise<Session | null>;
  /** The same-origin boundary; `undefined` falls back to each request's own origin. */
  readonly publicOrigin?: string;
}

/** Create the `/api/tokens` route handlers. */
export function createApiTokenHandlers(options: ApiTokenHandlerOptions): ApiTokenHandlers {
  const { service, publicOrigin } = options;

  /**
   * Resolve the browser session from the cookie alone. The Better Auth bearer
   * plugin would otherwise honor `Authorization: Bearer <token>` here too,
   * letting an API token list and mint tokens for its user.
   */
  const resolveSession = (request: Request): Promise<Session | null> => {
    if (!request.headers.has('authorization')) {
      return options.resolveSession(request);
    }
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    return options.resolveSession(new Request(request.url, { method: request.method, headers }));
  };

  /**
   * Resolve the signed-in browser session for a mutating request, enforcing the
   * same-origin boundary before touching the session store and the CSRF token
   * after. Returns the session, or the response to send when the request is
   * not an authorized browser mutation.
   */
  async function authorizeMutation(
    request: Request,
  ): Promise<{ session: Session } | { response: Response }> {
    if (!isSameOriginRequest(request, publicOrigin)) {
      return { response: forbiddenResponse() };
    }
    const session = await resolveSession(request);
    if (session === null) {
      return { response: unauthorizedResponse() };
    }
    if (!csrfTokenValid(session, request.headers.get(CSRF_HEADER))) {
      return { response: jsonError(403, 'csrf_mismatch', 'CSRF token missing or mismatch') };
    }
    return { session };
  }

  return {
    async create(request) {
      const authorized = await authorizeMutation(request);
      if ('response' in authorized) {
        return authorized.response;
      }
      const { session } = authorized;
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
      const authorized = await authorizeMutation(request);
      if ('response' in authorized) {
        return authorized.response;
      }
      const { session } = authorized;
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
