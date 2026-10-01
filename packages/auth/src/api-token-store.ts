/**
 * The API-token persistence seam and its Better Auth implementation.
 *
 * An API token is a long-lived Better Auth session tagged with a sentinel
 * `userAgent` prefix (`jsails/api-token:<name>`), so the token store rides on
 * the existing session table with no new schema: creation mints a session via
 * `internalAdapter.createSession` (returning the raw session token exactly
 * once), resolution reads it back through `internalAdapter.findSession`, and
 * revocation deletes it via `internalAdapter.deleteSession`. Tokens are
 * therefore durable and shared across processes like every session, and are
 * cleanly separable from browser sessions by the sentinel.
 *
 * {@link ApiTokenStore} is the seam; {@link createBetterAuthApiTokenStore} is
 * the built-in implementation. A test or custom backend may supply its own
 * through the plugin's `apiTokens.store` option.
 */

import type { Auth } from './better-auth.js';

/** Sentinel `userAgent` prefix tagging a session as an API token. */
const API_TOKEN_MARKER = 'jsails/api-token:';

/** A persisted API token as exposed to its owner (never the secret). */
export interface ApiToken {
  /** Stable identifier (the Better Auth session id). */
  readonly id: string;
  /** Display name, trimmed. */
  readonly name: string;
  /** Creation time as a Unix epoch timestamp in milliseconds. */
  readonly createdAt: number;
  /** Expiry as a Unix epoch timestamp in milliseconds. */
  readonly expiresAt: number;
}

/** The result of minting a token: the descriptor plus the one-time secret. */
export interface CreatedApiToken extends ApiToken {
  /** The raw credential. Returned exactly once, here; never persisted elsewhere. */
  readonly token: string;
}

/** A resolved token credential, ready to be mapped to a `Session`. */
export interface ResolvedApiToken {
  /** The Better Auth session id backing the token. */
  readonly sessionId: string;
  /** The owning user id. */
  readonly userId: string;
  /** The user's display name. */
  readonly name: string;
  /** The user's primary email. */
  readonly email: string;
  /** Expiry as a Unix epoch timestamp in milliseconds. */
  readonly expiresAt: number;
}

/**
 * Persistence seam for API tokens. The built-in implementation stores tokens
 * as tagged Better Auth sessions; a test or custom backend may supply its own.
 */
export interface ApiTokenStore {
  create(userId: string, name: string, expiresAt: Date): Promise<CreatedApiToken>;
  list(userId: string): Promise<ApiToken[]>;
  revoke(userId: string, tokenId: string): Promise<boolean>;
  resolve(token: string): Promise<ResolvedApiToken | null>;
}

/** A session row as the internal adapter returns it. */
interface AdapterSession {
  id: string;
  token: string;
  createdAt: string | number;
  expiresAt: string | number;
  userAgent?: string | null;
}

/** The slice of Better Auth's internal adapter the store depends on. */
interface BetterAuthInternalAdapter {
  createSession(
    userId: string,
    dontRememberMe: boolean | undefined,
    override: { userAgent: string; expiresAt: Date } | undefined,
    overrideAll: boolean,
  ): Promise<AdapterSession>;
  listSessions(
    userId: string,
    options?: { onlyActiveSessions?: boolean },
  ): Promise<AdapterSession[]>;
  findSession(token: string): Promise<{
    session: { id: string; expiresAt: string | number; userAgent?: string | null };
    user: { id: string; name: string; email: string };
  } | null>;
  deleteSession(token: string): Promise<void>;
}

/**
 * Create the database-backed store over a Better Auth instance. The internal
 * adapter is resolved lazily (once), so constructing the store opens no
 * connection.
 */
export function createBetterAuthApiTokenStore(auth: Auth): ApiTokenStore {
  const adapter: Promise<BetterAuthInternalAdapter> = auth.$context.then(
    (context) => context.internalAdapter as unknown as BetterAuthInternalAdapter,
  );

  return {
    async create(userId, name, expiresAt) {
      const session = await (
        await adapter
      ).createSession(
        userId,
        undefined,
        { userAgent: apiTokenUserAgent(name), expiresAt },
        // `overrideAll` lets the caller-supplied `expiresAt`/`userAgent` win
        // over Better Auth's computed defaults (which are derived from the
        // session-expiration config and the current request's headers).
        true,
      );
      return {
        id: session.id,
        name,
        createdAt: new Date(session.createdAt).getTime(),
        expiresAt: new Date(session.expiresAt).getTime(),
        token: session.token,
      };
    },

    async list(userId) {
      const sessions = await (await adapter).listSessions(userId, { onlyActiveSessions: true });
      const tokens: ApiToken[] = [];
      for (const session of sessions) {
        const name = apiTokenName(session);
        if (name === null) continue;
        tokens.push({
          id: session.id,
          name,
          createdAt: new Date(session.createdAt).getTime(),
          expiresAt: new Date(session.expiresAt).getTime(),
        });
      }
      return tokens;
    },

    async revoke(userId, tokenId) {
      const sessions = await (await adapter).listSessions(userId);
      const match = sessions.find(
        (session) => session.id === tokenId && apiTokenName(session) !== null,
      );
      if (match === undefined) return false;
      await (await adapter).deleteSession(match.token);
      return true;
    },

    async resolve(token) {
      const found = await (await adapter).findSession(token);
      if (found === null) return null;
      const { session, user } = found;
      if (apiTokenName(session) === null) return null;
      const expiresAt = new Date(session.expiresAt).getTime();
      if (expiresAt <= Date.now()) return null;
      return {
        sessionId: session.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        expiresAt,
      };
    },
  };
}

/** The sentinel-tagged `userAgent` value a token session is minted with. */
function apiTokenUserAgent(name: string): string {
  return `${API_TOKEN_MARKER}${name}`;
}

/** The display name of a token session, or `null` when it is not a token session. */
function apiTokenName(session: { userAgent?: string | null }): string | null {
  const { userAgent } = session;
  if (typeof userAgent !== 'string' || !userAgent.startsWith(API_TOKEN_MARKER)) {
    return null;
  }
  return userAgent.slice(API_TOKEN_MARKER.length);
}
