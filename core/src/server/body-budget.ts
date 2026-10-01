/**
 * The request body budget: the one way a request body is read.
 *
 * When the request frame opens (`request-frame.ts`), a request that carries
 * a body is rebuilt around a bounded copy of its body stream
 * ({@link bindRequestBody}); the frame, the guards, the router (`c.req.raw`)
 * and every handler see only that request. Whether a request carries one
 * depends on how it arrived ({@link BodyWire}): over HTTP/1 its framing
 * headers say exactly (`Transfer-Encoding`, or a `Content-Length` above 0;
 * with neither the body is empty, as a client sends a bodiless DELETE);
 * otherwise (in process, HTTP/2) any method but GET and HEAD with a body
 * stream carries one unless it declares `Content-Length: 0`. A request
 * without a body is left as it is: nothing is copied, and its budget never
 * reads as unread. The bounded stream
 * is lazy: no byte is pulled from the client until a reader asks for one, so
 * a request refused by its length, its origin, its access or a guard costs
 * nothing of its body. Bytes are counted as they are read, against the limit
 * of the route the request reached (`route-limits.ts`), read at count time.
 * Past it the stream fails with `request.too_large`, the source is cancelled,
 * and the budget is marked `exceeded`: the request is then answered 413
 * whatever the handler did with the error.
 *
 * `Expect: 100-continue`: the HTTP server (`http-server.ts`) does not answer
 * it on arrival. It marks the response as owing the interim answer
 * ({@link owe100Continue}), and the bounded stream's first pull writes it, so
 * a client is invited to send its body only once a reader wants it.
 */

import { tooLarge } from '../errors/kernel.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { boundStream } from '../support/bytes.js';

/**
 * A request's body budget: the limit of the route it reached (the app-wide
 * `maxBodyBytes` before one), the bytes read so far, and whether a read went
 * past the limit, in which case the request is answered 413.
 *
 * @public
 */
export interface BodyBudget {
  readonly limit: number;
  readonly consumed: number;
  readonly exceeded: boolean;
}

const BODY_ERRORS = {
  undeclared_read: {
    kind: 'internal',
    message: 'a route read its body as {reader}, which its body declaration does not allow',
    context: { reader: ['json', 'form', 'raw', 'multipart'] },
    suggestion:
      "declare the body the route reads: body: { kind: 'json' | 'form' | 'raw', maxBytes } or { kind: 'multipart', maxBytes, parts }",
  },
} as const;

/**
 * The request-body codes, `body.*`: a read of a kind the route does not
 * declare (outside production; a multipart read in production too). A read
 * past the route's limit is the kernel's `request.too_large` (413).
 *
 * @public
 */
export const BodyErrors: ErrorRegistry<'body', typeof BODY_ERRORS> = defineErrors(
  'body',
  BODY_ERRORS,
);

/** How far a request's body got: none installed, untouched, being read, or settled. */
type BodyState = 'none' | 'unread' | 'reading' | 'complete' | 'abandoned';

/** The frame's budget: the public view plus what the pipeline sets and asks. */
export class RequestBodyBudget implements BodyBudget {
  #limit: number;
  #consumed = 0;
  #exceeded = false;
  #state: BodyState = 'none';

  constructor(limit: number) {
    this.#limit = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  get consumed(): number {
    return this.#consumed;
  }

  get exceeded(): boolean {
    return this.#exceeded;
  }

  /** True when the request has a body that was not read to its end. */
  get unread(): boolean {
    return this.#state !== 'none' && this.#state !== 'complete';
  }

  /**
   * Mark the budget exceeded: a limit the route declares inside its body (a
   * multipart part past its cap) was crossed, so the request is answered 413
   * as if the body had passed the route's limit.
   */
  exceed(): void {
    this.#exceeded = true;
  }

  /** Set the limit of the route the request reached. */
  setLimit(limit: number): void {
    this.#limit = limit;
  }

  /** The bounded stream over `source`; `onFirstPull` runs before its first read. */
  bind(
    source: ReadableStream<Uint8Array>,
    onFirstPull: (() => void) | undefined,
  ): ReadableStream<Uint8Array> {
    this.#state = 'unread';
    return boundStream(source, {
      maxBytes: () => this.#limit,
      overflow: () => {
        this.#exceeded = true;
        return tooLarge();
      },
      onFirstPull: () => {
        this.#state = 'reading';
        onFirstPull?.();
      },
      onChunk: (total) => {
        this.#consumed = total;
      },
      onSettle: (complete) => {
        this.#state = complete ? 'complete' : 'abandoned';
      },
    });
  }
}

/** Methods whose request carries no body, or that `new Request` refuses (no route answers them). */
const BODILESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'CONNECT', 'TRACE', 'TRACK']);

/** How a request's body arrives, as the server it came through states it. */
export interface BodyWire {
  /**
   * True for a request read off an HTTP/1 connection: its framing headers
   * are the body's whole description, so a request with neither
   * `Content-Length` nor `Transfer-Encoding` has no body.
   */
  readonly http1: boolean;
  /** Writes the `100 Continue` the request is owed, at the body's first read. */
  readonly releaseContinue: (() => void) | undefined;
}

/** A request served in process: no framing to go by, no interim answer owed. */
const IN_PROCESS: BodyWire = Object.freeze({ http1: false, releaseContinue: undefined });

/** Whether `request`, which has a body stream, carries a body the budget must bound. */
function carriesBody(request: Request, wire: BodyWire): boolean {
  if (BODILESS_METHODS.has(request.method)) return false;
  if (request.headers.has('transfer-encoding')) return true;
  const length = request.headers.get('content-length');
  if (length === null) return !wire.http1;
  return Number(length.trim()) !== 0;
}

/**
 * `request` with its body read through `budget`, or `request` itself when it
 * carries none. The copy keeps the method, the (already canonical) headers
 * and the abort signal.
 */
export function bindRequestBody(
  request: Request,
  budget: RequestBodyBudget,
  wire: BodyWire = IN_PROCESS,
): Request {
  const source = request.body;
  if (source === null || !carriesBody(request, wire)) return request;
  const init: RequestInit & { duplex: 'half' } = {
    method: request.method,
    headers: request.headers,
    body: budget.bind(source, wire.releaseContinue),
    duplex: 'half',
    signal: request.signal,
  };
  return new Request(request.url, init);
}

/**
 * The body length `request` declares, when it can carry a body and the
 * length is its framing: a valid `Content-Length` and no
 * `Transfer-Encoding`. Reading nothing.
 */
export function declaredBodyLength(request: Request): number | undefined {
  if (BODILESS_METHODS.has(request.method) || request.headers.has('transfer-encoding')) {
    return undefined;
  }
  const value = request.headers.get('content-length');
  if (value === null || !/^\s*\d+\s*$/.test(value)) return undefined;
  return Number(value);
}

/** A response the server may still send `100 Continue` on. */
export interface ContinueTarget {
  readonly headersSent: boolean;
  writeContinue(): void;
}

/** Requests (the adapter's incoming message) whose `100 Continue` is owed, with their response. */
const owedContinue = new WeakMap<object, ContinueTarget>();

/** Mark `incoming` as expecting `100 Continue`, to be written on `outgoing` at the first read. */
export function owe100Continue(incoming: object, outgoing: ContinueTarget): void {
  owedContinue.set(incoming, outgoing);
}

/**
 * How the request in the adapter's `env` arrived: whether it was read off an
 * HTTP/1 connection, and the callback that writes the `100 Continue` it is
 * owed, once (`undefined` when none is owed: an in-process request, a server
 * that answered it on arrival).
 */
export function bodyWire(env: unknown): BodyWire {
  if (env === null || typeof env !== 'object') return IN_PROCESS;
  const incoming = (env as { incoming?: unknown }).incoming;
  if (incoming === null || typeof incoming !== 'object') return IN_PROCESS;
  const http1 = (incoming as { httpVersionMajor?: unknown }).httpVersionMajor === 1;
  const outgoing = owedContinue.get(incoming);
  const releaseContinue =
    outgoing === undefined
      ? undefined
      : (): void => {
          if (!owedContinue.delete(incoming)) return;
          if (!outgoing.headersSent) outgoing.writeContinue();
        };
  return { http1, releaseContinue };
}
