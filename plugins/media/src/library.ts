/**
 * Media library: an upload/list/update/remove surface over the existing
 * {@link Disk} seam.
 *
 * {@link createMediaLibrary} is the content-agnostic counterpart to
 * ActiveStorage: it stores the bytes on a caller-supplied `Disk` (the
 * `jsails/filesystem` seam) and keeps a **process-local** index of
 * {@link MediaAsset} metadata keyed by id. This slice deliberately adds no
 * database dependency; the index is an injectable {@link MediaIndex} so a
 * persistent index (database-backed) can replace the in-memory default later
 * without changing the library surface.
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
 * checks raises a value-free `path_rejected` {@link MediaError} rather than
 * being silently sanitized.
 *
 * ## Errors
 *
 * Every failure that reaches a caller is a value-free {@link MediaError}: no
 * id, path, filename, MIME type, or data is ever embedded in a message.
 * Construction-time option mistakes throw `TypeError`, matching the other
 * factory helpers.
 *
 * ## Not in scope
 *
 * Width and height are **not** derived (JSails ships no image library): they
 * are optional caller-supplied metadata on {@link MediaUploadInput}. Metadata
 * (alt/caption/dimensions) lives only in the index, while the `Disk` holds
 * only the raw bytes — the two can diverge if a record is removed out of band,
 * which is an accepted property of the process-local slice.
 */

import { DiskError, type Disk } from 'jsails/filesystem';
import { Encoding } from 'jsails/support';
import { CONTROL_CHARS } from 'jsails/support';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  /** Lower-cased MIME type without parameters (`image/png`). */
  readonly mimeType: string;
  /** Byte length of the payload at upload time. */
  readonly size: number;
  /** Optional width in pixels (caller-supplied; never derived). */
  readonly width?: number;
  /** Optional height in pixels (caller-supplied; never derived). */
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
  /** Optional width in pixels (caller-supplied; never derived). */
  readonly width?: number;
  /** Optional height in pixels (caller-supplied; never derived). */
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
  /** Lower-cased MIME type without parameters, as recorded. */
  readonly mimeType: string;
  /** Original, sanitized basename recorded at upload time. */
  readonly filename: string;
}

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
 * the process; a database-backed implementation can be injected later. Because
 * records hold only the id-to-asset mapping, a custom index must never invent
 * ids or paths — it stores what the library hands it.
 */
export interface MediaIndex {
  /** All assets in insertion order. */
  list(): Promise<readonly MediaAsset[]>;
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
  /** The asset with the given id, or `undefined` when absent. */
  get(id: string): Promise<MediaAsset | undefined>;
  /**
   * Read the asset's bytes from the disk. A missing id raises `not_found`;
   * disk failures raise the equivalent value-free {@link MediaError}. Callers
   * that only need to preview are expected to bound this by the recorded
   * `size` first, since the whole payload is read into memory.
   */
  content(id: string): Promise<MediaContent>;
  /** Update alt/caption, returning the fresh asset or `undefined` when absent. */
  update(id: string, patch: MediaPatch): Promise<MediaAsset | undefined>;
  /** Delete the bytes and the index record. Throws `not_found` when absent. */
  remove(id: string): Promise<void>;
}

/** Machine-readable reason for a {@link MediaError}. */
export type MediaErrorCode =
  | 'invalid_input'
  | 'too_large'
  | 'unsupported_type'
  | 'not_found'
  | 'path_rejected'
  | 'disk_failed';

/** Raised for every media failure that reaches a caller. Messages are value-free. */
export class MediaError extends Error {
  readonly code: MediaErrorCode;

  constructor(code: MediaErrorCode, message: string) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Configuration defaults and validation
// ---------------------------------------------------------------------------

/** Default upload size cap (5 MiB). */
export const DEFAULT_MAX_MEDIA_BYTES = 5 * 1024 * 1024;

/**
 * Default MIME allowlist: common image and document types. SVG is deliberately
 * excluded (it can carry scripts); an app that wants it opts in explicitly by
 * passing its own `allowedTypes`.
 */
export const DEFAULT_ALLOWED_MEDIA_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
];

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
  /** Upload size cap in bytes (default {@link DEFAULT_MAX_MEDIA_BYTES}). */
  readonly maxBytes?: number;
  /** MIME allowlist (default {@link DEFAULT_ALLOWED_MEDIA_TYPES}); entries are exact or `type/*`. */
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

/** C0 controls plus DEL — never valid in a filename or MIME type. */
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
 * case-insensitive; both values are expected already lower-cased.
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
    throw new MediaError('invalid_input', 'filename must be a non-empty string');
  }
  if (value.length > MAX_FILENAME_LENGTH) {
    throw new MediaError('invalid_input', 'filename is too long');
  }
  if (CONTROL_CHARS.test(value) || UNSAFE_NAME_CHARS.test(value)) {
    throw new MediaError('path_rejected', 'filename must be a single safe basename');
  }
  if (value === '.' || value === '..' || value.startsWith('.')) {
    throw new MediaError('path_rejected', 'filename must not be hidden or a traversal segment');
  }
  if (WINDOWS_DRIVE.test(value)) {
    throw new MediaError('path_rejected', 'filename must not use a drive prefix');
  }
}

/** Validate a generated id as path-safe, raising value-free on violation. */
function assertSafeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new MediaError('path_rejected', 'an asset id must be a safe identifier');
  }
}

/** Trim and normalize a MIME type, validating structural shape. */
function normalizeMimeType(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MediaError('invalid_input', 'mimeType must be a non-empty string');
  }
  if (CONTROL_CHARS.test(value) || value.includes(';')) {
    throw new MediaError('invalid_input', 'mimeType must be a bare type/subtype');
  }
  const mime = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) {
    throw new MediaError('invalid_input', 'mimeType must be a bare type/subtype');
  }
  return mime;
}

/** Trim, cap, and validate an optional text field (alt/caption). */
function normalizeTextField(value: unknown, max: number, label: string): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new MediaError('invalid_input', `${label} must be a string when present`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new MediaError('invalid_input', `${label} is too long`);
  }
  return text;
}

/** Validate an optional positive-integer dimension, returning `undefined` when absent. */
function normalizeDimension(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new MediaError('invalid_input', `${label} must be a positive integer when present`);
  }
  return value;
}

/** Reduce a caught {@link DiskError} to the equivalent value-free {@link MediaError}. */
function toMediaError(error: unknown): MediaError {
  if (error instanceof DiskError) {
    switch (error.code) {
      case 'invalid_key':
        return new MediaError('path_rejected', 'disk rejected the asset path');
      case 'not_found':
        return new MediaError('not_found', 'asset bytes not found');
      case 'max_bytes':
        return new MediaError('too_large', 'disk capacity exceeded');
      case 'io':
        return new MediaError('disk_failed', 'disk operation failed');
    }
  }
  return new MediaError('disk_failed', 'disk operation failed');
}

// ---------------------------------------------------------------------------
// In-memory index
// ---------------------------------------------------------------------------

/**
 * The default {@link MediaIndex}: an in-memory `Map` keyed by id. Records live
 * for the lifetime of the process and are never serialized — this is the
 * process-local slice, replaceable by a persistent index later.
 */
export function createMemoryMediaIndex(): MediaIndex {
  const records = new Map<string, MediaAsset>();
  return {
    async list() {
      return [...records.values()];
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

// ---------------------------------------------------------------------------
// createMediaLibrary
// ---------------------------------------------------------------------------

/**
 * Build a media library over a `Disk` and a metadata index.
 *
 * Validation is eager for option mistakes (`TypeError`) and per-operation for
 * the value-free {@link MediaError}s detailed in the module doc. The returned
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

  const disk = options.disk;
  const diskName = options.diskName ?? 'media';
  const index = options.metadata ?? createMemoryMediaIndex();
  const now = options.now ?? (() => new Date());
  const nextId = options.nextId ?? (() => Encoding.nanoid());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const allowedTypes = options.allowedTypes ?? DEFAULT_ALLOWED_MEDIA_TYPES;
  const pathPrefix = options.pathPrefix ?? 'media';

  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative integer');
  }
  for (const entry of allowedTypes) {
    assertMimePattern(entry);
  }

  /** Stamp the current instant as an ISO string from the injected clock. */
  function stamp(): string {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new MediaError('invalid_input', 'now must return a valid Date');
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
      throw new MediaError('invalid_input', 'upload requires an input object');
    }
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new MediaError('invalid_input', 'upload bytes must be a non-empty byte array');
    }
    if (typeof input.filename !== 'string' || input.filename.trim() === '') {
      throw new MediaError('invalid_input', 'filename must be a non-empty string');
    }
    const filename = input.filename.trim();
    assertSafeFilename(filename);
    const mimeType = normalizeMimeType(input.mimeType);
    if (!allowedTypes.some((pattern) => mimeMatches(pattern, mimeType))) {
      throw new MediaError('unsupported_type', 'media type is not allowed');
    }
    if (input.bytes.byteLength > maxBytes) {
      throw new MediaError('too_large', 'media exceeds the upload size limit');
    }
    const alt = normalizeTextField(input.alt, MAX_ALT_LENGTH, 'alt');
    const caption = normalizeTextField(input.caption, MAX_CAPTION_LENGTH, 'caption');
    const width = normalizeDimension(input.width, 'width');
    const height = normalizeDimension(input.height, 'height');

    const id = makeId();
    const path = `${pathPrefix}/${id}/${filename}`;
    const createdAt = stamp();
    try {
      await disk.put(path, input.bytes, { contentType: mimeType });
    } catch (error) {
      throw toMediaError(error);
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

  async function list(): Promise<readonly MediaAsset[]> {
    return index.list();
  }

  async function get(id: string): Promise<MediaAsset | undefined> {
    if (typeof id !== 'string' || id === '') {
      throw new MediaError('invalid_input', 'id must be a non-empty string');
    }
    return index.get(id);
  }

  async function content(id: string): Promise<MediaContent> {
    if (typeof id !== 'string' || id === '') {
      throw new MediaError('invalid_input', 'id must be a non-empty string');
    }
    const asset = await index.get(id);
    if (asset === undefined) {
      throw new MediaError('not_found', 'media asset not found');
    }
    let bytes: Uint8Array;
    try {
      bytes = await disk.get(asset.path);
    } catch (error) {
      throw toMediaError(error);
    }
    return {
      bytes,
      mimeType: asset.mimeType,
      filename: asset.filename,
    };
  }

  async function update(id: string, patch: MediaPatch): Promise<MediaAsset | undefined> {
    if (typeof id !== 'string' || id === '') {
      throw new MediaError('invalid_input', 'id must be a non-empty string');
    }
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new MediaError('invalid_input', 'update requires a patch object');
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
    if (typeof id !== 'string' || id === '') {
      throw new MediaError('invalid_input', 'id must be a non-empty string');
    }
    const current = await index.get(id);
    if (current === undefined) {
      throw new MediaError('not_found', 'media asset not found');
    }
    try {
      await disk.delete(current.path);
    } catch (error) {
      throw toMediaError(error);
    }
    await index.remove(id);
  }

  return { upload, list, get, content, update, remove };
}

/** True for a value with the {@link Disk} surface the library uses. */
function isDisk(value: unknown): value is Disk {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<Disk>;
  return (
    typeof candidate.put === 'function' &&
    typeof candidate.get === 'function' &&
    typeof candidate.exists === 'function' &&
    typeof candidate.delete === 'function' &&
    typeof candidate.list === 'function' &&
    typeof candidate.size === 'function'
  );
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
