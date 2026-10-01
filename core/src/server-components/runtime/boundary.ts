/**
 * The server-component lane boundary: `componentRoute` is the only way a
 * transport handler (update, upload, download) becomes something the HTTP
 * layer can mount, and it runs every request through one fixed sequence
 * before the handler sees it:
 *
 * 1. the runtime is open;
 * 2. the per-address limiter admits the client;
 * 3. the request is read (body or query) under the lane's deadline;
 * 4. the credential verifies: MAC and expiry (with the signer's clock
 *    tolerance), then its signed origin equals the trusted origin;
 * 5. the component it names is registered;
 * 6. its subject is the current session's;
 * 7. a download navigation's `Sec-Fetch-Site` is same-origin or none (a
 *    download reference is a capability URL a cross-site page must not
 *    drive);
 * 8. a concurrency slot is free on the lane, for the runtime and for the
 *    principal;
 * 9. the component's `authorize` allows (exactly `true`) against the context
 *    reconstructed from the credential's page, under the deadline;
 * 10. the handler runs, under the deadline.
 *
 * The cross-site check of an update or upload is not the lane's: each
 * transport route is a surface accepting the session cookie, so the access
 * chain refused a cross-site POST before the lane ran.
 *
 * Every credential kind shares one envelope (`component`, `subject`,
 * `origin`, `page`, `expiresAt`), so steps 4 to 9 are the same code on every
 * lane and `reconstructContext` yields the same url and params whichever lane
 * a component is reached through.
 *
 * The deadline is the lane's `totalMs` from arrival. When it passes the
 * request is answered `timeout` and `context.signal` aborts, but the slot is
 * held until the handler's promise actually settles, so a handler that
 * ignores the signal still counts against the lane. A streamed response body
 * keeps its slot until the stream ends, is cancelled, goes `idleMs` without
 * progress, or reaches the deadline. A handler that throws, and an authorize
 * that throws, are reported through the route's reporter and answered
 * value-free (`internal_error`, `unavailable`).
 */

import type { RequestContext } from '../../contracts/http.js';
import { safeEqualStrings } from '../../security/constant-time.js';
import { detach } from '../../support/detach.js';
import type { ServerComponentDefinition } from '../component.js';
import { DownloadError, type DownloadReferenceClaims } from '../downloads.js';
import type { ComponentBoundaryErrorCode } from '../../wire/protocol.js';
import type { ComponentRegistry } from '../registry.js';
import { SnapshotError, type ComponentSigner, type SnapshotPayload } from '../snapshot.js';
import {
  principalOf,
  type Admission,
  type AddressLimiter,
  type AdmissionSlot,
  type Lane,
  type RuntimeLimits,
} from './admission.js';
import {
  acceptedSubjects,
  ComponentAuthorizeErrors,
  evaluateAuthorize,
  trustedOriginOf,
} from './authorize.js';
import { reconstructContext } from './lifecycle.js';

/**
 * The credential kinds a lane can present: a component snapshot (update,
 * refresh, upload) or a download reference (download).
 *
 * @public
 */
export type LaneCredentialKind = 'snapshot' | 'download-ref';

/**
 * The claims every credential kind carries, whatever else it holds.
 *
 * @public
 */
export interface CredentialEnvelope {
  /** The component id the credential was minted for. */
  readonly component: string;
  /** The subject tag of the session it was minted in, or `null` when anonymous. */
  readonly subject: string | null;
  /** The origin it was minted on. */
  readonly origin: string;
  /** The page (path and route params) the component was mounted on. */
  readonly page: { readonly path: string; readonly params: Readonly<Record<string, string>> };
  /** Epoch milliseconds after which it no longer verifies. */
  readonly expiresAt: number;
}

/**
 * The verified credential of kind `K`. Every kind carries the whole
 * {@link CredentialEnvelope}.
 *
 * @public
 */
export type Credential<K extends LaneCredentialKind> = K extends 'snapshot'
  ? SnapshotPayload
  : DownloadReferenceClaims;

/**
 * Every reason the boundary refuses a request, in the order the steps run.
 * The deny matrix is generated from this list and {@link LANES}.
 *
 * @public
 */
export const REJECTIONS: readonly [
  'closed',
  'rate_limited',
  'malformed',
  'credential',
  'origin',
  'unknown_component',
  'subject',
  'cross_site',
  'busy',
  'forbidden',
  'authorize_fault',
  'deadline',
] = Object.freeze([
  'closed',
  'rate_limited',
  'malformed',
  'credential',
  'origin',
  'unknown_component',
  'subject',
  'cross_site',
  'busy',
  'forbidden',
  'authorize_fault',
  'deadline',
] as const);

/**
 * One reason the boundary refuses a request.
 *
 * @public
 */
export type Rejection = (typeof REJECTIONS)[number];

/** What a lane answers a refused request with: a status and a value-free code and message. */
export interface LaneFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/**
 * Members merged into every error body of a lane (the update lane marks its
 * error bodies `kind: 'error'` and echoes `sequence`).
 */
export type LaneEcho = Readonly<Record<string, string | number>>;

/**
 * The result of reading a request: its credential token and parsed input, a
 * failure answered with the lane's error body, or a complete answer of the
 * lane's own protocol (the update lane's `protocol_mismatch`).
 */
export type ComponentRead<I> =
  | { readonly ok: true; readonly token: string; readonly input: I; readonly echo?: LaneEcho }
  | { readonly ok: false; readonly failure: LaneFailure; readonly echo?: LaneEcho }
  | { readonly ok: false; readonly answer: Response };

/**
 * A request that crossed the boundary: the handler's whole view of it.
 *
 * @public
 */
export interface AuthorizedComponentRequest<K extends LaneCredentialKind, I> {
  readonly lane: Lane;
  readonly request: Request;
  readonly credential: Credential<K>;
  /** The credential exactly as presented. */
  readonly token: string;
  readonly componentId: string;
  readonly component: ServerComponentDefinition<any>;
  /** The context reconstructed from the credential's page, carrying `signal`. */
  readonly context: RequestContext;
  /** The current session id, or `null`; the credential's subject was derived from it. */
  readonly subjectId: string | null;
  readonly input: I;
  /** Aborted when the client goes away or the lane's deadline passes. */
  readonly signal: AbortSignal;
  /** The lane's idle allowance for a streamed body, in milliseconds. */
  readonly idleMs: number;
  /** Reports a failure the handler absorbed but an operator should see. */
  readonly report: (error: unknown) => void;
}

/** How one route reads, runs, and answers its requests. */
export interface ComponentRouteSpec<K extends LaneCredentialKind, I> {
  /** The credential the route accepts. */
  readonly credential: K;
  /** The lane the limiter and the read deadline apply to before the request is read. */
  readonly lane: Lane;
  /** The lane the request runs on once read; defaults to {@link lane}. */
  readonly laneOf?: (input: I) => Lane;
  /** Hand a streamed response body the slot, so it is held until the stream closes. */
  readonly streams?: boolean;
  /** Members merged into an error body answered before the request is read. */
  readonly echo?: LaneEcho;
  /** Read the credential token and input. Never throws for client input. */
  read(request: Request, signal: AbortSignal): Promise<ComponentRead<I>>;
  /** Release what `read` opened, after the request is answered either way. */
  dispose?(input: I): Promise<void>;
  /** Answer an authorized request. */
  handle(request: AuthorizedComponentRequest<K, I>): Promise<Response>;
}

declare const COMPONENT_ROUTE: unique symbol;

/**
 * A mounted component transport handler. Only {@link componentRoute} produces
 * one, so every handler the HTTP layer mounts runs behind the boundary.
 * `report` receives every failure the route answers value-free.
 *
 * @public
 */
export type ComponentRoute = ((
  request: Request,
  context: RequestContext,
  report: (error: unknown) => void,
) => Promise<Response>) & { readonly [COMPONENT_ROUTE]: true };

/** What the boundary reads from the assembled runtime. */
export interface BoundaryDeps {
  readonly isClosed: () => boolean;
  readonly registry: ComponentRegistry;
  readonly signer: ComponentSigner;
  readonly limits: RuntimeLimits;
  readonly admission: Admission;
  readonly limiter: AddressLimiter;
  /** Verifies a download reference; `undefined` when downloads are not configured. */
  readonly verifyDownload: ((token: string) => DownloadReferenceClaims) | undefined;
}

/** Build the JSON response every lane answers with; never cached. */
export function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/** The value-free failure for a boundary code. */
export function laneFailure(code: ComponentBoundaryErrorCode, message: string): LaneFailure {
  return { status: STATUS[code], code, message };
}

const STATUS: Readonly<Record<ComponentBoundaryErrorCode, number>> = {
  invalid_request: 400,
  origin_mismatch: 403,
  invalid_snapshot: 403,
  forbidden: 403,
  unknown_component: 404,
  rate_limited: 429,
  unavailable: 503,
  timeout: 503,
  internal_error: 500,
};

/** The wire failure for one rejection on a lane presenting `kind`. */
export function rejectionFailure(reason: Rejection, kind: LaneCredentialKind): LaneFailure {
  // A download reference is a navigation capability: its failures read as one
  // `forbidden`, like any refused capability URL, rather than naming a snapshot.
  const credentialFailure =
    kind === 'snapshot'
      ? laneFailure('invalid_snapshot', 'Invalid component snapshot')
      : laneFailure('forbidden', 'Forbidden');
  switch (reason) {
    case 'closed':
      return laneFailure('unavailable', 'Service unavailable');
    case 'rate_limited':
      return laneFailure('rate_limited', 'Too many requests');
    case 'origin':
      return kind === 'snapshot'
        ? laneFailure('origin_mismatch', 'Cross-origin request rejected')
        : credentialFailure;
    case 'malformed':
      return laneFailure('invalid_request', 'Invalid component request');
    case 'credential':
    case 'subject':
      return credentialFailure;
    case 'unknown_component':
      return laneFailure('unknown_component', 'Unknown component');
    case 'cross_site':
      return credentialFailure;
    case 'busy':
      return laneFailure('unavailable', 'Too many requests in progress');
    case 'forbidden':
      return laneFailure('forbidden', 'Forbidden');
    case 'authorize_fault':
      return laneFailure('unavailable', 'Service unavailable');
    case 'deadline':
      return laneFailure('timeout', 'The request took too long');
  }
}

const INTERNAL: LaneFailure = laneFailure('internal_error', 'Internal Server Error');

function failureResponse(failure: LaneFailure, echo: LaneEcho | undefined): Response {
  const retry: Record<string, string> =
    failure.status === 429 || failure.status === 503 ? { 'retry-after': '1' } : {};
  return jsonResponse(
    failure.status,
    { ...echo, error: { code: failure.code, message: failure.message } },
    retry,
  );
}

/** Navigations a download reference may arrive by: same-origin, or typed/bookmarked. */
const DOWNLOAD_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

function sameSubject(expected: string | null, actual: string | null): boolean {
  if (expected === null || actual === null) {
    return expected === actual;
  }
  return safeEqualStrings(expected, actual);
}

const DEADLINE = Symbol('deadline');

/**
 * Wrap a streamed response body so `release` runs exactly once, when the
 * stream ends, is cancelled, errors, goes `idleMs` without a pull or a chunk,
 * or passes `remainingMs`. A cut stream is errored, and its source cancelled.
 */
function guardResponseBody(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  remainingMs: number,
  release: () => void,
  report: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let cut: () => void = () => undefined;
  const finish = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    release();
  };
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(cut, idleMs);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        cut = () => {
          if (finished) {
            return;
          }
          finish();
          controller.error(new DOMException('component stream timed out', 'TimeoutError'));
          detach(reader.cancel(), report);
        };
        totalTimer = setTimeout(cut, Math.max(remainingMs, 0));
        armIdle();
      },
      async pull(controller) {
        armIdle();
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (!finished) {
            finish();
            controller.error(error);
          }
          return;
        }
        if (finished) {
          return;
        }
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
        armIdle();
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Put a handler behind the boundary. The returned route never throws: every
 * refusal is a value-free JSON answer, and every fault is also handed to the
 * route's reporter.
 */
export function componentRoute<K extends LaneCredentialKind, I>(
  spec: ComponentRouteSpec<K, I>,
  deps: BoundaryDeps,
): ComponentRoute {
  const verify = (token: string): Credential<K> | undefined => {
    try {
      if (spec.credential === 'snapshot') {
        return deps.signer.verify(token) as Credential<K>;
      }
      if (deps.verifyDownload === undefined) {
        return undefined;
      }
      return deps.verifyDownload(token) as Credential<K>;
    } catch (error) {
      if (error instanceof SnapshotError || error instanceof DownloadError) {
        return undefined;
      }
      throw error;
    }
  };

  const route = async (
    request: Request,
    context: RequestContext,
    report: (error: unknown) => void,
  ): Promise<Response> => {
    const refuse = (reason: Rejection, echo: LaneEcho | undefined = spec.echo): Response =>
      failureResponse(rejectionFailure(reason, spec.credential), echo);

    if (deps.isClosed()) {
      return refuse('closed');
    }
    if (!deps.limiter.admit(context.client, spec.lane)) {
      return refuse('rate_limited');
    }
    let trustedOrigin: string;
    try {
      trustedOrigin = trustedOriginOf(context);
    } catch (error) {
      report(error);
      return failureResponse(INTERNAL, spec.echo);
    }

    const started = Date.now();
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fireDeadline: (() => void) | undefined;
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      fireDeadline = () => {
        controller.abort(new DOMException('component request timed out', 'TimeoutError'));
        resolve(DEADLINE);
      };
    });
    const arm = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => fireDeadline?.(), Math.max(ms, 0));
    };
    const race = <T>(work: Promise<T>): Promise<T | typeof DEADLINE> =>
      Promise.race([work, deadline]);

    let lane = spec.lane;
    arm(deps.limits[lane].totalMs);
    let slot: AdmissionSlot | undefined;
    let input: { readonly value: I } | undefined;
    let echo: LaneEcho | undefined = spec.echo;
    try {
      const read = await race(spec.read(request, signal));
      if (read === DEADLINE) {
        return refuse('deadline');
      }
      if ('answer' in read) {
        return read.answer;
      }
      echo = read.echo ?? spec.echo;
      if (!read.ok) {
        return failureResponse(read.failure, echo);
      }
      input = { value: read.input };
      if (spec.laneOf !== undefined) {
        lane = spec.laneOf(read.input);
        arm(deps.limits[lane].totalMs - (Date.now() - started));
      }

      const credential = verify(read.token);
      if (credential === undefined) {
        return refuse('credential', echo);
      }
      if (credential.origin !== trustedOrigin) {
        return refuse('origin', echo);
      }
      const componentId = credential.component;
      const component = deps.registry.get(componentId);
      if (component === undefined) {
        return refuse('unknown_component', echo);
      }
      const subjectId = context.session?.id ?? null;
      if (
        !acceptedSubjects(deps.signer, subjectId).some((tag) =>
          sameSubject(tag, credential.subject),
        )
      ) {
        return refuse('subject', echo);
      }

      if (spec.credential === 'download-ref') {
        const site = request.headers.get('sec-fetch-site');
        if (site !== null && !DOWNLOAD_FETCH_SITES.has(site)) {
          return refuse('cross_site', echo);
        }
      }

      slot = deps.admission.acquire(lane, principalOf(credential.subject, context.client));
      if (slot === undefined) {
        return refuse('busy', echo);
      }

      const authorizedContext = reconstructContext(context, credential.page, trustedOrigin, signal);
      const authorized: AuthorizedComponentRequest<K, I> = {
        lane,
        request,
        credential,
        token: read.token,
        componentId,
        component,
        context: authorizedContext,
        subjectId,
        input: read.input,
        signal,
        idleMs: deps.limits[lane].idleMs,
        report,
      };
      const work = (async (): Promise<Response | Rejection> => {
        const outcome = await evaluateAuthorize(() => component.authorize(authorizedContext));
        if (outcome.kind === 'fault') {
          report(
            new ComponentAuthorizeErrors.Error(
              'component_failed',
              { component: componentId },
              { cause: outcome.error },
            ),
          );
          return 'authorize_fault';
        }
        if (outcome.kind === 'deny') {
          return 'forbidden';
        }
        // An authorize that outlived the deadline (or the client) must not
        // start the handler: the request was already answered `timeout`, and
        // an action run now would take effect behind the client's back, then
        // again on its retry.
        if (signal.aborted) {
          return 'deadline';
        }
        return spec.handle(authorized);
      })();

      const settled = await race(work);
      if (settled === DEADLINE) {
        // The answer goes out now; the slot follows the handler, which may
        // still be running because it ignored the signal.
        const held = slot;
        slot = undefined;
        detach(
          work
            .then(
              async (late) => {
                if (late instanceof Response) {
                  await late.body?.cancel();
                }
              },
              (error: unknown) => {
                report(error);
              },
            )
            .finally(() => {
              held.release();
            }),
          report,
        );
        return refuse('deadline', echo);
      }
      if (typeof settled === 'string') {
        return refuse(settled, echo);
      }
      if (spec.streams === true && settled.body !== null) {
        const held = slot;
        slot = undefined;
        const body = guardResponseBody(
          settled.body,
          deps.limits[lane].idleMs,
          deps.limits[lane].totalMs - (Date.now() - started),
          () => held.release(),
          report,
        );
        return new Response(body, { status: settled.status, headers: settled.headers });
      }
      return settled;
    } catch (error) {
      report(error);
      if (ComponentAuthorizeErrors.is(error)) {
        return refuse('authorize_fault', echo);
      }
      return failureResponse(INTERNAL, echo);
    } finally {
      clearTimeout(timer);
      slot?.release();
      if (input !== undefined && spec.dispose !== undefined) {
        await spec.dispose(input.value);
      }
    }
  };
  return route as ComponentRoute;
}
