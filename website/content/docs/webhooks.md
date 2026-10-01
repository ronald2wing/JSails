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
// jsails.app.ts
import { webhookPlugin } from '@jsails/webhook';
import { cacheToken } from 'jsails/cache';

export default defineApp({
  plugins: {
    use: [
      cachePlugin({}),
      webhookPlugin({
        cache: cacheToken,
        endpoints: [
          {
            id: 'stripe',
            path: '/webhooks/stripe',
            secret: process.env.STRIPE_WEBHOOK_SECRET!,
            onEvent: async (event, body) => {
              await handleStripeEvent(body);
            },
          },
        ],
      }),
    ],
  },
});
```

`cache` is **required**. The replay guard needs a store that survives across
processes and implements atomic `increment`; defaulting to an in-memory store
would silently accept replays the moment the app runs more than one instance.
`@jsails/cache` provides one, backed by Valkey in production.

## The signature scheme

The scheme is the one Stripe, GitHub, and Slack use: HMAC-SHA256 over
`{id}.{timestamp}.{rawBody}`, sent as

```
X-Webhook-Signature: t=<unix>,v1=<hex>
```

The endpoint id is inside the signed string, so a signature captured from one
endpoint cannot be replayed against another that shares a secret. The timestamp
is inside it, so a captured request cannot be re-dated.

The body is read as **raw text**, never parsed first: the signature covers the
exact bytes the sender transmitted, and a JSON round-trip would change them.

## Verification order

1. **Parse** the header. A missing or malformed header is `invalid_signature`.
2. **Check the timestamp** against `toleranceSeconds` (default 300). A stale
   request is `timestamp_out_of_tolerance` — rejected before any HMAC work.
3. **Check the HMAC** in constant time. A mismatch is `invalid_signature`.
4. **Claim the signature** against replay. The first sighting wins; a second is
   `replayed`.

The HMAC check runs before the replay claim so an attacker cannot fill the
replay store with garbage signatures — only a correctly signed request consumes
a slot.

## Status codes

| Failure | Status |
| --- | --- |
| `invalid_signature` | 401 |
| `timestamp_out_of_tolerance` | 401 |
| `replayed` | 409 |
| `invalid_payload` (body is not JSON) | 400 |
| `unsupported_replay_guard` | 500 |

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
