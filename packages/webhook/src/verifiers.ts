/**
 * Pluggable signature schemes for inbound webhooks.
 *
 * Providers disagree on everything but the primitive: the header name, what
 * is signed, how the timestamp travels, and how the digest is encoded. A
 * {@link WebhookVerifier} captures one scheme in two steps so the plugin can
 * keep its order of checks for every provider: `parse` reads the headers alone
 * (a malformed or stale request is rejected before the body is read), and
 * `verify` checks one secret against the exact bytes received.
 *
 * Presets cover the JSails scheme (the default) and the three most common
 * providers. Each preset compares in constant time and signs over the raw
 * body bytes, never a re-encoded string.
 */

import { createHmac } from 'node:crypto';

import { safeEqualStrings } from 'jsails/plugin-sdk';

import { computeSignatureBytes, parseSignatureHeader, SIGNATURE_HEADER } from './signature.js';

/** What a verifier read from the headers. */
export interface WebhookSignatureParts {
  /**
   * Unix seconds the sender signed at, when the scheme signs one. The plugin
   * rejects a request outside the tolerance before reading the body. A scheme
   * without a timestamp (GitHub) has no expiry of its own, so the replay guard
   * remembers its deliveries for a much longer window (`replayWindowSeconds`).
   */
  readonly timestamp?: number;
  /** The candidate signatures; a match against any one verifies. */
  readonly signatures: readonly string[];
}

/** One provider's signature scheme. */
export interface WebhookVerifier {
  /** A short label for diagnostics. */
  readonly name: string;
  /**
   * How long, in seconds, the replay guard remembers a delivery verified by
   * this scheme. When unset, a timestamped delivery is remembered for twice
   * the tolerance (it is refused as stale after that anyway) and an untimed
   * one for `DEFAULT_UNTIMED_REPLAY_WINDOW_SECONDS` (7 days).
   */
  readonly replayWindowSeconds?: number;
  /** Read the signature material, or `null` when it is missing or malformed. */
  parse(headers: Headers): WebhookSignatureParts | null;
  /** Whether `parts` carries a valid signature of `body` under `secret`. */
  verify(
    parts: WebhookSignatureParts,
    input: { readonly endpointId: string; readonly body: Uint8Array; readonly secret: string },
  ): boolean;
}

function hmacHex(secret: string, ...chunks: readonly (string | Uint8Array)[]): string {
  const hmac = createHmac('sha256', secret);
  for (const chunk of chunks) {
    hmac.update(chunk);
  }
  return hmac.digest('hex');
}

function anyMatches(expected: string, candidates: readonly string[]): boolean {
  // Every candidate is compared so the time taken does not reveal which matched.
  let matched = false;
  for (const candidate of candidates) {
    if (safeEqualStrings(expected, candidate)) {
      matched = true;
    }
  }
  return matched;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * The JSails scheme: `X-Webhook-Signature: t=<unix>,v1=<hex>` over
 * `{endpointId}.{timestamp}.{body}`. The endpoint id is signed so a signature
 * captured from one endpoint cannot be replayed against another that shares a
 * secret.
 */
export const jsailsVerifier: WebhookVerifier = Object.freeze({
  name: 'jsails',
  parse(headers: Headers): WebhookSignatureParts | null {
    const parsed = parseSignatureHeader(headers.get(SIGNATURE_HEADER));
    return parsed === null ? null : { timestamp: parsed.timestamp, signatures: [parsed.signature] };
  },
  verify(
    parts: WebhookSignatureParts,
    input: { endpointId: string; body: Uint8Array; secret: string },
  ) {
    if (parts.timestamp === undefined) {
      return false;
    }
    const expected = computeSignatureBytes(
      input.endpointId,
      parts.timestamp,
      input.body,
      input.secret,
    );
    return anyMatches(expected, parts.signatures);
  },
});

/**
 * Stripe: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]` over
 * `{timestamp}.{body}`. Stripe sends one `v1` per active endpoint secret
 * during a rotation, so any of them may match.
 */
export const stripeVerifier: WebhookVerifier = Object.freeze({
  name: 'stripe',
  parse(headers: Headers): WebhookSignatureParts | null {
    const header = headers.get('stripe-signature');
    if (header === null || header.length === 0) {
      return null;
    }
    let timestamp: number | undefined;
    const signatures: string[] = [];
    for (const part of header.split(',')) {
      const separator = part.indexOf('=');
      if (separator === -1) {
        return null;
      }
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (name === 't') {
        if (!/^\d+$/.test(value)) {
          return null;
        }
        timestamp = Number(value);
      } else if (name === 'v1' && HEX_SHA256.test(value)) {
        signatures.push(value.toLowerCase());
      }
    }
    return timestamp === undefined || signatures.length === 0 ? null : { timestamp, signatures };
  },
  verify(parts: WebhookSignatureParts, input: { body: Uint8Array; secret: string }) {
    if (parts.timestamp === undefined) {
      return false;
    }
    return anyMatches(hmacHex(input.secret, `${parts.timestamp}.`, input.body), parts.signatures);
  },
});

/**
 * GitHub: `X-Hub-Signature-256: sha256=<hex>` over the body. GitHub signs no
 * timestamp, so nothing makes a captured delivery stale: the replay guard
 * remembers it for the untimed window (7 days by default), and a replay after
 * that is accepted. Keep the endpoint's handler idempotent on the
 * `X-GitHub-Delivery` id for protection beyond the window.
 */
export const githubVerifier: WebhookVerifier = Object.freeze({
  name: 'github',
  parse(headers: Headers): WebhookSignatureParts | null {
    const header = headers.get('x-hub-signature-256');
    if (header === null || !header.startsWith('sha256=')) {
      return null;
    }
    const value = header.slice('sha256='.length);
    return HEX_SHA256.test(value) ? { signatures: [value.toLowerCase()] } : null;
  },
  verify(parts: WebhookSignatureParts, input: { body: Uint8Array; secret: string }) {
    return anyMatches(hmacHex(input.secret, input.body), parts.signatures);
  },
});

/**
 * Slack: `X-Slack-Signature: v0=<hex>` over `v0:{timestamp}:{body}`, with the
 * timestamp in `X-Slack-Request-Timestamp`.
 */
export const slackVerifier: WebhookVerifier = Object.freeze({
  name: 'slack',
  parse(headers: Headers): WebhookSignatureParts | null {
    const timestamp = headers.get('x-slack-request-timestamp');
    const signature = headers.get('x-slack-signature');
    if (timestamp === null || !/^\d+$/.test(timestamp) || signature === null) {
      return null;
    }
    if (!signature.startsWith('v0=')) {
      return null;
    }
    const value = signature.slice('v0='.length);
    return HEX_SHA256.test(value)
      ? { timestamp: Number(timestamp), signatures: [value.toLowerCase()] }
      : null;
  },
  verify(parts: WebhookSignatureParts, input: { body: Uint8Array; secret: string }) {
    if (parts.timestamp === undefined) {
      return false;
    }
    return anyMatches(
      hmacHex(input.secret, `v0:${parts.timestamp}:`, input.body),
      parts.signatures,
    );
  },
});
