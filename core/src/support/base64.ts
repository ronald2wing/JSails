/**
 * Base64 encoding and decoding for binary data. The caller validates the
 * alphabet; this module assumes valid input.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = new Int16Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index += 1) {
  LOOKUP[ALPHABET.charCodeAt(index)] = index;
}

function codeAt(input: string, index: number): number {
  return LOOKUP[input.charCodeAt(index)] ?? -1;
}

/** Encode bytes as a padded standard-base64 string. */
export function encodeBase64Bytes(bytes: Uint8Array): string {
  let output = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];

    output += ALPHABET[first >> 2];
    output += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? '=' : ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? '=' : ALPHABET[third & 0x3f];
  }

  return output;
}

/** Decode a padded standard-base64 string into bytes. */
export function decodeBase64Bytes(input: string): Uint8Array {
  const length = input.length;
  let padding = 0;
  if (length > 0 && input[length - 1] === '=') padding += 1;
  if (length > 1 && input[length - 2] === '=') padding += 1;

  const output = new Uint8Array(Math.floor((length * 3) / 4) - padding);
  let offset = 0;

  for (let index = 0; index < length; index += 4) {
    const first = codeAt(input, index);
    const second = codeAt(input, index + 1);
    const third = input[index + 2] === '=' ? 0 : codeAt(input, index + 2);
    const fourth = input[index + 3] === '=' ? 0 : codeAt(input, index + 3);

    if (offset < output.length) output[offset++] = (first << 2) | (second >> 4);
    if (offset < output.length) output[offset++] = ((second & 0x0f) << 4) | (third >> 2);
    if (offset < output.length) output[offset++] = ((third & 0x03) << 6) | fourth;
  }

  return output;
}
