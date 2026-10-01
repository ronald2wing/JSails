---
title: Extending JSails
order: 13
section: Extending
---

# Extending JSails

JSails is extended through a single seam: the **extension**. An extension is a
plain object — not a class, not a global registration — that provides services,
registers routes, and returns a cleanup. The **substrate** is the code that
must run before any extension can exist — the CLI entry, the app config loader,
the extension runner and service registry, route discovery, and the plugin
resolver. Everything above the substrate is plugin-shaped, and a **plugin** is
just an extension that can be packaged and discovered.

Import from **`jsails/extensions`** for an ORM-free entry. The root `jsails` entry re-exports the same symbols
but pulls in `reflect-metadata` and TypeORM.

## The extension seam

An extension is `{ name, requires?, provides?, priority?, readiness?, setup(context) }`.
Names must be non-empty and unique — a duplicate errors before any `setup` runs.
`setup({ services, rootDir, routes, configureRequestScope, configureGuard, onServe })`
may return a cleanup function (or a promise of one).

- `rootDir` is the absolute application root, the directory of the app config
  the app was assembled from. Resolve project files an extension reads against
  it, not `process.cwd()`, so `--config path/to/app/jsails.app.js` run from
  elsewhere still finds them. `runExtensions(extensions, { rootDir })` sets it,
  and `rootDir` is required: a missing or relative value fails with
  `extension.invalid_root` before any `setup` runs, never falling back to the
  working directory.

- `createServiceToken<T>(name)` makes an opaque typed token. Identity is the
  token object itself, not its name, so define each token **once** and share it
  between providers and consumers. `name` is a diagnostic label only.
- Services are per application: `runExtensions([...], { rootDir })` (or `createApplication`)
  builds a fresh registry. There is no global registry and no cross-app sharing.
- `requires` lists service tokens that must already be registered by an
  **earlier** declared extension; a missing requirement fails before `setup`.
- `priority` orders the setup phase: within a topological layer, lower priorities
  run first, and ties keep declaration order. It defaults to `0`.
- Cleanups run in **reverse** declaration order on `close()`. If a `setup`
  throws, already-completed extensions are cleaned up and the registry cleared.
  An extension that throws before returning its teardown **owns the cleanup of
  whatever it partially created** — return the teardown as soon as resources
  exist so a later failure can dispose of them.

```js
// jsails.app.js  (app-owned, compiled ESM; plain default export)
import { publicAccess } from 'jsails/api';
import { createServiceToken } from 'jsails/extensions';

// Token defined once, shared by the provider and the consumer.
/** @type {import('jsails/extensions').ServiceToken<{ now(): string }>} */
export const clock = createServiceToken('clock');

/** @type {import('jsails/extensions').JsailsExtension} */
const clockExtension = {
  name: 'clock',
  setup({ services }) {
    services.provide(clock, { now: () => new Date().toISOString() });
  },
};

/** @type {import('jsails/extensions').JsailsExtension} */
const healthExtension = {
  name: 'health',
  requires: [clock], // provided by the earlier "clock" extension
  setup({ services, routes }) {
    const { now } = services.get(clock);
    routes.add({
      methods: ['GET'],
      path: '/healthz',
      access: publicAccess('uptime probe'),
      handler: () => Response.json({ ok: true, at: now() }),
    });
  },
};

export default {
  rootDir: '.',
  out: 'out',
  extensions: [clockExtension, healthExtension],
};
```

## HTTP routes

`routes` is the extension's HTTP registrar (an `HttpRoutes`, owned by the
extension's name). What it collects is compiled into the app's route table
and router when the app assembles:

- `routes.add({ methods, path, access, surface?, credentials?, cache?, body?, timeoutMs?, stream?, middleware?, handler })`
  adds a route. `access` is required (`publicAccess(reason)` from
  `jsails/api`, or a check function, see
  [Route access](/docs/routing#route-access)); `credentials` is `['cookie']`
  unless it says otherwise (the handler sees a session only from a kind it
  lists, so a route serving API tokens declares `['cookie', 'token']`), and
  `[]` (a route that reads no credential) skips the cross-site check;
  `surface` is the surface kind the registry lists it under, `'route'` unless
  it says `'admin'` (an admin-panel route) or `'webhook'` (a signed delivery
  receiver; see [Security](/docs/security#the-surface-registry)); `cache` is a public cache declaration (GET routes only);
  `body` states the request body the handler reads through `ctx.body` and its
  cap, `timeoutMs` the route's deadline and `stream.timeoutMs` a streamed
  answer's idle bound (see [Request bodies](/docs/routing#request-bodies) and
  [Deadlines](/docs/routing#deadlines)). The
  handler takes the request context and runs inside the route boundary, after
  the claim and the access chain. A `GET` route also answers `HEAD`, so `HEAD` is
  never listed. Paths use the router's syntax (`/reports/:id`, `/files/*`).
- `routes.mount(prefix, fetch, { access, credentials?, body?, timeoutMs? })` serves every method at and
  under the literal `prefix` with a web-standard fetch handler
  (`(request) => Response`, such as a Hono app's `fetch`), which sees the
  request as sent. It runs behind the same access chain. A mount at `/`, under a
  parameter, or covering a reserved path is refused, and a managed plugin is
  never granted one.
- `routes.guard(guard)` is `configureGuard(guard)`.
- `routes.transform(kinds, fn)` rewrites the answers of the routes of those
  kinds (`'api'`, which a registrar route is, `'page'`, `'component'`,
  `'mount'`), after their handler, in registration order. It cannot answer in a
  route's place and never sees a denied request. Framework routes are never
  transformed, so naming `'framework'` is refused (`route.invalid_route`).

A provider may hand its `routes` to a later extension (a helper service that
adds a route or a guard for the caller): what that extension registers through
it during setup belongs to the provider and is kept. After setup every call
throws.

Assembly refuses, with a value-free `route.*` code, a method and path
registered twice by anyone (`route.duplicate_route`), a route whose path lies
under a mount's prefix, or a mount at, above or under another mount
(`route.mount_overlap`), a path the framework reserves (the health and
readiness paths, `/_jsails/introspect`, the server-component endpoints, and any
other `/_jsails` path for an app route or a managed plugin:
`route.reserved_path`), and a managed plugin's route in an app whose plugins
are not managed (`route.managed_origin_refused`). Whichever of two such routes
registers first, assembly refuses the second.

A pattern that only may match a path another route owns, such as a catch-all
`/:slug{.+}`, is a fallback rather than a clash, and the owner answers first
whatever the registration order: assembly compiles the framework routes (each
answering a method it does not serve with a 405), then the registrars' mounts,
their routes under `/_jsails`, the registrars' other routes, and the
filesystem routes last. Every route, whoever registered it, is listed with its
access and owner by `routeTableOf(app).entries()`, and every file the asset
index serves (public, `GET` and `HEAD`, with its owner) by `assetRowsOf(app)`;
the surface registry describes those files as the one `asset:public` surface.

`routes` is the only way an extension adds to the HTTP surface: no extension
receives the router, so every route it serves has a declared access, the
credentials it accepts, and the cross-site check in front of its handler. An
app that needs Hono's own routing mounts a Hono app's `fetch` with
`routes.mount`.

## Middleware and request hooks

There is no app-wide middleware chain. A wall in front of every request is a
guard (`configureGuard`, or `http.guards` in the app config), and a rewrite of
every answer of some route kinds is a transform (`routes.transform`). A
`RouteMiddleware`, `(context, next) => Response`, wraps one route: a route
module's or `defineApi`'s `middleware` list, or `routes.add`'s `middleware`.

`configureRequestScope(scope)` registers a request scope: resolve first, then
bind. A scope is `{ name, cache, resolve }`:

```ts
import type { Session } from 'jsails';
import { runWithTenant } from 'jsails/database';
import type { JsailsExtension } from 'jsails/extensions';

declare function findTenant(host: string, identity: Session | null): Promise<{ id: number } | null>;

export const tenantScope: JsailsExtension = {
  name: 'tenant-scope',
  setup({ configureRequestScope }) {
    configureRequestScope({
      name: 'tenant',
      cache: 'partition',
      async resolve({ request, identity }) {
        const tenant = await findTenant(new URL(request.url).hostname, identity);
        if (tenant === null) return undefined;
        return {
          run: (fn) => runWithTenant(tenant.id, fn),
          partition: { name: 'tenant', value: String(tenant.id), from: 'host' },
        };
      },
    });
  },
};
```

When **any** route claims the request (filesystem pages and API routes,
registrar routes and mounts, the server-components transport, and
introspection), `resolve` runs once, after the identity and the locale and
before the access chain, the route's middleware, and the handler. It
receives a `ScopeRequest` (`request`, `url`, `params`, `identity`, `locale`,
`origin`, `client`) and answers with a binding, a `Response` (the scope answers
the request itself, such as a redirect to a canonical host), or `undefined`
(nothing to bind). Everything the route runs, and an error page or a late
streaming failure report for it, runs inside the binding's `run`, so a value it
makes ambient (a key of the execution context, such as the tenant
`runWithTenant` sets) reaches all of them. Scopes resolve in setup order, each
inside the earlier bindings, and the first binding is the outermost. A scope
that throws fails the request with the generic 500.

`cache` states how the scope affects a cached response: `partition` adds a
cache dimension its binding names (`partition: { name, value, from }`, where
`from` is `host`, `path`, `session`, or `header`, and only `host` or `path`
can key a response shared between visitors), `private` makes any response it
binds personal, and `transparent` changes nothing a response holds. A binding
that breaks its class (a `partition` scope without a partition, any other with
one) fails the request with `request_scope.invalid_binding`; a malformed or
duplicate scope fails `createApp` with `request_scope.invalid_scope` or
`request_scope.duplicate_scope`. Guards, and requests no route claims (public
files, 404s, the health probe), resolve no scope at all. A managed plugin needs the `http.scope` permission
([Plugins](/docs/plugins)).

`configureGuard(guard)` registers a guard, `(request, { id, client }) =>
Response | undefined`: a wall in front of **every** request but the health and
readiness probes. Guards run after the app config's `http.guards`, in setup
order, before public files, the 405 answer, and routes, so
nothing is read or served for a request a guard refuses. The first guard to answer with a
`Response` refuses the request (its answer gets `Cache-Control: private,
no-store` unless it set one, and the security headers and `X-Request-Id`); a
guard that throws, or answers anything else, fails the request with a
value-free 500. A managed plugin needs the `http.guard` permission.

`routes`, `configureRequestScope`, and `configureGuard` are only valid while
`setup` is running — calling any of them afterwards throws.

`readiness` declares named probes for the app's readiness endpoint, as
`(signal, services) => …`: each receives the readiness deadline's abort signal
and the sealed service registry, and passes unless it returns `false`, throws,
or times out. They are declared rather than registered in `setup`, run only for
extensions that ran, and share one namespace with every other extension and the
app config's `readiness.probes`. `runExtensions` returns them bound to the
registry as `runtime.readinessProbes`; see
[Configuration](/docs/configuration#health-route). A plugin activated through
the managed surface must declare the `health.readiness` permission to declare
any probe ([Plugins](/docs/plugins)).

## Serve hooks

`onServe(hook)` runs `hook(server, { config, services })` when the
application serves: after the `node:http` server is created, before it
accepts a connection, in registration order. A hook that attaches something
to the server that does not finish by itself (a WebSocket server, a
long-poll transport) returns it as a drain participant, a `ServeAttachment`:
an identifier `name` and `drain(deadline)`. When the application closes,
every participant's `drain` runs once, concurrently with the in-flight
requests, after the server stopped accepting connections; it disconnects its
clients and resolves once they are gone. `deadline` aborts at the shutdown
deadline, when whatever is still open is destroyed and the close
(`serve.shutdown_timeout`) names the participants that had not finished. A
participant never awaits the HTTP server's own close (Socket.IO's
`io.close()` does): that resolves only once every connection of the server
has ended, so a slow HTTP request would hold the participant and the close
would name it. The server's drain already waits on the connections,
upgraded ones included.

```ts
// plugins/echo-socket.ts
import type { JsailsExtension } from 'jsails/extensions';

declare function attachEchoSocket(server: import('node:http').Server): {
  close(): Promise<void>;
};

export const echoSocket: JsailsExtension = {
  name: 'echo-socket',
  setup({ onServe }) {
    onServe((server) => {
      const transport = attachEchoSocket(server);
      return { name: 'echo-socket', drain: () => transport.close() };
    });
  },
};
```

A hook that adds an `upgrade` listener and returns no participant fails the
serve with `serve.missing_attachment`, naming its extension: nothing would
close an upgraded socket before the deadline. A hook that returns anything
but a participant or nothing fails with `serve.invalid_attachment`. The
broadcast and live plugins return their Socket.IO servers this way; see
[Deployment](/docs/deploy#shutdown-and-live-streams) for the whole drain.

## Substrate vs. plugin boundary

Not everything can be an extension. The substrate is everything upstream of
`runExtensions`: the CLI entry and command dispatch (`src/cli/index.ts`), the
app config loader and plugin resolver (`loadApp` and `resolvePlugins` in
`src/kernel/`), the extension runner itself (`runExtensions`) and the
service registry, and route discovery (`discoverRoutes`).

An extension cannot run itself, so these stay in core. Everything **above** that
line — routes, services, commands, pages, admin surfaces, first-party
features like auth/blog/jobs — is plugin-shaped and can be declared as an
extension.

The read-only introspection commands (`inspect`, `describe`, `explain`) are
deliberately **substrate**, not an `introspect` plugin: they are early-routed
_before_ config loading and own their own `--config` flag, so they work from any
cwd with no app config. Their names are reserved
(`DEFAULT_RESERVED_COMMAND_NAMES`) so a user command cannot be silently shadowed
by the early routing.

## Contract tokens

A **contract token** is a typed capability declaration with replacement
semantics — distinct from a service token, not a flag on it.
`createContractToken<T>(name, { version? })` produces a token whose `version`
defaults to `1` and must be a positive integer; each call is a distinct identity
even when `name` repeats.

An extension declares the contracts it fulfills in `provides` and the ones it
reads in `requires`. When one extension provides a contract and another requires
it, the provider is guaranteed to run before the consumer regardless of
declaration order — the runner topologically sorts over these edges, then
`priority` lowest-first, then declaration order. Service tokens in `requires`
are still checked inline; they do not affect ordering.

At most one non-override provider plus at most one override is permitted per
contract. A `provides` entry with `override: true` replaces the default
provider — the override's implementation wins in the registry. The runner
always sets up the default before its override, whatever their declaration
order or `priority`, so the default's plain `provide` never collides with the
override's value. Zero providers for a required contract, or two non-override
providers, fails value-free before any extension's `setup` runs, so a
misdeclared graph opens no connections, workers, or timers.

An interceptor registry dispatches each bucket in its stored order (sorted at
registration), and `hasObservers(event)` lets a hot path skip building a payload
nobody listens to.

## Overrides, interceptors, and the signal bus

Overrides work differently in different parts of the framework, and that asymmetry is deliberate:

- **Extensions always run.** App-declared `config.extensions` and `plugins.use`
  entries run in full; nothing filters them at boot.
- **Services override; registries are add-only.** `provide(token, value,
{ replace: true })` overwrites a registration (a duplicate without the flag
  throws); a contract has one dedicated override provider; theme tokens fold by
  precedence with application tokens winning highest. Admin
  pages/resources/widgets/charts/notices enforce uniqueness with no override
  API, and routes/pages/API are additive — a health-path collision is a hard
  error.
- Interceptors follow a narrow subset of the Magento 2 model. `before`, `after`, and `observe` run on explicitly defined operation tokens: `before` mutates args in place with no short-circuit, `after` transforms the result in reverse order, and `observe` is fire-and-forget. There is no `around` hook, no method-level AOP weaving, and no generated interceptor classes. Only the first-party blog plugin uses interceptors.
- Signals share the WordPress observer model but deliberately omit filters. `SignalBus.observe` and `emit` provide a shared, fire-and-forget, error-isolated bus over a fixed set of event tokens (requests, jobs, and logging). There is no `apply_filters`-style value-filter registry — no priority-ordered callback chain that transforms a framework value in transit. There is no runtime `add_action` after the registry seals, and no dynamic per-listener priority outside `setup`.

The trade is deliberate: JSails exchanges ambient power for compile-time clarity
— capabilities exist only where explicitly authored, and only enumerate during
`setup`. It is neither a Magento aspect weaver nor a WordPress hook system.

## Next steps

- [Plugins](/docs/plugins) — packaging, discovering, and installing extensions.
- [Symbols & Autoload](/docs/symbols) — the generated autoload layer.
- [Admin Panel](/docs/admin) — the first-party admin surface.
