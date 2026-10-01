---
title: Authentication
order: 17
section: Extending
---

# Authentication

The server-rendered `--admin`, `--blog`, and `--saas` starters ship a local email/password sign-in flow through the
first-party **`auth` plugin** (`@jsails/auth`), which backs **Better Auth over
MariaDB**. It provides email/password sign-in, RFC 8628 device authorization,
self-registration, password reset, email verification, OAuth/social providers,
magic links, optional two-factor authentication, and revocable API tokens. It is
an authentication layer, not a finished authorization system.

## The auth plugin

`authPlugin({ publicOrigin })` lazily builds a Better Auth instance and mounts
its routes. Better Auth is constructed lazily and memoized, so nothing connects
at import or setup time — the database is only touched when a route actually
runs.

The plugin provides an `AuthSessionService` under the `authSessionToken` service
token. The admin panel consumes it by declaring `requires: [authSessionToken]`,
so the `auth` plugin must be declared **earlier** in the extension list than the
`admin` plugin, or assembly fails with a value-free error (never echoes input, secrets, or raw values).

```js
// jsails.app.js  (app-owned, compiled ESM; plain default export)
import { authPlugin } from '@jsails/auth';
import { serverComponentsPlugin } from 'jsails/server-components';
import { taskList } from './dist/components/task-list.js';

export default {
  rootDir: '.',
  plugins: {
    enabled: ['auth', 'cache', 'filesystem', 'mail', 'server-components'],
  },
  extensions: [
    authPlugin({ publicOrigin: process.env.BETTER_AUTH_URL }),
    serverComponentsPlugin({ components: { 'task-list': taskList } }),
  ],
};
```

`resolveSessionFromRequest(createAuth(), request)` and `createAuth` are exported
from the same subpath. The starter's own config sets a global `resolveSession`
this way for the `/api/me` filesystem API and the `/dashboard` page — that
resolves a memoized instance **distinct** from the plugin's own, but both read
the same environment and database.

```js
// jsails.app.js  (app-owned)
import { createAuth, resolveSessionFromRequest } from '@jsails/auth';

const auth = createAuth();

export default {
  resolveSession: (request) => resolveSessionFromRequest(auth, request),
  // ...extensions, including authPlugin
};
```

## Mounted routes

`authPlugin` mounts **trusted hook routes** — native Hono routes added through
the extension seam, never filesystem API routes. That means they bypass the
default-deny `authorize` gate and the cookie-session CSRF middleware, because the
plugin owns its own origin/session checks.

Core sign-in and device flow:

- `/api/auth/*` — the Better Auth handler (email/password, session endpoints).
- `/api/login` and `/api/logout`.
- `/api/device/approve` and `/api/device/deny` — RFC 8628 device authorization.

The account lifecycle routes are mounted only when their option is enabled
(`registration.enabled`, `passwordReset.enabled`, `verification.enabled`; the
last two also need a `sendMail` seam). Without the option the route does not
exist and a form posting to it gets a `404`:

- `/api/register`
- `/api/password-reset` and `/api/password-reset/confirm`
- `/api/verification/send`

Self sign-up is off by default at every layer: Better Auth's own
`/api/auth/sign-up/email` is disabled too unless `registration.enabled` is set.

The standalone functions `handleRegister`,
`handleRequestPasswordReset` / `handleResetPassword`, and
`handleSendVerificationEmail` let you wire these into your own surfaces. Each
takes the request and an `AuthHandlerOptions` object (`{ auth, publicOrigin?,
rateLimit?, clientAddress? }`) and answers every failure in the framework's
`{ error: { status, code, message } }` envelope. `createResetPasswordSender`
and `createVerificationSender` adapt a `SendMailFn` to the `@jsails/mail`
transport; the exported `sendMail` is the default seam over the `Mail` facade.

The registration and password-reset pages post to these routes, so an app that
ships them must enable the matching options. OAuth, magic links, and two-factor
authentication are plugin options too.

### Rate limiting

Credential endpoints are **throttled by default**. Without configuration, each
surface (`login`, `registration`, `passwordReset`, `verification`) gets an
in-memory limiter of 10 attempts per 15 minutes per normalized email and client
address, so case variants of one address share a bucket and a stranger cannot
lock an account owner out from elsewhere. A second bucket caps each client
address at 100 attempts per window across every email, so one client cannot
spray a password over many accounts; it is skipped when no address is known. The same limit governs the Better Auth
twins of the form routes: `/api/auth/sign-in/email` and `/sign-in/magic-link`
use the login limiter, `/sign-up/email` the registration limiter,
`/request-password-reset` the reset limiter, and `/send-verification-email` the
verification limiter.

Pass your own hook as `login.rateLimit` (or `registration.rateLimit`, ...) to
share state across instances, or `false` to turn a surface's throttle off. A hook
receives the trimmed, lowercased email and a `RateLimitAttempt`
(`{ email, ip, route, request }`); an exact `true` allows, anything else (or a
throw) answers a generic `429`.
`createMemoryRateLimiter({ limit, perAddressLimit, windowMs })` builds the
default limiter with other bounds.

The client address is the socket peer by default. Behind a reverse proxy every
client shares the proxy's address, so pass `clientAddress: (request) => ...` to
read the proxy's trusted forwarding header.

### Browser-only surfaces

The Better Auth router (`/api/auth/*`), logout, and device approval are browser
surfaces: the plugin strips the `Authorization` header before Better Auth sees
it. An API token or a `jsails login` CLI token therefore cannot update the
user, list or revoke sessions, or approve a device code to mint a fresh,
unlisted session. The `/api/tokens` routes ignore the header the same way, so a
leaked token cannot list or mint further tokens for its user.

## Roles

The plugin adds a `role` column to Better Auth's user table and the session
resolver projects it into `session.data.role`. The column is `input: false`:
neither sign-up nor Better Auth's update-user endpoint can set it, so a user
cannot promote themselves. Assign it from a trusted script with
`setUserRole(auth, email, role)` (or `null` to clear it); the change applies on
the user's next request. Existing databases need `npm run auth:migrate` once to
add the column. `roles: false` leaves the column out.

```js
// scripts/make-admin.mjs  (app-owned)
import { createAuth, disposeCachedAuth, setUserRole } from '@jsails/auth';

await setUserRole(createAuth(), process.argv[2], 'admin');
await disposeCachedAuth();
```

`sessionRole`, `requireRole(...roles)`, and `adminOnly` read that role from a
`Session` or a `RequestContext` and return a strict `RoleCheck`: an exact `true`
allows, anything else (no session, no role) denies. They suit a page or API
`authorize` callback and the admin panel's `authorize` option, so an admin panel
should use `authorize: adminOnly` rather than "any signed-in user".

```ts
// pages/admin.tsx  (app-owned)
import type { RequestContext } from 'jsails';

export function authorize(context: RequestContext) {
  return adminOnly(context); // exact true allows, everything else denies
}
```

A resolved session's `data.authMethod` records how it was authenticated:
`'cookie'`, `'bearer'` (a `jsails login` CLI token), or `'api-token'`.

## API tokens

The same subpath mints long-lived, revocable **API tokens** behind the
`apiTokens` option, **disabled by default**. When `apiTokens.enabled` is set, the
plugin provides an `ApiTokenService` under the `apiTokensToken` service token and
mounts three trusted routes:

- `POST /api/tokens`
- `GET /api/tokens`
- `DELETE /api/tokens/:id`

Token management requires a signed-in **browser** session plus same-origin and
CSRF checks.

A token is a Better Auth session tagged with a `jsails/api-token:` `userAgent`
sentinel, so it rides the existing session table with no new schema.
`createApiToken` returns the raw secret **exactly once** — it is never listed or
stored again.

`AuthSessionService.resolveSession` resolves a `Bearer <token>` API token in the
configured header first (only when tokens are enabled), then the cookie session.
The header defaults to `authorization`, overridable via `apiTokens.headerName`.
`apiTokens.expiresInDays` defaults to `30` (bounded `1..3650`).

A token's expiry is **fixed**: header credentials are resolved with Better
Auth's sliding session refresh disabled, so a token stops working at the
`expiresAt` it was minted with however often it is used (CLI tokens from
`jsails login` likewise). A completed password reset revokes every session of
the account, API tokens included; set `passwordReset.revokeSessions: false` to
keep them.

Filesystem API mutations from a token client still pass core's session CSRF
check, which expects an `Origin` and an `X-CSRF-Token` header; a token session
is therefore read-only against filesystem API routes.

```js
// jsails.app.js  (app-owned)
import { authPlugin } from '@jsails/auth';

export default {
  extensions: [
    authPlugin({
      publicOrigin: process.env.BETTER_AUTH_URL,
      apiTokens: { enabled: true, expiresInDays: 90 },
    }),
  ],
};
```

```sh
curl -H "Authorization: Bearer $TOKEN" https://app.example.com/api/me
```

## Environment and setup

Auth requires a MariaDB or MySQL connection, started locally with
`npx jsails jamal up` (which also starts Valkey). `DATABASE_TYPE=postgres` is
refused at construction with `AuthInstanceError` (`unsupported_database`)
rather than failing on the first request. JSails reads the connection from
individual variables — there is **no `DATABASE_URL`**:

- `DATABASE_HOST`
- `DATABASE_PORT` (default `3306`)
- `DATABASE_USER`
- `DATABASE_PASSWORD`
- `DATABASE_NAME`

Better Auth reads:

- `BETTER_AUTH_SECRET` — export it before serving, at least 32 bytes.
- `BETTER_AUTH_URL` — the public origin, used behind a TLS-terminating proxy
  (default `http://localhost:3000`); in the starter it is also passed as
  `publicOrigin`.

Create Better Auth's tables and the first account with the starter's scripts:

```sh
npm run auth:migrate                        # create Better Auth's tables
npm run user:create -- <email> <password> [name]   # create the first account
```

Every request carrying a session cookie looks the session up in the database;
the plugin memoizes the result per request, so the session middleware and every
`authSessionToken` consumer share one lookup. `sessionCookieCache: { maxAge }`
(seconds) additionally caches the session in a signed cookie, at the cost of a
revoked session staying valid for up to `maxAge`.

An injected `createAuth` instance with email/password enabled must already carry
the plugin's policy (sign-up disabled unless `registration.enabled`,
`autoSignIn: false` when it is, a reset sender and
`revokeSessionsOnPasswordReset` when `passwordReset.enabled`); otherwise the
first use throws `AuthInstanceError` (`unsafe_instance`) instead of running
open.

## Sessions

`@jsails/sessions` carries the framework-owned session entity and a
database-backed `SessionStore`. `JsailsSession` maps the `jsails_session` table
(`SESSION_TABLE`, `SESSION_ID_COLUMN_LENGTH`); add `sessionEntities` to a
`JsailsDataSource` `entities` and run
`jsails db:push --config jsails.database.js`.
`createDatabaseSessionStore({ dataSource })` builds the store through the data
source's repository — no raw SQL, no runtime DDL; a missing table fails with a
value-free `SessionStoreError`.

The session id is the cookie credential, so the table never stores it: the
`sessionId` column holds `sessionLookupKey(id)`, a SHA-256 digest, and the CSRF
token is sealed with a key derived from the raw id. A leaked backup or a SQL
read yields neither a usable cookie nor its CSRF token. Rows written by an
earlier version are still read and are rewritten in the hashed format on first
use, so upgrading signs nobody out. Writes are a single atomic upsert on the
unique `sessionId` index.

```js
// No import: these are projected globals in app code (see conventions.md).

const sessions = createDatabaseSessionStore({ dataSource });
```

## Next steps

- [Admin Panel](/docs/admin) — the first-party admin surface.
- [Configuration](/docs/configuration) — the full `jsails.app.js` key set.
