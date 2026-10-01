/**
 * The `@jsails/webhook` plugin: inbound webhook verification.
 *
 * An app declares its endpoints and the plugin mounts one `POST` route per
 * endpoint. Each request is verified (signature, timestamp, replay) before the
 * endpoint's `onEvent` sees it, so a handler never has to think about
 * authenticity — it receives a {@link VerifiedWebhook} and the parsed JSON body.
 * Each endpoint picks its provider's signature scheme (`verifier`, default the
 * JSails scheme) and may list several secrets to rotate without dropping
 * deliveries.
 *
 * The replay claim is taken only after the body parsed, and is released when
 * the handler throws or answers with a 5xx: the sender retries such a
 * delivery verbatim, and keeping the claim would answer every retry with 409
 * and lose the event. Handlers must therefore be idempotent — a delivery whose
 * handler failed half-way through will run again.
 *
 * The cache store is **required**. A replay guard needs a store that survives
 * across processes and implements atomic `increment`; defaulting to an
 * in-memory store would silently accept replays the moment the app runs more
 * than one instance. Making it explicit forces that decision at the call site.
 *
 * Outbound delivery (sending webhooks with retries) is deliberately not here.
 * It is a different problem — a queue, a delivery record, a retry policy — and
 * bundling it would make the inbound path depend on the outbound one.
 */

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import type { CacheStore } from 'jsails/cache';
import { jsonError } from 'jsails/api';

import { WebhookError } from './errors.js';
import { releaseSignature } from './replay-guard.js';
import { DEFAULT_TOLERANCE_SECONDS } from './signature.js';
import { jsailsVerifier, type WebhookVerifier } from './verifiers.js';
import { claimVerified, verifyWebhookSignature, type VerifiedWebhook } from './verify.js';

/** One inbound webhook endpoint. */
export interface WebhookEndpoint {
  /** Stable id, signed into every request. Unique within the plugin. */
  readonly id: string;
  /** The path the sender posts to, e.g. `/webhooks/stripe`. */
  readonly path: string;
  /**
   * The shared secret the sender signs with, or several during a rotation (a
   * signature valid under any one verifies).
   */
  readonly secret: string | readonly string[];
  /**
   * The sender's signature scheme: `jsailsVerifier` (the default),
   * `stripeVerifier`, `githubVerifier`, `slackVerifier`, or a custom
   * {@link WebhookVerifier}.
   */
  readonly verifier?: WebhookVerifier;
  /** Tolerance in seconds between the signed timestamp and now. Defaults to 300. */
  readonly toleranceSeconds?: number;
  /**
   * How long, in seconds, the replay guard remembers a delivery. Defaults to
   * the verifier's own window, else twice the tolerance for a timestamped
   * scheme and 7 days for one that signs no timestamp (GitHub).
   */
  readonly replayWindowSeconds?: number;
  /**
   * Handle a verified request. The body is the parsed JSON; a non-JSON body is
   * rejected with 400 before this runs. Return a `Response` to control the
   * reply, or nothing for `200 { received: true }`.
   */
  readonly onEvent: (
    event: VerifiedWebhook,
    body: unknown,
  ) => Response | void | Promise<Response | void>;
}

/** Options accepted by {@link webhookPlugin}. */
export interface WebhookPluginOptions {
  /** The cache store backing the replay guard. Required. */
  readonly cache: CacheStore;
  /** The endpoints to mount. At least one. */
  readonly endpoints: readonly WebhookEndpoint[];
}

/** The status each failure code maps to. */
const STATUS_BY_CODE: Readonly<Record<WebhookError['code'], number>> = Object.freeze({
  invalid_endpoint: 500,
  invalid_signature: 401,
  timestamp_out_of_tolerance: 401,
  replayed: 409,
  unsupported_replay_guard: 500,
});

/**
 * Create the `webhook` plugin. Options are validated at construction so a
 * misconfigured endpoint fails at boot, not on the first delivery.
 */
export function webhookPlugin(options: WebhookPluginOptions): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('webhookPlugin requires an options object');
  }
  if (options.cache === null || typeof options.cache !== 'object') {
    throw new TypeError('webhookPlugin requires a cache store');
  }
  if (!Array.isArray(options.endpoints) || options.endpoints.length === 0) {
    throw new TypeError('webhookPlugin requires at least one endpoint');
  }
  const endpoints = options.endpoints.map(validateEndpoint);
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const endpoint of endpoints) {
    if (seenIds.has(endpoint.id)) {
      throw new WebhookError('invalid_endpoint', `duplicate webhook endpoint id "${endpoint.id}"`, {
        context: { endpoint: endpoint.id },
      });
    }
    if (seenPaths.has(endpoint.path)) {
      throw new WebhookError(
        'invalid_endpoint',
        `duplicate webhook endpoint path "${endpoint.path}"`,
        {
          context: { endpoint: endpoint.id },
        },
      );
    }
    seenIds.add(endpoint.id);
    seenPaths.add(endpoint.path);
  }

  return definePlugin({
    name: 'webhook',
    setup({ configureHttp }) {
      configureHttp((app) => {
        for (const endpoint of endpoints) {
          app.post(endpoint.path, (context) =>
            handleDelivery(context.req.raw, endpoint, options.cache),
          );
        }
      });
    },
  });
}

/** Validate one endpoint and fill its defaults. */
function validateEndpoint(endpoint: WebhookEndpoint): WebhookEndpoint {
  if (endpoint === null || typeof endpoint !== 'object') {
    throw new WebhookError('invalid_endpoint', 'a webhook endpoint must be an object');
  }
  if (typeof endpoint.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(endpoint.id)) {
    throw new WebhookError(
      'invalid_endpoint',
      'a webhook endpoint id must be lowercase letters, digits, ".", "_", or "-"',
    );
  }
  if (typeof endpoint.path !== 'string' || !endpoint.path.startsWith('/')) {
    throw new WebhookError('invalid_endpoint', 'a webhook endpoint path must start with "/"', {
      context: { endpoint: endpoint.id },
    });
  }
  const secrets: readonly unknown[] =
    typeof endpoint.secret === 'string'
      ? [endpoint.secret]
      : Array.isArray(endpoint.secret)
        ? endpoint.secret
        : [];
  if (
    secrets.length === 0 ||
    secrets.some((secret) => typeof secret !== 'string' || secret.length === 0)
  ) {
    throw new WebhookError('invalid_endpoint', 'a webhook endpoint needs a non-empty secret', {
      context: { endpoint: endpoint.id },
    });
  }
  if (
    endpoint.verifier !== undefined &&
    (endpoint.verifier === null ||
      typeof endpoint.verifier.parse !== 'function' ||
      typeof endpoint.verifier.verify !== 'function')
  ) {
    throw new WebhookError('invalid_endpoint', 'a webhook verifier needs parse and verify', {
      context: { endpoint: endpoint.id },
    });
  }
  if (typeof endpoint.onEvent !== 'function') {
    throw new WebhookError('invalid_endpoint', 'a webhook endpoint needs an onEvent handler', {
      context: { endpoint: endpoint.id },
    });
  }
  if (
    endpoint.replayWindowSeconds !== undefined &&
    (!Number.isInteger(endpoint.replayWindowSeconds) || endpoint.replayWindowSeconds <= 0)
  ) {
    throw new WebhookError('invalid_endpoint', 'replayWindowSeconds must be a positive integer', {
      context: { endpoint: endpoint.id },
    });
  }
  if (
    endpoint.toleranceSeconds !== undefined &&
    (!Number.isInteger(endpoint.toleranceSeconds) || endpoint.toleranceSeconds <= 0)
  ) {
    throw new WebhookError('invalid_endpoint', 'toleranceSeconds must be a positive integer', {
      context: { endpoint: endpoint.id },
    });
  }
  return {
    ...endpoint,
    verifier: endpoint.verifier ?? jsailsVerifier,
    toleranceSeconds: endpoint.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS,
  };
}

/** Verify one delivery and hand it to the endpoint's handler. */
async function handleDelivery(
  request: Request,
  endpoint: WebhookEndpoint,
  cache: CacheStore,
): Promise<Response> {
  let verified: VerifiedWebhook;
  try {
    verified = await verifyWebhookSignature(request, {
      endpointId: endpoint.id,
      secret: endpoint.secret,
      verifier: endpoint.verifier,
      cache,
      toleranceSeconds: endpoint.toleranceSeconds,
      replayWindowSeconds: endpoint.replayWindowSeconds,
    });
  } catch (error) {
    return webhookFailure(error);
  }

  // A malformed body is answered before the claim: it consumes no replay slot,
  // and the sender gets the same 400 however often it retries.
  let body: unknown;
  try {
    body = JSON.parse(verified.rawBody) as unknown;
  } catch {
    return jsonError(400, 'invalid_payload', 'the webhook body is not valid JSON');
  }

  try {
    await claimVerified(cache, verified);
  } catch (error) {
    return webhookFailure(error);
  }

  let response: Response | void;
  try {
    response = await endpoint.onEvent(verified, body);
  } catch (error) {
    await releaseQuietly(cache, verified.replayKey);
    throw error;
  }
  if (response !== undefined && response.status >= 500) {
    await releaseQuietly(cache, verified.replayKey);
  }
  return response ?? Response.json({ received: true });
}

function webhookFailure(error: unknown): Response {
  if (error instanceof WebhookError) {
    return jsonError(STATUS_BY_CODE[error.code], error.code, error.message);
  }
  throw error;
}

/**
 * Release a claim on the failure path. A cache that cannot delete leaves the
 * claim to expire on its own; that must not replace the handler's own outcome.
 */
async function releaseQuietly(cache: CacheStore, key: string): Promise<void> {
  try {
    await releaseSignature(cache, key);
  } catch {
    // The claim expires with its replay window; the original outcome wins.
  }
}
