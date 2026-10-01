---
title: Webhooks
order: 34
section: Reference
---

# Webhooks

`@jsails/webhook` verifies inbound webhook deliveries: it checks an HMAC
signature, enforces a timestamp tolerance, and refuses a replayed request. A
handler receives only requests that passed all three checks, so it never has to
think about authenticity.

```sh
npm install @jsails/webhook
```

## The plugin

```ts
// jsails.app.js
import { cachePlugin } from '@jsails/cache';
import { stripeVerifier, webhookPlugin } from '@jsails/webhook';

export default {
  plugins: {
    use: [
      cachePlugin({ store: 'valkey' }),
      webhookPlugin({
        endpoints: [
          {
            id: 'stripe',
            path: '/webhooks/stripe',
            secret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
            verifier: stripeVerifier,
            onEvent: async (event, body) => {
              await handleStripeEvent(body);
            },
          },
        ],
      }),
    ],
  },
};
```

The plugin registers one public `POST` route per endpoint. A sender posts
cross-site and carries no cookie, so the routes skip the cross-site check: the
signature is what admits a request.

The replay guard lives in a namespace of the application cache (`cache`,
default `webhooks`), so the plugin requires `@jsails/cache` and the app's cache
store decides where claims live. The guard claims each delivery with the
store's atomic `add`, which stores the claim only while its key is free, so
exactly one of two concurrent deliveries wins. The store must survive across
processes: an app that runs more than one instance configures the cache plugin
over Valkey, or an in-memory store would accept a replay that reaches another
instance. A claim is a cache entry: a Valkey that evicts it under memory
pressure ends that delivery's replay window early, so give the cache a server
with room. Replay windows are whole seconds up to one year, the longest cache
TTL.

The options are data and functions (a verifier is read as its `name`, its
`replayWindowSeconds` and its bound `parse` and `verify`), checked when the
config is loaded: an invalid endpoint (a malformed id, a path that is not an
absolute route path, an empty secret, a duplicate id or path, a window no cache
entry can hold) fails with `config.invalid_options`, naming the option and
never its value.

## Signature schemes

Each endpoint picks its sender's scheme with `verifier`. The default,
`jsailsVerifier`, is HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`, sent as

```
X-Webhook-Signature: t=<unix>,v1=<hex>
```

The endpoint id is inside the signed string, so a signature captured from one
endpoint cannot be replayed against another that shares a secret. The timestamp
is inside it, so a captured request cannot be re-dated.

Presets cover the common providers:

| Verifier | Header | Signed content |
| --- | --- | --- |
| `jsailsVerifier` | `X-Webhook-Signature: t=…,v1=…` | `{id}.{timestamp}.{body}` |
| `stripeVerifier` | `Stripe-Signature: t=…,v1=…` (any `v1` may match) | `{timestamp}.{body}` |
| `githubVerifier` | `X-Hub-Signature-256: sha256=…` | `{body}` |
| `slackVerifier` | `X-Slack-Signature: v0=…` + `X-Slack-Request-Timestamp` | `v0:{timestamp}:{body}` |

GitHub signs no timestamp, so nothing makes a captured GitHub delivery stale.
The replay guard therefore remembers a delivery from an untimed scheme for
`DEFAULT_UNTIMED_REPLAY_WINDOW_SECONDS` (7 days) rather than twice the
tolerance; set `replayWindowSeconds` on the endpoint (or on a custom verifier)
to change it, and key the handler on the `X-GitHub-Delivery` id for protection
beyond the window. A claim is a cache entry, so a replay window is a whole
number of seconds up to one year and `toleranceSeconds` one up to half a
year: the plugin refuses any other value when the config loads, and
`verifyWebhookRequest` refuses it with `invalid_endpoint` before reading the
request. Any other scheme is a `WebhookVerifier` — a
`parse(headers)` that reads the signature material without the body, and a
`verify(parts, { endpointId, body, secret })` that checks one secret against
the raw bytes.

The body is read as **raw bytes**, never parsed first: the signature covers the
exact bytes the sender transmitted, and a text or JSON round-trip could change
them.

### Rotating a secret

`secret` accepts an array. A signature valid under any listed secret verifies,
so deploy `[newSecret, oldSecret]`, switch the sender, then drop the old one.

## Verification order

1. **Parse** the headers. A missing or malformed header is `invalid_signature`.
2. **Check the timestamp** against `toleranceSeconds` (default 300). A stale
   request is `timestamp_out_of_tolerance` — rejected before the body is read
   or any HMAC is computed.
3. **Read the body and check the HMAC** in constant time against each secret.
   A mismatch is `invalid_signature`.
4. **Parse the JSON** body. A body that is not JSON is `invalid_payload`, and
   consumes no replay slot.
5. **Claim the delivery** against replay. The first sighting wins; a second is
   `replayed`. The claim is keyed on a digest of the signed timestamp and the
   body, never on a value from the signature header, so adding a junk
   candidate (an extra Stripe `v1`) to a captured delivery does not make it
   new. It is held for twice the tolerance on a timestamped scheme (a later
   resend is stale anyway) and for 7 days on an untimed one. Two genuinely
   different deliveries with the same timestamp and identical bodies are
   therefore treated as one.
6. **Run `onEvent`.** When it throws or returns a 5xx response, the claim is
   released, so the sender's retry of the same signed request is accepted
   rather than refused as `replayed`.

The HMAC check runs before the replay claim so an attacker cannot fill the
replay store with garbage signatures — only a correctly signed request consumes
a slot.

Because a failed delivery can be retried, and a sender may also redeliver after
a timeout the handler did not notice, `onEvent` must be idempotent: key its
effects on the provider's event id. Outside the plugin, `verifyWebhookSignature`
verifies without claiming, `claimVerified` claims, and `releaseSignature`
releases a claim after a failure.

## Status codes

| Failure | Status |
| --- | --- |
| `invalid_signature` | 401 |
| `timestamp_out_of_tolerance` | 401 |
| `replayed` | 409 |
| `invalid_payload` (body is not JSON) | 400 |

Error bodies are value-free: the secret, the signature, and the body never
appear in a response.

## Sending a webhook

The package exports the pieces a sender needs to reproduce a signature:

```ts
import { computeSignature, SIGNATURE_HEADER } from '@jsails/webhook';

const timestamp = Math.floor(Date.now() / 1000);
const signature = computeSignature('stripe', timestamp, rawBody, secret);

await fetch('https://app.example/webhooks/stripe', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    [SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
  },
  body: rawBody,
});
```

## Outbound delivery

Sending webhooks with retries is deliberately not part of this package. It is a
different problem — a queue, a delivery record, a retry policy — and bundling it
would make the inbound path depend on the outbound one.
