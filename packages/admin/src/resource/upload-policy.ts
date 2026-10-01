/**
 * The server-side rules a `file` field upload must pass before it is written:
 * a size cap, a content type sniffed from the bytes (the client's declared
 * type is never trusted or stored), a refusal of active content, the field's
 * `accept` list, and a collision-free storage key.
 *
 * Active content (HTML, SVG, XML, JavaScript) is refused outright, by sniffed
 * bytes, by extension, and by declared type alike: a disk served from the app
 * origin would otherwise turn an editor's upload into stored script. The
 * stored content type is the sniffed one (or `application/octet-stream`), so a
 * served file cannot be reinterpreted as markup.
 *
 * Keys are `<field>/<random id>/<basename>`, so two records uploading the same
 * filename never share (or overwrite) one object. The module performs no I/O.
 */

import { randomUUID } from 'node:crypto';

import { DEFAULT_MAX_UPLOAD_BYTES } from './field-types.js';

/** The upload limits of one `file` field. */
export interface UploadRules {
  readonly accept?: string;
  readonly maxBytes?: number;
}

/** A checked upload: the bytes plus the content type to store them under. */
export interface AcceptedUpload {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** A refused upload with its value-free form message. */
export interface RefusedUpload {
  readonly ok: false;
  readonly message: string;
}

/** Message for an upload over the field's byte cap. */
export const UPLOAD_TOO_LARGE_MESSAGE = 'File is too large';

/** Message for an upload whose type is refused. */
export const UPLOAD_TYPE_MESSAGE = 'File type is not allowed';

/** Extensions whose files a browser can execute as markup or script. */
const ACTIVE_EXTENSIONS = new Set([
  'htm',
  'html',
  'xhtml',
  'shtml',
  'svg',
  'svgz',
  'xml',
  'xsl',
  'xslt',
  'js',
  'mjs',
  'cjs',
]);

/** Declared types a browser can execute as markup or script. */
const ACTIVE_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'text/ecmascript',
]);

/** Inert text types inferred from the extension when the bytes carry no signature. */
const TEXT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
});

/** Fallback stored type for bytes with no recognized signature. */
const OCTET_STREAM = 'application/octet-stream';

/** Check one upload against its field's rules. */
export function checkUpload(
  bytes: Uint8Array,
  filename: string,
  declaredType: string,
  rules: UploadRules,
): AcceptedUpload | RefusedUpload {
  if (bytes.byteLength > (rules.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES)) {
    return { ok: false, message: UPLOAD_TOO_LARGE_MESSAGE };
  }
  const extension = fileExtension(filename);
  const sniffed = sniffContentType(bytes);
  if (
    sniffed === 'text/html' ||
    ACTIVE_EXTENSIONS.has(extension) ||
    ACTIVE_TYPES.has(declaredType.toLowerCase().split(';')[0]!.trim())
  ) {
    return { ok: false, message: UPLOAD_TYPE_MESSAGE };
  }
  const contentType = sniffed ?? TEXT_TYPES[extension] ?? OCTET_STREAM;
  if (rules.accept !== undefined && !matchesAccept(rules.accept, contentType, extension)) {
    return { ok: false, message: UPLOAD_TYPE_MESSAGE };
  }
  return { ok: true, bytes, contentType };
}

/**
 * Identify the bytes by signature. Leading markup (`<` after optional BOM and
 * whitespace) reports `text/html`, which the caller always refuses; unknown
 * bytes report `undefined`.
 */
export function sniffContentType(bytes: Uint8Array): string | undefined {
  const startsWith = (signature: readonly number[], offset = 0): boolean =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (startsWith([0x66, 0x74, 0x79, 0x70], 4)) return 'video/mp4';
  if (looksLikeMarkup(bytes)) return 'text/html';
  return undefined;
}

/** Whether the first non-whitespace byte (after a UTF-8 BOM) opens a tag. */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  let index = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const limit = Math.min(bytes.byteLength, 1024);
  while (index < limit) {
    const byte = bytes[index]!;
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c) {
      index += 1;
      continue;
    }
    return byte === 0x3c;
  }
  return false;
}

/** Whether a type/extension satisfies a comma-separated `accept` list. */
export function matchesAccept(accept: string, contentType: string, extension: string): boolean {
  const [major] = contentType.split('/');
  return accept
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
    .some((entry) => {
      if (entry.startsWith('.')) return entry.slice(1) === extension;
      if (entry.endsWith('/*')) return entry.slice(0, -2) === major;
      return entry === contentType;
    });
}

/** The lowercased extension of a filename's basename (`''` when none). */
function fileExtension(filename: string): string {
  const basename = sanitizeSegment(filename);
  const dot = basename.lastIndexOf('.');
  return dot <= 0 ? '' : basename.slice(dot + 1).toLowerCase();
}

/** A collision-free disk key: `<field>/<random id>/<sanitized basename>`. */
export function diskKeyForUpload(fieldName: string, filename: string): string {
  const dir = sanitizeSegment(fieldName) || 'upload';
  const name = sanitizeSegment(filename) || 'file';
  return `${dir}/${randomUUID()}/${name}`;
}

/**
 * Reduce a path segment to a safe, portable filename fragment: keep only the
 * final basename, strip control characters and path separators, map any other
 * unsafe character to `_`, and trim leading/trailing dots.
 */
export function sanitizeSegment(value: string): string {
  const basename = value.split(/[\\/]/).pop() ?? '';
  return basename
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}
