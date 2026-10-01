/**
 * Media source checks: strict base64, decoded sizes, URL sources, and
 * magic-byte sniffing of declared media types.
 *
 * Browser-safe: decoding uses `atob` and `TextDecoder`, never `node:buffer`.
 */

import type { AiFileMediaType, AiImageMediaType } from './types.js';

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `data` is canonical, unwrapped, padded base64 with at least one byte. */
export function isBase64(data: string): boolean {
  return data.length > 0 && data.length % 4 === 0 && BASE64_PATTERN.test(data);
}

/** The number of bytes `data` (valid base64) decodes to. */
export function base64DecodedLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** The first `count` decoded bytes of valid base64 `data`. */
function decodePrefix(data: string, count: number): Uint8Array {
  const chars = Math.ceil(count / 3) * 4;
  const binary = atob(data.slice(0, Math.min(chars, data.length)));
  const bytes = new Uint8Array(Math.min(binary.length, count));
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Whether the decoded bytes of `data` match the declared media type by their
 * magic number. `text/plain` must decode as UTF-8.
 */
export function sniffMatches(data: string, mediaType: AiImageMediaType | AiFileMediaType): boolean {
  if (mediaType === 'text/plain') {
    try {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = binary.charCodeAt(index);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  }
  const bytes = decodePrefix(data, 16);
  switch (mediaType) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return (
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      );
    case 'image/webp':
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case 'application/pdf':
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  }
}

/** The parsed URL when `value` is an absolute URL with one of `protocols`, else `undefined`. */
export function parseMediaUrl(value: string, protocols: readonly string[]): URL | undefined {
  if (value.length === 0 || value.length > 8192) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!protocols.includes(url.protocol)) return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  return url;
}
