/**
 * Real file signatures for the media tests. Uploads are sniffed, so a test
 * payload must carry the bytes its declared type implies. Also a memory disk
 * that can issue signed URLs, for the direct-URL paths, and an S3 disk around
 * a bare `send` double, which carries `url` but refuses to sign.
 */

import { MemoryDisk, S3Disk } from '@jsails/filesystem';
import type { DiskUrlOptions, UrlDisk } from 'jsails/filesystem';

/** A valid 1×1 PNG. */
export const PNG_BYTES: Uint8Array = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** A JPEG start-of-image marker and APP0 header: enough for a signature match. */
export const JPEG_BYTES: Uint8Array = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

/** A PDF header: the signature the sniffer reads. */
export const PDF_BYTES: Uint8Array = new TextEncoder().encode('%PDF-1.4\n%fake\n');

/** A PNG padded with trailing zeros to `size` bytes (still a valid signature and header). */
export function pngOfSize(size: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, PNG_BYTES.byteLength));
  bytes.set(PNG_BYTES);
  return bytes;
}

/** A PNG whose header claims `width` × `height` pixels. */
export function pngWithDimensions(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG_BYTES);
  const view = new DataView(bytes.buffer);
  // IHDR data starts at byte 16: width then height, big-endian.
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * A memory disk with the signed-URL capability: bytes live in memory, and
 * `url` presigns through an S3 disk holding fake static credentials, which
 * signs locally and never opens a connection. `calls` records each request.
 */
export function signingMemoryDisk(): MemoryDisk &
  UrlDisk & { readonly calls: [string, DiskUrlOptions | undefined][] } {
  const signer = new S3Disk({
    bucket: 'media-bucket',
    region: 'us-east-1',
    endpoint: 'https://s3.example.test',
    forcePathStyle: true,
    credentials: {
      accessKeyId: 'AKIAEXAMPLEEXAMPLE00',
      secretAccessKey: 'example-secret-key-not-real-0000000000000',
    },
  });
  const calls: [string, DiskUrlOptions | undefined][] = [];
  return Object.assign(new MemoryDisk(), {
    calls,
    url(key: string, options?: DiskUrlOptions): Promise<string> {
      calls.push([key, options]);
      return signer.url(key, options);
    },
  });
}

/** The command input fields the in-memory `send` double reads. */
interface S3InputLike {
  readonly Key?: string;
  readonly Body?: Uint8Array;
  readonly Range?: string;
}

/**
 * An S3 disk whose client is a bare `send` double storing objects in memory.
 * It answers `PutObject`, `GetObject` (with a single range), and `HeadObject`;
 * because the client is not a real `S3Client`, `url` refuses as `unsupported`.
 */
export function sendDoubleS3Disk(): S3Disk {
  const objects = new Map<string, Uint8Array>();
  const missing = (): Error =>
    Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  const client = {
    send(command: { readonly input: object }): Promise<unknown> {
      // The disk under test only ever sends byte bodies and string ranges.
      const input = command.input as S3InputLike;
      const key = input.Key ?? '';
      switch (command.constructor.name) {
        case 'PutObjectCommand':
          objects.set(key, Uint8Array.from(input.Body ?? new Uint8Array()));
          return Promise.resolve({});
        case 'HeadObjectCommand': {
          const body = objects.get(key);
          return body === undefined
            ? Promise.reject(missing())
            : Promise.resolve({ ContentLength: body.byteLength });
        }
        case 'GetObjectCommand': {
          const body = objects.get(key);
          if (body === undefined) {
            return Promise.reject(missing());
          }
          const range = /^bytes=(\d+)-(\d+)$/.exec(input.Range ?? '');
          if (range === null) {
            return Promise.resolve({ Body: body, ContentLength: body.byteLength });
          }
          const start = Number(range[1]);
          const end = Number(range[2]);
          return Promise.resolve({
            Body: body.subarray(start, end + 1),
            ContentLength: end - start + 1,
            ContentRange: `bytes ${start}-${end}/${body.byteLength}`,
          });
        }
        default:
          return Promise.reject(new Error('unscripted send call'));
      }
    },
  };
  return new S3Disk({ bucket: 'media-bucket', client });
}
