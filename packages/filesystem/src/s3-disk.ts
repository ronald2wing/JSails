/**
 * S3 disk: a {@link Disk} backed by AWS S3 or any S3-compatible object store
 * (Cloudflare R2, MinIO, SeaweedFS, RustFS). It is a thin, deliberate wrapper
 * over `@aws-sdk/client-s3` that keeps the {@link Disk} key contract and the
 * value-free error guarantee: every failure reaching a caller is a
 * {@link DiskError} with no key, bucket, endpoint, or credential echoed.
 *
 * Construction accepts the S3 coordinates (`bucket`, `region`, optional
 * `credentials`, `endpoint`, `forcePathStyle`, `prefix`) and builds a real
 * `S3Client`; tests inject a `client` (anything with a `send` method) or a bare
 * `send` function instead of hitting the network. A non-empty `prefix` is joined
 * onto every stored key, so a disk configured with `prefix: 'assets'` stores key
 * `logo.png` at object key `assets/logo.png`; `list` strips it back off, so
 * callers only ever see relative keys.
 *
 * The built client carries connection and request timeouts (5 s and 30 s by
 * default) so a stalled store fails a request instead of hanging it. `stream`
 * serves a whole object or one byte range without buffering it (a `Range`
 * GET), `putStream` enforces its byte cap while collecting the upload (a
 * single PutObject needs a known length), and `listPage` walks a large prefix
 * one page at a time instead of materializing every key.
 *
 * `url` presigns a `GetObject` locally (`@aws-sdk/s3-request-presigner`, no
 * network call): the result reads one object until it expires, so a download
 * or preview can go straight from the store to the client. The lifetime is
 * bounded by the core contract (15 minutes by default, at most 7 days), and
 * the requested `Content-Disposition`/`Content-Type` are signed into the URL
 * as response overrides, so a holder cannot change them. Presigning needs a
 * real `S3Client`: a disk built from coordinates or handed an `S3Client` can
 * sign, while one handed a bare `send` double refuses with `unsupported`.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DiskError,
  type DiskData,
  type DiskPutOptions,
  type DiskUrlOptions,
  type UrlDisk,
} from 'jsails/filesystem';
import {
  assertContentType,
  assertDiskKey,
  assertDiskPrefix,
  resolveDiskUrlOptions,
  toDiskBytes,
  toDiskIoError,
  validateMaxBytes,
} from './disk-validation.js';
import {
  chunksOf,
  resolveRange,
  type DiskPutStreamOptions,
  type DiskReadStream,
  type DiskStreamOptions,
  type StreamingDisk,
} from './streaming.js';

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** One page of {@link S3Disk.listPage}. */
export interface DiskListPage {
  /** Keys on this page, in the store's (lexicographic) order. */
  readonly keys: readonly string[];
  /** Pass back to get the next page; `undefined` on the last page. */
  readonly cursor: string | undefined;
}

/**
 * The dispatch seam {@link S3Disk} talks to: a per-command `send` returning a
 * raw promise. The real `S3Client.send` is a generic Smithy method, so it is
 * narrowed to these concrete command shapes at the one construction boundary;
 * tests inject a double with the same concrete signature.
 */
interface S3Dispatcher {
  send(command: PutObjectCommand): Promise<unknown>;
  send(command: GetObjectCommand): Promise<unknown>;
  send(command: HeadObjectCommand): Promise<unknown>;
  send(command: DeleteObjectCommand): Promise<unknown>;
  send(command: ListObjectsV2Command): Promise<unknown>;
}

/** Options for {@link S3Disk}. */
export interface S3DiskOptions {
  /** The bucket that owns the stored objects. */
  readonly bucket: string;
  /** AWS region (e.g. `us-east-1`); required unless a `client` is injected. */
  readonly region?: string;
  /** Static access credentials; omitted to fall back to the SDK's default chain. */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    /** Temporary-session token, when using STS-issued credentials. */
    readonly sessionToken?: string;
  };
  /** Custom endpoint for S3-compatible stores (R2, MinIO, SeaweedFS, RustFS). */
  readonly endpoint?: string;
  /** Use path-style addressing; required by most S3-compatible stores. */
  readonly forcePathStyle?: boolean;
  /** TCP/TLS connect timeout for the built client, in ms. Defaults to 5000. */
  readonly connectionTimeoutMs?: number;
  /** Per-request timeout for the built client, in ms. Defaults to 30 000. */
  readonly requestTimeoutMs?: number;
  /** Optional object-key prefix, joined onto every stored key. */
  readonly prefix?: string;
  /**
   * Injectable S3 client (anything exposing a per-command `send`) for tests.
   * Takes precedence over `region`/`credentials`/`endpoint`/`forcePathStyle`.
   * Only a real `S3Client` can presign `url`s; any other client refuses them.
   */
  readonly client?: S3Dispatcher;
}

/** The shape `HeadObject` returns for a present object (`size` reads `ContentLength`). */
interface HeadShape {
  ContentLength?: number;
}

/** The shape `GetObject` returns, with a body that may stream. */
interface GetShape extends HeadShape {
  Body?: Uint8Array | SdkStreamBody | string | ReadableLike;
}

/** Any streaming body exposing the SDK's byte transform. */
interface SdkStreamBody {
  transformToByteArray(): Promise<Uint8Array>;
  transformToWebStream?(): ReadableStream<Uint8Array>;
}

/** The `GetObject` fields a ranged read needs. */
interface RangedGetShape extends GetShape {
  ContentRange?: string;
}

/** A Node or web readable stream, collected manually when no transform exists. */
interface ReadableLike {
  [Symbol.asyncIterator]?(): AsyncIterableIterator<Uint8Array>;
}

/** True when `error` is a 404-shaped S3 response (missing object/bucket). */
function isNotFound(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; name?: unknown };
    if (candidate.code === 'NotFound' || candidate.code === 'NoSuchKey') {
      return true;
    }
    if (candidate.name === 'NotFound' || candidate.name === 'NoSuchKey') {
      return true;
    }
    const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
    if (typeof metadata === 'object' && metadata !== null && metadata.httpStatusCode === 404) {
      return true;
    }
  }
  return false;
}

/** Reduce an SDK error to a payload-free {@link DiskError}. */
function wrapS3(error: unknown): Error {
  if (error instanceof DiskError) {
    return error;
  }
  if (isNotFound(error)) {
    return new DiskError('not_found', 'file not found');
  }
  return toDiskIoError(error);
}

/** Coerce an arbitrary `Body` to bytes, collecting streaming bodies when needed. */
async function toBytes(body: GetShape['Body']): Promise<Uint8Array> {
  if (body === undefined) {
    throw new DiskError('not_found', 'file not found');
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  const transform = (body as SdkStreamBody).transformToByteArray;
  if (typeof transform === 'function') {
    return transform.call(body);
  }
  const iterator = (body as ReadableLike)[Symbol.asyncIterator];
  if (iterator !== undefined) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of iterator.call(body)) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new DiskError('io_failed', 'object body is not readable');
}

/** Turn a `GetObject` body into a web stream without collecting it. */
function toWebStream(body: GetShape['Body']): ReadableStream<Uint8Array> {
  if (body === undefined) {
    throw new DiskError('not_found', 'file not found');
  }
  if (body instanceof Uint8Array || typeof body === 'string') {
    return new Blob([typeof body === 'string' ? body : new Uint8Array(body)]).stream();
  }
  const transform = (body as SdkStreamBody).transformToWebStream;
  if (typeof transform === 'function') {
    return transform.call(body);
  }
  const iterator = (body as ReadableLike)[Symbol.asyncIterator];
  if (iterator !== undefined) {
    const source = iterator.call(body);
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await source.next();
        if (next.done === true) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      },
    });
  }
  throw new DiskError('io_failed', 'object body is not readable');
}

/** Read the total size from a `Content-Range: bytes a-b/total` header. */
function totalFromContentRange(header: string | undefined): number | undefined {
  const match = header === undefined ? null : /\/(\d+)$/.exec(header);
  return match === null ? undefined : Number(match[1]);
}

function timeoutOption(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('timeouts must be positive integers');
  }
  return value;
}

/**
 * A disk stored in S3 or an S3-compatible store. Construct with
 * `new S3Disk({ bucket, region, ... })`: construction validates options and
 * builds the client; it never contacts the network until a method is called.
 */
export class S3Disk implements StreamingDisk, UrlDisk {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #send: S3Dispatcher['send'];
  /** The client presigning uses; absent when only a `send` double was injected. */
  readonly #signer: S3Client | undefined;

  constructor(options: S3DiskOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('S3Disk requires an options object');
    }
    if (typeof options.bucket !== 'string' || options.bucket.trim() === '') {
      throw new TypeError('bucket must be a non-empty string');
    }
    const prefix = options.prefix ?? '';
    if (typeof prefix !== 'string') {
      throw new TypeError('prefix must be a string');
    }
    if (prefix.includes('\0')) {
      throw new TypeError('prefix must not contain control characters');
    }

    this.#bucket = options.bucket;
    this.#prefix = prefix === '' ? '' : prefix.replace(/\/+$/, '') + '/';

    if (options.client !== undefined) {
      if (options.client === null || typeof options.client.send !== 'function') {
        throw new TypeError('client must expose a send method');
      }
      this.#send = options.client.send.bind(options.client);
      this.#signer = options.client instanceof S3Client ? options.client : undefined;
    } else {
      if (typeof options.region !== 'string' || options.region.trim() === '') {
        throw new TypeError('region must be a non-empty string when no client is injected');
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
          connectionTimeout: timeoutOption(
            options.connectionTimeoutMs,
            DEFAULT_CONNECTION_TIMEOUT_MS,
          ),
          requestTimeout: timeoutOption(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
        },
      });
      this.#send = client.send.bind(client) as S3Dispatcher['send'];
      this.#signer = client;
    }
  }

  /** Map a relative disk key to its object key (prefix applied). */
  #objectKey(key: string): string {
    return this.#prefix + key;
  }

  async put(key: string, data: DiskData, options?: DiskPutOptions): Promise<void> {
    assertDiskKey(key);
    assertContentType(options?.contentType);
    const bytes = toDiskBytes(data);
    try {
      await this.#send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: this.#objectKey(key),
          Body: bytes,
          ContentType: options?.contentType,
        }),
      );
    } catch (error) {
      throw wrapS3(error);
    }
  }

  async get(key: string): Promise<Uint8Array> {
    assertDiskKey(key);
    try {
      const output = (await this.#send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: this.#objectKey(key) }),
      )) as GetShape;
      return await toBytes(output.Body);
    } catch (error) {
      throw wrapS3(error);
    }
  }

  /**
   * A presigned `GetObject` URL for `key`, valid for `expiresIn` seconds. The
   * object's existence is not checked: a URL for a missing key answers 404
   * from the store, and checking first would cost a round trip per URL.
   */
  async url(key: string, options?: DiskUrlOptions): Promise<string> {
    assertDiskKey(key);
    const resolved = resolveDiskUrlOptions(options);
    if (this.#signer === undefined) {
      throw new DiskError('unsupported', 'this disk cannot issue URLs');
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
        { expiresIn: resolved.expiresIn },
      );
    } catch (error) {
      throw wrapS3(error);
    }
  }

  async stream(key: string, options?: DiskStreamOptions): Promise<DiskReadStream> {
    assertDiskKey(key);
    const range = options?.range;
    if (range === undefined) {
      try {
        const output = (await this.#send(
          new GetObjectCommand({ Bucket: this.#bucket, Key: this.#objectKey(key) }),
        )) as GetShape;
        const size = output.ContentLength ?? 0;
        return { stream: toWebStream(output.Body), size, start: 0, end: size - 1 };
      } catch (error) {
        throw wrapS3(error);
      }
    }
    // A range is validated against the real size first, so an unsatisfiable
    // request fails as `invalid_range` rather than a store-specific 416.
    const size = await this.size(key);
    const { start, end } = resolveRange(range, size);
    try {
      const output = (await this.#send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#objectKey(key),
          Range: `bytes=${start}-${end}`,
        }),
      )) as RangedGetShape;
      return {
        stream: toWebStream(output.Body),
        size: totalFromContentRange(output.ContentRange) ?? size,
        start,
        end,
      };
    } catch (error) {
      throw wrapS3(error);
    }
  }

  async putStream(
    key: string,
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options?: DiskPutStreamOptions,
  ): Promise<number> {
    assertDiskKey(key);
    assertContentType(options?.contentType);
    const cap = validateMaxBytes(options?.maxBytes) ?? Number.POSITIVE_INFINITY;
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of chunksOf(source)) {
      received += chunk.byteLength;
      if (received > cap) {
        throw new DiskError('too_large', 'disk capacity exceeded');
      }
      chunks.push(chunk);
    }
    await this.put(key, Buffer.concat(chunks), options);
    return received;
  }

  /**
   * One page of keys under `prefix`. Unlike `list`, nothing beyond the page is
   * held in memory, so a bucket prefix of any size can be walked.
   */
  async listPage(
    prefix?: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<DiskListPage> {
    assertDiskPrefix(prefix);
    const limit = options.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be an integer from 1 to 1000');
    }
    let output: { NextContinuationToken?: string; IsTruncated?: boolean; Contents?: _Object[] };
    try {
      output = (await this.#send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: this.#listPrefix(prefix) || undefined,
          ContinuationToken: options.cursor,
          MaxKeys: limit,
        }),
      )) as typeof output;
    } catch (error) {
      throw wrapS3(error);
    }
    return {
      keys: this.#relativeKeys(output.Contents ?? []),
      cursor: output.IsTruncated === true ? output.NextContinuationToken : undefined,
    };
  }

  #listPrefix(prefix: string | undefined): string {
    const rawPrefix = this.#objectKey(prefix === undefined || prefix === '' ? '' : prefix);
    return rawPrefix === '' ? '' : `${rawPrefix.replace(/\/+$/, '')}/`;
  }

  #relativeKeys(objects: readonly _Object[]): string[] {
    const keys: string[] = [];
    for (const object of objects) {
      const key = object.Key;
      if (key === undefined) {
        continue;
      }
      const relative = key.startsWith(this.#prefix) ? key.slice(this.#prefix.length) : key;
      if (relative === '') {
        continue; // the prefix marker itself is not a stored key
      }
      keys.push(relative);
    }
    return keys;
  }

  async exists(key: string): Promise<boolean> {
    assertDiskKey(key);
    try {
      await this.#send(new HeadObjectCommand({ Bucket: this.#bucket, Key: this.#objectKey(key) }));
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw wrapS3(error);
    }
  }

  async delete(key: string): Promise<void> {
    assertDiskKey(key);
    try {
      await this.#send(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#objectKey(key) }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return; // idempotent
      }
      throw wrapS3(error);
    }
  }

  async list(prefix?: string): Promise<readonly string[]> {
    assertDiskPrefix(prefix);
    const keys: string[] = [];
    const listPrefix = this.#listPrefix(prefix);
    let continuationToken: string | undefined;
    for (;;) {
      let output: { NextContinuationToken?: string; IsTruncated?: boolean; Contents?: _Object[] };
      try {
        output = (await this.#send(
          new ListObjectsV2Command({
            Bucket: this.#bucket,
            Prefix: listPrefix || undefined,
            ContinuationToken: continuationToken,
          }),
        )) as typeof output;
      } catch (error) {
        throw wrapS3(error);
      }
      keys.push(...this.#relativeKeys(output.Contents ?? []));
      // Stop when the store reports completion, or when a truncated page omits
      // its continuation token (some S3-compatible stores do this); looping on
      // `undefined` would re-request the same first page forever.
      if (output.IsTruncated !== true || output.NextContinuationToken === undefined) {
        break;
      }
      continuationToken = output.NextContinuationToken;
    }
    keys.sort();
    return keys;
  }

  async size(key: string): Promise<number> {
    assertDiskKey(key);
    try {
      const output = (await this.#send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: this.#objectKey(key) }),
      )) as HeadShape;
      const size = output.ContentLength;
      if (typeof size !== 'number') {
        throw new DiskError('not_found', 'file not found');
      }
      return size;
    } catch (error) {
      throw wrapS3(error);
    }
  }
}
