/**
 * Incremental `multipart/form-data` reader for the component upload endpoint.
 *
 * The platform `Request.formData()` parser materializes every part, file
 * included, before the caller sees any of it, so a request that will be
 * rejected (bad snapshot, CSRF mismatch, a component that does not accept
 * uploads) would still have its whole file buffered in memory first. This
 * reader instead pulls the body chunk by chunk: the snapshot part, which must
 * come first, is read alone (bounded at {@link MAX_UPLOAD_SNAPSHOT_BYTES}) so
 * the caller can authorize the request, and only then is the file part opened
 * as a stream that the store consumes directly. At most one chunk plus a
 * boundary's worth of bytes is held at a time.
 *
 * The accepted shape is exactly what the component client sends: a snapshot
 * field, then one file field, then the closing boundary. Anything else (another
 * order, extra parts, a truncated body, oversize headers) is a value-free
 * {@link UploadError}; nothing from the body is echoed.
 */

import { Readable } from 'node:stream';

import { COMPONENT_UPLOAD_FILE_FIELD, COMPONENT_UPLOAD_SNAPSHOT_FIELD } from '../protocol.js';
import { UploadError } from '../uploads.js';

/** Upper bound on the snapshot field, matching the update payload's snapshot cap. */
export const MAX_UPLOAD_SNAPSHOT_BYTES = 64 * 1024;

/** Upper bound on one part's header block. */
const MAX_PART_HEADER_BYTES = 8 * 1024;
/** Upper bound on a preamble before the first boundary. */
const MAX_PREAMBLE_BYTES = 1024;
/** RFC 2046 boundary: 1-70 characters from a restricted set. */
const BOUNDARY_PATTERN = /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/;

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const CLOSE_MARKER = Buffer.from('--');

/** The file part of an upload, streamed straight from the request body. */
export interface MultipartFilePart {
  readonly contentType: string;
  readonly filename: string;
  readonly stream: Readable;
}

function invalidBody(message = 'Upload body could not be parsed'): UploadError {
  return new UploadError('invalid_input', message);
}

/** Extract the boundary parameter from a `multipart/form-data` content type. */
function boundaryFrom(contentType: string): string {
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw invalidBody('Upload must be multipart/form-data');
  }
  const match = /;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (boundary === undefined || !BOUNDARY_PATTERN.test(boundary) || boundary.endsWith(' ')) {
    throw invalidBody();
  }
  return boundary;
}

interface PartHeaders {
  readonly name: string;
  readonly filename: string | undefined;
  readonly contentType: string | undefined;
}

/** Read a `key="value"` (or bare token) parameter from a header value. */
function headerParameter(value: string, key: string): string | undefined {
  const pattern = new RegExp(`;\\s*${key}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s;]+))`, 'i');
  const match = pattern.exec(value);
  const raw = match?.[1] ?? match?.[2];
  return raw?.replace(/\\(.)/g, '$1');
}

function parsePartHeaders(block: Buffer): PartHeaders {
  let disposition: string | undefined;
  let contentType: string | undefined;
  for (const line of block.toString('utf8').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw invalidBody();
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'content-disposition') {
      disposition = value;
    } else if (name === 'content-type') {
      contentType = value;
    }
  }
  if (disposition === undefined || !/^form-data\s*(;|$)/i.test(disposition)) {
    throw invalidBody();
  }
  const fieldName = headerParameter(disposition, 'name');
  if (fieldName === undefined) {
    throw invalidBody();
  }
  return { name: fieldName, filename: headerParameter(disposition, 'filename'), contentType };
}

/**
 * A pull-based reader over one upload body. Call {@link readSnapshot} first,
 * authorize, then {@link openFile}; {@link cancel} releases the body whenever
 * the caller stops early.
 */
export class MultipartUploadReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #delimiter: Buffer;
  readonly #maxBodyBytes: number;
  #buffer: Buffer = Buffer.alloc(0);
  #received = 0;
  #ended = false;
  #finished = false;

  constructor(body: ReadableStream<Uint8Array>, boundary: string, maxBodyBytes: number) {
    this.#reader = body.getReader();
    // Every boundary after the first is preceded by the CRLF that ends the
    // previous part's body; the first one may follow a preamble.
    this.#delimiter = Buffer.from(`\r\n--${boundary}`);
    this.#maxBodyBytes = maxBodyBytes;
  }

  /** Pull one more chunk into the buffer; `false` at end of body. */
  async #fill(): Promise<boolean> {
    if (this.#ended) {
      return false;
    }
    const { done, value } = await this.#reader.read();
    if (done) {
      this.#ended = true;
      return false;
    }
    this.#received += value.byteLength;
    if (this.#received > this.#maxBodyBytes) {
      throw new UploadError('too_large', 'upload exceeds the maximum size');
    }
    this.#buffer =
      this.#buffer.length === 0
        ? Buffer.from(value)
        : Buffer.concat([this.#buffer, Buffer.from(value)]);
    return true;
  }

  /** Read and consume bytes up to `marker`, failing past `limit` bytes or at end of body. */
  async #readUntil(marker: Buffer, limit: number): Promise<Buffer> {
    for (;;) {
      const index = this.#buffer.indexOf(marker);
      if (index !== -1) {
        if (index > limit) {
          throw invalidBody();
        }
        const head = this.#buffer.subarray(0, index);
        this.#buffer = this.#buffer.subarray(index + marker.length);
        return Buffer.from(head);
      }
      if (this.#buffer.length > limit + marker.length) {
        throw invalidBody();
      }
      if (!(await this.#fill())) {
        throw invalidBody();
      }
    }
  }

  /** Consume exactly `length` bytes. */
  async #take(length: number): Promise<Buffer> {
    while (this.#buffer.length < length) {
      if (!(await this.#fill())) {
        throw invalidBody();
      }
    }
    const head = Buffer.from(this.#buffer.subarray(0, length));
    this.#buffer = this.#buffer.subarray(length);
    return head;
  }

  /**
   * After a delimiter: `true` when another part follows (CRLF), `false` when
   * the body is closing (`--`).
   */
  async #afterDelimiter(): Promise<boolean> {
    const marker = await this.#take(2);
    if (marker.equals(CRLF)) {
      return true;
    }
    if (marker.equals(CLOSE_MARKER)) {
      this.#finished = true;
      return false;
    }
    throw invalidBody();
  }

  /** Read the leading snapshot field, rejecting any other first part. */
  async readSnapshot(): Promise<string> {
    // Prefix a CRLF so the first boundary matches the same delimiter as the rest.
    this.#buffer = Buffer.from(CRLF);
    await this.#readUntil(this.#delimiter, MAX_PREAMBLE_BYTES);
    if (!(await this.#afterDelimiter())) {
      throw invalidBody('Upload is missing a snapshot');
    }
    const headers = parsePartHeaders(await this.#readUntil(HEADER_END, MAX_PART_HEADER_BYTES));
    if (headers.name !== COMPONENT_UPLOAD_SNAPSHOT_FIELD || headers.filename !== undefined) {
      throw invalidBody('Upload is missing a snapshot');
    }
    const value = await this.#readUntil(this.#delimiter, MAX_UPLOAD_SNAPSHOT_BYTES);
    const snapshot = value.toString('utf8');
    if (snapshot === '') {
      throw invalidBody('Upload is missing a snapshot');
    }
    return snapshot;
  }

  /**
   * Open the file part that follows the snapshot, or `undefined` when the body
   * closes without one. The returned stream ends at the closing boundary and
   * errors (value-free) on a truncated body, an extra part, or the byte cap.
   */
  async openFile(): Promise<MultipartFilePart | undefined> {
    if (this.#finished || !(await this.#afterDelimiter())) {
      return undefined;
    }
    const headers = parsePartHeaders(await this.#readUntil(HEADER_END, MAX_PART_HEADER_BYTES));
    if (headers.name !== COMPONENT_UPLOAD_FILE_FIELD || headers.filename === undefined) {
      throw invalidBody('Upload file field is invalid');
    }
    const contentType = headers.contentType?.split(';')[0]?.trim();
    return {
      contentType:
        contentType === undefined || contentType === '' ? 'application/octet-stream' : contentType,
      filename: headers.filename === '' ? 'upload' : headers.filename,
      stream: Readable.from(this.#fileChunks(), { objectMode: false }),
    };
  }

  /** Yield the file body up to the next delimiter, which must close the body. */
  async *#fileChunks(): AsyncGenerator<Buffer> {
    const delimiter = this.#delimiter;
    for (;;) {
      const index = this.#buffer.indexOf(delimiter);
      if (index !== -1) {
        if (index > 0) {
          yield Buffer.from(this.#buffer.subarray(0, index));
        }
        this.#buffer = this.#buffer.subarray(index + delimiter.length);
        if (await this.#afterDelimiter()) {
          throw invalidBody('Upload carries unexpected fields');
        }
        return;
      }
      // Keep a delimiter-length tail: the boundary may straddle two chunks.
      const safe = this.#buffer.length - (delimiter.length - 1);
      if (safe > 0) {
        yield Buffer.from(this.#buffer.subarray(0, safe));
        this.#buffer = this.#buffer.subarray(safe);
      }
      if (!(await this.#fill())) {
        throw invalidBody();
      }
    }
  }

  /** Release the request body; safe to call at any point and more than once. */
  async cancel(): Promise<void> {
    try {
      await this.#reader.cancel();
    } catch {
      // A body that already errored or closed has nothing left to release.
    }
  }
}

/** Open an incremental reader over an upload request, or fail value-free. */
export function openMultipartUpload(request: Request, maxBodyBytes: number): MultipartUploadReader {
  const boundary = boundaryFrom(request.headers.get('content-type') ?? '');
  const body = request.body;
  if (body === null) {
    throw invalidBody();
  }
  return new MultipartUploadReader(body, boundary, maxBodyBytes);
}
