/**
 * Shared fixtures for the auth tests: Better Auth stubs (an `api`-only fake and
 * one whose internal adapter is an in-memory session table), an in-memory
 * `ApiTokenStore`, the deterministic CSRF derivation, and request/session
 * builders. Nothing here opens a database, a browser, or a listener.
 */

import { createHmac } from 'node:crypto';

import type { JsonObject, RequestContext, Session } from 'jsails';

import type { ApiTokenStore, ResolvedApiToken } from '../src/api-token-store.js';
import type { Auth } from '../src/better-auth.js';

/** The origin every same-origin test request presents. */
export const ORIGIN = 'http://localhost';
/** The signing secret the token tests key their CSRF derivation with. */
export const SECRET = 'secret-key';
/** The test user's id. */
export const USER_ID = 'u1';

/** A Better Auth stub exposing only the given `api` endpoints. */
export function fakeAuth(api: Record<string, unknown>, rest: Record<string, unknown> = {}): Auth {
  return { api, ...rest } as unknown as Auth;
}

/** Build a form-encoded POST request against the given origin. */
export function formRequest(
  path: string,
  fields: Record<string, string>,
  origin = ORIGIN,
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A session with the given `data` payload. */
export function sessionWith(data: JsonObject): Session {
  return { id: 's1', csrfToken: 'csrf', data, expiresAt: 2_000_000_000_000 };
}

/** The deterministic CSRF token `resolveSessionFromRequest` derives with {@link SECRET}. */
export function deriveCsrf(sessionId: string): string {
  return createHmac('sha256', SECRET)
    .update(`jsails.session.csrf:${sessionId}`)
    .digest('base64url');
}

/** A session as `resolveSessionFromRequest` would produce for the test user. */
export function cookieSession(): Session {
  return {
    id: 'session-1',
    csrfToken: deriveCsrf('session-1'),
    data: { user: { id: USER_ID, name: 'Ada', email: 'ada@example.com' } },
    expiresAt: 2_000_000_000_000,
  };
}

/** A minimal request context carrying the test session. */
export function requestContext(
  session: Session | null,
  services?: RequestContext['services'],
): RequestContext {
  return {
    request: new Request(`${ORIGIN}/`),
    url: new URL(`${ORIGIN}/`),
    params: {},
    session,
    services,
  };
}

/** A session row as the fake internal adapter stores it. */
export interface SessionRow {
  id: string;
  token: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  userAgent: string;
  ipAddress: string;
}

/**
 * A Better Auth stub whose `$context.internalAdapter` is an in-memory session
 * table, so the Better Auth token store runs against a real (fake) adapter.
 */
export function fakeAuthWithSessions(
  users: Map<string, { id: string; name: string; email: string }> = new Map(),
) {
  users.set(USER_ID, { id: USER_ID, name: 'Ada', email: 'ada@example.com' });

  const sessions = new Map<string, SessionRow>();
  let counter = 0;

  const adapter = {
    async createSession(
      userId: string,
      _dontRememberMe: boolean | undefined,
      override: { expiresAt?: Date; userAgent?: string } | undefined,
    ): Promise<SessionRow> {
      counter += 1;
      const now = new Date();
      const row: SessionRow = {
        id: `session-${counter}`,
        token: `token-${counter}`,
        userId,
        createdAt: now,
        updatedAt: now,
        expiresAt: override?.expiresAt ?? new Date(Date.now() + 86_400_000),
        userAgent: override?.userAgent ?? '',
        ipAddress: '',
      };
      sessions.set(row.token, row);
      return row;
    },

    async listSessions(
      userId: string,
      options?: { onlyActiveSessions?: boolean },
    ): Promise<SessionRow[]> {
      const now = Date.now();
      return [...sessions.values()]
        .filter((s) => s.userId === userId)
        .filter((s) => !options?.onlyActiveSessions || s.expiresAt.getTime() > now);
    },

    async findSession(token: string) {
      const row = sessions.get(token);
      if (row === undefined) return null;
      const user = users.get(row.userId);
      if (user === undefined) return null;
      return { session: { ...row }, user: { ...user } };
    },

    async deleteSession(token: string): Promise<void> {
      sessions.delete(token);
    },
  };

  const auth = { $context: Promise.resolve({ internalAdapter: adapter }) } as unknown as Auth;

  return { auth, sessions, adapter };
}

/** An in-memory `ApiTokenStore` for service and handler tests. */
export function createInMemoryTokenStore(): ApiTokenStore & {
  rows: Map<string, { token: string; userId: string }>;
} {
  const rows = new Map<
    string,
    {
      id: string;
      name: string;
      createdAt: number;
      expiresAt: number;
      token: string;
      userId: string;
    }
  >();
  let counter = 0;

  return {
    rows,
    async create(userId, name, expiresAt) {
      counter += 1;
      const id = `tok-${counter}`;
      const token = `secret-${counter}`;
      const createdAt = Date.now();
      rows.set(id, { id, name, createdAt, expiresAt: expiresAt.getTime(), token, userId });
      return { id, name, createdAt, expiresAt: expiresAt.getTime(), token };
    },
    async list(userId) {
      const now = Date.now();
      return [...rows.values()]
        .filter((r) => r.userId === userId && r.expiresAt > now)
        .map(({ id, name, createdAt, expiresAt }) => ({ id, name, createdAt, expiresAt }));
    },
    async revoke(userId, id) {
      const row = rows.get(id);
      if (row === undefined || row.userId !== userId) return false;
      rows.delete(id);
      return true;
    },
    async resolve(token): Promise<ResolvedApiToken | null> {
      for (const row of rows.values()) {
        if (row.token === token && row.expiresAt > Date.now()) {
          return {
            sessionId: row.id,
            userId: row.userId,
            name: 'Ada',
            email: 'ada@example.com',
            expiresAt: row.expiresAt,
          };
        }
      }
      return null;
    },
  };
}
