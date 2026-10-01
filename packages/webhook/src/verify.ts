/**
 * Verify one inbound webhook request: parse the signature headers, check the
 * timestamp, read the body, check the HMAC against each configured secret,
 * then (for {@link verifyWebhookRequest}) claim the signature against replay.
 *
 * The order matters. The header parse and the timestamp check need no body,
 * so a malformed or stale request is rejected before the body is read or any
 * HMAC is computed. The HMAC check runs before the replay claim so an
 * attacker cannot fill the replay store with garbage signatures — only a
 * correctly signed request consumes a slot.
 *
 * The body is read as raw bytes, never parsed first: the signature covers the
 * exact bytes the sender transmitted, and a JSON or text round-trip could
 * change them.
 *
 * The replay key is derived from what the signature covers (the timestamp
 * and the body digest), never from the signature header: a header may carry
 * several candidates, and keying on one the sender chose would let an attacker
 * add a junk candidate to a captured delivery and claim a fresh slot with
 * every resend.
 *
 * A claim is not final. The plugin releases it when the handler fails, so a
 * sender's retry of the same signed request is accepted instead of answered
 * with `replayed` for the rest of the window (`releaseSignature`).
 *
 * A claim is a cache entry, so every window that can become its TTL (the
 * endpoint's, the verifier's, twice the tolerance) is checked against the
 * longest cache TTL before anything is verified: the plugin checks at
 * construction, and a direct call checks its options on entry. Otherwise the
 * misconfiguration would surface as a cache error only after a correctly
 * signed delivery verified, failing every delivery.
 */

import { createHash } from 'node:crypto';

import { MAX_CACHE_TTL_MS, type CacheStore } from 'jsails/cache';

import { WebhookError } from './errors.js';
import { claimReplayKey, replayKey } from './replay-guard.js';
import { DEFAULT_TOLERANCE_SECONDS } from './signature.js';
import { jsailsVerifier, type WebhookVerifier } from './verifiers.js';

/** What a verified request carries to the endpoint's handler. */
export interface VerifiedWebhook {
  /** The endpoint id the signature was checked against. */
  readonly endpointId: string;
  /** The raw request body decoded as UTF-8. */
  readonly rawBody: string;
  /**
   * The sender's signed timestamp, in Unix seconds, or `undefined` for a
   * scheme that signs none.
   */
  readonly timestamp: number | undefined;
  /** The replay-guard key this delivery claims; pass it to `releaseSignature`. */
  readonly replayKey: string;
  /** How long, in seconds, the replay guard holds this delivery's claim. */
  readonly replayWindowSeconds: number;
}

/**
 * How long a delivery from a scheme that signs no timestamp (GitHub) is
 * remembered by the replay guard. Such a delivery never goes stale, so the
 * guard is the only thing refusing a replay; seven days outlasts every common
 * provider's own retry schedule.
 */
export const DEFAULT_UNTIMED_REPLAY_WINDOW_SECONDS: number = 7 * 24 * 60 * 60;

/** Options for {@link verifyWebhookSignature} and {@link verifyWebhookRequest}. */
export interface VerifyWebhookOptions {
  readonly endpointId: string;
  /**
   * The shared secret, or several during a rotation: a signature valid under
   * any of them verifies, so the new secret can be deployed before the sender
   * switches to it.
   */
  readonly secret: string | readonly string[];
  readonly cache: CacheStore;
  /** The signature scheme. Defaults to {@link jsailsVerifier}. */
  readonly verifier?: WebhookVerifier;
  /**
   * Tolerance in seconds, a whole number up to half a year. Defaults to
   * {@link DEFAULT_TOLERANCE_SECONDS}.
   */
  readonly toleranceSeconds?: number;
  /**
   * How long, in seconds, a claim is held. Defaults to the verifier's
   * `replayWindowSeconds`, else twice the tolerance for a timestamped scheme
   * and {@link DEFAULT_UNTIMED_REPLAY_WINDOW_SECONDS} for an untimed one. A
   * timestamped claim is never held for less than twice the tolerance, so a
   * request still inside the tolerance cannot outlive its record. Like the
   * verifier's, a whole number of seconds up to one year.
   */
  readonly replayWindowSeconds?: number;
  /** Current time in Unix seconds. Defaults to the wall clock. */
  readonly nowSeconds?: number;
}

/** The longest replay window, in seconds: the longest cache TTL. */
export const MAX_REPLAY_WINDOW_SECONDS: number = MAX_CACHE_TTL_MS / 1000;

function isWholeSecondsUpTo(value: unknown, max: number): boolean {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= max;
}

/** The settings that decide how long a claim is held. */
export interface ReplayWindowSettings {
  readonly endpointId: string;
  readonly verifier?: WebhookVerifier;
  readonly toleranceSeconds?: number;
  readonly replayWindowSeconds?: number;
}

/**
 * Throw `invalid_endpoint` unless every window that can become a claim's TTL
 * fits one: a replay window (the endpoint's or the verifier's) is a whole
 * number of seconds up to one year, and the tolerance one up to half a year,
 * because a timestamped claim is held for at least twice the tolerance.
 */
export function assertReplayWindows(settings: ReplayWindowSettings): void {
  const context = { endpoint: settings.endpointId };
  for (const window of [settings.replayWindowSeconds, settings.verifier?.replayWindowSeconds]) {
    if (window !== undefined && !isWholeSecondsUpTo(window, MAX_REPLAY_WINDOW_SECONDS)) {
      throw new WebhookError(
        'invalid_endpoint',
        'replayWindowSeconds must be a positive integer of at most one year',
        { context },
      );
    }
  }
  if (
    settings.toleranceSeconds !== undefined &&
    !isWholeSecondsUpTo(settings.toleranceSeconds, MAX_REPLAY_WINDOW_SECONDS / 2)
  ) {
    throw new WebhookError(
      'invalid_endpoint',
      'toleranceSeconds must be a positive integer of at most half a year',
      { context },
    );
  }
}

function secretsOf(secret: string | readonly string[]): readonly string[] {
  return typeof secret === 'string' ? [secret] : secret;
}

/**
 * Verify a request's signature without claiming it, or throw a
 * {@link WebhookError}. The caller claims it once it is ready to act on the
 * delivery (the plugin parses the JSON body first). Options whose windows no
 * claim can hold throw `invalid_endpoint` before the request is read.
 */
export async function verifyWebhookSignature(
  request: Request,
  options: VerifyWebhookOptions,
): Promise<VerifiedWebhook> {
  assertReplayWindows(options);
  const verifier = options.verifier ?? jsailsVerifier;
  const context = { endpoint: options.endpointId };
  const parts = verifier.parse(request.headers);
  if (parts === null || parts.signatures.length === 0) {
    throw new WebhookError(
      'invalid_signature',
      'the webhook signature header is missing or malformed',
      { context },
    );
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (parts.timestamp !== undefined && Math.abs(nowSeconds - parts.timestamp) > toleranceSeconds) {
    throw new WebhookError(
      'timestamp_out_of_tolerance',
      'the webhook request failed verification: timestamp_out_of_tolerance',
      { context },
    );
  }

  const body = new Uint8Array(await request.arrayBuffer());
  let valid = false;
  for (const secret of secretsOf(options.secret)) {
    if (verifier.verify(parts, { endpointId: options.endpointId, body, secret })) {
      valid = true;
    }
  }
  if (!valid) {
    throw new WebhookError(
      'invalid_signature',
      'the webhook request failed verification: invalid_signature',
      { context },
    );
  }

  return {
    endpointId: options.endpointId,
    rawBody: new TextDecoder().decode(body),
    timestamp: parts.timestamp,
    replayKey: replayKey(options.endpointId, deliveryDigest(parts.timestamp, body)),
    replayWindowSeconds: replayWindowOf(options, verifier, parts.timestamp, toleranceSeconds),
  };
}

/**
 * The identity of a delivery: a digest of the timestamp and the body, the
 * material every scheme signs. A sender's retry carries the same pair, so it
 * maps to the same key, while nothing in the signature header can change it.
 */
function deliveryDigest(timestamp: number | undefined, body: Uint8Array): string {
  return createHash('sha256')
    .update(timestamp === undefined ? '-' : String(timestamp))
    .update('.')
    .update(body)
    .digest('hex');
}

function replayWindowOf(
  options: VerifyWebhookOptions,
  verifier: WebhookVerifier,
  timestamp: number | undefined,
  toleranceSeconds: number,
): number {
  const configured = options.replayWindowSeconds ?? verifier.replayWindowSeconds;
  if (timestamp === undefined) {
    return configured ?? DEFAULT_UNTIMED_REPLAY_WINDOW_SECONDS;
  }
  return Math.max(configured ?? 0, toleranceSeconds * 2);
}

/**
 * Verify a request and claim its signature, or throw a {@link WebhookError}.
 * The caller maps the error code to a status: `invalid_signature` and
 * `timestamp_out_of_tolerance` are 401 and `replayed` is 409; a cache failure
 * (`cache.unavailable`) propagates as it is. A caller that fails to process the
 * delivery should release the claim with `releaseSignature` so the sender's
 * retry is accepted.
 */
export async function verifyWebhookRequest(
  request: Request,
  options: VerifyWebhookOptions,
): Promise<VerifiedWebhook> {
  const verified = await verifyWebhookSignature(request, options);
  await claimVerified(options.cache, verified);
  return verified;
}

/**
 * Claim a verified delivery for its `replayWindowSeconds`, or throw
 * `replayed` when it was already claimed.
 */
export async function claimVerified(cache: CacheStore, verified: VerifiedWebhook): Promise<void> {
  const first = await claimReplayKey(cache, verified.replayKey, verified.replayWindowSeconds);
  if (!first) {
    throw new WebhookError('replayed', 'this webhook request was already delivered', {
      context: { endpoint: verified.endpointId },
    });
  }
}
