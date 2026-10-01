/**
 * Media library: an upload/list/update/remove surface over the existing
 * {@link Disk} seam.
 *
 * {@link createMediaLibrary} is the content-agnostic counterpart to
 * ActiveStorage: it stores the bytes on a caller-supplied `Disk` (the
 * core `jsails/filesystem` seam) and keeps a **process-local** index of
 * {@link MediaAsset} metadata keyed by id. The index is an injectable
 * {@link MediaIndex}: the in-memory default suits tests and single-process
 * demos, and `createDatabaseMediaIndex` persists it without changing the
 * library surface.
 *
 * ## Paths
 *
 * An asset is stored under an **id-prefixed** key
 * `<pathPrefix>/<id>/<filename>`. The id is produced by the injectable
 * `nextId` (default: a URL-safe random id) and is required to match the safe
 * `[A-Za-z0-9_-]+` alphabet; the filename is validated as a single, non-hidden
 * basename with no separators, control, or Windows-reserved characters, and the
 * `pathPrefix` is a single safe segment. The composed key therefore always
 * passes the `Disk` key validation: no traversal, absolute, or hidden segment,
 * and no control characters. A caller-supplied filename that fails these
 * checks raises a value-free `path_rejected` {@link MediaLibraryError} rather than
 * being silently sanitized.
 *
 * ## Errors
 *
 * Every failure that reaches a caller is a value-free {@link MediaLibraryError}: no
 * id, path, filename, MIME type, or data is ever embedded in a message.
 * Construction-time option mistakes throw `TypeError`, matching the other
 * factory helpers.
 *
 * ## Content checks
 *
 * The declared MIME type is a claim, not a fact. `upload` sniffs the bytes
 * (`Media.detect` from `jsails/support/server`): a sniffed type must be on the
 * allowlist and agree with the declared one, and is the type recorded; a
 * declared binary type (an image, audio, video, or PDF) whose bytes sniff as
 * nothing is refused, because a real file of that type always has a signature.
 * The filename's extension is rewritten to the recorded type's canonical one
 * when the two disagree, so a server that maps extensions to types can never
 * serve `payload.html` holding "PNG" bytes as HTML. Image dimensions are read
 * from the bytes (`Media.imageSize`) in preference to caller-supplied ones,
 * and an image above `maxPixels` is refused before any transform sees it.
 *
 * ## Listing
 *
 * `query` filters and pages through the index (`MediaIndex.query`), so an
 * admin page or picker never loads the whole table; an index without `query`
 * falls back to filtering `list()` in memory.
 *
 * ## Not in scope
 *
 * Metadata (alt/caption/dimensions) lives only in the index, while the `Disk`
 * holds only the raw bytes — the two can diverge if a record is removed out of
 * band, which is accepted: the library never reconciles the two.
 */

import { DiskError, isDisk, type Disk } from 'jsails/filesystem';
import { JsailsError, isNonNegativeInteger, isPositiveInteger } from 'jsails/plugin-sdk';
import { CONTROL_CHARS, Encoding } from 'jsails/support';
import { Media } from 'jsails/support/server';

/**
 * A stored media asset's metadata. Immutable descriptor: every field is
 * read-only and instances returned by the library are frozen. `alt` and
 * `caption` are editable only through {@link MediaLibrary.update}, which
 * returns a fresh asset (and bumps `updatedAt`); timestamps are ISO-8601.
 */
export interface MediaAsset {
  /** Opaque asset id (from `nextId`), also the first path segment. */
  readonly id: string;
  /** Name of the disk the bytes live on (the `diskName` option). */
  readonly disk: string;
  /** Key on the disk where the bytes are stored. */
  readonly path: string;
  /** Original, sanitized basename recorded at upload time. */
  readonly filename: string;
  /** Lowercased MIME type without parameters (`image/png`). */
  readonly mimeType: string;
  /** Byte length of the payload at upload time. */
  readonly size: number;
  /** Width in pixels: read from the image bytes, else caller-supplied. */
  readonly width?: number;
  /** Height in pixels: read from the image bytes, else caller-supplied. */
  readonly height?: number;
  /** Accessible alternative text (editable via `update`). */
  readonly alt: string;
  /** Longer caption/description (editable via `update`). */
  readonly caption: string;
  /** Upload timestamp as ISO-8601. */
  readonly createdAt: string;
  /** Last-update timestamp as ISO-8601 (equals `createdAt` until `update`). */
  readonly updatedAt: string;
}

/** Payload handed to {@link MediaLibrary.upload}. */
export interface MediaUploadInput {
  /** Raw payload bytes (a Node `Buffer` is a `Uint8Array` and is accepted). */
  readonly bytes: Uint8Array;
  /** Original filename; validated as a single safe basename. */
  readonly filename: string;
  /** MIME type; validated and checked against the allowlist. */
  readonly mimeType: string;
  /** Optional alternative text (trimmed, length-capped). */
  readonly alt?: string;
  /** Optional caption (trimmed, length-capped). */
  readonly caption?: string;
  /** Width in pixels, used only when the bytes do not reveal it. */
  readonly width?: number;
  /** Height in pixels, used only when the bytes do not reveal it. */
  readonly height?: number;
}

/**
 * The raw bytes of a stored asset plus the metadata needed to render or serve
 * them. `mimeType` and `filename` are the values recorded at upload time (the
 * filename is a validated safe basename), never caller input.
 */
export interface MediaContent {
  /** The asset's raw payload bytes. */
  readonly bytes: Uint8Array;
  /** Lowercased MIME type without parameters, as recorded. */
  readonly mimeType: string;
  /** Original, sanitized basename recorded at upload time. */
  readonly filename: string;
}

/** A readable view of an asset's bytes, or one byte range of them. */
export interface MediaStream {
  readonly stream: ReadableStream<Uint8Array>;
  /** The whole asset's size in bytes. */
  readonly size: number;
  /** First byte delivered. */
  readonly start: number;
  /** Last byte delivered (inclusive). */
  readonly end: number;
  readonly mimeType: string;
  readonly filename: string;
}

/** An inclusive byte range, as HTTP `Range: bytes=start-end` expresses it. */
export interface MediaRange {
  readonly start: number;
  /** Inclusive end; omitted means "to the end". */
  readonly end?: number;
}

/** Filter and paging input for {@link MediaLibrary.query} and {@link MediaIndex.query}. */
export interface MediaQuery {
  /** Substring matched case-insensitively against filename, alt, and caption. */
  readonly q?: string;
  /** MIME filter: exact `image/png` or wildcard `image/*`. */
  readonly mime?: string;
  /** Page size; at most {@link MAX_MEDIA_PAGE_SIZE}. */
  readonly limit: number;
  /** Matches to skip before the page. */
  readonly offset?: number;
}

/** One page of a {@link MediaQuery}, ordered by filename then id. */
export interface MediaQueryPage {
  readonly assets: readonly MediaAsset[];
  /** Every match, not just this page. */
  readonly total: number;
}

/** The largest page {@link MediaLibrary.query} returns. */
export const MAX_MEDIA_PAGE_SIZE = 1000;

/** Editable metadata for {@link MediaLibrary.update}. */
export interface MediaPatch {
  /** New alternative text (trimmed, length-capped). */
  readonly alt?: string;
  /** New caption (trimmed, length-capped). */
  readonly caption?: string;
}

/**
 * The metadata index. Implementations own persistence: the default
 * {@link createMemoryMediaIndex} keeps records in a `Map` for the lifetime of
 * the process; `createDatabaseMediaIndex` persists them. Because records hold
 * only the id-to-asset mapping, a custom index must never invent ids or paths
 * — it stores what the library hands it.
 */
export interface MediaIndex {
  /** All assets in insertion order. */
  list(): Promise<readonly MediaAsset[]>;
  /**
   * One filtered page, ordered by filename then id. Optional: without it the
   * library filters `list()` in memory, which reads the whole index.
   */
  query?(query: MediaQuery): Promise<MediaQueryPage>;
  /** The asset with the given id, or `undefined` when absent. */
  get(id: string): Promise<MediaAsset | undefined>;
  /** Store (or replace) an asset under its id. */
  put(asset: MediaAsset): Promise<void>;
  /** Remove the asset with the given id (a no-op when absent). */
  remove(id: string): Promise<void>;
}

/** The media library surface. */
export interface MediaLibrary {
  /** Validate and store a payload, returning the frozen asset. */
  upload(input: MediaUploadInput): Promise<MediaAsset>;
  /** All assets in insertion order (frozen descriptors). */
  list(): Promise<readonly MediaAsset[]>;
  /** One filtered page of assets plus the total match count. */
  query(query: MediaQuery): Promise<MediaQueryPage>;
  /** The asset with the given id, or `undefined` when absent. */
  get(id: string): Promise<MediaAsset | undefined>;
  /**
   * Stream an asset's bytes (or one byte range) without buffering them when
   * the disk can stream; otherwise the bytes are read whole and wrapped.
   */
  stream(asset: MediaAsset, range?: MediaRange): Promise<MediaStream>;
  /**
   * Read the asset's bytes from the disk. A missing id raises `not_found`;
   * disk failures raise the equivalent value-free {@link MediaLibraryError}. Callers
   * that only need to preview are expected to bound this by the recorded
   * `size` first, since the whole payload is read into memory.
   */
  content(id: string): Promise<MediaContent>;
  /** Update alt/caption, returning the fresh asset or `undefined` when absent. */
  update(id: string, patch: MediaPatch): Promise<MediaAsset | undefined>;
  /** Delete the bytes and the index record. Throws `not_found` when absent. */
  remove(id: string): Promise<void>;
}

/** Machine-readable reason for a {@link MediaLibraryError}. */
export type MediaLibraryErrorCode =
  | 'invalid_input'
  | 'too_large'
  | 'unsupported_content_type'
  | 'not_found'
  | 'path_rejected'
  | 'io_failed'
  | 'not_initialized'
  | 'missing_table'
  | 'invalid_range';

/** Raised for every media failure that reaches a caller. Messages are value-free. */
export class MediaLibraryError extends JsailsError {
  constructor(
    readonly code: MediaLibraryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Default upload size cap: 960 KiB. An upload reaches the library through an
 * HTTP body, and the framework's default request body cap is 1 MiB; the
 * difference leaves room for multipart framing and the form's other fields.
 * An app that raises `maxBodyBytes` raises this with it.
 */
const DEFAULT_MAX_BYTES = 1024 * 1024 - 64 * 1024;

/** Default pixel cap: 100 megapixels (a 10 000 × 10 000 image). */
const DEFAULT_MAX_PIXELS = 100_000_000;

/**
 * Declared types whose files always carry a byte signature. A payload
 * declared as one of these that sniffs as nothing is not what it claims to be.
 * Text-based formats (SVG, CSV, plain text) have no signature and are taken as
 * declared.
 */
function requiresSignature(mimeType: string): boolean {
  if (mimeType === 'image/svg+xml') {
    return false;
  }
  return (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/') ||
    mimeType === 'application/pdf'
  );
}

/** Legacy and vendor spellings that name the same format as the sniffer's type. */
const MIME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'application/x-pdf': 'application/pdf',
});

/** The type a browser declares when it does not know: defer to the bytes. */
const UNKNOWN_TYPE = 'application/octet-stream';

/**
 * Default MIME allowlist: common image and document types. SVG is deliberately
 * excluded (it can carry scripts); an app that wants it opts in explicitly by
 * passing its own `allowedTypes`.
 */
const DEFAULT_ALLOWED_TYPES: readonly string[] = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
]);

/** Options for {@link createMediaLibrary}. */
export interface MediaLibraryOptions {
  /** The disk that stores the bytes. */
  readonly disk: Disk;
  /** Name recorded on each asset (the `filesystem` plugin's disk name). Defaults to `media`. */
  readonly diskName?: string;
  /** The metadata index. Defaults to an in-memory index. */
  readonly metadata?: MediaIndex;
  /** Clock used to stamp `createdAt`/`updatedAt`. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Id generator. Defaults to a URL-safe random id. Must return safe ids. */
  readonly nextId?: () => string;
  /**
   * Upload size cap in bytes. Defaults to 960 KiB, which fits under the
   * framework's default 1 MiB request body cap with room for multipart
   * framing; raise both together.
   */
  readonly maxBytes?: number;
  /** Largest accepted image, as width × height. Defaults to 100 megapixels. */
  readonly maxPixels?: number;
  /**
   * The variant resolver for this library's disk. When set, `remove` purges
   * every variant derived from the asset, so hashed variant objects are not
   * left behind.
   */
  readonly variants?: { purge(sourceKey: string): Promise<void> };
  /**
   * MIME allowlist; entries are exact or `type/*`. Defaults to the common
   * image types plus PDF, without SVG.
   */
  readonly allowedTypes?: readonly string[];
  /** First path segment (a single safe identifier). Defaults to `media`. */
  readonly pathPrefix?: string;
}

/** Maximum recorded filename length. */
const MAX_FILENAME_LENGTH = 255;
/** Maximum alt text length. */
const MAX_ALT_LENGTH = 500;
/** Maximum caption length. */
const MAX_CAPTION_LENGTH = 5000;

/** Path separators plus Windows-reserved filename characters. */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|]/;
/** Windows drive prefix (`C:`), invalid at the start of a path. */
const WINDOWS_DRIVE = /^[A-Za-z]:/;
/** The id alphabet the library accepts for path safety. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
/** A single safe path segment (identifier-ish with `.`/`_`/`-`). */
const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * True when `pattern` matches `mimeType`. A pattern is an exact type
 * (`image/png`) or a wildcard (`image/*`, or `*` for any). Matching is
 * case-insensitive.
 */
export function mimeMatches(pattern: string, mimeType: string): boolean {
  const p = pattern.toLowerCase();
  const m = mimeType.toLowerCase();
  if (p === '*' || p === '*/*') {
    return true;
  }
  if (p.endsWith('/*')) {
    return m.startsWith(p.slice(0, -2));
  }
  return p === m;
}

/** Validate an `allowedTypes` entry: an exact `type/subtype` or a wildcard. */
function assertMimePattern(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError('allowedTypes entries must be strings');
  }
  const pattern = value.trim().toLowerCase();
  if (pattern === '' || CONTROL_CHARS.test(pattern)) {
    throw new TypeError('allowedTypes entries must be non-empty and control-free');
  }
  if (pattern === '*' || pattern === '*/*') {
    return;
  }
  if (!/^[a-z0-9!#$&^_.+-]+\/(\*|[a-z0-9!#$&^_.+-]+)$/.test(pattern)) {
    throw new TypeError('allowedTypes entries must be "type/subtype" or "type/*"');
  }
}

/** Validate that a filename is a single, safe, non-hidden basename. */
function assertSafeFilename(value: string): void {
  if (value.length === 0) {
    throw new MediaLibraryError('invalid_input', 'filename must be a non-empty string');
  }
  if (value.length > MAX_FILENAME_LENGTH) {
    throw new MediaLibraryError('invalid_input', 'filename is too long');
  }
  if (CONTROL_CHARS.test(value) || UNSAFE_NAME_CHARS.test(value)) {
    throw new MediaLibraryError('path_rejected', 'filename must be a single safe basename');
  }
  if (value === '.' || value === '..' || value.startsWith('.')) {
    throw new MediaLibraryError(
      'path_rejected',
      'filename must not be hidden or a traversal segment',
    );
  }
  if (WINDOWS_DRIVE.test(value)) {
    throw new MediaLibraryError('path_rejected', 'filename must not use a drive prefix');
  }
}

/** Validate a generated id as path-safe, raising value-free on violation. */
function assertSafeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new MediaLibraryError('path_rejected', 'an asset id must be a safe identifier');
  }
}

/** Validate a non-empty asset id argument, value-free. */
function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '') {
    throw new MediaLibraryError('invalid_input', 'id must be a non-empty string');
  }
}

/** Trim and normalize a MIME type, validating structural shape. */
function normalizeMimeType(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MediaLibraryError('invalid_input', 'mimeType must be a non-empty string');
  }
  if (CONTROL_CHARS.test(value) || value.includes(';')) {
    throw new MediaLibraryError('invalid_input', 'mimeType must be a bare type/subtype');
  }
  const mime = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) {
    throw new MediaLibraryError('invalid_input', 'mimeType must be a bare type/subtype');
  }
  return mime;
}

/** Trim, cap, and validate an optional text field (alt/caption). */
function normalizeTextField(value: unknown, max: number, label: string): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new MediaLibraryError('invalid_input', `${label} must be a string when present`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new MediaLibraryError('invalid_input', `${label} is too long`);
  }
  return text;
}

/** Validate an optional positive-integer dimension, returning `undefined` when absent. */
function normalizeDimension(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPositiveInteger(value)) {
    throw new MediaLibraryError(
      'invalid_input',
      `${label} must be a positive integer when present`,
    );
  }
  return value;
}

/** Reduce a caught {@link DiskError} to the equivalent value-free {@link MediaLibraryError}. */
function toMediaLibraryError(error: unknown): MediaLibraryError {
  if (error instanceof DiskError) {
    switch (error.code) {
      case 'invalid_key':
        return new MediaLibraryError('path_rejected', 'disk rejected the asset path');
      case 'not_found':
        return new MediaLibraryError('not_found', 'asset bytes not found');
      case 'too_large':
        return new MediaLibraryError('too_large', 'disk capacity exceeded');
      case 'io_failed':
        return new MediaLibraryError('io_failed', 'disk operation failed', { cause: error });
    }
  }
  return new MediaLibraryError('io_failed', 'disk operation failed', { cause: error });
}

/**
 * Filter and page a set of assets in memory: the {@link MediaIndex.query}
 * fallback, and the in-memory index's implementation. Ordering is filename
 * then id by code point, matching `selectMedia`.
 */
export function queryAssets(assets: readonly MediaAsset[], query: MediaQuery): MediaQueryPage {
  const term = (query.q ?? '').trim().toLowerCase();
  const mime = (query.mime ?? '').trim().toLowerCase();
  const matched = assets
    .filter((asset) => {
      if (mime !== '' && !mimeMatches(mime, asset.mimeType)) {
        return false;
      }
      return (
        term === '' ||
        asset.filename.toLowerCase().includes(term) ||
        asset.alt.toLowerCase().includes(term) ||
        asset.caption.toLowerCase().includes(term)
      );
    })
    .sort((a, b) => {
      if (a.filename !== b.filename) {
        return a.filename < b.filename ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const offset = query.offset ?? 0;
  return { assets: matched.slice(offset, offset + query.limit), total: matched.length };
}

/** Validate a query's paging, raising value-free on a bad page. */
function assertQuery(query: MediaQuery): void {
  if (query === null || typeof query !== 'object') {
    throw new MediaLibraryError('invalid_input', 'query requires an object');
  }
  if (!isPositiveInteger(query.limit) || query.limit > MAX_MEDIA_PAGE_SIZE) {
    throw new MediaLibraryError('invalid_input', 'limit must be a positive integer up to 1000');
  }
  if (query.offset !== undefined && !isNonNegativeInteger(query.offset)) {
    throw new MediaLibraryError('invalid_input', 'offset must be a non-negative integer');
  }
}

/** The part of a disk that can stream a range; checked structurally. */
interface RangeStreamingDisk {
  stream(
    key: string,
    options?: { range?: MediaRange },
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number; start: number; end: number }>;
}

function canStream(disk: Disk): disk is Disk & RangeStreamingDisk {
  return typeof (disk as Partial<RangeStreamingDisk>).stream === 'function';
}

/** Resolve a range against a size, or throw `invalid_range`. */
function resolveMediaRange(
  range: MediaRange | undefined,
  size: number,
): { start: number; end: number } {
  if (range === undefined) {
    return { start: 0, end: size - 1 };
  }
  if (
    !isNonNegativeInteger(range.start) ||
    range.start >= size ||
    (range.end !== undefined && (!isNonNegativeInteger(range.end) || range.end < range.start))
  ) {
    throw new MediaLibraryError('invalid_range', 'the requested range is not satisfiable');
  }
  return { start: range.start, end: Math.min(range.end ?? size - 1, size - 1) };
}

/** Replace a filename's extension (or append one when it has none). */
function withExtension(filename: string, extension: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem}.${extension}`;
}

/**
 * The default {@link MediaIndex}: an in-memory `Map` keyed by id. Records live
 * for the lifetime of the process and are never serialized; use
 * `createDatabaseMediaIndex` when assets must survive a restart.
 */
export function createMemoryMediaIndex(): MediaIndex {
  const records = new Map<string, MediaAsset>();
  return {
    async list() {
      return [...records.values()];
    },
    async query(query) {
      return queryAssets([...records.values()], query);
    },
    async get(id) {
      return records.get(id);
    },
    async put(asset) {
      records.set(asset.id, asset);
    },
    async remove(id) {
      records.delete(id);
    },
  };
}

/**
 * Create a media library over a `Disk` and a metadata index.
 *
 * Validation is eager for option mistakes (`TypeError`) and per-operation for
 * the value-free {@link MediaLibraryError}s detailed in the module doc. The returned
 * {@link MediaAsset}s are frozen descriptors.
 */
export function createMediaLibrary(options: MediaLibraryOptions): MediaLibrary {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createMediaLibrary requires an options object');
  }
  if (!isDisk(options.disk)) {
    throw new TypeError('disk must implement the Disk contract');
  }
  if (options.diskName !== undefined) {
    if (typeof options.diskName !== 'string' || options.diskName.trim() === '') {
      throw new TypeError('diskName must be a non-empty string');
    }
  }
  if (options.metadata !== undefined && !isMediaIndex(options.metadata)) {
    throw new TypeError('metadata must implement the MediaIndex contract');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }
  if (options.nextId !== undefined && typeof options.nextId !== 'function') {
    throw new TypeError('nextId must be a function');
  }
  if (options.pathPrefix !== undefined) {
    if (typeof options.pathPrefix !== 'string' || !SAFE_SEGMENT.test(options.pathPrefix)) {
      throw new TypeError('pathPrefix must be a single safe segment');
    }
  }
  if (options.maxBytes !== undefined && !isNonNegativeInteger(options.maxBytes)) {
    throw new TypeError('maxBytes must be a non-negative integer');
  }
  if (options.maxPixels !== undefined && !isPositiveInteger(options.maxPixels)) {
    throw new TypeError('maxPixels must be a positive integer');
  }
  if (
    options.variants !== undefined &&
    (options.variants === null || typeof options.variants.purge !== 'function')
  ) {
    throw new TypeError('variants must expose purge');
  }

  const disk = options.disk;
  const diskName = options.diskName ?? 'media';
  const index = options.metadata ?? createMemoryMediaIndex();
  const now = options.now ?? (() => new Date());
  const nextId = options.nextId ?? (() => Encoding.nanoid());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const variants = options.variants;
  const allowedTypes = options.allowedTypes ?? DEFAULT_ALLOWED_TYPES;
  const pathPrefix = options.pathPrefix ?? 'media';

  for (const entry of allowedTypes) {
    assertMimePattern(entry);
  }

  /** Stamp the current instant as an ISO string from the injected clock. */
  function stamp(): string {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new MediaLibraryError('invalid_input', 'now must return a valid Date');
    }
    return value.toISOString();
  }

  /** Produce and validate a path-safe id from the injected generator. */
  function makeId(): string {
    const id = nextId();
    assertSafeId(id);
    return id;
  }

  /** Build the frozen public descriptor from component parts. */
  function freezeAsset(
    asset: MediaAsset,
    overrides?: { readonly alt?: string; readonly caption?: string; readonly updatedAt?: string },
  ): MediaAsset {
    return Object.freeze({
      id: asset.id,
      disk: asset.disk,
      path: asset.path,
      filename: asset.filename,
      mimeType: asset.mimeType,
      size: asset.size,
      ...(asset.width === undefined ? {} : { width: asset.width }),
      ...(asset.height === undefined ? {} : { height: asset.height }),
      alt: overrides?.alt ?? asset.alt,
      caption: overrides?.caption ?? asset.caption,
      createdAt: asset.createdAt,
      updatedAt: overrides?.updatedAt ?? asset.updatedAt,
    });
  }

  async function upload(input: MediaUploadInput): Promise<MediaAsset> {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new MediaLibraryError('invalid_input', 'upload requires an input object');
    }
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new MediaLibraryError('invalid_input', 'upload bytes must be a non-empty byte array');
    }
    if (typeof input.filename !== 'string' || input.filename.trim() === '') {
      throw new MediaLibraryError('invalid_input', 'filename must be a non-empty string');
    }
    const declaredFilename = input.filename.trim();
    assertSafeFilename(declaredFilename);
    const declared = normalizeMimeType(input.mimeType);
    if (input.bytes.byteLength > maxBytes) {
      throw new MediaLibraryError('too_large', 'media exceeds the upload size limit');
    }
    const mimeType = await recordedType(input.bytes, MIME_ALIASES[declared] ?? declared);
    if (!allowedTypes.some((pattern) => mimeMatches(pattern, mimeType))) {
      throw new MediaLibraryError('unsupported_content_type', 'media type is not allowed');
    }
    const filename = reconcileExtension(declaredFilename, mimeType);
    const alt = normalizeTextField(input.alt, MAX_ALT_LENGTH, 'alt');
    const caption = normalizeTextField(input.caption, MAX_CAPTION_LENGTH, 'caption');
    const declaredWidth = normalizeDimension(input.width, 'width');
    const declaredHeight = normalizeDimension(input.height, 'height');
    const measured = mimeType.startsWith('image/') ? Media.imageSize(input.bytes) : undefined;
    if (measured !== undefined && measured.width * measured.height > maxPixels) {
      throw new MediaLibraryError('too_large', 'image dimensions exceed the pixel limit');
    }
    const width = measured?.width ?? declaredWidth;
    const height = measured?.height ?? declaredHeight;

    const id = makeId();
    const path = `${pathPrefix}/${id}/${filename}`;
    const createdAt = stamp();
    try {
      await disk.put(path, input.bytes, { contentType: mimeType });
    } catch (error) {
      throw toMediaLibraryError(error);
    }

    const asset = freezeAsset({
      id,
      disk: diskName,
      path,
      filename,
      mimeType,
      size: input.bytes.byteLength,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      alt,
      caption,
      createdAt,
      updatedAt: createdAt,
    });
    await index.put(asset);
    return asset;
  }

  /**
   * The type to record: the sniffed one, which must agree with the declared
   * type unless the client declared none; or the declared one for a format
   * without a byte signature. See the module comment.
   */
  async function recordedType(bytes: Uint8Array, declared: string): Promise<string> {
    let sniffed: string | undefined;
    try {
      sniffed = (await Media.detect(bytes))?.mime;
    } catch {
      sniffed = undefined;
    }
    if (sniffed === undefined) {
      if (declared === UNKNOWN_TYPE || requiresSignature(declared)) {
        throw new MediaLibraryError(
          'unsupported_content_type',
          'media content does not match its declared type',
        );
      }
      return declared;
    }
    if (declared !== UNKNOWN_TYPE && declared !== sniffed) {
      throw new MediaLibraryError(
        'unsupported_content_type',
        'media content does not match its declared type',
      );
    }
    return sniffed;
  }

  /** Give the filename the recorded type's extension when its own names another type. */
  function reconcileExtension(filename: string, mimeType: string): string {
    const implied = Media.mime(filename);
    if (implied === mimeType || (implied !== false && MIME_ALIASES[implied] === mimeType)) {
      return filename;
    }
    const extension = Media.extension(mimeType);
    if (implied === false && !filename.includes('.')) {
      return filename;
    }
    return extension === false ? filename : withExtension(filename, extension);
  }

  async function list(): Promise<readonly MediaAsset[]> {
    return index.list();
  }

  async function query(input: MediaQuery): Promise<MediaQueryPage> {
    assertQuery(input);
    if (index.query !== undefined) {
      return index.query(input);
    }
    return queryAssets(await index.list(), input);
  }

  async function stream(asset: MediaAsset, range?: MediaRange): Promise<MediaStream> {
    const meta = { mimeType: asset.mimeType, filename: asset.filename };
    try {
      if (canStream(disk)) {
        try {
          return {
            ...(await disk.stream(asset.path, range === undefined ? {} : { range })),
            ...meta,
          };
        } catch (error) {
          if (
            error instanceof JsailsError &&
            (error as { code?: unknown }).code === 'invalid_range'
          ) {
            throw new MediaLibraryError('invalid_range', 'the requested range is not satisfiable');
          }
          throw error;
        }
      }
      const bytes = await disk.get(asset.path);
      const { start, end } = resolveMediaRange(range, bytes.byteLength);
      return {
        stream: new Blob([new Uint8Array(bytes.subarray(start, end + 1))]).stream(),
        size: bytes.byteLength,
        start,
        end,
        ...meta,
      };
    } catch (error) {
      if (error instanceof MediaLibraryError) {
        throw error;
      }
      throw toMediaLibraryError(error);
    }
  }

  async function get(id: string): Promise<MediaAsset | undefined> {
    assertId(id);
    return index.get(id);
  }

  async function content(id: string): Promise<MediaContent> {
    assertId(id);
    const asset = await index.get(id);
    if (asset === undefined) {
      throw new MediaLibraryError('not_found', 'media asset not found');
    }
    let bytes: Uint8Array;
    try {
      bytes = await disk.get(asset.path);
    } catch (error) {
      throw toMediaLibraryError(error);
    }
    return { bytes, mimeType: asset.mimeType, filename: asset.filename };
  }

  async function update(id: string, patch: MediaPatch): Promise<MediaAsset | undefined> {
    assertId(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new MediaLibraryError('invalid_input', 'update requires a patch object');
    }
    // Validate any present fields first: a malformed patch fails even when the
    // id is missing. Absent fields preserve the current value.
    const nextAlt =
      patch.alt === undefined ? undefined : normalizeTextField(patch.alt, MAX_ALT_LENGTH, 'alt');
    const nextCaption =
      patch.caption === undefined
        ? undefined
        : normalizeTextField(patch.caption, MAX_CAPTION_LENGTH, 'caption');

    const current = await index.get(id);
    if (current === undefined) {
      return undefined;
    }
    if (nextAlt === undefined && nextCaption === undefined) {
      return current;
    }
    const updated = freezeAsset(current, {
      ...(nextAlt === undefined ? {} : { alt: nextAlt }),
      ...(nextCaption === undefined ? {} : { caption: nextCaption }),
      updatedAt: stamp(),
    });
    await index.put(updated);
    return updated;
  }

  async function remove(id: string): Promise<void> {
    assertId(id);
    const current = await index.get(id);
    if (current === undefined) {
      throw new MediaLibraryError('not_found', 'media asset not found');
    }
    try {
      await disk.delete(current.path);
    } catch (error) {
      throw toMediaLibraryError(error);
    }
    await index.remove(id);
    // Variants go last: a purge failure leaves stray cache objects, never an
    // index record pointing at deleted bytes.
    try {
      await variants?.purge(current.path);
    } catch (error) {
      throw toMediaLibraryError(error);
    }
  }

  return { upload, list, query, get, stream, content, update, remove };
}

/** True for a value with the {@link MediaIndex} surface the library uses. */
function isMediaIndex(value: unknown): value is MediaIndex {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<MediaIndex>;
  return (
    typeof candidate.list === 'function' &&
    typeof candidate.get === 'function' &&
    typeof candidate.put === 'function' &&
    typeof candidate.remove === 'function'
  );
}
