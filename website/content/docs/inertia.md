---
title: Inertia
order: 41
section: Reference
---

# Inertia

`@jsails/inertia` is the server half of the
[Inertia v3 protocol](https://inertiajs.com/docs/v3/core-concepts/the-protocol).
It is written as pure functions over web-standard request facts, so it works
with the official Inertia v3 clients. Its test suite drives the real
`@inertiajs/react` 3.11.0 client, on `preact/compat` and on React 19, against
the engine (see [Client notes](#client-notes)). Your client app resolves and
renders the components.

The engine never sees a framework request. It takes plain request facts
(method, URL, headers, abort signal) and returns an **outcome**: plain data
holding its `kind`, the status, the header pairs, and the body. `outcomeToResponse` maps
an outcome to a web-standard `Response`, and `requestFacts(request)` reads
the facts of a web-standard `Request`.

```ts
import {
  adaptInertiaResponse,
  defer,
  defineInertia,
  inertiaVersion,
  originGuard,
  outcomeToResponse,
  requestFacts,
  resolveInertia,
  validationFailure,
  validationIssuesOf,
  webCryptoSealer,
} from '@jsails/inertia';

const inertia = defineInertia({
  version: inertiaVersion({ 'app.js': 'a1b2c3', 'app.css': 'd4e5f6' }),
  assets: { scripts: ['/assets/app.js'], styles: ['/assets/app.css'] },
  carrier: { sealer: webCryptoSealer(carrierKey) },
  share: () => ({ appName: 'Tasks' }),
});

export async function GET(request: Request): Promise<Response> {
  const outcome = await resolveInertia(inertia, requestFacts(request), {
    component: 'Tasks/Index',
    props: {
      tasks: [{ id: 1, title: 'Write docs' }],
      stats: defer(async () => ({ open: 1 })),
    },
  });
  return outcomeToResponse(outcome);
}

export async function POST(request: Request): Promise<Response> {
  const facts = requestFacts(request);
  const refused = originGuard(facts);
  if (refused !== null) return outcomeToResponse(refused);
  try {
    await createTask(await request.json());
  } catch (error) {
    const issues = validationIssuesOf(error);
    const failed = issues === null ? null : await validationFailure(inertia, facts, issues);
    if (failed === null) throw error;
    return outcomeToResponse(failed);
  }
  return adaptInertiaResponse(facts, Response.redirect(new URL('/tasks', request.url), 302));
}
```

`carrierKey` is 32 random bytes kept as a secret. `createTask` stands for your
own code.

## Props

A prop is one of three things:

- a literal value;
- a bare resolver function `(context) => value`, which is a lazy regular prop;
- a descriptor.

Descriptors are frozen, and their options are checked when they are built (a
bad option is an `invalid_options` error). `optional` and `defer` take a
resolver; the other kinds take a value or a resolver. Each kind has its
options:

| Descriptor | Full visit | Options |
| --- | --- | --- |
| `always(value)` | sent | — |
| `optional(resolve)` | left out, not announced | `once` |
| `defer(resolve)` | left out, listed in `deferredProps` by group | `group`, `rescue`, `merge`, `once` |
| `merge(value)` | sent, labelled for merging | `mode` (`append`, `prepend`, `deep`), `matchOn`, `once` |
| `once(value)` | sent, unless the client holds it | `key`, `expiresAt` or `ttlMs`, `fresh` |
| `scroll(page)` | sent as `{ data }`, labelled `<path>.data`, and listed in `scrollProps` | `pageName`, `defer`, `matchOn` |

The resolver of a prop runs only when the response carries that prop. Every
selected resolver runs concurrently. A resolver receives the component, the
method, the URL, the headers, and a `signal`. The signal aborts when the
request aborts or when a sibling resolver fails.

A resolver that returns `undefined` sends its prop as `null`, so the key is
always present when the prop was selected: `<Deferred>` keeps showing its
fallback until every key it waits for is defined.

A resolver failure fails the whole resolution. The exception is
`defer(resolve, { rescue: true })`: a failure there leaves the prop out, lists
it in `rescuedProps`, and goes to the `report` hook (`console.error` when no
hook is given). A failure while the request itself is aborted is never
rescued or reported: the client is gone, so the abort is rethrown.

Descriptors may sit inside plain objects. Their paths then use dots
(`auth.permissions`) in every metadata list.

## Partial reloads

A request is a partial reload only when `X-Inertia-Partial-Component` equals the
component being rendered. A request for any other component is answered as a
full visit, as the protocol requires. A common case is the login page after a
session expired.

On a partial reload:

- `X-Inertia-Partial-Data` narrows the props first, then
  `X-Inertia-Partial-Except` removes props from what is left;
- `errors` and `always` props are kept, even when Except names them;
- dot paths descend only through plain literal objects. A lazy prop selected
  by a path that points inside it is returned whole, the same rule the Laravel
  reference adapter uses.

`X-Inertia-Reset` resolves a prop again without its merge label and sets
`scrollProps[path].reset`. `X-Inertia-Except-Once-Props` skips once props
that the client already holds. It applies only on full Inertia visits; a
partial reload always resolves the once props it asks for.

## The page object

`buildInertiaPage(input)` resolves the props and assembles the v3 page object.
`url` is the request path and query.

Optional fields are present only when they apply:

- each metadata list or map (`sharedProps`, `mergeProps`, `prependProps`,
  `deepMergeProps`, `matchPropsOn`, `deferredProps`, `rescuedProps`,
  `scrollProps`, `onceProps`) only when non-empty;
- `encryptHistory`, `clearHistory`, and `preserveFragment` only when `true`;
- `flash` only when it has a key.

Shared props (`shared`) sit under the page props, and page props win on a
key collision. Their top-level keys are reported as `sharedProps`, which the
client uses for instant visits.

`errors` is reserved. It is always the first prop and defaults to `{}`. A
page or shared prop named `errors` is an `invalid_prop_key` error.

## Error bags

`shapeErrorBags(bags, errorBag)` follows the reference rule:

- with a default bag and an `X-Inertia-Error-Bag` header, it returns
  `{ [header]: default }`;
- with a default bag and no header, it returns the default bag unwrapped;
- with no default bag, it returns every named bag under its own name.

Shape the bags on the failing request, because that request carries the
header. A `__proto__`-style bag name is treated as absent.

## Serialization

`serializePage(page)` allows only plain data:

- strings, booleans, finite numbers, and `null`;
- plain and null-prototype objects, and arrays;
- valid `Date`s, sent as ISO-8601 strings;
- `bigint`s, sent as `{ "$bigint": "digits" }` with `preserveBigIntegers: true`
  so the client revives them.

Anything else throws `InertiaError` with code `unserializable_prop` and the path
(`props.user.tags.2`) in `context.path`, in every environment. That includes:

- class instances, ORM records among them, so hidden columns never leak;
- `Map`, `Set`, functions, and symbols;
- `toJSON` objects, non-finite numbers, invalid dates, and cycles;
- unresolved descriptors;
- the keys `__proto__`, `constructor`, and `prototype`;
- any object with its own `$bigint` key.

## The document

`buildDocument({ page, rootId?, lang?, head?, assets?, nonce?, ssrBody? })`
returns the full-page HTML. The page goes in
`<script data-page="app" type="application/json">`, which is what the v3 client
reads, followed by `<div id="app">`. The JSON escapes `/` and `<` the way the
upstream SSR builder does, so `</script>` never occurs inside it. It uses no
HTML entities.

The data block is never executed. A script element whose type is not a
JavaScript type is a data block, and the browser stops processing it before
any CSP check, so `script-src` does not apply to it: it needs no nonce or
hash, and a strict CSP needs no exception for it. Only an HTML sanitizer, or a
layer that strips inline script elements from the page, must leave it in
place. Asset URLs and the nonce are attribute-escaped. `head`
strings and `ssrBody` are trusted HTML, such as an SSR result. `ssrBody`
replaces both the data block and the root element.

## Asset version

`inertiaVersion(assets)` hashes an asset map with SHA-256 over the canonical
JSON of its sorted `[key, value]` pairs and returns 16 base64url characters.
Keys and values are both hashed, so a renamed asset changes the version. Use
`''` as the version to turn versioning off.

## Configuration

`defineInertia(options)` checks every option once and returns a frozen config.
A bad option is an `invalid_options` error at startup, never in a request.

| Option | Meaning |
| --- | --- |
| `version` | The asset version, a function returning it per request, or `null` (`''`, versioning off). |
| `rootId`, `lang` | The root element id (default `app`) and the document language. |
| `assets`, `nonce` | Client asset URLs (`scripts`, `styles`, `preloads`, each a list of non-empty strings) and the CSP nonce for the document, fixed or per request. |
| `share` | Shared props, computed per request from the prop context. |
| `encryptHistory` | Encrypt history for every page unless a render says otherwise. |
| `errors` | `allMessages` (every message per field as an array) and `backFallback` (default `/`). |
| `carrier` | The sealed flash and errors cookie: `sealer`, `secure`, `maxAgeSeconds`, `oversize`. |
| `ssr` | The SSR gateway and its policy: `gateway`, `timeoutMs`, `onError`, `exclude`. |
| `report` | Receives failures the engine absorbs: `rescued_prop`, `ssr`, `carrier`. |

The version is sent in the `X-Inertia-Version` header in both directions, so
it must be visible ASCII, with spaces allowed only inside it. A leading or
trailing space would be stripped from the header the client sends back, and
every visit would then fail the version check. A fixed version or asset list
is checked by `defineInertia`. A version or asset list returned by a function
is checked each time the function returns it, and is an `invalid_options`
error when it is malformed.

## Rendering

`resolveInertia(config, facts, spec)` answers one request for one component.
`spec` holds `component` and `props`, plus optional `status` (2xx, or 4xx/5xx
for an error page), `headers`, `flash`, `encryptHistory`, `clearHistory`,
`preserveFragment`, and `ssr: false`. The outcome is one of:

- `page`: the JSON page object with `X-Inertia: true`, for an Inertia visit;
- `document`: the HTML document, for a first visit, server-rendered when an
  SSR gateway is configured;
- `control`: a `409` (see below).

The other entry points return the remaining kinds: `redirect` (the redirect
helpers and `validationFailure`), `precognition`, and `forbidden` (the
Origin check's `403`).

A `HEAD` request gets the `GET` status and headers and no body.

### Version guard

An Inertia `GET` or `HEAD` whose `X-Inertia-Version` differs from the current
version gets a `409` with `X-Inertia-Location` and `X-Inertia-Version`. A
missing header counts as `''`, as in the reference adapter. The guard runs
before any prop resolves, and it leaves the carrier alone, so flash survives
the reload. `X-Inertia-Location` holds the request path and query rather than
the full URL; the client resolves it against its own location. Call
`versionGuard(config, facts)` to run the guard before expensive handler work.

### Headers and caching

Every outcome appends `Vary: X-Inertia, Precognition` to any `Vary` you set.
Pages are `Cache-Control: private`. They are `private, no-store` when the
request sent partial-reload, once, reset, or error-bag headers, or when the
response sets the carrier cookie.

## Redirects

An Inertia visit is an XHR, which follows redirects by itself, so the engine
decides how each redirect reaches the client:

- a `302` after `PUT`, `PATCH`, `DELETE`, or `QUERY` becomes `303`;
- an off-origin target becomes a `409` with `X-Inertia-Location`, and the
  client makes a full page visit;
- a target with a fragment becomes a `409` with `X-Inertia-Redirect`, and the
  client makes a new Inertia visit. Prefetch requests get the redirect
  unchanged.

The helpers return outcomes:

- `inertiaRedirect(config, facts, to, options?)` accepts only a same-origin
  path. Anything else is an `invalid_redirect` error. The default status is
  `302` after `GET` and `303` after a mutation. Characters outside visible
  ASCII are percent-encoded as UTF-8 before the path goes into a header, so
  `/café` is sent as `/caf%C3%A9`. Nothing else in the path is changed.
- `inertiaBack(config, facts, options?)` returns to the same-origin `Referer`,
  or to `fallback`.
- `inertiaLocation(facts, url)` makes a full page visit to any http(s) URL. It
  gives a `409` for an Inertia request and a plain redirect otherwise.

Redirect options take `status`, `headers`, `flash`, `clearHistory`, and
`preserveFragment`. The last three travel in the carrier to the page that
follows. `preserveFragment` marks that page so the client keeps the fragment
of the visit that was redirected. For example, a form posted to
`/comments#new` lands on the redirect target with `#new` still in the URL.
This is a different thing from a redirect target with a fragment, which
becomes a `409` with `X-Inertia-Redirect`.

`adaptInertiaResponse(facts, response)` applies the same rules to a response
the engine did not build, such as `Response.redirect` or a static page. It
also turns a `200` `text/html` page without `X-Inertia` that answers an
Inertia `GET` into a `409` location visit, so the browser loads that page in
full instead of showing the client's error modal. It never mutates the
original headers. When it replaces a response, it cancels the body of the
response it replaces. It does not cancel a body that something is already
reading, and a failed cancel is ignored. A network-error or opaque response
(status `0`) is returned unchanged.

## Validation errors

`toInertiaErrors(issues, { allMessages? })` maps core `ValidationIssue`s to
the `errors` prop. Keys are dotted paths (`user.tags.2`). Each key gets its
first message by default, or every message as an array with `allMessages`.
An issue with no path is filed under `''`.

`validationFailure(config, facts, issues)` answers a failed mutation from an
Inertia form. It returns a `303` back to the page with the errors sealed in
the carrier, and the next page render shows them. The errors are wrapped for
`X-Inertia-Error-Bag` at this point, while the failing request still carries
the header. It returns `null` for `GET`, `HEAD`, non-Inertia, and Precognition
requests, which take their usual error path. `validationIssuesOf(error)`
reads the issues of a core `ValidationError`.

## Flash and the carrier

There is no server session, so flash, carried errors, `clearHistory`, and
`preserveFragment` travel in a sealed one-shot cookie:

- the payload is AES-GCM sealed under the AAD `jsails-inertia-carrier:v1` and
  carries its own expiry. A tampered, expired, or foreign cookie reads as
  empty.
- the cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and lives 60 seconds by
  default. Under https it is also `Secure` and named
  `__Host-jsails-inertia-carrier`.
- `webCryptoSealer(key)` is the default sealer and takes 32 raw bytes or an
  AES-GCM `CryptoKey`. `sealerFromEncrypter(encrypter)` adapts the core
  `AesEncrypter`.
- the cookie is capped at 3 KiB. Over the cap, the default outside production
  (`oversize: 'throw'`) is a `carrier_too_large` error. In production the
  default (`oversize: 'drop-flash'`) reduces what is carried, step by step,
  until the cookie fits:
  1. The flash is dropped.
  2. If the errors alone are still too large, each field keeps only its first
     message.
  3. Fields are then dropped from the end. The cookie keeps the longest run of
     fields, in the order the issues reported them, that fits.

  `clearHistory` and `preserveFragment` are always kept, and each reduction is
  reported once as `carrier_too_large`. The user still sees an error for at
  least one field, and after correcting it, sees the rest on the next submit.
  If even the first field does not fit, for example a single message longer
  than 3 KiB, `drop-flash` also throws `carrier_too_large`. A validation
  failure that carried no errors would look like a success.

When the carrier is consumed:

- carried errors go to the next page render, partial reloads included,
  because `errors` is always sent;
- flash, `clearHistory`, and `preserveFragment` go only to a non-partial
  render. The client
  ignores flash on deferred-props requests, so a deferred or polling request
  that lands first leaves the flash for the real page;
- a `409`, a `HEAD`, and a prefetch consume nothing. A prefetch also gets no
  flash, because the client replays a prefetched response later;
- a redirect chain merges what each hop adds into what the request already
  carries. A prefetch redirect writes no carrier.

`flash` must be plain JSON. A `Date`, `bigint`, or class instance is an
`unserializable_prop` error with its path, such as `flash.when`.

## Precognition

`precognition(facts, issues)` answers a `Precognition: true` request from the
issues that validating its body produced, without running the handler. It
returns `null` for any other request. Precognition requests are unsafe-method
requests too, so run `originGuard` before parsing the body.

- When validation passes, it answers `204` with `Precognition: true` and
  `Precognition-Success: true`.
- When it fails, it answers `422` `application/json` with
  `{ message, errors }`, every field holding an array of messages.

The `422` is plain `application/json` and not `problem+json`, because the
laravel-precognition client parses only content types that contain
`application/json`. Only fields listed in `Precognition-Validate-Only` count.
In that list `*` matches one path segment, and an issue under a listed field
counts as that field's.

## Server-side rendering

An SSR gateway renders a page to `{ head, body }`. The `head` strings go into
the document head, and the `body` replaces the data block and the empty root
element.

- `inProcessSsr(app)` takes the function `createInertiaApp` returns in server
  mode, `(page, renderToString) => Promise<{ head, body }>`, and supplies
  preact-render-to-string. Use it when your React imports resolve to
  `preact/compat`. The page it passes is the one the browser parses: dates are
  ISO strings and big integers are revived.
- `createInertiaApp` picks server mode by `typeof window === 'undefined'`, so
  the server render function must be created where no DOM globals exist.
- `httpSsr({ url, timeoutMs?, fetch? })` posts the page to an external render
  server's `/render` endpoint. That is the official contract: `200` with
  `{ head, body }`, or `500` with a classified error.

The policy (`ssr: { gateway, timeoutMs, onError, exclude }`) gives every
render a time limit (2000 ms by default) and aborts it with the request. On a
failure, `onError: 'fallback'` sends the client-rendered document and reports
`ssr`; this is the default outside tests. `onError: 'throw'` fails with
`ssr_failed` or `ssr_timeout`; this is the default under `NODE_ENV=test`.
A request abort is rethrown and never reported. Inertia visits, `HEAD`,
`ssr: false`, and excluded URLs skip SSR.

In-process rendering shares the request's thread. The time limit and the
abort bound only asynchronous work, such as component resolution. A
synchronous render that loops cannot be stopped by a timer. Use `httpSsr`
when a render must be bounded absolutely.

## CSRF

Inertia needs no CSRF token. Its defence is the Origin check: the v3 client
sends every visit as a same-origin XHR, and a browser attaches `Origin` to
every XHR whose method is not `GET` or `HEAD`, so a forged cross-site form or
fetch names another origin.

`originGuard(facts, { origin? })` runs that check. It returns `null` for
`GET`, `HEAD`, and `OPTIONS`, and for an unsafe request from the trusted
origin. Otherwise it returns a `forbidden` outcome: a `403` with the body
`{ "error": { "status": 403, "code": "origin_mismatch", ... } }`, which never
echoes the request. It reads `Origin` first, then `Sec-Fetch-Site`, then the
`Referer` origin, and the first header present decides. A request with none of
the three comes from a non-browser client and passes only when it sends no
`Cookie`. Forwarded headers are never read: behind a TLS-terminating proxy,
pass the public origin as `origin`. Call it first in every mutation route,
before reading the body, and before `precognition`.

The engine never sets an `XSRF-TOKEN` cookie, so the client sends no
`X-XSRF-TOKEN`. There is no `_method` override, because an override widens
what a cross-site form can reach. Send `PUT` and `PATCH` directly, using
`router.put(url, data, { forceFormData: true })` for uploads.

Core's API routes add their own check on cookie-session mutations: a
same-origin `Origin` and a matching `X-CSRF-Token` (see
[Configuration](/docs/configuration)). The Inertia client does not send
`X-CSRF-Token` on its own. When an Inertia mutation is served by a core API
route with a cookie session, pass the token in the visit's `headers` option.

## Testing

`@jsails/inertia/testing` holds three helpers for testing routes without a
browser:

```ts
import { requestFacts, resolveInertia, outcomeToResponse } from '@jsails/inertia';
import { inertiaRequest, openCarrier, readInertiaPage } from '@jsails/inertia/testing';

const request = inertiaRequest('/tasks', {
  version: 'v1',
  partial: { component: 'Tasks/Index', only: ['stats'] },
});
const response = outcomeToResponse(
  await resolveInertia(inertia, requestFacts(request), { component: 'Tasks/Index', props }),
);
const page = await readInertiaPage(response);
```

- `inertiaRequest(url, init)` builds the `Request` an Inertia v3 client sends:
  `X-Inertia`, and the headers for `version`, `partial` (`component`, `only`,
  `except`, `reset`), `errorBag`, `exceptOnce`, `mergeIntent` (`append` or
  `prepend`, as `<InfiniteScroll>` sends it), `prefetch`, and `precognition`
  (`validateOnly`). The headers have the values the client gives them.
  `X-Inertia-Partial-Data` lists `only` followed by `reset`, because a reset
  prop must also be selected. The partial headers are sent only when one of
  `only`, `except`, or `reset` is non-empty. A relative URL resolves against
  `http://localhost`. Without `version` no version header is sent, which the
  version guard compares as `''`.
- `readInertiaPage(response, { rootId })` returns the page object from either
  representation: the JSON body, or the document's data element. Big integers
  are revived as the client revives them. A response without a page is a
  `not_a_page` error.
- `openCarrier(response, sealer, { now })` opens the carrier cookie the
  response sets and returns its `flash`, its `errors` (already shaped for the
  error bag), `clearHistory`, and `preserveFragment`. It returns `null` when the response sets no
  carrier, deletes it, or sets one that does not open or has expired.

## Client notes

- The package is certified against `@inertiajs/react` 3.11.0. Its
  end-to-end suite runs that client in happy-dom on `preact/compat` (React
  imports aliased the way `@preact/preset-vite` aliases them) and checks boot
  from the document, `<Link>`, partial reloads, `<Deferred>` groups, once
  props, `useForm` errors and error bags, flash, version reloads, off-origin
  redirects, `303` after `PUT`, `<InfiniteScroll>`, `encryptHistory` and
  `clearHistory`, Precognition, `usePage()`, and SSR followed by hydration.
  The same scenarios run on React 19 and must leave identical pages, requests,
  and events. A test also pins the React APIs the client imports and checks
  that `preact/compat` provides every one, including `use`, which `usePage()`
  reads its context with.
- To run the client on Preact, alias `react`, `react-dom`, their `client` and
  `server` entries, and the JSX runtimes to `preact/compat` in your bundler,
  in the server build too when you render in process. `@inertiajs/react`
  declares `react` and `react-dom` 19 as required peers, so npm installs them
  next to Preact; the alias decides which one runs.
- `@inertiajs/core` 3.11.0 re-exports its types through extensionless
  relative paths, which TypeScript's `NodeNext` resolution cannot follow.
  Client code that needs Inertia's types must compile with
  `moduleResolution: "bundler"`.
- `encryptHistory` needs `crypto.subtle`, which browsers expose only in a
  secure context (https, `localhost`, or a loopback address). Outside
  production the engine warns once per config when a page asks for it over
  plain http on any other host.
- Inertia's `useHttp` reads validation errors from the `errors` member of a
  `422` body. Core's API error envelope has no such member, so a route used
  through `useHttp` must answer a validation failure itself, for example with
  `Response.json({ errors: toInertiaErrors(issues) }, { status: 422 })`.
- The `type="application/json"` data block is never executed, and CSP
  `script-src` does not apply to it, so it needs no nonce or hash. Only an
  HTML sanitizer, or a layer that strips inline script elements, must leave
  it in place.

## Errors

Every failure is an `InertiaError` (a `JsailsError`) with a stable code from
`INERTIA_ERROR_MESSAGES`. Its message is static and never echoes a prop value
or a header; a prop path, when there is one, is in `context.path`.

| Code | Raised when |
| --- | --- |
| `invalid_options` | An option, descriptor option, render spec, or test request header is malformed, or a version or asset function returns a malformed value. |
| `invalid_component` | The component name is empty or holds control characters. |
| `invalid_prop_key` | A prop is named `errors`, a prototype key appears in the props, or a key on the path to a resolver or descriptor holds `.` or `,`. |
| `unserializable_prop` | A prop or flash value is not plain data (see [Serialization](#serialization)). |
| `invalid_props` | The props or shared props are not a plain object, or a scroll prop resolved to something other than a scroll page. |
| `invalid_redirect` | A redirect target or fallback is not a same-origin path. |
| `carrier_too_large` | The carrier exceeds 3 KiB under the `throw` policy, or under `drop-flash` when not even the first error field fits. |
| `ssr_failed`, `ssr_timeout` | An SSR render failed or ran out of time under `onError: 'throw'`. |
| `not_a_page` | `readInertiaPage` found no page object in the response. |

## Limits

- **No plugin or route registration yet.** Wire `resolveInertia`,
  `originGuard`, `adaptInertiaResponse`, `validationFailure`, and
  `precognition` into your routes yourself. The version guard and the Origin
  check run only where you call them.
- **No per-render output schema.** Props are checked by the strict serializer
  only.
- **No client.** Use an official Inertia v3 client.
- **Live props are out of scope for 1.0.**
