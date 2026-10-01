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
 * endpoint for legitimate uploads. An authorized client is held to the same
 * discipline once it has a slot: the file part must keep arriving (an idle
 * timeout) and finish within a total deadline, or the stream is destroyed and
 * the slot released, and one subject may hold only a few slots at once, so a
 * single session cannot occupy the whole runtime cap.
 *
 * Anonymous uploads are refused unless the component opts in with its own
 * `uploads.anonymous` quota. Every anonymous visitor shares one subject, so
 * without a quota of its own one visitor could exhaust the shared anonymous
 * scope (and the slots) for every component that accepts files.
 */

import { Readable } from 'node:stream';

import type { RequestContext } from '../../contracts/http.js';
import { isSameOriginRequest } from '../../security/trusted-mutation.js';
import type { ServerComponentAnonymousUploads, ServerComponentDefinition } from '../component.js';
import type { ComponentSigner } from '../snapshot.js';
import { DEFAULT_UPLOAD_REFERENCE_TTL_MS, UploadError } from '../uploads.js';
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
import { detach, escalate } from '../../support/detach.js';

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
  /** Authorized uploads one subject may have in progress at once. */
  readonly maxConcurrentPerSubject: number;
  /** Milliseconds the file part may go without delivering a byte. */
  readonly idleTimeoutMs: number;
  /** Milliseconds the file part may take in total, from its authorization. */
  readonly timeoutMs: number;
  /** Time source returning epoch milliseconds, for the anonymous quota window. */
  readonly now?: () => number;
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

/** Default cap on uploads one subject has in progress at once. */
export const DEFAULT_MAX_CONCURRENT_UPLOADS_PER_SUBJECT = 2;

/** Default time the file part may go without delivering a byte. */
export const DEFAULT_UPLOAD_IDLE_TIMEOUT_MS = 30_000;

/** Default total time the file part may take once authorized. */
export const DEFAULT_UPLOAD_TIMEOUT_MS: number = 5 * 60_000;

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

/**
 * Fail the file stream when it goes `idleMs` without a chunk or runs past
 * `deadline` (epoch ms). `release` is called on a timeout so the body read the
 * stream is blocked on settles; without it the source could never be
 * destroyed, and the slot it holds never freed.
 */
function guardStream(
  stream: Readable,
  idleMs: number,
  deadline: number,
  now: () => number,
  release: () => void,
): Readable {
  async function* guarded(): AsyncGenerator<Buffer> {
    const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<unknown>;
    try {
      for (;;) {
        const next = iterator.next();
        // A read abandoned on timeout still settles (with the body's own error
        // once it is released); absorb it so it never goes unhandled.
        next.catch(() => undefined);
        const result = await settleWithin(next, Math.min(idleMs, deadline - now()));
        if (result === undefined) {
          release();
          throw uploadTimedOut();
        }
        if (result.done === true) {
          return;
        }
        const chunk: unknown = result.value;
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      }
    } finally {
      stream.destroy();
    }
  }
  return Readable.from(guarded(), { objectMode: false });
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
  reader: MultipartUploadReader,
  timeoutMs: number,
): Promise<string | undefined> {
  const reading = reader.readSnapshot();
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

export function createUploadTransport(deps: UploadTransportDeps): UploadTransport {
  const now = deps.now ?? Date.now;
  let inFlight = 0;
  /** Slots held per subject tag (anonymous uploads are keyed by their component). */
  const inFlightBySubject = new Map<string, number>();
  const anonymousLedgers = new Map<string, AnonymousLedger>();

  function resolveStore(storagePath: string | undefined): UploadStore {
    return resolveUploadStore(deps.uploads?.store, storagePath);
  }

  /** Take one slot for `key` unless it already holds `limit`; returns whether it did. */
  function takeSubjectSlot(key: string, limit: number): boolean {
    const held = inFlightBySubject.get(key) ?? 0;
    if (held >= limit) {
      return false;
    }
    inFlightBySubject.set(key, held + 1);
    return true;
  }

  function releaseSubjectSlot(key: string): void {
    const held = (inFlightBySubject.get(key) ?? 1) - 1;
    if (held <= 0) {
      inFlightBySubject.delete(key);
    } else {
      inFlightBySubject.set(key, held);
    }
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
    let subjectKey: string | undefined;
    let anonymous: { ledger: AnonymousLedger; counted: { bytes: number } } | undefined;
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
      const anonymousQuota = snapshot.subject === null ? policy.anonymous : undefined;
      if (snapshot.subject === null && anonymousQuota === undefined) {
        return uploadErrorResult('forbidden', 'Component does not accept anonymous uploads');
      }
      if (inFlight >= deps.maxConcurrentUploads) {
        return uploadErrorResult('unavailable', 'Too many uploads in progress');
      }
      const key =
        snapshot.subject === null
          ? `anonymous\u0000${snapshot.component}`
          : `subject\u0000${snapshot.subject}`;
      const subjectLimit =
        anonymousQuota === undefined
          ? deps.maxConcurrentPerSubject
          : (anonymousQuota.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_ANONYMOUS_UPLOADS);
      if (!takeSubjectSlot(key, subjectLimit)) {
        return uploadErrorResult('unavailable', 'Too many uploads in progress');
      }
      subjectKey = key;
      inFlight += 1;
      holdsSlot = true;

      if (anonymousQuota !== undefined) {
        const ledger = anonymousLedger(snapshot.component);
        // Uploads in progress hold this component's anonymous slots, so they
        // count as files about to be committed.
        const pendingFiles = (inFlightBySubject.get(key) ?? 1) - 1;
        if (ledger.committed.length + pendingFiles >= anonymousQuota.maxFiles) {
          return uploadErrorResult('too_large', 'Upload quota exceeded');
        }
        anonymous = { ledger, counted: { bytes: 0 } };
      }

      const fileDeadline = now() + deps.timeoutMs;
      const activeReader = reader;
      const release = (): void => {
        detach(activeReader.cancel(), escalate);
      };
      const opened = reader.openFile();
      // Marked handled: settleWithin observes it inside the bound; past it
      // release() cancels the reader, which settles the abandoned open.
      opened.catch(() => undefined);
      const settled = await settleWithin(
        opened.then((part) => ({ part })),
        Math.min(deps.idleTimeoutMs, deps.timeoutMs),
      );
      if (settled === undefined) {
        release();
        return uploadErrorResult('invalid_request', 'Upload did not arrive in time');
      }
      const file: MultipartFilePart | undefined = settled.part;
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

      const guarded = guardStream(file.stream, deps.idleTimeoutMs, fileDeadline, now, release);
      const capped =
        policy.maxBytes !== undefined && policy.maxBytes < deps.maxUploadBytes
          ? capStream(guarded, policy.maxBytes)
          : guarded;
      const stream =
        anonymous === undefined || anonymousQuota === undefined
          ? capped
          : meterAnonymous(capped, anonymous.ledger, anonymousQuota, anonymous.counted);
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
        // Charged only once a reference exists: a file deleted because signing
        // failed can never be named, so it must not hold the anonymous quota.
        if (anonymous !== undefined) {
          anonymous.ledger.committed.push({ at: now(), bytes: size });
        }
        return { status: 201, body: { reference } };
      } catch {
        // Best-effort removal of the stored file: the request already failed
        // and answers internal_error whether or not the delete succeeds.
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
      if (subjectKey !== undefined) {
        releaseSubjectSlot(subjectKey);
      }
      if (anonymous !== undefined) {
        anonymous.ledger.streamingBytes -= anonymous.counted.bytes;
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
