/**
 * An in-memory S3 bucket behind the `send` seam {@link S3Disk} accepts, for
 * tests that need the store's semantics rather than a scripted reply per call.
 *
 * It models what the disk depends on: objects with ranged reads and
 * modification times, `HeadBucket`, paginated `ListObjectsV2` whose
 * continuation tokens are checked, batch `DeleteObjects`, conditional puts
 * (`If-None-Match: *`, `If-Match`), and multipart uploads with S3's own rules
 * (part order, ETag match, the 5 MiB minimum for every part but the last,
 * conditional completion, abort). Every command is recorded with its input,
 * so a test can assert what was sent and in what order. An unknown command
 * throws, so a test cannot pass against a fake that silently does nothing.
 *
 * With `discardBodies`, objects and parts keep only their size and digest,
 * so a test can stream far more bytes through a disk than it could hold, and
 * measure the disk's own memory rather than the fake's.
 *
 * Errors are `S3ServiceException`s shaped as the SDK raises them. A `HEAD`
 * response has no body, so a `HeadObject` against a missing bucket surfaces as
 * a bodiless 404 (`NotFound`), exactly as the real SDK reports it.
 */

import { createHash } from 'node:crypto';

import { S3ServiceException } from '@aws-sdk/client-s3';

/** The smallest part S3 accepts for every part of a multipart upload but the last. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

/** One command the fake received: its class name and its input. */
export interface FakeS3Command {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** A stored object. */
export interface FakeS3Object {
  /** The stored bytes; empty when the fake discards bodies. */
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly etag: string;
  readonly contentType: string | undefined;
  readonly lastModified: Date;
}

/** Options for {@link createFakeS3}. */
export interface FakeS3Options {
  /** The one bucket that exists. Defaults to `test-bucket`. */
  readonly bucket?: string;
  /** Called before each command is applied; throw from it to inject a failure. */
  readonly beforeCommand?: (command: FakeS3Command) => void | Promise<void>;
  /** Keep only the size and digest of each body. */
  readonly discardBodies?: boolean;
}

/** The fake store and the client to hand to `new S3Disk({ client })`. */
export interface FakeS3 {
  readonly bucket: string;
  /** Every command received, in order. */
  readonly commands: FakeS3Command[];
  /** Stored objects by key. */
  readonly objects: Map<string, FakeS3Object>;
  /** The number of multipart uploads started and neither completed nor aborted. */
  readonly openUploads: number;
  readonly client: { send(command: object): Promise<unknown> };
  /** The names of the commands received, in order. */
  commandNames(): string[];
}

interface Upload {
  readonly key: string;
  readonly contentType: string | undefined;
  readonly parts: Map<
    number,
    { readonly bytes: Uint8Array; readonly size: number; readonly etag: string }
  >;
}

function serviceError(name: string, status: number, message: string): S3ServiceException {
  return new S3ServiceException({
    name,
    $fault: status >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: status },
    message,
  });
}

function etagOf(bytes: Uint8Array): string {
  return `"${createHash('md5').update(bytes).digest('hex')}"`;
}

export function serviceErrorFor(name: string, status: number): S3ServiceException {
  return serviceError(name, status, name);
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) {
    return new Uint8Array(0);
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  if (body instanceof Uint8Array) {
    return new Uint8Array(body);
  }
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new TypeError('the fake S3 cannot read this body');
}

/** A body with the SDK's transforms, as `GetObject` returns it. */
function sdkBody(bytes: Uint8Array): {
  transformToByteArray(): Promise<Uint8Array>;
  transformToWebStream(): ReadableStream<Uint8Array>;
} {
  return {
    transformToByteArray: () => Promise.resolve(new Uint8Array(bytes)),
    transformToWebStream: () => new Blob([new Uint8Array(bytes)]).stream(),
  };
}

function stringInput(input: Readonly<Record<string, unknown>>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value === '') {
    throw serviceError('InvalidRequest', 400, `${field} is required`);
  }
  return value;
}

function optionalString(
  input: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = input[field];
  return typeof value === 'string' ? value : undefined;
}

/** Create an empty fake bucket. */
export function createFakeS3(options: FakeS3Options = {}): FakeS3 {
  const bucket = options.bucket ?? 'test-bucket';
  const commands: FakeS3Command[] = [];
  const objects = new Map<string, FakeS3Object>();
  const uploads = new Map<string, Upload>();
  const issuedTokens = new Set<string>();
  const discard = options.discardBodies === true;
  let uploadSeq = 0;

  /** A body's bytes; a discarding fake reads a buffer in place instead of copying it. */
  function readBody(body: unknown): Promise<Uint8Array> {
    return discard && body instanceof Uint8Array ? Promise.resolve(body) : bodyBytes(body);
  }

  function store(
    key: string,
    bytes: Uint8Array,
    etag: string,
    contentType: string | undefined,
  ): void {
    objects.set(key, {
      bytes: discard ? new Uint8Array(0) : bytes,
      size: bytes.byteLength,
      etag,
      contentType,
      lastModified: new Date(),
    });
  }

  function checkPreconditions(key: string, input: Readonly<Record<string, unknown>>): void {
    const existing = objects.get(key);
    const ifNoneMatch = optionalString(input, 'IfNoneMatch');
    if (ifNoneMatch !== undefined) {
      if (ifNoneMatch !== '*') {
        throw serviceError('NotImplemented', 501, 'If-None-Match accepts only *');
      }
      if (existing !== undefined) {
        throw serviceError('PreconditionFailed', 412, 'At least one precondition failed');
      }
    }
    const ifMatch = optionalString(input, 'IfMatch');
    if (ifMatch !== undefined && existing?.etag !== ifMatch) {
      throw serviceError(
        existing === undefined ? 'NoSuchKey' : 'PreconditionFailed',
        existing === undefined ? 404 : 412,
        'At least one precondition failed',
      );
    }
  }

  function requireObject(key: string, head: boolean): FakeS3Object {
    const object = objects.get(key);
    if (object === undefined) {
      throw head
        ? serviceError('NotFound', 404, 'UnknownError')
        : serviceError('NoSuchKey', 404, 'The specified key does not exist.');
    }
    return object;
  }

  function requireUpload(input: Readonly<Record<string, unknown>>, key: string): Upload {
    const upload = uploads.get(stringInput(input, 'UploadId'));
    if (upload === undefined || upload.key !== key) {
      throw serviceError('NoSuchUpload', 404, 'The specified upload does not exist.');
    }
    return upload;
  }

  async function apply(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (input.Bucket !== bucket) {
      // A HEAD response carries no error body, so the SDK cannot name the cause.
      throw name === 'HeadObjectCommand' || name === 'HeadBucketCommand'
        ? serviceError('NotFound', 404, 'UnknownError')
        : serviceError('NoSuchBucket', 404, 'The specified bucket does not exist');
    }
    switch (name) {
      case 'PutObjectCommand': {
        const key = stringInput(input, 'Key');
        const bytes = await readBody(input.Body);
        checkPreconditions(key, input);
        const etag = etagOf(bytes);
        store(key, bytes, etag, optionalString(input, 'ContentType'));
        return { ETag: etag };
      }
      case 'HeadBucketCommand':
        return {};
      case 'DeleteObjectsCommand': {
        const listed = (input.Delete as { Objects?: { Key?: unknown }[] } | undefined)?.Objects;
        if (!Array.isArray(listed) || listed.length === 0 || listed.length > 1000) {
          throw serviceError('MalformedXML', 400, 'The XML you provided was not well-formed');
        }
        for (const entry of listed) {
          if (typeof entry.Key === 'string') objects.delete(entry.Key);
        }
        return { Errors: [] };
      }
      case 'GetObjectCommand': {
        const object = requireObject(stringInput(input, 'Key'), false);
        const range = optionalString(input, 'Range');
        if (range === undefined) {
          return {
            Body: sdkBody(object.bytes),
            ContentLength: object.bytes.byteLength,
            ContentType: object.contentType,
            ETag: object.etag,
            LastModified: object.lastModified,
          };
        }
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        const size = object.bytes.byteLength;
        const start = match === null ? Number.NaN : Number(match[1]);
        const end = match?.[2] === undefined || match[2] === '' ? size - 1 : Number(match[2]);
        if (!Number.isSafeInteger(start) || start >= size || end < start) {
          throw serviceError('InvalidRange', 416, 'The requested range is not satisfiable');
        }
        const last = Math.min(end, size - 1);
        const slice = object.bytes.subarray(start, last + 1);
        return {
          Body: sdkBody(slice),
          ContentLength: slice.byteLength,
          ContentRange: `bytes ${start}-${last}/${size}`,
          ContentType: object.contentType,
          ETag: object.etag,
        };
      }
      case 'HeadObjectCommand': {
        const object = requireObject(stringInput(input, 'Key'), true);
        return {
          ContentLength: object.size,
          ContentType: object.contentType,
          ETag: object.etag,
          LastModified: object.lastModified,
        };
      }
      case 'DeleteObjectCommand': {
        objects.delete(stringInput(input, 'Key'));
        return {};
      }
      case 'ListObjectsV2Command': {
        const prefix = optionalString(input, 'Prefix') ?? '';
        const maxKeys = typeof input.MaxKeys === 'number' ? input.MaxKeys : 1000;
        const token = optionalString(input, 'ContinuationToken');
        if (token !== undefined && !issuedTokens.has(token)) {
          throw serviceError(
            'InvalidArgument',
            400,
            'The continuation token provided is incorrect',
          );
        }
        const after = token === undefined ? undefined : Buffer.from(token, 'base64url').toString();
        const keys = [...objects.keys()]
          .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
          .sort();
        const page = keys.slice(0, maxKeys);
        const truncated = keys.length > page.length;
        const next = truncated ? Buffer.from(page.at(-1) ?? '').toString('base64url') : undefined;
        if (next !== undefined) issuedTokens.add(next);
        return {
          Contents: page.map((key) => ({ Key: key, Size: objects.get(key)?.size })),
          KeyCount: page.length,
          IsTruncated: truncated,
          NextContinuationToken: next,
        };
      }
      case 'CreateMultipartUploadCommand': {
        uploadSeq += 1;
        const uploadId = `upload-${uploadSeq}`;
        uploads.set(uploadId, {
          key: stringInput(input, 'Key'),
          contentType: optionalString(input, 'ContentType'),
          parts: new Map(),
        });
        return { Bucket: bucket, Key: input.Key, UploadId: uploadId };
      }
      case 'UploadPartCommand': {
        const upload = requireUpload(input, stringInput(input, 'Key'));
        const partNumber = input.PartNumber;
        if (typeof partNumber !== 'number' || !Number.isInteger(partNumber) || partNumber < 1) {
          throw serviceError('InvalidArgument', 400, 'Part number must be an integer from 1');
        }
        const bytes = await readBody(input.Body);
        const etag = etagOf(bytes);
        upload.parts.set(partNumber, {
          bytes: discard ? new Uint8Array(0) : bytes,
          size: bytes.byteLength,
          etag,
        });
        return { ETag: etag };
      }
      case 'CompleteMultipartUploadCommand': {
        const key = stringInput(input, 'Key');
        const uploadId = stringInput(input, 'UploadId');
        const upload = requireUpload(input, key);
        const listed = (input.MultipartUpload as { Parts?: unknown } | undefined)?.Parts;
        if (!Array.isArray(listed) || listed.length === 0) {
          throw serviceError('MalformedXML', 400, 'The XML you provided was not well-formed');
        }
        // S3 validates the list (order, then each part's ETag) before sizes.
        let previous = 0;
        const parts = listed.map((entry: { PartNumber?: unknown; ETag?: unknown }) => {
          const partNumber = entry.PartNumber;
          if (typeof partNumber !== 'number' || partNumber <= previous) {
            throw serviceError('InvalidPartOrder', 400, 'The parts are not in ascending order');
          }
          previous = partNumber;
          const part = upload.parts.get(partNumber);
          if (part === undefined || part.etag !== entry.ETag) {
            throw serviceError('InvalidPart', 400, 'One or more parts could not be found');
          }
          return part;
        });
        if (parts.slice(0, -1).some((part) => part.size < MIN_PART_BYTES)) {
          throw serviceError('EntityTooSmall', 400, 'A part is smaller than the minimum');
        }
        checkPreconditions(key, input);
        const etag = `"${createHash('md5')
          .update(parts.map((part) => part.etag).join(''))
          .digest('hex')}-${listed.length}"`;
        if (discard) {
          objects.set(key, {
            bytes: new Uint8Array(0),
            size: parts.reduce((total, part) => total + part.size, 0),
            etag,
            contentType: upload.contentType,
            lastModified: new Date(),
          });
        } else {
          store(key, Buffer.concat(parts.map((part) => part.bytes)), etag, upload.contentType);
        }
        uploads.delete(uploadId);
        return { Bucket: bucket, Key: key, ETag: etag };
      }
      case 'AbortMultipartUploadCommand': {
        const key = stringInput(input, 'Key');
        requireUpload(input, key);
        uploads.delete(stringInput(input, 'UploadId'));
        return {};
      }
      default:
        throw new Error(`the fake S3 does not implement ${name}`);
    }
  }

  return {
    bucket,
    commands,
    objects,
    get openUploads() {
      return uploads.size;
    },
    client: {
      async send(command: object): Promise<unknown> {
        const name = command.constructor.name;
        const input = (command as { input?: Readonly<Record<string, unknown>> }).input ?? {};
        const record = { name, input };
        commands.push(record);
        await options.beforeCommand?.(record);
        return apply(name, input);
      },
    },
    commandNames() {
      return commands.map((command) => command.name);
    },
  };
}
