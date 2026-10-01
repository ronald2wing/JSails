/**
 * The multipart upload transport for the server-component runtime.
 *
 * `createUploadTransport` builds the upload lane's route and the runtime's
 * `resolveUpload` over the shared runtime state. It is inert: it opens no
 * connection and reads nothing until a request arrives, and both fail closed
 * (value-free) when no upload transport was configured.
 *
 * The upload lane crosses the same boundary as the update lane
 * ({@link componentRoute}), behind the access chain's cross-site check:
 * snapshot (its signed origin included), subject, a concurrency slot, and
 * the component's `authorize`, all before anything is stored. The body is
 * read by the framework's streaming multipart reader (`server/multipart.ts`)
 * under the upload's own parts (the snapshot field, then one file): only the
 * leading snapshot field (at most 64 KiB, within a short deadline) is read
 * before the boundary decides, so a refused request never has its file
 * buffered, and an accepted file streams straight into the store. A
 * component must opt in with `uploads` on its definition; its limits narrow
 * the plugin-wide ones.
 *
 * The lane slot is taken only once the request is authorized, so an
 * unauthenticated client trickling bytes can neither hold a slot nor stall
 * the lane. The body must keep arriving (the reader's idle bound is the
 * lane's `idleMs`) and finish before the lane deadline, whose signal the
 * reader honours, or the read fails, the body is released and the slot
 * with it.
 *
 * Anonymous uploads are refused unless the component opts in with its own
 * `uploads.anonymous` quota, counted per component on top of the lane's
 * per-principal slots: without it one visitor could exhaust the shared
 * anonymous storage scope for every component that accepts files.
 */

import { Readable } from 'node:stream';

import type { ServerComponentAnonymousUploads } from '../component.js';
import type { ComponentSigner } from '../snapshot.js';
import { DEFAULT_UPLOAD_REFERENCE_TTL_MS, UploadError } from '../uploads.js';
import type { UploadReferenceClaims, UploadReferenceSigner, UploadStore } from '../uploads.js';
import { acceptedSubjects } from './authorize.js';
import {
  componentRoute,
  jsonResponse,
  type AuthorizedComponentRequest,
  type BoundaryDeps,
  type ComponentRead,
  type ComponentRoute,
  type LaneFailure,
} from './boundary.js';
import { generateComponentId } from './lifecycle.js';
import type { MultipartFilePart, MultipartPart } from '../../contracts/http.js';
import { MultipartErrors, readMultipart, type MultipartReader } from '../../server/multipart.js';
import type { MultipartSpec } from '../../server/route-limits.js';
import {
  COMPONENT_UPLOAD_FILE_FIELD,
  COMPONENT_UPLOAD_SNAPSHOT_FIELD,
  type ComponentUploadErrorCode,
} from '../protocol.js';
import {
  ServerComponentRuntimeError,
  uploadErrorFromStoreError,
  uploadErrorResult,
} from './value-errors.js';
import { detach, escalate } from '../../support/detach.js';

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
  readonly boundary: BoundaryDeps;
  readonly uploads: UploadsConfig | undefined;
  readonly signer: ComponentSigner;
  readonly maxUploadBytes: number;
  readonly uploadContentTypes: ReadonlySet<string>;
  /** Time source returning epoch milliseconds, for the anonymous quota window. */
  readonly now?: () => number;
}

/** The upload half of the assembled runtime handle. */
interface UploadTransport {
  readonly route: ComponentRoute;
  /** The largest request body the route reads ({@link uploadBodyBytes}). */
  readonly bodyBytes: number;
  resolveUpload(reference: unknown, options: ResolveUploadOptions): ResolvedUpload;
}

/** The read half of an upload: the opened multipart body, past its snapshot field. */
interface UploadInput {
  readonly reader: MultipartReader;
}

/**
 * Slack added to the upload byte cap to account for multipart framing,
 * boundaries, headers, and the snapshot field (itself capped at 64 KiB). The
 * upload route declares the sum as its body (`raw`), so the request's body
 * budget refuses a longer declared length before anything is read and stops
 * a headerless body there; the multipart reader bounds each part (the
 * snapshot field, the file, every header block), and the store enforces the
 * exact file cap.
 */
export const UPLOAD_OVERHEAD_SLACK_BYTES: number = 64 * 1024;

/** The largest request body an upload with a file cap of `maxUploadBytes` may take. */
export function uploadBodyBytes(maxUploadBytes: number): number {
  return maxUploadBytes + UPLOAD_OVERHEAD_SLACK_BYTES;
}

/**
 * Deadline for the snapshot field, which precedes authorization: a client
 * that has not proved it holds a snapshot within it is refused, so a slow
 * unauthenticated sender cannot keep a request open.
 */
const UPLOAD_SNAPSHOT_TIMEOUT_MS = 10_000;

/** Default concurrent anonymous uploads for a component that accepts them. */
const DEFAULT_MAX_CONCURRENT_ANONYMOUS_UPLOADS = 2;

/**
 * Resolve the store an upload or download uses: the configured store, or the
 * factory's store for the request's storage path. An empty or missing path is
 * refused rather than handed to the factory, which would root the store
 * relative to the process's working directory.
 */
export function resolveUploadStore(
  store: UploadStore | ((storagePath: string) => UploadStore) | undefined,
  storagePath: string | undefined,
): UploadStore {
  if (store === undefined) {
    throw new ServerComponentRuntimeError('unavailable', 'uploads are not configured');
  }
  if (typeof store !== 'function') {
    return store;
  }
  if (typeof storagePath !== 'string' || storagePath === '') {
    throw new ServerComponentRuntimeError('unavailable', 'upload storage path is unavailable');
  }
  return store(storagePath);
}

/** Resolve `promise`, or `undefined` when `timeoutMs` passes first. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(timeoutMs, 0));
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function uploadTimedOut(): UploadError {
  return new UploadError('invalid_input', 'Upload did not arrive in time');
}

/** Upper bound on the snapshot field, matching the update payload's snapshot cap. */
const MAX_UPLOAD_SNAPSHOT_BYTES = 64 * 1024;

/**
 * The parts an upload body carries: the snapshot field, then one file of at
 * most `maxUploadBytes` in the file field, each read arriving within
 * `idleMs`. A third part, a second file or a file in another field fails the
 * read.
 */
function uploadParts(maxUploadBytes: number, idleMs: number): MultipartSpec {
  return {
    maxParts: 2,
    maxFieldBytes: MAX_UPLOAD_SNAPSHOT_BYTES,
    files: { [COMPONENT_UPLOAD_FILE_FIELD]: { maxBytes: maxUploadBytes, maxCount: 1 } },
    idleMs,
  };
}

/**
 * A multipart reader failure as the upload lane answers it: a crossed limit
 * is `too_large`, a body that stopped arriving (or a request that ended)
 * timed out, and anything else malformed input. Any other error is returned
 * as it is.
 */
function uploadErrorOf(error: unknown): unknown {
  if (MultipartErrors.is(error, 'too_large')) {
    return new UploadError('too_large', 'upload exceeds the maximum size');
  }
  if (MultipartErrors.is(error, 'idle') || MultipartErrors.is(error, 'aborted')) {
    return uploadTimedOut();
  }
  if (MultipartErrors.is(error)) {
    return new UploadError('invalid_input', 'Upload body could not be parsed');
  }
  return error;
}

/** The reader's next part, a reader failure turned into the lane's {@link UploadError}. */
async function nextPart(
  reader: MultipartReader,
): Promise<IteratorResult<MultipartPart, undefined>> {
  try {
    return await reader.next();
  } catch (error) {
    throw uploadErrorOf(error);
  }
}

/** The leading snapshot field; any other first part is refused. */
async function readSnapshot(reader: MultipartReader): Promise<string> {
  const first = await nextPart(reader);
  if (
    first.done === true ||
    first.value.kind !== 'field' ||
    first.value.name !== COMPONENT_UPLOAD_SNAPSHOT_FIELD ||
    first.value.value === ''
  ) {
    throw new UploadError('invalid_input', 'Upload is missing a snapshot');
  }
  return first.value.value;
}

/** The file part after the snapshot, or `undefined` when the body closes without one. */
async function openFile(reader: MultipartReader): Promise<MultipartFilePart | undefined> {
  const next = await nextPart(reader);
  if (next.done === true) return undefined;
  if (next.value.kind !== 'file' || next.value.filename === undefined) {
    throw new UploadError('invalid_input', 'Upload file field is invalid');
  }
  return next.value;
}

/** The file's bytes as the store reads them, a reader failure turned into an {@link UploadError}. */
function uploadStream(stream: ReadableStream<Uint8Array>): Readable {
  async function* chunks(): AsyncGenerator<Buffer> {
    try {
      for await (const chunk of stream) {
        yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
    } catch (error) {
      throw uploadErrorOf(error);
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}

/** What one component's anonymous uploads have used within the quota window. */
interface AnonymousLedger {
  /** Committed uploads still inside the window, oldest first. */
  readonly committed: { readonly at: number; readonly bytes: number }[];
  /** Bytes streamed by uploads that have not committed yet. */
  streamingBytes: number;
}

/**
 * Read the snapshot field, or `undefined` when it does not arrive within
 * `timeoutMs`. The caller cancels the reader afterwards, which settles the
 * abandoned read; its rejection is absorbed here so it never goes unhandled.
 */
async function readSnapshotWithin(
  reader: MultipartReader,
  timeoutMs: number,
): Promise<string | undefined> {
  const reading = readSnapshot(reader);
  // Marked handled: settleWithin observes it inside the bound; past it the
  // caller's cancel settles the abandoned read (see above).
  reading.catch(() => undefined);
  return settleWithin(reading, timeoutMs);
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

function toFailure(code: ComponentUploadErrorCode, message: string): LaneFailure {
  return { status: uploadErrorResult(code, message).status, code, message };
}

/** The failure for an error raised while opening or reading the multipart body. */
function failureFromError(raised: unknown): LaneFailure {
  const error = uploadErrorOf(raised);
  if (error instanceof UploadError) {
    const { status, body } = uploadErrorFromStoreError(error);
    return {
      status,
      code: body.error?.code ?? 'invalid_request',
      message: body.error?.message ?? 'Invalid upload',
    };
  }
  return toFailure('invalid_request', 'Invalid upload');
}

function uploadFailure(code: ComponentUploadErrorCode, message: string): Response {
  const result = uploadErrorResult(code, message);
  return jsonResponse(result.status, result.body);
}

export function createUploadTransport(deps: UploadTransportDeps): UploadTransport {
  const now = deps.now ?? Date.now;
  /** Anonymous uploads in progress per component, against its `uploads.anonymous` cap. */
  const anonymousInFlight = new Map<string, number>();
  const anonymousLedgers = new Map<string, AnonymousLedger>();

  function resolveStore(storagePath: string | undefined): UploadStore {
    return resolveUploadStore(deps.uploads?.store, storagePath);
  }

  /**
   * The component's anonymous ledger with uploads older than the reference
   * lifetime dropped: past it no reference can name them, so they no longer
   * count against what an anonymous visitor may stage.
   */
  function anonymousLedger(component: string): AnonymousLedger {
    let ledger = anonymousLedgers.get(component);
    if (ledger === undefined) {
      ledger = { committed: [], streamingBytes: 0 };
      anonymousLedgers.set(component, ledger);
    }
    const cutoff = now() - DEFAULT_UPLOAD_REFERENCE_TTL_MS;
    while ((ledger.committed[0]?.at ?? cutoff) < cutoff) {
      ledger.committed.shift();
    }
    return ledger;
  }

  /** Count anonymous bytes as they stream, failing the stream past the component's byte quota. */
  function meterAnonymous(
    stream: Readable,
    ledger: AnonymousLedger,
    quota: ServerComponentAnonymousUploads,
    counted: { bytes: number },
  ): Readable {
    async function* metered(): AsyncGenerator<Buffer> {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        const committed = ledger.committed.reduce((total, entry) => total + entry.bytes, 0);
        if (committed + ledger.streamingBytes + buffer.length > quota.maxBytes) {
          throw new UploadError('quota_exceeded', 'upload quota exceeded');
        }
        ledger.streamingBytes += buffer.length;
        counted.bytes += buffer.length;
        yield buffer;
      }
    }
    return Readable.from(metered(), { objectMode: false });
  }

  /**
   * Open the multipart body and read only its snapshot field. An oversize
   * declared length is refused before a byte is read; the reader and the store
   * still enforce the cap while streaming, and the reader cuts off a body
   * that stops arriving for the lane's `idleMs` or outlives `signal`.
   */
  async function readUpload(
    request: Request,
    signal: AbortSignal,
  ): Promise<ComponentRead<UploadInput>> {
    if (deps.uploads === undefined) {
      return { ok: false, failure: toFailure('unavailable', 'Uploads are not configured') };
    }
    const maxBodyBytes = uploadBodyBytes(deps.maxUploadBytes);
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
        return { ok: false, failure: toFailure('too_large', 'Upload exceeds the maximum size') };
      }
    }
    let reader: MultipartReader;
    try {
      reader = readMultipart(
        request.body,
        request.headers.get('content-type'),
        uploadParts(deps.maxUploadBytes, deps.boundary.limits.upload.idleMs),
        { signal },
      );
    } catch (error) {
      return { ok: false, failure: failureFromError(error) };
    }
    // A request abandoned at the deadline releases its body here; once read
    // succeeds the boundary's dispose does the same, and cancel is idempotent.
    signal.addEventListener(
      'abort',
      () => {
        detach(reader.cancel(), escalate);
      },
      { once: true },
    );
    let token: string | undefined;
    try {
      token = await readSnapshotWithin(reader, UPLOAD_SNAPSHOT_TIMEOUT_MS);
    } catch (error) {
      await reader.cancel();
      return { ok: false, failure: failureFromError(error) };
    }
    if (token === undefined) {
      await reader.cancel();
      return {
        ok: false,
        failure: toFailure('invalid_request', 'Upload snapshot was not received in time'),
      };
    }
    return { ok: true, token, input: { reader } };
  }
  /** Store the authorized request's file and answer its signed reference. */
  async function storeUpload(
    authorized: AuthorizedComponentRequest<'snapshot', UploadInput>,
  ): Promise<Response> {
    const uploads = deps.uploads;
    if (uploads === undefined) {
      return uploadFailure('unavailable', 'Uploads are not configured');
    }
    const { reader } = authorized.input;
    const snapshot = authorized.credential;
    const policy = authorized.component.uploads;
    if (policy === undefined) {
      return uploadFailure('forbidden', 'Component does not accept uploads');
    }
    const anonymousQuota = snapshot.subject === null ? policy.anonymous : undefined;
    if (snapshot.subject === null && anonymousQuota === undefined) {
      return uploadFailure('forbidden', 'Component does not accept anonymous uploads');
    }

    let anonymous:
      { readonly key: string; ledger: AnonymousLedger; counted: { bytes: number } } | undefined;
    try {
      if (anonymousQuota !== undefined) {
        const key = authorized.componentId;
        const held = anonymousInFlight.get(key) ?? 0;
        if (held >= (anonymousQuota.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_ANONYMOUS_UPLOADS)) {
          return uploadFailure('unavailable', 'Too many uploads in progress');
        }
        const ledger = anonymousLedger(key);
        // Uploads in progress count as files about to be committed.
        if (ledger.committed.length + held >= anonymousQuota.maxFiles) {
          return uploadFailure('too_large', 'Upload quota exceeded');
        }
        anonymousInFlight.set(key, held + 1);
        anonymous = { key, ledger, counted: { bytes: 0 } };
      }

      const file = await openFile(reader);
      if (file === undefined) {
        return uploadFailure('invalid_request', 'Upload is missing a file');
      }
      const contentType = file.contentType.toLowerCase();
      if (
        !deps.uploadContentTypes.has(contentType) ||
        (policy.contentTypes !== undefined &&
          !policy.contentTypes.some((allowed) => allowed.toLowerCase() === contentType))
      ) {
        return uploadFailure('unsupported_content_type', 'Unsupported content type');
      }

      let store: UploadStore;
      try {
        store = resolveStore(authorized.context.storagePath);
      } catch {
        return uploadFailure('unavailable', 'Upload storage is unavailable');
      }

      const source = uploadStream(file.stream);
      const capped =
        policy.maxBytes !== undefined && policy.maxBytes < deps.maxUploadBytes
          ? capStream(source, policy.maxBytes)
          : source;
      const stream =
        anonymous === undefined || anonymousQuota === undefined
          ? capped
          : meterAnonymous(capped, anonymous.ledger, anonymousQuota, anonymous.counted);
      const id = generateComponentId();
      const { size } = await store.put({ id, subject: snapshot.subject, contentType, stream });

      try {
        const reference = uploads.signer.sign({
          uploadId: id,
          component: authorized.componentId,
          subject: snapshot.subject,
          size,
          contentType,
        });
        // Charged only once a reference exists: a file deleted because signing
        // failed can never be named, so it must not hold the anonymous quota.
        anonymous?.ledger.committed.push({ at: now(), bytes: size });
        return jsonResponse(201, { reference });
      } catch (error) {
        authorized.report(error);
        // Best-effort removal of the stored file: the request already failed
        // and answers internal_error whether or not the delete succeeds.
        await store.delete(id, snapshot.subject).catch(() => undefined);
        return uploadFailure('internal_error', 'Internal Server Error');
      }
    } catch (error) {
      if (error instanceof UploadError) {
        const result = uploadErrorFromStoreError(error);
        return jsonResponse(result.status, result.body);
      }
      throw error;
    } finally {
      if (anonymous !== undefined) {
        anonymous.ledger.streamingBytes -= anonymous.counted.bytes;
        const remaining = (anonymousInFlight.get(anonymous.key) ?? 1) - 1;
        if (remaining <= 0) {
          anonymousInFlight.delete(anonymous.key);
        } else {
          anonymousInFlight.set(anonymous.key, remaining);
        }
      }
    }
  }

  const route = componentRoute<'snapshot', UploadInput>(
    {
      credential: 'snapshot',
      lane: 'upload',
      read: readUpload,
      dispose: (input) => input.reader.cancel(),
      handle: storeUpload,
    },
    deps.boundary,
  );

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

  return { route, bodyBytes: uploadBodyBytes(deps.maxUploadBytes), resolveUpload };
}
