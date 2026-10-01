---
title: Services & Utilities
order: 23
section: Reference
---

# Services & Utilities

There are two kinds of service in JSails: **domain services** you write to
encapsulate application work, and the **utility services** the framework ships.

## Domain services

`defineService({ name?, input, run })` builds a reusable, callable unit of work.
Jobs, commands, pages, and API routes call the same function; the service owns
input validation and the work itself.

```ts
// services/send-invoice.ts
import { defineService } from 'jsails';
import { z } from 'zod';

export const sendInvoice = defineService({
  name: 'sendInvoice',
  input: z.object({ invoiceId: z.string() }),
  async run({ invoiceId }) {
    // The work: load, compute, persist, call another service.
    return { invoiceId };
  },
});
```

```ts
// From a job, command, page, or API route:
const result = await sendInvoice({ invoiceId: 'inv_1' });
```

- `input` is parsed before `run`; invalid input throws `ServiceInputError` with
  value-free `{ field, message }[]` (never echoes input, secrets, or raw values).
- `run` receives already-validated, typed input.
- `name` is diagnostic only; it is not a queue or route identity.
- `defineService` is exported from the root `jsails` entry and `jsails/services`;
  app code gets it (and `Service`) as an autoloaded global.
- A domain service is **not** a job and **not** a command. Jobs and commands are
  delivery adapters; the service is the shared work they call.

### Multi-method services

When related operations share dependencies, extend `Service` and declare each
operation with `this.action(...)`. The class holds the dependencies; each action
keeps its own validated input. In app code both `Service` and `defineService`
are autoloaded; the imports below are the explicit form.

```ts
// services/user-service.ts
import { Service } from 'jsails';
import { z } from 'zod';

export class UserService extends Service {
  constructor(private readonly users: UserRepository) {
    super();
  }

  readonly register = this.action({
    input: z.object({ email: z.string().email(), password: z.string() }),
    run: async (input) => this.users.create(input),
  });

  readonly login = this.action({
    input: z.object({ email: z.string().email(), password: z.string() }),
    run: async (input) => this.users.authenticate(input),
  });
}

const users = new UserService(userRepository);
await users.register({ email: 'ada@example.com', password: 'secret' });
```

An operation can also be static; use `static readonly` and `this.action`. Each
operation is a normal `ServiceFn`: it has `.input`, throws `ServiceInputError`
on invalid input, and can be used wherever a standalone `defineService` is used.

The class carries dependencies (or the subject an operation acts on), not a
request payload accumulated across calls. Pass per-call data as the operation
input; use `z.void()` when an operation only needs constructor state.

## Utility services

JSails ships a cluster of small, focused utility services you can opt into:
caching and rate limiting, mail, filesystem blobs, notifications, validation
rules, and an HTTP client. Each is a narrow contract with an in-memory default
and, where it makes sense, a first-party plugin that exposes it under a typed
service token. Construction is inert — nothing connects until you call a method.

## Cache

`jsails/cache` owns the string-keyed `CacheStore` and atomic `MutexStore`
contracts plus their service tokens. `@jsails/cache` implements them with an
in-memory default (`MemoryCacheStore`) and an optional Valkey backend
(`ValkeyCacheStore`). A fixed-window `FixedWindowRateLimiter` runs over the same
store — `guardRateLimit` for the check and `rateLimitResponse` for a value-free
`429`. `cachePlugin` exposes a `CacheStore` under `cacheToken`; pass
`mutex: true` (or `mutex: { store, prefix }`) to also provide a `MutexStore`
under `mutexToken`, backed by the same Valkey URL when one is configured.
`throttle` builds a per-key request throttle on the same limiter.

```js
import { FixedWindowRateLimiter, MemoryCacheStore } from '@jsails/cache';

const store = new MemoryCacheStore();
const limiter = new FixedWindowRateLimiter({ store, limit: 60, windowMs: 60_000 });
```

### Rate-limiter atomicity

`FixedWindowRateLimiter.check` is atomic when the store implements the optional
`increment(key, ttlMs)` method — both built-in stores do. The memory store bumps
the counter synchronously; the Valkey store runs `INCR` plus a first-increment
`PEXPIRE` as one Lua script, so concurrent callers across processes cannot all
observe the pre-increment count. A custom store without `increment` falls back to
a read-then-write that the limiter serializes per key in-process: correct for a
single process, but a multi-process deployment must use a store with `increment`
to get the same guarantee across processes. `throttle` reuses one limiter per
store, clock, limit, and window, so that per-key serialization holds across
calls too.

### Bounded memory

`MemoryCacheStore` accepts `maxEntries` (default 10 000). When the store exceeds
the cap it sweeps expired entries first, then evicts counters that have been
hit only once (oldest first), and only then the oldest insertions. Rate-limit
counters created by `increment` count toward the same cap, so a flood of unique
throttle keys cannot grow the heap without bound, and because the flood's own
fresh keys are evicted first it cannot reset a counter that is near its limit
(a login throttle under attack). Once every live counter has more than one hit,
the oldest are evicted and those windows restart, so size `maxEntries` above
the number of keys one window legitimately holds. The
page revalidation index is bounded the same way: a key recorded with a TTL is
dropped once that TTL elapses, and the index evicts its oldest keys past its own
cap.

## Mail

`@jsails/mail` is a minimal, transport-agnostic mail seam: the `Mailer` contract
plus three transports and a first-party plugin. Use `InMemoryMailTransport`
(in-memory capture for tests), `CallbackMailTransport` (an injected callback),
or `SmtpMailTransport` (lazy SMTP over nodemailer, loaded at first send).
`mailPlugin({ transport?, smtp?, allowMemory? })` exposes the mailer under
`mailToken` with lazy, fail-closed transport resolution; the `Mail` facade
resolves that mailer from the live application scope. The package is
server-only; nodemailer is pulled in only when SMTP is actually used. Preact
templates (`defineMail`), queued delivery (`Mail.queue`), and the development
preview are covered in [Mail](/docs/mail).

```js
// No import: these are projected globals in app code (see conventions.md).

const mail = mailPlugin({ transport: new InMemoryMailTransport() });
```

A message takes one recipient or an array, optional `cc`, `bcc`, and
`replyTo`, and in-memory `attachments` (`{ filename, content, contentType? }`).
An address is a bare `user@example.com` or a structured
`{ name: 'App', address: 'no-reply@example.com' }`; a display name is never
parsed out of a string, so `"App" <no-reply@example.com>` as a string is
refused. One message carries at most 100 recipients across `to`, `cc`, and
`bcc`, and every address, display name, attachment filename, and the subject
is checked for header injection.

`SmtpMailTransport` pools connections and bounds every phase by default:
`pool: true`, `maxConnections: 5`, `connectionTimeoutMs: 10000`,
`greetingTimeoutMs: 10000`, and `socketTimeoutMs: 30000`. An unreachable or
slow server therefore fails a send in seconds instead of holding a request for
minutes. With a `url`, the settings travel as URL query parameters, and a
parameter already in the URL (`smtp://host?pool=false`) wins.

## Filesystem

`@jsails/filesystem` is a keyed blob-store `Disk` contract with three
implementations and a plugin. `new LocalDisk(options)` backs a disk with the
local filesystem; `new MemoryDisk(options)` is an in-memory disk for tests and
demos; `new S3Disk(options)` stores objects in AWS S3 or any S3-compatible
service (Cloudflare R2, MinIO, SeaweedFS, RustFS). `filesystemPlugin({ disks })`
exposes a named `FileSystem` service over those disks under `filesystemToken`.
On top of it, `defineVariant` / `DiskVariantResolver` lazily cache
transformations of a stored source file (the caller supplies the transform — no
image library dependency).

The `Disk` contract in `jsails/filesystem` has two optional capabilities on
top of the base `put`/`get`/`exists`/`delete`/`list`/`size`. Code that accepts
any `Disk` checks for a capability and falls back to the base methods without
it.

Every disk in the package implements the streaming capability (check for it
with `isStreamingDisk(disk)`): `stream(key, { range })` returns a web
`ReadableStream` of the file or one inclusive byte range, with its `size`,
`start`, and `end`, and `putStream(key, source, { maxBytes })` writes from a
stream, refusing with `too_large` as soon as the cap is crossed. `LocalDisk`
streams from and to the file system without buffering (a stream write lands in
a temp file renamed into place, and a write that fails midway rejects with
`io_failed` and removes the temp file); `S3Disk` serves ranges with a ranged `GET`.
`S3Disk` also has `listPage(prefix, { cursor, limit })` for paged listing and
bounds every request with `connectionTimeoutMs` (default 5000) and
`requestTimeoutMs` (default 30000).

`S3Disk` also implements the signed-URL capability (check with
`isUrlDisk(disk)`, or call `diskUrl(disk, key, options)`, which refuses a disk
without it). `url(key, { expiresIn?, disposition?, filename?, contentType? })`
returns a presigned `GetObject` URL that reads one object straight from the
store, so a download or preview does not pass through the app. The URL is
signed locally with no network call, and the store does not check that the
object exists until the URL is fetched.

```js
import { diskUrl } from 'jsails/filesystem';

const href = await diskUrl(files.disk, 'reports/q3.pdf', {
  expiresIn: 600, // seconds
  disposition: 'attachment',
  filename: 'Q3 report.pdf',
  contentType: 'application/pdf',
});
```

- **Lifetime.** `expiresIn` is a whole number of seconds from 1 to 604 800
  (`DISK_URL_MAX_EXPIRES_IN`, 7 days, the SigV4 maximum) and defaults to 900
  (`DISK_URL_DEFAULT_EXPIRES_IN`, 15 minutes). A value outside that range
  throws a `TypeError`; it is not clamped. A signed URL is a bearer link that
  works for anyone holding it until it expires, so keep lifetimes short.
- **Response headers.** `disposition` (`inline` or `attachment`, plus an
  optional `filename`) and `contentType` are signed into the URL as response
  overrides, so the holder cannot change them. A filename with control
  characters, a filename without a disposition, or a malformed media type
  (anything outside RFC 9110 token syntax; only a space or tab may surround a
  `;`) throws a `TypeError`.
- **Keys.** Keys follow the same rules as every other disk method, and the
  disk's `prefix` is applied.
- **Unsupported disks.** `LocalDisk` and `MemoryDisk` have no origin to hand a
  client, so they do not implement `url`, and `diskUrl` refuses them with a
  value-free `DiskError` whose code is `unsupported`. Serve their files through
  an app route, as the media admin does. An `S3Disk` built around an injected
  `client` signs only when that client is a real `S3Client`; with a bare `send`
  double it also refuses with `unsupported`.

`LocalDisk`'s `maxBytes` quota is accounted atomically: writes and deletes on a
quota-limited disk are serialized, so concurrent uploads cannot overshoot it.

Variant objects are stored under `_variants/<sha256(source key)>/<sha256(seed)>`,
so every variant of one source shares a prefix and
`resolver.purge(sourceKey)` deletes them all — call it when the source is
removed. A resolver remembers keys it has materialized (up to `knownKeyLimit`,
default 10 000) and skips the `exists` round trip for them; a variant deleted
behind its back is regenerated only through `purge` or by a fresh resolver. A
variant's `contentType` is passed to the disk on write. Variants written under
the earlier key layout are not found, and are regenerated on first use.

## Media

`@jsails/media` is a disk-backed media library: `createMediaLibrary({ disk,
diskName, metadata?, maxBytes?, maxPixels?, allowedTypes?, variants? })` and the
`mediaAdmin` admin page.

- **Access.** `mediaAdmin({ library, authorize })` takes an
  `AdminPageAuthorize`, checked after the panel's own `authorize`; only an
  exact `true` admits a session. Without it the page answers 403 to everyone,
  since the panel gate admits a session to the panel, not to a page that
  uploads, rewrites, and deletes every asset.

- **Content checks.** `upload` sniffs the bytes rather than trusting the
  declared MIME type. A recognized format must be on the allowlist and agree
  with the declared type (`application/octet-stream` defers to the bytes), and
  it is the type recorded. A declared image, audio, video, or PDF whose bytes
  match no signature is refused. A filename extension naming another type is
  rewritten to the recorded type's (`payload.html` holding a PNG is stored as
  `payload.png`). Image width and height are read from the bytes, and an image
  over `maxPixels` (default 100 megapixels) is refused.
- **Size.** `maxBytes` defaults to 960 KiB, which fits under the framework's
  default 1 MiB request body limit with room for multipart framing. Raise the
  server's `maxBodyBytes` together with `maxBytes`; raising only `maxBytes`
  lets the server refuse an upload the library would accept.
- **Listing.** `library.query({ q?, mime?, limit, offset? })` returns
  `{ assets, total }` for one page (at most 1000), ordered by filename then id.
  `createDatabaseMediaIndex` runs it in SQL; a custom index without `query`
  falls back to filtering `list()`. The admin list shows 50 rows per page.
- **Bytes.** `library.stream(asset, range?)` streams an asset (through the
  disk's streaming capability when present). The admin download route serves a
  single `Range` with `206 Partial Content`, and list thumbnails are lazy
  `<img>` tags loading from the page's `?preview=<id>` route (raster images
  under the preview cap only, under a CSP that allows nothing), so rendering
  the list reads no asset bytes. Downloads and previews carry
  `X-Content-Type-Options: nosniff` and a sandboxing CSP, so a browser never
  sniffs an upload into a page that runs with the admin's cookies. A
  `type/*` entry in `allowedTypes` or a `mime` filter matches only that
  top-level type (`image/*` does not match `imagex/...`).
- **Direct URLs.** `library.url(asset, { expiresIn?, disposition? })` returns a
  signed URL that reads the asset straight from a disk with the signed-URL
  capability. It returns `undefined` on any other disk, and on a disk whose
  `url` refuses as `unsupported` (an `S3Disk` built around a test `send`
  double). `disposition` defaults to `attachment`. `inline` is honored only
  for raster images (JPEG, PNG, GIF, WebP, AVIF). Any other type, including an
  SVG an app added to `allowedTypes`, is signed as an attachment, because the
  store serves it without the sandboxing CSP of the app's preview route. The
  filename and content type in the URL are always the ones recorded at upload,
  never caller input. A bad option raises `invalid_input`.
  `mediaAdmin({ library, directUrls: true })`, or `directUrls: { expiresIn }`,
  makes the admin download and preview routes answer `302` to such a URL
  (5 minutes by default) after the usual authorization check, so the bytes skip
  the app. A malformed `directUrls` (or a lifetime outside 1 second to 7 days)
  throws a `TypeError` when `mediaAdmin` or `defineMediaAdminPage` is called. The redirect carries `Cache-Control: private, no-store` and
  `Referrer-Policy: no-referrer`. It is off by default because the link works
  for anyone holding it until it expires, and because a Content Security
  Policy has to allow images from the store's origin for thumbnails to load.
  On a disk that cannot sign, the routes keep streaming.
- **Variants.** Pass the disk's variant resolver as `variants` and `remove`
  purges an asset's variants along with it.

`createDiskFromEnv()` is the deployment switch. It constructs exactly one disk:

```js
const files = createDiskFromEnv();
// FILESYSTEM_DISK=local (default) → storage/files
// FILESYSTEM_DISK=s3 → S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID,
//   S3_SECRET_ACCESS_KEY, S3_SESSION_TOKEN, S3_ENDPOINT,
//   S3_FORCE_PATH_STYLE, S3_PREFIX
const filesystem = filesystemPlugin({
  disks: { [files.name]: files.disk },
  default: files.name,
});
```

`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` must be set together; omit both
to use the SDK's default credential chain (instance role, ECS task role, SSO).
Set `S3_FORCE_PATH_STYLE=true` for MinIO and most local S3-compatible services.

## Notifications

`@jsails/notifications` is a narrow, multi-channel delivery seam. A
`NotificationMessage` is smaller than a mail message — `to`, `subject`, and a
required plain-text `text` body — so any channel (mail, SMS, push) can consume
it. Two channels ship: `InMemoryNotificationChannel` captures messages in-process, and
`MailNotificationChannel({ mailer })` adapts the `@jsails/mail` `Mailer`.
`notificationsPlugin({ channels?, mail? })` exposes a `NotificationsService`
under `notificationsToken`; `notify(message, { channels? })` sends through every
selected channel and aggregates failures into a value-free `NotificationError`.
Each channel has `channelTimeoutMs` (default 30000) to finish; a channel that
takes longer counts as failed, so a hung mail server cannot hold the caller.
Defined notifications (`defineNotification`) add a database inbox with
read/unread state, realtime broadcast, and queued mail; see
[Notifications](/docs/notifications).

```js
// No import: these are projected globals in app code (see conventions.md).

const notifications = notificationsPlugin({
  channels: { memory: new InMemoryNotificationChannel() },
});
```

## Validation

`jsails/validation` provides composable, value-free Zod-backed validation rules
and a bulk validation helper. Each rule returns a Zod schema (for direct
composition into `z.object({...})`) or a `ValidationRule` predicate for
cross-field checks — `required`, `email`, `url`, `minLength` / `maxLength`,
`min` / `max`, `regex`, and `inList` are schema rules, while `confirmed(field)`
and `when(condition, rule)` are predicates. Without an import, `when` is reached
as `validation.when`: bare `when` is the `jsails/database` CASE builder (see
[Symbols](/docs/symbols)). `validateFields(schema, values)`
runs a Zod object schema and returns a flat array of value-free `FieldError`
objects. Messages never echo input values.

```js
// No import: these are projected globals in app code (see conventions.md).

const errors = validateFields(schema, values);
// confirmed('password') requires password_confirmation to match
```

## HTTP client

`jsails/http` is a thin fetch-based HTTP client seam with typed
`get`/`post`/`put`/`patch`/`delete` methods. Every method encodes/decodes JSON,
enforces a bounded timeout via AbortController, and surfaces failures as
value-free `HttpClientError`s (status + message; never the request URL or
response body). Pass an injectable `fetch` for testing — the client uses
`globalThis.fetch` by default.

```js
// No import: these are projected globals in app code (see conventions.md).

const http = new FetchHttpClient({ baseUrl: 'https://api.example.com' });
const user = await http.get('/users/42');
```

## Facades

A facade resolves a service by a stable name through the **ambient application
scope**, so a call site writes `Cache.get('x')` with no `new`, no import, and no
token. Any author — framework or application — can make their own class a facade
in one line.

```ts
import { facade, installFacades } from 'jsails/facades';

// One line makes YOUR class a facade. `cacheToken` carries the type.
export const Cache = facade(cacheToken);

// At boot, opt in to the names you want available globally.
installFacades({ Cache, Logger, Encrypter });
```

Inside any request, setup hook, or the app `setup`, the facade resolves to the
current application's service:

```ts
Cache.get('session:42'); // forwarded to the instance, typed
Logger.child({ req }).info('handled'); // real logger; chains natively
```

Resolution is by **token identity**, never a string key, and happens **per call**
against the current scope — so the same facade name resolves correctly under any
number of concurrently-live applications (a test app and a served app never
collide), and a call after the app closes fails cleanly instead of returning a
stale instance. `facade(token)` memoizes **per token**: repeated calls with the
same token return the same proxy, so an `installFacades` re-run across two live
apps is a no-op rather than a collision.

- `facade(token)` — a typed proxy over the token's service `T`, canonical per
  token. Use it directly (no global) for CLI scripts, pre-app code, and tests.
- `installFacades({ ... })` — publish names onto `globalThis`. Idempotent when
  the same token's proxy is reinstalled; a name held by a *different* facade
  raises a `TypeError`.

**Errors** are value-free `FacadeError`s: `no_app_scope` when used outside app
work (a top-level CLI script, or after `close()`), and `unresolved` when the
scope has no provider for the token.

**Honest limits.** Facades are server-only (`jsails/facades` reaches
`node:async_hooks` for the ambient scope) and meaningless outside application
work — resolve through a token or the extension runtime there. Detaching a
method (`const { get } = Cache`) loses binding; call through the proxy. Which
services become global names is opt-in. The `work`-driven job runtime resolves
facades inside job handlers and middleware when the runtime config declares
`extensions`; absent `extensions`, behavior is unchanged (`no_app_scope`).

```js
// jsails.runtime.js  (declaring extensions so facades resolve in job handlers)
export default {
  registry: createJobRegistry({ sendEmail }),
  valkeyUrl: 'redis://127.0.0.1:6379',
  extensions: [cachePlugin()],
};
```

## Next steps

- [Theme Tokens](/docs/theming), [Feature Flags](/docs/flags), and [Internationalization](/docs/i18n) — the presentation seams.
- [Observability](/docs/observability) — logging, signals, diagnostics, and watchers.
- [Encryption](/docs/encryption) — symmetric AES-256-GCM encryption.
- [Support Helpers](/docs/support) — the global `Str`/`Num`/`Time`/`Arr`/`Files` toolkit.
