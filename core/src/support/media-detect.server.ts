/**
 * The server-only `Media` namespace: MIME detection from bytes or names and image dimension probing.
 */

import mime from 'mime-types';
import { fileTypeFromBuffer } from 'file-type';
import { imageSize } from 'image-size';

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

const MEDIA_ERRORS = {
  expected_bytes: {
    kind: 'internal',
    message: '{operation}: expected a Uint8Array',
    context: { operation: ['Media.detect', 'Media.imageSize'] },
  },
  detect_failed: {
    kind: 'internal',
    message: 'Media.detect: could not read the buffer',
  },
} as const;

/**
 * The `Media` namespace's codes, `media.*`: a non-byte argument and a
 * detector that failed on the buffer. An unrecognized format is a value
 * (`undefined`), not an error.
 *
 * @public
 */
export const MediaErrors: ErrorRegistry<'media', typeof MEDIA_ERRORS> = defineErrors(
  'media',
  MEDIA_ERRORS,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MediaType {
  /** Sniffed MIME type, e.g. `image/png`. */
  readonly mime: string;
  /** Canonical file extension without a leading dot, e.g. `png`. */
  readonly extension: string;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
  /** Detected image type, e.g. `png`, when the parser can determine it. */
  readonly type?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a path or bare extension to its MIME type.
 *
 * Returns `false` when the type cannot be determined (mirrors `mime-types`).
 */
export function mimeOf(pathOrExt: string): string | false {
  return mime.lookup(pathOrExt);
}

/**
 * Map a MIME type to its canonical extension (without a leading dot).
 *
 * Returns `false` when the type is unknown (mirrors `mime-types`).
 */
export function extension(mimeType: string): string | false {
  return mime.extension(mimeType);
}

/**
 * Sniff a buffer's media type from its magic bytes.
 *
 * Returns `undefined` when the format is unrecognized — a "no match" is a
 * value, not an error.
 */
export async function detect(buffer: Uint8Array): Promise<MediaType | undefined> {
  if (!(buffer instanceof Uint8Array)) {
    throw new MediaErrors.Error('expected_bytes', { operation: 'Media.detect' });
  }
  try {
    const result = await fileTypeFromBuffer(buffer);
    if (!result) return undefined;
    return { mime: result.mime, extension: result.ext };
  } catch (error) {
    throw new MediaErrors.Error('detect_failed', {}, { cause: error });
  }
}

/**
 * Read image dimensions from a buffer.
 *
 * Returns `undefined` when the buffer is not a recognizable image — a "no
 * match" is a value, not an error.
 */
export function imageSizeOf(buffer: Uint8Array): ImageSize | undefined {
  if (!(buffer instanceof Uint8Array)) {
    throw new MediaErrors.Error('expected_bytes', { operation: 'Media.imageSize' });
  }
  try {
    const result = imageSize(buffer);
    if (result.width === undefined || result.height === undefined) return undefined;
    return { width: result.width, height: result.height, type: result.type };
  } catch {
    // A malformed/unsupported image is a "no result", not a failure.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Media: Readonly<{
  mime: typeof mimeOf;
  extension: typeof extension;
  detect: typeof detect;
  imageSize: typeof imageSizeOf;
}> = Object.freeze({
  mime: mimeOf,
  extension,
  detect,
  imageSize: imageSizeOf,
});
