---
title: Configuration
order: 4
section: Building
---

# Configuration

JSails reads configuration from two places: **environment variables** (validated
by typed readers) and a single compiled ESM module, `jsails.app.js`, whose
default export is a plain object. Nothing opens a connection until `serve()` or
an extension's own `setup` does.

## Environment configuration

`readEnvironment(schema, source?)` validates a plain
`Record<string, string | undefined>` (defaulting to `process.env`) against a Zod
schema and returns typed config. It **never loads a `.env` file, never mutates
the source or `process.env`**, and resolves the default source when a reader is
called — not at import.

Failures are `EnvironmentError`s whose issues carry `{ path, code, message }`
only: custom Zod messages, thrown transform/refine errors, `.cause`, and raw
values (including credentials) are never surfaced.

`readDatabaseEnvironment(source?)` and `readValkeyEnvironment(source?)` are
opt-in service readers. A static site that never calls them needs neither a
database nor Valkey; call them explicitly where the service is used.

```js
// jsails.database.js  (app-owned; plain ESM)
import { JsailsDataSource, readDatabaseEnvironment } from 'jsails';
import { User } from './entities/user.js';

const database = readDatabaseEnvironment();

export default new JsailsDataSource({ ...database, entities: [User] });
```

- `DATABASE_TYPE` selects the driver: `mariadb` (the default, port `3306`),
  `postgres` (port `5432`), or `mysql` (port `3306`); `DATABASE_PORT` overrides
  the driver default. `DATABASE_HOST`, `DATABASE_USER`, `DATABASE_PASSWORD`, and
  `DATABASE_NAME` are required — there is no implicit database.
- Valkey resolves `VALKEY_URL`.
- Readers accept an injected source and never fall back to `process.env` once
  one is given.

## Environment files and credentials

Every `jsails` command assembles `process.env` before it runs, in this order of
precedence:

1. **Real environment variables** always win.
2. **`.env` files**: `.env`, then `.env.local`, then `.env.<NODE_ENV>`, each
   overriding the one before. Under `NODE_ENV=test` the order is `.env`, then
   `.env.testing`, and `.env.local` is skipped so tests never depend on one
   machine.
3. **Encrypted credentials** from `config/credentials/<NODE_ENV>.enc` fill any
   key still unset. `NODE_ENV` defaults to `development` here.

The credentials file is optional. Nothing happens until one exists. It holds
`.env`-syntax lines encrypted with AES-256-GCM, and it is committed. Its key is
not. The key comes from the git-ignored `config/credentials/<NODE_ENV>.key`, or
from `JSAILS_CREDENTIALS_KEY`, which applies only to the environment the
process runs as. A development key set in `.env` is therefore never tried for
production or test, and each environment keeps its own key. Holding the
development key reveals nothing about production.

Where to keep the key:

- **On a developer machine**, the key file, or `JSAILS_CREDENTIALS_KEY` in
  `.env` or `.env.local`. Both are git-ignored and left out of the deploy
  image, so either works; share the key with teammates through a password
  manager, not alongside the encrypted file.
- **On a server**, `JSAILS_CREDENTIALS_KEY` from the host's secret settings.

The key is used once. When loading finishes, whether it succeeded or not,
`JSAILS_CREDENTIALS_KEY` is removed from `process.env`, so app code, a
dependency that logs the environment, and child processes never see it. A
child process inherits the decrypted values instead. `JSAILS_CREDENTIALS_LOADED`
records which environment they came from, so the child does not try to load
them again. Restart `jsails dev` after editing credentials so the new values
reach the app.

```sh
jsails credentials edit                    # create or edit the development file
jsails credentials edit --env production   # creates production.key on first use
jsails credentials show --env production   # key names only; exits 1 if it cannot decrypt
jsails credentials regenerate --yes        # rebuild from the live environment
jsails credentials regenerate --yes --order keys.txt
```

`edit` opens `$VISUAL` or `$EDITOR` on a private temporary copy and saves only
when the contents changed. `show` never prints a value, and marks a key that
the environment already sets. In production, set `JSAILS_CREDENTIALS_KEY` as a
deploy secret and the app reads every other secret from the committed file.

`regenerate` rebuilds the file from the values the environment actually holds. The
plaintext of a file that cannot be decrypted is unrecoverable, so this is a
re-seal, not a recovery: it reads the assembled environment (`.env`, then
`.env.local` or `.env.testing`, then `.env.<env>`, then `process.env`), writes a
**new** key and a **new** `.enc`, and leaves the old pair in place. `--yes` is
required. `--order <file>` takes a plain list of key names, one per line with
`#` comments allowed, and emits the file in that order; keys it does not name
keep their existing document order, and a key the environment holds but neither
list names is appended. A key the old file had but the environment no longer
holds is reported and not written.

The environment name is bound into the ciphertext, so a file copied to another
environment fails to decrypt. A file that fails to decrypt stops the command
with a value-free error. A file whose key is missing prints a warning and the
command continues without credentials. Help, `create`, and `credentials` itself
never load the file, so a broken one can always be inspected and fixed.

The starters ignore `config/credentials/*.key`. Two people editing the same
encrypted file at once produce a conflict that git cannot merge, so coordinate
edits or keep frequently changed values in the deploy tool's secrets.

## Listen host and port

When a command loads `jsails.app.js` from a file (`serve`, `dev`), two
variables override the config's `host` and `port`:

- `JSAILS_HOST`, for example `0.0.0.0` inside a container;
- `JSAILS_PORT`, an integer from 0 to 65535.

They exist so a container or a host can choose where the app listens without
editing the config. A value that is not a valid host or port stops the command
with an error that does not repeat it. A config passed to `validateAppConfig`
directly is never affected.

## Application config — `jsails.app.js`

An app ships one compiled ESM module (default `jsails.app.js`) whose default
export is a plain object. `loadAppConfig(path?)` imports it and
`validateAppConfig` resolves absolute directories; `createApplication(config)`
discovers routes, runs the extensions, then the app's `setup` hook, and returns
an inert `Application` (`build()`, `serve()`, `close()`).

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
export default {
  rootDir: '.', // defaults to the config file's directory
  pages: 'pages', // relative to rootDir
  api: 'api', // relative to rootDir
  public: 'public', // relative to rootDir
  out: 'out', // relative to rootDir
  storage: 'storage', // relative to rootDir; resolved to storageDir
  healthPath: '/up', // GET/HEAD 200; false disables the health route
  host: '127.0.0.1',
  port: 3000, // 0 requests an ephemeral port
};
```

`host`, `port`, and `out` come from the config, not CLI flags.

### Directories and storage

`storage` defaults to `storage` and resolves to `ResolvedAppConfig.storageDir`
(the folder need not exist yet). `serve` creates it before listening; `build`
and `fetch` never materialize it. The resolved directory reaches pages/API as
`RequestContext.storagePath` (absent when the static export synthesized the
context without one).

Isolation guards reject a `storageDir` that equals the project root, overlaps
`public`/`out` in either direction, or contains the config module. `public` must
not contain the project root, overlap `pages`/`api`/`out` in either direction,
or contain the config file. The static build refuses to overwrite a non-empty
`out` without its own ownership marker.

### Health route

`healthPath` is a `string` or `false` and defaults to `/up`. The resolved config
exposes it as `healthPath: string | undefined` (`false` becomes `undefined`).
The framework route answers `GET`/`HEAD` with `200 text/plain; charset=utf-8`
and `Cache-Control: no-store`, **independent of the default-deny API pipeline**.
A path must be absolute, have no trailing slash (except `/`), and stay outside
the reserved `/_jsails` namespace; a collision with a discovered page/API route
is rejected when the application is assembled.

### Renderer, extensions, and broadcast

- `renderer` is a `PageRenderer` passed through directly; only its `render`
  function is checked, never called.
- `extensions` is the list of extensions the app declares. `setup()` runs last
  and may return a cleanup callback; neither is invoked by the loader. If
  `setup` throws, already-opened extensions are closed first.
- `broadcast` accepts either the built-in Socket.IO options (including
  `valkeyUrl`, with no environment fallback) or `{ adapter }`. The custom form is
  validated structurally (non-empty `name` + `attach`) and passed through by
  identity; its `attach` is never invoked by the loader.

### Introspection

`introspect: { enabled, authorize, sections? }` opts into the runtime
`GET /_jsails/introspect` endpoint, which is default-off and default-deny. See
[Introspection](/docs/introspection#runtime-endpoint-get-jsails-introspect).

## Sessions, authorization, and CSRF

- `authorize(context)` is **default-deny**: absent means every API request is
  rejected, and a request is allowed only when the callback resolves to exactly
  `true` (truthy non-boolean, throw, or rejection all deny). There is no
  implicit-public default.
- `resolveSession(request)` is the trusted session seam; when absent the context
  carries `session: null`, and a throwing/rejecting resolver fails closed.
- Cookie-authenticated mutations (`POST`/`PUT`/`PATCH`/`DELETE` with a session)
  require a same-origin `Origin` and a matching `X-CSRF-Token`. Behind a
  TLS-terminating proxy the request URL is plain HTTP, so set `publicOrigin` to
  the public https origin — forwarded headers are never trusted. `publicOrigin`
  is consulted only for that `Origin` check (and the equivalent check on signed
  server-component updates); plain page rendering, static export, and the health
  route never need it.

## Shutdown

`close()` is idempotent and tears down in reverse (HTTP/broadcast → app cleanup
→ extensions). `shutdownTimeoutMs` (default `5000`, max `300000`) bounds
transport teardown: idle/all connections are force-closed and a server that will
not stop has its tracked sockets destroyed at the deadline. The app cleanup and
extension cleanups are trusted and awaited **without** a deadline — each owns its
own async cleanup; this is bounded teardown, not a full graceful drain of active
connections.

```sh
jsails build --config jsails.app.js   # static export into `out`
jsails serve --config jsails.app.js   # listen until SIGINT/SIGTERM
```

## Next steps

- [Database](/docs/database) — entities, the portable schema, and migrations.
- [Routing](/docs/routing) — pages, API routes, and layouts.
