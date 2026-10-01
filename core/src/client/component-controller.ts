/**
 * Browser-safe server-component controller.
 *
 * Owns the client-side model of one component root (canonical server state
 * plus local edits), a serialized one-task-at-a-time queue, and the
 * same-origin POST that drives `/_jsails/components/update`. File uploads
 * for `type=file` bound inputs go through `./component-upload.js`. It touches
 * no DOM and imports no Preact: the DOM binding layer consumes its `onRender`
 * callback (and `state`/`errors`) to morph the server HTML into place.
 *
 * Security posture:
 * - The snapshot token is UNVERIFIED client data. `decodePublicSnapshot`
 *   decodes the base64url JSON body for display/bootstrap only: it checks no
 *   HMAC, holds no key, and must never be treated as an authority. The server
 *   remains the sole authority; every update is re-authorized there.
 * - An update is always a same-origin POST, which the browser sends with its
 *   `Origin` (the server refuses any other); a cross-origin `endpoint` is
 *   rejected before any request is built.
 * - Errors thrown or reported here are value-free: they never embed the
 *   endpoint URL, the snapshot token, request/response bodies,
 *   or raw field values.
 * - No replay of unknown mutations. An action or sync whose outcome is unknown
 *   (network failure, request timeout, or a 502/503/504 from a proxy) is never
 *   re-sent: it rejects with a `retryable` error, the queued work behind it is
 *   rejected too, and the dirty diff is kept, but the controller stays usable
 *   so the next interaction can try again. Only an idempotent `refresh` (no
 *   diff, no action) is retried automatically, with capped backoff that waits
 *   at least a `Retry-After` of up to {@link MAX_REFRESH_RETRY_WAIT_MS}; a
 *   longer named wait would hold every queued interaction, so it is left to
 *   the caller. A caller that owns its backoff (the poll loop) opts out with
 *   `refresh({ retry: false })`. A 429 is a retryable `rate_limited` refusal,
 *   never a block.
 * - Every request is bounded by `requestTimeoutMs`, so a hung connection
 *   cannot stall the serialized queue.
 * - An unexpected response (a rejection, a malformed body, a sequence
 *   mismatch) still blocks the controller permanently. A snapshot the server
 *   rejects after its expiry blocks with `snapshot_expired`, and a server that
 *   speaks another protocol version blocks with `protocol_mismatch`; the
 *   binding layer answers both by reloading the page.
 *
 * Wire protocol: every request is a version 2 update (`wire/protocol.ts`)
 * stating what the client holds, `have.render` (the render tag of the DOM it
 * shows) and `have.slots` (the nested children inside it, from the
 * `heldSlots` option). A reply is parsed by the shared parser; an `unchanged`
 * reply applies nothing and fires no `onRender`.
 */

import type { JsonObject, JsonValue } from '../contracts/http.js';
import type { Awaitable } from '../contracts/awaitable.js';
import { isHttpOrigin } from '../url/origin.js';
import { isForbiddenKey, isPlainObject } from '../json/shape.js';
import {
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
  REFRESH_ACTION,
  UPLOAD_REFERENCE_KEY,
} from '../server-components/protocol.js';
import {
  COMPONENT_PROTOCOL_VERSION,
  MAX_HAVE_SLOTS_BYTES,
  haveSlotsByteLength,
  parseUpdateResponse,
  type ComponentHeldSlot,
  type ComponentRenderResponse,
  type ComponentUpdateEffects,
  type ComponentUpdateRequest,
  type ComponentUpdateResponse,
} from '../wire/protocol.js';
import { jsonViolationMessage, scanJson } from '../wire/json-scan.js';
import {
  sendComponentUpload,
  type ComponentUploadFile,
  type ComponentUploadProgress,
  type ComponentUploadXhr,
  type ComponentUploadXhrFactory,
} from './component-upload.js';
import {
  DEFAULT_MAX_QUEUE,
  MAX_ARGS_KEYS,
  MAX_RESPONSE_BODY_LENGTH,
  jsonEqual,
} from './decoding/limits.js';
import { decodePublicSnapshot, type PublicSnapshot } from './decoding/props.js';
import { JsailsError } from '../errors/jsails-error.js';
import { detach, escalate } from '../support/detach.js';

/** Stable machine codes carried by {@link ComponentControllerError}. */
export type ComponentControllerErrorCode =
  | 'invalid_options'
  | 'invalid_action'
  | 'invalid_args'
  | 'queue_full'
  | 'disposed'
  | 'blocked'
  | 'network'
  | 'timeout'
  | 'unavailable'
  | 'rate_limited'
  | 'snapshot_expired'
  | 'unexpected_status'
  | 'malformed_response'
  | 'sequence_mismatch'
  | 'protocol_mismatch'
  | 'too_many_children'
  | 'upload_failed';

/**
 * Raised for controller misconfiguration, misuse, or a failed update. A
 * `retryable` error (network, timeout, gateway unavailable, rate limited) left
 * the controller usable; any other update failure blocked it. `retryAfterMs`
 * is the wait a 429 or 503 reply named in `Retry-After`, when it named one.
 */
export class ComponentControllerError extends JsailsError {
  constructor(
    message: string,
    readonly code: ComponentControllerErrorCode,
    readonly retryable: boolean = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Default bound on one update request, response body included. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Automatic retries of an idempotent `refresh` after a transient failure. */
const MAX_REFRESH_RETRIES = 2;
/** Base delay of the refresh retry backoff (doubled per attempt). */
const REFRESH_RETRY_BASE_MS = 500;
/**
 * Longest `Retry-After` a refresh retry waits out inside the queue. The
 * framework's own busy replies name 1 s; a longer wait would hold every
 * interaction queued behind the refresh, so it goes to the caller instead.
 */
const MAX_REFRESH_RETRY_WAIT_MS = 5_000;
/**
 * Client-clock tolerance when deciding that an `invalid_snapshot` rejection
 * is an expiry: a client clock running behind the server's must still count
 * a snapshot that is about to expire as expired.
 */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** Gateway statuses that say nothing about whether the request was applied. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
/** The admission refusal: the request was not applied and may be sent again later. */
const RATE_LIMITED_STATUS = 429;

/**
 * The wait a `Retry-After` header names, in milliseconds: delta-seconds or an
 * HTTP date. `undefined` when absent or unreadable; a date in the past is 0.
 */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
  }
  // An HTTP date starts with its day name (`Sun, 06 Nov 1994 08:49:37 GMT`);
  // anything else is not one, however leniently `Date.parse` would read it.
  const date = /^[A-Za-z]{3}[, ]/.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * The wait before retrying `task` in the queue after the transient `error` of
 * its `attempt`, or `null` when it is not retried here: a `sync` (it carries a
 * diff), a refresh whose caller owns the backoff, a spent retry budget, or a
 * named wait too long to hold the queue for. A rate-limited refresh is retried
 * like any other: the refusal says the request was not applied.
 */
function refreshRetryDelay(
  task: RefreshTask,
  error: ComponentControllerError,
  attempt: number,
): number | null {
  if (task.kind !== 'refresh' || !task.retry || attempt >= MAX_REFRESH_RETRIES) {
    return null;
  }
  const named = error.retryAfterMs ?? 0;
  if (named > MAX_REFRESH_RETRY_WAIT_MS) {
    return null;
  }
  return Math.max(REFRESH_RETRY_BASE_MS * 2 ** attempt, named);
}

/** Options of {@link ComponentController.refresh}. */
export interface ComponentRefreshOptions {
  /**
   * Retry a transient failure inside the queue, with capped backoff that
   * waits out a short `Retry-After` (the default). `false` hands every
   * transient failure to the caller at once, for a caller that owns its own
   * backoff (the poll loop).
   */
  readonly retry?: boolean;
}

/** A render payload handed to `onRender` for the DOM binding layer to morph. */
export interface ComponentRender {
  /** Signed snapshot token in effect for the rendered HTML. */
  readonly snapshot: string;
  /** Server-rendered component root HTML. */
  readonly html: string;
  /** The controller's working state at render time. */
  readonly state: JsonObject;
  /** The render tag of `html`, echoed as `have.render` by the next update. */
  readonly render: string;
  /**
   * What the action asked for once the render is applied: a redirect or a
   * download (server-validated, trusted producer output) and the nested
   * children to refresh. Absent on a validation re-render and when the action
   * asked for nothing.
   */
  readonly effects?: ComponentUpdateEffects;
}

/** A serializable same-origin POST the controller performs. */
export interface ComponentFetchInit {
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly credentials: 'same-origin';
  readonly signal: AbortSignal;
}

/** Injectable fetch seam (matches `globalThis.fetch` for this call shape). */
export type ComponentFetch = (input: string, init: ComponentFetchInit) => Promise<Response>;

/** The outcome of a successful upload. */
type ComponentUploadResult = { readonly status: 'uploaded'; readonly reference: string };

/** Options for {@link ComponentController}. */
export interface ComponentControllerOptions {
  /** Initial (unverified) signed snapshot token rendered on the root. */
  readonly snapshot: string;
  /** Same-origin update endpoint. Defaults to `/_jsails/components/update`. */
  readonly endpoint?: string;
  /** Trusted http(s) origin; the endpoint must resolve same-origin. */
  readonly origin: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  readonly fetch?: ComponentFetch;
  /** Receives each actionable server render; awaited before the next action. */
  readonly onRender?: (render: ComponentRender) => Awaitable<void>;
  /** Receives fatal/network errors (value-free). */
  readonly onError?: (error: ComponentControllerError) => void;
  /** Receives the in-flight request count whenever it changes (0 -> 1 -> 0). */
  readonly onInflightChange?: (inflight: number) => void;
  /** Bound on queued (not yet dispatched) actions. Defaults to 8. */
  readonly maxQueue?: number;
  /** Same-origin upload endpoint. Defaults to `/_jsails/components/upload`. */
  readonly uploadEndpoint?: string;
  /** XHR factory used for uploads. Defaults to the platform `XMLHttpRequest`. */
  readonly uploadRequest?: ComponentUploadXhrFactory;
  /** Receives upload progress (value-free), keyed by the bound field name. */
  readonly onUploadProgress?: (field: string, progress: ComponentUploadProgress) => void;
  /**
   * Milliseconds one update request (response body included) may take before
   * it is aborted as a retryable `timeout`. Defaults to 30000.
   */
  readonly requestTimeoutMs?: number;
  /**
   * The render tag of the server render the root currently shows (its
   * `data-jsails-component-render` marker). Omitted, the first update cannot
   * be answered `unchanged`.
   */
  readonly render?: string;
  /**
   * Returns the nested children the root holds, by `(slot, component)`, read
   * when each update is sent so the server keeps them instead of re-mounting
   * them. Omitted (or returning none), the update mounts every child fresh.
   */
  readonly heldSlots?: () => readonly ComponentHeldSlot[];
  /**
   * Receives a re-signed token that arrived without a render (an `unchanged`
   * reply after the server renewed the token's lifetime), so the binding can
   * pin it on the root.
   */
  readonly onSnapshot?: (snapshot: string) => void;
}

/** The outcome of a dispatched action. */
type ComponentCommitResult =
  | { readonly status: 'applied'; readonly state: JsonObject }
  | { readonly status: 'unchanged'; readonly state: JsonObject }
  | {
      readonly status: 'invalid';
      readonly state: JsonObject;
      readonly errors: Readonly<Record<string, string>>;
    };

interface ActionTask {
  readonly kind: 'action';
  readonly actionName: string;
  readonly args: JsonObject;
  readonly resolve: (result: ComponentCommitResult) => void;
  readonly reject: (error: ComponentControllerError) => void;
}

interface UploadTask {
  readonly kind: 'upload';
  readonly field: string;
  readonly file: ComponentUploadFile;
  readonly resolve: (result: ComponentUploadResult) => void;
  readonly reject: (error: ComponentControllerError) => void;
}

interface RefreshTask {
  /** `refresh` sends no dirty diff; `sync` sends the current dirty diff. */
  readonly kind: 'refresh' | 'sync';
  /** Whether a transient failure is retried in the queue (a `refresh` only). */
  readonly retry: boolean;
  readonly resolve: (result: ComponentCommitResult) => void;
  readonly reject: (error: ComponentControllerError) => void;
}

type QueuedTask = ActionTask | UploadTask | RefreshTask;

const EMPTY_ERRORS: Readonly<Record<string, string>> = Object.freeze({});

/** True when `key` names an own or inherited property of `Object.prototype`. */
function shadowsObjectPrototype(key: string): boolean {
  return key in Object.prototype;
}

function assertJsonValue(value: unknown, code: ComponentControllerErrorCode): void {
  const violation = scanJson(value);
  if (violation !== null) {
    throw new ComponentControllerError(jsonViolationMessage(violation), code);
  }
}

function assertFieldKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ComponentControllerError('field key must be a non-empty string', 'invalid_args');
  }
  if (isForbiddenKey(key) || shadowsObjectPrototype(key)) {
    throw new ComponentControllerError(
      'field key must not shadow an inherited property',
      'invalid_args',
    );
  }
}

function assertActionName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ComponentControllerError('action name must be a non-empty string', 'invalid_action');
  }
  if (shadowsObjectPrototype(name)) {
    throw new ComponentControllerError(
      'action name must not shadow an inherited property',
      'invalid_action',
    );
  }
}

function assertArgs(args: unknown): asserts args is JsonObject {
  if (!isPlainObject(args)) {
    throw new ComponentControllerError('action args must be a plain object', 'invalid_args');
  }
  const keys = Object.keys(args);
  if (keys.length > MAX_ARGS_KEYS) {
    throw new ComponentControllerError('action args carry too many keys', 'invalid_args');
  }
  for (const key of keys) {
    if (isForbiddenKey(key) || shadowsObjectPrototype(key)) {
      throw new ComponentControllerError(
        'action args must not shadow an inherited property',
        'invalid_args',
      );
    }
  }
  assertJsonValue(args, 'invalid_args');
}

function assertUploadFile(file: unknown): asserts file is ComponentUploadFile {
  if (typeof file !== 'object' || file === null) {
    throw new ComponentControllerError('upload file must be a File or Blob', 'invalid_args');
  }
  const name = (file as { name?: unknown }).name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new ComponentControllerError('upload file must have a name', 'invalid_args');
  }
}

/** Resolve and enforce a same-origin endpoint, returning it unchanged. */
function resolveSameOriginEndpoint(endpoint: unknown, origin: string): string {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new ComponentControllerError('endpoint must be a non-empty string', 'invalid_options');
  }
  let resolved: URL;
  try {
    resolved = new URL(endpoint, origin);
  } catch {
    throw new ComponentControllerError('endpoint must be a valid URL', 'invalid_options');
  }
  if (resolved.origin !== origin || resolved.username !== '' || resolved.password !== '') {
    throw new ComponentControllerError('endpoint must be same-origin', 'invalid_options');
  }
  return endpoint;
}

/**
 * Build a controller over an initial snapshot. Throws a value-free
 * {@link ComponentControllerError} synchronously for invalid options, and a
 * {@link ComponentSnapshotError} when the initial snapshot cannot be decoded.
 */
export class ComponentController {
  #component: string;
  #origin: string;
  #endpoint: string;
  #uploadEndpoint: string;
  #fetchImpl: ComponentFetch;
  #onRender: ((render: ComponentRender) => Awaitable<void>) | undefined;
  #onError: ((error: ComponentControllerError) => void) | undefined;
  #onInflightChange: ((inflight: number) => void) | undefined;
  #maxQueue: number;
  #uploadRequest: ComponentUploadXhrFactory;
  #onUploadProgress: ((field: string, progress: ComponentUploadProgress) => void) | undefined;

  #requestTimeoutMs: number;
  #heldSlots: (() => readonly ComponentHeldSlot[]) | undefined;
  #onSnapshot: ((snapshot: string) => void) | undefined;
  /** The render tag of the DOM the root shows; `null` when unknown. */
  #renderTag: string | null;
  #canonical: JsonObject;
  #snapshotToken: string;
  /** Unverified expiry of the current snapshot, used only to classify a rejection. */
  #snapshotExpiresAt: number;
  #working: JsonObject;
  #currentErrors: Readonly<Record<string, string>> = EMPTY_ERRORS;
  #dirty = new Map<string, { readonly value: JsonValue; readonly revision: number }>();
  #editClock = 0;
  #sequence = 0;
  #disposed = false;
  #blocked = false;
  #pumping = false;
  #inflight = 0;
  #abortController: AbortController | null = null;
  #activeUploadXhr: ComponentUploadXhr | null = null;
  #queue: QueuedTask[] = [];

  constructor(options: ComponentControllerOptions) {
    if (!isPlainObject(options)) {
      throw new ComponentControllerError('options must be an object', 'invalid_options');
    }

    const decoded = decodePublicSnapshot(options.snapshot);
    const origin = options.origin;
    if (!isHttpOrigin(origin)) {
      throw new ComponentControllerError('origin must be an http(s) origin', 'invalid_options');
    }
    const endpoint = resolveSameOriginEndpoint(
      options.endpoint ?? COMPONENT_UPDATE_ENDPOINT,
      origin,
    );
    const uploadEndpoint = resolveSameOriginEndpoint(
      options.uploadEndpoint ?? COMPONENT_UPLOAD_ENDPOINT,
      origin,
    );

    const candidateFetch = options.fetch;
    if (candidateFetch !== undefined && typeof candidateFetch !== 'function') {
      throw new ComponentControllerError('fetch is not a function', 'invalid_options');
    }
    if (candidateFetch === undefined && typeof globalThis.fetch !== 'function') {
      throw new ComponentControllerError('fetch is not available', 'invalid_options');
    }
    // The browser default must be wrapped in an arrow: `globalThis.fetch` is a
    // `Window` method, and calling the detached method throws "Illegal
    // invocation". An injected `fetch` (tests) is already callable as-is.
    const fetchImpl: ComponentFetch =
      candidateFetch ?? ((input, init) => globalThis.fetch(input, init));
    const onRender = options.onRender;
    if (onRender !== undefined && typeof onRender !== 'function') {
      throw new ComponentControllerError('onRender must be a function', 'invalid_options');
    }
    const onError = options.onError;
    if (onError !== undefined && typeof onError !== 'function') {
      throw new ComponentControllerError('onError must be a function', 'invalid_options');
    }
    const onInflightChange = options.onInflightChange;
    if (onInflightChange !== undefined && typeof onInflightChange !== 'function') {
      throw new ComponentControllerError('onInflightChange must be a function', 'invalid_options');
    }
    const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) {
      throw new ComponentControllerError('maxQueue must be a positive integer', 'invalid_options');
    }

    const providedUploadRequest = options.uploadRequest;
    if (providedUploadRequest !== undefined && typeof providedUploadRequest !== 'function') {
      throw new ComponentControllerError('uploadRequest must be a function', 'invalid_options');
    }
    // Resolved lazily so a controller that never uploads still constructs (and
    // stays import-safe) in an environment without `XMLHttpRequest`.
    const uploadRequest: ComponentUploadXhrFactory =
      providedUploadRequest ??
      (() => {
        const ctor = (globalThis as { XMLHttpRequest?: new () => ComponentUploadXhr })
          .XMLHttpRequest;
        if (typeof ctor !== 'function') {
          throw new ComponentControllerError('XMLHttpRequest is unavailable', 'upload_failed');
        }
        return new ctor();
      });
    const onUploadProgress = options.onUploadProgress;
    if (onUploadProgress !== undefined && typeof onUploadProgress !== 'function') {
      throw new ComponentControllerError('onUploadProgress must be a function', 'invalid_options');
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new ComponentControllerError(
        'requestTimeoutMs must be a positive number',
        'invalid_options',
      );
    }

    const heldSlots = options.heldSlots;
    if (heldSlots !== undefined && typeof heldSlots !== 'function') {
      throw new ComponentControllerError('heldSlots must be a function', 'invalid_options');
    }
    const onSnapshot = options.onSnapshot;
    if (onSnapshot !== undefined && typeof onSnapshot !== 'function') {
      throw new ComponentControllerError('onSnapshot must be a function', 'invalid_options');
    }
    const render = options.render;
    if (render !== undefined && (typeof render !== 'string' || render === '')) {
      throw new ComponentControllerError('render must be a non-empty string', 'invalid_options');
    }

    this.#component = decoded.component;
    this.#heldSlots = heldSlots;
    this.#onSnapshot = onSnapshot;
    this.#renderTag = render ?? null;
    this.#origin = origin;
    this.#endpoint = endpoint;
    this.#uploadEndpoint = uploadEndpoint;
    this.#fetchImpl = fetchImpl;
    this.#onRender = onRender;
    this.#onError = onError;
    this.#onInflightChange = onInflightChange;
    this.#maxQueue = maxQueue;
    this.#uploadRequest = uploadRequest;
    this.#onUploadProgress = onUploadProgress;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#canonical = decoded.state;
    this.#snapshotToken = options.snapshot;
    this.#snapshotExpiresAt = decoded.expiresAt;
    this.#working = { ...decoded.state };
  }

  /** Current working state (canonical server state plus local edits). Read-only. */
  get state(): JsonObject {
    return this.#working;
  }

  /** Last validation errors from a 422, or an empty object. */
  get errors(): Readonly<Record<string, string>> {
    return this.#currentErrors;
  }

  /** Snapshot token currently believed to be the latest. */
  get snapshot(): string {
    return this.#snapshotToken;
  }

  /** The render tag the next update reports as `have.render`; `null` when unknown. */
  get render(): string | null {
    return this.#renderTag;
  }

  /**
   * Forget the render tag, so the next update is answered with a full render.
   * The binding calls it when the DOM no longer matches the last render (a
   * kept child the morph could not keep).
   */
  invalidateRender(): void {
    this.#renderTag = null;
  }

  /** True after a fatal failure: a page reload is required. */
  get blocked(): boolean {
    return this.#blocked;
  }

  /** True after {@link ComponentController.dispose}. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Number of updates currently in flight (never negative). */
  get inflight(): number {
    return this.#inflight;
  }

  /** Set a top-level state field (top-level key only). */
  setField(key: string, value: JsonValue): void {
    if (this.#disposed) {
      throw new ComponentControllerError('controller was disposed', 'disposed');
    }
    assertFieldKey(key);
    assertJsonValue(value, 'invalid_args');
    this.#recordFieldEdit(key, value);
  }

  /** Diff local edits and dispatch exactly one action; serialized with peers. */
  commit(actionName: string, args: JsonObject = {}): Promise<ComponentCommitResult> {
    if (this.#disposed) {
      return Promise.reject(new ComponentControllerError('controller was disposed', 'disposed'));
    }
    try {
      assertActionName(actionName);
      assertArgs(args);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#blocked) {
      return Promise.reject(
        new ComponentControllerError('controller requires a refresh', 'blocked'),
      );
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(new ComponentControllerError('action queue is full', 'queue_full'));
    }
    return new Promise<ComponentCommitResult>((resolve, reject) => {
      this.#queue.push({ kind: 'action', actionName, args, resolve, reject });
      this.#pump();
    });
  }

  /** True when `field` (or any field, when omitted) has an unsent local edit. */
  isDirty(field?: string): boolean {
    if (field !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(this.#working, field)) {
        return false;
      }
      return !jsonEqual(this.#working[field], this.#canonical[field]);
    }
    for (const key of Object.keys(this.#working)) {
      if (!jsonEqual(this.#working[key], this.#canonical[key])) {
        return true;
      }
    }
    return false;
  }

  /** Re-render with no client edits or user action; serialized with peers. */
  refresh(options: ComponentRefreshOptions = {}): Promise<ComponentCommitResult> {
    if (this.#disposed) {
      return Promise.reject(new ComponentControllerError('controller was disposed', 'disposed'));
    }
    if (this.#blocked) {
      return Promise.reject(
        new ComponentControllerError('controller requires a refresh', 'blocked'),
      );
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(new ComponentControllerError('action queue is full', 'queue_full'));
    }
    return new Promise<ComponentCommitResult>((resolve, reject) => {
      this.#queue.push({ kind: 'refresh', retry: options.retry !== false, resolve, reject });
      this.#pump();
    });
  }

  /** Re-render, carrying the current dirty diff but no user action. */
  sync(): Promise<ComponentCommitResult> {
    if (this.#disposed) {
      return Promise.reject(new ComponentControllerError('controller was disposed', 'disposed'));
    }
    if (this.#blocked) {
      return Promise.reject(
        new ComponentControllerError('controller requires a refresh', 'blocked'),
      );
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(new ComponentControllerError('action queue is full', 'queue_full'));
    }
    return new Promise<ComponentCommitResult>((resolve, reject) => {
      this.#queue.push({ kind: 'sync', retry: false, resolve, reject });
      this.#pump();
    });
  }

  /** Upload a file for a bound field; resolves to its signed reference. */
  uploadField(field: string, file: ComponentUploadFile): Promise<ComponentUploadResult> {
    if (this.#disposed) {
      return Promise.reject(new ComponentControllerError('controller was disposed', 'disposed'));
    }
    try {
      assertFieldKey(field);
      assertUploadFile(file);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#blocked) {
      return Promise.reject(
        new ComponentControllerError('controller requires a refresh', 'blocked'),
      );
    }
    if (this.#queue.length >= this.#maxQueue) {
      return Promise.reject(new ComponentControllerError('action queue is full', 'queue_full'));
    }
    return new Promise<ComponentUploadResult>((resolve, reject) => {
      this.#queue.push({ kind: 'upload', field, file, resolve, reject });
      this.#pump();
    });
  }

  /** Abort in-flight/queued work; no callbacks fire afterwards. Idempotent. */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#abortController?.abort();
    this.#abortController = null;
    this.#activeUploadXhr?.abort();
    this.#activeUploadXhr = null;
    const error = new ComponentControllerError('controller was disposed', 'disposed');
    const pending = this.#queue.splice(0);
    for (const task of pending) {
      task.reject(error);
    }
  }

  #notifyError(error: ComponentControllerError): void {
    if (this.#disposed || this.#onError === undefined) {
      return;
    }
    try {
      this.#onError(error);
    } catch {
      // The observer's own failure must not disturb the controller.
    }
  }

  #notifyInflight(): void {
    if (this.#disposed || this.#onInflightChange === undefined) {
      return;
    }
    try {
      this.#onInflightChange(this.#inflight);
    } catch {
      // The observer's own failure must not disturb the controller.
    }
  }

  #fail(message: string, code: ComponentControllerErrorCode): ComponentControllerError {
    this.#blocked = true;
    const error = new ComponentControllerError(message, code);
    const pending = this.#queue.splice(0);
    for (const task of pending) {
      task.reject(error);
    }
    this.#notifyError(error);
    return error;
  }

  /**
   * A transient failure whose outcome is unknown: reject the work queued
   * behind it (it was built on state that may or may not have changed) and
   * report it, but leave the controller usable and the dirty diff intact.
   */
  #failTransient(error: ComponentControllerError): void {
    const pending = this.#queue.splice(0);
    for (const task of pending) {
      task.reject(error);
    }
    this.#notifyError(error);
  }

  async #emitRender(render: ComponentRender): Promise<void> {
    if (this.#disposed || this.#onRender === undefined) {
      return;
    }
    try {
      await this.#onRender(render);
    } catch {
      this.#notifyError(new ComponentControllerError('render callback failed', 'invalid_options'));
    }
  }

  /** Block on a reply that is not what the protocol allows here, and throw. */
  #malformed(): never {
    throw this.#fail('component update returned an unexpected response', 'malformed_response');
  }

  /**
   * Decode a token the server issued for this root. A token for another
   * component or origin is a malformed reply.
   */
  #acceptSnapshot(token: string): PublicSnapshot {
    let next: PublicSnapshot;
    try {
      next = decodePublicSnapshot(token);
    } catch {
      return this.#malformed();
    }
    if (next.component !== this.#component || next.origin !== this.#origin) {
      return this.#malformed();
    }
    return next;
  }

  /**
   * Drop submitted edits (the server incorporated them). Every remaining entry
   * is a newer local edit made after the request was sent; it always survives.
   * The server is authoritative only for the state it actually received, so a
   * field the server changed that was not part of the request must not
   * silently discard the user's later input — that pending edit is sent by the
   * next action.
   */
  #settleSubmitted(submittedAt: number): void {
    for (const [key, entry] of [...this.#dirty]) {
      if (entry.revision <= submittedAt) {
        this.#dirty.delete(key);
      }
    }
    const nextWorking: JsonObject = { ...this.#canonical };
    for (const [key, entry] of this.#dirty) {
      nextWorking[key] = entry.value;
    }
    this.#working = nextWorking;
  }

  async #applySuccess(
    submittedAt: number,
    reply: ComponentRenderResponse,
  ): Promise<ComponentCommitResult> {
    const next = this.#acceptSnapshot(reply.snapshot);
    this.#canonical = next.state;
    this.#settleSubmitted(submittedAt);
    this.#snapshotToken = reply.snapshot;
    this.#snapshotExpiresAt = next.expiresAt;
    this.#renderTag = reply.render;
    this.#currentErrors = EMPTY_ERRORS;

    await this.#emitRender({
      snapshot: reply.snapshot,
      html: reply.html,
      state: this.#working,
      render: reply.render,
      ...(reply.effects === undefined ? {} : { effects: reply.effects }),
    });
    return { status: 'applied', state: this.#working };
  }

  /**
   * The DOM is already the current render. Nothing is morphed; a re-signed
   * token (the server renewed its lifetime) replaces the held one.
   */
  #applyUnchanged(submittedAt: number, snapshot: string | undefined): ComponentCommitResult {
    if (snapshot !== undefined) {
      const next = this.#acceptSnapshot(snapshot);
      this.#canonical = next.state;
      this.#snapshotToken = snapshot;
      this.#snapshotExpiresAt = next.expiresAt;
    }
    this.#settleSubmitted(submittedAt);
    this.#currentErrors = EMPTY_ERRORS;
    if (snapshot !== undefined && !this.#disposed && this.#onSnapshot !== undefined) {
      try {
        this.#onSnapshot(snapshot);
      } catch {
        this.#notifyError(
          new ComponentControllerError('snapshot callback failed', 'invalid_options'),
        );
      }
    }
    return { status: 'unchanged', state: this.#working };
  }

  async #applyInvalid(
    errors: Readonly<Record<string, string>>,
    html: string,
    render: string,
  ): Promise<ComponentCommitResult> {
    // A 422 keeps canonical state, every submitted value, and newer edits.
    this.#currentErrors = errors;
    this.#renderTag = render;
    await this.#emitRender({ snapshot: this.#snapshotToken, html, state: this.#working, render });
    return { status: 'invalid', state: this.#working, errors };
  }

  /** The children the root holds, refusing an update that reports more than the cap. */
  #collectHeldSlots(): readonly ComponentHeldSlot[] {
    const slots = this.#heldSlots?.() ?? [];
    if (slots.length > 0 && haveSlotsByteLength(slots) > MAX_HAVE_SLOTS_BYTES) {
      throw this.#fail('component holds too many nested children', 'too_many_children');
    }
    return slots;
  }

  /**
   * Dispatch one action/refresh/sync. A transient failure of a retrying
   * `refresh` is retried (see {@link refreshRetryDelay}); any other transient
   * failure is reported without blocking (see
   * {@link ComponentController.#failTransient}).
   */
  async #dispatchAction(task: ActionTask | RefreshTask): Promise<ComponentCommitResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#requestOnce(task);
      } catch (error) {
        if (!(error instanceof ComponentControllerError) || !error.retryable) {
          throw error;
        }
        const delay = task.kind === 'action' ? null : refreshRetryDelay(task, error, attempt);
        if (delay !== null) {
          await this.#delay(delay);
          if (!this.#disposed) {
            continue;
          }
          throw new ComponentControllerError('controller was disposed', 'disposed');
        }
        this.#failTransient(error);
        throw error;
      }
    }
  }

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * One update round trip. Throws a `retryable` error for a transient failure
   * (no side effects; the caller decides between retry and reporting) and
   * blocks the controller for any other failure.
   */
  async #requestOnce(task: ActionTask | RefreshTask): Promise<ComponentCommitResult> {
    // `refresh` sends no dirty diff; `action` and `sync` send the current diff.
    // Action args are carried separately, never folded into the updates diff.
    const submitDirty = task.kind !== 'refresh';
    const updates: JsonObject = {};
    if (submitDirty) {
      for (const [key, entry] of this.#dirty) {
        if (!jsonEqual(entry.value, this.#canonical[key])) {
          updates[key] = entry.value;
        }
      }
    }
    const submittedAt = submitDirty ? this.#editClock : 0;
    const actionName = task.kind === 'action' ? task.actionName : REFRESH_ACTION;
    const args = task.kind === 'action' ? task.args : {};

    const slots = this.#collectHeldSlots();
    this.#sequence += 1;
    const requestSequence = this.#sequence;
    const body: ComponentUpdateRequest = {
      v: COMPONENT_PROTOCOL_VERSION,
      sequence: requestSequence,
      snapshot: this.#snapshotToken,
      updates,
      action: { name: actionName, args },
      have: { render: this.#renderTag, slots },
    };

    this.#inflight += 1;
    this.#notifyInflight();
    const abortController = new AbortController();
    this.#abortController = abortController;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.#requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetchImpl(this.#endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
          credentials: 'same-origin',
          signal: abortController.signal,
        });
      } catch {
        this.#throwIfDisposed(task);
        throw timedOut
          ? new ComponentControllerError('component request timed out', 'timeout', true)
          : new ComponentControllerError('component request failed', 'network', true);
      }
      this.#throwIfDisposed(task);

      // A gateway error says nothing about whether the update was applied, and
      // its body is the proxy's, not ours, so classify it before parsing. A
      // rate-limit refusal was not applied; it may be sent again later.
      if (TRANSIENT_STATUSES.has(response.status) || response.status === RATE_LIMITED_STATUS) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        throw response.status === RATE_LIMITED_STATUS
          ? new ComponentControllerError(
              'component update was rate limited',
              'rate_limited',
              true,
              retryAfterMs,
            )
          : new ComponentControllerError(
              'component service is unavailable',
              'unavailable',
              true,
              retryAfterMs,
            );
      }

      const reply = await readReply(response);
      this.#throwIfDisposed(task);
      if (reply === null) {
        if (timedOut) {
          throw new ComponentControllerError('component request timed out', 'timeout', true);
        }
        return this.#malformed();
      }
      // A refusal answered before the server read the body cannot echo the
      // sequence and carries 0, which no request uses.
      const refusedUnread =
        reply.sequence === 0 && (reply.kind === 'error' || reply.kind === 'protocol_mismatch');
      if (reply.sequence !== requestSequence && !refusedUnread) {
        throw this.#fail('component update sequence mismatch', 'sequence_mismatch');
      }

      switch (reply.kind) {
        case 'render':
          if (response.status !== 200) {
            return this.#malformed();
          }
          return await this.#applySuccess(submittedAt, reply);
        case 'unchanged':
          if (response.status !== 200) {
            return this.#malformed();
          }
          return this.#applyUnchanged(submittedAt, reply.snapshot);
        case 'invalid':
          if (response.status !== 422) {
            return this.#malformed();
          }
          return await this.#applyInvalid(reply.errors, reply.html, reply.render);
        case 'protocol_mismatch':
          throw this.#fail('component protocol version mismatch', 'protocol_mismatch');
        case 'error':
          if (response.ok) {
            return this.#malformed();
          }
          if (reply.error.code === 'too_many_children') {
            throw this.#fail('component holds too many nested children', 'too_many_children');
          }
          if (this.#isSnapshotExpiry(reply.error.code)) {
            throw this.#fail('component snapshot expired', 'snapshot_expired');
          }
          throw this.#fail('component update was rejected', 'unexpected_status');
        default:
          return this.#malformed();
      }
    } finally {
      clearTimeout(timer);
      if (this.#abortController === abortController) {
        this.#abortController = null;
      }
      this.#inflight -= 1;
      this.#notifyInflight();
    }
  }

  #throwIfDisposed(task: ActionTask | RefreshTask): void {
    if (this.#disposed) {
      task.reject(new ComponentControllerError('controller was disposed', 'disposed'));
      throw new ComponentControllerError('controller was disposed', 'disposed');
    }
  }

  /**
   * True when the server rejected the snapshot and the snapshot's own
   * (unverified) expiry says it has run out: a reload will mint a fresh one.
   * A rejection of a snapshot that is not near its expiry stays a hard block,
   * so a misconfiguration can never turn into a reload loop.
   */
  #isSnapshotExpiry(code: string): boolean {
    if (code !== 'invalid_snapshot') {
      return false;
    }
    return Date.now() >= this.#snapshotExpiresAt - EXPIRY_SKEW_MS;
  }

  /** Record a validated local edit (shared by `setField` and upload apply). */
  #recordFieldEdit(key: string, value: JsonValue): void {
    this.#editClock += 1;
    this.#dirty.set(key, { value, revision: this.#editClock });
    this.#working = { ...this.#working, [key]: value };
  }

  /**
   * Drive one upload. Resolves to the signed reference; rejects with a
   * value-free {@link ComponentControllerError} (`upload_failed`/`disposed`)
   * otherwise. Never marks the controller blocked: an upload failure is
   * non-fatal.
   */
  async #uploadOnce(field: string, file: ComponentUploadFile): Promise<string> {
    let xhr: ComponentUploadXhr;
    try {
      xhr = this.#uploadRequest();
    } catch {
      throw new ComponentControllerError('upload request is not available', 'upload_failed');
    }

    this.#activeUploadXhr = xhr;
    const onUploadProgress = this.#onUploadProgress;
    const outcome = await sendComponentUpload(xhr, {
      endpoint: this.#uploadEndpoint,
      snapshot: this.#snapshotToken,
      file,
      ...(onUploadProgress === undefined
        ? {}
        : {
            onProgress: (progress: ComponentUploadProgress) => {
              if (!this.#disposed) {
                onUploadProgress(field, progress);
              }
            },
          }),
    });
    if (this.#activeUploadXhr === xhr) {
      this.#activeUploadXhr = null;
    }

    if (outcome.ok) {
      return outcome.reference;
    }
    if (outcome.failure === 'unexpected_response') {
      throw new ComponentControllerError('upload returned an unexpected response', 'upload_failed');
    }
    if (outcome.failure === 'aborted' && this.#disposed) {
      throw new ComponentControllerError('controller was disposed', 'disposed');
    }
    throw new ComponentControllerError('upload failed', 'upload_failed');
  }

  async #dispatchUpload(task: UploadTask): Promise<ComponentUploadResult> {
    const reference = await this.#uploadOnce(task.field, task.file);
    if (this.#disposed) {
      throw new ComponentControllerError('controller was disposed', 'disposed');
    }
    // The uploaded reference is a local edit: it enters working state and the
    // dirty diff so the next action serializes it back to the server.
    this.#recordFieldEdit(task.field, { [UPLOAD_REFERENCE_KEY]: reference });
    return { status: 'uploaded', reference };
  }

  #pump(): void {
    if (this.#pumping || this.#disposed || this.#blocked) {
      return;
    }
    this.#pumping = true;
    detach(
      (async () => {
        try {
          while (!this.#disposed && !this.#blocked && this.#queue.length > 0) {
            const task = this.#queue.shift()!;
            try {
              if (task.kind === 'upload') {
                task.resolve(await this.#dispatchUpload(task));
              } else {
                task.resolve(await this.#dispatchAction(task));
              }
            } catch (error) {
              task.reject(
                error instanceof ComponentControllerError
                  ? error
                  : new ComponentControllerError('component request failed', 'network'),
              );
            }
          }
        } finally {
          this.#pumping = false;
        }
      })(),
      escalate,
    );
  }
}

/** Parse a bounded update reply; `null` on any malformed input. */
async function readReply(response: Response): Promise<ComponentUpdateResponse | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > MAX_RESPONSE_BODY_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parseUpdateResponse(parsed);
}
