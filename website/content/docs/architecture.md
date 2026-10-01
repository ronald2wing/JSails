---
title: Architecture
order: 3
section: Orientation
---

# Architecture

JSails is a TypeScript Active Record data layer plus a bounded application runtime
(extension system, HTTP/pages/API, static export, jobs, broadcast, deploy config,
and a CLI). It deliberately reuses maintained libraries — TypeORM, Zod, BullMQ,
Socket.IO, Preact, Hono — instead of implementing its own renderer, auth stack, or
queue.

Small utilities (duration/byte formatting, deep equality, defaults merging,
concurrency, retry scheduling, base64, error serialization, cookie parsing) are
owned in `src/internal/` rather than added as dependencies. When one big package
already covers the need (for example `es-toolkit` for case and collection
helpers), it is preferred over a collection of small packages; large,
protocol-level, or rule/data-heavy packages stay external.

The framework also dogfoods its own helpers and runtime surfaces: when core needs
a capability it already exposes, it uses that surface rather than a parallel
private helper or a new dependency.

Other frameworks and JavaScript best practices are references, not specifications.
The API is designed for JSails and for the person reading it; there are no
compatibility shims for their own sake.

## Overview and principles

- **Human-first.** The CLI scaffolds, compiles, and serves, but decisions with
  domain impact — applying migrations, destructive schema changes, running a
  production release — remain explicit human actions. `jamal deploy` and
  `jamal rollback` execute by default with `--dry-run` printing the plan.
- **Everything is a plugin.** The kernel is a thin, inert core: config loading, an
  ordered extension runner, route discovery, the Hono pipeline, and the data
  layer. Every capability — auth, admin, blog, jobs, broadcast, cache, mail,
  filesystem, notifications, server components — is a first-party plugin wired
  through the same extension seam.
- **Lazy, inert construction.** Importing a config module or calling a factory
  never opens a connection or reads the environment. Connections are opened only
  by `serve()` (or an extension's own `setup`/first use). This is what keeps
  `jsails build` (static export) working without a database.
- **MariaDB by default, but no lock-in.** Drivers: `mariadb` (recommended),
  `postgres`, `mysql`, and persistent file-backed SQLite via `sqljs`.
- **Bounded, portable schema.** The migration core models a narrow scalar schema
  and rejects anything it cannot faithfully represent.
- **Value-free errors.** Failures that cross a trust boundary never echo raw
  values, credentials, or response bodies.

## Kernel vs plugins

The **kernel** (the `core` package's `src/` substrate: `app/`, `extensions/`,
`routing/`, `pages/`, `server/`, `database/`, `migrations/`, `environment.ts`,
`contracts/`, `jsx/`) provides the runtime and the seams. First-party **plugins**
are separate workspace packages under `packages/*/`, published under the
`@jsails/*` scope (`@jsails/auth`, `@jsails/admin`, `@jsails/blog`,
`@jsails/cache`, `@jsails/live`, `@jsails/theme`, and so on);
they consume the kernel through the same extension seam. Some runtime
capabilities still ship as core modules under `src/` (`jobs/`, `broadcast/`,
`live/`, `signals/`, `server-components/`, `seo/`, `encryption/`), with their
plugin packages re-exporting the contract. The `src/i18n/` translator is a
dependency-free leaf (neither kernel nor plugin — it imports nothing beyond the
platform).

### Kernel contracts

Kernel features expose a typed service token when the application replaces an
implementation. The default implementation stays in core; a plugin or app can
provide its own through the normal service registry.

| Domain | Contract | Token / seam |
| --- | --- | --- |
| Encryption | `Encrypter` (`encrypt`/`decrypt`) | `encryptionToken` + `encryptionPlugin`; model fields resolve the env key source once before extension setup |
| SEO | `SeoService` (`buildHeadTags`/`injectHead`) | `seoToken`; page rendering resolves it per request and falls back to the stateless default |
| i18n | `I18nService` | `i18nToken` + `i18nPlugin` |
| Jobs | `JobsService`, `JobsRuntimeAdapter` | `jobsToken` + `jobsPlugin` |
| Broadcast | `BroadcastAdapter`, `BroadcastService` (`publish`) | `broadcastToken` + `broadcastPlugin`; publishing before serve fails closed |
| Server components | `ServerComponentsRuntime` | `serverComponentsToken` + `serverComponentsPlugin` |
| MCP | `defineMcpTool`, `defineMcpServer` (`@jsails/mcp`) | definitions served over stdio by `serveMcpStdio` (the Streamable HTTP mount arrives with the `mcp` plugin); `jsails mcp` is the developer stdio server in core |

### The extension foundation

An **extension** is a plain object `{ name, requires?, priority?, disabled?, setup(context) }`. `runExtensions` prevalidates every entry and the required absolute `rootDir` it hands each `setup`, runs `setup` in priority order (lower first, then declaration order), checks each extension's `requires` against services earlier extensions registered, collects routes, guards, transforms and serve hooks, wires a per-application interceptor/observer registry, seals the registries, and returns a runtime whose `close()` runs cleanups in reverse.

The `setup` context exposes these write surfaces:

- `services.provide(token, value)` / `services.get(token)` — a per-application service registry keyed by opaque `createServiceToken<T>(name)` tokens.
- `routes.add(spec)` / `routes.mount(prefix, fetch, options)` — register routes, each with its access and the credentials it accepts; the access chain (the cross-site check, then the access) runs in front of every handler, and no extension receives the router. A request no route matches gets a 404, or a 405 with `Allow` when its path answers other methods.
- `onServe(hook)` — run after the HTTP server is created but before it accepts a connection; a hook returns what it attached (a WebSocket server) as a drain participant, which the server's shutdown drains with the in-flight requests.
- `intercept(operation, fn, { phase })` / `observe(event, fn)` — identity-based interception. `before` hooks mutate args, `after` hooks transform the result in reverse order, and observers react to emitted events with errors isolated.

A **plugin** (`definePlugin`) is an extension with a declarative `renderer` passthrough and a `PluginContext` whose `setup` can register interceptors/observers.

### Substrate vs. plugin boundary

The **substrate** is everything upstream of `runExtensions` — the code that must
run before any extension can exist — and it stays in core; everything above that
line is plugin-shaped. [Extending JSails](/docs/extending#substrate-vs-plugin-boundary)
lists the substrate modules and why the introspection commands belong there.

### Application assembly

The kernel stages are functions over values. `loadApp` scans the config's
import graph and activation literal, imports it, validates it, and seals its
activation mode onto the `LoadedApp`; `resolvePlugins` turns that into a
`PluginGraph` — the framework's routing, pages and i18n plugins, then
`plugins.use`, then `config.extensions` — and checks it (cycles, unprovided
services, duplicate names and providers) before any setup, for the roles the process runs (`web`
for `jsails serve`, `worker` for `jsails work`). `openServices` runs the
graph's plugins in full, connection-free, collects the lifecycle units they
register and validates their plan (names, `after` order, transport reach)
before anything starts; `createApplication` then discovers routes, runs the
app `setup` hook, and returns an inert `Application`. `start` (on
`app.start()`, `serve()` or `standby()`) starts the units of the process's
roles in dependency order; the HTTP server joins as a unit that drains first,
and `close()` shuts everything down under one deadline. The graph also names
its live-only plugins (`liveOnly`), which a static export leaves out and
`jsails describe` reports. Only the resolver reads the sealed mode: in managed
mode the graph carries the schema authority, and it is where the marketplace
plugin source will add its verified plugins. No database row or file activates
plugin code in either mode.

```mermaid
flowchart TB
    A["loadApp: scan graph + activation literal, import, validate, seal mode"] --> B["resolvePlugins → PluginGraph"]
    B --> D["framework → plugins.use → config.extensions"]
    D --> E["validate graph: cycles, services, names — before any setup"]
    E --> F["openServices(graph): setup(context) in contract/priority order"]
    F --> H["services.provide / routes / lifecycle.register / intercept / observe"]
    H --> I["seal registries; plan the units: names, after, reach"]
    I --> C["discoverRoutes(pages/, api/) — lexical, no import"]
    C --> J["app setup() hook (runs last)"]
    J --> K["inert Application: build() | start() | serve() | close()"]
    K --> L["start: units of the process's roles; HTTP server adopted last, drained first"]
```

## Data layer

`JsailsDataSource` extends TypeORM's `DataSource` and restricts drivers to
`postgres | mysql | mariadb | sqlite` (the `sqlite` logical driver uses `sqljs`
with an atomic write-then-rename `autoSave` callback — single-process, no WAL).
It rejects `synchronize`, `dropSchema`, `migrationsRun`, and a TypeORM
`migrations` config at construction. `getModelSchema()` builds entity metadata
offline.

Entities use `BaseEntity` (Active Record) or `EntitySchema`. The portable schema
model is deliberately bounded: scalar columns (`integer`, `varchar` with explicit
`length`, `text`, `boolean`, `datetime`, `decimal`, `float`, `bigint`, `uuid`,
`json`, `date`, `time`), single or composite primary keys, simple indexes and
unique constraints, single- or multi-column many-to-one foreign keys with
`CASCADE`/`RESTRICT`/`SET NULL`/`NO ACTION`, and many-to-many relations through
explicit junction-table entities or auto-generated `@JoinTable()` junction tables.
Deferrable foreign keys and unique constraints are Postgres-only. Partial or
expression indexes, enums, generated UUIDs, computed columns, and function
defaults are rejected with `UnsupportedSchemaError`.

`FileDataSource` is a read-only, in-memory Active Record source for tests and
demos, backed by `sqljs` in `query_only` mode.

### Transactions and model-level validation

`transaction(dataSource, body)` wraps TypeORM's `manager.transaction` with a
per-call `TransactionHandle` supporting `afterCommit` and `afterRollback`
callbacks. Nested calls for the same data source join the outer transaction;
different data sources open independent transactions.

`defineEntityValidation(entity, schema)` returns an immutable validation
descriptor; `validateEntity` returns a flat `FieldError[]`;
`assertEntityValid` throws `EntityValidationError`.
`entityValidationHooks(validation)` bridges to the subscriber seam, gating
`beforeInsert` and `beforeUpdate`.

### Declarative schema engine

Schema management is declarative, not linear. The model classes (`@jsails.*`) are the
single source of truth — there are no migration files, no JSON artifacts, no applied-state
ledger, and no `migrations/` directory.

`db:push` diffs the declared model schema against the **live** database (TypeORM
`QueryRunner.getTables()`), computes a minimal operation plan, classifies each
operation safe vs destructive, and applies all safe operations automatically. A
destructive operation (drop column/table, narrowing alter, any SQLite alter)
refuses the **entire plan atomically** unless `--allow-destructive` is passed. No
partial apply. `--dry-run` prints the plan without applying it.

`db:diff` is the read-only counterpart — it diffs and prints the same operation
plan but never touches the database.

The only permanent intent marker is `@jsails.renamedFrom('old_name')` on a column or
relation, which tells the differ a rename happened (emits `rename_column` instead of
drop+add). It is idempotent.

Data migrations (`defineDataMigration({ up, down })`) are named functions over a
live `DataMigrationContext` (a TypeORM `QueryRunner`). They are a **second phase**
of `db:push` executed after schema changes succeed, every time `db:push` runs —
including when the schema is already current. Every data migration MUST be
idempotent (guarded `UPDATE ... WHERE <not-yet-migrated>`); a non-idempotent data
migration duplicates rows on each push. `down` is never invoked by a command — it is
a documented manual escape hatch. Data migrations never run if phase 1 refuses or
fails.

Live-only objects are filtered from introspection (no phantom diffs).
MySQL/MariaDB type ambiguity resolves by declared-side tiebreaker; SQLite
introspection is the least faithful. Rollback is manual — there is no ledger to
walk backwards from.

### Polymorphic relations, relation API, through relations

`@PolymorphicRelation` on a child entity generates `<prop>_type` and `<prop>_id`
columns plus a table-level descriptor, with no database-level FK. Typed loaders
(`loadPolymorphic`, `loadPolymorphicInverse`) handle forward and inverse load.

The relation API provides a connectionless metadata resolver (`resolveRelation` /
`resolveRelationPath`), batch IN-clause loader (`loadRelation` / `loadRelations`
with nested-path recursion and M2O/O2M/O2O/M2M/polymorphic support), portable
EXISTS predicates (`whereHas` / `has` / `exists` with nested dotted-path support),
and GROUP BY aggregates (`relationCount` / `relationAggregate`). Through relations
(`resolveThroughRelation`) resolve `has_many :through` and `has_one :through` paths.

### Attribute encryption

`new AesEncrypter({ key, previousKeys? })` (`jsails/encryption`) is a standalone
AES-256-GCM adapter implementing the structural `Encrypter` port that takes an
explicit key with **no** environment fallback.
The model-level `encrypts(encrypter, fields, options?)` builds an
`EntityHooksDefinition` that transparently encrypts/decrypts named fields. When
used with the framework's `@jsails.encrypts()` decorator, the encrypter is
resolved through `resolveModelEncrypter`, which reads `JSAILS_ENCRYPTION_KEY`
(and optional `JSAILS_ENCRYPTION_PREVIOUS_KEYS`) from the environment — the
channel available before any extension `setup` runs. Without a configured key,
the model-level resolver returns a sentinel that throws on first use rather than
silently persisting plaintext.

## HTTP, pages and server components

**HTTP is Hono.** `createApp` + `createHttpServer` build the pipeline but never
listen. An API module exports named HTTP-method handlers `(request, context) =>
Response`.

- **Routing** is lexical and import-free: `discoverRoutes` walks `pages/` and
  `api/` (only compiled `.js`/`.mjs`), mounts `api/` under `/api`, and accepts
  only single-segment `[id]` params.
- **Pages** are compiled modules: a function default export, optional `load(context)`
  for async props, optional `getStaticPaths()`. The built-in `preactPageRenderer`
  renders Preact SSR.
- **`jsails build`** is a static export: render every page (expanding
  `getStaticPaths`), copy the asset index (`public/`) byte-for-byte, swap into `out/` through a
  staging directory.
- **Route groups** `(name)` contribute no URL segment but scope layouts (pages-only).
- **Nested layouts** (`layout.js`/`layout.mjs`) are discovered lexically and
  folded inside-out at render time. If the outermost layout emits `<html>`, the
  minimal document shell is skipped.
- **Every surface states its access.** Each route and the public files are
  registered as surfaces with a required access (`publicAccess(reason)` or a
  check that admits on exactly `true`); one stating none fails `createApp`.
  `resolveSession(request)` is the trusted session seam. An unsafe request to
  a surface accepting the session cookie must carry the app's exact `Origin`
  (or `Sec-Fetch-Site: same-origin`), anonymous included; there is no CSRF
  token.
- **API resources** (`createResourceHandlers`, `defineSerializer`, `parseFilters`,
  `require`/`and`/`or`/`resourcePolicy`, `readForm`, `generateOpenApi`,
  `createResourceRouter`, `resolveApiVersion`) are browser-safe and live in
  `jsails/api`. Request throttling is `throttle` in `@jsails/cache`.

The request lifecycle:

```mermaid
sequenceDiagram
    participant C as Client
    participant H as Hono pipeline
    participant R as Routes (framework, registrar, filesystem)
    participant A as authorize/resolveSession

    C->>H: HTTP request
    H->>H: request frame (request id, origin, 421, body bound to its budget) + guard tier
    H->>H: declared body length over the largest route cap: 413
    H->>H: route match (framework, mounts, registrar, filesystem)
    H->>A: resolveSession (default session: null)
    H->>H: cross-site check for an unsafe method
    H->>A: authorize (default-deny, exact true)
    A-->>H: allow / deny
    H->>R: page loader + renderer, or API method handler
    R-->>H: Response
    H->>H: no route matched: 404, or 405 with Allow
    H->>H: finalize (cache policy, coding, ETag/304, security headers)
    H-->>C: Response
```

### Per-route middleware

A compiled page or API module may export `middleware`, an array of
`RouteMiddleware` functions (`(context, next) => Response`) applied in declared
order before the handler. Every route, whoever registered it, is recorded in the
route table (`routeTableOf(app)`: kind, methods, pattern, access, credentials,
surface kind, owner, origin) and the surface registry (`surfacesOf(app)`) and compiled into one route boundary with a fixed order:
`request frame (body bound to its budget) → guards → route match → declared
body length → deadline → rate-limit hook → claim (session, locale, scopes) →
access chain (cross-site check for unsafe methods, then access) → per-route
middleware → handler → transforms → body verdict → finalize`. No byte of the
body is read before a reader asks for it. A request
no route matches skips the route's stages and gets a 404, or a 405 with `Allow`
when the route table says its path answers other methods. A middleware that
returns without calling `next()` short-circuits; `next()` is callable at most
once. There is no app-wide middleware chain: extensions add routes, guards and
response transforms through their `routes` registrar.

### Server components

`jsails/server-components` is a signed, **stateless** state protocol:
state is carried in an HMAC-signed snapshot, not a server-side store.
`defineServerComponent`/`defineAction` define a component (`stateSchema` forced
`.strict()`, `writableKeys` restricting client edits only, a **required**
default-deny `authorize`, actions with their own `input` schema, and `render(state,
{ bind, call, submit })`). The runtime mounts `POST /_jsails/components/update`
only when an extension registered one; the access chain runs the cross-site check
on it, and the runtime owns every signature and policy check.
**State is public** — integrity-protected, never encrypted. Static export renders
only `staticFallback`.

Lifecycle hooks (`mount`/`hydrate`/`updating`/`updated`) run in order and receive
mutable server-side state. Computed properties (`computed`) derive read-only view
values at render time. The friendly authoring surface `defineComponent` splits
actions into `serverAction` (full authorize/origin/validation) and `localAction`
(pure, synchronous, no context — a persisted write is unreachable by
construction). `FormObject`s (`defineForm`) and nested child components
(`defineNestedComponent` / `renderNested`) with independent security boundaries
and `MAX_NESTING_DEPTH` (8) complete the authoring toolkit.

The update flow:

```mermaid
sequenceDiagram
    participant B as Browser
    participant U as POST /_jsails/components/update
    participant R as Runtime
    participant C as Component

    B->>U: v2 update (snapshot + have: render tag, held children; Origin)
    U->>U: access chain: cross-site check (exact Origin)
    U->>R: verify snapshot (HMAC, expiry, subject binding, origin)
    R->>C: authorize(context) — current request, default-deny
    C-->>R: allow / deny
    R->>R: apply client edits under writableKeys; validate strict state
    R->>C: run at most one allowlisted action (args via input schema)
    C-->>R: mutate state (may throw ZodError -> 422 field errors)
    R->>R: re-validate whole state; render (held children kept by reference)
    R-->>B: unchanged (same tag, no edit, no effect) or render (HTML, tag, effects)
```

The token is re-signed only when the state changed or its lifetime needs
renewing, so an idle poll gets a few-dozen-byte `unchanged` reply. A nested
child the client reports holding is kept by reference: authorized, never
executed, and left untouched in the DOM.

## Client runtime

`jsails/client` is the browser-safe runtime. `startClient()` dynamically imports
Turbo, starts the shared session, registers declarative islands, hydrates initial
markup, and auto-enables server-component bindings; it is idempotent. Turbo owns
all link interception and history. Ordinary same-origin `<a href>` links get soft
navigation over SSR and SSG pages; native opt-outs fall through to full
navigation. Island props are decoded with bounded `JSON.parse` and reject
`__proto__`/`constructor`/`prototype` keys.

Asset URLs map a public asset path to a content-hashed `?v=<sha256>` query (cached
by `mtimeMs` + size), so a changed build asset forces a full reload via
`data-turbo-track="reload"` while unchanged assets keep soft navigation.

Model projection (`jsails/client/model`) projects server-owned component state
into `@preact/signals` for reactive rendering — strictly one-way, pull-only, never
pushing a local edit back. Hotwire Native web groundwork
(`definePathConfiguration`, `resolvePathConfiguration`, `isNativeApp`) provides a
pure-path configuration layer with no native SDK dependency.

## Admin

`@jsails/admin` is a first-party plugin: `adminPlugin` mounts the dashboard,
`/_search`, and `/actions/:name`. Building blocks are ORM-free descriptors:
`defineWidget` (stat-card descriptors), `defineNotice` (flash-message registry),
`defineAdminAction` (header/row/bulk mutations with optional per-record
`authorize`), `defineChart` (SVG chart descriptors), and `defineResource` (CRUD
surface with list columns and form fields). Additional breadth: relation columns,
repeater fields, infolist sections, file fields wired to the filesystem disk seam,
tabs, wizards, table grouping, bulk export, additional chart types (donut/area),
additional widgets (progress/list/trend), and additional actions
(replicate/restore/import). Relation managers (`defineRelationManager`,
`defineAttachAction`, `defineDetachAction`) handle many-to-many associations.

## Plugin system

The plugin system (`jsails/plugins`) covers the manifest contract, the
permission registry, the settings schema, plugin package discovery and its
framework-version check, the capability gate, plugin schema collection, and
`plugins.use` resolution.

- **Code declares what runs.** `resolvePluginUse` loads the `plugins.use`
  entries; the kernel resolver orders them into the plugin graph with the
  framework plugins and `config.extensions`, and the extension runner runs
  each `setup` in contract and priority order.
- **Discovery activates nothing.** `discoverPlugins` reads the `package.json`
  manifests of the app's plugin dependencies, and `checkPlugins` checks them
  against the framework version (`jsails plugins list|check`). Neither imports
  plugin code.
- **Release trust** lives in `@jsails/marketplace`: the bundle archive reader,
  bundle intake, and the release-statement, publisher and catalog verifiers.

```mermaid
flowchart TB
    A["plugins.use + config.extensions (code)"] --> R["resolvePlugins: graph, validated before setup"]
    F["framework plugins: routing, pages, i18n"] --> R
    R --> G["extension runner: setup() in contract/priority order"]
    D["discoverPlugins + checkPlugins: manifests only"] -.->|"report, never activate"| L["jsails plugins list | check"]
```

## Runtime services

Jobs, broadcast, cache, mail, filesystem, diagnostics, sessions, notifications,
i18n, flags, and theme are first-party plugins and services, each with its own
subpath and an explicit lazy-connect discipline.

- **Jobs** (`jsails/jobs`) — `defineJob(schema, handler)` pairs a Zod schema with a
  typed handler. The provider-neutral runtime `JobsRuntimeImpl` owns job-level
  policy (validation on enqueue and on processing, dispatch-option allowlisting,
  local schedule validation). `BullMQAdapter` is the default transport.
  Scheduling is at-least-once. Metrics (`InMemoryJobMetrics`), failed-job store,
  lifecycle events on the signal bus, per-job middleware, batch/chain patterns,
  and overlap control over the `LeaseStore` contract round out the surface.
- **Broadcast** (`jsails/broadcast`) — `attachBroadcast` mounts on the existing HTTP
  server under `/_jsails/broadcast`. The built-in Socket.IO adapter enforces
  origin allowlist, server-side authentication, and default-deny channel
  authorization. A custom `BroadcastAdapter` is trusted application code.
- **Cache** (`@jsails/cache`) — an evictable `CacheStore` of strings and bytes
  with namespaced views, in memory (a byte-bounded LRU) or on Valkey, plus a
  fixed-window `FixedWindowRateLimiter` whose counters live apart from it. The
  fenced `LeaseStore` contract is a separate surface for exclusion that cache
  pressure cannot break.
- **Mail** (`@jsails/mail`) — a transport-agnostic `Mailer` seam with three
  transports (in-memory, callback, lazy SMTP via nodemailer).
- **Filesystem** (`@jsails/filesystem`) — a keyed blob-store `Disk` contract with
  local, in-memory, and S3-compatible disks described to its plugin as data
  (an `env` disk for deployment selection), plus lazily cached variants
  (`defineVariant`).
- **Blog** (`@jsails/blog`) — the standalone blog CMS package (TypeORM persistence):
  `blogPlugin({ repository })` contributes the `blogRepositoryToken`
  `BlogRepository` plus the live `GET /blog` list, discovery feeds, and search
  routes (`POST /blog/posts` is registered only with `createRoute: { access }`);
  `createMemoryBlogRepository` and
  `createDatabaseBlogRepository` (the `jsails_blog_content_*` tables declared by
  the plugin's static schema) implement the repository. The admin integration
  lives under `@jsails/blog/admin` (`@jsails/admin` is an optional peer):
  `blogAdmin({ repository })` contributes the posts/pages/categories/tags
  resources plus the menus and revisions pages, and
  `blogThemeAdmin({ registry, repository })` contributes a `themes` page for
  activating a `@jsails/theme` package (persisted in the `theme.active`
  setting, `BLOG_THEME_SETTING_KEY`). The site settings are the `blog.site`
  `@jsails/config` set, `blogSiteConfig`; the public routes read its title,
  tagline, posts per page, time zone, and social links through the config
  service when the app provides it (`readBlogSiteSettings`), and the themed
  header renders the admin's `primary` menu. Each public route queries exactly
  the page it shows (`listPublishedPosts`: status filter, order, and paging in
  SQL, no rich-text bodies; `getPostBySlug`, `getCategoryBySlug`,
  `getTagBySlug` for single rows). Pass `siteUrl` (the public origin) in
  production: feed and sitemap links are built on it, and only then are those
  responses marked `public, max-age=300`; without it they fall back to the
  request origin. Admin saves run the update, its revision, and the status
  change in one `repository.transaction`, skip a revision when the content did
  not change, keep the newest `revisionLimit` revisions per entry (default 25),
  and attribute writes to the session's `data.user.id`; restoring a revision
  re-indexes the post. Slugs must match `BLOG_SLUG_PATTERN`
  (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) and menu links `isAllowedMenuHref` (paths,
  fragments, `http(s):`, `mailto:`; no control characters or `//host`), for
  every writer. In the admin a refused or already-taken slug re-renders the
  form with a 422 on the slug field, and a menu past `BLOG_MENU_MAX_ITEMS`
  (100) or one holding a stored link the policy now refuses answers 400; fix
  legacy rows before editing them.
- **Config** (`@jsails/config`) — typed config sets edited on the admin
  Configuration page, exported to and imported from sync files
  (`config:export`/`config:import`), and overridable from code. Values are
  stored in `jsails_config`; see [Config Management](/docs/config).
- **Editor** (`@jsails/editor`) — the ProseMirror rich-text editor, its form
  field island and the server renderer over the editor-agnostic model in
  `jsails/rich-text` (version 2: blocks of inline runs, read only through
  `parseRichText`). The editor's schema is generated from the model, so it
  cannot hold a value the model refuses. The Preact island
  (`@jsails/editor/preact`) hydrates rich-text fields (the admin's and
  `RichTextField`'s) with a three-state form contract and loads the editor on
  demand; the server renderer (`@jsails/editor/server`) emits a fixed element
  and attribute set and relies on the model's URL predicates. Neither imports
  blog persistence.
- **Media** (`@jsails/media`) — a disk-backed media library (uploads, metadata,
  selection, media references). Metadata is process-local by default; the
  generated blog wires `createDatabaseMediaIndex` over its shared data source so
  alt/caption/MIME/dimensions persist in the `jsails_media_asset` table.
- **Diagnostics** (`@jsails/diagnostics`) — a Telescope-style, in-memory recorder
  with `wrapAsync` duration tracking, a plugin, and pluggable watchers (request,
  query, exception). No secrets, credentials, or raw bodies are recorded.
- **Sessions** (`@jsails/sessions`) — a framework-owned `jsails_session` entity and
  `createDatabaseSessionStore` over the data source's repository.
- **Notifications** (`@jsails/notifications`) — multi-channel delivery (memory/mail)
  with an in-process fire-and-forget `NotificationsService`. No queue or retry —
  use the jobs plugin for durable delivery.
- **i18n** (`jsails/i18n`) — a dependency-free translator (dot-path keys,
  `scope`/`default` fallbacks, `{name}` + `:Name` interpolation, and
  `Intl.PluralRules`-driven plurals) plus `localize()` for dates/numbers/currency.
  A server-only loader (flat JSON + nested group files), an `i18nPlugin` with a
  per-request `I18n` facade, and a `jsails i18n:missing` command complete it.
- **Feature flags** (`@jsails/flags`) — a boolean gate with an in-memory
  `FeatureStore`, a database-backed one on the `@jsails/flags/database`
  subpath (provided under `featureStoreToken`), plus a `flagsPlugin`.
- **Theme tokens** (`@jsails/theme`) — a browser-safe CSS custom property token
  contract. The five core tokens (`--jsails-bg`, `--jsails-fg`, `--jsails-accent`,
  `--jsails-muted`, `--jsails-border`) are semver-visible API. Plugins contribute
  additional `--jsails-*` properties with app-wins-highest precedence.
- **Encryption** (`jsails/encryption`) — symmetric AES-256-GCM with key rotation.
   `new AesEncrypter` takes an explicit key with no environment fallback.
  `encryptionPlugin` provides it under `encryptionToken`. The model-level hook
  resolves from `JSAILS_ENCRYPTION_KEY` (see Data layer section above).
- **Validation** (`jsails/validation`) — composable, value-free Zod-backed rules
  (`required`, `email`, `url`, `minLength`, `maxLength`, `min`, `max`, `regex`,
  `inList`, `confirmed`, `when`) plus a `validateFields` bulk helper.
- **HTTP client** (`jsails/http`) — fetch-based `FetchHttpClient` with typed
  methods, bounded timeouts, injectable fetch, retries, and value-free error
  reporting (never echoing input, secrets, or raw values), plus a
  `FakeHttpClientImpl` for deterministic test stubbing.
- **Inertia adapter** (`@jsails/inertia`) — the server half of the Inertia v3
  protocol as pure functions that return plain-data outcomes: prop
  descriptors, partial reloads, the page object, a strict serializer, the
  `<script data-page>` document, the version guard and `409` control
  responses, redirect adaptation, the Origin check (its cross-site defence: no
  `XSRF-TOKEN` cookie, no `_method`), a sealed one-shot cookie for flash and
  validation errors, Precognition, and in-process or HTTP SSR gateways.
  `@jsails/inertia/testing` builds client requests and reads pages and the
  carrier back; the suite certifies the engine against the real
  `@inertiajs/react` client on `preact/compat` and React 19.
- **Signed URLs** — `HmacUrlSigner` with HMAC-SHA256, domain-scoped key prefix,
  and an expiry timestamp. `verify(url)` returns the verified `{ path, params }`
  (or `null`, never a throw) and rejects a URL that repeats any query key;
  handlers read parameters from that result, never by re-parsing the request
  URL. `sign` rejects a path containing `?`/`#` and the reserved param names
  `signature` and `expires`.

## Jamal

Jamal (`@jsails/jamal`, a regular dependency of the app) runs the local
backing services in development and deploys to one server in production: a TypeScript reimplementation of
Sail and single-host Kamal behind one config file. `jsails jamal` forwards to
the project's install; core never imports it.

- **One config file.** `jamal.config.ts` default-exports `defineJamal({...})`
  with base fields plus `local` (ports/app) and `production` (server/domain/
  onDemandTlsUrl/registry) overlays. Secrets are `SecretRef`s — a name only,
  never resolved or serialized.
- **Deploy executes by default.** `jamal deploy` runs a production release
  of the committed checkout (a dirty tree needs `--allow-dirty`); `--dry-run`
  prints the plan from a read-only look at the server and runs nothing.
  `rollback` runs the previous release again, with its own image digest and
  secrets file, and also previews with `--dry-run`.
- **Execution verbs** (`up`/`down`/`ps`/`logs`/`exec`) drive `docker compose`
  against `.jamal/compose.yml`, which `up` materializes; they are the verbs
  that run on Windows. Production execution provisions backing services
  (MariaDB/Postgres/Valkey accessory containers on the shared `jamal` Docker
  network), then builds and pushes the image tagged with the release id
  (`YYYYMMDDHHMMSS-<sha12>`) and reads back its registry digest. Holding the
  server's deploy lock, it observes what the server holds, reconciles it
  (the proxy's target is the truth), plans the release as data, and pulls the
  image by digest, runs, health-checks, and switches traffic to it.
- **The server is the record.** Each release writes an immutable
  `releases/<id>/manifest.json` (image digest, commit, pinned proxy images,
  secret names and digest) before its container starts, and the run
  compare-and-replaces `state.json` (live and previous release) under the
  lock. There is no local deploy history. The lock is a directory with an
  owner token and a sequence number; every mutating command a run sends is
  fenced by its token, so a run whose lock was force-released stops at its
  next command.
- **Domain routing** (`jamal domain add|list|remove`) controls kamal-proxy routing
  without a full redeploy. `jamal app <verb>` and `jamal accessory <verb>` manage
  app and backing-service lifecycle over ssh.
- **On-demand TLS** (`production.onDemandTlsUrl`) routes unknown hostnames and
  authorizes each at certificate-issuance time via an allowlist endpoint the
  app mounts (`createOnDemandTlsAllowlist` from `jsails/app`).
- **Image retention** — `jamal prune --keep <n>` plans which images to remove
  and runs nothing.
- **Cache proxy** — an opt-in, default-OFF Varnish reverse proxy between
  kamal-proxy and the app, toggled by `cacheProxy` in the config. The
  generated VCL is default-deny.

```mermaid
flowchart TB
    A["jamal.config.ts"] --> B["normalizeJamalConfig"]
    B --> C{"verb"}
    C -- up --> D["planLocal -> .jamal/compose.yml (services, optional dev app)"]
    D --> J["docker compose up -d --wait"]
    C -- deploy --> E["build -> push -> digest"]
    E --> K["lock -> observe -> reconcile -> planRelease"]
    K --> F{"--dry-run?"}
    F -- yes --> G["print the plan (no build, no lock)"]
    F -- no --> H["manifest -> pull by digest -> run -> health check -> switch -> state.json -> retire"]
```

### Broadcast: same-port, authenticated, default-deny

Broadcast mounts on the same HTTP server/port (`/_jsails/broadcast`), never a
second listener. The built-in Socket.IO adapter enforces a non-empty exact-match
origin allowlist, derives identity from server-side handshake data, and
default-denies channel authorization. A custom `BroadcastAdapter` is trusted
application code that owns all of these checks itself.

### Deploy tooling: hardening is human-run

Jamal never changes the server's firewall: the deploy guide carries a UFW
script that is **reviewed and run by a human**. No secret is baked into the
image or the plan. `createOnDemandTlsAllowlist` is fail-closed (200 only for an
allowlisted hostname, 403/400/405 otherwise) and never echoes hostnames. The
app owns that endpoint and must protect it — an over-permissive policy can have
certificates issued for unauthorized domains.

### Dependency audit

CI does **not** fail on `npm audit` advisories. Run `npm audit` yourself and
triage the findings. The dev toolchain uses Node's recursive `fs.watch` and
`Files.glob` uses `tinyglobby`, so the previous `nodemon`/`chokidar`/`braces`
chain is gone. `Files.glob` still interprets caller-supplied patterns — never
pass untrusted input as a glob pattern.

### Verification gaps

- No live external-service coverage in CI (the `integrations` job is env-gated).
- Windows is untested (the real end-to-end run is Linux only).
- OAuth, magic links, and two-factor authentication are plugin options the
  starter does not wire; registration, password reset, and email verification
  ship and are wired through the mail facade.
- Auth is authentication, not a policy engine: authorization is session-role
  checks plus app-owned callbacks.

## Next steps

- [Database](/docs/database) — entities, the portable schema, and migrations.
- [Extending JSails](/docs/extending) — the extension seam.
