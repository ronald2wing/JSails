/**
 * The `@jsails/webhook` plugin: inbound webhook verification.
 *
 * An app declares its endpoints and the plugin registers one `POST` route per
 * endpoint. Each request is verified (signature, timestamp, replay) before the
 * endpoint's `onEvent` sees it, so a handler never has to think about
 * authenticity — it receives a {@link VerifiedWebhook} and the parsed JSON body.
 * Each endpoint picks its provider's signature scheme (`verifier`, default the
 * JSails scheme) and may list several secrets to rotate without dropping
 * deliveries. A sender posts cross-site and carries no cookie, so the routes
 * opt out of the cross-site check; the signature is what admits a request.
 *
 * The replay claim is taken only after the body parsed, and is released when
 * the handler throws or answers with a 5xx: the sender retries such a
 * delivery verbatim, and keeping the claim would answer every retry with 409
 * and lose the event. Handlers must therefore be idempotent — a delivery whose
 * handler failed half-way through will run again.
 *
 * The replay guard lives in a namespace (`cache`, default `webhooks`) of the
 * application cache the `@jsails/cache` plugin provides, a service the plugin
 * requires. A replay guard needs a store that survives across processes (its
 * claim is the store's atomic `add`); the cache plugin's store is that
 * decision, made once for the app (Valkey when it runs more than one
 * instance), rather than an in-memory default that would silently accept
 * replays.
 *
 * The plugin is on the `definePlugin` contract of `jsails/kernel`: its options
 * are data and functions (a verifier is read as its name, window and bound
 * `parse`/`verify`), checked before any setup, and a misconfigured endpoint
 * fails the config with `config.invalid_options`, never on the first delivery.
 *
 * Outbound delivery (sending webhooks with retries) is deliberately not here.
 * It is a different problem — a queue, a delivery record, a retry policy — and
 * bundling it would make the inbound path depend on the outbound one.
 */

import { jsonError } from 'jsails/api';
import { cacheToken, type CacheStore } from 'jsails/cache';
import { boundObject, definePlugin, fn, publicAccess, type PluginFactory } from 'jsails/kernel';
import { z } from 'jsails/zod';

import { WebhookError } from './errors.js';
import { releaseSignature } from './replay-guard.js';
import { DEFAULT_TOLERANCE_SECONDS } from './signature.js';
import { jsailsVerifier, type WebhookVerifier } from './verifiers.js';
import {
  claimVerified,
  MAX_REPLAY_WINDOW_SECONDS,
  verifyWebhookSignature,
  type VerifiedWebhook,
} from './verify.js';

/** One inbound webhook endpoint. */
export interface WebhookEndpoint {
  /** Stable id, signed into every request. Unique within the plugin. */
  readonly id: string;
  /** The path the sender posts to, e.g. `/webhooks/stripe`. Unique within the plugin. */
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
  /**
   * The namespace of the application cache the replay guard claims
   * deliveries in. Defaults to `webhooks`.
   */
  readonly cache?: string;
  /** The endpoints to register. At least one. */
  readonly endpoints: readonly WebhookEndpoint[];
}

/** A whole number of seconds from 1 up to `max`. */
const seconds = (max: number) => z.int().positive().max(max);

/** A registrable route path: absolute, no empty segment, trailing slash, query or control character. */
const ROUTE_PATH = /^\/(?:[^/\\?#\s\u0000-\u001f\u007f]+(?:\/[^/\\?#\s\u0000-\u001f\u007f]+)*)?$/;

const secret = z.string().min(1);

const verifier = boundObject({
  name: z.string(),
  replayWindowSeconds: seconds(MAX_REPLAY_WINDOW_SECONDS).optional(),
  parse: fn<WebhookVerifier['parse']>(),
  verify: fn<WebhookVerifier['verify']>(),
});

const endpoint = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    path: z.string().regex(ROUTE_PATH),
    secret: z.union([secret, z.array(secret).min(1)]),
    verifier: verifier.optional(),
    toleranceSeconds: seconds(MAX_REPLAY_WINDOW_SECONDS / 2).optional(),
    replayWindowSeconds: seconds(MAX_REPLAY_WINDOW_SECONDS).optional(),
    onEvent: fn<WebhookEndpoint['onEvent']>(),
  })
  .strict();

/** Whether no two entries share the key `key` reads. */
function distinct<T>(list: readonly T[], key: (entry: T) => string): boolean {
  return new Set(list.map(key)).size === list.length;
}

const webhookOptions: z.ZodType<WebhookPluginOptions> = z
  .object({
    cache: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/)
      .optional(),
    endpoints: z
      .array(endpoint)
      .min(1)
      .refine((list) => distinct(list, (entry) => entry.id), {
        message: 'must not list an endpoint id twice',
      })
      .refine((list) => distinct(list, (entry) => entry.path), {
        message: 'must not list an endpoint path twice',
      }),
  })
  .strict();

/** The status each failure code maps to. */
const STATUS_BY_CODE: Readonly<Record<WebhookError['code'], number>> = Object.freeze({
  invalid_endpoint: 500,
  invalid_signature: 401,
  timestamp_out_of_tolerance: 401,
  replayed: 409,
});

/** The namespace of the application cache the replay guard uses by default. */
const DEFAULT_CACHE_NAMESPACE = 'webhooks';

/**
 * The `webhook` plugin: one verified `POST` route per endpoint, its replay
 * guard in a namespace of the application cache.
 */
export const webhookPlugin: PluginFactory<WebhookPluginOptions> = definePlugin({
  name: 'webhook',
  options: webhookOptions,
  requires: [cacheToken],
  setup({ options, services, routes }) {
    const cache = services.get(cacheToken).cache(options.cache ?? DEFAULT_CACHE_NAMESPACE);
    for (const declared of options.endpoints) {
      const resolved: WebhookEndpoint = {
        ...declared,
        verifier: declared.verifier ?? jsailsVerifier,
        toleranceSeconds: declared.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS,
      };
      routes.add({
        methods: ['POST'],
        path: resolved.path,
        access: publicAccess('signed webhook delivery; the signature is verified before onEvent'),
        surface: 'webhook',
        credentials: [],
        handler: (context) => handleDelivery(context.request, resolved, cache),
      });
    }
  },
});

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
