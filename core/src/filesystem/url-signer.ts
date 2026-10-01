/**
 * Short-lived URLs that read one stored object straight from its store, so a
 * download or preview does not pass through the app.
 *
 * {@link DiskUrlSigner} is separate from `Disk`: only a store with an origin
 * of its own (S3 and its compatibles) can sign, and a caller that wants a URL
 * asks for a signer by type instead of probing a disk at run time. Every
 * option is required. A signed URL is a bearer credential until it expires, so
 * the lifetime is explicit and bounded by {@link SIGNED_URL_MAX_EXPIRES_IN_MS};
 * the response's `Content-Disposition` and `Content-Type` are signed into the
 * URL, so a holder cannot turn a download into an inline document of another
 * type and the app's nosniff and disposition rules hold for signed reads too.
 */

/**
 * The longest a signed URL may live: 7 days, the SigV4 maximum.
 *
 * @public
 */
export const SIGNED_URL_MAX_EXPIRES_IN_MS: number = 7 * 24 * 60 * 60 * 1000;

/**
 * The `Content-Disposition` a signed URL answers with.
 *
 * @public
 */
export interface SignedContentDisposition {
  /** `inline` to display, `attachment` to download. */
  readonly type: 'inline' | 'attachment';
  /** The filename the browser offers; omitted means none. */
  readonly filename?: string;
}

/**
 * Options for {@link DiskUrlSigner.signedUrl}. All are required.
 *
 * @public
 */
export interface DiskSignedUrlOptions {
  /** Lifetime in milliseconds, from 1000 to {@link SIGNED_URL_MAX_EXPIRES_IN_MS}; rounded up to whole seconds. */
  readonly expiresInMs: number;
  readonly contentDisposition: SignedContentDisposition;
  /** The media type the store answers with, in RFC 9110 syntax. */
  readonly contentType: string;
}

/**
 * Something that signs read URLs for the objects of one store.
 *
 * @public
 */
export interface DiskUrlSigner {
  /**
   * A URL that reads the object under `key` until it expires. The object's
   * existence is not checked: a URL for a missing key answers 404 from the
   * store.
   */
  signedUrl(key: string, options: DiskSignedUrlOptions): Promise<string>;
}

/**
 * True when `value` structurally implements {@link DiskUrlSigner}.
 *
 * @public
 */
export function isDiskUrlSigner(value: unknown): value is DiskUrlSigner {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Partial<DiskUrlSigner>).signedUrl === 'function'
  );
}
