/**
 * The surface registry: every thing the app answers a client through, each
 * described once by a frozen {@link SurfaceDescriptor}.
 *
 * A surface is a route (a filesystem API module or page, a registrar route or
 * mount, a server-component transport endpoint, a framework route) or the
 * app's asset index. Its descriptor states what the
 * access chain (`access-chain.ts`) decides from: who may reach it (`access`,
 * with no default), the action it is asked about, the credential kinds it
 * accepts (a surface accepting `cookie` gets the cross-site check on every
 * unsafe request), its request body, and who registered it.
 *
 * {@link createSurfaceRegistry} is assembly's: `add` freezes a descriptor and
 * refuses one without a valid access reference (`surface.missing_access`), an
 * id registered twice (`surface.duplicate_surface`) and a malformed one
 * (`surface.invalid_surface`), each failing assembly value-free.
 * {@link surfacesOf} reads an assembled app's registry: the list a reviewer,
 * the registration snapshot and the access matrix walk.
 */

import { isAccessRef, publicAccess, type AccessRef } from '../api/access-ref.js';
import type { ApiMethod } from '../contracts/http.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import type { BodySpec } from '../server/route-limits.js';
import type { RouteMeta } from '../server/route-meta.js';
import { isCredentialList, type CredentialKind } from './credentials.js';

export type { CredentialKind };

/**
 * What a surface is. A filesystem `api` module and `page`, a registrar
 * `route`, the asset index (`asset`), a server-component render, action,
 * `upload` and `download` endpoint, a `webhook`, an `ops` endpoint (probes,
 * introspection), an `admin` screen, a realtime `connection`, `channel` and
 * `publication`.
 *
 * @public
 */
export type SurfaceKind =
  | 'page'
  | 'api'
  | 'route'
  | 'asset'
  | 'component'
  | 'component-action'
  | 'upload'
  | 'download'
  | 'webhook'
  | 'ops'
  | 'admin'
  | 'connection'
  | 'channel'
  | 'publication';

/**
 * The requests a surface answers: its methods (a GET surface also answers
 * HEAD) and its registered pattern (`/posts/:id`, `/*`), never a concrete path.
 *
 * @public
 */
export interface SurfaceMatch {
  readonly methods: readonly ApiMethod[];
  readonly pattern: string;
}

/**
 * One surface, as the access chain decides it.
 *
 * @public
 */
export interface SurfaceDescriptor {
  /**
   * Unique in the app: `<METHODS> <pattern>` for a route, `asset:public` for
   * the asset index.
   */
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly match: SurfaceMatch;
  /** Who may reach the surface; there is no default. */
  readonly access: AccessRef;
  /** The action the gate is asked about: `read` for a surface of safe methods only, else `write`. */
  readonly action: string;
  /** The credential kinds the surface accepts; `[]` reads none. */
  readonly credentials: readonly CredentialKind[];
  /** The request body the surface reads and its cap; absent, the app-wide cap. */
  readonly body?: BodySpec;
  /** Who registered it: `app`, `framework`, or the plugin's name. */
  readonly owner: string;
}

/**
 * Every surface of an assembled app.
 *
 * @public
 */
export interface SurfaceRegistry {
  /** Every surface, in registration order. */
  entries(): readonly SurfaceDescriptor[];
  /** The surface registered under `id`, if any. */
  get(id: string): SurfaceDescriptor | undefined;
}

/** The registry assembly writes. */
export interface MutableSurfaceRegistry extends SurfaceRegistry {
  /** Register `descriptor`, returning its frozen copy. */
  add(descriptor: SurfaceDescriptor): SurfaceDescriptor;
}

const SURFACE_KINDS: ReadonlySet<string> = new Set<SurfaceKind>([
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
]);

const SURFACE_ERRORS = {
  missing_access: {
    kind: 'internal',
    message: 'surface {pattern} of {owner} states no access',
    context: { pattern: 'relative-path', owner: 'identifier' },
    suggestion:
      'give the route an access: publicAccess(reason), or a function returning exactly true for the requests it admits',
  },
  duplicate_surface: {
    kind: 'internal',
    message: 'surface {pattern} is registered twice (second by {owner})',
    context: { pattern: 'relative-path', owner: 'identifier' },
    suggestion: 'register each method and path once',
  },
  invalid_surface: {
    kind: 'internal',
    message: 'surface {pattern} of {owner} is malformed: {problem}',
    context: {
      pattern: 'relative-path',
      owner: 'identifier',
      problem: ['invalid_kind', 'invalid_methods', 'invalid_credentials', 'invalid_action'],
    },
    suggestion:
      "credentials are a list of distinct 'cookie' and 'token' entries; methods a non-empty list",
  },
} as const;

/**
 * The surface registration codes, `surface.*`: a surface without access, one
 * registered twice, and a malformed descriptor. Each fails assembly.
 *
 * @public
 */
export const SurfaceErrors: ErrorRegistry<'surface', typeof SURFACE_ERRORS> = defineErrors(
  'surface',
  SURFACE_ERRORS,
);

/** `pattern` as a `relative-path` slot: without its leading slash, `.` for the root. */
function patternSlot(pattern: string): string {
  const relative = pattern.replace(/^\/+/, '');
  return relative === '' ? '.' : relative;
}

/** `owner` as an `identifier` slot (a name that is not one renders as `unnamed`). */
function ownerSlot(owner: string): string {
  return /^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/.test(owner) ? owner : 'unnamed';
}

/** The action of a surface answering `methods`: `read` when every one is safe, else `write`. */
function actionOf(methods: readonly string[]): 'read' | 'write' {
  return methods.every((method) => method === 'GET' || method === 'HEAD' || method === 'OPTIONS')
    ? 'read'
    : 'write';
}

/** The id of a route surface: its methods, then its pattern. */
export function routeSurfaceId(methods: readonly string[], pattern: string): string {
  return `${methods.join(',')} ${pattern}`;
}

/** A registry enforcing the registration rules. */
export function createSurfaceRegistry(): MutableSurfaceRegistry {
  const byId = new Map<string, SurfaceDescriptor>();
  return {
    add(descriptor) {
      const pattern = patternSlot(descriptor.match.pattern);
      const owner = ownerSlot(descriptor.owner);
      const invalid = (
        problem: 'invalid_kind' | 'invalid_methods' | 'invalid_credentials' | 'invalid_action',
      ): Error => new SurfaceErrors.Error('invalid_surface', { pattern, owner, problem });
      if (!isAccessRef(descriptor.access)) {
        throw new SurfaceErrors.Error('missing_access', { pattern, owner });
      }
      if (!SURFACE_KINDS.has(descriptor.kind)) throw invalid('invalid_kind');
      const methods: unknown = descriptor.match.methods;
      if (!Array.isArray(methods) || methods.length === 0) throw invalid('invalid_methods');
      if (!isCredentialList(descriptor.credentials)) throw invalid('invalid_credentials');
      if (typeof descriptor.action !== 'string' || descriptor.action === '') {
        throw invalid('invalid_action');
      }
      if (byId.has(descriptor.id)) {
        throw new SurfaceErrors.Error('duplicate_surface', { pattern, owner });
      }
      const frozen: SurfaceDescriptor = Object.freeze({
        id: descriptor.id,
        kind: descriptor.kind,
        match: Object.freeze({
          methods: Object.freeze([...(methods as ApiMethod[])]),
          pattern: descriptor.match.pattern,
        }),
        access: descriptor.access,
        action: descriptor.action,
        credentials: Object.freeze([...descriptor.credentials]),
        ...(descriptor.body === undefined ? {} : { body: descriptor.body }),
        owner: descriptor.owner,
      });
      byId.set(frozen.id, frozen);
      return frozen;
    },
    entries() {
      return Object.freeze([...byId.values()]);
    },
    get(id) {
      return byId.get(id);
    },
  };
}

/** The registry of each app assembly built. */
const registries = new WeakMap<object, SurfaceRegistry>();

/** Record `registry` as `app`'s (assembly only). */
export function attachSurfaces(app: object, registry: MutableSurfaceRegistry): void {
  registries.set(
    app,
    Object.freeze({ entries: () => registry.entries(), get: (id: string) => registry.get(id) }),
  );
}

/**
 * The surface registry of an app `createApp` built, read-only; `undefined`
 * for any other object.
 *
 * @public
 */
export function surfacesOf(app: object): SurfaceRegistry | undefined {
  return registries.get(app);
}

/** The descriptor of the route `meta` describes. */
export function surfaceOfRoute(meta: RouteMeta): SurfaceDescriptor {
  return {
    id: routeSurfaceId(meta.methods, meta.pattern),
    kind: meta.surface,
    match: { methods: meta.methods, pattern: meta.pattern },
    access: meta.access,
    action: actionOf(meta.methods),
    credentials: meta.credentials,
    ...(meta.body === undefined ? {} : { body: meta.body }),
    owner: meta.owner,
  };
}

/** The id of the asset surface. */
export const PUBLIC_FILES_SURFACE_ID = 'asset:public';

/**
 * The descriptor of the app's asset index: a GET or HEAD of any path the
 * index serves, answered before the routes, open to anyone (a file is public
 * by being in an asset root), reading no credential. One descriptor covers
 * every file, because one access decides them all; `assetRowsOf` lists the
 * files themselves.
 */
export function publicFilesSurface(): SurfaceDescriptor {
  return {
    id: PUBLIC_FILES_SURFACE_ID,
    kind: 'asset',
    match: { methods: ['GET', 'HEAD'], pattern: '/*' },
    access: publicAccess('a file in an asset root of the app'),
    action: 'read',
    credentials: [],
    owner: 'framework',
  };
}
