/**
 * The streaming `multipart/form-data` reader behind `ctx.body.multipart()`.
 *
 * `Request.formData()` materialises every part, files included, before the
 * caller sees one, so a body is held whole in memory. This reader pulls the
 * body as the caller asks: parts come in wire order, a text field whole
 * (bounded by `maxFieldBytes`), a file as a stream that reads straight from
 * the body. At most one chunk of the body plus a delimiter is held, whatever
 * the size of the file, and nothing is read before the first part is asked
 * for.
 *
 * Limits are those of the route's {@link MultipartSpec}, enforced as the
 * bytes arrive: the part count (checked at the delimiter that would open one
 * more part, so the file before it fails rather than completes), the files
 * per field, each field's and each file's bytes, and each part's header
 * block. Crossing one fails with `multipart.too_large` and calls `onLimit`
 * first, which marks the request's body budget exceeded: the request is
 * answered 413 whatever the handler does with the error. A file in a field
 * the spec does not declare is `multipart.unexpected_file`, a file of a media
 * type its field does not accept `multipart.unsupported_type`, and a
 * malformed body `multipart.invalid` (each a 422). The whole body is bounded
 * by the request's budget, which this reader reads through.
 *
 * A client that stops sending is cut off: a read from the body that waits
 * `idleMs` fails with `multipart.idle`, and `signal` (the request's: client
 * gone, deadline passed) with `multipart.aborted`. The timer runs only while
 * the reader waits on the client, never while the caller is busy with a
 * chunk it already has.
 *
 * The first failure is final: it errors the file stream being read, releases
 * the body, and every later step rethrows it. Moving to the next part while
 * a file stream is unfinished reads and discards the rest of that file
 * (still counted against its cap and the budget) and errors the old stream
 * with `multipart.part_abandoned`, so a reader still holding it sees an
 * error, never a short file that looks complete. Ending the iteration early
 * (`break`) leaves a file stream being read readable to its end.
 *
 * Header parsing follows the WHATWG multipart/form-data parser: parameter
 * values are quoted strings in which a browser writes `"`, CR and LF as
 * `%22`, `%0D` and `%0A`; `filename*` is ignored (RFC 7578 section 4.2).
 * Names, values, filenames and claimed media types are untrusted input, and
 * no error echoes any of them.
 */

import type { MultipartPart } from '../contracts/http.js';
import type { JsailsError } from '../errors/jsails-error.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import {
  acceptsMediaType,
  DEFAULT_MULTIPART_FILE_COUNT,
  DEFAULT_MULTIPART_HEADER_BYTES,
  DEFAULT_MULTIPART_IDLE_MS,
  type MultipartFileSpec,
  type MultipartSpec,
} from './route-limits.js';

const MULTIPART_ERRORS = {
  invalid: {
    kind: 'invalid',
    audience: 'client',
    message: 'The multipart body is malformed ({problem}).',
    context: { problem: ['content_type', 'framing', 'headers', 'truncated'] },
  },
  too_large: {
    kind: 'too_large',
    audience: 'client',
    message: 'The multipart body exceeds its {limit} limit.',
    context: { limit: ['parts', 'files', 'field', 'file', 'headers'] },
  },
  unexpected_file: {
    kind: 'invalid',
    audience: 'client',
    message: 'The multipart body carries a file in a field that takes none.',
  },
  unsupported_type: {
    kind: 'invalid',
    audience: 'client',
    message: 'The multipart body carries a file of a media type its field does not accept.',
  },
  idle: {
    kind: 'timeout',
    audience: 'client',
    message: 'The request body stopped arriving.',
  },
  aborted: {
    kind: 'aborted',
    audience: 'client',
    message: 'The request ended while its body was being read.',
  },
  part_abandoned: {
    kind: 'internal',
    message: 'a file part was read after the multipart reader moved past it',
    suggestion: "read or cancel each file part's stream before asking for the next part",
  },
} as const;

/**
 * The multipart codes, `multipart.*`: a malformed body (`invalid`), a
 * declared limit crossed (`too_large`, answered 413), a file where the route
 * takes none (`unexpected_file`) or of a type it does not accept
 * (`unsupported_type`), a body that stopped arriving (`idle`) or a request
 * that ended (`aborted`), and a file part read after the reader moved on
 * (`part_abandoned`).
 *
 * @public
 */
export const MultipartErrors: ErrorRegistry<'multipart', typeof MULTIPART_ERRORS> = defineErrors(
  'multipart',
  MULTIPART_ERRORS,
);

type InvalidProblem = 'content_type' | 'framing' | 'headers' | 'truncated';
type LimitName = 'parts' | 'files' | 'field' | 'file' | 'headers';

function invalid(problem: InvalidProblem): JsailsError {
  return new MultipartErrors.Error('invalid', { problem });
}

/** How a reader is driven: the request's signal, and who hears of a crossed limit. */
export interface MultipartReadOptions {
  /** Aborts every read from the body (the client went away, the deadline passed). */
  readonly signal?: AbortSignal;
  /** Called once, before the error is raised, when a declared limit is crossed. */
  readonly onLimit?: () => void;
}

/** RFC 2046 boundary: 1-70 characters from a restricted set, not ending in a space. */
const BOUNDARY_PATTERN = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;
/** An RFC 9110 token: a header field name, a parameter name, a media type's halves. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;
const SP = 0x20;
const HTAB = 0x09;
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const DEFAULT_FILE_TYPE = 'application/octet-stream';
const DONE: IteratorReturnResult<undefined> = Object.freeze({
  done: true as const,
  value: undefined,
});

/** `value` with surrounding spaces and tabs (HTTP's optional whitespace) removed. */
function trimOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** A header value split into its leading value (lowercased) and its parameters. */
interface ParameterizedValue {
  readonly value: string;
  readonly parameters: ReadonlyMap<string, string>;
}

/**
 * Parse `value; name=token; name="quoted"`. Parameter names are lowercased;
 * a quoted value runs to the next `"` and is kept verbatim. `undefined` for
 * a malformed list, a parameter named twice included.
 */
function parseParameterized(header: string): ParameterizedValue | undefined {
  const first = header.indexOf(';');
  const value = trimOws(first === -1 ? header : header.slice(0, first)).toLowerCase();
  const parameters = new Map<string, string>();
  let at = first === -1 ? header.length : first;
  while (at < header.length) {
    // `at` is on a `;`.
    at += 1;
    while (header[at] === ' ' || header[at] === '\t') at += 1;
    if (at >= header.length) break;
    const equals = header.indexOf('=', at);
    if (equals === -1) return undefined;
    const name = trimOws(header.slice(at, equals)).toLowerCase();
    if (!TOKEN.test(name) || parameters.has(name)) return undefined;
    at = equals + 1;
    while (header[at] === ' ' || header[at] === '\t') at += 1;
    let parameter: string;
    if (header[at] === '"') {
      const close = header.indexOf('"', at + 1);
      if (close === -1) return undefined;
      parameter = header.slice(at + 1, close);
      at = close + 1;
      while (header[at] === ' ' || header[at] === '\t') at += 1;
      if (at < header.length && header[at] !== ';') return undefined;
    } else {
      const end = header.indexOf(';', at);
      parameter = trimOws(header.slice(at, end === -1 ? header.length : end));
      if (parameter === '') return undefined;
      at = end === -1 ? header.length : end;
    }
    parameters.set(name, parameter);
  }
  return { value, parameters };
}

/** The boundary of a `multipart/form-data` content type, or a value-free failure. */
function boundaryOf(contentType: string | null): string {
  const parsed = contentType === null ? undefined : parseParameterized(contentType);
  const boundary = parsed?.parameters.get('boundary');
  if (
    parsed?.value !== 'multipart/form-data' ||
    boundary === undefined ||
    !BOUNDARY_PATTERN.test(boundary)
  ) {
    throw invalid('content_type');
  }
  return boundary;
}

/** A Content-Disposition parameter as the WHATWG parser reads it: `%0A`, `%0D`, `%22` decoded. */
function formValue(raw: string): string {
  return raw.replace(/%0A|%0D|%22/g, (escape) =>
    escape === '%0A' ? '\n' : escape === '%0D' ? '\r' : '"',
  );
}

/** What a part's header block says about it. */
interface PartHeaders {
  readonly name: string;
  readonly filename: string | undefined;
  readonly contentType: string | undefined;
}

/** Parse one part's header block (the bytes before its blank line). */
function parsePartHeaders(block: Buffer): PartHeaders {
  let disposition: string | undefined;
  let contentType: string | undefined;
  for (const line of block.toString('utf8').split('\r\n')) {
    const colon = line.indexOf(':');
    const field = colon === -1 ? '' : line.slice(0, colon);
    if (!TOKEN.test(field) || /[\r\n]/.test(line)) throw invalid('headers');
    const value = trimOws(line.slice(colon + 1));
    switch (field.toLowerCase()) {
      case 'content-disposition':
        if (disposition !== undefined) throw invalid('headers');
        disposition = value;
        break;
      case 'content-type':
        if (contentType !== undefined) throw invalid('headers');
        contentType = value;
        break;
      default:
        break;
    }
  }
  const parsed = disposition === undefined ? undefined : parseParameterized(disposition);
  const name = parsed?.parameters.get('name');
  if (parsed?.value !== 'form-data' || name === undefined) throw invalid('headers');
  const filename = parsed.parameters.get('filename');
  return {
    name: formValue(name),
    filename: filename === undefined ? undefined : formValue(filename),
    contentType,
  };
}

/** A file part's claimed media type, lowercased and without parameters. */
function fileMediaType(contentType: string | undefined): string {
  if (contentType === undefined) return DEFAULT_FILE_TYPE;
  const type = parseParameterized(contentType)?.value;
  const slash = type?.indexOf('/') ?? -1;
  if (
    type === undefined ||
    slash === -1 ||
    !TOKEN.test(type.slice(0, slash)) ||
    !TOKEN.test(type.slice(slash + 1))
  ) {
    throw invalid('headers');
  }
  return type;
}

/** `chunk` as a Buffer over the same memory. */
function asBuffer(chunk: Uint8Array): Buffer {
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/** `bytes` as a plain Uint8Array over the same memory. */
function asBytes(bytes: Buffer): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The bytes read from the body and not yet consumed. An append writes only
 * past the bytes already held, into memory this queue allocated (unpooled),
 * so a view handed out of it is never written over; when that space runs
 * out, the held bytes move to a new allocation at least twice their size,
 * so a value gathered from many small chunks costs linear copying.
 */
class PendingBytes {
  #store: Buffer = Buffer.alloc(0);
  #start = 0;
  #end = 0;

  get length(): number {
    return this.#end - this.#start;
  }

  /** The byte at `index`, counted from the first unconsumed one. */
  at(index: number): number | undefined {
    return index < this.length ? this.#store[this.#start + index] : undefined;
  }

  /** Where `marker` starts, at or after `from`, or -1. */
  indexOf(marker: Buffer, from: number): number {
    return this.#store.subarray(this.#start, this.#end).indexOf(marker, from);
  }

  /** Consume the first `length` bytes, returning a view of them. */
  take(length: number): Buffer {
    const head = this.#store.subarray(this.#start, this.#start + length);
    this.#start += length;
    return head;
  }

  append(chunk: Uint8Array): void {
    const added = chunk.byteLength;
    if (this.length === 0) {
      // Adopted as it is: a source chunk is never written into, and it has
      // no room past its end for an append to use.
      this.#store = asBuffer(chunk);
      this.#start = 0;
      this.#end = added;
      return;
    }
    if (this.#end + added <= this.#store.length) {
      this.#store.set(chunk, this.#end);
      this.#end += added;
      return;
    }
    const held = this.length;
    const store = Buffer.allocUnsafeSlow(Math.max(held + added, 2 * held));
    this.#store.copy(store, 0, this.#start, this.#end);
    store.set(chunk, held);
    this.#store = store;
    this.#start = 0;
    this.#end = held + added;
  }
}

/** Where the reader stands between parts. */
type Stage = 'start' | 'part' | 'closing' | 'done';

/** A file part being streamed. */
interface FileState {
  readonly maxBytes: number;
  bytes: number;
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  /** Its closing delimiter was consumed. */
  done: boolean;
  /** Its stream was cancelled, or errored by the reader moving on: what is left is discarded. */
  detached: boolean;
}

/**
 * A pull reader over one multipart body: an async iterator of its parts.
 * Every step (a part, a file chunk, a cancel) runs alone, in call order.
 */
export class MultipartReader implements AsyncIterableIterator<MultipartPart, undefined> {
  readonly #source: ReadableStreamDefaultReader<Uint8Array>;
  readonly #delimiter: Buffer;
  readonly #spec: MultipartSpec;
  readonly #headerBytes: number;
  readonly #idleMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #onLimit: (() => void) | undefined;
  readonly #pending = new PendingBytes();
  readonly #fileCounts = new Map<string, number>();
  #queue: Promise<unknown> = Promise.resolve();
  #stage: Stage = 'start';
  #ended = false;
  #released = false;
  #returned = false;
  #failure: { readonly error: unknown } | undefined;
  #limitCrossed = false;
  #parts = 0;
  #active: FileState | undefined;

  constructor(
    body: ReadableStream<Uint8Array>,
    boundary: string,
    spec: MultipartSpec,
    options: MultipartReadOptions,
  ) {
    this.#source = body.getReader();
    // Every delimiter but the first ends the CRLF that closes the part
    // before it; the queue starts with one, so the first matches too.
    this.#delimiter = Buffer.from(`\r\n--${boundary}`, 'latin1');
    this.#pending.append(CRLF);
    this.#spec = spec;
    this.#headerBytes = spec.maxHeaderBytes ?? DEFAULT_MULTIPART_HEADER_BYTES;
    this.#idleMs = spec.idleMs ?? DEFAULT_MULTIPART_IDLE_MS;
    this.#signal = options.signal;
    this.#onLimit = options.onLimit;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  next(): Promise<IteratorResult<MultipartPart, undefined>> {
    return this.#exclusive(() => this.#next());
  }

  /**
   * End the iteration. The body is released now, or, while a file stream is
   * still being read, once that stream ends.
   */
  return(): Promise<IteratorResult<MultipartPart, undefined>> {
    return this.#exclusive(async () => {
      this.#returned = true;
      const active = this.#active;
      if (active === undefined || active.done || active.detached) await this.#finish();
      return DONE;
    });
  }

  /**
   * Stop now: the body is released at once (a read waiting on the client
   * settles), the iteration ends, and a file stream still open errors with
   * `multipart.part_abandoned`. Never rejects.
   */
  async cancel(): Promise<void> {
    this.#returned = true;
    const active = this.#active;
    if (active !== undefined && !active.done && !active.detached) {
      active.detached = true;
      active.controller?.error(new MultipartErrors.Error('part_abandoned'));
    }
    await this.#release();
  }

  /** Run `step` once every step before it settled. */
  #exclusive<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(step);
    // The queue only orders the steps; each step's outcome goes to its caller.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #next(): Promise<IteratorResult<MultipartPart, undefined>> {
    if (this.#returned) return DONE;
    if (this.#failure !== undefined) throw this.#failure.error;
    if (this.#stage === 'done') return DONE;
    try {
      await this.#leaveActive();
      if (this.#stage === 'start') {
        await this.#readUntil(this.#delimiter, this.#headerBytes, () => invalid('framing'));
        await this.#afterDelimiter();
      }
      if (this.#stage === 'closing') {
        await this.#drainEpilogue();
        await this.#finish();
        return DONE;
      }
      return { done: false, value: await this.#readPart() };
    } catch (error) {
      throw await this.#fail(error);
    }
  }

  /** Discard what is left of a file part the caller moved past, failing its stream. */
  async #leaveActive(): Promise<void> {
    const active = this.#active;
    if (active === undefined) return;
    if (!active.done && !active.detached) {
      active.detached = true;
      active.controller?.error(new MultipartErrors.Error('part_abandoned'));
    }
    while (!active.done) await this.#fileChunk(active);
    this.#active = undefined;
  }

  /** Read one part's headers and, for a field, its value. */
  async #readPart(): Promise<MultipartPart> {
    this.#parts += 1;
    await this.#want(2);
    if (this.#pending.at(0) === CR && this.#pending.at(1) === LF) throw invalid('headers');
    const headers = parsePartHeaders(
      await this.#readUntil(HEADER_END, this.#headerBytes, () => this.#limit('headers')),
    );
    const { name, filename } = headers;
    const files = this.#spec.files;
    const declared: MultipartFileSpec | undefined = Object.hasOwn(files, name)
      ? files[name]
      : undefined;
    if (declared === undefined) {
      if (filename !== undefined) throw new MultipartErrors.Error('unexpected_file');
      const value = await this.#readUntil(this.#delimiter, this.#spec.maxFieldBytes, () =>
        this.#limit('field'),
      );
      const text = value.toString('utf8');
      await this.#afterDelimiter();
      return Object.freeze({ kind: 'field', name, value: text });
    }
    const count = (this.#fileCounts.get(name) ?? 0) + 1;
    if (count > (declared.maxCount ?? DEFAULT_MULTIPART_FILE_COUNT)) throw this.#limit('files');
    this.#fileCounts.set(name, count);
    const contentType = fileMediaType(headers.contentType);
    if (
      declared.contentTypes !== undefined &&
      !acceptsMediaType(declared.contentTypes, contentType)
    ) {
      throw new MultipartErrors.Error('unsupported_type');
    }
    const file: FileState = {
      maxBytes: declared.maxBytes,
      bytes: 0,
      controller: undefined,
      done: false,
      detached: false,
    };
    this.#active = file;
    return Object.freeze({ kind: 'file', name, filename, contentType, stream: this.#stream(file) });
  }

  /** The stream of `file`'s bytes: pulled from the body as it is read. */
  #stream(file: FileState): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          file.controller = controller;
        },
        pull: (controller) => this.#exclusive(() => this.#pullFile(file, controller)),
        cancel: () => {
          // Marked now: a pull already queued must not enqueue into a
          // cancelled stream.
          file.detached = true;
          return this.#exclusive(async () => {
            if (this.#returned) await this.#finish();
          });
        },
      },
      { highWaterMark: 0 },
    );
  }

  async #pullFile(
    file: FileState,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    if (file.detached || file.done) return;
    try {
      const chunk = await this.#fileChunk(file);
      if (file.detached) return;
      if (chunk !== undefined) {
        controller.enqueue(asBytes(chunk));
        return;
      }
      controller.close();
      if (this.#returned) await this.#finish();
    } catch (error) {
      // `#fail` errors this stream with the failure.
      await this.#fail(error);
    }
  }

  /**
   * The next run of `file`'s bytes, or `undefined` once its closing delimiter
   * and what follows it are consumed. Bytes are counted against its cap
   * before they are handed out.
   */
  async #fileChunk(file: FileState): Promise<Buffer | undefined> {
    const delimiter = this.#delimiter;
    for (;;) {
      const index = this.#pending.indexOf(delimiter, 0);
      if (index === 0) {
        this.#pending.take(delimiter.length);
        await this.#afterDelimiter();
        file.done = true;
        return undefined;
      }
      // Without a match, keep a delimiter's length but one: it may straddle chunks.
      const ready = index === -1 ? this.#pending.length - (delimiter.length - 1) : index;
      if (ready > 0) {
        file.bytes += ready;
        if (file.bytes > file.maxBytes) throw this.#limit('file');
        return this.#pending.take(ready);
      }
      if (!(await this.#fill())) throw invalid('truncated');
    }
  }

  /**
   * After a delimiter: `--` closes the body; otherwise optional padding and
   * a CRLF open the next part, which must be within `maxParts`.
   */
  async #afterDelimiter(): Promise<void> {
    await this.#want(2);
    if (this.#pending.at(0) === DASH && this.#pending.at(1) === DASH) {
      this.#pending.take(2);
      this.#stage = 'closing';
      return;
    }
    let padding = 0;
    for (;;) {
      await this.#want(padding + 1);
      const byte = this.#pending.at(padding);
      if (byte !== SP && byte !== HTAB) break;
      padding += 1;
      if (padding > this.#headerBytes) throw invalid('framing');
    }
    await this.#want(padding + 2);
    if (this.#pending.at(padding) !== CR || this.#pending.at(padding + 1) !== LF) {
      throw invalid('framing');
    }
    this.#pending.take(padding + 2);
    if (this.#parts >= this.#spec.maxParts) throw this.#limit('parts');
    this.#stage = 'part';
  }

  /** Read past the close delimiter to the end of the body, which may hold a short epilogue. */
  async #drainEpilogue(): Promise<void> {
    let epilogue = this.#pending.length;
    this.#pending.take(epilogue);
    while (epilogue <= this.#headerBytes && (await this.#fill())) {
      epilogue += this.#pending.length;
      this.#pending.take(this.#pending.length);
    }
    if (epilogue > this.#headerBytes) throw invalid('framing');
  }

  /**
   * Consume the bytes before `marker` and the marker, returning those bytes;
   * `overflow()` once more than `limit` would come before it.
   */
  async #readUntil(marker: Buffer, limit: number, overflow: () => Error): Promise<Buffer> {
    let from = 0;
    for (;;) {
      const index = this.#pending.indexOf(marker, from);
      if (index !== -1) {
        if (index > limit) throw overflow();
        const head = this.#pending.take(index);
        this.#pending.take(marker.length);
        return head;
      }
      // A match can only start where the marker would still fit.
      from = Math.max(0, this.#pending.length - (marker.length - 1));
      if (from > limit) throw overflow();
      if (!(await this.#fill())) throw invalid('truncated');
    }
  }

  /** Read until at least `length` bytes are held, failing at the end of the body. */
  async #want(length: number): Promise<void> {
    while (this.#pending.length < length) {
      if (!(await this.#fill())) throw invalid('truncated');
    }
  }

  /** Append the body's next chunk; `false` at its end. */
  async #fill(): Promise<boolean> {
    if (this.#ended) return false;
    const step = await this.#read();
    if (step.done) {
      this.#ended = true;
      return false;
    }
    if (step.value.byteLength > 0) this.#pending.append(step.value);
    return true;
  }

  /**
   * One read from the body, cut off by the idle bound or the signal. The
   * timer runs only for the length of this read.
   */
  async #read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const signal = this.#signal;
    if (signal?.aborted === true) throw new MultipartErrors.Error('aborted');
    const reading = this.#source.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<'idle' | 'aborted'>((resolve) => {
      timer = setTimeout(() => resolve('idle'), this.#idleMs);
      onAbort = () => resolve('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([reading, interrupted]);
      if (outcome === 'idle' || outcome === 'aborted') {
        // The abandoned read settles when the failure releases the body; the
        // failure raised here is what the caller gets, not its outcome.
        reading.catch(() => undefined);
        throw new MultipartErrors.Error(outcome);
      }
      return outcome;
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    }
  }

  /** A crossed limit's error, after telling `onLimit` (once). */
  #limit(limit: LimitName): JsailsError {
    if (!this.#limitCrossed) {
      this.#limitCrossed = true;
      this.#onLimit?.();
    }
    return new MultipartErrors.Error('too_large', { limit });
  }

  /**
   * Make `error` final, unless a failure already is: the file stream being
   * read errors with it, and the body is released. Returns the final error.
   */
  async #fail(error: unknown): Promise<unknown> {
    if (this.#failure !== undefined) return this.#failure.error;
    this.#failure = { error };
    const active = this.#active;
    if (active !== undefined && !active.detached) {
      active.detached = true;
      active.controller?.error(error);
    }
    await this.#finish();
    return error;
  }

  /** Stop reading: nothing more is parsed, and the body is released. */
  async #finish(): Promise<void> {
    this.#stage = 'done';
    this.#active = undefined;
    await this.#release();
  }

  /** Release the body, once. */
  async #release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    // A body that already failed has nothing left to release; the failure
    // that ended it was raised already.
    await this.#source.cancel().catch(() => undefined);
  }
}

/**
 * A reader over the `multipart/form-data` body `body`, whose request
 * declares `contentType`, under `spec`. The content type is checked now
 * (`multipart.invalid`, `content_type`) and the body locked; nothing is read
 * until the first part is asked for. `spec` is trusted: a route's comes
 * checked from its declaration.
 */
export function readMultipart(
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  spec: MultipartSpec,
  options: MultipartReadOptions = {},
): MultipartReader {
  const boundary = boundaryOf(contentType);
  return new MultipartReader(body ?? emptyBody(), boundary, spec, options);
}

/** A body with no bytes, for a request that carries none. */
function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}
