/**
 * The content identity every disk write returns: the SHA-256 of the stored
 * bytes, as 64 lowercase hex digits, branded so a plain string (a key, an
 * etag) cannot be passed where a digest is required.
 */

declare const SHA256_BRAND: unique symbol;

/**
 * A SHA-256 digest in lowercase hex. Obtain one from `Disk.write`, or check a
 * stored string with {@link isSha256}.
 *
 * @public
 */
export type Sha256 = string & { readonly [SHA256_BRAND]: true };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * True when `value` is a SHA-256 digest in lowercase hex, such as one read back
 * from a database column.
 *
 * @public
 */
export function isSha256(value: unknown): value is Sha256 {
  return typeof value === 'string' && SHA256_HEX.test(value);
}
