/**
 * Signed URL generation and verification (`jsails/routing`).
 *
 * `new HmacUrlSigner({ key })` creates a signer with `sign(path, params?,
 * expiresInMs?)` and `verify(url)`. Signing produces an HMAC-SHA256 token
 * over a domain-separated, normalized payload; `verify` returns the verified
 * `{ path, params }` on a valid, unexpired signature, or `null` on tampering,
 * expiry, or any malformed input. It never throws.
 *
 * Handlers must read parameters from the value `verify` returns, never by
 * re-parsing the request URL: a URL with a repeated key is rejected outright,
 * so the verified params are the only ones the signature covers.
 *
 * The key is never echoed in error messages. Signatures are
 * integrity-protected, **not encrypted** — the payload is recoverable.
 */

import { createHmac } from 'node:crypto';

import { safeEqualStrings } from '../security/constant-time.js';
import { JsailsError } from '../errors/jsails-error.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Stable codes carried by a {@link SignedUrlError}. */
export type SignedUrlErrorCode =
  'invalid_key' | 'invalid_path' | 'invalid_param' | 'invalid_expiry';

/** A value-free signed-URL error. Never echoes the key, path, or signature. */
export class SignedUrlError extends JsailsError {
  constructor(
    readonly code: SignedUrlErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link HmacUrlSigner}. */
export interface UrlSignerOptions {
  /**
   * Symmetric signing key. Must be at least 32 bytes. This is a secret,
   * never echoed in errors or embedded in produced URLs.
   */
  readonly key: string;
  /**
   * Injectible clock for tests. Defaults to `Date.now()`.
   */
  readonly now?: () => number;
}

/** The payload of a URL whose signature verified. */
export interface VerifiedSignedUrl {
  /** The signed path, without the query string. */
  readonly path: string;
  /**
   * The signed caller params, decoded, without `signature`/`expires`. These
   * are the only parameter values the signature vouches for.
   */
  readonly params: Readonly<Record<string, string>>;
}

/** A URL signer returned by {@link HmacUrlSigner}. */
export interface UrlSigner {
  /**
   * Sign a path, returning a full URL with a `?signature=<token>` query
   * parameter appended. The token is an HMAC-SHA256 over the normalized
   * payload (path + serialized params + expiry).
   *
   * @param path - The path to sign (e.g. `/reset/1`). Must not contain `?`
   *   or `#`; pass query values through `params`.
   * @param params - Optional query parameters to include in the signature and
   *   the URL. Values are serialized as strings. `signature` and `expires` are
   *   reserved names.
   * @param expiresInMs - Signature lifetime in milliseconds. Defaults to
   *   `900_000` (15 minutes). When `0` the signature never expires.
   * @throws {SignedUrlError} `invalid_path`, `invalid_param`, or
   *   `invalid_expiry` for input that could never verify.
   */
  sign(
    path: string,
    params?: Record<string, string | number | boolean>,
    expiresInMs?: number,
  ): string;

  /**
   * Verify a signed URL. Returns the verified path and params when the
   * signature is valid and unexpired; returns `null` on tampering, expiry,
   * a repeated query key, or malformed input. Never throws.
   *
   * @param url - The full signed URL to verify.
   */
  verify(url: string): VerifiedSignedUrl | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Domain-separation prefix prepended to the HMAC payload. */
const DOMAIN_PREFIX = 'jsails-signed-url:v1';

/** Default signature lifetime: 15 minutes. */
const DEFAULT_EXPIRY_MS = 900_000;

/** Minimum key length in bytes. */
const MIN_KEY_LENGTH = 32;

/** Query names the signer appends itself; a caller param may not use them. */
const RESERVED_PARAMS: ReadonlySet<string> = new Set(['signature', 'expires']);

// ---------------------------------------------------------------------------
// HmacUrlSigner
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 URL signer for generating and verifying signed URLs.
 *
 * ```ts
 * const signer = new HmacUrlSigner({ key: '...' });
 * const url = signer.sign('/reset/1', { token: 'abc' });
 * const verified = signer.verify(url); // { path: '/reset/1', params: { token: 'abc' } } or null
 * ```
 */
export class HmacUrlSigner implements UrlSigner {
  #key: Buffer;
  #clock: () => number;

  constructor(options: UrlSignerOptions) {
    if (typeof options.key !== 'string' || options.key.length < MIN_KEY_LENGTH) {
      throw new SignedUrlError('invalid_key', 'signing key must be a string of at least 32 bytes');
    }
    this.#key = Buffer.from(options.key, 'utf-8');
    this.#clock = options.now ?? (() => Date.now());
  }

  /**
   * Build the HMAC payload: `<prefix>\n<path>\n<serialized params>\n<expiry>`.
   * The expiry is an epoch-ms string (`0` means no expiry).
   */
  #buildPayload(path: string, params: Readonly<Record<string, string>>, expiryMs: number): string {
    return [DOMAIN_PREFIX, path, serializeParams(params), String(expiryMs)].join('\n');
  }

  #signature(payload: string): string {
    return createHmac('sha256', this.#key).update(payload).digest('base64url');
  }

  sign(
    path: string,
    params?: Record<string, string | number | boolean>,
    expiresInMs: number = DEFAULT_EXPIRY_MS,
  ): string {
    // A `?` or `#` in the path would make verify split the URL somewhere
    // other than where sign joined it, producing a URL that never verifies.
    if (typeof path !== 'string' || path === '' || path.includes('?') || path.includes('#')) {
      throw new SignedUrlError(
        'invalid_path',
        'signed path must be a non-empty string without "?" or "#"',
      );
    }
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 0) {
      throw new SignedUrlError('invalid_expiry', 'expiresInMs must be a non-negative integer');
    }
    const expiryMs = expiresInMs === 0 ? 0 : this.#clock() + expiresInMs;

    const stringParams: Record<string, string> = {};
    for (const [name, value] of Object.entries(params ?? {})) {
      if (RESERVED_PARAMS.has(name)) {
        throw new SignedUrlError('invalid_param', 'signature and expires are reserved param names');
      }
      Object.defineProperty(stringParams, name, {
        value: String(value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    const signature = this.#signature(this.#buildPayload(path, stringParams, expiryMs));
    const query = serializeParams(stringParams);
    const tail = `signature=${signature}&expires=${String(expiryMs)}`;
    return `${path}?${query === '' ? tail : `${query}&${tail}`}`;
  }

  verify(url: string): VerifiedSignedUrl | null {
    try {
      return this.#verify(url);
    } catch {
      // verify is a predicate: any malformed input is a failed verification.
      return null;
    }
  }

  #verify(url: string): VerifiedSignedUrl | null {
    if (typeof url !== 'string' || url.length === 0 || url.includes('#')) {
      return null;
    }

    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) {
      return null;
    }
    const path = url.slice(0, queryIndex);
    const query = parseUniqueQuery(url.slice(queryIndex + 1));
    if (query === null) {
      return null;
    }

    const signature = query.get('signature');
    const expiresStr = query.get('expires');
    if (signature === undefined || signature === '' || expiresStr === undefined) {
      return null;
    }
    if (!/^(?:0|[1-9]\d*)$/.test(expiresStr)) {
      return null;
    }
    const expiresMs = Number(expiresStr);
    if (!Number.isSafeInteger(expiresMs)) {
      return null;
    }
    if (expiresMs !== 0 && this.#clock() > expiresMs) {
      return null;
    }

    const params: Record<string, string> = {};
    for (const [name, value] of query) {
      if (RESERVED_PARAMS.has(name)) continue;
      Object.defineProperty(params, name, {
        value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }

    const expectedSignature = this.#signature(this.#buildPayload(path, params, expiresMs));
    // Both sides are base64url strings; `safeEqualStrings` compares them
    // constant-time and hashes unequal lengths instead of short-circuiting.
    if (!safeEqualStrings(expectedSignature, signature)) {
      return null;
    }

    return Object.freeze({ path, params: Object.freeze(params) });
  }
}

// ---------------------------------------------------------------------------
// Query encoding
// ---------------------------------------------------------------------------

/**
 * Serialize a params object into a deterministic query-string fragment.
 * Keys are sorted for deterministic output.
 */
function serializeParams(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join('&');
}

/**
 * Parse a query string into a map, or `null` when any key appears twice.
 *
 * Repeated keys are refused rather than resolved: the signature covers one
 * value per key, and first-wins (`URLSearchParams.get`) versus last-wins
 * readers would otherwise disagree about which value was verified.
 * `URLSearchParams` never throws on a malformed escape; it keeps the text
 * literally, which then simply fails the HMAC comparison.
 */
function parseUniqueQuery(query: string): Map<string, string> | null {
  const result = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(query)) {
    if (result.has(name)) {
      return null;
    }
    result.set(name, value);
  }
  return result;
}
