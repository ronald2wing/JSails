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

## Service tokens

Plugins share services through typed tokens: `createServiceToken<T>(name)` from
`jsails/services` returns a token, a plugin lists it in `provides` and calls
`services.provide(token, value)`, and another lists it in `requires` and reads
`services.get(token)`, typed `T`. A token is identified by the object, not its
name, so two tokens with one name stay distinct services.

### Keyed and live tokens

A token is also the family of its **keyed members**: `token.named(key)`
returns one member per key (always the same object for that key), named
`<name>:<key>` and typed like the family. Two plugin instances can each
provide one member, so an application can run two disks or two caches side by
side and a plugin option chooses which one a consumer uses
(`tokenRef(diskToken)` accepts the family and any member). One plugin
configured once per disk declares `key`, so each instance gets its own name
(see [One plugin, several instances](/docs/plugins#one-plugin-several-instances)).

```ts
import { createServiceToken } from 'jsails/kernel';

interface Disk {
  read(path: string): Promise<Uint8Array>;
}

export const diskToken = createServiceToken<Disk>('disk');
export const mediaDisk = diskToken.named('media');
export const backupDisk = diskToken.named('backups');

export const queueToken = createServiceToken<{ push(job: string): Promise<void> }>('queue', {
  live: true,
});
```

`createServiceToken(name, { live: true })` marks a service that exists only in
a live process (a queue, a socket server); its members are live too. A static
export (the `export` role) leaves out every plugin that touches a live token,
and every plugin whose required service only such a plugin provides.

## Utility services

JSails ships a cluster of small, focused utility services you can opt into:
caching and rate limiting, mail, filesystem blobs, notifications, validation
rules, and an HTTP client. Each is a narrow contract with an in-memory default
and, where it makes sense, a first-party plugin that exposes it under a typed
service token. Construction is inert — nothing connects until you call a method.

## Cache

`jsails/cache` owns two store contracts and their service tokens, and
`defineCache`, the one way to cache a derived value (see
[Defined caches](#defined-caches)):

- `CacheStore` — an evictable, TTL-bounded key-value store of strings and
  bytes: `get`, `getMany`, `set`, `add` (store only while the key is free),
  `delete`, `namespace(name)`, and `close`. Every member is required, so every
  store gives the same guarantees. An entry may vanish before its TTL, so
  nothing whose loss breaks correctness belongs in a cache.
- `LeaseStore` — exclusion that does not vanish under memory pressure:
  `acquire(key, ttlMs)` returns a `Lease` (`{ key, token, fence }`) or `null`
  while the key is held, and `renew` and `release` act only for the holder
  whose token and fence still match, so a holder whose lease expired can never
  extend or free the next holder's. Fences grow with every acquisition.

TTLs are whole milliseconds from 1 ms to one year (`MAX_CACHE_TTL_MS`), and
keys are 1 to 1024 characters. A bad argument, a closed store, or an
unreachable backend raises a value-free `CacheErrors` code (`cache.invalid_ttl`,
`cache.closed`, `cache.unavailable`, …).

`@jsails/cache` implements them: `MemoryCacheStore` (a least-recently-used
cache bounded by `maxBytes`, default 64 MiB, and `maxEntries`) and
`ValkeyCacheStore`, `MemoryLeaseStore` and `ValkeyLeaseStore`. `cachePlugin`
provides a `CacheService` under `cacheToken`: each consumer asks for its own
namespace, and no token reaches the root, so no plugin can read or clear
another's entries. It is a `definePlugin` plugin, so its options are data
checked when the factory is called (`config.invalid_options` before anything
runs). `store` picks the root: unset, the app's Valkey when it has one and
memory otherwise; `'memory'` or `'valkey'` to force one; or a
`cacheStoreToken` (from `jsails/cache`) naming a store another plugin
provides, which the cache then requires, uses verbatim and never closes.

```ts
import type { CacheService } from 'jsails/cache';

// `service` is `services.get(cacheToken)`.
export async function saveSession(service: CacheService, id: string, state: object) {
  const sessions = service.cache('sessions');
  await sessions.set(id, JSON.stringify(state), 60_000);
  return sessions.add(`nonce:${id}`, '1', 300_000); // true for the first caller only
}
```

Pass `leases: true` (or `leases: { prefix, url }`) to also provide a
`LeaseStore` under `leaseToken`; `withLease(store, key, { ttlMs }, work)` holds
one for the length of `work`, renewing it every third of its TTL and aborting
the work's signal once it may be lost: when the store refuses a renewal, or
when no renewal has succeeded within the TTL (the store unreachable while
another process can take the expired lease). An app with a lease store of its
own provides `leaseToken` from its own plugin instead. Both stores run on the
app's Valkey connections when it has them (`valkeyToken`, which
`valkeyPlugin({ url })` from `jsails/plugin-sdk` provides, or else the
`VALKEY_URL` the cache plugin declares, whose connections it owns and closes),
and in memory otherwise. On Valkey the cache
lives under `<app prefix>:cache` and the leases under `<app prefix>:lease`;
leases need a server whose `maxmemory-policy` evicts nothing, and
`ValkeyLeaseStore` warns once when it does. `leases.url` puts them on a second
server, so the cache's server can evict freely.

### Bounded memory

`MemoryCacheStore` charges each entry the UTF-8 bytes of its key and value.
When a write takes it over `maxBytes` or `maxEntries` it drops every expired
entry first (found through an expiry heap, not a scan), then the least
recently used entries, never the one just written; reads refresh recency. An
entry larger than `maxBytes` is refused with `cache.too_large` before anything
changes. `MemoryLeaseStore` is a separate structure that never evicts a live
lease and sweeps expired ones on `acquire`, so filling the cache cannot drop a
lock. The page revalidation index is bounded the same way: a key recorded with
a TTL is dropped once that TTL elapses, and the index evicts its oldest keys
past its own cap.

### Defined caches

`defineCache(services, definition)` declares a read-through cache over the
app's cache services, typically in a plugin's `setup`. `get(key, load)` serves
the entry for `key` while it is fresh and its tags are current, and otherwise
runs `load` once however many callers ask at the same time; `invalidate(...tags)`
drops every entry, of any defined cache in any process of the app, that
recorded one of the tags. Call it after the write it reflects has committed.

```ts
import { defineCache, type CacheServices } from 'jsails/cache';

export function menuCache(services: CacheServices) {
  return defineCache<readonly string[]>(services, {
    name: 'shop.menu',
    ttlMs: 60_000,
    staleMs: 30_000,
    tier: 'process',
    tags: () => ['shop:menu'],
  });
}

// const items = await menu.get(locale, () => loadMenu(locale));
// after a menu write commits: await menu.invalidate('shop:menu');
```

- **Tiers.** `tier: 'process'` keeps values by reference in the process,
  bounded by `maxEntries` (1 000, least recently used first). `tier: 'shared'`
  stores them in the app cache (`codec`, JSON by default; `maxBytes`, 1 MiB
  by default, beyond which a value is returned unstored), so every process
  shares one copy.
- **Tags are tokens.** Each tag's current version is an opaque random token
  in the app cache; an entry records its tags' tokens when it is loaded and
  is valid while they are still current. `invalidate` mints new tokens. A
  token the cache lost reads as missing and a new one is minted, so losing
  one invalidates rather than revives. `valueTags(value)` adds tags derived
  from a loaded value; a cache with them must give every key a tag of its own.
  At most 32 tags per entry; keep them few and coarse (one per content domain).
- **Capture before load.** The key's tag tokens are read before `load`; when
  any invalidation lands in the process while it runs, its value is returned
  and not stored. Once `invalidate` resolves, no `get` started afterwards in
  the process returns an older value.
- **Single flight and stale-while-refresh.** Concurrent gets of one key share
  one load, and a loader error rejects them all without being cached. An entry
  past `ttlMs` but within `staleMs` is refreshed by the caller that finds it,
  while callers arriving meanwhile get the stale value; an invalidated entry is
  never served stale. `stampede: 'cluster'` (shared tier, with `leases`
  enabled on the cache plugin) runs one load across processes under a lease:
  the others serve stale or wait for the winner's entry.
- **Across processes.** Each process keeps the tokens it read, so a warm tag
  costs no round trip. On the plugin's Valkey store an invalidation is
  published on `<app prefix>:cache:tags` and the other processes drop the tag
  at once; every `tags.syncMs` (5 000 ms) each process also re-reads its warm
  tags in one `getMany`, which bounds staleness when a message is lost or the
  bus is off. The first cold reads wait for the bus subscription; once an
  attempt fails, reads stop waiting, the subscription is retried with a
  doubling backoff (from `syncMs`, at most a minute), and every tag read
  meanwhile is read again once it is live. A process holds at most 10 000
  tags, dropping the least recently used. With an explicit `store`, pass
  `tags: { bus: true }` to `cachePlugin` when several processes share it.
- **Failures.** A cache outage never fails a read: the value is loaded and
  returned uncached. `invalidate` rejects `cache.unavailable` when the new
  tokens could not be written; retry it. `stats()` counts hits, stale serves,
  misses, coalesced gets, skipped stores, evictions, invalidated entries and
  tolerated errors.
- **Context.** `load` runs in the async context the cache was defined in, not
  the caller's, because the value is shared: it must depend on its key alone,
  never on a request's tenant, scope or open transaction.

Authorization data (sessions, memberships, tenant status) must not go through
a defined cache: a revocation has to take effect on the next request. Names
are unique per app (`cache.duplicate_cache`).

### Rate limiting

A fixed-window `FixedWindowRateLimiter` keeps its counters apart from every
cache: in a bounded in-process map, or under `<app prefix>:ratelimit` on Valkey
when given the app's `connections`, where `INCR` and a first-hit `PEXPIRE` run
as one Lua script so concurrent callers across processes cannot all observe the
pre-increment count. Its counters are keyed by the limiter's limit and window,
so two limiters never share one. `guardRateLimit` wraps a handler with the
check and `rateLimitResponse` builds a value-free `429`; `throttle` builds a
per-key request throttle on the same limiter.

```js
import { FixedWindowRateLimiter } from '@jsails/cache';

const limiter = new FixedWindowRateLimiter({ limit: 60, windowMs: 60_000 });
```

Past its cap (10 000 counters) the in-process map evicts expired counters
first, then counters hit only once (oldest first), and only then the oldest,
so a flood of fresh keys cannot reset a counter near its limit.

### Testing a store

`jsails/testing` exports `cacheStoreConformance` and `leaseStoreConformance`:
named cases every implementation, first-party or custom, is held to.
`defineCacheConformance` holds a store to the defined-cache guarantees above,
for both tiers, from a harness that supplies a fresh store (and optionally a
lease store for the `cluster` case). A test
file registers them over a harness that builds a fresh store and says how time
passes for it:

```ts
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { MemoryCacheStore } from '@jsails/cache';
import { cacheStoreConformance } from 'jsails/testing';

const cases = cacheStoreConformance(async () => {
  const store = new MemoryCacheStore();
  return {
    store,
    advance: async (ms: number) => {
      await sleep(ms);
    },
    close: () => store.close(),
  };
});
for (const entry of cases) test(entry.name, () => entry.run());
```

## Mail

`@jsails/mail` is a minimal, transport-agnostic mail seam: the `Mailer` contract
plus three transports and a first-party plugin. Use `InMemoryMailTransport`
(in-memory capture for tests), `CallbackMailTransport` (an injected callback),
or `SmtpMailTransport` (lazy SMTP over nodemailer, loaded at first send).
`mailPlugin({ transport?, smtp?, allowMemory? })` exposes the mailer under
`mailToken` with lazy, fail-closed transport resolution. Its options are data:
`transport` names a `mailTransportToken` that another plugin provides, never a
transport instance, and `allowMemory: true` falls back to an in-memory
transport when nothing else is configured, as tests want. The `Mail` facade
resolves that mailer from the live application scope. The package is
server-only; nodemailer is pulled in only when SMTP is actually used. Preact
templates (`defineMail`), queued delivery (`Mail.queue`), and the development
preview are covered in [Mail](/docs/mail).

```ts
import { mailPlugin } from '@jsails/mail';

// Tests capture mail in memory; an app names a transport token or `smtp`.
export const mail = mailPlugin({ allowMemory: true });
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

`@jsails/filesystem` stores byte objects on a disk: `LocalDisk` (files under a
root directory), `S3Disk` (S3 or an S3-compatible store), or `MemoryDisk` (in
memory, for tests). Every disk implements the one streaming `Disk` contract
from `jsails/filesystem`. Each write streams its source under a required
`maxBytes` and returns the object's SHA-256. Reads return a ranged
`ReadableStream`. Listing is paged. `S3Disk` also signs download URLs.
`filesystemPlugin({ disks })` exposes the disks by name under
`filesystemToken`; each disk is described as data (`{ driver: 'local', root }`,
`{ driver: 'memory' }`, or `{ driver: 'env' }`).

See [Filesystem](/docs/filesystem) for the contract, errors, signed URLs,
variants and the conformance suite.

## Media

`@jsails/media` is a disk-backed media library: `createMediaLibrary({ disk,
diskName, metadata?, maxBytes?, maxPixels?, allowedTypes?, variants? })` and the
`mediaAdmin` admin page. `disk` is a `Disk`, or a function each operation calls
for one, so the library can store on a disk the `filesystem` plugin provides
once the app is set up: `disk: () => facade(filesystemToken).disk('files')`
with `diskName: 'files'` shares that very disk object, and each asset records
the name a `disk(name)` lookup resolves. A resolver that throws or returns no
disk fails the operation with a value-free `io_failed`.

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
  upload route's body limit (its `body` declaration, or the app's
  `maxBodyBytes` for a route that declares none) together with `maxBytes`; raising only
  `maxBytes` lets the server refuse an upload the library would accept.
- **Listing.** `library.query({ q?, mime?, limit, offset? })` returns
  `{ assets, total }` for one page (at most 1000), ordered by filename then id.
  `createDatabaseMediaIndex` runs it in SQL; a custom index without `query`
  falls back to filtering `list()`. The admin list shows 50 rows per page.
- **Bytes.** `library.stream(asset, range?)` streams an asset, or one byte
  range of it, straight from the disk. The admin download route serves a
  single `Range` with `206 Partial Content`, and list thumbnails are lazy
  `<img>` tags loading from the page's `?preview=<id>` route (raster images
  under the preview cap only, under a CSP that allows nothing), so rendering
  the list reads no asset bytes. Downloads and previews carry
  `X-Content-Type-Options: nosniff` and a sandboxing CSP, so a browser never
  sniffs an upload into a page that runs with the admin's cookies. A
  `type/*` entry in `allowedTypes` or a `mime` filter matches only that
  top-level type (`image/*` does not match `imagex/...`).
- **Direct URLs.** `library.url(asset, { expiresIn?, disposition? })` returns a
  signed URL that reads the asset straight from a disk that signs URLs (a
  `DiskUrlSigner`). It returns `undefined` on any other disk, and on a disk
  whose `signedUrl` refuses as `disk.unsupported` (an `S3Disk` built around a
  test `send` double). `expiresIn` is whole seconds, 15 minutes by default. `disposition` defaults to `attachment`. `inline` is honored only
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

The `env` disk is the deployment switch. The filesystem plugin declares the
`FILESYSTEM_*` and `S3_*` variables, validates them before it starts, and
builds exactly the one disk they select:

```js
// jsails.app.js
export default {
  plugins: {
    use: [['@jsails/filesystem', { disks: { files: { driver: 'env' } } }]],
  },
};
// FILESYSTEM_DISK unset → storage/files under the app root
// FILESYSTEM_DISK=local → the same, or FILESYSTEM_LOCAL_ROOT
// FILESYSTEM_DISK=memory → process memory
// FILESYSTEM_DISK=s3 → S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID,
//   S3_SECRET_ACCESS_KEY, S3_SESSION_TOKEN, S3_ENDPOINT,
//   S3_FORCE_PATH_STYLE, S3_PREFIX, S3_CONDITIONAL_WRITES
```

A `FILESYSTEM_DISK` that is set but blank (`FILESYSTEM_DISK=`, a templated
value that rendered empty) fails with `config.invalid_env` before any setup
rather than falling back to the local disk. Code that needs the disk itself (a
media library) resolves the plugin's own disk on each use, as above, rather
than building a second one.

`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` must be set together; omit both
to use the SDK's default credential chain (instance role, ECS task role, SSO).
Set `S3_FORCE_PATH_STYLE=true` for MinIO and most local S3-compatible services.
Set `S3_CONDITIONAL_WRITES=false` for a store that ignores `If-None-Match`
(SeaweedFS), so `ifAbsent` writes refuse instead of overwriting.

## Notifications

`@jsails/notifications` is a narrow, multi-channel delivery seam. A
`NotificationMessage` is smaller than a mail message — `to`, `subject`, and a
required plain-text `text` body — so any channel (mail, SMS, push) can consume
it. Two channels ship: `InMemoryNotificationChannel` captures messages in-process, and
`MailNotificationChannel({ mailer })` adapts the `@jsails/mail` `Mailer`.
`notificationsPlugin({ channels?, mail? })` exposes a `NotificationsService`
under `notificationsToken` and needs at least one channel;
`notify(message, { channels? })` sends through every selected channel and
aggregates failures into a value-free `NotificationError`.
Each channel has `channelTimeoutMs` (default 30000) to finish; a channel that
takes longer counts as failed, so a hung mail server cannot hold the caller.
Defined notifications (`defineNotification`) add a database inbox with
read/unread state, realtime broadcast, and queued mail; see
[Notifications](/docs/notifications).

```ts
import { InMemoryNotificationChannel, notificationsPlugin } from '@jsails/notifications';

export const notifications = notificationsPlugin({
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
scope**, so a call site writes `Cache.cache('x')` with no `new`, no import, and no
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
Cache.cache('sessions'); // forwarded to the instance, typed
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
method (`const { cache } = Cache`) loses binding; call through the proxy. Which
services become global names is opt-in. Job handlers and middleware run by
`jsails work` resolve facades: the worker is the app's `worker` role, so it
runs the same plugins as the web process and every job runs in the app's
scope.

## Next steps

- [Theme Tokens](/docs/theming), [Feature Flags](/docs/flags), and [Internationalization](/docs/i18n) — the presentation seams.
- [Observability](/docs/observability) — logging, signals, diagnostics, and watchers.
- [Encryption](/docs/encryption) — symmetric AES-256-GCM encryption.
- [Support Helpers](/docs/support) — the global `Str`/`Num`/`Time`/`Arr`/`Files` toolkit.
