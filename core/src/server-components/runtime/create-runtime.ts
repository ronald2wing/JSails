/**
 * Server component runtime assembly: the transport half of the stateful
 * component story.
 *
 * `createServerComponentsRuntime({ components, signer, uploads? })` validates
 * its options and returns a frozen handle whose operations delegate to one
 * module each: `render` to the mount pipeline (or the static fallback),
 * `update` to the update pipeline, `handleUpload`/`resolveUpload` to the upload
 * transport, and `handleDownload` to the download transport.
 *
 * The runtime is stateless across requests: there is no persistent UI store and
 * every request reconstructs its verified state from the signed snapshot, so an
 * update is re-playable (at-least-once, never exactly-once, no atomic DB
 * rollback) and a handler must make its own persistence idempotent. `close()`
 * only flips a guard because the runtime owns no store, listener, or connection.
 *
 * Security posture:
 * - Authorization is default-deny and requires an exact `true`. There is no
 *   implicit role or sign-in identity and the runtime never fabricates one.
 * - Client edits may touch only `writableKeys`; actions run server-side and may
 *   change any schema-valid field. All validation is the strict state schema.
 * - The anonymous CSRF token is the verified snapshot id — a possession token,
 *   not an authentication identity; the session CSRF token is the session's.
 *   The token header is required in all cases and compared constant-time.
 * - Errors never leak the key, state, token, session, or raw submitted values.
 */

import type { RequestContext } from '../../contracts/http.js';
import { isPlainObject } from '../../json/shape.js';
import type { ServerComponentDefinition } from '../component.js';
import type { DownloadReferenceSigner } from '../downloads.js';
import type { ComponentSigner } from '../snapshot.js';
import {
  DEFAULT_UPLOAD_CONTENT_TYPES,
  DEFAULT_UPLOAD_MAX_BYTES,
  type UploadReferenceSigner,
  type UploadStore,
} from '../uploads.js';
import {
  serveComponentDownload,
  type ServerComponentDownloadResult,
} from './download-transport.js';
import { mountComponent } from './mount.js';
import { renderStaticFallbackHtml } from './render-root.js';
import { applyComponentUpdate } from './update.js';
import {
  createUploadTransport,
  type ResolveUploadOptions,
  type ResolvedUpload,
  type ServerComponentUploadOptions,
} from './upload-transport.js';
import {
  ServerComponentRuntimeError,
  type ServerComponentUpdateResult,
  type ServerComponentUploadResult,
} from './value-errors.js';

/** Options for {@link createServerComponentsRuntime}. */
export interface ServerComponentsRuntimeOptions {
  /** Registered components keyed by name. The runtime reads, never mutates, them. */
  readonly components: Readonly<Record<string, ServerComponentDefinition<any>>>;
  /** The signer used to mint and verify snapshot tokens. */
  readonly signer: ComponentSigner;
  /**
   * Optional upload transport. When present the runtime exposes
   * {@link ServerComponentsRuntime.handleUpload} and `resolveUpload`. `store` is
   * either an {@link UploadStore} directly, or a factory resolving one from the
   * request's `storagePath` (the disk store must be rooted per application, and
   * the path is only known at request time). `signer` mints/verifies signed
   * upload references; `downloadSigner`, when present, enables `download()`
   * action results. `maxBytes`/`contentTypes` bound uploads independent of the
   * store implementation.
   */
  readonly uploads?: {
    readonly store: UploadStore | ((storagePath: string) => UploadStore);
    readonly signer: UploadReferenceSigner;
    readonly downloadSigner?: DownloadReferenceSigner;
    readonly maxBytes?: number;
    readonly contentTypes?: readonly string[];
  };
}

/** Options controlling a single `render` (mount). */
export interface ServerComponentRenderOptions {
  /** Render only the author's static fallback; no state, signing, or id. */
  readonly staticMode?: boolean;
  /**
   * Trusted origin bound into the snapshot. Defaults to `context.url.origin`.
   * Supply the public origin when the app sits behind a TLS-terminating proxy.
   */
  readonly origin?: string;
}

/** Options controlling a single `update`. */
export interface ServerComponentUpdateOptions {
  /**
   * Trusted origin the request `Origin` header and snapshot scope must match.
   * Defaults to `context.url.origin`.
   */
  readonly origin?: string;
}

/** The assembled runtime handle. */
export interface ServerComponentsRuntime {
  render(
    name: string,
    context: RequestContext,
    options?: ServerComponentRenderOptions,
  ): Promise<string>;
  update(
    payload: unknown,
    context: RequestContext,
    options?: ServerComponentUpdateOptions,
  ): Promise<ServerComponentUpdateResult>;
  handleUpload(
    request: Request,
    context: RequestContext,
    options?: ServerComponentUploadOptions,
  ): Promise<ServerComponentUploadResult>;
  handleDownload(
    request: Request,
    context: RequestContext,
    options?: ServerComponentUpdateOptions,
  ): Promise<ServerComponentDownloadResult>;
  resolveUpload(reference: unknown, options: ResolveUploadOptions): ResolvedUpload;
  /**
   * Derive the subject tag for a raw session/scope id (delegates to the snapshot
   * signer). Exposed so callers can derive an `expectedSubject` for
   * {@link resolveUpload} without re-implementing the tag derivation.
   */
  subjectFor(sessionOrScopeId: string | null): string | null;
  /**
   * Read-only summary of registered components for introspection. Returns
   * component names, action names, and writable keys only — no state, schemas,
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

function readComponents(
  source: ServerComponentsRuntimeOptions['components'],
): Map<string, ServerComponentDefinition<any>> {
  if (!isPlainObject(source)) {
    throw new TypeError('components must be a plain object of definitions');
  }
  const components = new Map<string, ServerComponentDefinition<any>>();
  for (const [name, definition] of Object.entries(source)) {
    if (name.trim() === '' || name in Object.prototype) {
      throw new ServerComponentRuntimeError('invalid_definition', 'invalid component name');
    }
    if (!isPlainObject(definition) || typeof definition.render !== 'function') {
      throw new ServerComponentRuntimeError('invalid_definition', 'invalid component definition');
    }
    components.set(name, definition);
  }
  return components;
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

function assertUploads(uploads: ServerComponentsRuntimeOptions['uploads']): void {
  if (uploads === undefined) {
    return;
  }
  if (
    uploads === null ||
    typeof uploads !== 'object' ||
    (typeof uploads.store !== 'function' &&
      (uploads.store === null ||
        typeof uploads.store !== 'object' ||
        typeof uploads.store.put !== 'function' ||
        typeof uploads.store.open !== 'function' ||
        typeof uploads.store.delete !== 'function')) ||
    uploads.signer === null ||
    typeof uploads.signer !== 'object' ||
    typeof uploads.signer.sign !== 'function' ||
    typeof uploads.signer.verify !== 'function'
  ) {
    throw new TypeError('uploads must provide a store (or factory) and a reference signer');
  }
  const downloadSigner = uploads.downloadSigner;
  if (
    downloadSigner !== undefined &&
    (downloadSigner === null ||
      typeof downloadSigner !== 'object' ||
      typeof downloadSigner.sign !== 'function' ||
      typeof downloadSigner.verify !== 'function')
  ) {
    throw new TypeError('uploads.downloadSigner must expose sign and verify');
  }
}

/**
 * Assemble a server-components runtime over a component map and a snapshot
 * signer. The runtime is inert: it opens no listener, holds no store, and runs
 * no component callback until an operation is invoked.
 */
export function createServerComponentsRuntime(
  options: ServerComponentsRuntimeOptions,
): ServerComponentsRuntime {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createServerComponentsRuntime requires an options object');
  }
  const components = readComponents(options.components);
  const signer = options.signer;
  assertSigner(signer);
  const uploads = options.uploads;
  assertUploads(uploads);
  const downloadSigner = uploads?.downloadSigner;

  let closed = false;
  const assertOpen = (): void => {
    if (closed) {
      throw new ServerComponentRuntimeError('closed', 'server components runtime is closed');
    }
  };

  const uploadTransport = createUploadTransport({
    isClosed: () => closed,
    uploads: uploads === undefined ? undefined : { store: uploads.store, signer: uploads.signer },
    components,
    signer,
    maxUploadBytes: uploads?.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES,
    uploadContentTypes: new Set(
      (uploads?.contentTypes ?? DEFAULT_UPLOAD_CONTENT_TYPES).map((type) => type.toLowerCase()),
    ),
  });

  return Object.freeze({
    async render(name, context, renderOptions = {}) {
      assertOpen();
      const component = components.get(name);
      if (component === undefined) {
        throw new ServerComponentRuntimeError('not_found', 'unknown server component');
      }
      if (renderOptions.staticMode === true) {
        return renderStaticFallbackHtml(component, context);
      }
      return mountComponent(component, context, signer, renderOptions.origin);
    },
    async update(payload, context, updateOptions = {}) {
      assertOpen();
      return applyComponentUpdate(payload, context, updateOptions.origin, {
        components,
        signer,
        downloadSigner,
      });
    },
    handleUpload: uploadTransport.handleUpload,
    async handleDownload(_request, context) {
      if (closed) {
        return {
          status: 500,
          body: { error: { code: 'internal_error', message: 'Server error' } },
        };
      }
      return serveComponentDownload(context, { signer, downloadSigner, store: uploads?.store });
    },
    resolveUpload: uploadTransport.resolveUpload,
    subjectFor: signer.subjectFor,
    describe() {
      const described = [...components].map(([name, component]) => ({
        name,
        actions: Object.keys(component.actions ?? {}),
        writableKeys: component.writableKeys ?? [],
      }));
      return Object.freeze({ components: Object.freeze(described) });
    },
    close() {
      closed = true;
    },
  } satisfies ServerComponentsRuntime);
}
