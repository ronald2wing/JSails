/**
 * Webhook signature verification: the pure half of the `@jsails/webhook`
 * plugin.
 *
 * The scheme is the one every major provider uses (Stripe, GitHub, Slack):
 * HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`, sent as
 * `X-Webhook-Signature: t=<unix>,v1=<hex>`. The id is in the signed string so a
 * signature captured from one endpoint cannot be replayed against another that
 * shares a secret; the timestamp is in it so a captured request cannot be
 * re-dated.
 *
 * Nothing here touches the clock, the network, or the filesystem — the caller
 * supplies `now` and the replay guard. That keeps the verification rules
 * testable against fixed vectors.
 */

import { createHmac } from 'node:crypto';

import { safeEqualStrings } from 'jsails/plugin-sdk';

/** The header a sender puts the signature in. */
export const SIGNATURE_HEADER = 'x-webhook-signature';

/** The default tolerance, in seconds, between the signed timestamp and now. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A parsed `X-Webhook-Signature` header. */
export interface ParsedSignature {
  /** Unix seconds the sender signed at. */
  readonly timestamp: number;
  /** Lowercase hex HMAC-SHA256. */
  readonly signature: string;
}

/**
 * The exact bytes a signature covers. Exported so a sender (a test, a
 * provider's own SDK) can reproduce it without re-deriving the format.
 */
export function signedPayload(id: string, timestamp: number, rawBody: string): string {
  return `${id}.${timestamp}.${rawBody}`;
}

/** Compute the lowercase hex HMAC-SHA256 of {@link signedPayload}. */
export function computeSignature(
  id: string,
  timestamp: number,
  rawBody: string,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(signedPayload(id, timestamp, rawBody), 'utf8')
    .digest('hex');
}

/**
 * Parse `t=<unix>,v1=<hex>`. Returns `null` for anything that is not exactly
 * that shape — a missing part, a non-numeric timestamp, a non-hex signature.
 * The caller turns `null` into a value-free `invalid_signature`.
 */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignature | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) return null;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === 't') {
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (name === 'v1') {
      if (!/^[0-9a-f]{64}$/i.test(value)) return null;
      signature = value.toLowerCase();
    }
  }
  if (timestamp === undefined || signature === undefined) return null;
  return { timestamp, signature };
}

/** Why a signature check failed. Each maps to one `WebhookError` code. */
export type SignatureFailure = 'invalid_signature' | 'timestamp_out_of_tolerance';

/**
 * Verify a parsed signature against the body. Returns `null` when it is valid,
 * or the failure reason. The HMAC comparison is constant-time; the timestamp
 * check runs first so a stale request never reaches the HMAC.
 */
export function checkSignature(
  parsed: ParsedSignature,
  id: string,
  rawBody: string,
  secret: string,
  nowSeconds: number,
  toleranceSeconds: number,
): SignatureFailure | null {
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    return 'timestamp_out_of_tolerance';
  }
  const expected = computeSignature(id, parsed.timestamp, rawBody, secret);
  return safeEqualStrings(expected, parsed.signature) ? null : 'invalid_signature';
}
