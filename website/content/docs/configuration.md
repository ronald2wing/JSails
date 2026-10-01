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

Failures are `environment.invalid_variable` errors (`environment.invalid_environment`
when no variable can be named), from the `EnvironmentErrors` registry, whose
payload `issues` carry `{ path, code, message }` only: custom Zod messages,
thrown transform/refine errors, `.cause`, and raw values (including
credentials) are never surfaced.

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

Every `jsails` command resolves its environment once, before any app code
runs, and applies it to `process.env`.

**The name.** `JSAILS_ENV` names the environment; a leading `--env <name>`
(`jsails --env staging serve`) outranks it, and `jsails test` runs as `test`
unless one is named. Without either it is `development`. `NODE_ENV` is derived
from the name — `development`, `test`, otherwise `production` — and set for
the process, so libraries that read it agree with the app. A real `NODE_ENV`
that contradicts the name stops the command with `environment.conflict`: set
`JSAILS_ENV` and leave `NODE_ENV` alone.

**The layers**, highest precedence first:

1. **Real environment variables.**
2. **The secrets file** named by `JSAILS_SECRETS_FILE`, a JSON document
   `{ "v": 1, "values": { "NAME": "value" } }`. A deploy mounts it read-only
   into the app container. When the variable is set the file must exist and be
   well formed; the resolution records that it was consumed and how many values
   it held. It may carry `JSAILS_CREDENTIALS_KEY`, the one control variable a
   deployed container has no other way to receive: that value is lifted out
   (it is not a variable, and is not counted) and opens the sealed credentials
   when the real environment holds no key ring.
3. **`.env.local`**, in `development` only.
4. **Sealed credentials** from `config/credentials/<env>.enc`.
5. **`.env.<env>`** (`.env.development`, `.env.test`).
6. **`.env`**.

Only `development` and `test` read `.env` files at all. Any other environment
(`production`, `staging`) runs on the real environment, the secrets file, and
its sealed credentials, so a stray `.env` copied into an image or left on a
server never decides a deployed value. A file that does not exist is skipped;
one that exists but cannot be read (`EACCES`) stops the command
(`environment.unreadable_file`), since running with it silently skipped would
pick values from the layer below.

`JSAILS_ENV`, `NODE_ENV`, `JSAILS_CREDENTIALS_KEY`, `JSAILS_SECRETS_FILE`,
`JSAILS_ENV_RESOLVED`, and `JSAILS_DEBUG` (which makes a failure report print
the underlying error messages, [Failure reports](/docs/cli#failure-reports))
come from the real environment only (and `JSAILS_CREDENTIALS_KEY` from the
secrets file too, as above). A `.env` file, a sealed document, or a secrets
file that defines one of the others stops every command with a value-free
error naming the file and the key.

### Reading variables from config

Config code reads variables through the `env` accessor:

```js
import { env } from 'jsails';

const password = env.require('DATABASE_PASSWORD'); // environment.missing_variable when unset
const region = env.optional('S3_REGION') ?? 'eu-west-1';
```

`env.require` fails naming the exact variable. Under a command that does not
use secrets (below) and skipped a sealed document, it returns an empty string
instead, so `jsails build` runs on a machine without the production key; a
value a build writes into its output belongs in the real environment or a
`.env` file, not the sealed credentials.

### Which commands need secrets

Each command declares whether it uses the sealed credentials. `serve`, `dev`,
`work`, `schedule`, `console`, `test`, `seed`, `db:*`, `queue*`, `plugins`,
introspection commands, and every project command do: when the document is
sealed and no key opens it they stop with `credentials.missing_key`, in every
environment, development included. `build`, `build:meta`,
`inject:auto-imports`, `make:*`, `credentials`, and help never open the
document, so an image build needs no key and a broken document can always be
inspected and fixed. `create` resolves no environment at all: it scaffolds a
new project, so the `.env` files and credentials of the directory it runs in
are not its own.

### Child processes

A command that resolved its environment exports
`JSAILS_ENV_RESOLVED=<name>:<keyId>:<sha256 of the sealed document>:<sha256 of
the project root>`. A JSails process started beneath it already holds every
resolved value as a real variable (and the key was consumed), so it inherits
the resolution instead of resolving again. It stops when it runs in another
project directory than the one its parent resolved
(`environment.inherited_foreign_project`), when it is asked for another
environment (`environment.inherited_mismatch`), when the sealed document it
would read is not the one its parent resolved (`environment.inherited_stale`),
or when it needs secrets its parent skipped
(`environment.inherited_without_secrets`). Restart `jsails dev` after editing
credentials so the new values reach the app.

The root field is a digest of the project directory's real path, so the
marker names no path, and another route to the same directory (a symlink,
macOS's `/var` for `/private/var`, a differently cased path on a
case-insensitive file system) still inherits. A subdirectory of the project
is another directory: run JSails commands from the project root. A child in another project is refused rather than resolved afresh:
the parent's values are already real variables in its environment, which
would outrank every layer of the child's own project. The children JSails
starts itself (the `jsails dev` server, the `jamal` bin under `jsails jamal`,
the test runner under `jsails test`) run in the parent's directory. A program
that starts a JSails command for another project (a test that runs the CLI in
a fixture directory) passes it an environment without `JSAILS_ENV_RESOLVED`
and the values its own resolution loaded.

### Sealed credentials

The credentials document is optional; nothing happens until one exists. It
holds `.env`-syntax lines and is committed. Format v2 is two lines:

```text
jsails-credentials v2 <env> <keyId>
<base64url of iv, ciphertext, and GCM tag>
```

It is encrypted with AES-256-GCM, with the header line as authenticated data,
so a document copied to another environment, or one whose header was edited,
fails to open. `keyId` is the first 8 bytes of HKDF-SHA256 over the key with
the info `jsails-credentials-keyid`. A document sealed before format v2 cannot
be read: move it aside and run `jsails credentials init --from <dotenv file>`.

The key is not committed. A key is 32 random bytes in base64url, and an
environment has a **key ring** of one or two keys (current, then previous):
the git-ignored `config/credentials/<env>.key` holds one per line, and
`JSAILS_CREDENTIALS_KEY` in the real environment holds them comma-separated
and outranks the file for the environment the process runs as only. The loader
picks the key the document names, whatever the ring order. Each environment
has its own ring; holding the development key reveals nothing about
production.

Where to keep the ring:

- **On a developer machine**, the git-ignored key file. Share it with teammates
  through a password manager, not alongside the sealed file.
- **On a server deployed with `jamal deploy`**, nowhere you manage: the deploy
  delivers the ring itself (see [Deploy](/docs/deploy#the-credentials-key)).
- **On any other host**, `JSAILS_CREDENTIALS_KEY` from the host's secret
  settings.

The key is used once: resolution removes `JSAILS_CREDENTIALS_KEY` from
`process.env`, so app code, a dependency that logs the environment, and child
processes never see it.

```sh
jsails credentials init [--from .env.production.local]   # create the document (and key file)
jsails credentials edit                                  # $VISUAL or $EDITOR on a private copy
printf %s "$TOKEN" | jsails credentials set API_TOKEN    # the value comes from stdin
jsails credentials unset API_TOKEN
jsails credentials import more.env                       # merge a dotenv file's values
jsails credentials show --env production                 # names only; exits 1 if it cannot open
jsails credentials rotate                                # new current key, re-seal under it
jsails credentials rotate --finish                       # drop the previous key
```

Every subcommand takes `--env <name>` (default: the environment the process
runs as). Nothing reads `process.env` for what it seals: a document holds
exactly what `init --from`, `edit`, `set`, and `import` put in it. `init`
refuses to overwrite an existing document. `set`, `unset`, and `import`
rewrite the document one `KEY=value` per line in its key order, quoting each
value so it reads back exactly; a comment survives only `edit`. `show` marks a
name that a higher layer overrides.

**Rotation** never leaves a server with a document none of its keys opens:
`rotate` adds a fresh current key to the ring, then re-seals the document under
it in one atomic write, keeping the previous key so a server still running the
old document opens it. Deploy, then run `rotate --finish` to drop the key that
no longer seals the document. An edit in between re-seals under the key that
opened the document, so the rotation's state survives it. When
`JSAILS_CREDENTIALS_KEY` holds the ring, set it to the key file's keys
(comma-separated) after each step.

The server-rendered and CLI starters ignore `config/credentials/*.key`. Two
people editing the same sealed document at once produce a conflict that git
cannot merge, so coordinate edits or keep frequently changed values in the
deploy tool's secrets.

## Listen host and port

When a command loads `jsails.app.js` from a file (`serve`, `dev`), two
variables override the config's `host` and `port`:

- `JSAILS_HOST`, for example `0.0.0.0` inside a container;
- `JSAILS_PORT`, an integer from 0 to 65535.

They exist so a container or a host can choose where the app listens without
editing the config. A value that is not a valid host or port stops the command
with an error that does not repeat it. A config passed to `validateAppConfig`
directly is never affected.

## `jsails.config.ts`

The typed app definition. `jsails.config.ts` default-exports `defineApp`
(`jsails/kernel`): the variables the app reads, declared like a plugin's
`env`, and a function from those parsed variables to the config. Node loads
the file with type stripping, so it needs no build step, and every command
reads it with the same loader (`loadApp`).

```ts
// jsails.config.ts
import { defineApp, envVar } from 'jsails/kernel';

export default defineApp({
  env: { APP_PORT: envVar.integer() },
  config: (env) => ({
    port: env.APP_PORT ?? 3000,
    server: { origin: 'https://example.com', trustedProxies: { hops: 1 } },
    plugins: { use: [], activation: { mode: 'locked' } },
  }),
});
```

Pass it to a command with `--config jsails.config.ts`; `jsails.app.js`
stays the default config path until the starters move over.

The config is inert. Before importing it, the loader reads the module and
every module it imports, and refuses, with the file, line and column and
never the source text:

- an import of anything but an npm package (by bare name) or a module under
  `config/` beside the root, by a relative path naming an existing `.ts` or
  `.js` file (`config.outside_graph`, whose `problem` names the case, such as
  `relative_import` or `missing_module`). App code, a
  `node:` builtin, an absolute path, a URL, `import()` and `require` are all
  refused, so loading the config never runs the app. App code spelled as a
  bare name is refused too: a `#` subpath import (`subpath_import`), which
  Node maps through your `package.json` `imports`, and your own package
  name (`self_import`), a self-reference through its `exports`;
- syntax that type stripping cannot erase: an `enum`, a `namespace` with a
  body, a parameter property, `import =`, `export =`, a decorator
  (`config.non_erasable_syntax`);
- a module that does not parse (`config.invalid_syntax`).

A default export that is not a `defineApp` result is `config.invalid_app_definition`,
a variable that fails its declaration is `config.invalid_app_env` (naming the
variable, never its value), a `config` function that throws is
`config.config_failed`, and one that returns a promise (an `async`
function) is `config.async_config`: return the config object itself. The
keys `defineApp` accepts are the `AppConfig`
interface: `rootDir`, `host`, `port`, `storage`, `healthPath`,
`maxBodyBytes`, `shutdownTimeoutMs`, `server` (`origin`, `hosts`,
`trustedProxies`, `timeouts`, `handlerTimeoutMs`), `render`, `telemetry`,
`http` (`guards`), and `plugins` (`use`, `activation`). A misspelt key is a
type error and, at load, a validation error. `JSAILS_HOST`, `JSAILS_PORT` and
`JSAILS_TRUSTED_PROXIES` override the listen address and proxies of a loaded
config, as below.

The environment is the one the caller passes (`loadApp({ env })`,
`createTestApp({ env })`). Without one, the loader takes the environment the
`jsails` bin resolved for the command; in a process the bin did not start (a
test file run by `jsails test` or `node --test`, a custom server script) it
resolves it for `cwd` exactly as the bin does (the real variables, a parent
JSails process's resolution, the `.env` files, the sealed credentials) and
never writes it to `process.env`.

### Plugin activation

`plugins.activation.mode` says who may activate plugin code:

- `'locked'` (the default): only the code the config lists in `plugins.use`
  runs. No database row, admin action or variable can activate more.
- `'managed'`: for a site its owner runs without a developer, the
  marketplace plugin source may also activate verified, signed plugin
  bundles. That source is not part of this release, so a managed app runs the
  same plugins as a locked one. Only the managed plugin graph carries the
  authority to change the database schema for plugins.

The mode is a literal in the config, written as an object literal inside
`plugins`: `plugins: { activation: { mode: 'managed' } }`, in the root or one
`config/` module. Its `mode` must be the string `'locked'` or `'managed'`
(`config.activation_not_literal` for one computed from a variable, an
import or a condition), it may be stated once (`config.activation_repeated`),
and the config must return that same mode: one that returns another mode
than its literal (`config.activation_mismatch`, at the literal) or a
managed mode no literal states, through a spread or a variable
(`config.activation_unstated`), is refused. An `activation` key anywhere
else, such as a plugin's options, is not the mode. No environment variable,
settings schema or flag of a command that runs an app selects it. Safe mode, which `jsails build` and the `db:*` commands
use, narrows a managed app to its config's plugins; nothing widens a locked
one. Every `jsails create` preset ships locked.

Before any plugin's setup runs, the plugin graph is checked: a dependency
cycle, a required service no plugin provides, two plugins with one name, or
two providers of one service is `config.misconfigured`, naming the problem
and the plugin.

### Legacy keys

`jsails.app.js` and the keys below are still accepted, through one compat
mapper, until the package that provides each replacement removes them. The
`legacy-config` gate keeps the list from growing.

| Key | Replacement |
| --- | --- |
| `jsails.app.js` (the root) | `jsails.config.ts` with `defineApp` |
| `pages`, `api` | routes listed in the AppManifest |
| `public`, `out` | the build pipeline's asset and export directories |
| `shape` | the roles a process runs (web, worker, export) |
| `resolveSession`, `identity` | an authenticator providing the actor |
| `setup`, `extensions` | `definePlugin` instances in `plugins.use` |
| `renderer` | the typed page outcome |
| `introspect`, `seo` | the introspection and seo plugins |
| `i18n` | the i18n plugin instance in `plugins.use` |
| `onError`, `errorPage` | the `app/error` and `pages/_error` hook modules |
| `readiness`, `systemChecks` | readiness checks contributed by plugins |
| string and `[specifier, options]` entries in `plugins.use` | `definePlugin` instances |

Some options are gone, and naming one is `config.removed_option`, which
names its replacement: `plugins.managed` (use `plugins.activation`),
`plugins.force` (declare `requires` and `provides` on `definePlugin`
instances), the `{ specifier, … }` descriptor form of a `plugins.use`
entry (list the `definePlugin` instance), and the options of the removed
plugin installer and plugin state store, `plugins.enabled`,
`plugins.downloads`, `plugins.stateSource`, `plugins.pluginsDir` and
`plugins.allowLoadFailures` (the marketplace plugin source).

## Application config — `jsails.app.js`

The legacy root: one compiled ESM module (default `jsails.app.js`) whose
default export is a plain object. `loadApp({ configPath? })` imports it,
resolves absolute directories, and seals its activation mode;
`createApplication(app)` resolves the plugin graph, discovers routes, runs the
plugins and extensions, then the app's `setup` hook, and returns an inert
`Application` (`build()`, `serve()`, `close()`). Its activation literal is
checked like a `jsails.config.ts` one; its imports are not restricted.

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
is rejected when the application is assembled. The route is matched before
i18n and session resolution, so a probe does no locale or session work.

`<healthPath>?deep=1` is the readiness probe. With the app config's
`systemChecks` and `readiness` keys (the same options `createApp` takes), plus
any probes extensions declare, it runs the synchronous system checks plus the
async `readiness.probes` (`(signal) => …`; a throw, `false`, or outliving
`readiness.timeoutMs`, default `2000`, fails the probe) in parallel and answers
`200 {"status":"ok"}` or `503 {"status":"error"}`. Results are cached for
`readiness.cacheMs` (default `1000`) and concurrent probes share one run.
Anonymous callers see only the aggregate; per-check results are returned only
when `readiness.authorize(request)` resolves to exactly `true`, and a probe's
error text is never returned to anyone. `readiness.path` (e.g. `/ready`) serves
the same answer on its own path. With nothing configured, `?deep=1` is the plain
liveness answer. Both answers become `503` once the server starts draining for
shutdown. The loader validates `readiness` (and rejects a `readiness.path` equal
to `healthPath`) when the config loads.

```js
// jsails.app.js
import { createDataSourceReadinessProbe, createValkeyReadinessProbe } from 'jsails/app';
import dataSource from './jsails.database.js';
import { valkey } from './valkey.js';

export default {
  readiness: {
    path: '/ready',
    probes: {
      database: createDataSourceReadinessProbe(dataSource), // SELECT 1
      valkey: createValkeyReadinessProbe(valkey), // PING, expects PONG
    },
    authorize: (request) => request.headers.get('x-ops-token') === process.env.OPS_TOKEN,
  },
};
```

`createDataSourceReadinessProbe` fails a data source that is not initialized
instead of initializing it, and `createValkeyReadinessProbe` takes the app's Valkey
connections (`services.get(valkeyToken)`, `jsails/plugin-sdk`) and pings their
`command` connection, which connects on the first probe. `valkeyPlugin` reports
its own: its `valkey` lifecycle unit connects the `command` role when the
process starts (an unreachable server fails the start) and its readiness probe,
named `valkey`, pings it. A lifecycle unit's optional `ready` is a probe like
these, merged in under the unit's name for the units the process runs. Both
helpers accept `{ timeoutMs }` for use outside the readiness endpoint.

An extension or plugin contributes probes by declaring them, next to `name` and
`setup`. Each probe receives the abort signal and the sealed service registry, so
it can reach what its `setup` provided:

```ts
export const databasePlugin = definePlugin({
  name: 'database',
  readiness: {
    database: (signal, services) =>
      createDataSourceReadinessProbe(services.get(dataSourceToken))(signal),
  },
  setup({ services }) {
    services.provide(dataSourceToken, dataSource);
  },
});
```

Probe names share one namespace: two extensions declaring the same name fail
validation, and a config probe that reuses an extension's name fails when the
app is assembled. A disabled or skipped extension contributes no probes.

### Request errors and error pages

`onError(error, { phase, method, route, requestId })` receives every unexpected
request failure; without it the failure is logged to stderr. `errorPage(error,
context)` renders the HTML for a 404 or failed browser navigation to a page
path. Both are passed to `createApp` unchanged; see
[Observability](/docs/observability#request-errors).

### Renderer, extensions, and broadcast

- `renderer` is a `PageRenderer` passed through directly; only its `render`
  function is checked, never called. It answers with a `PageOutcome` (see
  [Static export](/docs/routing#static-export)).
- `render` holds the page streaming setting `streamTimeoutMs` (a positive
  integer). Pages are buffered and a page opts into streaming itself, so there
  is no `stream` key; unknown keys are rejected. See
  [Streaming rendering](/docs/routing#streaming-rendering).
- `extensions` is the list of extensions the app declares. `setup()` runs last
  and may return a cleanup callback; neither is invoked by the loader. If
  `setup` throws, already-opened extensions are closed first.
- `broadcast` accepts either the built-in Socket.IO options (including
  `valkeyUrl`, with no environment fallback) or `{ adapter }`. The custom form is
  validated structurally (non-empty `name` + `attach`) and passed through by
  identity; its `attach` is never invoked by the loader.

The built-in Socket.IO broadcast server sets these limits by default:

- Origin. An Engine.IO request (polling or WebSocket upgrade) from an origin
  outside `allowedOrigins` is refused before the Socket.IO handshake runs, with
  HTTP `400`. One inbound frame may be at most `maxFrameBytes` (default 32 KiB).
- Subscribe rate. Each socket has a token bucket: `maxRequestsPerSecond`
  (default 5) and a burst of `requestBurst` (default 20). At most
  `maxPendingOperations` (default 8) subscribe and unsubscribe frames can wait
  in its queue. One subscribe names at most 50 channels, and they are
  authorized 5 at a time. A frame beyond these limits is answered
  `rate_limited`. After `maxRejectedRequests` (default 50) malformed
  (`invalid_request`) or rate-limited frames within `rejectedRequestWindowMs`
  (default 60 s), the socket is disconnected. A well-formed subscribe that is
  denied, or that exceeds `maxSubscriptions`, is not counted, so a long-lived
  tab that visits pages with channels it may not join stays connected.
- Partial denial. A subscribe joins the channels that are authorized. If any
  channel is denied, the server answers `{ ok: false, error: 'unauthorized',
  denied }`, and the client drops only the channels in `denied`.
- Revalidation. Every `revalidateIntervalMs` (default 5 minutes, `0` turns it
  off), each socket runs `authenticate` and `authorizeChannel` again for every
  channel it has joined. A channel that is no longer authorized is left, and
  the client receives `jsails:revoked`. A socket whose identity no longer
  authenticates is disconnected. To apply a revocation right away (for example
  on logout or a role change), call `broadcast.revalidate()`. With the Valkey
  adapter, that call reaches every process. Only an explicit answer revokes: if
  `authenticate` or `authorizeChannel` throws or rejects during revalidation (a
  database or session-store outage), the socket keeps its channels and the
  failure goes to `onError` (or a process warning).
- Valkey. The publisher does not queue commands while Valkey is down: a publish
  during an outage fails fast instead of piling up in memory. The failure is
  reported once per outage.

The browser `SocketIOBroadcastClient` (from `jsails/broadcast/client`, which imports only
`socket.io-client` and is safe in a client bundle) waits at most `ackTimeoutMs` (default 10 s) for a
subscribe or unsubscribe acknowledgement. Subscribes made in the same tick are
sent together, and every request is split into batches of 50 channels. A
subscribe or rejoin that fails transiently (`timeout`, `rate_limited`, or a
server error) keeps its channels and is retried with backoff while the socket
stays connected; the `subscribe()` promise still rejects, with `retryable: true`.

### Introspection

`introspect: { enabled, authorize, sections? }` opts into the runtime
`GET /_jsails/introspect` endpoint, which is default-off and default-deny. See
[Introspection](/docs/introspection#runtime-endpoint-get-jsails-introspect).

## Sessions and authorization

- There is no app-wide `authorize`: every route states its own access (see
  [Route access](/docs/routing#route-access)), and an API module that states
  none fails at startup. An `authorize` key in `jsails.app.js` is refused with
  `config.removed_option`.
- `resolveSession(request)` is the trusted session seam; when absent the context
  carries `session: null`, and a throwing/rejecting resolver fails closed (and
  is reported, see [Observability](/docs/observability#request-errors)). It is
  called at most once per request, and only when a route claims the request:
  any registered route (an API, page, registrar, server-component, or
  introspection route, or a mount), or the app's error page. A public file, the health probe, or a JSON 404 never
  touches the session store. A registrar route's handler reads
  `ctx.session`.
- A bare `resolveSession` says nothing about where it reads a credential (a
  cookie, any header, the URL), so every request a route claims calls it.
  `identity` replaces it (the two are mutually exclusive) with a source that
  declares the cookies and headers it reads: a request carrying none of them,
  with a non-empty value, is anonymous without a lookup. Declare every name
  the resolver reads; a credential sent anywhere else is never resolved.
- An unsafe request (`POST`/`PUT`/`PATCH`/`DELETE`) to a route that accepts
  the session cookie (the default) must carry an `Origin` equal to the origin
  it was addressed to, or, without `Origin`, `Sec-Fetch-Site: same-origin`;
  anything else is refused `403` `access.cross_site`, with or without a
  session (see [Security](/docs/security#what-the-pipeline-enforces)). A
  session the resolver marks as header-authenticated (`data.authMethod` of
  `'bearer'` or `'api-token'`) is exempt. Behind a TLS-terminating proxy the
  request URL is plain HTTP, so set `server.origin` to the public https
  origin.

```js
import { identitySource } from 'jsails';

/** @param {Request} request */
const lookUpSession = async (request) =>
  request.headers.get('x-api-key') === process.env.API_KEY
    ? { id: 'api', data: { authMethod: 'api-token' }, expiresAt: Number.MAX_SAFE_INTEGER }
    : null;

export default {
  identity: identitySource({
    cookies: ['session'],
    headers: ['x-api-key'],
    resolve: lookUpSession,
  }),
};
```

An `identity` source is the same seam `createApp({ identity })` takes:
`{ hasCredential(request), resolve(request) }`, where `hasCredential` is asked
once, when a route first needs the identity, and one that throws fails closed
and is reported (phase `session`) like a throwing resolver.

## Guards

`http: { guards: [...] }` lists guards, `(request, { id, client }) => Response |
undefined`, run for every request before public files, the 405 answer,
and routes, and before every guard an extension registers with
`configureGuard`. A `GET` or `HEAD` of the health path or `readiness.path` is
the one exception: a deploy tool (`jamal deploy`, a proxy's health check)
probes the container by its own address with no credential, so a wall there
would fail every release. The probe answers no more than that the process is
up (per-check readiness results stay behind `readiness.authorize`). The first to answer with a `Response`
refuses the request; `undefined` lets it through. A guard is where a wall
belongs that must stand in front of everything, cached pages and static files
included: basic auth on a staging site, an IP allowlist, a maintenance switch.

```js
/** @type {import('jsails/extensions').Guard} */
const stagingWall = (request) =>
  request.headers.get('authorization') === `Basic ${process.env.STAGING_AUTH}`
    ? undefined
    : new Response('Authentication required', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="staging"' },
      });

export default {
  http: { guards: [stagingWall] },
};
```

A guard's answer carries `Cache-Control: private, no-store` unless it set its
own, plus the security headers and `X-Request-Id`. A guard that throws, or
answers anything other than a `Response` or `undefined`, fails the request
with a value-free 500 and is reported (phase `guard`).

## Origin, hosts, and proxies

`server.origin` is the app's public origin, `server.hosts` the further hosts it
answers on (`'*.example.com'` stands for exactly one label), and
`server.trustedProxies` (`'none'`, the default, `{ hops: n }`,
`{ cidrs: [...] }`, or `{ hops: n, cidrs: [...] }`) the proxies trusted to
report the client in `X-Forwarded-For` and the scheme in `X-Forwarded-Proto`;
the `JSAILS_TRUSTED_PROXIES` environment variable (`none`, `hops=<n>`, a CIDR
list, or `hops=<n>` followed by one) applies when the config does not set it. `jamal deploy` sets that
variable from the proxies it deploys, so an app deployed with it leaves
`trustedProxies` out.

```js
export default {
  server: { origin: 'https://example.com', hosts: ['*.example.com'], trustedProxies: { hops: 1 } },
};
```

With an origin set, any other `Host` is answered `421` before every other
stage, and `jsails serve` outside development and test requires one. See
[Origin, hosts and proxies](/docs/deployment-proxies) for the full rules.

A request continues an inbound W3C `traceparent` only when one of those trusted
proxies relayed it. `telemetry: { trustInbound: true }` continues it from any
caller, for an app only its own services can reach; any other key under
`telemetry` is rejected. See
[Observability](/docs/observability#trace-context).

## Shutdown

`close()` is idempotent and tears down in reverse (HTTP server → the plugins'
lifecycle units → app cleanup → extensions). The HTTP server and the units
drain under one shared deadline, `shutdownTimeoutMs`: the units in reverse
dependency order once the server has drained, and a unit not idle at the
deadline (or when `close({ signal })`'s signal aborts, as a second SIGINT or
SIGTERM does under `jsails serve` and `jsails work`) is aborted, with at most
one more second for its abort (see [Plugins](/docs/plugins)). A unit aborted
without an error of its own makes `close()` reject with
`kernel.shutdown_timeout`, whose payload names the units. HTTP shutdown is a
drain under that deadline,
`shutdownTimeoutMs` (default `5000`, max `300000`): the health route flips to
`503`, the server stops accepting connections, idle keep-alive sockets close,
and every in-flight request runs to completion (answered with
`Connection: close`); meanwhile every live stream ends (`Respond.eventStream`,
`Respond.stream` with `{ live: true }`, any `text/event-stream` answer) and
every serve hook's drain participant (the broadcast and live plugins'
Socket.IO servers) disconnects its clients. Whatever is still open at the
deadline is stopped: each request's `ctx.signal` aborts with `serve.stopped`,
an unfinished stream is reported to `onError` as `serve.unfinished_stream`,
every socket the server accepted is destroyed, upgraded ones included, and
`close()` rejects with `serve.shutdown_timeout` (`ServeErrors` from
`jsails/app`), counting what was left open and naming the participants still
draining in its payload. The app cleanup and extension cleanups run after
every unit, trusted and awaited **without** a deadline — each owns its own
async cleanup. See
[Deployment](/docs/deploy#shutdown-and-live-streams).

`app.standby({ handle? })` runs every serve hook and resolves with the server
ready and accepting nothing; its `accept()` starts accepting. With `handle`
(the native handle of a listening socket another process passed over IPC, or
`{ fd }` of one) the server accepts on it instead of `host` and `port`, and
connections made before `accept()` wait in the socket's backlog: how a
supervisor's candidate process reports ready before it takes traffic.
`app.serve({ handle? })` is both in one call. Windows, supported for
development, refuses every handle with `serve.unsupported_platform`: it has
no listening descriptor to pass.

The server's keep-alive timeout defaults to `65000` ms (headers `66000`, whole
request `300000`), above the 60-second idle timeout of common load balancers,
so a proxy never reuses a socket Node has just closed (the Node default of 5 s
produces intermittent 502s behind one). Override them with the `server` key:

```js
export default {
  server: { keepAliveTimeoutMs: 75_000, headersTimeoutMs: 76_000, requestTimeoutMs: 0 },
};
```

Each field is optional and keeps its default when unset. `keepAliveTimeoutMs`
and `headersTimeoutMs` must be positive integers, `requestTimeoutMs` a
non-negative integer (`0` disables it), and `headersTimeoutMs` may not exceed a
non-zero `requestTimeoutMs`; the loader rejects anything else.

`server.handlerTimeoutMs` (default `30000`) is how long a route has to answer,
from entering it to its response: past it the request is answered `504`, its
`ctx.signal` aborts, and the expiry is reported to `onError` with phase
`timeout`. A route that declares its own `timeoutMs` uses that instead, and `0`
disables the deadline (see [Deadlines](/docs/routing#deadlines)). It must be an
integer from `0` to `2147483647`. `createApp` takes the same value as its
`handlerTimeoutMs` option.

```js
export default {
  server: { handlerTimeoutMs: 10_000 },
};
```

`maxBodyBytes` (default `1048576`, 1 MiB) caps the request body of a route that
declares no `body` of its own (see
[Request bodies](/docs/routing#request-bodies)). It is at most `104857600`
(100 MiB, `MAX_ROUTE_BODY_BYTES`), the length above which a request is refused
before routing; a route that takes more declares its own `body`.

```sh
jsails build --config jsails.app.js   # static export into `out`
jsails serve --config jsails.app.js   # listen until SIGINT/SIGTERM
```

## Next steps

- [Database](/docs/database) — entities, the portable schema, and migrations.
- [Routing](/docs/routing) — pages, API routes, and layouts.
