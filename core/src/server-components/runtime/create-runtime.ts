/**
 * Server component runtime assembly: the transport half of the stateful
 * component story.
 *
 * `createServerComponentsRuntime({ components, signer, ... })` validates its
 * options once (the component registry, the signers, the frozen
 * {@link RuntimeLimits}) and returns a frozen handle: `render` runs the mount
 * pipeline (or the static fallback), and `routes` holds the three transport
 * handlers (update, upload, download), each built by `componentRoute`, so the
 * only way to reach a handler is through the lane boundary.
 *
 * The runtime is stateless across requests: there is no persistent UI store and
 * every request reconstructs its verified state from the signed snapshot, so an
 * update is re-playable (at-least-once, never exactly-once, no atomic DB
 * rollback) and a handler must make its own persistence idempotent. `close()`
 * only flips a guard because the runtime owns no store, listener, or connection.
 *
 * Security posture:
 * - Authorization is default-deny and requires an exact `true`; a throwing
 *   authorize is a reported fault. There is no implicit role or sign-in
 *   identity and the runtime never fabricates one.
 * - Client edits may touch only `writableKeys`; actions run server-side and may
 *   change any schema-valid field. All validation is the strict state schema.
 * - Updates and uploads are refused cross-site by the access chain before
 *   the lane runs (their routes accept the session cookie); the snapshot's
 *   signed origin must also be the trusted origin.
 * - Errors never leak the key, state, token, session, or raw submitted values.
 */

import type { RequestContext } from '../../contracts/http.js';
import type { DownloadReferenceSigner } from '../downloads.js';
import { describeComponentRegistry, type ComponentRegistry } from '../registry.js';
import { DEFAULT_SNAPSHOT_TTL_MS, type ComponentSigner } from '../snapshot.js';
import {
  DEFAULT_UPLOAD_CONTENT_TYPES,
  DEFAULT_UPLOAD_MAX_BYTES,
  type UploadReferenceSigner,
  type UploadStore,
} from '../uploads.js';
import {
  UNLIMITED_ADDRESSES,
  createAdmission,
  resolveRuntimeLimits,
  type AddressLimiter,
  type RuntimeLimits,
  type RuntimeLimitsInput,
} from './admission.js';
import type { BoundaryDeps, ComponentRoute } from './boundary.js';
import { downloadRoute } from './download-transport.js';
import type { ServerComponentDefinition } from '../component.js';
import { authorizeComponent, mountAuthorized, mountComponent, withRenderSignal } from './mount.js';
import { renderStaticHtml } from './static-render.js';
import { updateRoute } from './update.js';
import {
  createUploadTransport,
  UPLOAD_OVERHEAD_SLACK_BYTES,
  uploadBodyBytes,
  type ResolveUploadOptions,
  type ResolvedUpload,
} from './upload-transport.js';
import { ServerComponentRuntimeError } from './value-errors.js';
import { MAX_ROUTE_BODY_BYTES } from '../../server/route-limits.js';

/** Options for {@link createServerComponentsRuntime}. */
export interface ServerComponentsRuntimeOptions {
  /** The application's components. The runtime reads, never mutates, them. */
  readonly components: ComponentRegistry;
  /** The signer used to mint and verify snapshot tokens. */
  readonly signer: ComponentSigner;
  /** The signer's sliding snapshot lifetime, exposed as `snapshotTtlMs`. Defaults to 1 hour. */
  readonly snapshotTtlMs?: number;
  /** Per-lane concurrency and deadline limits, validated over the defaults. */
  readonly limits?: RuntimeLimitsInput;
  /** The per-address limiter every lane consults first. Defaults to admitting every address. */
  readonly addressLimiter?: AddressLimiter;
  /**
   * The store uploads are written to and downloads read from: an
   * {@link UploadStore}, or a factory resolving one from the request's
   * `storagePath` (the disk store is rooted per application, and the path is
   * only known at request time).
   */
  readonly store?: UploadStore | ((storagePath: string) => UploadStore);
  /**
   * Optional upload transport. `signer` mints signed upload references, and
   * `maxBytes`/`contentTypes` bound uploads independent of the store. Only
   * components that declare `uploads` accept a file, and only those that
   * declare `uploads.anonymous` accept one without a session.
   */
  readonly uploads?: {
    readonly signer: UploadReferenceSigner;
    readonly maxBytes?: number;
    readonly contentTypes?: readonly string[];
  };
  /** Optional download transport: `signer` mints and verifies download references. */
  readonly downloads?: {
    readonly signer: DownloadReferenceSigner;
  };
}

/** Options controlling a single `render` (mount). */
export interface ServerComponentRenderOptions {
  /** Render the component's static form (`static-render.ts`); nothing is signed. */
  readonly staticMode?: boolean;
}

/**
 * Options controlling one nested child render (`renderNested`).
 *
 * @public
 */
export interface ServerComponentChildRenderOptions {
  /** Render the component's static form (`static-render.ts`); nothing is signed. */
  readonly staticMode?: boolean;
  /**
   * The client already holds this child in its slot, with this component. When
   * the child's `authorize` allows, it is kept by reference: nothing about it
   * runs and nothing is rendered for it.
   */
  readonly held?: boolean;
}

/**
 * The outcome of a nested child render: kept by reference (the client's copy
 * stays), mounted (its HTML), or denied by its `authorize` (rendered as
 * nothing, so a child the viewer may no longer see is removed).
 *
 * @public
 */
export type ServerComponentChildRender =
  | { readonly kind: 'keep' }
  | { readonly kind: 'html'; readonly html: string }
  | { readonly kind: 'denied' };

/**
 * What one request's live renders mean for a response cache: the component
 * ids it mounted, and whether any of them is bound to a session subject (and
 * so must never be served to another visitor).
 *
 * @public
 */
export interface ServerComponentRenderMarks {
  readonly roots: readonly string[];
  readonly subjectBound: boolean;
}

/**
 * The transport handlers, one per endpoint; mount each at its protocol path.
 *
 * @public
 */
export interface ServerComponentRoutes {
  readonly update: ComponentRoute;
  readonly upload: ComponentRoute;
  readonly download: ComponentRoute;
  /** The largest request body the upload route reads: the file cap plus multipart framing. */
  readonly uploadBodyBytes: number;
  /**
   * How long each route's lane lets a request run (its `totalMs`; the update
   * route serves the update and refresh lanes, so the longer of the two). A
   * request still running then is answered by the lane itself (`503
   * timeout`), so the HTTP route around it must allow at least this long.
   */
  readonly laneTotalMs: {
    readonly update: number;
    readonly upload: number;
    readonly download: number;
  };
}

/** The assembled runtime handle. */
export interface ServerComponentsRuntime {
  /** Render the component registered as `id`; a denying `authorize` throws `forbidden`. */
  render(
    id: string,
    context: RequestContext,
    options?: ServerComponentRenderOptions,
  ): Promise<string>;
  /** Render the component registered as `id` as a nested child (see {@link ServerComponentChildRender}). */
  renderChild(
    id: string,
    context: RequestContext,
    options?: ServerComponentChildRenderOptions,
  ): Promise<ServerComponentChildRender>;
  /** The transport handlers, each behind the lane boundary. */
  readonly routes: ServerComponentRoutes;
  /** The sliding snapshot lifetime: how long a mounted component stays updatable while idle. */
  readonly snapshotTtlMs: number;
  /** The validated limits every lane runs under. */
  readonly limits: RuntimeLimits;
  /** The marks this request's live renders left so far. */
  renderMarks(request: Request): ServerComponentRenderMarks;
  resolveUpload(reference: unknown, options: ResolveUploadOptions): ResolvedUpload;
  /**
   * Derive the subject tag for a raw session/scope id (delegates to the snapshot
   * signer). Exposed so callers can derive an `expectedSubject` for
   * {@link resolveUpload} without re-implementing the tag derivation.
   */
  subjectFor(sessionOrScopeId: string | null): string | null;
  /**
   * Read-only summary of registered components for introspection. Returns
   * component ids, action names, and writable keys only — no state, schemas,
   * or signing details.
   */
  describe(): {
    readonly components: ReadonlyArray<{
      readonly name: string;
      readonly actions: readonly string[];
      readonly writableKeys: readonly string[];
    }>;
  };
  close(): void;
}

function assertRegistry(components: ComponentRegistry): void {
  if (
    components === null ||
    typeof components !== 'object' ||
    typeof components.get !== 'function' ||
    typeof components.entries !== 'function'
  ) {
    throw new TypeError('components must be a component registry');
  }
}

function assertSigner(signer: ComponentSigner): void {
  if (
    signer === null ||
    typeof signer !== 'object' ||
    typeof signer.subjectFor !== 'function' ||
    typeof signer.sign !== 'function' ||
    typeof signer.verify !== 'function'
  ) {
    throw new TypeError('signer must expose subjectFor, sign, and verify');
  }
}

function hasSignAndVerify(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { sign?: unknown }).sign === 'function' &&
    typeof (value as { verify?: unknown }).verify === 'function'
  );
}

function assertTransports(options: ServerComponentsRuntimeOptions): void {
  const store = options.store;
  if (
    store !== undefined &&
    typeof store !== 'function' &&
    (store === null ||
      typeof store !== 'object' ||
      typeof store.put !== 'function' ||
      typeof store.open !== 'function' ||
      typeof store.delete !== 'function')
  ) {
    throw new TypeError('store must be an upload store or a store factory');
  }
  if (options.uploads !== undefined) {
    if (options.uploads === null || !hasSignAndVerify(options.uploads.signer)) {
      throw new TypeError('uploads must provide a reference signer');
    }
    if (store === undefined) {
      throw new TypeError('uploads require a store');
    }
    const { maxBytes } = options.uploads;
    if (
      maxBytes !== undefined &&
      (!Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        uploadBodyBytes(maxBytes) > MAX_ROUTE_BODY_BYTES)
    ) {
      throw new TypeError(
        `uploads.maxBytes must be a positive integer of at most ${MAX_ROUTE_BODY_BYTES - UPLOAD_OVERHEAD_SLACK_BYTES} bytes`,
      );
    }
  }
  if (options.downloads !== undefined) {
    if (options.downloads === null || !hasSignAndVerify(options.downloads.signer)) {
      throw new TypeError('downloads must provide a reference signer');
    }
    if (store === undefined) {
      throw new TypeError('downloads require a store');
    }
  }
}

/**
 * Assemble a server-components runtime over a component registry and a
 * snapshot signer. The runtime is inert: it opens no listener, holds no store,
 * and runs no component callback until a render or a request arrives.
 */
export function createServerComponentsRuntime(
  options: ServerComponentsRuntimeOptions,
): ServerComponentsRuntime {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createServerComponentsRuntime requires an options object');
  }
  const registry = options.components;
  assertRegistry(registry);
  const signer = options.signer;
  assertSigner(signer);
  assertTransports(options);
  const limits = resolveRuntimeLimits(options.limits);
  const downloadSigner = options.downloads?.signer;

  let closed = false;
  const isClosed = (): boolean => closed;
  const boundary: BoundaryDeps = {
    isClosed,
    registry,
    signer,
    limits,
    admission: createAdmission(limits),
    limiter: options.addressLimiter ?? UNLIMITED_ADDRESSES,
    verifyDownload:
      downloadSigner === undefined ? undefined : (token) => downloadSigner.verify(token),
  };

  const uploadTransport = createUploadTransport({
    isClosed,
    boundary,
    uploads:
      options.uploads === undefined || options.store === undefined
        ? undefined
        : { store: options.store, signer: options.uploads.signer },
    signer,
    maxUploadBytes: options.uploads?.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES,
    uploadContentTypes: new Set(
      (options.uploads?.contentTypes ?? DEFAULT_UPLOAD_CONTENT_TYPES).map((type) =>
        type.toLowerCase(),
      ),
    ),
  });

  const routes: ServerComponentRoutes = Object.freeze({
    update: updateRoute({ boundary, signer, downloadSigner }),
    upload: uploadTransport.route,
    uploadBodyBytes: uploadTransport.bodyBytes,
    laneTotalMs: Object.freeze({
      update: Math.max(limits.update.totalMs, limits.refresh.totalMs),
      upload: limits.upload.totalMs,
      download: limits.download.totalMs,
    }),
    download: downloadRoute({
      boundary,
      store: downloadSigner === undefined ? undefined : options.store,
    }),
  });

  // Marks are kept per request object: a nested child rendered during its
  // parent's render shares the request, so one request's roots accumulate.
  const marks = new WeakMap<Request, { roots: string[]; subjectBound: boolean }>();
  const mark = (context: RequestContext, id: string): void => {
    let entry = marks.get(context.request);
    if (entry === undefined) {
      entry = { roots: [], subjectBound: false };
      marks.set(context.request, entry);
    }
    entry.roots.push(id);
    entry.subjectBound ||= signer.subjectFor(context.session?.id ?? null) !== null;
  };

  const lookup = (id: string): ServerComponentDefinition<any> => {
    if (closed) {
      throw new ServerComponentRuntimeError('closed', 'server components runtime is closed');
    }
    const component = registry.get(id);
    if (component === undefined) {
      throw new ServerComponentRuntimeError('not_found', 'unknown server component');
    }
    return component;
  };

  return Object.freeze({
    async render(id, context, renderOptions = {}) {
      const component = lookup(id);
      if (renderOptions.staticMode === true) {
        return renderStaticHtml(id, component, context);
      }
      const html = await mountComponent(id, component, context, signer);
      mark(context, id);
      return html;
    },
    async renderChild(id, requestContext, childOptions = {}) {
      const component = lookup(id);
      if (childOptions.staticMode === true) {
        return { kind: 'html', html: await renderStaticHtml(id, component, requestContext) };
      }
      const context = withRenderSignal(requestContext);
      if (!(await authorizeComponent(id, component, context))) {
        return { kind: 'denied' };
      }
      if (childOptions.held === true) {
        return { kind: 'keep' };
      }
      const html = await mountAuthorized(id, component, context, signer);
      mark(context, id);
      return { kind: 'html', html };
    },
    routes,
    snapshotTtlMs: options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS,
    limits,
    renderMarks(request) {
      const entry = marks.get(request);
      return Object.freeze({
        roots: Object.freeze([...(entry?.roots ?? [])]),
        subjectBound: entry?.subjectBound ?? false,
      });
    },
    resolveUpload: uploadTransport.resolveUpload,
    subjectFor: (sessionOrScopeId) => signer.subjectFor(sessionOrScopeId),
    describe() {
      return Object.freeze({ components: describeComponentRegistry(registry) });
    },
    close() {
      closed = true;
    },
  } satisfies ServerComponentsRuntime);
}
