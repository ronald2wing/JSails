/**
 * The access matrix's hard invariants: rules every app's surfaces hold, with
 * no snapshot to compare against.
 *
 * {@link checkAccessInvariants} judges the rows `accessMatrix` recorded (one
 * per surface, method, actor and origin variant) and the surface registry
 * itself, and returns every violation in a fixed order. Each rule is one
 * entry of {@link ACCESS_INVARIANTS}:
 *
 * - `own-chain-decides`: every request to a surface is decided by that
 *   surface's own access chain. A request another surface's chain decided
 *   (the probe's path reached an earlier route) tells nothing about its own
 *   surface, so the other rules leave it out and this one reports it; a
 *   request a stage before the chain answered is the surface's only when the
 *   surface is public and reads no credential (the chain would admit
 *   everyone the same way) or the host is one the app does not serve;
 * - `denied-before-handler`: a request the access chain denied reached no
 *   route code and had no body byte read;
 * - `public-only-admits-anonymous`: only a `publicAccess` surface admits a
 *   request with no identity;
 * - `cross-site-refused`: every unsafe request to a cookie-accepting surface
 *   that names a foreign origin, or none, is refused `403 access.cross_site`,
 *   for every actor whose identity there did not come from a header token. A
 *   credential the surface accepts and the authenticator refuses may be
 *   refused `401` instead, since `rejected-credential-401` demands exactly
 *   that answer for it;
 * - `connection-origin-and-host`: a connection surface admits no handshake
 *   from a foreign origin or for a host the app does not serve;
 * - `denied-no-store`: a denial is `no-store` and sets no cookie;
 * - `identified-never-public`: an answer to an identified caller is never
 *   `public` for a shared cache;
 * - `rejected-credential-401`: a credential the authenticator refuses is
 *   answered 401, never treated as anonymous;
 * - `tokenless-management`: no admin, component-action or auth-management
 *   surface accepts a token (auth management is the `auth` plugin's
 *   surfaces until they have a surface kind of their own);
 * - `credential-free-never-authenticates`: a surface accepting no credential
 *   never calls the authenticator;
 * - `anonymous-write-rate-limited`: every write an anonymous caller is
 *   admitted to has a rate-limit rule. A surface descriptor states no rule
 *   yet (the limiter brings the declaration), so every such write fails it;
 * - `locked-no-code-activation`: an app whose plugins are locked has no
 *   surface that activates plugin code. Each id the app declares
 *   code-activating must name a surface it registers, or the rule could not
 *   see the surface it is about.
 */

import type { SurfaceDescriptor } from '../security/surfaces.js';
import { AccessMatrixErrors, type CanonicalActor } from './canonical-actors.js';

/**
 * The origin a matrix request names: the app's own (`same`), another site's
 * (`foreign`), none at all (`missing`, neither `Origin` nor
 * `Sec-Fetch-Site`), or, for a connection surface, the app's origin on a
 * host it does not serve (`foreign-host`).
 *
 * @public
 */
export type ProbeOrigin = 'same' | 'foreign' | 'missing' | 'foreign-host';

/**
 * What became of one matrix request: the access chain `admitted` it (it
 * reached the place of the route's code), `denied` it, or another stage
 * `answered` it first (a host the app does not serve, the public files, a
 * request scope).
 *
 * @public
 */
export type ProbeOutcome = 'admitted' | 'denied' | 'answered';

/**
 * One request of the access matrix and what the app did with it.
 *
 * @public
 */
export interface AccessMatrixRow {
  /** The surface's id. */
  readonly surface: string;
  readonly kind: SurfaceDescriptor['kind'];
  readonly method: string;
  /** The actor's id. */
  readonly actor: string;
  readonly origin: ProbeOrigin;
  readonly outcome: ProbeOutcome;
  /**
   * The id of the surface whose access chain admitted or denied the request
   * (another surface's when the probe's path reached an earlier route), or
   * `null` when another stage answered it.
   */
  readonly decidedBy: string | null;
  readonly status: number;
  /** The failure code of a denial, or of a problem answer; `null` otherwise. */
  readonly code: string | null;
  /** Admitted with an identity (the surface accepted the actor's credential). */
  readonly identified: boolean;
  /** The request reached the place of the route's middleware and handler. */
  readonly handlerInvoked: boolean;
  /** Bytes of the request body any reader took. */
  readonly bodyBytesRead: number;
  /** The app's session resolver was called for the request. */
  readonly authenticatorInvoked: boolean;
  readonly cacheControl: string | null;
  readonly setCookie: boolean;
}

/**
 * An invariant's id.
 *
 * @public
 */
export type AccessInvariantId =
  | 'own-chain-decides'
  | 'denied-before-handler'
  | 'public-only-admits-anonymous'
  | 'cross-site-refused'
  | 'connection-origin-and-host'
  | 'denied-no-store'
  | 'identified-never-public'
  | 'rejected-credential-401'
  | 'tokenless-management'
  | 'credential-free-never-authenticates'
  | 'anonymous-write-rate-limited'
  | 'locked-no-code-activation';

/**
 * One hard invariant: its id and the rule it states.
 *
 * @public
 */
export interface AccessInvariant {
  readonly id: AccessInvariantId;
  readonly rule: string;
}

/**
 * One breach of an invariant: the surface, and the request when a row shows
 * it (`null` for a breach of the registry itself).
 *
 * @public
 */
export interface AccessViolation {
  readonly invariant: AccessInvariantId;
  readonly surface: string;
  readonly method: string | null;
  readonly actor: string | null;
  readonly origin: ProbeOrigin | null;
}

/**
 * Every hard invariant, in the order violations are reported.
 *
 * @public
 */
export const ACCESS_INVARIANTS: readonly AccessInvariant[] = Object.freeze(
  [
    {
      id: 'own-chain-decides',
      rule: "every request to a surface is decided by that surface's access chain, unless the surface is public and reads no credential or the host is not served",
    },
    {
      id: 'denied-before-handler',
      rule: 'a denied request reaches no route code and has no body byte read',
    },
    {
      id: 'public-only-admits-anonymous',
      rule: 'only a publicAccess surface admits a request with no identity',
    },
    {
      id: 'cross-site-refused',
      rule: 'an unsafe request to a cookie-accepting surface naming a foreign origin, or none, is refused 403 access.cross_site (401 for a refused credential the surface accepts) unless a header token authenticated it',
    },
    {
      id: 'connection-origin-and-host',
      rule: 'a connection surface admits no handshake from a foreign origin or for a host the app does not serve',
    },
    { id: 'denied-no-store', rule: 'a denial is no-store and sets no cookie' },
    {
      id: 'identified-never-public',
      rule: 'an answer to an identified caller is never public for a shared cache',
    },
    {
      id: 'rejected-credential-401',
      rule: 'a credential the authenticator refuses is answered 401, never as anonymous',
    },
    {
      id: 'tokenless-management',
      rule: 'no admin, component-action or auth-management surface accepts a token',
    },
    {
      id: 'credential-free-never-authenticates',
      rule: 'a surface accepting no credential never calls the authenticator',
    },
    {
      id: 'anonymous-write-rate-limited',
      rule: 'every write an anonymous caller is admitted to has a rate-limit rule',
    },
    {
      id: 'locked-no-code-activation',
      rule: 'an app whose plugins are locked has no surface that activates plugin code',
    },
  ].map((invariant) => Object.freeze(invariant as AccessInvariant)),
);

/** What {@link checkAccessInvariants} judges. */
export interface AccessInvariantInput {
  readonly surfaces: readonly SurfaceDescriptor[];
  readonly rows: readonly AccessMatrixRow[];
  readonly actors: readonly CanonicalActor[];
  /** The app's plugin activation mode. */
  readonly activation: 'locked' | 'managed';
  /** The ids of the surfaces that activate plugin code. */
  readonly codeActivating: readonly string[];
}

/** Methods that change nothing: the cross-site check does not apply to them. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The owners whose surfaces manage authentication, until such surfaces have a kind. */
const AUTH_MANAGEMENT_OWNERS: ReadonlySet<string> = new Set(['auth']);

/** Whether `method` changes state. */
export function isUnsafe(method: string): boolean {
  return !SAFE_METHODS.has(method);
}

/** Whether `actor`'s identity on `surface` comes from a header token the surface accepts. */
function tokenAuthenticated(actor: CanonicalActor, surface: SurfaceDescriptor): boolean {
  return (
    actor.carrier.includes('token') && !actor.rejected && surface.credentials.includes('token')
  );
}

/** Whether `surface` accepts the credential kind `actor` presents. */
function acceptsCarrier(actor: CanonicalActor, surface: SurfaceDescriptor): boolean {
  return (
    (actor.carrier.includes('cookie') && surface.credentials.includes('cookie')) ||
    (actor.carrier.includes('token') && surface.credentials.includes('token'))
  );
}

/** Whether `actor` presents a credential `surface` reads and the authenticator must refuse. */
function presentsRejected(actor: CanonicalActor, surface: SurfaceDescriptor): boolean {
  return actor.rejected && acceptsCarrier(actor, surface);
}

/**
 * Whether `row` was refused as a cross-site request must be: `403
 * access.cross_site`, or, for a refused credential the surface reads, the
 * `401` that `rejected-credential-401` demands.
 */
function refusedCrossSite(
  row: AccessMatrixRow,
  surface: SurfaceDescriptor,
  actor: CanonicalActor,
): boolean {
  if (row.outcome !== 'denied') return false;
  if (row.status === 403 && row.code === 'access.cross_site') return true;
  return row.status === 401 && presentsRejected(actor, surface);
}

/**
 * Whether a stage before the access chain may answer `row` for `surface`:
 * the host is one the app does not serve, or the surface is public and reads
 * no credential, so its chain would admit every caller the same way.
 */
function answerableBeforeChain(row: AccessMatrixRow, surface: SurfaceDescriptor): boolean {
  return (
    row.origin === 'foreign-host' ||
    (surface.access.kind === 'public' && surface.credentials.length === 0)
  );
}

/** Whether another surface's chain decided `row`, so it says nothing about its own. */
function misrouted(row: AccessMatrixRow): boolean {
  return row.decidedBy !== null && row.decidedBy !== row.surface;
}

/** Whether `surface` manages accounts, sessions or the app: it must accept no token. */
function managesAccess(surface: SurfaceDescriptor): boolean {
  return (
    surface.kind === 'admin' ||
    surface.kind === 'component-action' ||
    AUTH_MANAGEMENT_OWNERS.has(surface.owner)
  );
}

/**
 * Whether `surface` declares a rate-limit rule. A surface descriptor carries
 * no rule declaration yet (the limiter adds it), so no surface does.
 */
function declaresRateLimit(surface: SurfaceDescriptor): boolean {
  return Object.hasOwn(surface, 'rateLimit');
}

type RowCheck = (
  row: AccessMatrixRow,
  surface: SurfaceDescriptor,
  actor: CanonicalActor,
) => boolean;

/** The per-row rules: each returns true when the row breaks it. */
const ROW_BREACHES: ReadonlyMap<AccessInvariantId, RowCheck> = new Map<AccessInvariantId, RowCheck>(
  [
    [
      'own-chain-decides',
      (row, surface) =>
        misrouted(row) || (row.outcome === 'answered' && !answerableBeforeChain(row, surface)),
    ],
    [
      'denied-before-handler',
      (row) => row.outcome === 'denied' && (row.handlerInvoked || row.bodyBytesRead > 0),
    ],
    [
      'public-only-admits-anonymous',
      (row, surface) =>
        row.outcome === 'admitted' && !row.identified && surface.access.kind !== 'public',
    ],
    [
      'cross-site-refused',
      (row, surface, actor) =>
        isUnsafe(row.method) &&
        surface.credentials.includes('cookie') &&
        (row.origin === 'foreign' || row.origin === 'missing') &&
        !tokenAuthenticated(actor, surface) &&
        !refusedCrossSite(row, surface, actor),
    ],
    [
      'connection-origin-and-host',
      (row) =>
        row.kind === 'connection' &&
        (row.origin === 'foreign' || row.origin === 'foreign-host') &&
        row.outcome === 'admitted',
    ],
    [
      'denied-no-store',
      (row) =>
        row.outcome === 'denied' &&
        (row.setCookie || !/(?:^|,)\s*no-store\s*(?:,|$)/.test(row.cacheControl ?? '')),
    ],
    [
      'identified-never-public',
      (row) =>
        row.outcome === 'admitted' &&
        row.identified &&
        /(?:^|,)\s*public\s*(?:,|$)/.test(row.cacheControl ?? ''),
    ],
    [
      'rejected-credential-401',
      (row, surface, actor) => presentsRejected(actor, surface) && row.status !== 401,
    ],
    [
      'tokenless-management',
      (row, surface, actor) =>
        managesAccess(surface) && row.identified && tokenAuthenticated(actor, surface),
    ],
    [
      'credential-free-never-authenticates',
      (row, surface) => surface.credentials.length === 0 && row.authenticatorInvoked,
    ],
  ],
);

/**
 * Refuse a declared code-activating id that names no surface in `surfaces`:
 * `locked-no-code-activation` would pass over the surface it is about (a
 * renamed route) as if it were gone.
 *
 * @throws `access_matrix.unknown_surface`
 */
export function assertCodeActivating(
  surfaces: readonly SurfaceDescriptor[],
  codeActivating: readonly string[],
): void {
  const registered = new Set(surfaces.map((surface) => surface.id));
  if (codeActivating.some((id) => !registered.has(id))) {
    throw new AccessMatrixErrors.Error('unknown_surface');
  }
}

/**
 * Every violation of {@link ACCESS_INVARIANTS} in `input`, ordered by
 * invariant, then as the surfaces and rows are ordered. A row another
 * surface's chain decided breaks `own-chain-decides` and is judged by no
 * other rule, since its answer is not its surface's.
 *
 * @throws `access_matrix.unknown_surface` when a declared code-activating id
 *   names no surface.
 */
export function checkAccessInvariants(input: AccessInvariantInput): readonly AccessViolation[] {
  assertCodeActivating(input.surfaces, input.codeActivating);
  const surfaces = new Map(input.surfaces.map((surface) => [surface.id, surface]));
  const actors = new Map(input.actors.map((actor) => [actor.id, actor]));
  const violations: AccessViolation[] = [];
  for (const { id } of ACCESS_INVARIANTS) {
    const breach = ROW_BREACHES.get(id);
    if (breach !== undefined) {
      for (const row of input.rows) {
        const surface = surfaces.get(row.surface);
        const actor = actors.get(row.actor);
        const judged = id === 'own-chain-decides' || !misrouted(row);
        if (surface !== undefined && actor !== undefined && judged && breach(row, surface, actor)) {
          violations.push(rowViolation(id, row));
        }
      }
    }
    violations.push(...surfaceViolations(id, input));
  }
  return Object.freeze(violations);
}

/** The violation `row` shows of `invariant`. */
function rowViolation(invariant: AccessInvariantId, row: AccessMatrixRow): AccessViolation {
  return Object.freeze({
    invariant,
    surface: row.surface,
    method: row.method,
    actor: row.actor,
    origin: row.origin,
  });
}

/** The violation of `invariant` by `surface` as registered. */
function registryViolation(invariant: AccessInvariantId, surface: string): AccessViolation {
  return Object.freeze({ invariant, surface, method: null, actor: null, origin: null });
}

/** The breaches of the registry-level part of `invariant`. */
function surfaceViolations(
  invariant: AccessInvariantId,
  input: AccessInvariantInput,
): readonly AccessViolation[] {
  switch (invariant) {
    case 'tokenless-management':
      return input.surfaces
        .filter((surface) => managesAccess(surface) && surface.credentials.includes('token'))
        .map((surface) => registryViolation(invariant, surface.id));
    case 'anonymous-write-rate-limited': {
      const anonymousWrites = new Set(
        input.rows
          .filter(
            (row) =>
              row.outcome === 'admitted' &&
              !row.identified &&
              isUnsafe(row.method) &&
              !misrouted(row),
          )
          .map((row) => row.surface),
      );
      return input.surfaces
        .filter((surface) => anonymousWrites.has(surface.id) && !declaresRateLimit(surface))
        .map((surface) => registryViolation(invariant, surface.id));
    }
    case 'locked-no-code-activation': {
      if (input.activation !== 'locked') return [];
      const declared = new Set(input.codeActivating);
      return input.surfaces
        .filter((surface) => declared.has(surface.id))
        .map((surface) => registryViolation(invariant, surface.id));
    }
    default:
      return [];
  }
}
