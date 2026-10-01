/**
 * Real file signatures for the media tests. Uploads are sniffed, so a test
 * payload must carry the bytes its declared type implies.
 */

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
