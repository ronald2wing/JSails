# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - unreleased

The first public release.

### Added

- **Active Record data layer** — `jsails/models` authoring DSL
  (`ApplicationRecord` + `@jsails.*`), `BaseEntity`/`EntitySchema` over MariaDB
  (recommended), Postgres, MySQL, and SQLite; read-only in-memory
  `FileDataSource`; relations (IN-clause batch loading, EXISTS predicates,
  aggregates, through relations, polymorphic relations); attribute encryption;
  Active Storage; fixtures; entity validation; transactions with
  after-commit/after-rollback callbacks; composable query expressions.
- **Data contracts** — `jsails/data` (`defineData`, `defineDataList`,
  `DataValue`) with a strict Zod schema, lazy input/output JSON Schema, and
  `@jsails.data` JSON model columns that validate on insert/update and persist
  parsed defaults/transforms; `aiTool` projects the same contract to an AI tool
  with value-free argument/result errors.
- **Declarative schema reconciliation** — `jsails db:push` / `jsails db:diff`
  diff the model definitions against the live schema, classify operations as
  safe or destructive, apply safe plans atomically, and refuse a plan containing
  a destructive operation unless `--allow-destructive` is passed;
  `@jsails.renamedFrom` preserves renames; ordered idempotent data migrations
  run as phase 2.
- **HTTP and pages** — filesystem-routed pages with Preact SSR and static
  export, progressive streaming, route groups, nested layouts, optional
  catch-all routes, error boundaries, per-route and global middleware on
  Hono, strict default-deny authorization, CSRF/public-origin checks, security
  headers, ETag/compression, deep health checks, signed URLs, and
  content-hashed asset URLs.
- **API toolkit** — storage-agnostic resource handlers with allowlisted
  search, sort, and filter parsing handed to the store, offset-capped
  pagination, composable permissions, form parsing, deterministic OpenAPI,
  route manifests, version negotiation, nested serializers, and a browsable
  explorer.
- **Server components** — signed, stateless server components, server and local
  actions, nested components, form objects, lifecycle hooks, computed values,
  uploads, polling, render directives, redirects and downloads, URL binding,
  and an in-process test harness.
- **Client runtime** — Turbo navigation with explicitly registered Preact
  islands, Turbo Stream builders and morphing, before-navigation hooks, and
  Hotwire Native path configuration plus the bridge protocol.
- **Auth** — first-party Better Auth plugin (email/password, RFC 8628 device
  flow, registration, password reset, email verification, OAuth/social
  providers, magic links, optional two-factor authentication, and revocable API
  tokens), `AuthSessionService`, session roles, and database-backed sessions.
- **Starter presets** — five mutually exclusive scaffolds: a static site, an
  admin app, a blog CMS, a SaaS preset with opt-in tenancy/flags, and a CLI
  project. `jsails create` accepts local tarball overrides for every plugin
  dependency, and `verify:starter` installs and checks the admin, blog, and
  SaaS presets from packed workspace tarballs.
- **Editor.js editor** — every persisted rich-text block kind (paragraph,
  heading, list, quote, code, divider, image, gallery, embed, callout, and CTA)
  maps through the Editor.js adapter, with a block tool for the structured
  kinds, a Preact island, and the same allowlisted server renderer.
- **Blog CMS** — tenant-free posts, pages, categories, tags, menus, settings,
  revisions, a shared content repository, six admin CRUD resources, a
  disk-backed media library admin page with multipart upload/edit/delete, theme
  activation persisted through content settings, and a curated first-party
  plugin directory with search, categories, featured entries, and one-click
  install/update/rollback.
- **First-party plugins** — admin panel (CRUD resources, widgets, charts,
  actions, tabs, wizards, grouping, export helpers, relation managers), blog
  with an optional admin surface, admin plugin manager with per-plugin
  settings, live reactivity (service, change logs, Socket.IO transport, and
  publications that allowlist the columns a subscriber receives), mail,
  filesystem (disks, variants), notifications, cache and mutex stores with a
  request throttle, feature flags with A/B scopes and an optional admin page,
  diagnostics with watchers and an exporter seam,
  record-first logging, i18n catalogs with CLI extraction, AES-256-GCM
  encryption with key rotation, theme tokens, and the signal bus.
- **Jobs** — provider-neutral runtime over BullMQ with schedules and overlap
  control, per-job retry/discard policy, middleware, chains, batches
  (in-memory and shared coordinators), a failed-job store with tags and
  retention, metrics/wait-time/history, lifecycle events, and a dashboard.
- **Content and SEO** — Markdown collections, taxonomies, sections, versions,
  feeds, sitemap, blog helpers, page metadata/head tags, JSON-LD, robots.txt,
  and asset helpers.
- **AI and agent tooling** — `jsails mcp`, the developer MCP server (describe,
  routes, explain, schema tools; MCP 2026-07-28 with 2025 fallback, stdout kept
  for protocol messages, read-only annotated tools), and `jsails agents:setup`
  for project AGENTS.md, skills, and MCP config.
- **`@jsails/ai`** — a provider-neutral run loop: typed message parts, one
  streaming path for `run`, `generate`, and `countTokens`, tools via
  `defineTool` (Zod schema or data contract, `authorize`, `needsApproval`,
  per-tool deadlines, value-free error results), `generateObject`, budgets,
  usage and micro-USD cost, and `onStepFinish` checkpoints for resumable jobs.
  The server's trusted `history` is kept apart from the browser's `input`
  (`parseUserInput`), and approvals are bound to pending calls by id, name,
  input digest, and actor. Adapters: `@jsails/ai/anthropic` (verbatim replay
  of raw content, prompt caching) and `@jsails/ai/openai-compatible`, on
  optional SDK peers. `toEventStreamResponse` streams a run as ai.v1
  server-sent events with backpressure and heartbeats; `@jsails/ai/client`
  parses and reduces them in the browser; `@jsails/ai/testing` has fake and
  replay providers; `@jsails/ai/mcp` turns MCP server tools into run tools.
- **`@jsails/inertia`** — the Inertia v3 protocol, tested end to end against
  the official `@inertiajs/react` 3.11 client on `preact/compat` and React 19:
  prop descriptors (`always`, `optional`, `defer`, `merge`, `once`, `scroll`)
  resolved only when selected, protocol partial reloads, error bags, a strict
  serializer, `<script data-page>` documents, the version 409, v3 redirect
  rules, a sealed one-shot flash/errors cookie, Precognition, an Origin check
  in place of an XSRF cookie, in-process and HTTP SSR with client fallback, and
  `@jsails/inertia/testing`.
- **`@jsails/mcp`** — define MCP tools, resources, templates, and prompts with
  Zod or Standard Schema, each behind an access value your `authorize` gate
  answers with allow, hidden, or a scope challenge (hidden is
  indistinguishable from absent). Output schemas are enforced, failures are
  value-free (`McpToolFailure` for caller-readable ones), handlers get an abort
  signal, progress, and multi-round input with encrypted, bound request state.
  `serveMcpStdio` serves both protocol eras, `connectMcp` is a client for
  Streamable HTTP and stdio servers, and `connectInMemory` tests a server with
  the real client. Cancellation reaches the handler's signal on every
  transport and era: `notifications/cancelled` on stdio, closing the request's
  stream over HTTP (the 2026-07-28 cancellation, and the only one a stateless
  2025 request can receive), and `connectMcp` closes a cancelled 2025 HTTP
  call's stream as well as sending the notification, so a stateless server
  stops the work at once instead of at its deadline. It runs the official conformance suite 0.1.16
  (`JSAILS_MCP_CONFORMANCE=1`) against a ledger of known gaps that may only
  shrink. The Streamable HTTP endpoint is built and tested but mounts with the
  `mcp` plugin.
- **Tenancy domain** — `@jsails/tenancy` adds slug and hostname policy
  (`checkSlug`, `normalizeHostname`, `matchTenantHost`, `matchTenantPath`),
  code-defined roles with a reserved owner, the tenant status machine,
  hash-only single-use invitation tokens and escaped invitation messages,
  custom-domain verification by DNS TXT challenge, `parseTenantSettings` and
  `checkLimit`, and `TENANCY_ERROR_CODES`.
- **Plugins** — two-source enablement, a single `package.json#jsails`
  manifest per plugin (including its `autoload` symbols), build-time autoload
  projection with ambient types, marketplace discovery and
  install gates (SHA-256 checksum plus optional signature), managed state
  storage, and `activatePlugins`.
- **Jamal** — local Docker Compose and production deploy/rollback/status/logs/
  exec, app and accessory lifecycle verbs over ssh, domain routing, on-demand
  TLS allowlisting, an optional Varnish cache proxy, and pure registry/prune/
  audit/snapshot planners.
- **CLI** — `create` (default static `starter`, `--admin`, `--blog`, `--saas`,
  `--cli`; `--starter` selects the default explicitly), `dev`, `build`, `serve`,
  `db:push`, `db:diff`, `work`, `schedule`, `schedules`, `seed`, `queue`,
  `make:<page|api|job|model|command|server-component|serializer|middleware|content>`,
  `inspect`, `describe`, `explain`, `mcp`, `agents:setup`, `i18n:missing`,
  `app:shape`, `console`, `test`, `jamal`, `plugins`, and user-defined
  commands. Every command declares the config module
  it reads (`jsails.app.js`, `jsails.database.js`, `jsails.runtime.js`, or
  `jsails.seed.js`); `--config` overrides that module's path and a second module
  takes a qualified flag (`--app-config`, `--db-config`, `--runtime-config`).
- **Support toolkit** — `Str`, `Num`, `Time`, `Arr`, `Async`, `Encoding`, `Url`,
  and `Cryptography`, plus the server-only `Files`, `Media`, `Cookie`, and
  frontmatter/error helpers.
- **Runtime** — extension/service/contract system with documented override
  rules, facades backed by AsyncLocalStorage, the shared signal bus, interceptors,
  a deployment-generator registry, environment readers, the `.env` bootstrap
  (over `util.parseEnv`) with optional per-environment encrypted credentials
  (`jsails credentials edit|show`; the key is removed from `process.env` once
  loaded), system checks, seeders, and the in-process testing
  application.
- **Jamal local development** — `local.app` runs the app on the host, in a
  Sail-style dev container (project mounted, your user id, `node_modules` in a
  volume, `jsails dev` reloading on save), or from the project's Dockerfile.
  `jamal jsails|npm|npx|node|test|shell` run one command in the dev container.
  `jamal logs` and `jamal exec` always act locally; the deployed container is
  `jamal app logs`/`jamal app exec`.
- **Config management** — `@jsails/config` ships typed config sets
  (`defineConfig` with `text`/`integer`/`boolean`/`choice`/`json` fields), a
  memory or database (`jsails_config`) store, code overrides that win at
  runtime and show as "Set in code", a generated admin Configuration page
  (`@jsails/config/admin`), and the `config:export`/`config:import` commands
  that round-trip the active config through committed sync files, all or
  nothing. The blog's site settings moved onto it as the `blog.site` set
  (`blogSiteConfig`), replacing `defineBlogSettingsAdminPage`; the `--blog`
  starter wires it.
- **Model-backed API resources** — `@jsails/resources` ships
  `defineModelResource`: one explicit field allowlist yields the serializer,
  filter options, and a row-scoped store for the `jsails/api` handlers. Scope
  and `authorize` are required, sort/filter/search are opt-in per field, and
  write-only, encrypted, and JSON columns can never be queried. Following
  Django REST framework, `actions` picks the operations a resource serves
  (the rest answer `405`), and unique constraints the resource fills are
  validated before a write, so a duplicate is a `400`, including one from a
  concurrent writer that the database refuses. `isUniqueViolation` in
  `jsails/database` recognizes that refusal on every supported driver.
- **S3 storage** — `@jsails/filesystem` ships `S3Disk` over
  `@aws-sdk/client-s3` and `createDiskFromEnv()`, so generated apps switch
  between local and S3-compatible storage with `FILESYSTEM_DISK`.
- **Blog search** — Orama is the default engine; database search, Meilisearch,
  Typesense, and OpenSearch are selected through `SEARCH_DRIVER` and Jamal
  services. Jello Elementor is the default blog theme.
- **Development runtime** — `jsails dev` watches with Node's recursive
  `fs.watch` and restarts a plain serve child; `Files.glob` runs on
  `tinyglobby`.
- **Node 26** is the runtime floor: every workspace and generated starter
  requires `>=26.0.0`, and CI, Docker, and generated deployment workflows target
  it.
- **Packaging and layout** — every `@jsails/*` package lives under
  `packages/<name>/` in the monorepo and is released in lockstep with `jsails`;
  this changelog covers all of them. The database config module is
  `jsails.database.js` and the generated app script is `npm run db:push`
  (`scripts/db-push.mjs`); `jsails console` takes `--runtime-config`. Every
  framework error extends `JsailsError` and carries a snake_case `code`
  (`invalid_<thing>`, `missing_<thing>`, `unsupported_<thing>`, `not_found`,
  ...); CLI commands live under `core/src/cli/commands/`.

- **Config management** (see the entry above) also caches resolved values per
  set (`cacheTtlMs`, default 5 s) and serializes concurrent writes to one set.
- **Streaming rendering** — opt-in per app (`render: { stream: true }` in
  `jsails.app.js` or `createApp`) or per page (`export const stream`): the head and shell are sent first and each
  `Suspense` boundary follows as it resolves, with a deadline
  (`render.streamTimeoutMs`, default 30 s). A page with a public
  `cacheControl` is never streamed.
- **Not-found pages** — a `pages/**/not-found` module is the 404 page for its
  directory scope, served automatically by `createApp` and exported as
  `404.html`. Browser navigations get HTML error pages for 404/405/413/500
  (`errorPage` renderer, or a built-in page); API paths keep the JSON envelope.
- **Operations** — an `onError` hook (default: one stderr line with phase,
  route pattern, and request id); readiness probes (`readiness.probes`,
  extension `readiness`, built-in data source and Valkey probes from
  `jsails/app`) at `<healthPath>?deep=1`; graceful shutdown that drains
  in-flight requests; configurable server timeouts (`server` app-config key);
  an ambient request id (`currentRequestId()` from `jsails/app`) carried into
  request signals, error reports, and jobs; per-route body limits
  (`routeBodyLimit`, an API module's `maxBodyBytes`).
- **Request scopes** — `configureRequestScope((c, next) => ...)` on the
  extension context (`RequestScope` from `jsails/extensions`) runs once per
  request around pages, API routes, the server-components transport, and hook
  routes, after the session and before CSRF/authorize; managed plugins need the
  `http.scope` permission.
- **Plugin-owned tables** — a plugin's `schema.unmanagedTables`, or an
  `unmanagedTables` export from `jsails.database.js`, keeps tables another
  migrator owns out of `db:push`, `db:diff`, and `jsails test` planning.
  `@jsails/auth` declares Better Auth's tables, so `db:push` no longer plans to
  drop what `auth:migrate` created.
- **`@jsails.index()`** — a plain single-column index on a model field.
- **Nested server components keep their state** across a parent update: the
  client sends each child's signed snapshot and the server restores the ones
  that verify (bounded by the `MAX_NESTED_SNAPSHOT*` limits).
- **Tenant isolation** — `tenantScoped(column)` and `runWithTenant` /
  `runWithoutTenant` in `jsails/database` hold every query on a tenant-owned
  model to the ambient tenant: reads with no tenant return nothing, creates
  stamp the column, and a write cannot move a row to another tenant.
  `@jsails/tenancy` enforces active status and membership by default and runs
  each granted request inside the tenant through a request scope, so the tenant
  reaches every route kind. Every job attempt starts with no tenant; a job that
  works for one carries the id in its payload and calls `runWithTenant`. The
  `--saas` starter ships a tenant-scoped `Project` model.
- **Jobs** — finished jobs are trimmed by default; per-attempt timeouts abort
  `context.signal`; terminal failures (unknown job, invalid payload,
  `UnrecoverableJobError`) are not retried and are logged with a value-free
  summary; durable failed-job history (`failedJobs`, memory or database) with
  `jsails queue:failed`, `queue:retry`, and `queue:forget`; an in-process
  `MemoryJobsAdapter` and the `createFakeJobs` test recorder.
- **Storage** — signed URLs on the core `Disk` contract (`diskUrl`, `S3Disk.url`
  presigning GetObject, default 15 minutes, max 7 days) and streaming/ranged
  reads and capped streaming writes (`StreamingDisk`); `MediaLibrary.url` and
  the media admin `directUrls` option use them.
- **Mail and notifications** — `defineMail` Preact templates rendered to escaped
  HTML plus a text part; `Mail.queue` through jobs; a development-only preview
  at `/_jsails/mail`; pooled SMTP with bounded timeouts, several recipients,
  cc/bcc, and attachments; `defineNotification` with mail, database, and
  broadcast channels.
- **Auth** — the auth database can be MariaDB/MySQL, PostgreSQL, or SQLite;
  roles (`setUserRole`, `session.data.role`, `adminOnly`); `findUserByEmail`;
  credential endpoints throttled by default (normalized email and client
  address); a session cookie cache and pool sizing.
- **Webhooks** — pluggable signature schemes (`stripeVerifier`,
  `githubVerifier`, `slackVerifier`), secret rotation, and a replay guard keyed
  on the signed timestamp and body.

- **Un-awaited promises** — `detach(promise, report)` and `escalate`
  (`jsails/support`, also bare app globals) are the one sanctioned way to leave
  a promise un-awaited; every fire-and-forget promise in core and the
  first-party packages now goes through them or an explicit handler.
- **Regression, property, and hang helpers** (`jsails/testing`) —
  `auditCase`/`auditTitle` (attributed `<area>/<finding>` tests with bounded
  timeouts, `AuditTestError`), `settlesWithin` (`SettleTimeoutError`, code
  `not_settled`), `blackholeServer()` for client timeout tests, and
  `seededRandom`, `FIXED_SEEDS`, `testSeeds()` and `forEachSeed` for property
  tests replayable with `JSAILS_TEST_SEED`.
- **Windows for development** — core loads route, config, job and command
  modules from paths containing `#`, `?`, `%`, spaces, or drive letters;
  `jsails create --install` runs npm without a shell; the dev watcher
  normalizes separators once. `jsails serve` outside development/test and the
  server-facing `jamal` verbs refuse with `unsupported_platform`; `jamal up`,
  `down`, `logs`, `ps` and `exec` work.
- **Release gates** — an API report with stability tiers and the 1.0 inclusion
  criterion (a Versioning and Stability docs page with a generated table), a
  docs gate that compiles every sample in the docs, `AGENTS.md` and the starter
  guides against the built packages, and import-graph, footprint, bundle-size
  and per-request bench ratchets.

- **Request origin and client address.** `server.origin` is the app's public
  origin and the same-origin boundary for every cookie-authenticated check;
  `jsails serve` requires it outside development and test. `server.hosts`
  names further hosts (`*.example.com` is exactly one label), and with
  `server.origin` set any other Host is answered `421 Misdirected Request`
  before any other pipeline stage, except a GET or HEAD to the health or
  readiness path. `server.trustedProxies` (`'none'` by default, `{ hops }` or
  `{ cidrs }`, with `JSAILS_TRUSTED_PROXIES` as the environment fallback)
  decides who may speak for the client. Every request carries
  `context.client` (`{ via, ip, bucket }`, the bucket being the IPv4 address
  or IPv6 /64) and `context.origin`, resolved from the socket and trusted
  proxies only; `Forwarded`, `X-Real-IP` and `X-Forwarded-Host` are dropped
  and `X-Forwarded-For` is rewritten to the one resolved client.
- **Guarded outbound fetch.** `guardedFetch` and `createGuardedFetch` in
  `jsails/support/server` are the one outbound HTTP primitive: credential-free
  https only, each hop resolved once and connected only to an address it
  checked (loopback, link-local, private, CGNAT, unique-local and reserved
  addresses refused), every redirect re-checked, `maxBytes` and a whole-chain
  `timeoutMs` enforced, and value-free `GuardedFetchError` codes. Plugin bundle
  downloads use it.
- **Data engine (`@jsails/database`).** A SQL-level engine contract (lease,
  begin with savepoints, compile, close) over SQLite, MariaDB and PostgreSQL
  that renders every statement shape itself with all values bound; a spike
  showed TypeORM's QueryBuilder in table-name mode splices numbers and
  LIMIT/OFFSET as literals and drops RETURNING, so TypeORM is confined to
  `src/engine`. SQLite runs synchronously on `node:sqlite` with a writer lock,
  a shared WAL reader and busy retry. `resolveDatabaseConfig` is the
  `database()` options schema (secrets from the environment only). Errors are
  a value-free `DatabaseError` with driver-classified codes and a transient
  flag, and a query ledger records statements without parameter values. `pg`
  and `mysql2` are optional peers loaded only for their dialect; server floors
  are MariaDB 10.6, PostgreSQL 14 and SQLite 3.35, and MySQL is refused.
- **`.jsails` front end.** A tag-aware block scanner and an HTML-correct
  template parser: block content may start on its tag's line, nested
  `<template>`s are counted, script and style are raw text, text is literal
  (braces and `>` stay text), entities decode in text and every attribute,
  and `{{ }}` ends where oxc parses exactly one expression. Bindings are
  `:name`, events `@name.modifiers`, slots `#name`; `js-pre` subtrees are
  literal behind `<!-- prettier-ignore -->`. Whitespace follows Prettier's
  significance rules, with its display, white-space, implied-end-tag and
  entity tables pinned by tests to the installed Prettier, so formatting
  never changes rendered text. Every diagnostic is positioned, value-free and
  carries a stable `sfc.*` code, with a fix-it for every removed construct.
  The compiler gains a segment model (Verbatim, Alias and Atom spans, numbered
  like TypeScript 7.1's `SpanMapKind`) and column-accurate source maps that
  JSails composes with oxc's map itself, since rolldown ignores
  `typescript.inputMap`.
- **Plugin manifest v1.** One strict schema for the npm `jsails` field and a
  bundle's `manifest.json` (`checkPluginManifest`, `parsePackageManifest`,
  `parseBundleManifest`), a closed registry of 26 permissions with titles and
  risks (`PERMISSIONS`, `parsePermission`, `describePermission`; scoped forms
  such as `net.fetch:<host>` and `data.read:<Model>`, `JSAILS_` env names
  reserved), and a settings-schema subset (`parseSettingsSchema`,
  `validateSettings`, `describeSettings`) with value-free issues. A bundle may
  not declare commands, generators, autoload or env; `jsailsCompat` is one
  caret or tilde range, tilde for experimental plugins. Every first-party
  manifest is v1, checked by the `plugin-manifests` gate.
- **Typed jobs (`@jsails/jobs`).** `defineJob` returns a definition whose only
  operation is the inert `with(payload, options?)`, typed by its schema;
  `Jobs.dispatch` and `dispatchByName` snapshot and validate the payload,
  refuse unknown options (BullMQ names included), and cap delays at a year.
  Idempotency keys deduplicate per queue for a window (one day by default).
  `defineQueues` declares queues with concurrency and retention, and
  `createJobCatalog` refuses an undeclared queue at type and run time. Jobs
  travel in a versioned envelope (`JOB_ENVELOPE_VERSION` 1) whose wire shape
  is pinned per version; `memoryJobs()` is the in-process transport, and
  `setLongTimeout`/`setLongInterval` hold waits beyond 2^31-1 ms.

### Changed

- `jsails build:meta`, `inject:auto-imports`, and `test` parse their flags
  strictly: `--help` prints the command's usage instead of running it, and an
  unknown flag, a flag without its value, or a positional argument is a usage
  error (exit 2) instead of being ignored.
- **Starters are developer mode.** Every preset loads plugins only from code
  and `jsails.plugins.lock`; none sets `plugins.managed`, ships the plugin
  manager, or lists `pluginStateEntities`. The generated `jamal.config.ts` sets
  `JSAILS_TRUSTED_PROXIES: 'hops=1'`, `auth/README.md` teaches the same first run as
  the guide, and the static starter ignores `config/credentials/*.key`.
- **Admin is default-deny.** Resources, pages, and row/bulk actions without
  their own `authorize` are served to no one, and dashboard links hide what a
  session may not list. `withAdminAuthorize(plugin, gate)` gates a plugin's
  contributions; `configAdmin`, `flagsAdmin`, `blogAdmin`, `blogThemeAdmin`,
  the blog menus/revisions pages, `mediaAdmin`, and `jobsAdmin` take an
  `authorize` option.
- **Plugin state is written per entry.** `PluginStateSource` requires
  `putEntry(id, entry)` and `removeEntry(id)`, and `save(state)` never deletes
  an omitted entry. `jsails plugins enable`/`disable`/`rollback` write only the
  named plugin; `jsails plugins import` merges. Bundles must hold exactly one
  root `manifest.json` (`multiple_manifests`, `manifest_missing`) and are stored
  at `<pluginsDir>/<id>/<version>/`; a manifest whose id or version differs
  from its directory is skipped (`bundle_mismatch`), and earlier
  `<id>/<version>/package/` installs need reinstalling.
- **Jobs.** The default queue key prefix is `<package name>:<NODE_ENV>` (it was
  `bull`). `FailedJobHistory` requires `take(id)` and `restore(entry)`;
  `queue:retry` claims an entry before dispatching it and replays its recorded
  options; `retryFailedJob` resolves `{ status }`. The failed-job table gains
  `dispatchOptions` and `membership` columns (run `db:push`). An attempt
  aborted at shutdown is requeued without spending an attempt
  (`isJobAttemptInterrupted`). `jsails work` no longer prunes schedules; only
  `jsails schedule` does.
- **Data.** Row hooks no longer run for query-builder updates and deletes;
  `beforeBulkUpdate`/`afterBulkUpdate` receive the SET map, and entity
  validation and `@jsails.data` contracts check it column by column. Counter
  caches and `touch` follow `save()`/`remove()` only and skip the parent's
  hooks. `autosave` and `nestedAttributes` read the instance being saved.
  TypeORM's query result `cache` is rejected. A transactional data migration's
  `up` is the ambient `transaction()` scope, so model calls inside it join its
  transaction on every driver.
- **SQLite connection lease.** `JsailsDataSource` on `sqljs` hands its single
  connection out as a lease: a transaction holds it from `BEGIN` to the end and
  other work queues in arrival order, so a rollback no longer discards another
  unit of work's rows.
- **Request pipeline.** `cacheControl` applies only to cacheable statuses for
  requests without a session or `Authorization`; the page-props cache is
  bypassed for those requests and under a tenant, and keys on the host. A page
  `stream` producer keeps the request's async context. `Vary` is appended, not
  replaced. `?v=` is `immutable` only when it is the current content hash. A
  raised route body cap applies only to bodies with `Content-Length`.
  `Response.redirect()` and proxied `fetch()` responses are accepted, and
  streamed responses are sent as produced.
- **Build.** A function-level `'use server'` is a build error (use a module
  whose first statement is `'use server'`).
  Routes load by file URL, so app paths with `#` or `%` work. `jsails dev`
  regenerates a stale `.jsails/` and re-runs `build:meta` on source changes.
  Bare `and`, `or`, and `when` resolve to the query builders. `create` prints
  the first run in an order that works.
- **Credentials.** `credentials regenerate` seals only the keys the target
  environment's `.env` files define, refuses to replace what the current key
  cannot decrypt, and keeps the old pair as `<env>.previous.*`. A missing key
  stops every command outside development and test (`missing_key`). `.env` and
  credentials may not define `NODE_ENV` or the credentials variables.
- **Auth.** `loadAuthMigrations()` always builds an instance of its own and the
  plan carries its `dispose()` (`OwnedAuthMigrations` is gone); the starter's
  `auth:migrate` and `user:create` release their pools instead of calling
  `process.exit`. `magicLink` and `twoFactor` take an options object only, the
  `clientAddress` option is replaced by `JSAILS_TRUSTED_PROXIES` /
  `trustedProxies`, and better-auth is pinned to 1.7.12.
- **Live.** A publication over a `tenantScoped` model fails with
  `unsupported_tenant_scope`; names over 128 characters are rejected; a resume
  ahead of the change log is answered with a snapshot; a failed change-log
  append is reported to `onError` and skipped.
- **Content.** Editor.js list v2 items are saved, and a form submit waits for
  the editor's current content. A media `type/*` entry matches only that type.
  `LocalDisk.putStream` rejects with `io_failed` instead of crashing.
- **AI, Inertia, and MCP surfaces replaced.** `@jsails/ai` drops
  `createAiRuntime`, `createHttpTransport`, `createMcpTransport`, `aiTool`, and
  the `temperature` option; `run`/`generate` take only a string or a
  `parseUserInput` result as input. `@jsails/inertia` drops
  `createInertiaPage`, `renderInertiaPage`, `resolveInertiaProps`,
  `mergeSharedProps`, `resolveDeferredProps`, `resolveErrorBag`, and
  `errorsFor` (use `defineInertia`/`resolveInertia`, `buildInertiaPage`,
  `serializePage`, `buildDocument`, `shapeErrorBags`) and embeds the page in a
  JSON script block instead of a `data-page` attribute. `jsails/mcp` exports
  only the developer server (`runJsailsDevMcp`); `createMcpServer`,
  `createInProcessMcpClient`, the tool registry, and the tool singletons are
  gone in favour of `@jsails/mcp`.
- **jamal.** App containers run with `NODE_ENV=production`; env-file values are
  written verbatim, and a value Docker cannot read fails the deploy naming only
  its key; remote files are verified by size and SHA-256 before they replace
  the old one; a deploy releases only the lock it holds; `deploy` refuses a
  project without a Dockerfile.

- **Owned tables on MariaDB.** Stores built on owned tables (flags,
  sessions, config, notifications, plugin state, blog, media) no longer crash on
  their first call when the app connects to MariaDB as a user without global
  privileges: the table probe is one parameterized query over the owned names
  instead of TypeORM's whole-server introspection.

- **Static export and symlinked layouts.** `generateStaticSite` takes `root`
  (default: the working directory; `Application.build` and `jsails build` pass
  the app's `rootDir`). The root and its parents may be symlinks, as macOS's
  `/var` -> `/private/var` and symlinked home directories are; any other
  symlink on the way to `outDir` is still refused. Builds under a temporary
  directory on macOS no longer fail.
- **jamal verbs.** An unknown verb is a usage error (exit 2) on every platform,
  and a verb spelling an `Object.prototype` member (`jamal constructor`) is
  rejected as unknown instead of reaching the generator flow.

- **Request origin replaces per-feature origins.** The top-level
  `publicOrigin` key is removed (use `server.origin`), and the bare count
  `JSAILS_TRUSTED_PROXIES=1` is now `hops=1`. `@jsails/auth` rate limits key on
  the resolved client, and its `trustedProxies` option and the exports
  `resolveClientAddress`, `parseTrustedProxies`, `clientAddressKey`,
  `socketAddress`, `TRUSTED_PROXIES_ENV` and `CLIENT_ADDRESS_HEADER` are
  removed. `@jsails/admin` and `@jsails/blog` same-origin checks use the
  resolved origin, and the `@jsails/mail` preview's loopback gate refuses
  relayed requests.
- **Plugin installer fetch.** `createPluginInstaller`'s `fetch` option is a
  `GuardedFetch`; `lookupHost`, `PluginFetch`, `HostLookup` and
  `InstallPluginInput.validateUrl` are removed, `allowedHosts` entries must be
  bare host names, and a bundle is fetched over plain http only from a
  loopback host with `allowPrivateHosts`.
- **Component authoring.** The `// #region` component dialect, the TSX
  multi-file component layout (`make:server-component --mfc`),
  `convert:component`, `compilerPlugin` in `jsails/build` and the web
  starters, `live:list` and the `@jsails/signals` package are removed;
  `UPGRADING.md` lists each with its replacement. `.jsails` single-file
  components stay and become the default authoring format, with a folder
  layout of the same component to follow. A `<script>` block requires
  `lang="ts"`, `<server>` blocks give way to a `.server.ts` module, and the
  magic config exports (`stateSchema`, `authorize`, `actions`, ...) move into
  `defineLive({...})`.
- **Jamal is its own package.** `@jsails/jamal` (installed as a regular
  dependency by the `--admin`, `--saas` and `--blog` starters, because a
  deploy runs from a production install) provides local services in
  development and single-host production deploys through the
  `jamal` bin, and `jsails jamal` forwards to it. Jamal is single-host and
  reads `jamal.config.ts` (`defineJamal`, `secret`). The `jsails/deploy` and
  `jsails/jamal` subpaths, the static-host generators, the deployment
  registry, the ONCE preset, the hardening generator, the `deployments`
  config key and `jamal deploy --target`, `dev`, `harden`, `targets`,
  `registry`, `audit` and `snapshot` are removed; the deploy guide covers
  static hosts, hardening and database dumps. `createOnDemandTlsAllowlist`
  moves to `jsails/app`, since the endpoint runs in the production app.
  On Windows the local-service verbs run and the server verbs refuse with
  `unsupported_platform`.
- **Plugin snapshots.** `exportPluginSnapshot(state)` no longer takes a plugins
  directory, entries carry no `checksum`, `SnapshotFs` is `{ existsSync }`, and
  `checksums`/`signature` are no longer manifest fields.

### Security

- Plugin bundle downloads can no longer be moved to a private address by DNS
  rebinding: the connection goes only to the address that was checked.
- MariaDB parameters are written by the data engine as hexadecimal string
  literals and plain digits, so no `sql_mode` (including
  `NO_BACKSLASH_ESCAPES`) can turn a bound value into SQL, and a transaction
  the server ended fails every later statement with `transaction_aborted`
  instead of continuing in autocommit.
- Forwarded headers no longer reach rate-limit keys or same-origin checks
  unless `server.trustedProxies` trusts the hop they came from.
- Model queries no longer reuse bound-parameter names across `where()` calls,
  which could let a later filter replace a scope or tenant filter.
- Deterministic attribute encryption writes a v2 format whose IV is a keyed
  HMAC of the plaintext; v1 values still decrypt, so re-encrypt existing rows.
  `@jsails.encrypts` fields are no longer encrypted twice on a second save.
- Plugin bundles need a checksum or verified signature (`allowUnverified` /
  `--allow-unverified` opts out with a warning); only the recorded active
  version loads; manifest permissions are enforced; downloads check every
  redirect hop. The admin plugin manager is default-deny (`authorize`,
  `authorizeInstall`), its raw URL form is off by default, and first-party
  directory entries carry release-written SHA-256 digests.
- `'use server'` modules stub every export shape for the client or fail the
  build; client source maps never embed stripped server code.
- `@jsails/auth`: bearer and API tokens never reach the Better Auth router,
  logout, or device approval; header-credential sessions do not slide their
  expiry; a password reset revokes every session and token; a custom
  `createAuth` more open than the plugin policy is refused.
- `@jsails/blog`: `POST /blog/posts` is mounted only with `createRoute:
  { authorize }`; slugs, menu hrefs, theme tokens, and feed URLs are validated.
- `@jsails/admin`: actions go through the resource `authorize` gate; uploads are
  validated, size-capped, byte-sniffed, and stored under collision-free keys;
  relation create/attach/detach authorize the relationship; CSRF origin checks
  honor `publicOrigin`.
- Server components: uploads need an explicit opt-in and are quota-bound and
  authorized before the body is read; snapshots have an absolute lifetime and
  key rotation; tokens must be canonical; `defineForm.fill()` keeps only
  declared fields.
- Broadcast and live: subscribes are rate-limited and queues bounded; channel
  authorization is revalidated; the live Socket.IO transport resolves the
  session user.
- `HmacUrlSigner.verify` returns `{ path, params }` and refuses repeated keys
  and malformed escapes (breaking for callers that used the old return value);
  the page-props cache key includes the locale and a full query digest;
  `readForm` treats `__proto__`/`constructor` as ordinary keys; a thrown
  non-Error value gets the value-free 500.
- `@jsails/sessions` stores a SHA-256 of the session id and no CSRF token;
  `@jsails/cache` and the job overlap lock use owner-token leases; the memory
  cache bounds rate-limit counters; logs escape control characters and redact
  secret-looking keys; diagnostics record route patterns, not raw paths.
- Starters fail closed: admin access needs an admin role, the plugin manager is
  admin-only, the SaaS tenant resolver no longer trusts a client header, and
  deploy config sets the public origin so session cookies are `Secure`.
- jamal production: remote arguments are shell-quoted; secrets travel in env
  files, never on the command line; containers share a network with a restart
  policy; health checks can fail and release the deploy lock.
- Unsafe requests without a session are origin-checked (`origin_mismatch`); a
  request with no `Origin`, `Sec-Fetch-Site`, or `Referer` passes only without a
  `Cookie`. `jsails/plugin-sdk` exports `requestSite`, `checkRequestOrigin`, and
  `isUnsafeMethod`.
- `@jsails/auth` throttles every credential path (magic link, reset, two-factor,
  email OTP) whether or not the body parses, counts current-password endpoints
  against the login limiter, keys IPv6 clients on their /64, and does not store
  denied attempts. It refuses every user creation while registration is closed
  (magic link, email OTP, and social sign-in included), answers 404 for the
  session-listing and revocation endpoints, and strips session tokens from
  Better Auth responses.
- `@jsails/admin` rejects bearer and API-token sessions; relation managers and
  relation columns consult the related resource's `authorize`, and delete
  buttons are decided per row.
- `@jsails/tenancy` reads the session user only from `data.user.id`.
- The plugin installer refuses download URLs and redirects that resolve to
  loopback, private, link-local, CGNAT, unique-local, multicast, documentation,
  or reserved addresses (`private_address`); `allowPrivateHosts` lifts it for an
  operator installer, which `jsails plugins install` is. It does not pin the
  resolved address, so DNS rebinding is not covered. Failed downloads cancel
  their body.
- Encrypted columns are encrypted on `Model.update()` too, and every written
  value is treated as plaintext, so a submitted ciphertext is sealed again
  rather than shown back decrypted.
- `jsails test` asks the server which database it is connected to and refuses
  unless it is a test database, and refuses a non-test `NODE_ENV`.
- Server-component downloads are served only while the component exists and
  its `authorize` admits the request; uploads have idle (30 s) and total
  (5 min) deadlines, two per subject, and anonymous uploads need an explicit
  quota.
- Live revalidation disconnects a socket whose user claims changed and re-runs
  `authorize` for every subscription; the Socket.IO transport checks
  `allowedOrigins` before the upgrade, caps inbound frames, and rate-limits
  inbound events.
- `SmtpMailTransport` requires STARTTLS off loopback and disables file and URL
  access; the mail preview answers loopback peers without forwarding headers
  only. Media admin downloads carry `nosniff` and a sandboxing CSP.
- `DiskUploadStore.open` opens the file before returning its stream, so an
  upload removed between the lookup and the read (a retention sweep, a
  concurrent delete) is reported as absent instead of crashing the process with
  an unhandled `ENOENT`.
- `LocalDisk.get` and `LocalDisk.stream` read through a descriptor opened with
  `O_NOFOLLOW` whose device and inode must match the file the containment check
  approved, so a file swapped for a symlink or another file between the check
  and the read is refused as `not_found` instead of read from outside the root.

### Performance

- CLI and server start no longer load the `date-fns` barrel (about 1.1 s).
- A CLI start costs what the chosen command needs: the bin loads the command
  table and argument parsing, then that command alone. `jsails --help` loads
  23 modules instead of 126 and a usage error 15, neither loading Zod; a
  command's own `--help` loads no implementation (`plugins --help` 28 instead
  of 769, `console --help` 20 instead of 782). Reading the app config loads
  Zod and nothing else (no HTTP server, head renderer, or Node server
  adapter), so `inspect`, `describe`, `explain`, `app:shape`, `i18n:missing`,
  `plugins list`, and project commands load about 150 modules instead of 370;
  the application loads only when one is assembled, and `db:diff` without an
  app config loads no config at all. Resolving plugin enablement no longer
  loads the database-backed state store, so `jsails/app` loads 410 modules
  instead of 737 and no TypeORM, `jsails serve` of an app without a database
  reaches its first request with 422 modules instead of 798, and `jsails build`
  loads 422 instead of 799. `jsails mcp` answers its first `tools/list` with
  131 modules instead of 389. The import-graph gate holds a ceiling for each
  representative invocation.
- Sessions resolve lazily once per request; static files and health probes do
  no lookup. Public files answer conditional GETs with a 304 without opening
  the file (fixes a descriptor leak) and serve fresh `.br`/`.gz` siblings;
  dynamic responses use brotli when preferred; ETags skip `no-store`, large,
  and streamed responses.
- Page and layout modules are imported once; static export renders with
  bounded concurrency and writes as it goes; eager loads chunk IN lists.
- The blog's public routes query only the page they show; the media admin is
  paged; live replaces its global write fence with per-entity snapshot buffers.
- The workspace runner builds and tests independent workspaces in parallel;
  `npm run bench` reports start-up and throughput.

### Known limits

- The portable schema subset rejects partial/expression/fulltext/spatial
  indexes, database enums, generated/computed columns, and function defaults;
  SQLite `alter_column` is destructive (table recreate), and there is no
  automatic rollback — destructive changes are refused and backups remain the
  operator's responsibility.
- Data migrations have no ledger: they run on every `db:push` and must be
  idempotent. `down` is a manual escape hatch, not a CLI command.
- Live MariaDB/Valkey/Docker coverage is opt-in via `jsails test`,
  `verify:starter`, and `verify:integrations`; the default `check` suite runs in
  process.
- Server-component state is signed but public: there is no exactly-once
  processing, replay prevention, or database rollback, so actions must be
  idempotent.
- A custom broadcast transport needs its own client; the shipped browser client
  is Socket.IO-specific.
- On-demand TLS is the application's allow policy: it owns the authorization
  endpoint.
- Auth is authentication, not a policy engine: role checks are session-based.
- `@jsails/mcp` serves no logging, resource subscriptions, sampling, or
  stateful SSE sessions, cannot ask for input over stateless HTTP, cannot
  route a 2025 `notifications/cancelled` over stateless HTTP (a 2025 client
  that sends it without closing the request's stream, as the official SDK
  client does, leaves the handler running until it disconnects or the
  deadline passes), has no
  per-tool rate limit yet, and its client has no OAuth authorization flow
  (bearer headers only). A sealed request state can be replayed for the same
  call until it expires. The official suite's 2026-07-28 scenarios do not exist
  in 0.1.16, so that revision is covered by the package's own spec vectors and
  the official client.
- `@jsails/inertia` client code that uses Inertia's types must compile with
  `moduleResolution: bundler`, because `@inertiajs/core` 3.11 re-exports its
  types through extensionless paths.
- Windows teardown is covered by simulated protocol tests only, and the Varnish
  VCL is verified by construction rather than a live `varnish -C` compile.
- Windows and macOS are verified only by their CI legs; their first runs
  record platform failures in the expected-failure ledgers. Today's known
  defects (request handling, data layer, security holes, marketplace, jobs,
  content) are executable tests listed in `scripts/expected-failures/`, each
  naming the work package that fixes it.
