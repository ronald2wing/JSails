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

The account lifecycle handlers are mounted too, alongside the standalone
handlers the package's barrel (its index module, which re-exports the public
API) exports:

- `/api/register`
- `/api/password-reset` and `/api/password-reset/confirm`
- `/api/verification/send`

The standalone functions `handleRegister`,
`handleRequestPasswordReset` / `handleResetPassword`, and
`handleSendVerificationEmail` let you wire these into your own surfaces. Each
takes the request and an `AuthHandlerOptions` object (`{ auth, publicOrigin?,
rateLimit? }`) and answers every failure in the framework's
`{ error: { status, code, message } }` envelope. `createResetPasswordSender`
and `createVerificationSender` adapt a `SendMailFn` to the `@jsails/mail`
transport; the exported `sendMail` is the default seam over the `Mail` facade.

The starter ships registration and password-reset pages plus their shared form
components, and wires the corresponding plugin options (`registration`,
`passwordReset`, `verification` with a `sendMail` seam). OAuth, magic links, and
two-factor authentication are plugin options too, but the starter's pages do not
wire them by default.

`POST /api/login` calls Better Auth's sign-in API directly, which bypasses the
rate limiter Better Auth applies to its own `/api/auth/*` router. Throttle
password guessing with `login.rateLimit`, a per-email hook with the same
contract as `registration.rateLimit`: an exact `true` allows, anything else (or
a throw) answers a generic `429`. The `@jsails/cache` fixed-window limiter is
the usual implementation.

API tokens are managed by a signed-in browser session only: the `/api/tokens`
routes ignore an `Authorization` header, so a leaked token cannot list or mint
further tokens for its user.

## Roles

Role checks read a session's `role` field. `sessionRole(context)`,
`requireRole(...roles)`, and `adminOnly` each return a strict `RoleCheck`: an
exact `true` allows, anything else denies. They are suitable for a page or API
`authorize` callback, which follows the same exact-`true` default-deny rule as
the rest of the runtime.

```ts
// pages/admin.tsx  (app-owned)
import type { RequestContext } from 'jsails';

export function authorize(context: RequestContext) {
  return adminOnly(context); // exact true allows, everything else denies
}
```

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

`AuthSessionService.resolveSession` resolves the cookie session first, then falls
back to the `Bearer <token>` credential in the configured header — and only when
tokens are enabled. The header defaults to `authorization`, overridable via
`apiTokens.headerName`. `apiTokens.expiresInDays` defaults to `30` (bounded
`1..3650`).

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

Auth requires a database connection. The recommended default is MariaDB, started
locally with `npx jsails jamal up` (which also starts Valkey). JSails reads the connection
from individual variables — there is **no `DATABASE_URL`**:

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

## Sessions

`@jsails/sessions` carries the framework-owned session entity and a
database-backed `SessionStore`. `JsailsSession` maps the `jsails_session` table
(`SESSION_TABLE`, `SESSION_ID_COLUMN_LENGTH`); add `sessionEntities` to a
`JsailsDataSource` `entities` and run
`jsails db:push --config jsails.database.js`.
`createDatabaseSessionStore({ dataSource })` builds the store through the data
source's repository — no raw SQL, no runtime DDL; a missing table fails with a
value-free `SessionStoreError`.

```js
// No import: these are projected globals in app code (see conventions.md).

const sessions = createDatabaseSessionStore({ dataSource });
```

## Next steps

- [Admin Panel](/docs/admin) — the first-party admin surface.
- [Configuration](/docs/configuration) — the full `jsails.app.js` key set.
