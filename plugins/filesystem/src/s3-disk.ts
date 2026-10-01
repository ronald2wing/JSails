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
import { DiskError, type Disk, type DiskData, type DiskPutOptions } from 'jsails/filesystem';
import { assertDiskKey, assertDiskPrefix, assertContentType, toDiskBytes } from './disk-key.js';

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
  /** Optional object-key prefix, joined onto every stored key. */
  readonly prefix?: string;
  /**
   * Injectable S3 client (anything exposing a per-command `send`) for tests.
   * Takes precedence over `region`/`credentials`/`endpoint`/`forcePathStyle`.
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
function wrapS3(error: unknown): DiskError {
  if (error instanceof DiskError) {
    return error;
  }
  if (isNotFound(error)) {
    return new DiskError('not_found', 'file not found');
  }
  return new DiskError('io', 'disk I/O failed');
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
  throw new DiskError('io', 'disk I/O failed');
}

/**
 * A disk stored in S3 or an S3-compatible store. Construct with
 * `new S3Disk({ bucket, region, ... })`: construction validates options and
 * builds the client; it never contacts the network until a method is called.
 */
export class S3Disk implements Disk {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #send: S3Dispatcher['send'];

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
      });
      this.#send = client.send.bind(client) as S3Dispatcher['send'];
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
    const rawPrefix = this.#objectKey(prefix === undefined || prefix === '' ? '' : prefix);
    const listPrefix = rawPrefix === '' ? '' : `${rawPrefix.replace(/\/+$/, '')}/`;
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
      for (const object of output.Contents ?? []) {
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
