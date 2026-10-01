/**
 * The access matrix: every surface of an app, asked by every canonical actor,
 * through the real request pipeline, with a probe in place of the route's
 * code.
 *
 * {@link accessMatrix} reads the app's surface registry and, for each
 * surface, each of its methods and each actor (`canonical-actors.ts`), sends
 * one synthesised request through the app's own `fetch`: same-origin, and
 * for an unsafe method also from a foreign origin and with no origin at all.
 * The request carries the actor's real credentials and, for an unsafe
 * method, a small body of the kind the surface declares, counted at its
 * source. A probe rides along (`security/access-record.ts`): the access
 * chain tells it each denial and whose chain denied, and the route boundary
 * answers with it where the route's middleware and handler would run, so no
 * route code runs and the matrix sees how far the request got and which
 * surface decided it. Each request becomes one {@link AccessMatrixRow}; the
 * rows are judged by the hard invariants (`access-invariants.ts`).
 *
 * The app is assembled with {@link accessMatrixSession} as its session
 * resolver (the app's own, and every plugin seam that resolves a session),
 * so the session behind each credential is the actor's and every resolver
 * call is counted.
 *
 * A probe builder per surface kind ({@link ProbeBuilder}) turns a surface,
 * method and actor into the request's path, headers and body: parameters
 * become `x`, an upload gets a multipart body. A builder may give several
 * candidate requests: when another surface's chain decides one (an earlier
 * route also matches its path, as `/docs/:slug` matches the `/docs/x` of
 * `/docs/*`), the matrix sends the next, and records the last it sent, so a
 * surface no candidate reaches shows in its rows (`decidedBy`) instead of
 * passing on another surface's answers. A wildcard pattern's candidates are
 * its one-segment and its two-segment path. Every kind an app can serve
 * today has a builder; the realtime kinds (`connection`, `channel`,
 * `publication`) bring theirs with their surfaces, and a surface of a kind
 * without one fails the matrix.
 *
 * Requests run one at a time, in registration order, then method, actor and
 * origin; a row holds no id, time or port, so two runs over the same app
 * serialise byte for byte the same.
 */

import { applicationPipeline } from '../app/application.js';
import type { Application } from '../app/application.js';
import type { Session } from '../contracts/http.js';
import {
  accessProbeOf,
  attachAccessProbe,
  type AccessProbe,
  type Admitted,
} from '../security/access-record.js';
import {
  surfacesOf,
  type SurfaceDescriptor,
  type SurfaceKind,
  type SurfaceRegistry,
} from '../security/surfaces.js';
import {
  assertCodeActivating,
  checkAccessInvariants,
  isUnsafe,
  type AccessMatrixRow,
  type AccessViolation,
  type ProbeOrigin,
  type ProbeOutcome,
} from './access-invariants.js';
import {
  AccessMatrixErrors,
  canonicalActors,
  carrierHeaders,
  type CanonicalActor,
  type Persona,
} from './canonical-actors.js';

/**
 * What a probe builder is asked for: one request to `surface` with
 * `method`, as `actor`, naming `origin`, to the app at `appOrigin`.
 *
 * @public
 */
export interface ProbeContext {
  readonly surface: SurfaceDescriptor;
  readonly method: string;
  readonly actor: CanonicalActor;
  readonly origin: ProbeOrigin;
  readonly appOrigin: string;
}

/**
 * The request a probe builder synthesises: a path on the app's origin, the
 * headers the surface kind needs beyond the matrix's own, and the body of an
 * unsafe method.
 *
 * @public
 */
export interface ProbeRequest {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

/**
 * Builds the request of one probe for surfaces of one kind, or several
 * candidates in order: the matrix sends the next while another surface's
 * access chain decides the one it sent.
 *
 * @public
 */
export type ProbeBuilder = (context: ProbeContext) => ProbeRequest | readonly ProbeRequest[];

/**
 * Options of {@link accessMatrix}.
 *
 * @public
 */
export interface AccessMatrixOptions {
  /** The app's own actors, sent after the canonical ones. */
  readonly personas?: readonly Persona[];
  /** The app's plugin activation mode; absent, `locked`. */
  readonly activation?: 'locked' | 'managed';
  /**
   * The ids of the app's surfaces that activate plugin code; each must name
   * a surface the app registers.
   */
  readonly codeActivating?: readonly string[];
  /** Probe builders by surface kind, over the built-in ones. */
  readonly probes?: Readonly<Partial<Record<SurfaceKind, ProbeBuilder>>>;
  /**
   * The origin the app serves; absent, a `TestApplication`'s origin, else
   * `http://localhost`.
   */
  readonly origin?: string;
}

/**
 * The matrix of one app: its surfaces, every request's row, and every
 * violation of the hard invariants.
 *
 * @public
 */
export interface AccessMatrixResult {
  readonly surfaces: readonly SurfaceDescriptor[];
  readonly rows: readonly AccessMatrixRow[];
  readonly violations: readonly AccessViolation[];
}

/**
 * What the matrix can run against: the app `createApp` returned, an
 * `Application`, or a `TestApplication`.
 *
 * @public
 */
export type AccessMatrixTarget =
  | { fetch(request: Request, env?: unknown): Response | Promise<Response> }
  | { readonly application: Application; readonly origin: string };

/** An origin no app serves. */
const FOREIGN_ORIGIN = 'https://attacker.invalid';

/** A host no app serves. */
const FOREIGN_HOST = 'unlisted-host.invalid';

/** The adapter environment of a request from a loopback socket peer. */
const LOOPBACK = Object.freeze({ incoming: { socket: { remoteAddress: '127.0.0.1' } } });

/** The answer a probe gives in the place of a route's code. */
const PROBE_BODY = 'access-matrix probe';

/** What one probe saw. */
interface ProbeState {
  readonly surface: SurfaceDescriptor;
  readonly actor: CanonicalActor;
  /** The surface whose chain denied the request, and the denial's code. */
  denied: { readonly by: SurfaceDescriptor; readonly code: string | null } | undefined;
  admitted: Admitted | undefined;
  authenticated: boolean;
}

/** The state behind each probe this module attached. */
const states = new WeakMap<AccessProbe, ProbeState>();

/**
 * The session of the access-matrix request `request` is, or bound to: its
 * actor's session on its surface (`null` for anonymous and a rejected
 * credential). Every call counts as the app's authenticator running for the
 * request. Any other request has no session here.
 *
 * Assemble the app under the matrix with it as every session resolver: the
 * app's `resolveSession`, and each plugin seam that resolves a session
 * itself (the `auth` plugin's `sessionResolver`, an admin panel's
 * `resolveSession`).
 *
 * @public
 */
export function accessMatrixSession(request: Request): Promise<Session | null> {
  const probe = accessProbeOf(request);
  const state = probe === undefined ? undefined : states.get(probe);
  if (state === undefined) return Promise.resolve(null);
  state.authenticated = true;
  return Promise.resolve(state.actor.session(state.surface));
}

/** The probe of one request, recording into `state`. */
function createProbe(state: ProbeState): AccessProbe {
  const probe: AccessProbe = {
    denied(surface, code) {
      state.denied = { by: surface, code: code ?? null };
    },
    reached(admitted) {
      state.admitted = admitted;
      return new Response(PROBE_BODY, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    },
  };
  states.set(probe, state);
  return probe;
}

/**
 * A concrete path `pattern` matches: each parameter segment becomes `x`, each
 * wildcard segment `depth` segments of `x`.
 */
function concretePath(pattern: string, depth: number): string {
  return pattern
    .split('/')
    .map((segment) => {
      if (segment.includes('*')) return Array.from({ length: depth }, () => 'x').join('/');
      return segment.startsWith(':') ? 'x' : segment;
    })
    .join('/');
}

/**
 * The candidate paths of `pattern`: its one-segment form, then, for a
 * wildcard, its two-segment form, which an earlier one-segment parameter
 * route does not match.
 */
function candidatePaths(pattern: string): readonly string[] {
  const shallow = concretePath(pattern, 1);
  const deep = concretePath(pattern, 2);
  return deep === shallow ? [shallow] : [shallow, deep];
}

const encoder = new TextEncoder();

/** A body of the kind `surface` declares, for an unsafe method. */
function declaredBody(surface: SurfaceDescriptor): {
  readonly type: string;
  readonly bytes: Uint8Array;
} {
  switch (surface.body?.kind) {
    case 'json':
      return { type: 'application/json', bytes: encoder.encode('{"probe":true}') };
    case 'raw':
      return { type: 'application/octet-stream', bytes: encoder.encode('access-matrix probe') };
    default:
      return {
        type: 'application/x-www-form-urlencoded',
        bytes: encoder.encode('probe=access-matrix'),
      };
  }
}

/** The multipart body of an upload probe. */
function multipartBody(): { readonly type: string; readonly bytes: Uint8Array } {
  const boundary = 'access-matrix-boundary';
  return {
    type: `multipart/form-data; boundary=${boundary}`,
    bytes: encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="probe.txt"\r\nContent-Type: text/plain\r\n\r\naccess-matrix probe\r\n--${boundary}--\r\n`,
    ),
  };
}

/** A route surface's requests: its pattern made concrete, a declared body for a write. */
const routeProbe: ProbeBuilder = ({ surface, method }) =>
  candidatePaths(surface.match.pattern).map((path) => {
    if (!isUnsafe(method)) return { path };
    const body = declaredBody(surface);
    return { path, headers: { 'content-type': body.type }, body: body.bytes };
  });

/** An upload's requests: a multipart body. */
const uploadProbe: ProbeBuilder = ({ surface, method }) =>
  candidatePaths(surface.match.pattern).map((path) => {
    if (!isUnsafe(method)) return { path };
    const body = multipartBody();
    return { path, headers: { 'content-type': body.type }, body: body.bytes };
  });

/** The public files' request: a path no route answers. */
const assetProbe: ProbeBuilder = () => ({ path: '/access-matrix/missing-file.txt' });

/** The built-in probe builder of every kind an app serves today. */
const BUILT_IN_PROBES: Readonly<Partial<Record<SurfaceKind, ProbeBuilder>>> = Object.freeze({
  page: routeProbe,
  api: routeProbe,
  route: routeProbe,
  asset: assetProbe,
  component: routeProbe,
  'component-action': routeProbe,
  upload: uploadProbe,
  download: routeProbe,
  webhook: routeProbe,
  ops: routeProbe,
  admin: routeProbe,
});

/** The origin variants a request to `surface` with `method` is sent with. */
function originsFor(surface: SurfaceDescriptor, method: string): readonly ProbeOrigin[] {
  if (surface.kind === 'connection') return ['same', 'foreign', 'foreign-host'];
  return isUnsafe(method) ? ['same', 'foreign', 'missing'] : ['same'];
}

/** The methods a surface is probed with: its own, HEAD left to its GET. */
function methodsOf(surface: SurfaceDescriptor): readonly string[] {
  const methods = surface.match.methods.filter((method) => method !== 'HEAD');
  return methods.length === 0 ? surface.match.methods : methods;
}

/** A body stream that counts the bytes any reader takes from it. */
function countedBody(bytes: Uint8Array, count: { bytes: number }): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        count.bytes += bytes.byteLength;
        controller.enqueue(bytes);
      },
    },
    // No read ahead: a byte counts only once a reader asks for it.
    { highWaterMark: 0 },
  );
}

/** The request of one probe, and the counter of its body. */
function probeRequest(
  context: ProbeContext,
  built: ProbeRequest,
): { readonly request: Request; readonly count: { bytes: number } } {
  const { actor, origin, appOrigin, method } = context;
  const base =
    origin === 'foreign-host'
      ? (() => {
          const url = new URL(appOrigin);
          url.hostname = FOREIGN_HOST;
          return url.origin;
        })()
      : appOrigin;
  const headers = new Headers({ accept: 'application/json', ...built.headers });
  for (const [name, value] of Object.entries(carrierHeaders(actor))) headers.set(name, value);
  const unsafe = isUnsafe(method);
  if (origin === 'foreign') {
    headers.set('origin', FOREIGN_ORIGIN);
    headers.set('sec-fetch-site', 'cross-site');
  } else if ((origin === 'same' && unsafe) || origin === 'foreign-host') {
    headers.set('origin', appOrigin);
  }
  const count = { bytes: 0 };
  const body = built.body;
  if (body === undefined || !unsafe) {
    return { request: new Request(new URL(built.path, base), { method, headers }), count };
  }
  headers.set('content-length', String(body.byteLength));
  const request = new Request(new URL(built.path, base), {
    method,
    headers,
    body: countedBody(body, count),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { request, count };
}

/** The code of a problem answer, or `null`. */
async function problemCode(response: Response): Promise<string | null> {
  const text = await response.text();
  if (!/json/.test(response.headers.get('content-type') ?? '')) return null;
  try {
    const document: unknown = JSON.parse(text);
    if (document === null || typeof document !== 'object') return null;
    const code: unknown = (document as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  } catch {
    // A body that is not JSON carries no code.
    return null;
  }
}

/** The fetch, origin and surfaces of `target`. */
async function resolveTarget(
  target: AccessMatrixTarget,
  options: AccessMatrixOptions,
): Promise<{
  readonly fetch: (request: Request) => Promise<Response>;
  readonly origin: string;
  readonly surfaces: SurfaceRegistry;
}> {
  if ('application' in target) {
    const pipeline = applicationPipeline(target.application);
    const surfaces = pipeline === undefined ? undefined : surfacesOf(await pipeline);
    if (surfaces === undefined) throw new AccessMatrixErrors.Error('unsupported_target');
    const application = target.application;
    return {
      fetch: (request) => application.fetch(request),
      origin: options.origin ?? target.origin,
      surfaces,
    };
  }
  const surfaces = surfacesOf(target);
  if (surfaces === undefined) throw new AccessMatrixErrors.Error('unsupported_target');
  return {
    fetch: async (request) => await target.fetch(request, LOOPBACK),
    origin: options.origin ?? 'http://localhost',
    surfaces,
  };
}

/**
 * Send every surface of `target` every canonical actor's requests (then the
 * `personas`'), judge the rows by the hard invariants, and return the matrix.
 *
 * @throws `access_matrix.unsupported_target` for a target that is not an app
 *   `createApp` or `createApplication` built; `access_matrix.missing_probe`
 *   for a surface of a kind without a probe builder, or whose builder gave no
 *   request;
 *   `access_matrix.invalid_persona` for an invalid persona;
 *   `access_matrix.unknown_surface` for a `codeActivating` id that names no
 *   surface of the app.
 * @public
 */
export async function accessMatrix(
  target: AccessMatrixTarget,
  options: AccessMatrixOptions = {},
): Promise<AccessMatrixResult> {
  const actors = canonicalActors(options.personas);
  const builders = { ...BUILT_IN_PROBES, ...options.probes };
  const { fetch, origin: appOrigin, surfaces: registry } = await resolveTarget(target, options);
  const surfaces = registry.entries();
  for (const surface of surfaces) {
    if (builders[surface.kind] === undefined) {
      throw new AccessMatrixErrors.Error('missing_probe', { kind: surface.kind });
    }
  }
  const codeActivating = options.codeActivating ?? [];
  assertCodeActivating(surfaces, codeActivating);
  const rows: AccessMatrixRow[] = [];
  for (const surface of surfaces) {
    const build = builders[surface.kind] as ProbeBuilder;
    for (const method of methodsOf(surface)) {
      for (const actor of actors) {
        for (const origin of originsFor(surface, method)) {
          const context: ProbeContext = { surface, method, actor, origin, appOrigin };
          rows.push(await probe(fetch, context, build(context)));
        }
      }
    }
  }
  const violations = checkAccessInvariants({
    surfaces,
    rows,
    actors,
    activation: options.activation ?? 'locked',
    codeActivating,
  });
  return Object.freeze({ surfaces, rows: Object.freeze(rows), violations });
}

/**
 * Send one probe, the next of `built`'s candidates while another surface's
 * chain decides the one sent, and record the row of the last.
 */
async function probe(
  fetch: (request: Request) => Promise<Response>,
  context: ProbeContext,
  built: ProbeRequest | readonly ProbeRequest[],
): Promise<AccessMatrixRow> {
  const candidates: readonly ProbeRequest[] = isCandidateList(built) ? built : [built];
  let row: AccessMatrixRow | undefined;
  for (const candidate of candidates) {
    row = await probeOnce(fetch, context, candidate);
    if (row.decidedBy === null || row.decidedBy === row.surface) return row;
  }
  // A builder that gave no candidate built no probe for the surface.
  if (row === undefined) {
    throw new AccessMatrixErrors.Error('missing_probe', { kind: context.surface.kind });
  }
  return row;
}

/** Whether a builder gave candidates rather than one request. */
function isCandidateList(
  built: ProbeRequest | readonly ProbeRequest[],
): built is readonly ProbeRequest[] {
  return Array.isArray(built);
}

/** Send one request of a probe and record its row. */
async function probeOnce(
  fetch: (request: Request) => Promise<Response>,
  context: ProbeContext,
  built: ProbeRequest,
): Promise<AccessMatrixRow> {
  const state: ProbeState = {
    surface: context.surface,
    actor: context.actor,
    denied: undefined,
    admitted: undefined,
    authenticated: false,
  };
  const { request, count } = probeRequest(context, built);
  attachAccessProbe(request, createProbe(state));
  const response = await fetch(request);
  const answered = await problemCode(response);
  const outcome: ProbeOutcome =
    state.denied !== undefined ? 'denied' : state.admitted !== undefined ? 'admitted' : 'answered';
  return Object.freeze({
    surface: context.surface.id,
    kind: context.surface.kind,
    method: context.method,
    actor: context.actor.id,
    origin: context.origin,
    outcome,
    decidedBy: (state.denied?.by ?? state.admitted?.surface)?.id ?? null,
    status: response.status,
    code: outcome === 'denied' ? (state.denied?.code ?? null) : answered,
    identified: state.admitted !== undefined && !state.admitted.anonymous,
    handlerInvoked: state.admitted !== undefined,
    bodyBytesRead: count.bytes,
    authenticatorInvoked: state.authenticated,
    cacheControl: response.headers.get('cache-control'),
    setCookie: response.headers.getSetCookie().length > 0,
  });
}
