/**
 * The canonical actors of the access matrix (`access-matrix.ts`): who the
 * matrix sends each surface's requests as.
 *
 * Each actor is a credential carrier (none, the session cookie, a bearer
 * token, or both) and the session a valid credential resolves to. The list
 * is fixed: anonymous; a user without a role; an unverified user; a user
 * signed in without a second factor; a user whose authorization version is
 * stale; a token with no scope, one with exactly the surface's scope, and
 * one issued for another tenant; a cookie sent together with a bearer token;
 * and a rejected cookie and a rejected token (a credential an authenticator
 * must refuse). An app adds its own {@link Persona}s, declared as data (an
 * administrator, an editor), after them.
 *
 * Sessions are today's `Session` records: the facts the coming actor model
 * names (email verification, authentication methods, second factor,
 * authorization version, token scopes and tenant) are carried in `data`, and
 * a header credential is marked the way every resolver marks it
 * (`data.authMethod` of `bearer` or `api-token`), so core's credential
 * narrowing and cross-site exemption judge them as in production. A rejected
 * credential resolves to no session, as every resolver answers one today.
 *
 * A matrix request carries its actor's credentials for real
 * ({@link carrierHeaders}), so whether a request carries a credential, which
 * kind the surface accepts, and the cross-site exemption of a header
 * credential are decided as in production; the session behind them comes
 * from the matrix (`accessMatrixSession` in `access-matrix.ts`).
 */

import type { Session } from '../contracts/http.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import type { JsonObject } from '../json/shape.js';
import type { SurfaceDescriptor } from '../security/surfaces.js';

/**
 * The credentials an actor's requests carry: none, the session cookie, a
 * bearer token, or both.
 *
 * @public
 */
export type ActorCarrier = 'none' | 'cookie' | 'token' | 'cookie+token';

/**
 * One actor the access matrix sends requests as.
 *
 * @public
 */
export interface CanonicalActor {
  /** Unique: `anonymous`, `user`, ..., or a persona's id. */
  readonly id: string;
  readonly carrier: ActorCarrier;
  /** The actor presents a credential an authenticator must refuse. */
  readonly rejected: boolean;
  /**
   * The session the actor's credential resolves to on `surface`: `null` for
   * anonymous and for a rejected credential. With both carriers, the header
   * credential's session (a header credential wins over the cookie).
   */
  session(surface: SurfaceDescriptor): Session | null;
}

/**
 * An app's own actor, declared as data: its id, the credential it signs in
 * with, and its session's `data` (roles and whatever the app's checks read).
 *
 * @public
 */
export interface Persona {
  /** Lowercase letters, digits and dashes, starting with a letter; at most 40 characters. */
  readonly id: string;
  readonly carrier: 'cookie' | 'token';
  readonly data: JsonObject;
}

const ACCESS_MATRIX_ERRORS = {
  invalid_persona: {
    kind: 'internal',
    message: 'an access-matrix persona is invalid: {problem}',
    context: { problem: ['invalid_id', 'duplicate_id', 'invalid_carrier', 'invalid_data'] },
    suggestion:
      "a persona has a unique lowercase id that names no canonical actor, a carrier of 'cookie' or 'token', and plain object data",
  },
  unsupported_target: {
    kind: 'internal',
    message: 'the access matrix needs an app createApp or createApplication built',
    suggestion: 'pass the app createApp returned, an Application, or a TestApplication',
  },
  missing_probe: {
    kind: 'internal',
    message: 'no probe builder for surfaces of kind {kind}',
    context: {
      kind: [
        'page',
        'api',
        'route',
        'asset',
        'component',
        'component-action',
        'upload',
        'download',
        'webhook',
        'ops',
        'admin',
        'connection',
        'channel',
        'publication',
      ],
    },
    suggestion: 'pass a probe builder for the kind in the probes option',
  },
  unknown_surface: {
    kind: 'internal',
    message: 'a code-activating surface id names no surface the app registers',
    suggestion:
      'name each surface in codeActivating by its id as the app registers it (a renamed route needs its new id)',
  },
} as const;

/**
 * The access matrix's own failures, `access_matrix.*`: an invalid persona, a
 * target it cannot read the surfaces of, a surface kind it has no probe
 * builder for, and a code-activating id that names no registered surface.
 *
 * @public
 */
export const AccessMatrixErrors: ErrorRegistry<'access_matrix', typeof ACCESS_MATRIX_ERRORS> =
  defineErrors('access_matrix', ACCESS_MATRIX_ERRORS);

/** The cookie a matrix request carries its session credential in. */
export const ACCESS_MATRIX_COOKIE = 'jsails_access_matrix';

/** Far in the future, so no session the matrix builds expires during a run. */
const EXPIRES_AT = Date.UTC(2100, 0, 1);

/** The session `id` of the actor `actorId`. */
function sessionId(actorId: string): string {
  return `access-matrix:${actorId}`;
}

/** A signed-in user's session data, `facts` overriding the defaults. */
function userData(actorId: string, facts: JsonObject): JsonObject {
  return {
    user: { id: `user-${actorId}`, email: `${actorId}@access-matrix.invalid`, emailVerified: true },
    amr: ['password', 'totp'],
    mfa: true,
    authzVersion: 'current',
    ...facts,
  };
}

/** An actor whose session does not depend on the surface. */
function fixed(
  id: string,
  carrier: ActorCarrier,
  data: JsonObject | null,
  rejected = false,
): CanonicalActor {
  const session: Session | null =
    data === null ? null : Object.freeze({ id: sessionId(id), data, expiresAt: EXPIRES_AT });
  return Object.freeze({ id, carrier, rejected, session: () => session });
}

/** The scope a token needs for `surface`: its owner, then its action. */
function scopeOf(surface: SurfaceDescriptor): string {
  return `${surface.owner}:${surface.action}`;
}

/** The canonical actors, in matrix order. */
const CANONICAL: readonly CanonicalActor[] = Object.freeze([
  fixed('anonymous', 'none', null),
  fixed('user', 'cookie', userData('user', {})),
  fixed(
    'unverified',
    'cookie',
    userData('unverified', {
      user: {
        id: 'user-unverified',
        email: 'unverified@access-matrix.invalid',
        emailVerified: false,
      },
    }),
  ),
  fixed('non-mfa', 'cookie', userData('non-mfa', { amr: ['password'], mfa: false })),
  fixed('stale-authz', 'cookie', userData('stale-authz', { authzVersion: 'stale' })),
  fixed(
    'token-no-scope',
    'token',
    userData('token-no-scope', { authMethod: 'api-token', scopes: [] }),
  ),
  Object.freeze({
    id: 'token-exact-scope',
    carrier: 'token',
    rejected: false,
    session: (surface: SurfaceDescriptor): Session =>
      Object.freeze({
        id: sessionId('token-exact-scope'),
        data: userData('token-exact-scope', {
          authMethod: 'api-token',
          scopes: [scopeOf(surface)],
        }),
        expiresAt: EXPIRES_AT,
      }),
  } satisfies CanonicalActor),
  fixed(
    'token-wrong-tenant',
    'token',
    userData('token-wrong-tenant', {
      authMethod: 'api-token',
      scopes: ['*'],
      tenantId: 'access-matrix-other-tenant',
    }),
  ),
  fixed(
    'cookie-and-bearer',
    'cookie+token',
    userData('cookie-and-bearer', { authMethod: 'bearer' }),
  ),
  fixed('rejected-cookie', 'cookie', null, true),
  fixed('rejected-token', 'token', null, true),
]);

const PERSONA_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** `persona` as an actor, or the problem that makes it invalid. */
function personaActor(persona: Persona): CanonicalActor | 'invalid_carrier' | 'invalid_data' {
  const carrier: unknown = persona.carrier;
  if (carrier !== 'cookie' && carrier !== 'token') return 'invalid_carrier';
  const data: unknown = persona.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'invalid_data';
  const resolved: JsonObject =
    carrier === 'token'
      ? { ...(data as JsonObject), authMethod: 'api-token' }
      : (data as JsonObject);
  return fixed(persona.id, carrier, structuredClone(resolved));
}

/**
 * The canonical actors, then `personas` in their order, each frozen.
 *
 * @throws `access_matrix.invalid_persona` for a persona whose id is not a
 *   lowercase name, repeats one or names a canonical actor, whose carrier is
 *   not `cookie` or `token`, or whose data is not a plain object.
 * @public
 */
export function canonicalActors(personas: readonly Persona[] = []): readonly CanonicalActor[] {
  const actors = [...CANONICAL];
  const ids = new Set(actors.map((actor) => actor.id));
  for (const persona of personas) {
    const id: unknown = persona.id;
    if (typeof id !== 'string' || !PERSONA_ID.test(id)) {
      throw new AccessMatrixErrors.Error('invalid_persona', { problem: 'invalid_id' });
    }
    if (ids.has(id))
      throw new AccessMatrixErrors.Error('invalid_persona', { problem: 'duplicate_id' });
    const actor = personaActor(persona);
    if (typeof actor === 'string') {
      throw new AccessMatrixErrors.Error('invalid_persona', { problem: actor });
    }
    ids.add(id);
    actors.push(actor);
  }
  return Object.freeze(actors);
}

/** The cookie and authorization headers of `actor`'s requests. */
export function carrierHeaders(actor: CanonicalActor): Readonly<Record<string, string>> {
  const value = actor.rejected ? 'rejected' : actor.id;
  const headers: Record<string, string> = {};
  if (actor.carrier === 'cookie' || actor.carrier === 'cookie+token') {
    headers.cookie = `${ACCESS_MATRIX_COOKIE}=${value}`;
  }
  if (actor.carrier === 'token' || actor.carrier === 'cookie+token') {
    headers.authorization = `Bearer access-matrix.${value}`;
  }
  return headers;
}
