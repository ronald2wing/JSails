/**
 * Verify one inbound webhook request: parse the signature header, check the
 * timestamp, check the HMAC, then claim the signature against replay.
 *
 * The order matters. The timestamp check is cheap and rejects a stale request
 * before any HMAC work. The HMAC check runs before the replay claim so an
 * attacker cannot fill the replay store with garbage signatures — only a
 * correctly signed request consumes a slot.
 *
 * The body is read as raw text, never parsed first: the signature covers the
 * exact bytes the sender transmitted, and a JSON round-trip would change them.
 */

import type { CacheStore } from 'jsails/cache';

import { WebhookError } from './errors.js';
import { claimSignature } from './replay-guard.js';
import { SIGNATURE_HEADER, checkSignature, parseSignatureHeader } from './signature.js';

/** What a verified request carries to the endpoint's handler. */
export interface VerifiedWebhook {
  /** The endpoint id the signature was checked against. */
  readonly endpointId: string;
  /** The raw request body, exactly as received. */
  readonly rawBody: string;
  /** The sender's signed timestamp, in Unix seconds. */
  readonly timestamp: number;
}

/** Options for {@link verifyWebhookRequest}. */
export interface VerifyWebhookOptions {
  readonly endpointId: string;
  readonly secret: string;
  readonly cache: CacheStore;
  /** Tolerance in seconds. Defaults to {@link DEFAULT_TOLERANCE_SECONDS}. */
  readonly toleranceSeconds?: number;
  /** Current time in Unix seconds. Defaults to the wall clock. */
  readonly nowSeconds?: number;
}

/**
 * Verify a request, or throw a {@link WebhookError}. The caller maps the error
 * code to a status: `invalid_signature` and `timestamp_out_of_tolerance` are
 * 401, `replayed` is 409, `unsupported_replay_guard` is 500.
 */
export async function verifyWebhookRequest(
  request: Request,
  options: VerifyWebhookOptions,
): Promise<VerifiedWebhook> {
  const parsed = parseSignatureHeader(request.headers.get(SIGNATURE_HEADER));
  if (parsed === null) {
    throw new WebhookError(
      'invalid_signature',
      'the webhook signature header is missing or malformed',
      {
        context: { endpoint: options.endpointId },
      },
    );
  }

  const rawBody = await request.text();
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = options.toleranceSeconds ?? 300;

  const failure = checkSignature(
    parsed,
    options.endpointId,
    rawBody,
    options.secret,
    nowSeconds,
    toleranceSeconds,
  );
  if (failure !== null) {
    throw new WebhookError(failure, `the webhook request failed verification: ${failure}`, {
      context: { endpoint: options.endpointId },
    });
  }

  const first = await claimSignature(
    options.cache,
    options.endpointId,
    parsed.signature,
    toleranceSeconds,
  );
  if (!first) {
    throw new WebhookError('replayed', 'this webhook request was already delivered', {
      context: { endpoint: options.endpointId },
    });
  }

  return { endpointId: options.endpointId, rawBody, timestamp: parsed.timestamp };
}
