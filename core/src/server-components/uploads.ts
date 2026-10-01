/**
 * Server-side uploads for stateful server components (server-only).
 *
 * The storage-and-reference half of server-component file uploads (the
 * runtime's upload transport is the HTTP half). It provides three pieces, all
 * server-only (it imports `node:crypto`, `node:fs`, and `node:stream`):
 *
 * - {@link UploadStore} + {@link DiskUploadStore}: a subject-scoped,
 *   disk-backed store. Files are laid out under
 *   `<rootDir>/<sha256(subject)>/<id>` and written atomically (temp file then
 *   rename). Every write is streamed through a size limiter, every path
 *   segment is validated, each subject (and the shared anonymous scope) has a
 *   byte and file-count quota, and uploads older than the retention window are
 *   swept, so a hostile id/subject can never traverse the filesystem and
 *   neither abandoned nor hostile uploads can fill the disk. The store is a
 *   staging area: an action that keeps an upload copies it to permanent
 *   storage before the retention window ends.
 * - {@link UploadReferenceSigner} + {@link createUploadReferenceSigner}: a
 *   signed reference token (`base64url(json).sig`) binding an upload id to its
 *   component, subject tag, expiry, measured size, and content type. It is
 *   integrity protection, not encryption; the same master key as the snapshot
 *   signer is reused with a distinct HMAC domain, so a reference can never be
 *   forged from a snapshot signature (or vice versa).
 * - {@link uploadRefSchema}: the Zod shape an upload reference occupies in a
 *   component's `stateSchema` (`{ __upload: string }`). The request body is
 *   parsed incrementally by the runtime's upload transport.
 *
 * Nothing here trusts client-claimed metadata: the size in a reference is the
 * number of bytes actually written to disk, the content type is validated
 * against an allowlist, and the subject tag is derived from the verified
 * snapshot (never the client). Errors are value-free and never echo a path,
 * key, id, or underlying filesystem cause.
 */

import {
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { z } from 'zod';

import { Encoding } from '../support/encoding.js';
import { hashSync } from '../support/cryptography.server.js';

import { isErrno } from '../errors/inspect.js';
import { UPLOAD_REFERENCE_KEY, type UploadReference } from './protocol.js';
import {
  CONTENT_TYPE_PATTERN,
  SAFE_SEGMENT_PATTERN,
  createReferenceSigner,
  validateReferenceComponent,
  validateReferenceContentType,
  validateReferenceSegment,
  validateReferenceSubject,
} from './reference-token.js';
import { JsailsError } from '../errors/jsails-error.js';

/** Raised for every upload failure. `code` is a stable machine value; messages are value-free. */
export class UploadError extends JsailsError {
  constructor(
    readonly code: UploadErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Stable machine codes carried on an {@link UploadError}. */
export type UploadErrorCode =
  | 'invalid_reference'
  | 'too_large'
  | 'unsupported_content_type'
  | 'not_found'
  | 'invalid_input'
  | 'io_failed'
  | 'quota_exceeded'
  | 'unavailable';

/** Default per-upload byte cap (10 MiB). */
export const DEFAULT_UPLOAD_MAX_BYTES: number = 10 * 1024 * 1024;

/** Default content-type allowlist: raster images plus PDF (SVG is deliberately excluded). */
export const DEFAULT_UPLOAD_CONTENT_TYPES: readonly string[] = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
]);

/**
 * Default lifetime of a signed upload reference, and the floor for a store's
 * retention: a shorter retention would delete files that still-valid
 * references name.
 */
export const DEFAULT_UPLOAD_REFERENCE_TTL_MS: number = 60 * 60 * 1000; // 1 hour

/**
 * Default retention of a staged upload: the reference lifetime plus a margin
 * for an action that resolved the reference just before it expired. Past it no
 * reference can name the file any more, so it is garbage.
 */
export const DEFAULT_UPLOAD_RETENTION_MS: number = DEFAULT_UPLOAD_REFERENCE_TTL_MS + 15 * 60 * 1000;
/** Default byte quota per subject directory (the anonymous scope is one subject). */
export const DEFAULT_UPLOAD_SUBJECT_QUOTA_BYTES: number = 100 * 1024 * 1024;
/** Default file-count quota per subject directory. */
export const DEFAULT_UPLOAD_SUBJECT_MAX_FILES = 100;
/** Default minimum interval between opportunistic sweeps of the whole store. */
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Upper bound on a serialized reference token, in bytes (claims are tiny). */
const MAX_REFERENCE_BYTES = 8 * 1024;

/** Upper bound on a reference token string length accepted by {@link uploadRefSchema}. */
const MAX_UPLOAD_REFERENCE_LENGTH = 4096;

/** HMAC key-derivation domain separating upload references from snapshots. */
const REFERENCE_KEY_CONTEXT = 'jsails.upload.reference.v1';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Input to {@link UploadStore.put}. */
interface UploadStorePutInput {
  readonly id: string;
  readonly subject: string | null;
  readonly contentType: string;
  readonly stream: Readable;
}

/**
 * A subject-scoped upload store. Opaque ids are server-generated; every method
 * is scoped by the derived subject tag so one subject can never read another's
 * uploads. Implementations own their persistence and path safety.
 */
export interface UploadStore {
  /** Stream an upload to storage, returning its measured size. */
  put(input: UploadStorePutInput): Promise<{ size: number }>;
  /** Open a read stream over a stored upload, or `null` when absent. */
  open(id: string, subject: string | null): Promise<Readable | null>;
  /** Delete a stored upload. Absent is a no-op. */
  delete(id: string, subject: string | null): Promise<void>;
}

/** Options for {@link DiskUploadStore}. */
interface DiskUploadStoreOptions {
  /** Absolute directory under which uploads are stored. Created lazily. */
  readonly rootDir: string;
  /** Hard byte cap enforced during streaming. Defaults to {@link DEFAULT_UPLOAD_MAX_BYTES}. */
  readonly maxBytes?: number;
  /** Content-type allowlist. Defaults to {@link DEFAULT_UPLOAD_CONTENT_TYPES}. */
  readonly contentTypes?: readonly string[];
  /**
   * Age after which a stored upload is deleted by the sweep. Defaults to
   * {@link DEFAULT_UPLOAD_RETENTION_MS} (the reference lifetime plus a margin)
   * and may not be shorter than the reference lifetime
   * ({@link DEFAULT_UPLOAD_REFERENCE_TTL_MS}), or the sweep would delete files a
   * still-valid reference names.
   */
  readonly retentionMs?: number;
  /**
   * Byte quota per subject directory, counting unexpired uploads. All anonymous
   * uploads share one directory and therefore one quota. Defaults to
   * {@link DEFAULT_UPLOAD_SUBJECT_QUOTA_BYTES}.
   */
  readonly maxBytesPerSubject?: number;
  /** File-count quota per subject directory. Defaults to {@link DEFAULT_UPLOAD_SUBJECT_MAX_FILES}. */
  readonly maxFilesPerSubject?: number;
  /**
   * Minimum interval between the whole-store sweeps a `put` starts in the
   * background. Defaults to 10 minutes; {@link DiskUploadStore.sweep} can also
   * be called directly (for example from a scheduled job).
   */
  readonly sweepIntervalMs?: number;
  /** Time source returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

function positiveIntegerOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function assertSafeSegment(value: string, what: string): void {
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new UploadError('invalid_input', `Invalid upload ${what}`);
  }
}

function subjectDirFor(subject: string | null): string {
  if (subject === null) return 'anonymous';
  assertSafeSegment(subject, 'subject');
  return hashSync('SHA-256', subject);
}

/**
 * In-process bookkeeping for one subject directory while at least one `put`
 * for it is running. A quota check compares a directory scan, which is stale
 * the moment it returns, against the limit, so concurrent puts would each pass
 * it. The scan-and-reserve step is therefore serialized per subject (`gate`),
 * and the ledger adds what the scan cannot see: writes still streaming, file
 * slots reserved by puts that passed the check, and writes committed since a
 * put's scan began.
 */
interface SubjectLedger {
  /** Puts currently running for the subject; the ledger is dropped at zero. */
  active: number;
  /** Tail of the serialized scan-and-reserve steps. */
  gate: Promise<void>;
  /** Bytes streamed by puts that have not committed yet. */
  streamingBytes: number;
  /** File slots reserved by puts that have not committed yet. */
  reservedFiles: number;
  /** Bytes committed (renamed into place) since the ledger was created. */
  committedBytes: number;
  /** Files committed since the ledger was created. */
  committedFiles: number;
}

/** Usage of one subject directory after its expired entries were removed. */
interface SubjectUsage {
  /** Bytes of unexpired uploads. */
  readonly bytes: number;
  /** Unexpired uploads. */
  readonly files: number;
  /** Entries (uploads, temp files) left in the directory. */
  readonly entries: number;
  /** Expired entries deleted by this scan. */
  readonly removed: number;
}

/**
 * Create the subject directory and exclusively create the temp file in it.
 * A sweep removes subject directories it finds empty, so the directory can
 * vanish between `mkdir` and `open`; once the temp file exists the directory
 * is no longer empty and stays, so a retry after ENOENT is enough.
 */
async function openTempFile(dir: string, temp: string): Promise<FileHandle> {
  for (let attempt = 0; ; attempt += 1) {
    await mkdir(dir, { recursive: true });
    try {
      return await open(temp, 'wx');
    } catch (error) {
      if (!isErrno(error, 'ENOENT') || attempt >= 2) throw error;
    }
  }
}

/** True for the hidden temp file an in-progress write streams into. */
function isTempName(name: string): boolean {
  return name.startsWith('.') && name.endsWith('.tmp');
}

/**
 * A disk-backed upload store. `rootDir` holds one directory per subject (named
 * by `sha256(subject)`); each upload is written to a sibling temp file then
 * renamed into place atomically, so a failed or aborted write never leaves a
 * partial file visible. The byte cap is enforced during streaming, every
 * id/subject is validated against a safe charset before it touches a path, a
 * write that would take its subject past the byte or file quota is refused,
 * and files older than `retentionMs` are deleted — by a background sweep a
 * `put` starts at most once per `sweepIntervalMs`, by the quota scan of the
 * subject being written, or by an explicit {@link sweep}.
 */
export class DiskUploadStore implements UploadStore {
  readonly #rootDir: string;
  readonly #maxBytes: number;
  readonly #contentTypes: Set<string>;
  readonly #retentionMs: number;
  readonly #maxBytesPerSubject: number;
  readonly #maxFilesPerSubject: number;
  readonly #sweepIntervalMs: number;
  readonly #now: () => number;
  /** Per-subject quota ledger for running puts, so concurrent puts share the quota. */
  readonly #ledgers = new Map<string, SubjectLedger>();
  #lastSweepAt: number | undefined;

  constructor(options: DiskUploadStoreOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('DiskUploadStore requires an options object');
    }
    const rootDir = options.rootDir;
    if (typeof rootDir !== 'string' || rootDir === '') {
      throw new TypeError('rootDir must be a non-empty string');
    }
    this.#rootDir = rootDir;
    this.#maxBytes = positiveIntegerOption(options.maxBytes, DEFAULT_UPLOAD_MAX_BYTES, 'maxBytes');
    this.#contentTypes = normalizeContentTypes(
      options.contentTypes ?? DEFAULT_UPLOAD_CONTENT_TYPES,
    );
    this.#retentionMs = positiveIntegerOption(
      options.retentionMs,
      DEFAULT_UPLOAD_RETENTION_MS,
      'retentionMs',
    );
    if (this.#retentionMs < DEFAULT_UPLOAD_REFERENCE_TTL_MS) {
      throw new TypeError('retentionMs must not be shorter than the upload reference lifetime');
    }
    this.#maxBytesPerSubject = positiveIntegerOption(
      options.maxBytesPerSubject,
      DEFAULT_UPLOAD_SUBJECT_QUOTA_BYTES,
      'maxBytesPerSubject',
    );
    this.#maxFilesPerSubject = positiveIntegerOption(
      options.maxFilesPerSubject,
      DEFAULT_UPLOAD_SUBJECT_MAX_FILES,
      'maxFilesPerSubject',
    );
    this.#sweepIntervalMs = positiveIntegerOption(
      options.sweepIntervalMs,
      DEFAULT_SWEEP_INTERVAL_MS,
      'sweepIntervalMs',
    );
    this.#now = options.now ?? Date.now;
  }

  #assertContentType(contentType: string): void {
    if (typeof contentType !== 'string' || !CONTENT_TYPE_PATTERN.test(contentType)) {
      throw new UploadError('unsupported_content_type', 'Unsupported content type');
    }
    if (!this.#contentTypes.has(contentType.toLowerCase())) {
      throw new UploadError('unsupported_content_type', 'Unsupported content type');
    }
  }

  async put(input: UploadStorePutInput): Promise<{ size: number }> {
    assertSafeSegment(input.id, 'id');
    const subjectDir = subjectDirFor(input.subject);
    this.#assertContentType(input.contentType);
    this.#maybeSweep();

    const ledger = this.#ledgerFor(subjectDir);
    ledger.active += 1;
    const dir = join(this.#rootDir, subjectDir);
    let reserved = false;
    let bytes = 0;
    try {
      // The committed counters are read before the scan, so a put that
      // commits while this one scans is counted (possibly twice, which only
      // errs toward refusing).
      let baseBytes = 0;
      let usage: SubjectUsage = { bytes: 0, files: 0, entries: 0, removed: 0 };
      const step = ledger.gate.then(async () => {
        baseBytes = ledger.committedBytes;
        const baseFiles = ledger.committedFiles;
        try {
          usage = await this.#scanSubject(dir);
        } catch {
          throw new UploadError('io_failed', 'upload could not be stored');
        }
        const files = usage.files + (ledger.committedFiles - baseFiles) + ledger.reservedFiles;
        if (files >= this.#maxFilesPerSubject) {
          throw new UploadError('quota_exceeded', 'upload quota exceeded');
        }
        ledger.reservedFiles += 1;
        reserved = true;
      });
      ledger.gate = step.catch(() => undefined);
      await step;
      const target = join(dir, input.id);
      const temp = join(dir, `.${input.id}.${Encoding.hex(Encoding.randomBytes(8))}.tmp`);

      const maxBytes = this.#maxBytes;
      const quota = this.#maxBytesPerSubject;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
          bytes += chunk.length;
          ledger.streamingBytes += chunk.length;
          if (bytes > maxBytes) {
            callback(new UploadError('too_large', 'upload exceeds the maximum size'));
            return;
          }
          if (usage.bytes + (ledger.committedBytes - baseBytes) + ledger.streamingBytes > quota) {
            callback(new UploadError('quota_exceeded', 'upload quota exceeded'));
            return;
          }
          callback(null, chunk);
        },
      });

      try {
        const handle = await openTempFile(dir, temp);
        await pipeline(input.stream, limiter, handle.createWriteStream());
        await rename(temp, target);
      } catch (error) {
        // The temp file may never have been created; the failure that brought
        // us here is what the caller gets.
        await unlink(temp).catch(() => undefined);
        if (error instanceof UploadError) throw error;
        throw new UploadError('io_failed', 'upload could not be stored');
      }
      ledger.committedBytes += bytes;
      ledger.committedFiles += 1;
      return { size: bytes };
    } finally {
      ledger.streamingBytes -= bytes;
      if (reserved) {
        ledger.reservedFiles -= 1;
      }
      ledger.active -= 1;
      if (ledger.active === 0) {
        this.#ledgers.delete(subjectDir);
      }
    }
  }

  #ledgerFor(subjectDir: string): SubjectLedger {
    let ledger = this.#ledgers.get(subjectDir);
    if (ledger === undefined) {
      ledger = {
        active: 0,
        gate: Promise.resolve(),
        streamingBytes: 0,
        reservedFiles: 0,
        committedBytes: 0,
        committedFiles: 0,
      };
      this.#ledgers.set(subjectDir, ledger);
    }
    return ledger;
  }

  async open(id: string, subject: string | null): Promise<Readable | null> {
    assertSafeSegment(id, 'id');
    const file = join(this.#rootDir, subjectDirFor(subject), id);
    // Open the descriptor here rather than handing back a path-based stream. A
    // stream from `createReadStream(path)` opens on a later tick, so a file
    // removed in between (a retention sweep, a concurrent `delete`) would emit
    // ENOENT from a stream nobody listens to yet and crash the process. With
    // the handle already open, absence is answered here, and the stream reads
    // from the open descriptor even if the file is unlinked afterwards. The
    // stream closes the handle when it ends or is destroyed.
    let handle: FileHandle;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw new UploadError('io_failed', 'upload could not be opened');
    }
    return handle.createReadStream();
  }

  async delete(id: string, subject: string | null): Promise<void> {
    assertSafeSegment(id, 'id');
    const file = join(this.#rootDir, subjectDirFor(subject), id);
    try {
      await unlink(file);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw new UploadError('io_failed', 'upload could not be deleted');
    }
  }

  /**
   * Delete every upload (and abandoned temp file) older than the retention
   * window across all subjects, and remove subject directories left empty.
   * Returns the number of files removed. Safe to run concurrently with writes:
   * a file being written is younger than the window.
   */
  async sweep(): Promise<{ removed: number }> {
    this.#lastSweepAt = this.#now();
    let subjects: string[];
    try {
      subjects = await readdir(this.#rootDir);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { removed: 0 };
      throw new UploadError('io_failed', 'upload store could not be swept');
    }
    let removed = 0;
    for (const subject of subjects) {
      const dir = join(this.#rootDir, subject);
      try {
        const usage = await this.#scanSubject(dir);
        removed += usage.removed;
        if (usage.entries === 0) {
          // A concurrent put may have just recreated the directory's first
          // file; rmdir then fails with ENOTEMPTY and the directory stays.
          await rmdir(dir).catch(() => undefined);
        }
      } catch {
        // One unreadable subject must not stop the sweep of the others.
      }
    }
    return { removed };
  }

  /** Start a background sweep when the last one is older than the interval. */
  #maybeSweep(): void {
    const now = this.#now();
    if (this.#lastSweepAt !== undefined && now - this.#lastSweepAt < this.#sweepIntervalMs) {
      return;
    }
    this.#lastSweepAt = now;
    // A failed background sweep is retried after the next interval; a caller
    // that needs its error calls sweep() directly.
    this.sweep().catch(() => undefined);
  }

  /**
   * Measure one subject directory, deleting expired entries on the way, so the
   * quota counts only uploads a reference can still name.
   */
  async #scanSubject(dir: string): Promise<SubjectUsage> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
        return { bytes: 0, files: 0, entries: 0, removed: 0 };
      }
      throw error;
    }
    const cutoff = this.#now() - this.#retentionMs;
    let bytes = 0;
    let files = 0;
    let entries = 0;
    let removed = 0;
    for (const name of names) {
      const file = join(dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      if (info.mtimeMs < cutoff) {
        try {
          await unlink(file);
          removed += 1;
          continue;
        } catch {
          // Already gone, or not removable: count it as still present.
        }
      }
      entries += 1;
      if (!isTempName(name)) {
        bytes += info.size;
        files += 1;
      }
    }
    return { bytes, files, entries, removed };
  }
}

/** Normalize an allowlist to a set of lowercase media types, rejecting empties. */
function normalizeContentTypes(contentTypes: readonly string[]): Set<string> {
  if (!Array.isArray(contentTypes) || contentTypes.length === 0) {
    throw new TypeError('contentTypes must be a non-empty array of media types');
  }
  const normalized = new Set<string>();
  for (const contentType of contentTypes) {
    if (typeof contentType !== 'string' || !CONTENT_TYPE_PATTERN.test(contentType)) {
      throw new TypeError('contentTypes entries must be valid media types');
    }
    normalized.add(contentType.toLowerCase());
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Signed upload references
// ---------------------------------------------------------------------------

/** Verified claims carried in a signed upload reference. */
export interface UploadReferenceClaims {
  readonly v: 1;
  readonly uploadId: string;
  readonly component: string;
  readonly subject: string | null;
  readonly expiresAt: number;
  readonly size: number;
  readonly contentType: string;
}

/** Everything a caller supplies to `sign`; `v` and `expiresAt` are computed. */
type UploadReferenceClaimsInput = Omit<UploadReferenceClaims, 'v' | 'expiresAt'>;

/** A configured upload-reference signer: signs and verifies reference tokens. */
export interface UploadReferenceSigner {
  sign(claims: UploadReferenceClaimsInput): string;
  verify(token: string): UploadReferenceClaims;
}

/** Options for {@link createUploadReferenceSigner}. */
interface UploadReferenceSignerOptions {
  /** Master signing key (>= 32 bytes). Shared with the snapshot signer. */
  readonly key: string | Uint8Array;
  /**
   * Retired master keys accepted by `verify` only, so references minted before
   * a key rotation stay valid until they expire.
   */
  readonly previousKeys?: readonly (string | Uint8Array)[];
  /** Time source returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Reference lifetime in milliseconds. Must be a positive finite number. */
  readonly ttlMs?: number;
  /** Milliseconds a reference stays valid past its expiry, for clock skew. Defaults to 0. */
  readonly clockToleranceMs?: number;
}

function validateSize(value: unknown, fail: () => never): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail();
  }
  return value;
}

/**
 * Create an upload-reference signer over a master key. The key is required and
 * must be at least 32 bytes; `ttlMs` bounds the reference lifetime. Returns a
 * frozen handle exposing {@link UploadReferenceSigner.sign} and `verify`. The
 * HMAC domain is separated from the snapshot signer's, so a reference can never
 * be forged from a snapshot signature (or vice versa) without the master key.
 */
export function createUploadReferenceSigner(
  options: UploadReferenceSignerOptions,
): UploadReferenceSigner {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createUploadReferenceSigner requires an options object');
  }
  return createReferenceSigner<UploadReferenceClaimsInput>({
    key: options.key,
    ...(options.previousKeys === undefined ? {} : { previousKeys: options.previousKeys }),
    now: options.now,
    ttlMs: options.ttlMs ?? DEFAULT_UPLOAD_REFERENCE_TTL_MS,
    ...(options.clockToleranceMs === undefined
      ? {}
      : { clockToleranceMs: options.clockToleranceMs }),
    context: REFERENCE_KEY_CONTEXT,
    maxPayloadBytes: MAX_REFERENCE_BYTES,
    label: 'Upload',
    claims: {
      uploadId: validateReferenceSegment,
      component: validateReferenceComponent,
      subject: validateReferenceSubject,
      size: validateSize,
      contentType: validateReferenceContentType,
    },
    makeError: (failure, message) => new UploadError(failure, message),
  });
}

// ---------------------------------------------------------------------------
// Reference schema (the state shape an upload field occupies)
// ---------------------------------------------------------------------------

/**
 * The Zod schema an upload reference occupies in a component `stateSchema`:
 * `{ __upload: string }`, `.strict()`. Use it on a field that holds a signed
 * upload reference (e.g. `avatar: uploadRefSchema()`); the runtime never parses
 * this schema itself — it is the author's declaration of the state shape.
 */
export function uploadRefSchema(): z.ZodType<UploadReference> {
  return z
    .object({ [UPLOAD_REFERENCE_KEY]: z.string().min(1).max(MAX_UPLOAD_REFERENCE_LENGTH) })
    .strict();
}
