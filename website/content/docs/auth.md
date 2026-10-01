---
title: Authentication
order: 17
section: Extending
---

# Authentication

The server-rendered `--admin`, `--blog`, and `--saas` starters ship a local email/password sign-in flow through the
first-party **`auth` plugin** (`@jsails/auth`), which backs **Better Auth over
MariaDB** by default, or MySQL, PostgreSQL, or SQLite (see
[Choosing the auth database](#choosing-the-auth-database)). It provides email/password sign-in, RFC 8628 device authorization,
self-registration, password reset, email verification, OAuth/social providers,
magic links, optional two-factor authentication, and revocable API tokens. It is
an authentication layer, not a finished authorization system.

## The auth plugin

`authPlugin()` lazily builds a Better Auth instance and mounts
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
    authPlugin(),
    serverComponentsPlugin({ components: { 'task-list': taskList } }),
  ],
};
```

The app's global `resolveSession` (used by filesystem API routes and pages)
should read the plugin's own session service, so the app holds one Better Auth
instance and one connection pool. The starters capture the service in a small
extension, which runs after `plugins.use` and so after the `auth` plugin:

```js
// jsails.app.js  (app-owned)
import { authSessionToken } from '@jsails/auth';

let authSessions;
const authSessionBridge = {
  name: 'app-auth-session',
  requires: [authSessionToken],
  setup: ({ services }) => {
    authSessions = services.get(authSessionToken);
  },
};

export default {
  // Fails closed: no session until the bridge has run.
  resolveSession: (request) =>
    authSessions === undefined ? null : authSessions.resolveSession(request),
  extensions: [authSessionBridge],
  // ...plugins.use, including '@jsails/auth'
};
```

`resolveSessionFromRequest(auth, request)` and `createAuth` are exported from
the same subpath for scripts and custom mountings. `createAuth()` builds a
separate, memoized instance with its own pool; release it with
`disposeCachedAuth()`.

## Mounted routes

`authPlugin` registers its routes through the plugin registrar
(`routes.add`), so each one runs core's access chain: every route that accepts
the session cookie gets the exact `Origin` check on unsafe requests, a denial
is core's uniform answer (`401` without a session, `403` with one, sent
`no-store` and without cookies), and every form route declares its body (form
fields up to 64 KiB, the token create's JSON up to 16 KiB).

Core sign-in and device flow:

- `/api/auth/*` — the Better Auth handler (email/password, session endpoints),
  public and cookie-accepting, so a cross-site post to it is refused. Three of
  its endpoints read no core credential, because a client outside the browser
  or another site must reach them: `POST /api/auth/device/code` and
  `POST /api/auth/device/token` (the CLI's device flow, which sends no
  `Origin`) and `/api/auth/callback/:provider` (an OAuth provider's callback,
  which may arrive as a cross-site form post).
- `/api/login` and `/api/logout` — public form routes.
- `/api/device/approve` and `/api/device/deny` — RFC 8628 device authorization;
  their access requires a browser session, resolved from the cookie alone, so
  an API or CLI token never approves a device.

The account lifecycle routes are mounted only when their option is enabled
(`registration.enabled`, `passwordReset.enabled`, `verification.enabled`; the
last two also need a `sendMail` seam). Without the option the route does not
exist and a form posting to it gets a `404`:

- `/api/register`
- `/api/password-reset` and `/api/password-reset/confirm`
- `/api/verification/send`

Self sign-up is off by default at every layer: Better Auth's own
`/api/auth/sign-up/email` is disabled too unless `registration.enabled` is set.
Closed registration also covers every other way Better Auth creates a user: a
`user.create.before` database hook refuses the insert (`403`, "registration is
closed"), so a magic link or a social sign-in for an unknown email cannot open
an account either. Existing users still sign in through them.

`magicLink` and `twoFactor` are enabled only by an options object (`{}` for the
defaults) and disabled by `false` or by leaving them out; any other value,
`true` included, is refused with a `TypeError`.

The standalone functions `handleRegister`,
`handleRequestPasswordReset` / `handleResetPassword`, and
`handleSendVerificationEmail` let you wire these into your own surfaces. Each
takes the request and an `AuthHandlerOptions` object (`{ auth, rateLimit?,
clientAddress? }`, where `clientAddress` is the client bucket the limiter keys
on; the plugin passes the route context's `client.bucket`). They run no
cross-site check of their own: register them with `routes.add` (cookie
credentials, the default) and the access chain refuses a cross-site post
before they run. Each answers every failure in the framework's problem envelope
(`application/problem+json` with `status`, `code`, and `detail`). `createResetPasswordSender`
and `createVerificationSender` adapt a `SendMailFn` to the `@jsails/mail`
transport; the exported `sendMail` is the default seam over the `Mail` facade.

A page that posts to one of these routes needs the matching option. The web
starters pass `registration: { enabled: true }` for their `/register` page and
ship no password-reset page. `POST /api/password-reset` asks Better Auth for
the reset without a `redirectTo`, so the emailed link cannot yet land on an
app page that reads the token and posts it with the new password to
`/api/password-reset/confirm`. OAuth, magic links, and two-factor
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
and `GET /magic-link/verify` use the login limiter, `/sign-up/email` the
registration limiter, `/request-password-reset` and `/reset-password` the reset
limiter, `/send-verification-email` the verification limiter, and the
two-factor and email-OTP verify and send endpoints the login limiter. The
endpoints that check a signed-in user's current password (`/verify-password`,
`/change-password`, `/delete-user`, and the two-factor enable, disable, TOTP
URI and backup-code endpoints) count against the login limiter too, so a
stolen session cannot guess the password unthrottled. A request
to a throttled path is charged whether or not its body names an email (or can
be parsed at all): one that names none counts against the client address
alone, so omitting the email or sending an unusual `Content-Type` does not
bypass the limit. `POST /api/password-reset/confirm` is charged per client
address the same way.

A denied attempt is not counted and opens no new window, so a client that is
already limited cannot push other clients' windows out of the bounded store.

Pass your own hook as `login.rateLimit` (or `registration.rateLimit`, ...) to
share state across instances, or `false` to turn a surface's throttle off. A hook
receives the trimmed, lowercased email and a `RateLimitAttempt`
(`{ email, ip, route, request }`); an exact `true` allows, anything else (or a
throw) answers a generic `429`.
`createMemoryRateLimiter({ limit, perAddressLimit, windowMs })` builds the
default limiter with other bounds.

The limiter keys on the client core's first pipeline stage resolved
(the request frame's `client.bucket`): the socket peer by default, so with
`server.trustedProxies: 'none'` no forwarded header changes the key. Behind a
reverse proxy every client shares the proxy's address, so set
`server.trustedProxies` (or `JSAILS_TRUSTED_PROXIES`) to the proxies in front
of the app. On the `jamal deploy` path the deploy sets `JSAILS_TRUSTED_PROXIES`
from the proxies it runs (`hops=1` behind kamal-proxy alone), and a proxy the
app does not trust is reported once as `JSAILS_PROXY_UNTRUSTED`. The
address is then the `X-Forwarded-For` entry the outermost trusted proxy
appended, never a client-controlled one, and an IPv6 client is keyed on its
/64. The same stage rewrites `X-Forwarded-For` to that one address, which is
all Better Auth's own limiter and its recorded session address read. See
[Origin, hosts and proxies](/docs/deployment-proxies).

Better Auth's own limiter reads the same address: the plugin passes it in a
private request header (Better Auth's `advanced.ipAddress.ipAddressHeaders`)
after removing any copy the client sent, so Better Auth never trusts a
client-supplied forwarding header.

### Browser-only surfaces

The Better Auth router (`/api/auth/*`), logout, and device approval are browser
surfaces: the plugin strips the `Authorization` header before Better Auth sees
it. An API token or a `jsails login` CLI token therefore cannot update the
user, list or revoke sessions, or approve a device code to mint a fresh,
unlisted session. The `/api/tokens` routes ignore the header the same way, so a
leaked token cannot list or mint further tokens for its user.

Session listing and revocation by token are not served: `/api/auth/list-sessions`,
`/multi-session/list-device-sessions`, `/revoke-session`, and
`/multi-session/revoke` answer `404`, because they hand out or accept other
sessions' tokens. Every other Better Auth response has session tokens removed
(`token`, `session.token`, and the bearer plugin's `set-auth-token` header);
the browser holds its session in the cookie only. The device-flow
`/api/auth/device/token` response keeps its token, since issuing one is its
purpose.

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

`findUserByEmail(auth, email)` looks an account up for the same kind of trusted
script: it matches the email case-insensitively (Better Auth stores emails
lowercased) and returns the user, including its `role`, or `null`. It performs
no authorization, so keep it out of request handlers that echo the result.

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
registers three routes:

- `POST /api/tokens`
- `GET /api/tokens`
- `DELETE /api/tokens/:id`

Token management requires a signed-in **browser** session (the routes'
access resolves it from the cookie alone; without one they answer `401`) and
a same-origin request (the access chain's cross-site check).

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

Core's cross-site check on unsafe requests (an `Origin` equal to the app's
origin, or `Sec-Fetch-Site: same-origin` without one) is skipped for a session
whose `data.authMethod` is `'bearer'` or `'api-token'`: a browser never
attaches a header credential to a cross-site request, so a token client can
mutate filesystem API routes without sending `Origin`. A cookie session, and
any session without the marker, keeps the check.

```js
// jsails.app.js  (app-owned)
import { authPlugin } from '@jsails/auth';

export default {
  extensions: [
    authPlugin({
      apiTokens: { enabled: true, expiresInDays: 90 },
    }),
  ],
};
```

```sh
curl -H "Authorization: Bearer $TOKEN" https://app.example.com/api/me
```

## Environment and setup

By default auth uses the database the `DATABASE_*` variables describe — the
same variables `readDatabaseEnvironment` reads for the app — started locally with
`npx jsails jamal up` (which also starts Valkey). JSails reads the connection
from individual variables — there is **no `DATABASE_URL`**:

- `DATABASE_TYPE` — `mariadb` (default), `mysql`, or `postgres`; any other value
  is refused at construction with `AuthInstanceError` (`unsupported_database`)
- `DATABASE_HOST`
- `DATABASE_PORT` (default `3306`, or `5432` for `postgres`)
- `DATABASE_USER`
- `DATABASE_PASSWORD`
- `DATABASE_NAME`

Better Auth reads:

- `BETTER_AUTH_SECRET` — export it before serving, at least 32 bytes.
- `BETTER_AUTH_URL` — the public origin, used behind a TLS-terminating proxy
  (default `http://localhost:3000`); in the starter it carries the same value
  as `server.origin`.

Create Better Auth's tables and the first admin with the starter's scripts:

```sh
npm run auth:migrate                                            # create Better Auth's tables
npm run user:create -- <email> <password> [name] --role admin   # create the first admin
npm run user:create -- <email> --role admin                     # promote an existing account
```

`--role` calls `setUserRole` after the account is created; without it the
account has no role. When the email already has an account, the script skips
sign-up, assigns the role to that account, and leaves its password unchanged,
so a run whose role step failed can simply be repeated. The starters' admin panel uses `authorize: adminOnly`, so
this is how the first admin is made.

**The starter shares one database between auth and `db:push`.** Out of the
box, `authPlugin`, `auth:migrate`, `user:create`, and `jsails.database.js` all
read the same `DATABASE_*` variables, so Better Auth's tables land in the
database `db:push` reconciles. The `auth` plugin declares those tables as
unmanaged (described below), so `db:push` and `db:diff` leave them to
`auth:migrate`, and a re-run is a no-op once the models match. A separate auth database is still available: set
`database` on `authPlugin` (a second database on the same server, or a SQLite
file) and pass the same value to `loadAuthMigrations` and `createAuth` in
`scripts/auth-migrate.mjs` and `scripts/create-user.mjs`. See
[Choosing the auth database](#choosing-the-auth-database).

Every request carrying a session cookie looks the session up in the database;
the plugin memoizes the result per request, so the session middleware and every
`authSessionToken` consumer share one lookup. `sessionCookieCache: { maxAge }`
(seconds) additionally caches the session in a signed cookie, at the cost of a
revoked session staying valid for up to `maxAge`.

The plugin's Better Auth instance has its own connection pool, separate from
the app's TypeORM pool. `databasePool: { connectionLimit, queueLimit }` on
`authPlugin` (or `pool` on `createAuth`) sizes it. The defaults are 10
connections and at most 1000 requests waiting for one; past that a lookup fails
at once instead of queueing without bound. Both values must be positive
integers, so mysql2's `0` (unlimited) cannot be set by accident. On PostgreSQL
only `connectionLimit` applies (it becomes `pg`'s `max`; `pg` has no wait-queue
bound), and SQLite has no pool.

### Choosing the auth database

`database` on `authPlugin` (or on `createAuth`) points auth somewhere other than
the `DATABASE_*` variables. It takes either the app's `JsailsDataSource`, whose
connection options (`type`, `host`, `port`, `username`, `password`, `database`,
`url`, `ssl`) are reused for a separate auth pool, or an explicit config with
the same field names. Other data source options are not carried over: on
PostgreSQL the auth tables go to the connection's default `search_path`, not
the data source's `schema`, and `extra`, `replication`, and pool settings do
not apply (size the auth pool with `databasePool`).

```js
// jsails.app.js  (app-owned)
import { authPlugin } from '@jsails/auth';

export default {
  extensions: [
    authPlugin({
      // Auth tables in a SQLite file of their own:
      database: { type: 'sqlite', location: 'storage/auth.sqlite' },
      // Or a separate PostgreSQL database:
      // database: { type: 'postgres', host: 'db', username: 'auth', password, database: 'auth' },
      // Or the app's JsailsDataSource, to reuse its connection settings:
      // database: dataSource,
    }),
  ],
};
```

Nothing connects when the option is read; the auth database is opened with the
Better Auth instance, on first use. The starter's `jsails.database.js` reads
`DATABASE_*` when it is imported, so importing it into `jsails.app.js` to pass
its data source makes the app config need those variables, even for a static
build.

The dialect follows `type`:

| `type` | Driver | Notes |
| --- | --- | --- |
| `mariadb`, `mysql` | `mysql2`, a dependency of `@jsails/auth` | The default, unchanged |
| `postgres` | `pg`, an optional peer dependency | `jsails` already installs it; if it is missing, construction throws `AuthInstanceError` (`missing_driver`) naming `pg` |
| `sqlite` | `node:sqlite`, built into Node | Needs a `location` file of its own, in a directory that exists |

A `sqljs` data source is refused (`unsupported_database`) instead of shared:
TypeORM's sqljs driver keeps the whole database in memory and rewrites the file
on every commit, so a second writer to that file would lose writes. Give auth a
separate `{ type: 'sqlite', location }` file instead.

`url` and the individual fields (`host`, `port`, `username`, `password`,
`database`) are mutually exclusive: mysql2 lets the fields override a URL while
`pg` lets the URL override them, so a mix is refused rather than resolved
differently per driver. A URL keeps its own port (the dialect default applies
only without one) and must parse as a URL. `ssl` is `true`, the driver's TLS
options object, or, on `mariadb`/`mysql` only, a mysql2 TLS profile name such
as `'Amazon RDS'`. A config that lacks `host`, `username`, or `database` (and
has no `url`), mixes `url` with those fields, or has a malformed or mistyped
field fails with `invalid_database`, naming the field but never its value or
the URL.

When the same options are passed to `loadAuthMigrations(options)`, the
migration plan targets the same database. The starter's `auth:migrate` and
`user:create` scripts call `createAuth`/`loadAuthMigrations` without options, so
they follow `DATABASE_*`. An app that sets `database` should pass the same
value in those scripts too. Every call builds an auth instance of its own, never
the shared one the plugin serves with, and the plan it returns carries that
instance's `dispose()`: call it once the plan has run, in a `finally`, or the
open pool or SQLite handle keeps the process alive.

```js
// scripts/auth-migrate.mjs, with auth in a SQLite file of its own
const migrations = await loadAuthMigrations({
  database: { type: 'sqlite', location: 'storage/auth.sqlite' },
});
try {
  await migrations.runMigrations();
} finally {
  await migrations.dispose();
}
```

**Better Auth owns the auth schema.** Its own migrator (`auth:migrate`,
`loadAuthMigrations`) creates and alters the auth tables (`user`, `session`,
`account`, `verification`, `deviceCode`, plus `twoFactor` when enabled), with
column types and indexes it picks for each dialect. The auth plugin does not
declare these tables to `db:push` as `schema.entities`: a hand-copied set of
TypeORM entities would drift from Better Auth's migrator, and `db:push` would
read every difference as a destructive change. It declares them as
`schema.unmanagedTables` instead, which `db:push` and `db:diff` read from
`plugins.use` without calling `setup`: the plan leaves those live tables out of
introspection and never drops or alters them. `authTableNames({ twoFactor })`
returns the same list.

The plugin declares them when the tables may share the app database: with no
`database` option (auth follows `DATABASE_*`, as `jsails.database.js` does) or
with the app's `JsailsDataSource`. With an explicit `database` config it
declares nothing, because the tables normally live elsewhere. If that config
points at the database `db:push` reconciles anyway, export the names from
`jsails.database.js`:

```js
// jsails.database.js
import { authTableNames } from '@jsails/auth';

export const unmanagedTables = authTableNames({ twoFactor: {} });
```

The plugin must be listed in `plugins.use` for `db:push` to see its
declaration; an `authPlugin()` placed only in `extensions` is not discovered,
so declare the tables through that export then too. A model named after an
auth table is refused (`invalid_options`) rather than shared with Better Auth.
Even so, **never pass `--allow-destructive` against a database that holds the
auth tables unless they are declared unmanaged**: an undeclared auth table is
planned as a drop like any other unknown table.

An injected `createAuth` instance must already carry the plugin's policy:
while registration is closed, a `databaseHooks.user.create.before` hook that
refuses user creation (magic links, email OTP and social providers create the
account on first sign-in, which `disableSignUp` does not govern); with
email/password enabled, sign-up disabled unless `registration.enabled`,
`autoSignIn: false` when it is, a reset sender and
`revokeSessionsOnPasswordReset` when `passwordReset.enabled`; and a
verification sender when `verification.enabled`. Otherwise the first use
throws `AuthInstanceError` (`unsafe_instance`) instead of running open.

An invalid `JSAILS_TRUSTED_PROXIES` fails the boot: core reads it when the
config loads, so a bad deploy stops instead of answering every request with a
500.

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
`sessionId` column holds `sessionLookupKey(id)`, a SHA-256 digest, so a leaked
backup or a SQL read yields no usable cookie. Rows written by an
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
