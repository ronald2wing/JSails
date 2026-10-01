/**
 * S3 disk: a {@link Disk} and {@link DiskUrlSigner} backed by AWS S3 or an
 * S3-compatible store, over the `@aws-sdk/client-s3` commands.
 *
 * Construction takes the S3 coordinates (`bucket`, `region`, optional
 * `credentials`, `endpoint`, `forcePathStyle`, `prefix`) and builds a client
 * with connection and request timeouts (5 s and 30 s by default); tests inject
 * a `client` with a per-command `send` instead. A `prefix` is joined onto
 * every object key and stripped from listed keys, so callers only see disk keys.
 *
 * - **Writes stream in parts.** The bytes fill one buffer of `partSize`
 *   (8 MiB by default, at least the 5 MiB S3 requires). A write that fits in
 *   one buffer is a single `PutObject`; a larger one becomes a multipart
 *   upload, each full buffer sent as `UploadPart` before more of the source is
 *   read, so at most one part is held in memory whatever the size. A failure,
 *   an abort or `maxBytes` aborts the multipart upload, so nothing is left in
 *   the bucket, billed or visible.
 * - **`ifAbsent`** sends `If-None-Match: *` on the `PutObject` or the
 *   `CompleteMultipartUpload`; the store refuses with 412 when the key is
 *   taken, which is `disk.conflict` even against a racing writer. A store
 *   that does not implement the header answers 501, which is
 *   `disk.unsupported`: it is never emulated with a racy check. A store that
 *   ignores the header and overwrites (SeaweedFS) cannot be told apart from
 *   a store that honours it, so such a store is declared with
 *   `conditionalWrites: false`, and `ifAbsent` then refuses up front with
 *   `disk.unsupported`.
 * - **Reads** are one `GetObject`, with a `Range` header for a range; a 416
 *   is `disk.invalid_range`. `NoSuchKey` is `disk.not_found`; `NoSuchBucket`
 *   is `disk.io_failed`, so a misconfigured bucket never reads as empty. The
 *   `Content-Range` a store answers with is checked against the request: a
 *   range starting at or past the end is `disk.invalid_range` even from a
 *   store that answers it with a 206, and any other mismatch is
 *   `disk.io_failed`.
 * - **Listing** pages with the store's continuation token, wrapped in a
 *   cursor the disk can check, so a cursor it did not issue is
 *   `disk.invalid_cursor` on every store. Keys come back in the store's
 *   order: UTF-8 byte order on AWS S3, R2 and MinIO; SeaweedFS lists a
 *   directory's keys before a sibling that sorts ahead of `/` (`a/1` before
 *   `a-x`).
 * - **`stat`** is a `HeadObject`. A `HEAD` 404 cannot say whether the key or
 *   the bucket is missing, so a miss is confirmed with `HeadBucket` before it
 *   is reported as `null`.
 * - **`signedUrl`** presigns a `GetObject` locally (no network call) with the
 *   lifetime and the response `Content-Disposition` and `Content-Type` signed
 *   in. It needs a real `S3Client`; a disk around a bare `send` double refuses
 *   with `disk.unsupported`.
 *
 * Supported stores: AWS S3, Cloudflare R2, MinIO and SeaweedFS for every
 * method; `ifAbsent` additionally needs conditional writes (AWS S3 since
 * 2024, R2, recent MinIO). SeaweedFS ignores `If-None-Match`, so a disk on it
 * sets `conditionalWrites: false`.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type _Object,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assertDiskKey,
  assertDiskPrefix,
  assertRangeShape,
  DiskErrors,
  isDiskKey,
  meterByteSource,
  resolveDiskRange,
  throwIfDiskAborted,
  type ByteSource,
  type Disk,
  type DiskListOptions,
  type DiskListPage,
  type DiskObject,
  type DiskRange,
  type DiskReadOptions,
  type DiskStat,
  type DiskWriteOptions,
  type DiskWriteResult,
  type DiskSignedUrlOptions,
  type DiskUrlSigner,
  type DiskOperation,
} from 'jsails/filesystem';

import {
  assertListOptions,
  assertReadSignal,
  assertWriteOptions,
  diskIoError,
  isOptionsObject,
  positiveIntegerOption,
  resolveSignedUrlOptions,
} from './disk-validation.js';

const MIB = 1024 * 1024;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PART_SIZE = 8 * MIB;
/** The smallest part S3 accepts for every part of a multipart upload but the last. */
const MIN_PART_SIZE = 5 * MIB;
const MAX_PART_SIZE = 1024 * MIB;
/** The most parts one multipart upload may have. */
const MAX_PARTS = 10_000;

/** Per-call options the dispatcher forwards to the HTTP handler. */
interface SendOptions {
  readonly abortSignal?: AbortSignal;
}

/**
 * The dispatch seam {@link S3Disk} talks to: a per-command `send`. The real
 * `S3Client.send` is a generic Smithy method, so it is narrowed to these
 * concrete command shapes at the one construction boundary; tests inject a
 * double with the same shape.
 *
 * @public
 */
export interface S3Dispatcher {
  send(
    command:
      | PutObjectCommand
      | GetObjectCommand
      | HeadObjectCommand
      | HeadBucketCommand
      | DeleteObjectCommand
      | DeleteObjectsCommand
      | ListObjectsV2Command
      | CreateMultipartUploadCommand
      | UploadPartCommand
      | CompleteMultipartUploadCommand
      | AbortMultipartUploadCommand,
    options?: SendOptions,
  ): Promise<unknown>;
}

/**
 * Options for {@link S3Disk}.
 *
 * @public
 */
export interface S3DiskOptions {
  /** The bucket that holds the objects. */
  readonly bucket: string;
  /** AWS region (e.g. `us-east-1`); required unless a `client` is injected. */
  readonly region?: string;
  /** Static credentials; omitted, the SDK's default chain applies. */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    /** Temporary-session token, for STS-issued credentials. */
    readonly sessionToken?: string;
  };
  /** Endpoint of an S3-compatible store (R2, MinIO, SeaweedFS). */
  readonly endpoint?: string;
  /** Path-style addressing; most S3-compatible stores need it. */
  readonly forcePathStyle?: boolean;
  /** TCP/TLS connect timeout for the built client, in ms. Defaults to 5000. */
  readonly connectionTimeoutMs?: number;
  /** Per-request timeout for the built client, in ms. Defaults to 30 000. */
  readonly requestTimeoutMs?: number;
  /** A key prefix joined onto every object key: a disk key path without a trailing slash. */
  readonly prefix?: string;
  /** Bytes per multipart part, from 5 MiB to 1 GiB. Defaults to 8 MiB. */
  readonly partSize?: number;
  /**
   * Whether the store honours `If-None-Match: *`. Defaults to `true`; set
   * `false` for a store that ignores the header (SeaweedFS), so `ifAbsent`
   * refuses with `disk.unsupported` instead of silently overwriting.
   */
  readonly conditionalWrites?: boolean;
  /**
   * A client with a per-command `send`, for tests. Takes precedence over the
   * connection options. Only a real `S3Client` can sign URLs.
   */
  readonly client?: S3Dispatcher;
}

interface S3ErrorShape {
  readonly name?: unknown;
  readonly Code?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: unknown };
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { name, Code } = error as S3ErrorShape;
  if (typeof Code === 'string') return Code;
  return typeof name === 'string' ? name : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as S3ErrorShape).$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

/** The body shapes `GetObject` answers with. */
type BodyShape =
  | Uint8Array
  | string
  | {
      transformToWebStream?(): ReadableStream<Uint8Array>;
      [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array>;
    };

interface GetObjectShape {
  readonly Body?: BodyShape;
  readonly ContentLength?: number;
  readonly ContentRange?: string;
  readonly ContentType?: string;
}

interface HeadObjectShape {
  readonly ContentLength?: number;
  readonly LastModified?: Date;
  readonly ContentType?: string;
}

interface ListShape {
  readonly Contents?: readonly _Object[];
  readonly IsTruncated?: boolean;
  readonly NextContinuationToken?: string;
}

/** A `GetObject` body as a web stream, without collecting it. */
function toWebStream(body: BodyShape | undefined): ReadableStream<Uint8Array> {
  if (body === undefined) return new Blob([]).stream();
  if (body instanceof Uint8Array || typeof body === 'string') {
    return new Blob([typeof body === 'string' ? body : new Uint8Array(body)]).stream();
  }
  if (typeof body.transformToWebStream === 'function') return body.transformToWebStream();
  const iterate = body[Symbol.asyncIterator];
  if (typeof iterate === 'function') {
    const iterator = iterate.call(body);
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done === true) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await iterator.return?.();
      },
    });
  }
  throw new DiskErrors.Error('io_failed', { operation: 'read' });
}

/** Deliver only bytes `start..end` of `stream`, for a store that ignored a `Range` header. */
function sliceStream(
  stream: ReadableStream<Uint8Array>,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const from = Math.max(start - offset, 0);
        const to = Math.min(end + 1 - offset, chunk.byteLength);
        offset += chunk.byteLength;
        if (to > from) controller.enqueue(chunk.subarray(from, to));
        if (offset > end) controller.terminate();
      },
    }),
  );
}

/**
 * Wrap a store continuation token as a disk cursor, and unwrap one: the
 * strict round trip refuses any string this disk did not issue before it
 * reaches a store that might accept it (SeaweedFS takes any token).
 */
function encodeS3Cursor(token: string): string {
  return Buffer.from(token, 'utf8').toString('base64url');
}

function decodeS3Cursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const token = Buffer.from(cursor, 'base64url').toString('utf8');
  if (token === '' || encodeS3Cursor(token) !== cursor) {
    throw new DiskErrors.Error('invalid_cursor');
  }
  return token;
}

/** Parse `Content-Range: bytes a-b/total`. */
function parseContentRange(
  header: string | undefined,
): { start: number; end: number; size: number } | undefined {
  const match = header === undefined ? null : /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
  if (match === null) return undefined;
  return { start: Number(match[1]), end: Number(match[2]), size: Number(match[3]) };
}

/**
 * Check a served `Content-Range` against the requested range: the error to
 * raise, or `undefined` when the store served exactly what was asked (an end
 * past the object clamped to its last byte).
 */
function rangeFault(
  range: DiskRange,
  served: { start: number; end: number; size: number },
): Error | undefined {
  if (range.start >= served.size) return new DiskErrors.Error('invalid_range');
  const end = Math.min(range.end ?? served.size - 1, served.size - 1);
  if (served.start !== range.start || served.end !== end) {
    return new DiskErrors.Error('io_failed', { operation: 'read' });
  }
  return undefined;
}

/** An open multipart upload. */
interface Upload {
  readonly id: string;
  readonly parts: CompletedPart[];
}

/**
 * A disk in S3 or an S3-compatible store. Construction validates options and
 * builds the client; nothing touches the network until a method is called.
 *
 * @public
 */
export class S3Disk implements Disk, DiskUrlSigner {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #partSize: number;
  readonly #conditionalWrites: boolean;
  readonly #send: S3Dispatcher['send'];
  /** The client signing uses; absent when only a `send` double was injected. */
  readonly #signer: S3Client | undefined;

  constructor(options: S3DiskOptions) {
    if (!isOptionsObject(options))
      throw new DiskErrors.Error('invalid_option', { option: 'options' });
    if (typeof options.bucket !== 'string' || options.bucket.trim() === '') {
      throw new DiskErrors.Error('invalid_option', { option: 'bucket' });
    }
    if (options.prefix !== undefined && typeof options.prefix !== 'string') {
      throw new DiskErrors.Error('invalid_option', { option: 'prefix' });
    }
    const prefix = (options.prefix ?? '').replace(/\/+$/, '');
    if (prefix !== '' && !isDiskKey(prefix)) {
      throw new DiskErrors.Error('invalid_option', { option: 'prefix' });
    }
    const partSize = positiveIntegerOption(options.partSize, 'partSize', DEFAULT_PART_SIZE);
    if (partSize < MIN_PART_SIZE || partSize > MAX_PART_SIZE) {
      throw new DiskErrors.Error('invalid_option', { option: 'partSize' });
    }
    this.#bucket = options.bucket;
    this.#prefix = prefix === '' ? '' : `${prefix}/`;
    this.#partSize = partSize;
    if (options.conditionalWrites !== undefined && typeof options.conditionalWrites !== 'boolean') {
      throw new DiskErrors.Error('invalid_option', { option: 'conditionalWrites' });
    }
    this.#conditionalWrites = options.conditionalWrites !== false;

    if (options.client !== undefined) {
      if (options.client === null || typeof options.client.send !== 'function') {
        throw new DiskErrors.Error('invalid_option', { option: 'client' });
      }
      this.#send = options.client.send.bind(options.client);
      this.#signer = options.client instanceof S3Client ? options.client : undefined;
      return;
    }
    if (typeof options.region !== 'string' || options.region.trim() === '') {
      throw new DiskErrors.Error('invalid_option', { option: 'region' });
    }
    const client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      credentials:
        options.credentials === undefined
          ? undefined
          : {
              accessKeyId: options.credentials.accessKeyId,
              secretAccessKey: options.credentials.secretAccessKey,
              sessionToken: options.credentials.sessionToken,
            },
      forcePathStyle: options.forcePathStyle === true,
      requestHandler: {
        connectionTimeout: positiveIntegerOption(
          options.connectionTimeoutMs,
          'connectionTimeoutMs',
          DEFAULT_CONNECTION_TIMEOUT_MS,
        ),
        requestTimeout: positiveIntegerOption(
          options.requestTimeoutMs,
          'requestTimeoutMs',
          DEFAULT_REQUEST_TIMEOUT_MS,
        ),
      },
    });
    this.#send = client.send.bind(client) as S3Dispatcher['send'];
    this.#signer = client;
  }

  #objectKey(key: string): string {
    return this.#prefix + key;
  }

  /** The object-key prefix a listing under `prefix` sends (`''` for every key). */
  #listPrefix(prefix: string): string {
    return prefix === '' ? this.#prefix : `${this.#prefix}${prefix}/`;
  }

  /** Map a failed command to the disk error for `operation`. */
  #failure(operation: DiskOperation, error: unknown, signal?: AbortSignal): Error {
    if (DiskErrors.is(error)) return error;
    if (signal?.aborted === true && (operation === 'write' || operation === 'read')) {
      return new DiskErrors.Error('aborted', { operation }, { cause: signal.reason });
    }
    const name = errorName(error);
    const status = errorStatus(error);
    if (name === 'NoSuchBucket') return diskIoError(operation, error);
    if (operation === 'write') {
      if (
        name === 'PreconditionFailed' ||
        status === 412 ||
        name === 'ConditionalRequestConflict'
      ) {
        return new DiskErrors.Error('conflict', {}, { cause: error });
      }
      if (name === 'NotImplemented' || status === 501) {
        return new DiskErrors.Error('unsupported', { operation }, { cause: error });
      }
    }
    if (operation === 'read') {
      if (name === 'InvalidRange' || status === 416) {
        return new DiskErrors.Error('invalid_range', {}, { cause: error });
      }
      if (name === 'NoSuchKey' || status === 404) {
        return new DiskErrors.Error('not_found', {}, { cause: error });
      }
    }
    return diskIoError(operation, error);
  }

  async write(
    key: string,
    source: ByteSource,
    options: DiskWriteOptions,
  ): Promise<DiskWriteResult> {
    assertDiskKey(key);
    assertWriteOptions(options);
    if (options.ifAbsent === true && !this.#conditionalWrites) {
      throw new DiskErrors.Error('unsupported', { operation: 'write' });
    }
    const { signal } = options;
    const metered = meterByteSource(source, {
      maxBytes: options.maxBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    const objectKey = this.#objectKey(key);
    // A write that may not exceed one part never needs a bigger buffer.
    const buffer = Buffer.allocUnsafe(Math.min(this.#partSize, options.maxBytes));
    let filled = 0;
    let upload: Upload | undefined;
    try {
      for await (const chunk of metered.chunks) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          if (filled === buffer.byteLength) {
            upload ??= await this.#createUpload(objectKey, options);
            await this.#uploadPart(objectKey, upload, buffer.subarray(0, filled), signal);
            filled = 0;
          }
          const take = Math.min(chunk.byteLength - offset, buffer.byteLength - filled);
          buffer.set(chunk.subarray(offset, offset + take), filled);
          filled += take;
          offset += take;
        }
      }
      if (upload === undefined) {
        await this.#send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: objectKey,
            Body: buffer.subarray(0, filled),
            ContentLength: filled,
            ContentType: options.contentType,
            IfNoneMatch: options.ifAbsent === true ? '*' : undefined,
          }),
          { abortSignal: signal },
        );
      } else {
        if (filled > 0) {
          await this.#uploadPart(objectKey, upload, buffer.subarray(0, filled), signal);
        }
        await this.#send(
          new CompleteMultipartUploadCommand({
            Bucket: this.#bucket,
            Key: objectKey,
            UploadId: upload.id,
            MultipartUpload: { Parts: upload.parts },
            IfNoneMatch: options.ifAbsent === true ? '*' : undefined,
          }),
          { abortSignal: signal },
        );
      }
    } catch (error) {
      if (upload !== undefined) await this.#abortUpload(objectKey, upload);
      throw this.#failure('write', error, signal);
    }
    return metered.result();
  }

  async #createUpload(objectKey: string, options: DiskWriteOptions): Promise<Upload> {
    const output = (await this.#send(
      new CreateMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        ContentType: options.contentType,
      }),
      { abortSignal: options.signal },
    )) as { UploadId?: string };
    if (typeof output.UploadId !== 'string' || output.UploadId === '') {
      throw new DiskErrors.Error('io_failed', { operation: 'write' });
    }
    return { id: output.UploadId, parts: [] };
  }

  async #uploadPart(
    objectKey: string,
    upload: Upload,
    body: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (upload.parts.length === MAX_PARTS) throw new DiskErrors.Error('too_large');
    const partNumber = upload.parts.length + 1;
    const output = (await this.#send(
      new UploadPartCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        UploadId: upload.id,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.byteLength,
      }),
      { abortSignal: signal },
    )) as { ETag?: string };
    if (typeof output.ETag !== 'string') {
      throw new DiskErrors.Error('io_failed', { operation: 'write' });
    }
    upload.parts.push({ PartNumber: partNumber, ETag: output.ETag });
  }

  /** Abort a multipart upload after a failed write; the write's own error is what the caller sees. */
  async #abortUpload(objectKey: string, upload: Upload): Promise<void> {
    try {
      await this.#send(
        new AbortMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          UploadId: upload.id,
        }),
      );
    } catch {
      // The write has already failed; an upload this abort could not remove is
      // reclaimed by the bucket's AbortIncompleteMultipartUpload lifecycle rule.
    }
  }

  async read(key: string, options: DiskReadOptions = {}): Promise<DiskObject> {
    assertDiskKey(key);
    assertReadSignal(options.signal);
    throwIfDiskAborted(options.signal, 'read');
    const { range, signal } = options;
    if (range !== undefined) assertRangeShape(range);
    let output: GetObjectShape;
    try {
      output = (await this.#send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#objectKey(key),
          Range: range === undefined ? undefined : `bytes=${range.start}-${range.end ?? ''}`,
        }),
        { abortSignal: signal },
      )) as GetObjectShape;
    } catch (error) {
      throw this.#failure('read', error, signal);
    }
    const contentType = output.ContentType === undefined ? {} : { contentType: output.ContentType };
    const stream = toWebStream(output.Body);
    if (range === undefined) {
      const size = output.ContentLength ?? 0;
      return { stream, size, start: 0, end: size - 1, ...contentType };
    }
    const served = parseContentRange(output.ContentRange);
    if (served !== undefined) {
      const fault = rangeFault(range, served);
      if (fault !== undefined) {
        // The refusal is what the caller sees; a failed cancel adds nothing.
        await stream.cancel().catch(() => undefined);
        throw fault;
      }
      return { stream, ...served, ...contentType };
    }
    // The store ignored the Range header and sent the whole object.
    const size = output.ContentLength ?? 0;
    let bounds: { start: number; end: number };
    try {
      bounds = resolveDiskRange(range, size);
    } catch (error) {
      await stream.cancel();
      throw error;
    }
    return {
      stream: sliceStream(stream, bounds.start, bounds.end),
      size,
      ...bounds,
      ...contentType,
    };
  }

  async stat(key: string): Promise<DiskStat | null> {
    assertDiskKey(key);
    let output: HeadObjectShape;
    try {
      output = (await this.#send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: this.#objectKey(key) }),
      )) as HeadObjectShape;
    } catch (error) {
      if (errorStatus(error) !== 404) throw this.#failure('stat', error);
      await this.#assertBucket();
      return null;
    }
    return {
      size: output.ContentLength ?? 0,
      modifiedAt: output.LastModified ?? new Date(0),
      ...(output.ContentType === undefined ? {} : { contentType: output.ContentType }),
    };
  }

  /** Confirm the bucket exists, so a `HEAD` 404 can be read as a missing key. */
  async #assertBucket(): Promise<void> {
    try {
      await this.#send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch (error) {
      throw diskIoError('stat', error);
    }
  }

  async delete(key: string): Promise<void> {
    assertDiskKey(key);
    try {
      await this.#send(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#objectKey(key) }),
      );
    } catch (error) {
      if (errorName(error) === 'NoSuchKey') return;
      throw this.#failure('delete', error);
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertDiskKey(prefix);
    const listPrefix = this.#listPrefix(prefix);
    // Deleted keys leave the listing, so each round lists from the start.
    for (;;) {
      let page: ListShape;
      try {
        page = (await this.#send(
          new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: listPrefix, MaxKeys: 1000 }),
        )) as ListShape;
      } catch (error) {
        throw this.#failure('delete', error);
      }
      const objects = (page.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [{ Key: object.Key }],
      );
      if (objects.length === 0) return;
      let output: { Errors?: readonly unknown[] };
      try {
        output = (await this.#send(
          new DeleteObjectsCommand({
            Bucket: this.#bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        )) as { Errors?: readonly unknown[] };
      } catch (error) {
        throw this.#failure('delete', error);
      }
      if ((output.Errors ?? []).length > 0) {
        throw new DiskErrors.Error('io_failed', { operation: 'delete' });
      }
    }
  }

  async list(prefix: string, options: DiskListOptions): Promise<DiskListPage> {
    assertDiskPrefix(prefix);
    assertListOptions(options);
    const token = decodeS3Cursor(options.cursor);
    let page: ListShape;
    try {
      page = (await this.#send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: this.#listPrefix(prefix) || undefined,
          ContinuationToken: token,
          MaxKeys: options.limit,
        }),
      )) as ListShape;
    } catch (error) {
      if (options.cursor !== undefined && errorStatus(error) === 400) {
        throw new DiskErrors.Error('invalid_cursor');
      }
      throw this.#failure('list', error);
    }
    const keys: string[] = [];
    for (const object of page.Contents ?? []) {
      const key = object.Key?.startsWith(this.#prefix)
        ? object.Key.slice(this.#prefix.length)
        : undefined;
      // A folder marker (`photos/`) or an object written with a key the disk
      // rules refuse cannot be read through the disk, so it is not listed.
      if (key !== undefined && isDiskKey(key)) keys.push(key);
    }
    const next = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    return next === undefined || next === '' ? { keys } : { keys, cursor: encodeS3Cursor(next) };
  }

  async signedUrl(key: string, options: DiskSignedUrlOptions): Promise<string> {
    assertDiskKey(key);
    const resolved = resolveSignedUrlOptions(options);
    if (this.#signer === undefined) {
      throw new DiskErrors.Error('unsupported', { operation: 'sign' });
    }
    try {
      return await getSignedUrl(
        this.#signer,
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#objectKey(key),
          ResponseContentDisposition: resolved.contentDisposition,
          ResponseContentType: resolved.contentType,
        }),
        { expiresIn: resolved.expiresInSeconds },
      );
    } catch (error) {
      throw diskIoError('sign', error);
    }
  }
}
