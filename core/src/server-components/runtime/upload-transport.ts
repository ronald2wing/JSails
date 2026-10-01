/**
 * The multipart upload transport for the server-component runtime.
 *
 * `createUploadTransport` builds the runtime's `handleUpload` and
 * `resolveUpload` operations over the shared runtime state (the component map
 * and snapshot signer). It is inert: it opens no connection and reads nothing
 * until one of the two operations is invoked, and both fail closed (value-free)
 * when no upload transport was configured.
 *
 * The upload boundary is the update boundary: the request crosses the same
 * {@link authorizeSnapshotRequest} sequence before anything is stored, and a
 * component callback never runs on an unverified reference.
 */

import type { Readable } from 'node:stream';

import type { RequestContext } from '../../contracts/http.js';
import { isSameOriginRequest } from '../../security/trusted-mutation.js';
import type { ServerComponentDefinition } from '../component.js';
import type { ComponentSigner } from '../snapshot.js';
import { UploadError, readUploadBody } from '../uploads.js';
import type {
  UploadRequestBody,
  UploadReferenceClaims,
  UploadReferenceSigner,
  UploadStore,
} from '../uploads.js';
import { authorizeSnapshotRequest, resolveTrustedOrigin } from './authorize.js';
import { generateComponentId } from './lifecycle.js';
import {
  ServerComponentRuntimeError,
  uploadErrorFromStoreError,
  uploadErrorResult,
  type ServerComponentUploadResult,
} from './value-errors.js';

/** Options controlling a single `handleUpload`. */
export interface ServerComponentUploadOptions {
  /**
   * Trusted origin the request `Origin` header and snapshot scope must match.
   * Defaults to `context.url.origin`.
   */
  readonly origin?: string;
}

/** Options controlling a single `resolveUpload`. */
export interface ResolveUploadOptions {
  /** Component the reference must have been minted for. */
  readonly expectedComponent: string;
  /** Subject tag the reference must match (`undefined` skips the check). */
  readonly expectedSubject?: string | null;
  /** Storage path used to resolve a lazy store factory. */
  readonly storagePath?: string;
}

/** A verified, opened-for-use upload reference. */
export interface ResolvedUpload {
  readonly id: string;
  readonly component: string;
  readonly subject: string | null;
  readonly size: number;
  readonly contentType: string;
  /** Open a read stream over the stored upload, or `null` when absent. */
  open(): Promise<Readable | null>;
  /** Delete the stored upload; absent is a no-op. */
  delete(): Promise<void>;
}

/** The configured upload transport: a store (or factory) plus a reference signer. */
interface UploadsConfig {
  readonly store: UploadStore | ((storagePath: string) => UploadStore);
  readonly signer: UploadReferenceSigner;
}

/**
 * Shared runtime state the transport reads. It never mutates any of it; the
 * `closed` guard is owned by the runtime and exposed through `isClosed`.
 */
interface UploadTransportDeps {
  readonly isClosed: () => boolean;
  readonly uploads: UploadsConfig | undefined;
  readonly components: ReadonlyMap<string, ServerComponentDefinition<any>>;
  readonly signer: ComponentSigner;
  readonly maxUploadBytes: number;
  readonly uploadContentTypes: ReadonlySet<string>;
}

/** The upload half of the assembled runtime handle. */
interface UploadTransport {
  handleUpload(
    request: Request,
    context: RequestContext,
    options?: ServerComponentUploadOptions,
  ): Promise<ServerComponentUploadResult>;
  resolveUpload(reference: unknown, options: ResolveUploadOptions): ResolvedUpload;
}

/**
 * Slack added to the upload byte cap to account for multipart framing,
 * boundaries, headers, and the snapshot field (itself capped at 64 KiB). It
 * bounds both the `Content-Length` pre-check and the streaming read, so a
 * headerless body cannot make the multipart parser buffer more than the file
 * cap plus this overhead. The store still enforces the exact file cap.
 */
const UPLOAD_OVERHEAD_SLACK_BYTES = 64 * 1024;

export function createUploadTransport(deps: UploadTransportDeps): UploadTransport {
  function resolveStore(storagePath: string | undefined): UploadStore {
    if (deps.uploads === undefined) {
      throw new ServerComponentRuntimeError('unavailable', 'uploads are not configured');
    }
    if (typeof deps.uploads.store === 'function') {
      if (typeof storagePath !== 'string' || storagePath === '') {
        throw new ServerComponentRuntimeError('unavailable', 'upload storage path is unavailable');
      }
      return deps.uploads.store(storagePath);
    }
    return deps.uploads.store;
  }

  async function handleUpload(
    request: Request,
    context: RequestContext,
    options: ServerComponentUploadOptions = {},
  ): Promise<ServerComponentUploadResult> {
    if (deps.isClosed()) {
      throw new ServerComponentRuntimeError('closed', 'server components runtime is closed');
    }
    if (deps.uploads === undefined) {
      return uploadErrorResult('unavailable', 'Uploads are not configured');
    }

    let trustedOrigin: string;
    try {
      trustedOrigin = resolveTrustedOrigin(options.origin, context);
    } catch {
      return uploadErrorResult('internal_error', 'Internal Server Error');
    }
    if (!isSameOriginRequest(request, trustedOrigin)) {
      return uploadErrorResult('origin_mismatch', 'Cross-origin request rejected');
    }

    // Reject obviously-oversize bodies before the multipart parser buffers them;
    // the store still enforces the exact cap while streaming.
    const maxBodyBytes = deps.maxUploadBytes + UPLOAD_OVERHEAD_SLACK_BYTES;
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
        return uploadErrorResult('too_large', 'Upload exceeds the maximum size');
      }
    }

    let body: UploadRequestBody;
    try {
      // A headerless (chunked) request has no Content-Length to pre-check, so
      // the same bound is enforced while the body is read.
      body = await readUploadBody(request, { maxBytes: maxBodyBytes });
    } catch (error) {
      if (error instanceof UploadError) {
        return uploadErrorFromStoreError(error);
      }
      return uploadErrorResult('internal_error', 'Internal Server Error');
    }
    if (body.file === undefined) {
      return uploadErrorResult('invalid_request', 'Upload is missing a file');
    }

    // Nothing is stored and no component callback runs until the snapshot
    // boundary is crossed.
    const authorized = await authorizeSnapshotRequest({
      token: body.snapshot,
      request,
      context,
      trustedOrigin,
      components: deps.components,
      signer: deps.signer,
    });
    if (!authorized.ok) {
      return uploadErrorResult(authorized.code, authorized.message);
    }
    const { snapshot } = authorized;

    const contentType = body.file.contentType.toLowerCase();
    if (!deps.uploadContentTypes.has(contentType)) {
      return uploadErrorResult('unsupported_content_type', 'Unsupported content type');
    }

    let store: UploadStore;
    try {
      store = resolveStore(context.storagePath);
    } catch {
      return uploadErrorResult('unavailable', 'Upload storage is unavailable');
    }

    const id = generateComponentId();
    let size: number;
    try {
      ({ size } = await store.put({
        id,
        subject: snapshot.subject,
        contentType,
        stream: body.file.stream,
      }));
    } catch (error) {
      if (error instanceof UploadError) {
        return uploadErrorFromStoreError(error);
      }
      return uploadErrorResult('internal_error', 'Internal Server Error');
    }

    try {
      const reference = deps.uploads.signer.sign({
        uploadId: id,
        component: snapshot.component,
        subject: snapshot.subject,
        size,
        contentType,
      });
      return { status: 201, body: { reference } };
    } catch {
      return uploadErrorResult('internal_error', 'Internal Server Error');
    }
  }

  function resolveUpload(reference: unknown, options: ResolveUploadOptions): ResolvedUpload {
    if (deps.isClosed()) {
      throw new ServerComponentRuntimeError('closed', 'server components runtime is closed');
    }
    if (deps.uploads === undefined) {
      throw new ServerComponentRuntimeError('unavailable', 'uploads are not configured');
    }
    if (typeof reference !== 'string') {
      throw new UploadError('invalid_reference', 'Invalid upload reference');
    }
    let claims: UploadReferenceClaims;
    try {
      claims = deps.uploads.signer.verify(reference);
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError('invalid_reference', 'Invalid upload reference');
    }
    if (claims.component !== options.expectedComponent) {
      throw new UploadError(
        'invalid_reference',
        'Upload reference does not match the expected component',
      );
    }
    if (options.expectedSubject !== undefined && options.expectedSubject !== claims.subject) {
      throw new UploadError(
        'invalid_reference',
        'Upload reference does not match the expected subject',
      );
    }
    const store = resolveStore(options.storagePath);
    return {
      id: claims.uploadId,
      component: claims.component,
      subject: claims.subject,
      size: claims.size,
      contentType: claims.contentType,
      open: () => store.open(claims.uploadId, claims.subject),
      delete: () => store.delete(claims.uploadId, claims.subject),
    };
  }

  return { handleUpload, resolveUpload };
}
