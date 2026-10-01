---
title: Support Helpers
order: 29
section: Reference
---

# Support Helpers

Support helpers are a small, human-first toolkit projected as global namespaces,
so app code writes `Str.slug(title)` and `Num.bytes(size)` with no import. They
span two subpaths: a **browser-safe core** (`jsails/support`) and a **server-only
addendum** (`jsails/support/server`).

## Subpaths

| Subpath | Platform | Namespaces |
| --- | --- | --- |
| `jsails/support` | Browser-safe | `Str`, `Num`, `Time`, `Arr`, `Async`, `Encoding`, `Url`, `Cryptography`, plus `detach`/`escalate` |
| `jsails/support/server` | Server-only | `Files`, `Media`, `Cookie`, `hashSync`/`hmacSync`/`timingSafeEqual` (+ shared `Cryptography`), `parseFrontmatter`, `guardedFetch` |

The browser-safe core never reaches `node:*` or a server-only package; the server
addendum is reached only from server code. Both are wired into the framework
symbol mechanism, so their namespaces are on `globalThis` in app code — see
[symbols.md](/docs/symbols) for how projection works.

## Usage

In app code the namespaces are already global (the CLI bootstrap installs them
before any module evaluates):

```js
// No import: these are projected globals in app code (see conventions.md).
const slug = Str.slug('Hello, World'); // 'hello-world'
const label = Num.bytes(1_500_000); // '1.5 MB'
```

Outside app scope (a plain script, a test) import the namespace instead. Every
module also exports its functions individually, so a bundler can tree-shake to
just the helper you use:

```ts
import { Str } from 'jsails/support';
import { Files } from 'jsails/support/server';
```

The barrel (each subpath's index module, which re-exports its public API)
exports the **namespace objects and their error classes**, plus two bare
functions, `detach` and `escalate` (below); the namespaces' own functions are
not re-exported bare. Several helper names (`add`, `compact`, `format`,
`limit`, `parse`, `subtract`) exist in more than one namespace, and a barrel
cannot re-export two same-named symbols. Reach an individual function through
its namespace (`Time.add`), or import it from its concept module.

## Browser-safe core

### `Str` — strings

Case transforms (`camel`, `pascal`, `snake`, `kebab`, `constant`, `title`,
`capitalize`, `uncapitalize`), `slug`, `plural`/`singular` (`inflection`), and
hand-rolled text operations: `truncate`, `excerpt`, `words`, `limit`, `squish`
(collapse whitespace), `normalizeNewlines`, `stripTags`, `humanize`, `wrap`
(word-wrap to a column width), `isBlank`/`isPresent`, `escapeHtml`,
`unescapeHtml`, `random`, `mask`. `escapeHtml`/`unescapeHtml` cover the five HTML
entities (`& < > " '`) — they are **not** a sanitizer, and `stripTags` is a
string operation, not an HTML parser.

### `Num` — numbers

`format`, `compact`, `currency`, `percent`, `unit` (native `Intl.NumberFormat`),
`bytes` (owned formatter), `ordinal` (`Intl.PluralRules`), `clamp`, `round`,
`parse`, and the money pair below.

**Money is two jobs.** `Num.money(amount, currency)` returns a `dinero.js` value
object for **arithmetic** (add, subtract, multiply, allocate, compare).
`Num.formatMoney(amount, options)` renders a localized currency string for
**display** by wrapping the native `Intl.NumberFormat` — there is no maintained
money-formatting package worth adopting, so the display path is the platform
primitive plus the small gaps `Intl` does not cover (`accounting` parentheses and
an explicit `minorUnits` override). `Num.currency` is the raw `Intl.NumberFormat`
escape hatch.

```js
const total = Num.money(19.99, 'USD').multiply(3); // arithmetic
Num.formatMoney(total, { currency: 'USD' }); // '$59.97' (display)
```

### `Time` — dates & durations

`now`, `format` (native `Intl.DateTimeFormat`), `relative`
(`Intl.RelativeTimeFormat`), `duration` (`pretty-ms`), `parseDuration` (owned parser), and
`date-fns`-backed date math: `parse`, `diff`, `add`, `sub`, `startOf`, `endOf`,
`isToday`, `isPast`, `isFuture`. `TimeUnit` is
`'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'`.

### `Arr` — collections & objects

`groupBy` (native `Object.groupBy` with an `es-toolkit` fallback), `keyBy`,
`pluck`, `unique`, `uniqueBy`, `flatten`, `flattenDeep`, `compact`,
`compactBlank`, `pick`, `omit`, `get`, `set`, `has`, `sortBy`, `range`, `chunk`,
`merge` (earlier sources win), `deepMerge` (later overlays win, arrays
replace), `wrap`, `isEmpty`, `first`/`last`, `partition`, `inGroups`,
`transformKeys`/`transformValues`, `reverseMerge`, `clone`/`cloneDeep` (native
`structuredClone`), `equals` (owned structural equality), and `toSentence` (native
`Intl.ListFormat`).

### `Async` — flow control

`sleep`/`delay`, `once`, `debounce`, `throttle`, `memoize` (`es-toolkit`),
`retry` (owned exponential + explicit modes), `limit` (owned limiter),
`mapConcurrent` (owned concurrency mapper), `timeout(ms, { keepAlive? })` (a
`{ signal, clear }` handle; the timer is unref'd by default, and
`keepAlive: true` keeps the process alive for request-scoped work), and
`benchmark` (run a function and measure its wall-clock duration).

### `detach` — un-awaited promises

`detach(promise, report)` starts work without awaiting it and names where its
rejection goes. It is the one sanctioned way to leave a promise un-awaited:
`void promise` and a bare floating call drop the rejection on the floor, and
there is deliberately no `detach` without a reporter. `report` runs at most
once, only on rejection; if `report` itself throws, that error surfaces as an
unhandled rejection rather than being swallowed. A non-promise value (a
callback typed `void | Promise<void>` that returned synchronously) is accepted
and ignored.

`escalate` is the reporter for a promise that handles its own failures and so
must never reject: it rethrows (its return type is `never`), so the rejection
stays an unhandled rejection (the process's `unhandledRejection` handling sees
it, exactly as an un-awaited promise would). Pass a real error channel instead
whenever one exists.

```ts
import { detach, escalate } from 'jsails/support';

async function refreshCache(): Promise<void> {
  // Catches and logs its own failures, so it must never reject.
}

async function sendReceipt(orderId: string): Promise<void> {
  if (orderId === '') throw new Error('missing order');
}

detach(refreshCache(), escalate);
detach(sendReceipt('order-1'), (error) => {
  console.error('receipt failed', error);
});
```

Both are projected globals in app code like the namespaces, so app modules call
`detach(...)` with no import.

### `Encoding` — encodings

`base64`/`base64Decode` (platform `btoa`/`atob` for text, owned base64 for
binary), `base64url`/`base64urlDecode`, `hex`/`hexDecode`, `toDataUrl`,
`parseDataUrl`, `nanoid`, `uuid` (native `crypto.randomUUID`), `randomBytes`
(native `crypto.getRandomValues`).

### `Url` — URLs & query strings

`parseQuery`/`buildQuery` (flat, via the platform `URLSearchParams`),
`parseQueryDeep`/`buildQueryDeep` (nested, via `qs`), `join`/`addParams`/
`removeParams` over the platform `URL` class, and `contentDisposition` (a safe
`Content-Disposition` header value with an RFC 5987 UTF-8 filename).

### `Cryptography` — the one coherent surface

`hash`/`hmac` (native `crypto.subtle.digest`, lowercase hex), `equal`
(constant-time best-effort), `randomToken`. WebCrypto needs a **secure context**:
`hash`/`hmac` throw `insecure_context` on a non-`localhost` `http://` origin.
**MD5 and SHA-3 are not offered browser-side** — WebCrypto does not implement
them.

The **server does not shadow `Cryptography`**: it is one async surface on every
target. The server-only conveniences live under distinct names in
`jsails/support/server` (below).

## Server addendum

`jsails/support/server` re-exports the browser core and adds the server
namespaces. It is server-only and must never enter the browser bundle.

### `Files` — filesystem

`readJsonFile`, `writeJson`, `ensureDir`, `copy`, `move`, `remove` (native `fs/promises`),
`exists` (native `fs/promises`), `glob` (`tinyglobby`), and `toBase64`.
`writeJson` creates parent directories, writes a sibling temporary file, and
renames it into place, so a crash never leaves a truncated file. `move` checks
the source exists before touching the destination; replacing an existing
destination (or moving across devices) stages the new tree beside it and
restores the original if the swap fails.

### `Media` — MIME & media

`mime`/`extension` (`mime-types`), `detect` (`file-type` — sniffs a buffer's
magic bytes), `imageSize` (`image-size`).

### `Cookie` — cookies

`parse`/`serialize` (`cookie`), `parseSetCookie` (owned parser).

### Server-only crypto conveniences

The synchronous `node:crypto` digests are server-only **additions**, not a second
`Cryptography`:

- `hashSync(algorithm, data)` — lowercase hex for any `node:crypto` algorithm,
  including **MD5** and the **SHA-3** family (the legacy/interop hashes WebCrypto
  lacks).
- `hmacSync(algorithm, key, data)` — synchronous HMAC.
- `timingSafeEqual(a, b)` — the platform's true constant-time comparison.

`ServerCryptography` bundles these with the shared async `Cryptography` (so the
server namespace is a strict superset of the browser one). Import them directly
for legacy-interop server code:

```ts
import { hashSync } from 'jsails/support/server';

hashSync('MD5', 'abc'); // '900150983cd24fb0d6963f7d28e17f72'
```

The bare global `globalThis.Cryptography` is the **same async surface on the
server and browser** — no divergence, no namespace-key parking.

### Top-level helpers

`parseFrontmatter(input)` (`yaml`) returns `{ data, content }`.
`serializeError(error)`, which turns an `Error` into a plain, JSON-safe
object, lives with the rest of the error kernel in `jsails/errors`.

### `guardedFetch` — outbound HTTP

`guardedFetch(url, options)` is the framework's one outbound HTTP primitive,
for any request whose URL may come from someone else: a bundle URL from an
admin form, a catalog, a webhook endpoint. Outbound features build on it.

```ts
import { GuardedFetchErrors, guardedFetch } from 'jsails/support/server';

async function latestVersion(): Promise<string | undefined> {
  try {
    const response = await guardedFetch('https://registry.npmjs.org/jsails', {
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 10_000,
      allowHosts: ['registry.npmjs.org'],
      headers: { accept: 'application/json' },
    });
    if (response.status !== 200) return undefined;
    const document: unknown = JSON.parse(new TextDecoder().decode(response.bytes));
    const tags = (document as { 'dist-tags'?: { latest?: string } })['dist-tags'];
    return tags?.latest;
  } catch (error) {
    if (GuardedFetchErrors.is(error, 'timeout')) return undefined;
    throw error;
  }
}
```

Every hop, the first URL and each redirect, is checked the same way before a
byte is sent:

- The URL must be credential-free `https:`. Plain `http:` is allowed only with
  `allowPrivate: true` and only when every address the host resolves to is
  loopback.
- With `allowHosts`, the host must be on the list. Entries are bare host
  names (an IPv6 literal in brackets, no port), compared with `URL#hostname`
  after the same normalization: case, punycode, and IP literal form. Any other
  entry is `invalid_options`.
- The host is resolved **once**. If any address is loopback, link-local,
  private, carrier-grade NAT, unique local, unspecified, multicast,
  documentation, or reserved (IPv4 and IPv6, including IPv6 forms that carry an
  IPv4 address), the request fails with `blocked_address`, unless
  `allowPrivate: true`.
- The connection goes to one of exactly those checked addresses, with the TLS
  server name and the `Host` header taken from the URL. A resolver that answers
  differently a moment later (DNS rebinding) cannot move it.

`maxBytes` and `timeoutMs` are required. The deadline covers the whole chain:
every lookup, connect, TLS handshake, and body. A body over `maxBytes`
(declared or received) fails with `too_large` at once, and every exit closes the
connections the request opened. `maxRedirects` defaults to 5 (0 follows none).
A 303, or a 301/302 after a `POST`, turns into a `GET` without a body. A
redirect to another origin drops `Authorization`, `Cookie`, and
`Proxy-Authorization`. `method` is one of `GET`, `HEAD`, `POST`, `PUT`,
`PATCH`, `DELETE`. Connection-level headers (`Host`, `Connection`,
`Content-Length`, `Transfer-Encoding`, ...) are refused as `invalid_options`,
because the fetch sets them itself.

The result is `{ status, headers, bytes, url }`. A non-2xx status is a
response, not an error. A refused or failed request rejects with a
`GuardedFetchErrors` code, `guarded_fetch.` followed by one of
`invalid_options`, `invalid_url`, `host_not_allowed`, `resolve_failed`,
`blocked_address`, `connect_failed`, `tls`, `response_failed`,
`too_many_redirects`, `too_large`, `timeout`, or `aborted` (from
`options.signal`). Neither the message nor the context names the URL, a
header, or a resolved address.

`createGuardedFetch({ resolve, connect, ca })` builds an instance over another
transport: a resolver (`hostname => addresses`), a connector that opens a TCP
socket to the vetted `{ address, port }` it is given, and PEM certificates to
trust instead of Node's roots. Tests use it to point the guard at a loopback
server. The checks themselves are not part of the transport, so an instance
built this way enforces the same rules.

## Errors

Each namespace declares its failures in an **error registry** (`defineErrors`
from `jsails/errors`): every code is `domain.code`, and its message is rendered
from the code's template and validated context, so it names the operation,
never the input. Every `jsails/support` error is **value-free**. Recognize one
with the registry's `is`, never `instanceof`:

`StrErrors`, `NumErrors`, `TimeErrors`, `ArrErrors`, `AsyncErrors`,
`EncodingErrors`, `UrlErrors`, `CryptographyErrors`, and the server addendum's
`FilesErrors`, `MediaErrors`, `CookieErrors`, `FrontmatterErrors`, and
`GuardedFetchErrors`.

```ts
import { Encoding, EncodingErrors } from 'jsails/support';

export function decodeOrNull(input: string): Uint8Array | null {
  try {
    return Encoding.base64Decode(input);
  } catch (error) {
    if (EncodingErrors.is(error, 'decode_failed')) return null;
    throw error;
  }
}
```

An argument of the wrong type is the calling code's bug and raises an
`internal` code (`str.expected_string`, `arr.expected_array`); input that does
not parse raises an `invalid` one (`num.not_a_number`, `time.invalid_date`,
`encoding.decode_failed`, `url.invalid_url`). A malformed base64/hex input
throws `encoding.decode_failed` without echoing the input; `Cryptography.equal` returns `false` on a length mismatch rather than
throwing; `parseDataUrl` returns `null` on a non-match (a parse's "no match" is a
value, not an error).

## Honest limits

- **`crypto.subtle` requires a secure context.** Browser `Cryptography.hash`/
  `hmac` throw `insecure_context` on a non-`localhost` `http://` origin — a
  platform constraint, not a JSails choice.
- **`structuredClone` limits.** `Arr.clone`/`cloneDeep` cannot clone functions,
  DOM nodes, class prototypes (methods are lost), or `WeakMap`/`WeakSet`.
  The platform primitive is the only implementation — no fallback package.
- **MD5 gap.** MD5 is server-only. A browser caller needing MD5 has no JSails
  helper — a deliberate non-goal.
- **Money split.** `Num.money` is arithmetic; `Num.formatMoney` is display.
  Compose them (`formatMoney(money(amount, currency), { currency })`) when you
  want both.
- **`Arr.groupBy` uses `Object.groupBy`.** Node 26 provides the native
  implementation; there is no runtime feature detection.
- **`stripTags` is not sanitization.** It removes simple tags with a string
  operation; script/style content survives as text. Use a real parser for
  hostile markup.
- **`Arr.deepMerge` protocol guard.** Prototype-polluting keys (`__proto__`,
  `constructor`, `prototype`) are skipped rather than assigned. Arrays are
  replaced, never concatenated.
- **`Files.glob` interprets a pattern.** It uses `tinyglobby`; a pathological
  caller-supplied pattern can consume CPU. Never pass untrusted input as a glob
  pattern.
- **`guardedFetch` is deliberately plain.** HTTP/1.1 only, one connection per
  request (no keep-alive pool), no proxy support, and no response
  decompression (it asks for nothing compressed, and returns the bytes as they
  arrive). When a host has several vetted addresses, an address that drops
  packets instead of refusing holds the request until the deadline before the
  next one is tried.
- **Deferred.** No locale-aware collation helper; no `Time` timezone database
  beyond `Intl`; no `Files` streaming API; no `Media` image transform (that is
  `@jsails/filesystem`'s variant seam).

## Related

- [Services & Utilities](/docs/services) — cache, mail, filesystem, notifications,
  validation, HTTP client.
- [Symbols & Autoload](/docs/symbols) — how namespaces reach `globalThis`.
