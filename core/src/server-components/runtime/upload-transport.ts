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
 * component callback never runs on an unverified reference. The body is read
 * incrementally ({@link openMultipartUpload}): only the leading snapshot field
 * (at most 64 KiB) is read before authorization, so a request that is refused
 * never has its file buffered, and an accepted file streams straight into the
 * store. A component must opt in with `uploads` on its definition; its limits
 * narrow the plugin-wide ones.
 *
 * Concurrent uploads are capped per runtime, but a slot is taken only once the
 * request is authorized and its component accepts uploads: the snapshot phase
 * is already bounded at 64 KiB and must finish within a short deadline, so an
 * unauthenticated client trickling bytes can neither hold a slot nor stall the
 * endpoint for legitimate uploads.
 */

import { Readable } from 'node:stream';

import type { RequestContext } from '../../contracts/http.js';
import { isSameOriginRequest } from '../../security/trusted-mutation.js';
import type { ServerComponentDefinition } from '../component.js';
import type { ComponentSigner } from '../snapshot.js';
import { UploadError } from '../uploads.js';
import type { UploadReferenceClaims, UploadReferenceSigner, UploadStore } from '../uploads.js';
import { acceptedSubjects, authorizeSnapshotRequest, resolveTrustedOrigin } from './authorize.js';
import { generateComponentId } from './lifecycle.js';
import {
  openMultipartUpload,
  type MultipartFilePart,
  type MultipartUploadReader,
} from './multipart-upload.js';
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
  /**
   * Raw session id (or `null` for anonymous) the reference must belong to.
   * Matched against every tag the snapshot signer derives for it, so a
   * reference minted under a retired key still resolves after a rotation.
   * Takes precedence over `expectedSubject`.
   */
  readonly expectedSubjectId?: string | null;
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
  /** Authorized uploads processed at once; further ones are answered `unavailable`. */
  readonly maxConcurrentUploads: number;
  /** Milliseconds the client has to deliver the snapshot field before the request is refused. */
  readonly snapshotTimeoutMs: number;
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

/** Default cap on uploads one runtime processes concurrently. */
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 16;

/** Default deadline for the snapshot field, which precedes authorization. */
export const DEFAULT_UPLOAD_SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * Read the snapshot field, or `undefined` when it does not arrive within
 * `timeoutMs`. The caller cancels the reader afterwards, which settles the
 * abandoned read; its rejection is absorbed here so it never goes unhandled.
 */
async function readSnapshotWithin(
  reader: MultipartUploadReader,
  timeoutMs: number,
): Promise<string | undefined> {
  const reading = reader.readSnapshot();
  reading.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([reading, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fail a stream past a per-component byte cap that is tighter than the store's. */
function capStream(stream: Readable, maxBytes: number): Readable {
  async function* limited(): AsyncGenerator<Buffer> {
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        throw new UploadError('too_large', 'upload exceeds the maximum size');
      }
      yield buffer;
    }
  }
  return Readable.from(limited(), { objectMode: false });
}

export function createUploadTransport(deps: UploadTransportDeps): UploadTransport {
  let inFlight = 0;

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

    // Reject obviously-oversize bodies before reading any of them; the reader
    // and the store still enforce the cap while streaming.
    const maxBodyBytes = deps.maxUploadBytes + UPLOAD_OVERHEAD_SLACK_BYTES;
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
        return uploadErrorResult('too_large', 'Upload exceeds the maximum size');
      }
    }

    return receiveUpload(request, context, trustedOrigin, maxBodyBytes);
  }

  async function receiveUpload(
    request: Request,
    context: RequestContext,
    trustedOrigin: string,
    maxBodyBytes: number,
  ): Promise<ServerComponentUploadResult> {
    const uploads = deps.uploads;
    if (uploads === undefined) {
      return uploadErrorResult('unavailable', 'Uploads are not configured');
    }
    let reader: MultipartUploadReader | undefined;
    let holdsSlot = false;
    try {
      reader = openMultipartUpload(request, maxBodyBytes);
      // Only the snapshot field is read before authorization: nothing of the
      // file is buffered, and nothing is stored or run, until the snapshot
      // boundary is crossed.
      const token = await readSnapshotWithin(reader, deps.snapshotTimeoutMs);
      if (token === undefined) {
        return uploadErrorResult('invalid_request', 'Upload snapshot was not received in time');
      }
      const authorized = await authorizeSnapshotRequest({
        token,
        request,
        context,
        trustedOrigin,
        components: deps.components,
        signer: deps.signer,
      });
      if (!authorized.ok) {
        return uploadErrorResult(authorized.code, authorized.message);
      }
      const { snapshot, component } = authorized;
      const policy = component.uploads;
      if (policy === undefined) {
        return uploadErrorResult('forbidden', 'Component does not accept uploads');
      }
      if (inFlight >= deps.maxConcurrentUploads) {
        return uploadErrorResult('unavailable', 'Too many uploads in progress');
      }
      inFlight += 1;
      holdsSlot = true;

      const file: MultipartFilePart | undefined = await reader.openFile();
      if (file === undefined) {
        return uploadErrorResult('invalid_request', 'Upload is missing a file');
      }
      const contentType = file.contentType.toLowerCase();
      if (
        !deps.uploadContentTypes.has(contentType) ||
        (policy.contentTypes !== undefined &&
          !policy.contentTypes.some((allowed) => allowed.toLowerCase() === contentType))
      ) {
        return uploadErrorResult('unsupported_content_type', 'Unsupported content type');
      }

      let store: UploadStore;
      try {
        store = resolveStore(context.storagePath);
      } catch {
        return uploadErrorResult('unavailable', 'Upload storage is unavailable');
      }

      const stream =
        policy.maxBytes !== undefined && policy.maxBytes < deps.maxUploadBytes
          ? capStream(file.stream, policy.maxBytes)
          : file.stream;
      const id = generateComponentId();
      const { size } = await store.put({
        id,
        subject: snapshot.subject,
        contentType,
        stream,
      });

      try {
        const reference = uploads.signer.sign({
          uploadId: id,
          component: snapshot.component,
          subject: snapshot.subject,
          size,
          contentType,
        });
        return { status: 201, body: { reference } };
      } catch {
        await store.delete(id, snapshot.subject).catch(() => undefined);
        return uploadErrorResult('internal_error', 'Internal Server Error');
      }
    } catch (error) {
      if (error instanceof UploadError) {
        return uploadErrorFromStoreError(error);
      }
      return uploadErrorResult('internal_error', 'Internal Server Error');
    } finally {
      if (holdsSlot) {
        inFlight -= 1;
      }
      await reader?.cancel();
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
    if (
      options.expectedSubjectId !== undefined
        ? !acceptedSubjects(deps.signer, options.expectedSubjectId).includes(claims.subject)
        : options.expectedSubject !== undefined && options.expectedSubject !== claims.subject
    ) {
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
