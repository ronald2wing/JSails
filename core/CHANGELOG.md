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
  Hono, a declared access on every surface, an exact-Origin cross-site check, security
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
- **Rich-text editor** — `@jsails/editor` is a ProseMirror editor whose schema
  is generated from the rich-text model, so it cannot hold a value the model
  refuses: a toolbar with roving focus, an Insert menu, a link dialog checked
  with `isLinkHref`, task checkboxes, attribute controls for image, gallery,
  embed, call-to-action, callout, quote and code blocks, a keyboard map, and
  ARIA roles throughout (`mountRichTextEditor`, `RichTextEditor`). The
  `rich-text` island hydrates the field markup of `RichTextField`
  (`@jsails/editor/server`) and of admin `richText` fields with a three-state
  form contract: the server's source input round-trips the stored bytes until
  the editor is mounted, the mounted editor sets the field on the form's
  `formdata` event, and a stored value `parseRichText` refuses is a read-only
  issues panel with no field until an explicit "discard and start empty"; the
  same allowlisted server renderer. The island is a small shell that loads
  the editor with `import()` when a field hydrates, so a page without an
  editor does not download it, and the editor adopts its own stylesheets
  (ProseMirror's required `white-space`, and a zero-specificity layout).
  The starters' Vite configs set `preserveEntrySignatures: 'strict'`, so no
  lazy chunk imports the `app.js?v=` entry under a second URL.
- **Blog CMS** — tenant-free posts, pages, categories, tags, menus, settings,
  revisions, a shared content repository, six admin CRUD resources, a
  disk-backed media library admin page with multipart upload/edit/delete, and
  theme activation persisted through content settings.
- **First-party plugins** — admin panel (CRUD resources, widgets, charts,
  actions, tabs, wizards, grouping, export helpers, relation managers), blog
  with an optional admin surface, live reactivity (service, change logs, Socket.IO transport, and
  publications that allowlist the columns a subscriber receives), mail,
  filesystem (disks, variants), notifications, cache and lease stores with a
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
- **Plugins** — a single `package.json#jsails` manifest per plugin, plugin
  package discovery with its framework-version check (`jsails plugins
  list|check`), and the permission registry and capability gate a marketplace
  plugin source builds on.
- **Jamal** — local Docker Compose and production deploy/rollback/status/logs/
  exec, app and accessory lifecycle verbs over ssh, domain routing, on-demand
  TLS allowlisting, an optional Varnish cache proxy, and pure registry/prune/
  audit/snapshot planners.
- **CLI** — `create` (default static `starter`, `--admin`, `--blog`, `--saas`,
  `--cli`; `--starter` selects the default explicitly), `dev`, `build`, `serve`,
  `db:push`, `db:diff`, `work`, `schedule`, `schedules`, `seed`, `queue`,
  `make:<page|api|job|model|command|server-component|serializer|middleware|content>`,
  `inspect`, `describe`, `explain`, `mcp`, `agents:setup`, `i18n:missing`,
  `app:shape`, `console`, `test`, `jamal`, `plugins`, and the commands of the
  app (`commands/`) and of its dependencies (`jsails.commands`). Every command declares the config module
  it reads (`jsails.app.js`, `jsails.database.js`, `jsails.runtime.js`, or
  `jsails.seed.js`); `--config` overrides that module's path and a second module
  takes a qualified flag (`--app-config`, `--db-config`, `--runtime-config`).
- **Support toolkit** — `Str`, `Num`, `Time`, `Arr`, `Async`, `Encoding`, `Url`,
  and `Cryptography`, plus the server-only `Files`, `Media`, `Cookie`, and
  frontmatter/error helpers.
- **Runtime** — extension/service/contract system with documented override
  rules, facades backed by AsyncLocalStorage, the shared signal bus, interceptors,
  a deployment-generator registry, environment readers, environment
  resolution with optional per-environment sealed credentials (see
  "Environment resolution" below), system checks, seeders, and the in-process
  testing application.
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

- **Config management** (see the entry above) also serializes concurrent
  writes to one set.
- **Streaming rendering** — opt-in per app (`render: { stream: true }` in
  `jsails.app.js` or `createApp`) or per page (`export const stream`): the head and shell are sent first and each
  `Suspense` boundary follows as it resolves, with a deadline
  (`render.streamTimeoutMs`, default 30 s). A page with a public
  `cacheControl` is never streamed.
- **Not-found pages** — a `pages/**/not-found` module is the 404 page for its
  directory scope, served automatically by `createApp` and exported as
  `404.html`. Browser navigations get HTML error pages for 404/405/413/500
  (`errorPage` renderer, or a built-in page); API paths keep the problem envelope.
- **Operations** — an `onError` hook (default: one stderr line with phase,
  route pattern, and request id); readiness probes (`readiness.probes`,
  extension `readiness`, built-in data source and Valkey probes from
  `jsails/app`) at `<healthPath>?deep=1`; graceful shutdown that drains
  in-flight requests, live streams and serve-hook drain participants under one
  deadline (see Changed); configurable server timeouts (`server` app-config key);
  an ambient request id (`currentContext()?.requestId` from `jsails/context`)
  carried into request signals, error reports, and jobs; declared request
  bodies (`body: { kind, maxBytes }`, read through `ctx.body`) and handler
  deadlines (`timeoutMs`, `server.handlerTimeoutMs`).
- **Streaming multipart** — a route declares `body: { kind: 'multipart',
  maxBytes, parts }` (`MultipartSpec`: `maxParts`, `maxFieldBytes`,
  `maxHeaderBytes`, `files` with each file field's `maxBytes`, `maxCount` and
  `contentTypes`, `idleMs`) and reads `ctx.body.multipart()`, an async
  iterable of the body's parts in wire order: text fields whole, files as
  streams read straight from the request, so a file piped to a disk holds
  one chunk in memory at a time, whatever its size. Every limit is enforced as the bytes arrive; a
  part past its limit errors its stream and answers the request 413 whatever
  the handler does, a file in an undeclared field or of an unaccepted media
  type is a 422, and a body that stops arriving for `idleMs` (default 30 s),
  or outlives the route's deadline, is cut off and released. The route's row
  holds the parts canonical (every default stated, file fields by name, media
  types sorted and distinct), so two declarations with the same effect show
  the same row, and `api/routes.md` lists them.
  `MultipartErrors` (`multipart.*`) is exported from `jsails` and
  `jsails/app`, the part and spec types from `jsails/api` as well.
- **Request frame** — every request gets one immutable `RequestFrame`
  (`c.var.frame`, `currentRequestFrame()` from `jsails`): its id, resolved
  origin and client, and one execution context, so a request costs one
  `AsyncLocalStorage` run. Nothing about who is asking resolves until a route
  claims the request: pages, API routes, the server-components transport,
  introspection, hook routes, and the app's error page claim it once, which
  resolves the identity, the locale (`LocaleDecision`), and the extension
  request scopes; handlers read the route's `RequestContext` from
  `c.var.frame.requestContext()`. A public file, a probe, or a JSON 404
  resolves none of them.
- **Request scopes** — `configureRequestScope({ name, cache, resolve })` on the
  extension context (`RequestScopeSpec` from `jsails/extensions`) resolves once
  per request, when a route claims it, to a binding (`{ run, partition? }`), a
  `Response`, or nothing; the route, its error page, and its late streaming
  failures run inside the binding. `cache` (`partition`, `private`,
  `transparent`) states how the scope affects a cached response, and a binding
  that breaks it fails with `request_scope.invalid_binding`. Managed plugins
  need the `http.scope` permission. `@jsails/tenancy` names the tenant as a
  cache partition read from `tenantSource` (`subdomainTenantResolver` declares
  `host`).
- **Guards** — `http: { guards }` in the app config, `createApp({ guards })`,
  and `configureGuard` on the extension context (permission `http.guard`) run
  for every request before public files, the 405 answer, routes, and cached
  pages; the first `Response` refuses the request (a
  fetched answer with immutable headers included), and a throw fails it
  value-free (phase `guard`). A `GET` or `HEAD` of the health or readiness
  path passes unguarded, so a deploy tool's credential-free probe still sees
  the app.
- **Identity source** — `identity` in the app config and
  `createApp({ identity })` take an `IdentitySource` (`hasCredential`,
  `resolve`); `identitySource({ cookies, headers, resolve })` from `jsails`
  builds one from the credential names its resolver reads, so a request
  carrying none of them never reaches the session store. A bare
  `resolveSession` declares nothing and runs for every claimed request. A
  failure before the request frame exists is answered value-free and reported
  with phase `frame`.
- **Plugin-owned tables** — a plugin's `schema.unmanagedTables`, or an
  `unmanagedTables` export from `jsails.database.js`, keeps tables another
  migrator owns out of `db:push`, `db:diff`, and `jsails test` planning.
  `@jsails/auth` declares Better Auth's tables, so `db:push` no longer plans to
  drop what `auth:migrate` created.
- **`@jsails.index()`** — a plain single-column index on a model field.
- **Server-component update protocol v2.** A request states what the client
  holds (`have.render`, the render tag of its DOM, and `have.slots`, its nested
  children by `(slot, component)`), and a reply is one of `unchanged`,
  `render` (with `effects.redirect`, `effects.download`, `effects.refresh`),
  `invalid`, `error`, or `protocol_mismatch` (the browser reloads once). An
  idle poll is answered `unchanged` in a few dozen bytes and the token is
  re-signed only when the state changed or its lifetime needs renewing
  (`ComponentSigner.renewalDue`), so the presented token comes back byte for
  byte. A nested child the client holds is kept by reference: it is
  authorized, never executed, and its DOM, controller, values, and errors stay
  untouched; a denied child renders nothing; a parent action asks for a kept
  child's refresh with `context.refreshChild(key)` / `refreshChildren()`. The
  types live in `jsails/server-components` (`ComponentUpdateRequest`,
  `ComponentUpdateResponse`); `have.slots` is capped at `MAX_HAVE_SLOTS_BYTES`
  (32 KiB, `too_many_children`). Child-snapshot restore, the token
  `revision`, `RestoreOffer`, and the `MAX_NESTED_SNAPSHOT*` limits are gone.
- **Server-component triggers before hydration.** `submit()` renders its form
  `method="dialog"`, so a bound form submits nowhere until the client runs, and
  the render fails closed (`invalid_definition`) when a bound form overrides
  that method or sets an `action`, or when a `formaction` / non-dialog
  `formmethod` submitter is anywhere but inside an unbound form of the same
  render (a `form` attribute, a nested child, or no enclosing form could give
  it a bound owner); a root is checked with its children in place. The
  client entry installs one capturing `click`/`submit` listener before it
  awaits anything: every component trigger has its default prevented at once
  in the capture phase, is dispatched when its event bubbles back to the
  document (so a listener below that stops it, such as a form-level submit
  guard, vetoes it; `.capture` dispatches in the capture phase), and is held
  (up to 16, in order) until the bindings mount, then replayed; a trigger
  whose element left the page is dropped. A submit builds the form's
  `FormData` (firing `formdata`), and a bound element that is not a native
  control (a widget host, which may itself be an island) contributes the single
  string entry its widget wrote under its `data-jsails-model` name.
- **Shared poll loop.** Server-component and island polls run one loop:
  delays jittered by ±10%, paused while hidden or offline by default with one
  catch-up refresh on return when a tick came due, exponential backoff after
  failures (capped at 5 minutes), and at least the `Retry-After` a 429 or 503
  named; `intervalMs` is at most `MAX_POLL_INTERVAL_MS` (one day), so no
  delay overflows a browser timer. A 429 is a retryable `rate_limited`
  controller error, and a 429 or 503 carries `retryAfterMs`. A refresh outside
  a poll is still retried twice in the controller's queue, after at least a
  `Retry-After` of up to 5 s (a longer one is left to the caller); a poll's
  refresh is never retried there, since the loop owns its backoff.
- **Tenant isolation** — `tenantScoped(column)` and `runWithTenant` /
  `runWithoutTenant` in `jsails/database` hold every query on a tenant-owned
  model to the ambient tenant: reads with no tenant return nothing, creates
  stamp the column, and a write cannot move a row to another tenant.
  `@jsails/tenancy` enforces active status and membership by default and runs
  each granted request inside the tenant through a request scope, so the tenant
  reaches every route kind. A job runs in the tenant its dispatch carried
  (never a switched-off `withoutTenantScope`); a job dispatched outside a
  tenant starts with none. The `--saas` starter ships a tenant-scoped
  `Project` model.
- **Jobs** — finished jobs are trimmed by default; per-attempt timeouts abort
  `context.signal`; terminal failures (unknown job, invalid payload,
  `UnrecoverableJobError`) are not retried and are logged with a value-free
  summary; durable failed-job history (`failedJobs`, memory or database) with
  `jsails queue:failed`, `queue:retry`, and `queue:forget`; an in-process
  `MemoryJobsAdapter` and the `createFakeJobs` test recorder.
- **Storage** — one streaming contract,
  `write`/`read`/`stat`/`delete`/`deletePrefix`/`list`, where every write
  takes a required `maxBytes` and returns `{ size, sha256 }`.
  `jsails/filesystem` adds `readBytes`/`readText`, `meterByteSource`, the disk
  key rules, `DiskUrlSigner` with `signedUrl` (lifetime, disposition and
  content type all required; at most 7 days), and the `DiskErrors` registry
  (`disk.*`). `MediaLibrary.url` and the media admin `directUrls` option sign
  through it, and `@jsails/filesystem/testing` ships `runDiskContract`, the
  conformance suite every first-party disk passes, with leftover and
  stray-rejection checks.
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
- **Proxy trust for deploys.** `jamal deploy` derives the trusted-proxy
  setting from the proxies it runs (kamal-proxy, plus the cache proxy when
  enabled) and passes `JSAILS_TRUSTED_PROXIES` (`hops=1` or `hops=2`) to the
  release, its deploy check, and a rollback; the new `proxy` key
  (`{ forwardHeaders, upstreamCidrs }`) declares the CDN or load balancer in
  front of kamal-proxy, turns on kamal-proxy's `--forward-headers`, and trusts
  it by the address ranges it publishes (`hops=<n>,<ranges>`), so a client
  that connects to kamal-proxy around it cannot name its own address. Either
  key without the other is refused before the build, and a range the app
  cannot read when the config loads. `server.trustedProxies` gains the
  `{ hops, cidrs }` form behind that (the nearest proxies by position, then
  any proxy inside the ranges), and `JSAILS_TRUSTED_PROXIES` its
  `hops=<n>,<ranges>` spelling. Every `kamal-proxy deploy` of the app's
  service, `jamal domain add` included, passes the same route (target,
  health path, `--forward-headers`). The app warns once per process when a
  request shows a misconfigured trust (`JSAILS_PROXY_UNTRUSTED`,
  `JSAILS_PROXY_CHAIN_SHORT`, `JSAILS_PROXY_CHAIN_MALFORMED`, and in
  production `JSAILS_CLIENT_UNKNOWN`), naming no address and never for a
  health probe. `jsails check [--deploy] [--json]` loads the app config and,
  under `--deploy`, checks it in the `production` environment for a missing
  `server.origin` and for a `server.trustedProxies` that overrides the
  deploy's `JSAILS_TRUSTED_PROXIES`; `jamal deploy` and `jamal rollback` run
  it inside the new image with the release's environment before anything
  starts, and an error stops the deploy.
- **Guarded outbound fetch.** `guardedFetch` and `createGuardedFetch` in
  `jsails/support/server` are the one outbound HTTP primitive: credential-free
  https only, each hop resolved once and connected only to an address it
  checked (loopback, link-local, private, CGNAT, unique-local and reserved
  addresses refused), every redirect re-checked, `maxBytes` and a whole-chain
  `timeoutMs` enforced, and value-free `GuardedFetchError` codes.
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
- **Transactions on the data engine (`@jsails/database`).** `transaction(engine,
  body, options)` binds at the lease: every lease the body and its promises
  take joins the transaction, and statements route by async context, so no
  write path escapes it; a lease taken before the transaction stays its own
  connection, so session state never moves to another session. Nested calls
  are savepoint frames, serialised so siblings never interleave; a wait for a
  frame held by a nested one is bounded by the acquire timeout
  (`transaction.frame_busy`), so a read awaited inside a nested frame opened
  after it fails instead of hanging. One poisoned-frame rule on every driver:
  after a failed statement the frame refuses further statements with
  `transaction.aborted` and rolls back, and recovery is a nested
  `transaction()`. Isolation, read-only, opt-in `retry` (transient failures,
  never after a commit) and `timeoutMs` (rolls back at once and frees the
  lease) apply to the outermost call only. `afterCommit`/`afterRollback`
  callbacks run in the nearest enclosing open frame, or with only their own
  engine's scope removed, and report failures as
  `after_commit_failed`/`after_rollback_failed`. Work from an ended
  transaction fails with `transaction.closed`; `detached(fn)` is the way out.
  `withTestTransaction` runs a test in a virtual root that always rolls back,
  with autocommit emulated per statement, the callbacks of an inner
  transaction run inside it, and `isolation`/`readOnly`, which a savepoint
  cannot apply, refused (`transaction.unsupported_in_test`).
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
  travel in a versioned envelope (`JOB_ENVELOPE_VERSION`) whose wire shape
  is pinned per version; `memoryJobs()` is the in-process transport, and
  `setLongTimeout`/`setLongInterval` hold waits beyond 2^31-1 ms. Every
  failure is a `jobs.*` code of `JobsErrors`.
- **The `@jsails/jobs` worker runtime.** `startRuntimeWorker` runs a
  catalog's jobs over any adapter with a total processor: one outcome per
  attempt (completed, failed with a retry decision taken from the error's
  kind, discarded, released), the payload validated again by the worker's
  schema, the dispatcher's execution context (request id, trace, tenant)
  restored around middleware and handler, the whole middleware chain held
  inside its attempt (an unawaited `next()` still holds the job, and a
  handler's failure is never lost to a middleware that resolves), and jobs
  of a newer release released with a capped backoff instead of failed. `drain` and `abort` are
  bounded and idempotent, and an adapter keeps a job held until its handler
  settles, so a job never runs twice at once; a handler that outlives its
  grace after a timeout or shutdown poisons the worker, which stops and exits
  with code 75 (`exitPoisonedProcess`), also when the host's shutdown path
  reports success. Failures are stored as value-free
  summaries (code, kind, class name, stack frames; messages only with
  `storeErrorMessages`), and `jobCompleted`, `jobSkipped`, `jobReleased` and
  `jobFailed` are emitted on a signal bus. The producer captures the ambient
  execution context at each dispatch.
- **`@jsails/jobs` flows, failed jobs, overlap and schedules.** Chains
  advance in the worker with keyed follow-ups the transport stores in the
  operation that settles the step (a redelivery never forks a chain; a
  retried step continues it; a completed step is never failed over its next
  step; an optional catch fires once, also after a forced retry), batches
  run on the adapter's flow capability with a built-in finalizer (then or
  catch, then finally, each once, stored together, surviving a producer
  restart; every item validated before any is enqueued; `batchStatus`),
  flow and schedule keys live under a `jsails:` prefix no dispatch key may
  use, failed jobs live only in the transport and a retry is one atomic
  operation on the same envelope, overlap is a lease-backed `skipped`
  outcome that never advances a chain and survives a failed renewal while
  the store still holds the key, and `schedule()` plus
  `reconcileSchedules()` keep pause state across releases, apply each
  reconcile as one compare-and-set, and ship a ported cron evaluator (time
  zones, DST) and long-timer intervals. The envelope is version 2.
- **The Valkey job transport (`@jsails/jobs/valkey`).** `valkeyJobs({
  connections })` is a shared transport on BullMQ (an optional peer, loaded
  only when the adapter is built; without it the factory rejects with
  `jobs.missing_dependency`), taking every client from the app's Valkey
  provider: queues and scripts on the `command` connection, one dedicated
  `queue`-role connection per worker queue. It holds the whole adapter
  contract, proven by the conformance suite on a real server: a key
  deduplicates for its window after the first job was evicted (BullMQ TTL
  deduplication by the key's digest), a release spends no attempt, retention
  is age-first per queue, a crashed worker's job runs again once its lock
  lapses and fails as `jobs.job_stalled` past `maxStalledCount` (firing a
  chain's catch and recording a batch child), batches and their finalizer
  survive redelivery, a batch that is not chunked is stored in one
  transaction or not at all, a chunked one resumes by id in chunks of
  1,000, a status read costs the same at any size, a failed-job retry is
  atomic and keeps the envelope, and schedules, pause state and leases live
  under the app's `<app>:<environment>` namespace. A spawned test runs a
  producer and a worker in separate processes.

- **Production image.** `jsails make:dockerfile` writes the `Dockerfile` and
  `.dockerignore` that `jamal deploy` builds, and the `--admin`, `--saas` and
  `--blog` starters generate the same files. The image has three stages
  (`npm ci --omit=dev` with a BuildKit cache mount, `npm run build`, a slim
  Node 26 runtime), runs as the non-root `node` user with
  `JSAILS_ENV=production` (so `NODE_ENV=production`) on port 3000, and its
  HEALTHCHECK is the deploy's own
  `/up` probe. The starters' `jamal.config.ts` mounts a `storage` volume at
  `/app/storage`, the image's one writable directory. The command refuses to
  overwrite without `--force`, and the same flags always give the same output
  (`--health-path`, `--no-healthcheck`, `--dir`).
- **Backup and restore (`@jsails/jamal`).** `jamal backup <accessory>` dumps a
  production MariaDB (`mariadb-dump --single-transaction`), PostgreSQL
  (`pg_dump --format=custom`) or Valkey (`BGSAVE`, then `dump.rdb`) accessory
  inside its container to `.jamal/backups/<app>-<accessory>-<UTC time>`,
  written atomically with mode 0600 and a `sha256sum`-format sidecar.
  `jamal restore <accessory> <file>` checks the checksum and the dump kind,
  requires `--yes` or the accessory name typed at the terminal, checks the
  staged dump again in the container, then replaces the data (PostgreSQL
  through a scratch database swapped in atomically; Valkey stopped, rebuilt
  and started by one server-side command). Both hold the deploy lock, and
  `jamal lock status` names the verb and accessory holding it.
- **Jamal integration stage.** `verify:integrations` gains a `jamal` stage
  (`JSAILS_TEST_DOCKER=1`) that generates three `--admin` apps from packed
  tarballs and drives `jamal up`, `ps`, `exec`, `logs`, `down` and
  `down --volumes` against real containers in Compose projects and on
  loopback ports unique to the run. It asserts that the apps get different
  projects and volumes, that a third app under the first one's name is
  refused while the first app runs, that the package's own bin loads `.env`
  and `.env.local`, that `down` keeps data and `down --volumes` removes only
  its own project's volumes, and
  it fails when anything labelled with either project is left behind. CI's
  integrations job requires it.
- **Jamal secrets integration stage.** `verify:integrations` gains a
  `jamal-secrets` stage (`JSAILS_TEST_DOCKER=1`) that writes a release's
  secrets file through the built `@jsails/jamal` writer into a temporary home
  and reads it back from an `alpine:3` container run as uid 10001 through the
  release's own read-only mount: the bytes and every value the environment
  resolver reads back equal the originals, the mount is not writable, and a
  rewrite reaches a running container through the cache proxy's directory
  mount. Its containers are named after `JSAILS_TEST_DOCKER_PREFIX`. The
  harness also takes `--only <stages>`, and CI's integrations job requires the
  new stage.
- **`jamal down --volumes`.** `jamal down` keeps the project's named volumes
  (documented in its usage and the deploy guide); `down --volumes` then
  deletes every volume labelled with the project's Compose name and names
  each one removed. It asks for the project name to be typed back, or takes
  `--yes`, and otherwise refuses with `confirmation_required`.
- **`jsails/internal`.** The kernel's surface for first-party packages, with
  no compatibility promise; a package that imports it pins `jsails` to the
  exact lockstep version. It exports `resolveEnvironment` and
  `applyEnvironment`, the `jsails` CLI's environment resolution (and the key
  ring a deploy delivers), and the CLI failure report (`renderFailureReport`,
  `renderCauseChain`).
- **`jsails/internal/plugin-manifest`.** The static plugin manifest contract
  (manifest parsing and checks, the permission registry, settings schemas)
  without the plugin runtime behind `jsails/plugins`, so a package that only
  validates manifests loads a few modules and no database code. Internal tier:
  an importer pins `jsails` to the exact lockstep version.
- **Marketplace release trust (`@jsails/marketplace`).** Zero third-party
  dependencies. A bundle archive reader that reads GNU tar, bsdtar (pax) and
  `git archive` output with strict UTF-8 names, refuses links, devices,
  native addons, unsafe or colliding paths and every header it does not read,
  and enforces its byte and entry limits while reading; `openBundle` applies
  the single-root manifest rule. Ed25519 signatures over domain-tagged
  canonical JSON (RFC 8785, safe integers) with checked-in vectors; release
  statements, publishers with id namespaces, key uses and permission
  ceilings, root-signed key delegations that fall with their root, and signed
  catalogs with rollback protection (a floor that falls with the key that set
  it, and refusals that still carry their revocations), stale-but-honoured
  expiry, and revocations. `verifyRelease`, `verifyStatement`, `verifyDelegation` and
  `verifyCatalog` return a value-free verdict code per failure.
- **`jsails/errors`, the error kernel.** Browser-safe: `defineErrors` declares
  a domain's codes (kind, audience, message template, typed context slots,
  suggestion, client-exposed payload), and every message is rendered from
  validated context, so it is value-free by construction. It also exports
  `invariant`, `isRegistryError`, `JsailsError`/`isJsailsError`, the
  client-audience constructors, `normalizeError`/`registerErrorTranslator`,
  `formatError` and `serializeError`; the root barrel adds the boundary table
  and `toProblem`/`problemResponse`. `isRetryableKind(kind)` is the one
  retry rule: the boundary table's `retryable` column and the jobs runtime
  both read it. `api/error-codes.json` lists every code, kept current by the
  `error-registry` gate.
- **`@jsails/database/model`.** ModelSpec as the only model declaration:
  `defineModel`/`defineTable`, 14 portable column types with per-dialect
  codecs under a lossless, order-preserving fidelity rule, a spec validator
  (tenant, unique-includes-tenant, encrypted capacity, index names, worst-case
  PostgreSQL/MariaDB key widths), and `physicalTable(model, dialect)`, the one
  pure lowering, with automatic foreign-key, polymorphic and tenant indexes.
  `dependent: 'destroy' | 'nullify'` lowers to `ON DELETE CASCADE` / `SET
  NULL`. The `data-specs` gate (`scripts/check-schema-portability.mjs`, part
  of `check:structure`) requires every model to be a ModelSpec that lowers on
  PostgreSQL, MariaDB and SQLite with indexed keys; the remaining TypeORM
  models are ratcheted in `data-specs.json`.
- **Schema core (`@jsails/database`).** Owned introspection and DDL for
  PostgreSQL, MariaDB and SQLite, without an ORM: a pushed schema of every
  portable type and index form introspects back to an empty plan.
  `pushSchema`/`diffSchema` classify each operation as safe, blocking or
  destructive, apply the safe ones and defer the rest until approved by
  digest, one by one (`db:push --approve <digest>`; `--approve-all` in
  development and test only). A digest binds the operation to the live table
  it changes, so a stale approval refuses the push. The ledger
  (`jsails_schema_objects`, `jsails_data_migrations`, `jsails_schema_meta`)
  records each table's owner, so a hand-made or another owner's table is
  never dropped and never blocks safe work. The push holds a session lock
  named from the server-reported database and verified before every
  statement (`schema.pooled_connection` through a transaction-mode pooler),
  or one `BEGIN IMMEDIATE` transaction on SQLite. In `test` it requires a
  server-reported test database name and the harness's marker row. A
  complete push records the declared digest, and `verifySchema` fails boot
  with `schema.schema_out_of_date` in production when the code is ahead of
  the database. `defineSchemaConfig` makes a database config module that
  the built-in `db:push`/`db:diff` dispatch to (`--approve`, `--approve-all`,
  `--wait-lock`, `--json`; a push that deferred work exits 3).
- **Statements, tenant policy and column codecs (`@jsails/database`).** The
  statement IR gains inner and left joins and an upsert guard. `ir` builds
  frozen statements. `applyPolicies` is the tenant guard as a pure rewrite,
  and `compileGuarded` runs it under the ambient tenant for every app
  statement. The tenant condition goes on every reference to a tenant-scoped
  table: main table, joins, `EXISTS`/`IN` subqueries at any depth, the inner
  select of a window limit, and update and delete targets. Inserts are
  stamped. A row, SET or upsert that could reach another tenant is refused;
  an upsert's conflict target must include the tenant column, which also
  guards the update, so MariaDB's any-key conflict cannot rewrite another
  tenant's row. With no tenant, a read that references a tenant-scoped
  table anywhere matches nothing as a whole, so a `NOT EXISTS`, `NOT IN` or
  left join over it cannot read every row as "no match", and writes throw
  `tenant_scope.no_tenant`. A table outside the catalog is refused, and so
  is a column named twice, and so is a row lock PostgreSQL cannot take
  (over a left join, `DISTINCT`, `GROUP BY` or an aggregate) on every
  dialect. `withoutTenantScope` is the one opt-out, and its
  statements appear in the query ledger as `tenant-unscoped`.
  `findUnscopedReferences` is an independent coverage checker that other
  packages can hold their statements to. Column codecs (`ColumnCodec`)
  chain a `json` column's data contract, a `string` column's `enum`, the
  portable type and an encryption seat. A predicate a column's stored form
  cannot answer is refused at build time with
  `statement.unsupported_predicate`. `Where<T>` and `Q` compile conditions
  with every value encoded; a property or operator set to `undefined` throws
  `statement.invalid_where` instead of widening the predicate, up to every
  row. The owned hydrator builds records without
  running constructors and keeps a hidden `{ persisted, baseline, fks }`
  state slot. Projections are frozen plain rows. There is no result cache.
- **Records, queries and the `database()` plugin (`@jsails/database`).**
  `ApplicationRecord` extends nothing: `find`, `findBy`, `where`, `all`,
  `build`, `create` and `insertAll`; `save` (an insert that reads every
  generated value back, or an update of only the changed columns with the
  optimistic lock, `record.stale_record` when it matches no row),
  `destroy`, `reload`, `isPersisted`, `changed` and `was`. `ModelQuery` is
  immutable, with conditions compiled where they are written: `where`,
  `orderBy`, `limit`, `offset`, `lock`, `scope`, `whereHas` and `has`
  (correlated `EXISTS` over belongs-to, inverse, polymorphic-inverse, self
  and link-table relations), `withoutTenantScope`, `getMany`, `getOne`,
  `count`, `exists`, `pluck`, `select` (frozen plain rows, never records),
  `inBatches`, `findEach`, and the set writes `updateAll`/`deleteAll`
  returning `{ affected }`, the rows matched on every driver, which with a
  `lockVersion` condition is the conditional update. It has no `apply`,
  builder, repository or manager. Batch walks are keysets: a fresh
  statement per batch, built from the cursor's values (a plain or row-value
  comparison, the expanded form with a leading range term on MariaDB,
  explicit `IS NULL` branches for nullable columns), the primary key as
  default order and tiebreak, so each batch reads through the index.
  A locked `count()` locks the rows `getMany()` would, and a read grant
  refuses `lock()`. A query runs only on a context, codecs and state the
  package made (`query.invalid_context`), so a caller cannot swap the
  catalog that carries the tenant policy or a handle's grants.
  Constructing a `JsailsDataSource` binds its models (a second binding
  throws `data_source.already_bound`; `close()` unbinds); it holds its
  engine privately and opens it on first use, and `transaction(ds, ...)`
  accepts it. Bindings are shared with a duplicate copy of the package,
  which refuses the other copy's data source as
  `data_source.duplicate_package`. `FileDataSource` is a read-only
  in-memory SQLite source loaded through `insertAll` (a read-only
  transaction on it no longer lifts the guard: the SQLite engine resets
  `query_only` only when it set it); `dataHandle(ds, { models, read })` is
  the model-set handle for gated plugins; `@jsails/database/unguarded`
  gives `{ sql, lease }` only. The `database()` plugin declares the data
  source as a kernel-owned substrate resource under `databaseToken` (a
  `SubstrateHandle<JsailsDataSource>`, registered before any setup, opened
  on the first `get()`, which binds the models, and closed after the last
  cleanup) and declares `DATABASE_URL`, `DATABASE_PASSWORD` and
  `DATABASE_MIGRATION_URL`; a plugin's `substrate` declaration now also
  receives `rootDir`. `resolveDatabaseConfig` reads only the environment
  its caller passes and no longer takes the `urlEnv`, `passwordEnv` or
  `migrationUrlEnv` options.
- **The write pipeline and change feed (`@jsails/database`).** Every write
  goes through one pipeline. `save()` and `destroy()` write the full
  instance: before hooks, validation, one INSERT or one `UPDATE ... SET
  <changed> WHERE pk [AND lock_version]` with no SELECT before it, the
  declared effects, after hooks, and `afterCommit` once the outermost
  transaction commits; a save with nothing to write runs nothing. A write of
  more than one statement, or with hooks, is atomic in its own transaction
  or a savepoint of the caller's, and a write that rolls back puts its
  records back (unsaved after an insert, the old baseline and
  `lockVersion` after an update; a record written several times is put
  back as it was before the first write). `defineModel(Class, spec, { hooks,
  validate })` takes the record hooks (`beforeSave`, `beforeInsert`,
  `beforeUpdate`, `beforeDelete`, `afterInsert`, `afterUpdate`,
  `afterDelete`, `afterSave`, `afterCommit`; each gets `{ record,
  operation, changes, tx }`; there is no `afterLoad`) and any `safeParse`
  schema, whose failure is `record.invalid` (kind `invalid`, value-free
  `issues`). Declared effects are compiled once per model: `counterCache`
  and `touch` (`c = c ± 1` per record write, a recount by subquery for a
  set write), `dependent` lowered to the foreign-key action when that is
  the whole work, one statement for a polymorphic or versioned child, or
  keyset batches of 500 through the pipeline (a `belongsTo`'s own
  `onDelete: 'cascade'` or `'set null'` counts as the inverse's
  `dependent`), `autosave: true` on a `belongsTo` or inverse relation
  (read from the instance being saved, on update too; a record assigned
  to the relation states the link, while a key the application changed
  after the relation was loaded is kept), and `attachments:
  { name: { kind: 'one' } }` stored in `attachmentTable` (unique per record and name, moved with a primary-key
  change; a blob is deleted only once no row names it, the replaced one
  after commit and one a rolled-back save named only when the record no
  longer holds it, so a retry keeps its bytes; `attachmentOf` reads one;
  the data source takes `attachments: { disk, onCleanupError }`, and a
  failed cleanup goes there without changing the write's outcome). Effect
  writes apply codecs and the tenant policy but never parent hooks,
  validation or `lockVersion`. `updateAll`, `deleteAll` and `insertAll` are set writes:
  on a model with hooks or validation for the operation they need `{
  skipHooks: true }` (`query.set_write_skips_hooks`), and an effect with no
  set form throws `query.unsupported_set_write` unless `{ skipEffects: true
  }`. `ds.changes.subscribe(listener, { models, onError })` delivers
  key-only `ChangeRecord`s (`collection`, `op`: insert, update, delete or
  `invalidate`, `key`, `tenant`) for the subscribed models, built only
  while a subscription exists, coalesced and delivered after the outermost
  commit, never after a rollback; a primary-key condition yields per-key
  records, any other condition or a foreign-key action an `invalidate`,
  and listener failures go to `onError`, never to the write. An update's
  `SET` term may be a scalar subquery in the statement IR, covered by the
  tenant rewrite and coverage check.
- **Relation loading (`@jsails/database`).** `query.includes(spec)` loads
  relations with a query's records (`getMany`, `getOne`, `inBatches`,
  `findEach`; `count`, `exists`, `pluck` and set writes ignore it): a
  relation name, a list, or `{ name: true | { where, order, limit,
  maxRows, include } }`. Each relation level is one statement per bind
  chunk, all on the query's one lease: `WHERE fk IN (keys)` ordered by
  `(fk, order..., pk)` so the foreign-key index serves it, with the
  foreign key on each row so nothing is selected twice. PostgreSQL binds the
  keys as one array (`fk = ANY($1)`), so a level is one statement however
  many parents it has; MariaDB and SQLite split them at the bind limit less
  the statement's other parameters. A per-parent `limit` is a
  `ROW_NUMBER()` window, so the database returns at most `limit` rows per
  parent. `maxRows` fails a level that would read more
  (`relation.too_many_rows`); nothing is ever cut off silently. Every
  kind loads: `belongsTo` (once per distinct key, parents sharing the
  record), `hasMany`, `hasOne`, through relations (one join), a polymorphic
  `belongsTo` (one statement per type) and its inverse. The loads run under
  the tenant policy, so no loader returns another tenant's row, and a query
  `withoutTenantScope` loads unscoped. A class declares a relation as
  `Relation<V>`, which does not read as `V` until loaded: `includes` and
  `loadRelation` return `Loaded<T, S>`, and at run time an unloaded
  relation is a class accessor that throws `relation.not_loaded` (never
  `undefined` or empty), invisible to JSON and spreading; a loaded or
  assigned relation is an own enumerable property, and `reload()` unloads
  them. A relation named like a member of its class is refused by
  `defineModel`; a subclass of a model may repeat its parent's relations,
  and reads one it does not declare as `query.unknown_relation`. Relations
  a scope includes load and type as the query's own, and relations are not
  columns for `where`, `select` or `pluck`. Outside a query, `loadRelation(model, records, name, options)`
  loads onto records in hand, `loadRelationMap` returns each parent's value
  without attaching it (plain rows included), and `relationCount` counts
  with one grouped statement. A data handle loads only relations to the
  models it owns.
- **The testing surface (`@jsails/database/testing`).** `createTestDataSource(models,
  { database })` opens a data source on a test database: by default a fresh
  SQLite file in a temporary directory, removed with its WAL files on
  `close()`; `'memory'`, whose tables are created through the data source's
  own connection; or a server database (`{ config, name, workerId, drop }`)
  named `<base>_test`, or `<base>_w<id>_test` per `node:test` worker
  (`testDatabaseName`, from `NODE_TEST_WORKER_ID`), so parallel workers never
  share one. The harness creates and marks a database it creates, refuses an
  existing one that is not marked (`schema.unmarked_test_database`), pushes
  the schema under the test-database guard, emptying a reused database's
  tables inside that push (after the guard, before the plan, so rows a killed
  run left never block a new required column, unique index or foreign key),
  and drops it on `close()` only with `drop: true`; every one of these steps
  uses the configuration's migration connection, the one a push uses;
  `matrixTestDatabase()` gives the database suite's leg a random dropped
  database. `transactionalTests(dataSource)` returns `test` and `it` that run
  each test inside `withTestTransaction`, so whatever it writes, through any
  write path, rolls back; `{ commits: true }` runs a test for real and empties
  the tables after it, passed or failed. `countStatements(dataSource, fn)`
  returns the query ledger of `fn`'s statements on that data source only,
  without the engine's own transaction control, so counts are the same
  inside a test transaction as outside it. `defineFixture` and
  `loadFixtures` insert rows as stated in one transaction (codecs apply; no
  hooks, validation, effects or tenant policy; a row names its tenant;
  explicit PostgreSQL identity keys move the sequence past them).
  `defineFactory(Model, (n) => values)` builds, creates (through the write
  pipeline), creates a list atomically, or inserts as a set write, with a
  sequence that only counts up. `defineSeeder` and `runSeeders(dataSource,
  seeders, { only })` run seeders in order, each in its own transaction, a
  failure stopping the run as `testing.seeder_failed`. `storeContract(name,
  makeStore, cases)` runs plain-data store cases (absent read, upsert in one
  row, uniqueness with a conflict that leaves the caller's transaction
  usable, N concurrent writers, expiry on a fixed clock with a sweep,
  removal, rollback) on every database the run covers. Errors are
  `TestingErrors` (`testing.*`), value-free.
- **`valkeyPlugin` and `valkeyToken` (`jsails/plugin-sdk`).** One app-owned
  Valkey connection provider. It hands out `shared('command' | 'subscriber')`
  and `dedicated('blocking' | 'queue', name)` clients, each with its own
  connect deadline (5 s), command deadline (2 s, `command` role),
  offline-queue policy, client name and app key prefix. `script()` runs
  EVALSHA with an EVAL fallback and an optional longer per-script deadline.
  `useValkeyConnections({ services, rootDir })` gives a consumer's setup the
  registered provider, or creates one from `VALKEY_URL`.
- **`jsails/rich-text` version 2.** Inline runs with marks and links;
  `parseRichText` (the only reader), `normalizeRichText`, `measureRichText`
  with `MAX_DOCUMENT_BYTES`/`MAX_BLOCKS`/`MAX_BLOCK_CHARS`/`MAX_LIST_ITEMS`,
  `isLinkHref`/`isEmbedUrl`, `richTextToPlainText`, `upgradeRichTextDocument`;
  task lists and nested lists up to three levels. `jsails/testing` adds
  `generateRichTextDocument` and `generateRejectedRichText`. `@jsails/blog`
  adds the `blogRichTextUpgrade` data migration (it upgrades post, page and
  revision bodies, and refuses the whole run, naming failing rows by table and
  row id, when any body cannot be upgraded) and the `BlogContentError` code
  `unreadable_body`.
- **ProseMirror engine in `@jsails/editor` (internal until the editor UI
  ships).** A schema that mirrors the version 2 model node for node (one list
  node type per depth, attributes validated by the model's own predicates, a
  pasted `javascript:` link dropped at parse), a codec for which
  `decode(encode(d))` is `d` for every canonical document, editor plugins that
  keep the state within the model's character rules, schema validity and size
  budget, list commands, and a synchronous headless mount. New error codes
  `rich_text_editor.*`; new dependencies on the `prosemirror-*` packages.
- **`jsails/context`.** One immutable execution context per unit of work (a
  request, a job attempt, a static-export render, setup) with typed keys
  (`createContextKey`, `withContext`, `getContext`, `currentContext`), W3C
  Trace Context parsing and formatting, and a versioned carrier
  (`serializeContext`/`restoreContext`) that jobs use to carry the request id,
  trace, locale and tenant. Its codes are `context.*` (`ContextErrors`).
- **Trace continuation.** The `telemetry.trustInbound` app option
  (`AppOptions.telemetry`) continues any inbound `traceparent`; without it,
  one is continued only from a trusted proxy. `c.var.trustedPeer` and
  `ResolvedRequestOrigin.trustedPeer` say whether the immediate peer is a
  trusted proxy (`server.trustedProxies`), apart from the client address.
- **Environment resolution.** `JSAILS_ENV` (or a leading `--env`) names the
  environment, default `development`; `NODE_ENV` is derived from it
  (`development`, `test`, otherwise `production`) and a contradicting
  `NODE_ENV` is fatal (`environment.conflict`). Precedence: the process
  environment, then `JSAILS_SECRETS_FILE` (`{"v":1,"values":{...}}`), then
  `.env.local` (development only), then the sealed credentials, then
  `.env.<name>`, then `.env`; only development and test read `.env` files. A
  file that defines a reserved key, or an existing file that cannot be read,
  is fatal. Each command declares whether it needs the secrets: app-running
  commands fail with `credentials.missing_key` in every environment; `build`,
  `build:meta`, `inject:auto-imports`, `make:*`, `credentials` and `help`
  never open the document, and `create` resolves no environment at all (the
  directory it runs in is not the project it scaffolds). Child processes
  inherit the resolution through `JSAILS_ENV_RESOLVED`, which binds a digest
  of the project root's real path (never the path): a child in another
  project stops with `environment.inherited_foreign_project` rather than
  inherit, or resolve under its parent's values. `jsails` exports the
  `env.require`/`env.optional` accessor and the `EnvironmentErrors` and
  `CredentialsErrors` registries.
- **Credentials format v2.** The header `jsails-credentials v2 <env> <keyId>`
  is authenticated with AES-256-GCM, and a key ring of up to two keys (one per
  line in the key file, comma-separated in `JSAILS_CREDENTIALS_KEY`) opens a
  document while it is rotated. `jsails credentials` has `init [--from]`,
  `edit`, `set` (the value on stdin), `unset`, `show`, `import` and `rotate
  [--finish]`. A sealed document may only define plain variable names
  (`credentials.invalid_name` for `A.B`, `__proto__`, ...).
- **Server-component limits and downloads.** A validated `limits` plugin
  option (`component_limits.*`), `clockToleranceMs` (default 60 s) on snapshot
  and reference checks, `downloads` as its own opt-in, `runtime.snapshotTtlMs`
  and `runtime.renderMarks(request)`. `jsails/server-components` exports
  `ComponentRegistryErrors`, `ComponentLimitsErrors` and
  `ComponentAuthorizeErrors`.
- **`ExtensionContext.rootDir`.** The setup context's absolute app root (the
  app config's directory). App assembly and `jsails work`/`schedule` pass it
  through the `runExtensions` option `rootDir`, which is required and must be
  absolute (`extension.invalid_root` otherwise): the runner never falls back
  to the working directory. The first-party setups resolve against it too:
  the `jobs` plugin's `jobsDir` and default queue prefix, and the default app
  key prefix of `valkeyPlugin` and of a provider `useValkeyConnections`
  creates. `importGeneratedRegistry` and `bootstrapModels` require `rootDir`
  as well.
- **S3 multipart writes.** `S3Disk` streams uploads as multipart (`partSize`,
  5 MiB to 1 GiB) and aborts the upload on any failure; `ifAbsent` sends
  `If-None-Match: *`. Its `conditionalWrites` option and the
  `S3_CONDITIONAL_WRITES` variable declare a store that ignores
  `If-None-Match` (SeaweedFS), so `ifAbsent` refuses with `disk.unsupported`
  instead of overwriting.
- **`jsails/view`.** The browser-safe runtime of compiled `.jsails` templates:
  `normalizeClass`, `normalizeStyle`, `bindAttributes`, `renderList`, and the
  `PageProps<typeof load>`, `ComponentChild`, `SpreadAttributes` and
  `BoundAttributes` types. It is never projected as framework globals:
  compiled templates import its helpers explicitly.
- **`.jsails` pages, layouts and views.** The compiler lowers pages, layouts,
  error and not-found pages, and views (any `.jsails` file outside `pages/`,
  `components/`, `islands/` and `mail/`) to typed TSX shadows:
  `defineProps`/`defineSlots`, implicit props,
  `js-if`/`js-for`/slots/`<component :is>`, and class and style normalization.
- **`.jsails` compilation, sidecars and diagnostic remapping.** `compileSfc`
  compiles the checked shadow with oxc to JavaScript on the automatic
  `jsails` JSX runtime, composing a source map back to the `.jsails` file
  (sources relative to the output) and reporting a transform error at its
  `.jsails` offset (`sfc.compile_error`, or `sfc.internal` in generated
  code). `writeSidecars` keeps `.jsails/sfc` (each shadow, its span table and
  its `.d.jsails.ts` bridge) atomic, change-only and pruned, spelled as each
  source's path after a case-only rename on a case-insensitive file system,
  and refuses a symbolic link (`sfc_sidecar.symlinked_directory`) or a file
  (`sfc_sidecar.not_a_directory`) on the way; `remapTscOutput` maps
  `tsc` diagnostics on shadows to `.jsails` positions or to the template node
  that generated the code. Internal for now: the build and `jsails sync`
  wiring follow.
- **`.jsails` live components.** A `.jsails` file under `components/`
  compiles to a server component definition: `defineLive({ stateSchema, … })`
  in `<script>` is the definition, `<script setup>` and `<template>` its
  `render` (free names are state fields; `errors`, `values`, `context` and
  the keys of `derived` are kind names), and `<template static>` its
  `staticFallback`. `@click`, `@submit` (on a `<form>`) and `@intersect` name
  an action (`remove(task.id)`), with `.prevent`, `.once` and `.capture`;
  `js-model[.lazy.trim.number]`, `js-confirm`, `js-loading`, `js-poll`,
  `js-sort`, `js-ref` and `js-ignore` lower onto the render tools, and
  `js-show`/`js-text` on a bare state field also carry the client marker.
  The component's id comes from its path (`componentIdFor`). A page, a
  layout or the not-found page renders a live component by its tag
  (`<TaskList />`): the compiler hoists an awaited `mountLive` under the
  template's own `js-if` conditions, so each runs once before the template
  and nothing the template does not render is mounted. A live tag inside a
  `js-for`, a scoped slot or a `<slot>` fallback, with attributes, or in any
  other kind is a positioned diagnostic (`sfc.live_*`).
- **`.jsails` islands.** A `.jsails` file under `islands/` compiles to a
  named function component wrapped by `defineIsland` with its path id
  (`islands/admin/user-card.jsails` is `admin/user-card`, `islandIdFor`), so
  the server markup and the browser registry read the id from the module; a
  path that is not its own id (a name not in kebab case) or gives an id
  `defineIsland` refuses is `sfc.invalid_island_id`. In its template `@event`
  sets Preact's typed handler prop of a DOM event (`@keydown` → `onKeyDown`,
  `.capture` → `onKeyDownCapture`; `.once`, `.self`, `.prevent`, `.stop`; an
  event Preact does not type is `sfc.unknown_event`) or a component event's
  `on…` prop; `$event` is the event, and a member-path handler
  (`store.add`) is called through its object; `js-model[.lazy.trim.number]`
  binds an input, textarea or select to a signal through `bindControl`, and
  an `@input` or `@change` on the same control runs after the binding's
  handler; `defineEmits<{ change: [n: number] }>()`
  types an `emit` function and the parent's `@change`; and hooks are allowed.
  A page, layout, error page, not-found page or view mounts an island by its
  tag (`<Counter :start="n" />`), lowered to `<Island>`: the props object is
  checked against the island's props narrowed to JSON, so a function or a
  `Date` prop is a TypeScript error at its attribute and a missing prop at
  the tag. Inside an island the tag is a plain component; in a live
  component, children on the tag, or `js-hydrate="idle"`/`"visible"` (no
  runtime yet) it is a positioned diagnostic. `compileSfc(lowering, { target:
  'client' })` compiles an island or a view for the browser, byte for byte the
  server module (`sfc.client_target` for any other kind).
- **`.jsails` styles.** A `<style scoped>` block compiles to a native `@scope`
  rule with no selector rewriting: every compiled template writes
  `data-s="<id>"` on its outermost elements and on the outermost elements of
  the content it passes into a component's slots, and the rule reaches those
  elements and what they contain down to the next element another component
  marked, so a parent's rules never reach a child component's root. The id
  is eight characters derived from the component's lower-cased posix project
  path only, the same on every platform (`sfc_style.invalid_path` for a path
  that is not normalized). A `<style>` block is global CSS as written. The
  compiler collects every component's blocks into one stylesheet, the
  `ISLAND_STYLE` rule first and then components by path, with a style id per
  block (`<file>?jsails&type=style&index=N&lang.css`) and two components
  with one id refused (`sfc_style.scope_collision`); each lowering carries a
  module and a style hash, so a dev server can tell a style-only edit from a
  module change. A block that would break the joined stylesheet (an
  unclosed comment, string, `url(` or bracket: `sfc.style_unbalanced`;
  text that is not a complete rule, such as a selector with no block, an
  at-rule with no `;` or a declaration outside a rule, which would join the
  next block's first rule: `sfc.style_incomplete`; `@import`, `@charset`,
  `@namespace`: `sfc.style_at_rule`) or that a scope cannot limit
  (`@keyframes`, `@font-face`… in a scoped block: `sfc.scoped_global_rule`;
  `:scope` and `&` outside a rule: `sfc.scope_selector`; a declaration
  outside a rule: `sfc.scope_declaration`) is refused, and `data-s` written
  on a tag is `sfc.reserved_attribute`.
- **The `.jsails` format reference.** The docs' Components page states the
  format as the compiler builds it: the kinds by path, the blocks, text,
  interpolation, attributes and `js-*` directives, slots, the name rule, the
  macros, pages and live components, and when to keep TSX. Every
  ` ```jsails path=… ` sample in the docs is lowered, compiled and
  type-checked through its sidecars by the docs build, with each problem
  reported at the sample's own line (a sample without a path is a view).
- **Islands in `jsails/view`.** `defineIsland(id, component)` names a
  component as an island; `<Island component props>` renders it inside a
  `<jsails-island data-jsails-island data-jsails-props>` marker, encoding the
  props and rendering the island from the copy the browser's decoder returns,
  so the first paint is the hydrating render (an island inside another island
  renders inline). The marker carries no `style` attribute, which a
  nonce-based Content-Security-Policy would block; `ISLAND_STYLE`
  (`jsails-island{display:contents}`) is the stylesheet rule a layout
  includes. `IslandProps<P>`, `bindControl` (with a `handlers` option for the
  control's own `input`/`change` handlers), `emitter`, `EmitProps` and the
  `island.*` error registry (`IslandErrors`) are exported with it. `startClient({ islands })` also
  takes a list of defined islands, registered under their own ids.
- **`defineLiveComponent(name, stateSchema)(options)`** (`jsails/server-components`):
  the schema-first form of `defineComponent`, the shape compiled live
  components take. The state type is fixed before the options are checked,
  so `serverAction({ run(state, args) })`, derived functions and `render` are
  typed from the schema without type arguments, and `render`'s tools take only
  declared action names (`call`/`submit` args typed by the action, `intersect`)
  and return each derived property's type. `ServerComponentRenderTools`
  gains `Actions` and `Computed` parameters whose defaults keep untyped
  definitions as they were.
- **`mountLive(definition, context)`** (`jsails/server-components`): render a
  live component where a page renders it, as compiled pages do.
- **`staticRender: 'initial'`.** A server component may export its own render:
  a static export then renders `render` over `initialState(staticContext)`
  with inert tools (bound values without the model marker, a form that cannot
  navigate, no other marker; action args still validated), only when
  `authorize(staticContext)` returns exactly `true`, without the `mount`
  hook, a snapshot, signing or an instance id. Exclusive with
  `staticFallback`.
- **`.jsails` components as folders.** A component is one file or a folder
  named after it: `x/x.jsails` (`<template>`, `<template static>`,
  `<script setup>`), `x/x.ts` (the `<script>`), `x/x.css`, `x/x.scoped.css`
  and `x/x.server.ts`. The folder is named by its component path
  (`D/x.jsails`), which decides its kind, route, id and output, and both
  layouts lower through `lowerSfc` to the same module, shadow types and
  diagnostics, each diagnostic in the file that holds its block; only an
  import of the server module, which stays in the folder, names it there
  (`./x/x.server.js`). `x.ts` is a real module: a script companion sidecar
  (`.jsails/sfc/D/x.jsails.script.ts`) gives it the catalog names and, for a
  live component, `defineLive` typed by the component's state. A `<script>` or
  `<style>` in a folder's `x.jsails` is `sfc.folder_block`; a file beside a
  folder of the same name is `sfc.layout_conflict`. Module scans (routes, the
  component registry, autoload) skip a component's parts, and the server
  module is exactly `x.server.ts`.
- **`jsails convert <path>`** toggles a `.jsails` component between one file
  and a folder, moving block bodies byte for byte, rewriting the moved
  TypeScript's relative specifiers, moving the server module (and no sibling
  named like it), and refusing (`convert.*`) what it cannot convert
  losslessly, including a folder whose `x.ts` or style file holds a
  `</script` or `</style` that would end its block in one file
  (`convert.end_tag`). `jsails make:page` and `make:server-component` take
  `--mfc` to write the folder. Both make a folder only in a project that syncs
  `.jsails` sidecars (`.jsails/sfc`; `convert.no_sidecars`,
  `make.no_sidecars`), which the app build does not do yet: elsewhere the
  folder's `x.ts` would be compiled as a module of its own. Generators and
  `convert` create their files all or none.
- **Bind value modifiers.** `bind(name, { trim, number, lazy })` adds
  `data-jsails-trim`, `-number` and `-lazy`; the client reads the control's
  value through them (trimmed, a finite number read as a number, taken on
  `change` only) wherever it reads a bound control. A lazy control's
  uncommitted text survives a render the user did not trigger.
- **`.jsails` tooling.** One TextMate grammar (`source.jsails`) highlights
  `.jsails` files: script blocks as TSX, style blocks as CSS, and template
  interpolations, bindings, event handlers, slot parameters and `js-*` values
  as TSX expressions, each directive by the value kind the compiler's table
  declares. `@jsails/content` highlights ` ```jsails ` fences with it, loading
  the grammar only when a page has one (the render cache's format version
  moves to 4). Prettier formats `**/*.jsails` and `**/*.jsails.template` with
  its `vue` parser and no plugin, leaving the compiler inputs under
  `test/**/fixtures/` as written; a format corpus proves formatting is
  idempotent, keeps every diagnostic, lowers to the same shadow and renders
  the same HTML byte for byte. For that, the template parser writes the
  static `class`, `style`, `srcset` and `allow` values Prettier reprints in
  one canonical form, checked against the installed Prettier by a seeded
  sweep; a `style` whose meaning Prettier would change is
  `sfc.unstable_style`, an inline `on*` handler is
  `sfc.event_handler_attribute`, and Vue's `.x` and `slot-scope` are
  `sfc.vue_syntax` with fixes. A private VS Code extension (`editors/vscode`) contributes
  the language and its generated grammar and activates the TypeScript 7
  extension.
- **The plugin contract (`jsails/kernel`).** `definePlugin({ name, options,
  key, env, requires, optional, provides, substrate, setup, schema, jobs,
  schedules, release })` returns a factory that parses options against a Zod
  schema when called (`config.invalid_options`, with schema-declared paths and
  codes only, before any setup) and returns an inert `PluginInstance`. A
  plugin that declares `key` (a function of its options) names each instance
  `<plugin>:<key>`, so an application configures it once per key; an unkeyed
  plugin has one instance per application.
  `runExtensions` runs instances beside extensions: ordering by declared
  tokens, a declared-only service view (`plugin.undeclared_service`,
  `plugin.missing_provision`), one provider per token
  (`extension.duplicate_provider`), substrate resources opened on first use
  and closed after every cleanup, and `lifecycle.register(roles, unit)` for the
  `web`, `worker` and `export` roles. Options are data, `fn()`, `tokenRef()`
  and `moduleOption()` (`moduleRef(id)`), checked by `checkOptionSchema`;
  variables are declared with `envVar.*`, read only by the host (from the
  `env` option of `runExtensions`, or the process environment) and checked
  before any setup (`config.invalid_env`, never echoing a value).
  `lazy(() => import(...))` defers setup and contributions, and
  `loadPluginContribution` reads a contribution slot without setup.
  `db:push`, `db:diff` and `jsails test` register the models of a `schema`
  contribution and refuse one that carries tables or data migrations
  (`plugin.unsupported_contribution`) until the phased planner reads them.
  `lifecycle.register` for a role the process runs is refused
  (`plugin.lifecycle_unavailable`) until the kernel starts lifecycle units.
- **Keyed and live service tokens.** `token.named(key)` returns one member per
  key, so two plugin instances can provide two instances of one service;
  `createServiceToken(name, { live: true })` marks a service that exists only
  in a live process, and the `export` role leaves out every plugin that needs
  one. The token API is also exported from `jsails/kernel`.
- **`testPlugin` (`jsails/testing`).** Runs one plugin's setup with stand-in
  services and fails with `plugin_harness.inert_violation` when setup (or its
  lazy setup module) opens a socket, listens, fetches, resolves a name, writes
  a file, starts a subprocess, arms a recurring timer or opens a substrate
  resource, even when setup swallows the throw. A timer or immediate setup
  leaves pending is cancelled and fails the run, promise chains setup did not
  await run under the traps before it returns, and a side effect work setup
  left running commits before `close()` fails the close.
- **Access matrix (`jsails/testing`).** `accessMatrix(app, { personas })` asks
  every surface in an app's registry as every canonical actor (anonymous, a
  user without a role, unverified, without a second factor, with stale
  authorization, tokens with no, exact or another tenant's scope, a cookie
  with a bearer token, a rejected cookie and token, then the app's personas),
  same-origin and, for a write, from a foreign origin and naming none. Each
  request goes through the real pipeline with its actor's real credentials and
  a body of the declared kind; a probe answers where the route's middleware and
  handler would run, so no route code runs. Each row records the outcome,
  status, code, identification, handler reach, body bytes read, session
  resolver calls and the answer's caching and cookies, in a fixed order, byte
  for byte the same on every run, with the surface whose access chain decided
  it (`decidedBy`); `ACCESS_INVARIANTS` judges them (each request decided by
  its own surface's chain, unless the surface is public and reads no
  credential, denied before the handler, only public access admits anonymous,
  cross-site writes refused for every actor (a refused credential the surface
  reads may be answered 401 instead), connection origin and host, denials
  `no-store` without cookies, identified answers never `public`, rejected
  credentials 401, no token on management surfaces, no authentication on
  credential-free surfaces, rate-limited anonymous writes, no code-activating
  surface in a locked app). A probe builder may give candidate requests: when
  an earlier route decides one (`/docs/:slug` for the `/docs/x` of
  `/docs/*`), the next is sent, and a wildcard is tried at one and at two
  segments, so a shadowed surface is judged by its own chain or reported, never
  by another surface's answers. `accessMatrixSession` is the session resolver
  an app under the matrix uses; `probes` adds a probe builder for a surface
  kind; the `access_matrix.*` codes name an invalid persona, an unreadable
  target, a missing probe builder and a `codeActivating` id that names no
  registered surface.
- **`access` gate (`npm run check:access`).** Runs the access matrix over one
  fixture app per first-party plugin that serves HTTP and over each starter
  preset that serves HTTP (generated, compiled and assembled in process); the
  invariants that do not hold yet are pending in
  `scripts/expected-failures/access.json` with the package that fixes each,
  and a pending one that holds fails until its entry is removed. It also fails
  a matrix that went blind: an app that resolves sessions where no
  administrator (cookie) or exact-scope token (token) request was identified,
  a surface of the route-registration snapshot app that no app's matrix holds
  as registered there, and a known code-activating surface an app does not
  declare.
- **Plugin gates.** `unconverted-plugins` holds every first-party plugin on the
  new contract (the option rule, an awaited `testPlugin` run in its tests, and
  a config entry that loads no `typeorm`, `better-auth` or `bullmq`), with the
  plugins still on the `JsailsPlugin` contract in a shrinking ledger;
  `plugin-manifests` checks a kernel plugin's manifest against its runtime
  definition (name, env, schema slot, `services.provide`); `process-env`
  keeps reads of the process environment, through `process` or the `process`
  module, to process boundaries allow-listed file by file.
- **HTTP routes and the mode for `definePlugin` plugins.** Setup receives
  `routes`, the instance's HTTP registrar (`add`, `guard`, `transform`, and
  `mount` for a code plugin), whose registrations run in the request pipeline
  with stated access, are stamped with the instance's name, and are refused
  after setup returned (`plugin.routes_closed`); and `mode`
  (`'development' | 'test' | 'production'`), read from the `NODE_ENV` of the
  runner's environment. `testPlugin` returns what setup registered as `http`
  and derives `mode` from its `env` option. `jsails/kernel` also exports
  `publicAccess`, `legacyAccess` and the route types, and `boundObject`, an
  option schema for an object of data and methods a caller may pass as a class
  instance (each method bound to it).
- **`@jsails/notifications/database`.** The `jsails_notifications` entity and
  `createDatabaseNotificationStore` moved to this subpath, so importing
  `@jsails/notifications` loads no TypeORM. `mailTransportToken`
  (`@jsails/mail`) names a transport another plugin provides.
- **The kernel loader and plugin graph (`jsails/kernel`, `jsails`).**
  `jsails.config.ts` default-exports `defineApp({ env, config })`, a typed
  app definition whose `config` function receives the parsed variables; a
  misspelt key is a type error. `loadApp({ configPath, cwd, env })` scans the
  config's import graph before importing it (npm packages and erasable
  modules under `config/` only, so a `#` subpath import and the app's own
  package name are refused like a relative path into the app;
  `config.outside_graph`, `config.non_erasable_syntax` and
  `config.invalid_syntax` name the file, line and column, never the source),
  parses its variables (`config.invalid_app_env`), and seals its activation
  mode onto the `LoadedApp`. A `config` function must return the config
  object itself (`config.async_config` for a promise). Without `env`, the
  loader takes the environment the bin applied or, in a process the bin did
  not start (a test file, a custom server), resolves it as the bin does,
  without applying it. `resolvePlugins(app, { safeMode })` returns the
  `PluginGraph` in setup order (each provider before the plugins that depend
  on its service, framework plugins, `plugins.use`, then extensions breaking
  ties) and refuses a dependency
  cycle, an unprovided required service, a duplicate name or a duplicate
  provider before any setup (`config.misconfigured`). `createApplication`
  and `createTestApp` take a loaded app (`createTestApp` also takes the `env`
  a config module reads); `createLoadedApp(config)` builds one in process.
  `jsails describe` reads the safe-mode graph (`plugins.graph`), so a
  `plugins.use` plugin's components and commands are described too.
- **Locked and managed activation.** `plugins.activation: { mode }` states
  who may activate plugin code: `'locked'` (the default) runs only
  `plugins.use`; `'managed'` is for a site its owner runs, where a
  marketplace plugin source may add verified plugins (none ships yet, so a
  managed app runs the same plugins). The mode is a
  literal written as `plugins: { activation: { mode } }` in the config
  (`config.activation_not_literal` for one computed from a variable, an
  import or a condition, `config.activation_repeated` for a second one,
  `config.activation_mismatch` and `config.activation_unstated` when the
  config returns another mode than the literal states); an `activation` key
  anywhere else is not the mode. No environment variable, settings schema or
  flag of a command that runs an app selects it, and only the plugin resolver
  reads it. Only a
  managed graph outside safe mode carries a `SchemaAuthority`. Every
  `jsails create` preset ships locked.
- **`legacy-config` gate.** The app config keys the kernel no longer has go
  through one compat mapper (`LEGACY_CONFIG_SURFACES`), each ledgered with
  the package that removes it; the list only shrinks.

### Changed

- **Pages answer with a typed outcome.** A page's `load` returns its props or
  a `reply` from `jsails/pages`: `reply.props(props, { status, headers,
  cookies })` (one `Set-Cookie` per cookie, `SameSite=Lax` and `HttpOnly` by
  default), `reply.redirect(path)` (same-origin, 302 by default),
  `reply.redirectExternal(url)` and `reply.notFound()`; arguments are checked
  when the reply is built (`reply.*`, `redirect.*`). `PageProps<typeof load>`
  unwraps a props reply and leaves redirects out. A `PageRenderer` answers
  with a `PageOutcome` (a document as bytes or a stream, a redirect, or
  not-found), which the server maps one to one onto a response body and the
  static export onto files: a redirect leaves a fallback document and an
  entry in `redirects.json`, not-found writes nothing, a document at an
  error status (a `reply.props` 4xx, or an error boundary rendered for a
  `load` that failed during the build) fails the export with `error_status`,
  and a reply with headers or cookies fails it with `reply_not_static`;
  `jsails build` names every not-found page and redirect. Only a document at
  200 without headers or cookies of its own takes a page's public
  `cacheControl`: a redirect, another status, or a reply's headers make the
  answer `private, no-store`. A reply cookie defaults to `Secure` when the
  request's resolved origin (the canonical origin or a trusted forwarded
  scheme) is https. `documentOutcome(html)` wraps a string for a custom
  renderer. Pages are
  buffered: `render.stream` is removed and a page streams with
  `export const stream = true`; `stream = false`, and `stream` beside `cache`
  or `cacheControl`, are refused. `renderRouteStream`,
  `renderStreamResponse`, `StreamingPageRenderer` and their option types are
  removed. An error boundary's status comes from the failure mapper (a thrown
  `notFound()` renders 404), and a boundary that renders a 500 reports the
  failure. A page producer's silence is bounded by `render.streamTimeoutMs`;
  a producer cut off at that bound has as long again to run its cleanup
  inside the request before the body fails, and a cleanup that fails is
  reported with phase `stream`.
- **One redirect-target rule.** `Respond.redirect`, `reply.redirect`, a
  server-component action's `redirect` and `@jsails/inertia` accept only a
  same-origin path (no `//host`, backslash, control character or `..`
  segment), percent-encoding what a header cannot carry; an off-origin target
  needs the explicit `Respond.redirectExternal` (or `reply.redirectExternal`),
  which refuses credentials in the URL. `safeRedirectPath(input, fallback)`
  and `isSameOriginPath` are exported from `jsails/api`; `assertRedirectTarget`
  and its scheme blacklist are removed. `@jsails/inertia` takes its mode from
  `defineInertia({ mode })` (production by default) instead of `NODE_ENV`.
- **Public files are an asset index.** `createAssetIndex({ roots })` (in
  `jsails/app`) walks `public/` once, never following a link, and records
  each regular file's path, size and content hash (SHA-256, base64url, 16
  characters), holding files up to 64 KiB in memory; `Application` builds it
  on first use (a watching index under `NODE_ENV=development`, a snapshot
  otherwise) and shares it between `serve`, `fetch` and `build`.
  `createApp({ assets })` answers a `GET` or `HEAD` of an indexed path after
  the guards and before routing, so a public file wins over a parametric,
  catch-all or mount route (the `JSAILS_PUBLIC_FILE_SHADOWED` warning is
  gone); another method on its path is a 405 with `Allow: GET, HEAD`; an
  asset equal to a literal route or a reserved path fails assembly
  (`asset.route_collision`; a development index warns
  `JSAILS_ASSET_ROUTE_COLLISION` and lets the route answer). Answers carry a
  strong content `ETag`, `must-revalidate` unless `?v=` is the current hash
  (then immutable for a year), one byte range with `If-Range`, and a 304
  without touching the disk; a snapshot file that changed size answers 500,
  reported once as `asset.stale_assets`, and a production start that hashed
  the files of `public/` itself warns `JSAILS_ASSETS_NOT_BUILT`. In
  development a request that races a rewrite is answered again from the new
  bytes. `/.well-known/` is served; every other dot-name, symlink and
  special file is left out of the index (symlinks and unservable names
  counted in one `JSAILS_ASSETS_REFUSED` warning), a file or directory the
  server may not read is left out and counted in one
  `JSAILS_ASSETS_UNREADABLE` warning, and any other read failure is
  `asset.read_failed`, naming no location. The static export copies exactly
  the index, so a symlink in `public/` no longer fails `jsails build`.
  `assetRowsOf(app)` lists the files an app serves, beside `routeTableOf`.
  `context.assetUrl` is synchronous (the index's `url`): the starters'
  `loadLayout` returns its URLs directly. `createPublicFilesMiddleware`,
  `createAssetUrlResolver`, sibling `.br`/`.gz` variants, `createApp({
  assetUrl })` and `generateStaticSite({ publicDir, assetUrl })` are removed:
  pass `assets`.
- **One command descriptor table, a static manifest, and a zero-import bin.**
  Every built-in command is a frozen descriptor in the CLI manifest
  (name, summary, options, positionals, details, what it `needs` and whether
  it reads secrets, and a `load()` of its module), and that module imports
  only types. One dispatcher parses each command's arguments with
  `node:util`'s `parseArgs` against its declared options, so an unknown flag,
  a missing argument or an extra one is a usage error (exit 2) that names the
  flag only, never a value, and every `--help` is generated from the
  descriptor without resolving the environment (`api/cli.md` holds the help
  of every command, and the `cli-signature` gate compares it). The dispatcher
  then resolves the environment, opens the stages the command needs
  (`environment`, `app`, `plugins`, `{ services }`, `{ kernel }`) and closes
  them after `run`, the last first. `--env <name>` is the only option before
  the command, `jsails --version` prints the version, and `jsails` alone
  prints the help. The bin is `dist/src/cli/bin.cjs`, ES5 CommonJS that
  checks the Node major and refuses an older Node with the floor it needs
  (exit 1) before it imports the CLI; `create-jsails` gets the same shim.
  `jsails --help`, a command's `--help` and a usage error load no
  third-party module and import nothing from the project (the `cli-graph`
  gate keeps zod, typeorm, bullmq, hono, preact and the app config loader off
  the bin's static graph). `make` is one command per type
  (`jsails make:page`, ...), each with its own help; the `create` presets are
  one at a time, and the push-only flags are unknown options to `db:diff`.
- **Commands come from the app and its dependencies, not the app config.**
  `jsails a:b` runs the app's `dist/commands/a/b.js`, the build of
  `commands/a/b.ts`, or a command a direct dependency lists in the
  `jsails.commands` field of its `package.json` (`{ name, summary, module }`).
  A command module default-exports `defineCommand({ summary, options,
  positionals, needs, details, run })` (from `jsails` and `jsails/kernel`);
  `run(context)` gets the parsed `values` and `positionals`, the resolved
  `env`, a `prompter` that fails under `--no-interaction`
  (`cli.interactive_unavailable`), and the stages its `needs` opened. Help
  lists both sources without importing them: an app command with the summary
  `.jsails/commands.json` recorded the last time its built file ran (keyed by
  the file's SHA-256, so an edited command shows none), a dependency's from
  its manifest. A name two sources declare is `cli.ambiguous_command`, a
  built-in's name that a dependency or the app declares refuses that built-in
  (`cli.reserved_command`), a first-party command whose package is not
  installed `cli.missing_dependency` with the package to install, and a
  module that fails to load or exports no `defineCommand` value
  `cli.load_failed` / `cli.invalid_command` (`CliErrors`, value-free). The
  stages a command's `needs` opened are closed after it; a failed close
  (a kernel's shutdown report included) fails the command, reported with the
  run's own failure when both fail. `runCommand` (`jsails/testing`) runs a
  command in-process and refuses an exit code `jsails` would refuse
  (`cli.invalid_exit_code`), and `make:command` writes a command and a test
  that use it. `defineCommandJob`, in `jsails/jobs` and in `@jsails/jobs`,
  takes a `defineCommand` value that needs only the environment and a job
  `name`, and parses its args against the command's options
  (`command_usage`).
- **`@jsails/config` is a `definePlugin` plugin.** `configPlugin({ sets,
  store?, overrides?, syncDir? })` checks its options when called
  (`config.invalid_options`), requires the cache services and the store named
  by `store` (a `configStoreToken` service another plugin provides), and
  provides `configToken` and `configSyncToken`; `ConfigPlugin.config` is
  gone. It owns the `jsails_config` table through its `schema` contribution,
  whichever store the app provides. The database store moved to
  `@jsails/config/database` (`createDatabaseConfigStore`, `configEntities`,
  `JsailsConfigEntry`, `CONFIG_TABLE`), so importing `@jsails/config` loads
  no TypeORM.
  `configAdmin()` takes no `config`: the page resolves `configToken` and the
  admin plugin requires it, so a panel without the plugin fails at boot.
  `config:export` and `config:import` are the package's `jsails.commands`
  (`@jsails/config/commands/export` and `/import`), run over the app's
  services.
- **Shutdown is a drain protocol with participants.** A serve hook returns
  what it attached to the server as a drain participant (`ServeAttachment`:
  `name`, `drain(deadline)`), and a hook that adds an `upgrade` listener
  without one fails the serve (`serve.missing_attachment`); the broadcast and
  live plugins return their Socket.IO transports, whose drain
  (`Broadcast.drain`, `LiveSocketHandle.drain`, and an optional
  `BroadcastHandle.drain` for a custom adapter) disconnects their clients
  without awaiting the HTTP server's close, so a slow request is never blamed
  on them; `close()` still closes the server too. `close()` drains under the one
  `shutdownTimeoutMs` deadline: readiness 503 and no new connections, then
  every participant and every live stream end concurrently (a live answer's
  producer is cancelled and its `ctx.signal` aborts with `serve.draining`)
  while in-flight requests and finite streams finish. At the deadline every
  remaining request's signal aborts (`serve.stopped`), an unfinished stream is
  reported as `serve.unfinished_stream`, every accepted socket is destroyed,
  and `close()` rejects with `serve.shutdown_timeout` (`ServeErrors`, from
  `jsails/app`), counting what was open and naming the participants still
  draining; the hand-written `ShutdownTimeoutError` is gone. A live answer is
  classified once, on its request frame, instead of by patching `writeHead`
  and sniffing `text/event-stream` heads at the socket.
- **Standby and listen-on-handle.** `app.standby({ handle? })` runs every
  serve hook and resolves with the server ready and accepting nothing until
  `accept()`; with `handle` (a listening socket's native handle passed over
  IPC, or `{ fd }`) it accepts on that socket, so a supervisor's candidate
  process reports ready while connections wait in the backlog.
  `app.serve({ handle? })` is both in one call. A failed `accept()` releases
  the server (the app can serve again); Windows, a development platform,
  refuses every handle with `serve.unsupported_platform`.
- **Roles, lifecycle units and one shutdown owner.** A process runs roles
  (`web`, `worker`, `export`): `jsails serve` the `web` role (`--with worker`
  adds the `worker` role), `jsails work` the `worker` role of the same
  `jsails.app.js`. A plugin's long-running work is a lifecycle unit
  (`lifecycle.register(roles, { name, start, drain(deadline), abort, ready? },
  { after?, transport? })`); the kernel stages are `openServices` (setup,
  connection-free, then the unit plan: `kernel.duplicate_unit`,
  `kernel.unknown_unit`, `kernel.unit_cycle`) and `start` (units of the
  process's roles in dependency order; a failed start aborts the started units
  in reverse). Shutdown drains the HTTP server, then the units in reverse
  dependency order, independent ones together, under the one
  `shutdownTimeoutMs` deadline; a unit not idle at the deadline, or at a second
  SIGINT/SIGTERM (`close({ signal })`), is aborted with one more second for its
  abort, and an abort with no error of its own rejects with
  `kernel.shutdown_timeout` (`KernelStageErrors`, `jsails/app`). A unit's
  `ready` joins the readiness probes. A transport declares its reach
  (`process` or `shared`), and a process running only some of the roles over a
  `process` transport is refused with `kernel.adapter_not_shared`. The legacy
  `ExtensionContext` gains `lifecycle` (a managed plugin is refused it), and
  the CLI's one shutdown module is the only process-signal listener in core.
- **The jobs worker is part of the app.** `jobsPlugin` registers `jobs.producer`
  (web and worker) and `jobs.worker` (worker, after the producer) on the `jobs`
  transport with its adapter's reach (in-memory `process`, BullMQ `shared`;
  `JobsRuntimeAdapter.reach`), and takes the worker's `schedules` (else the app
  root's `jsails.schedules.json`), `overlapLeases`, `failedJobs`,
  `jobTimeoutMs` and `shutdownTimeoutMs`. Job handlers run with the app's
  plugins and services. `JobsRuntime.abort()` returns in-flight attempts to the
  queue at once. The runtime config serves the inspection commands only and
  refuses `extensions`. `createApplication(app)` without `roles` runs both
  roles, so a custom server entry that serves it consumes the queue too (pass
  `roles: ['web']` for a web-only process); `jsails dev` serves both roles, so
  an app on the in-memory adapter runs under it. `jsails work` refuses a worker
  with no unit of its own (`kernel.no_units`, `Application.dedicatedUnits`): a
  unit every role registers, such as the `valkey` connection, does not count.
- **`valkeyPlugin` is a kernel plugin.** It declares `VALKEY_URL`, validates
  its options through its schema (`config.invalid_options`), connects its
  `command` role in its `valkey` unit when the process starts, and reports a
  `valkey` readiness probe. The default app prefix follows the process mode
  (`<app>:production` when `NODE_ENV` is unset), the same in a plugin's setup
  and a runtime config, and the legacy `ExtensionContext` carries `mode`.
- **`measureLeaks` and `measurePluginLeaks`** (`jsails/testing`) count the
  process's active resources and listeners over repeated open/start/shutdown
  cycles; the `plugin-leaks` gate holds every first-party kernel plugin to
  them.
- **Plugins never receive the router (REQ-05).** `configureHttp`,
  `HttpExtensionHook`, `HttpHookRegistration`, `ExtensionRuntime.httpHooks`,
  `createApp({ httpHooks })`, `hookRoute`/`HookRouteLimits`, the `hook` route
  kind, `hook:<owner>` surface ids and the `route-owned` access kind are
  removed: an extension adds routes only through `routes.add` and
  `routes.mount`, each with its access and credentials, and a Hono app is
  served whole through `routes.mount(prefix, app.fetch, options)`.
  `defineDeclarativePlugin`'s `http` hook is `routes`, called with the
  plugin's registrar (`declarative_plugin.invalid_routes` for a non-function,
  `declarative_plugin.removed_option` for a spec that still declares `http`,
  `declarative_plugin.unknown_option` for any other key the spec does not
  have). The app-wide middleware chain is gone with it: the app config's
  `middleware` map and `globalMiddleware` (refused with
  `config.removed_option`, which names the replacement),
  `configureMiddleware`, middleware names in a route module's `middleware`
  list (`RouteMiddlewareRef`, `server/middleware-refs.ts`) and `createApp`'s
  `globalMiddleware`/`middlewareMap`; a wall is a guard, a rewrite of every
  answer of a route kind a `routes.transform`, and `RouteMiddleware` wraps
  one route. `routes.transform` requires the `http.transform` permission and
  `http.middleware` leaves the permission registry. Assembly compiles the
  framework routes, the registrars' mounts, their `/_jsails` routes, their
  other routes, then the filesystem routes. The introspection pipeline lists
  one `middleware` stage.

- **The app config is the kernel's `AppConfig`, plus ledgered legacy
  keys.** Its schema is strict and fully typed (`plugins.use` takes plugin
  instances, `http.guards` guard functions). `plugins.managed` is replaced by
  `plugins.activation: { mode: 'managed' }`, and `plugins.force` and the
  `{ specifier, … }` descriptor form of a `plugins.use` entry are removed;
  naming one is `config.removed_option`. `defineAppConfig`, `loadAppConfig`
  and `normalizeUseEntry` are removed (use `defineApp` and `loadApp`), and so
  is `jsails app:shape`. `db:push`, `db:diff`, `jsails build` and the plugin
  commands read the plugin graph; the commands hand on the environment the
  bin resolved instead of reading the process environment.
- **The old plugin installer, plugin state store and activation are
  removed.** No database row, file or admin page activates plugin code in
  either activation mode: a plugin runs when `plugins.use` lists it. Gone from
  `jsails/plugins` (and the root barrel): `createPluginInstaller`,
  `extractTarGz`, `PluginStateStore`, `createDatabasePluginStateStore`,
  `pluginStateEntities` and the `jsails_plugin_state` entity,
  `resolvePluginEnablement`, `loadPluginEnablement`, `activatePlugins`,
  `exportPluginSnapshot`, `importPluginSnapshot`, `resolveDownloadsCapability`
  and the bundle half of discovery (`pluginsDir`, `PluginSource`,
  `PluginDirent` and `PluginFs.readdirSync`). The
  config options `plugins.enabled`, `downloads`, `stateSource`, `pluginsDir`
  and `allowLoadFailures` are `config.removed_option`. `jsails plugins` keeps
  `list` and `check`, which read `package.json` manifests only; `install`,
  `uninstall`, `enable`, `disable`, `rollback`, `resolve`, `export` and
  `import` are a usage error. `@jsails/admin-plugin-manager` is removed. The
  `PluginGraph` has no `managed` origin and no `issues`; it reports
  `liveOnly`, the declared plugins a static export leaves out, `plugins.use`
  instances included. The `describe` and introspection `plugins` sections
  report the graph, and `describe`'s `liveOnly` is the graph's.
- **`devPlugin`, `mailPlugin`, `webhookPlugin` and `notificationsPlugin` are
  `definePlugin` factories.** Their options are data checked by strict schemas
  when the factory is called (`config.invalid_options`, echoing no input) and
  their setups are inert. `devPlugin({ enabled? })` defaults `enabled` to the
  development mode, declares `JSAILS_DEV_GENERATION`, registers the reload
  stream as a public route and injects the client through a response
  transform on page, API and mount answers (`devReloadMiddleware` is replaced
  by `devReloadTransform`). The reload stream is a `Respond.eventStream` that
  ends, releasing its heartbeat timer and generation subscription, as soon
  as the request's signal aborts or the stream is cancelled. `mailPlugin` takes `transport` as a `mailTransportToken` (no
  transport instance), declares `MAIL_URL` and `SMTP_URL` as secrets read
  from the resolved environment, reads the jobs service as an optional
  service, requires `previews` to carry JSON preview props and unique names,
  and registers its preview routes as public routes in development mode.
  `webhookPlugin` takes no `cache` store: it requires the `@jsails/cache`
  plugin and claims deliveries in a namespace of the application cache
  (`cache`, default `webhooks`); its endpoints are validated by the schema
  (an invalid one is `config.invalid_options`, no longer a
  `WebhookError('invalid_endpoint')` at construction) and registered as
  public `POST` routes that skip the cross-site check. `notificationsPlugin`
  takes `database` as a `notificationStoreToken` another plugin provides (it
  no longer provides the store or declares the table), takes
  `broadcast.publisher` as a function only, reads channels through their
  bound `send`/`deliver`, refuses options that add no channel with
  `config.invalid_options` (its options are no longer optional), and reads
  the jobs and broadcast services as optional services. `notify` rejects with
  `NotificationError('no_channel')` when it selects no channel, as with only
  the opt-in `database` and `broadcast` channels configured, instead of
  resolving undelivered. `@jsails/mail` and
  `@jsails/notifications` pin `jsails` to the exact version, since they read
  those tokens from `jsails/internal`.
- **A server module is never a route.** Route discovery skips `x.server.ts`
  and its compiled `x.server.js` under `pages/` and `api/`, which failed
  discovery with `invalid_segment` before.
- **A static export refuses a server component it cannot render.** The
  refusal is `component_static.missing_fallback` for a component without a
  static form, `component_static.initial_denied` for a denied
  `staticRender: 'initial'`, and `component_static.render_failed` (its cause
  the failure) for a static form that throws, renders a bound form that could
  navigate, or nests past the depth bound, replacing
  `ServerComponentRuntimeError('missing_fallback')`. The page that renders it
  fails the build as `PageRenderError('invalid_route')` naming the route,
  past any error boundary, instead of exporting the error page in its place.
  A `renderNested` child of a static form renders static, inline and within
  the same depth bound as a served one.
- **`loadingTarget()` without a selector marks its own element**, and the
  live client honours a loading-target marker on any element the component
  owns (it read only the root's, which a render cannot set). `js-loading`
  takes no value.
- **`encryptionPlugin()` takes no options.** It declares
  `JSAILS_ENCRYPTION_KEY` (a secret of at least 32 characters) and
  `JSAILS_ENCRYPTION_PREVIOUS_KEYS`, the variables the model encrypter reads, so
  a key never sits in config; a missing or short key is `config.invalid_env`.
- **`themePlugin` and `diagnosticsPlugin` are `definePlugin` factories.**
  Their options are checked by strict schemas when the factory is called.
  `diagnosticsPlugin` no longer accepts a `recorder` instance: it builds its
  recorder from `maxEntries`, `clock`, `tags`, `monitored` and `filters`, and
  an application with its own recorder provides `diagnosticsToken` from its
  own plugin.
- **`routingPlugin`, `pagesPlugin`, `i18nPlugin`, `loggingPlugin`,
  `cachePlugin`, `flagsPlugin` and `filesystemPlugin` are `definePlugin`
  factories.** Their options are data checked by strict schemas when the
  factory is called (`config.invalid_options`, echoing no input), their
  setups are inert, and an instance a plugin used to take is now a service
  another plugin provides, named by a token option:
  `cachePlugin({ store })` takes `'memory'`, `'valkey'` or a `cacheStoreToken`
  (new in `jsails/cache`) and declares its own optional `VALKEY_URL`, whose
  connections it owns and closes; `cachePlugin({ leases: { store } })` is gone
  (provide `leaseToken` yourself). `flagsPlugin({ store })` takes a
  `featureStoreToken` and no longer carries `.flags`; `flagsAdmin` and
  `defineFlagsAdminPage` take no `flags`, resolve `flagsToken` from the
  request's application and declare `requires: [flagsToken]`, so a panel
  without the flags plugin fails at boot. `loggingPlugin({ diagnostics,
  signals })` take `diagnosticsToken` and `signalsToken`, and channels are
  `{ name, minLevel, write }` objects whose `write` stays bound to the
  caller's channel (a class instance keeps its `this`).
  `filesystemPlugin({ disks })` takes disk specs (`{ driver: 'local', root }`,
  `{ driver: 'memory' }`, `{ driver: 'env' }`) and declares the
  `FILESYSTEM_*` and `S3_*` variables, refusing a set-but-blank
  `FILESYSTEM_DISK` before any setup; `createDiskFromEnv(env, { rootDir? })`
  takes the environment explicitly. The blog starter's media library stores on
  the plugin's own `files` disk through a per-operation resolver.
  `routingPlugin({ pagesDir, apiDir })` reads the app root from its setup and
  is no longer exported from `jsails/routing`: the framework adds it to every
  application, and the subpath keeps `routeManifestToken` without loading the
  plugin contract. `i18nToken` and the `I18n` facade likewise no longer load
  the `i18n` plugin.
  `diagnosticsToken` and `signalsToken` are token families.
- **`@jsails/flags` no longer loads TypeORM.** The database store,
  `JsailsFeatureFlag` and `flagsEntities` move to `@jsails/flags/database`.
- **A plugin definition records its static tokens.** `PluginDefinition` has
  `requires`, `optional` and `provides`: the frozen tokens of a literal list,
  or `undefined` when the list is computed from the options. The
  `plugin-manifests` gate reads plugin dependencies from token objects for
  both contracts (a kernel plugin's literal lists, else its zero-config
  instance; a legacy plugin's identifiers resolved through its imports), so a
  kernel provider such as `cache` stays the dependency of `config` and
  `flags`.
- **The cache tag table starts its sync timer on first use.** Setting up the
  cache plugin starts no timer.
- **An entry waits for a required service a later legacy extension
  provides.** A legacy extension declares no service it provides, so an
  entry (a `definePlugin` instance or an extension) whose required service no
  instance declares, and that is not registered at its turn, waits with every
  entry ordered after it until a later setup registers it, and fails with its
  `missing_service` error only when nothing does. A logging, cache or flags
  token option therefore works with a provider in the app's `extensions`,
  which run after `plugins.use`. An entry whose services are registered at its
  turn runs where the sort put it.
- **`envVar.string({ refuseBlank: true })` (`jsails/kernel`).** A variable so
  declared fails `config.invalid_env` (problem `blank`) when set but blank,
  instead of reading as unset.
- **Admin pages and admin plugins declare the services they read.**
  `defineAdminPage({ requires })` and `defineAdminPlugin({ requires })` carry
  service tokens; the `admin` plugin requires those of the panel's `pages`
  and `adminPlugins`, and its setup refuses (`missing_service`) a contributed
  page whose service nothing registered.
- **`createMediaLibrary({ disk })` takes a disk or a function returning one**,
  called on each operation, so the library can store on a disk a plugin
  provides once the application is set up. A resolver failure is a value-free
  `io_failed`.
- **`collectPluginSchema` replaces `collectPluginSchemaEntities`
  (`jsails/plugins`).** It is async and returns `{ entities, unmanagedTables }`
  for legacy plugins and `definePlugin` instances alike, loading each
  instance's lazy `schema` contribution.
- **`jsails/plugin-sdk` no longer loads TypeORM.** `isUniqueViolation`
  recognises TypeORM's `QueryFailedError` by name, so a plugin that imports the
  SDK keeps TypeORM out of its config entry.
- **`describe().needsLive` has a token form.** The live-only selection reads
  live tokens on plugin instances and `describe().needsLive` on extensions;
  `core/src/plugins/live-only.ts` is replaced by the contract's liveness module.
- **One response finalizer and one failure renderer.** `app.fetch` is the
  framework's request handler around Hono's routing: the request id and frame
  open first (a host the app does not serve is a sealed `421` before any app
  code), the guard tier and every route then run in one execution context, and
  every answer, a guard's, a route's, or a failure's, leaves through one
  finalizer (`core/src/server/output.ts`): the one cache policy
  (`decideCache`), content coding negotiated once (brotli or gzip, never below
  1 KiB), a strong content `ETag` for storable bytes with a `.br`/`.gz` suffix
  per coding, `304`, then the request id and security headers, installed as
  bytes with `Content-Length` that the Node server writes in one `end()`.
  Bodies are classified without sniffing: `Respond` helpers, pages, and error
  pages record theirs (a stream teed by `Response.clone()` included), and a
  foreign body is read only while it is already available (until the next
  macrotask, up to 64 KiB or its declared length), so a stalled producer never
  holds back the head; a body something already read is a reported `500`
  (`response_finalizer.body_taken`). A `HEAD` is finalized from the
  `GET` answer. Deleted: the compression, ETag, cache-control, security-header,
  method-not-allowed and thrown-value middlewares, `streamed-response.ts`,
  `attachNoStore`, `applyDefaultCacheControl`, and `wrapPublicResponse`.
- **One route spine: the route table, the route boundary, the access chain.**
  Every route, whoever registers it (filesystem API and page modules, the
  server-component transport, introspection, health and readiness, an
  extension's registrar), is recorded in a route table
  (`routeTableOf(app).entries()`: kind, methods, pattern, access, credentials,
  surface kind, owner, origin) and compiled into one route boundary with a
  fixed order: frame entry, the rate-limit hook (`createApp({ rateLimit })`),
  the claim, the access chain (see the surface registry entry below),
  middleware, handler, response transforms; a throw anywhere is reported once
  and rendered inside the claim's bindings. Every route states its access
  (`publicAccess(reason)` from `jsails/api`, or a check function); there is
  no default. Assembly refuses a method and pattern
  registered twice (`route.duplicate_route`), a route under a mount or a
  mount under another (`route.mount_overlap`), a reserved path (the health and
  readiness paths, introspection, the component endpoints, the `/_jsails`
  namespace for app routes and managed plugins: `route.reserved_path`), and,
  under `pluginOrigins: 'code-only'` (the default; `'allow-managed'` when
  the activation mode is managed), a managed plugin's route
  (`route.managed_origin_refused`) or response transform
  (`route.managed_transform_refused`). Routes compile in precedence order, so
  a path a route owns reaches it before any catch-all that could also match
  it: the framework routes (each answering a method it does not serve with a
  405), the registrar's mounts, its routes under `/_jsails`, the hook routes,
  its other routes, then the filesystem routes. The 405 answer reads the route
  table.
  Deleted: `method-table.ts`, the per-route CSRF and authorize middlewares,
  `buildHandlerChain`, `routeTerminal` and its staged-header adoption,
  `createRouteEntry`, `registerIntrospectRoute` and its explicit 405 routes,
  `assertNoIntrospectRouteCollision`, the component-route collision check.
- **The surface registry and one access chain; the CSRF token is gone.**
  Every route and the app's asset index are registered as surfaces
  (`jsails/security`: `SurfaceDescriptor` with `id`, `kind`, `match`,
  `access`, `action`, `credentials`, `body` and `owner`; `surfacesOf(app)`
  lists them). Registration refuses a surface without access
  (`surface.missing_access`), an id registered twice
  (`surface.duplicate_surface`) and a malformed one
  (`surface.invalid_surface`), so assembly fails. Every route request passes
  one access chain inside the route boundary, after the claim: the cross-site
  check, then the gate. The cross-site check applies to every unsafe method
  on a surface whose credentials include `cookie`, for every caller,
  anonymous included: the request's `Origin` must equal the origin it was
  addressed to exactly, or, without `Origin`, `Sec-Fetch-Site` must be
  `same-origin`; anything else (`Origin: null`, `Referer` alone, no header) is
  `403 access.cross_site`. A session `resolveSession` marks as
  header-authenticated (`data.authMethod` of `bearer` or `api-token`) is
  exempt. A route states the credentials it accepts with `credentials`
  (`defineApi`, `RouteSpec`, `MountOptions`): `['cookie', 'token']` for a
  filesystem API route, `['cookie']` for a page, a registrar route, a mount
  and the component transport, `[]` (no cross-site check) for a route that
  reads no credential. The list is enforced: a route's claim, request
  scopes, gate and handler see a session only when it came from a kind the
  route accepts (a cookie session is anonymous on a `['token']` route, a
  header-authenticated one on a `['cookie']` route), and a `[]` route never
  calls the identity source, so leaving out `cookie` cannot switch off the
  cross-site check for a route that still acts on the cookie. The gate admits a public surface, and a check only on
  exactly `true`; a denial is `401 request.unauthenticated` without a session
  and `403 request.forbidden` with one, and a throwing check is a reported
  `503 access.fault` instead of a silent deny. Every denied answer is
  `Cache-Control: private, no-store` with no `Set-Cookie` or
  `Surrogate-Control`, whatever an error page or an enclosing middleware set.
  A route's public cache declaration applies only when its access is public
  and the caller anonymous (`isPubliclyCacheable`, the cache policy's only
  access input). A check is passed as the route's access directly
  (`defineApi({ access: (ctx) => ... })`); `legacyAccess` is no longer
  exported. The app-wide `authorize` is removed (`config.removed_option`;
  `AppOptions.authorize` too): a method-export API module states an `access`
  or an `authorize` export (both is `route.invalid_definition`), and one
  stating neither fails assembly. Deleted: `Session.csrfToken`,
  `CSRF_HEADER`, `RouteMeta.csrf` and `CsrfRule`, the `csrf` member of
  `defineApi`, `RouteSpec` and `MountOptions`, `createApp({ accessGate })`
  and `access-gate.ts`, `core/src/security/csrf.ts` (with the unused
  in-memory session manager), `trusted-mutation.ts` (`isSameOriginRequest`,
  `requestSite`, `csrfTokenValid`, `checkRequestOrigin`,
  `checkTrustedMutation`; the chain's own check replaces them), the server
  components' CSRF root
  attribute and header and their `csrf_mismatch` code (the chain's check
  replaces the lane's own Origin step), the harness's `csrf` option and
  result member, every `_csrf` form field and `X-CSRF-Token` read in the
  admin, auth, blog and plugin-manager packages (their routes are registrar
  routes, so the chain checks them), `csrfInput` and the
  `csrf` option of `actionForm` (`@jsails/admin`), and the sealed CSRF token
  in `@jsails/sessions` rows (older rows still read). The asset index is
  one surface, `asset:public` (public, reading no credential).
- **Plugins reach HTTP through the registrar; the first-party hook routes
  are gone.** The auth, blog, admin (and with it every admin page: media,
  config, flags, jobs, plugin manager, themes, revisions, menus) and webhook
  plugins register every route with `routes.add`, so each one runs the
  route boundary and the access chain: none of them checks `Origin` itself
  any more, and the route-registration snapshot lists no hook row. A
  registrar route may state its surface kind, `routes.add({ surface })`:
  `'route'` (the default), `'admin'` or `'webhook'` (`route.invalid_route`
  otherwise); the admin panel's routes are `admin` surfaces and the webhook
  receiver a `webhook` one. The snapshot (`api/routes.md`) prints each
  route's surface kind and credentials, and lists the surfaces outside the
  route table (the asset index, `asset:public`); the snapshot's
  `cross-site=handler` rule is gone. The plugin contract (`definePlugin`)
  has no `configureHttp` and its `routes` no Hono verb, and the
  `jsails/no-hono-import` lint rule (`eslint/hono.mjs`) keeps `hono` out of
  every shipped `src/` but the core server modules that still build on it.
  `@jsails/auth`: the Better Auth router is four registrar routes, the
  device-flow `POST /api/auth/device/code` and `/device/token` and the OAuth
  `/api/auth/callback/:provider` reading no credential (`credentials: []`,
  so the CLI and a provider's cross-site form post reach them), and the
  cookie-accepting `/api/auth/*` catch-all, answering `GET` and `POST` only;
  device approval and token management are behind a browser-session access
  (bearer stripped), so a missing session is core's `401`; form routes
  declare a 64 KiB form and the token create a 16 KiB JSON body.
  `@jsails/blog`: the public routes read no credential, and
  `POST /blog/posts` reads a 1 MiB form behind `createRoute.access`.
  `@jsails/admin`: every route's access is the panel's session gate (the
  session resolved once per request and shared with the handler), so a
  refused session is core's uniform `401`/`403`, sealed `no-store`, while
  record-level refusals keep the panel's 403 page; a page states its form cap
  with `maxBodyBytes` (default 1 MiB, at most 100 MiB; the media page passes
  its own through), and a resource's create and update routes read a form as
  large as its file fields allow (their `maxBytes`, a formset's per row, plus
  64 KiB, from 1 to 100 MiB), so an upload above 1 MiB reaches the field's
  own limit instead of a `413`. The `--blog` starter no longer ships
  `pages/blog/index.tsx`: the blog plugin's route owns `GET /blog`. Deleted:
  the internal `assertAdminMutation`, `adminTrustedOrigin` and `readFormBody`
  (`@jsails/admin`), the `publicOrigin` option of `authPlugin`,
  `AuthHandlerOptions` and `ApiTokenHandlerOptions`, `createRoute.authorize`
  and `createRoute.publicOrigin` (`@jsails/blog`), and from
  `jsails/plugin-sdk` `crossSiteVerdict`, `requiresOriginCheck`,
  `isUnsafeMethod`, `CrossSiteVerdict`, `forbiddenResponse`,
  `badRequestResponse` and `notFoundResponse` (a registrar handler throws
  `notFound()` or `forbidden()` from `jsails/errors`).
- **Request bodies are read through a lazy, counted budget.** When the request
  frame opens, a request that can carry a body is rebuilt around a bounded
  copy of its body stream that reads nothing until a reader asks and counts
  every byte against the limit of the route the request reached: its declared
  `body` (`{ kind: 'json' | 'form' | 'raw', maxBytes }`, at most 100 MiB, or
  `{ kind: 'none' }`), else `maxBodyBytes`. A request the cross-site check, the
  access check or a guard refuses costs none of its body; a `Content-Length`
  over the route's limit is answered `413` before the claim (no identity
  resolved), one over `MAX_ROUTE_BODY_BYTES` before routing; a chunked body is
  read up to the limit and no further, whether or not the route raised it;
  and a read past the limit answers `413` whatever the handler does with the
  error (a hook route, a mount and a guard included). Every `413`, and every
  answer of `400` or above that leaves the body unread, carries
  `Connection: close`; the server then half-closes the connection and destroys
  it a second later (`LINGER_MS` from `createHttpServer`'s module), so a client
  still sending reads the answer before the close becomes a reset. Over HTTP/1
  a request with neither `Content-Length` nor `Transfer-Encoding` (a bodiless
  `DELETE`) has no body, is not copied, and keeps its connection when refused.
  A declared over-limit length is answered with the built-in page even when
  the app has an `errorPage`, so it resolves no identity. The app-wide
  `maxBodyBytes` is bounded by `MAX_ROUTE_BODY_BYTES` like a route's own cap.
  `Expect: 100-continue` is no longer answered on
  arrival: `createHttpServer` (now built on the adapter's request listener)
  writes `100 Continue` at the body's first read, so a refused request is
  never invited to send it. Handlers read through `ctx.body` (`RequestBody`:
  `json(schema)`, `form()`, `bytes()`, `stream()`; `RouteContext` is the
  request context with `body` and `signal` set), and outside production a
  reader of a kind the route does not declare throws `body.undeclared_read`.
  The frame exposes the budget as `frame.body` (`BodyBudget`). The component
  upload route declares its exact cap (the file cap plus 64 KiB of multipart
  framing; `uploads.maxBytes` above 100 MiB less that slack is refused).
  Deleted: the global body-limit stage (`createBodyLimitMiddleware`, Hono's
  `bodyLimit`), `routeBodyLimit`, the `maxBodyBytes` route declaration (API
  module export, `defineApi` and `RouteSpec` member), and
  `default-body-limit.ts`; the pipeline stage list reads `body-length`,
  `deadline` and `body-verdict` instead of `body-limit`.
- The server-component upload lane reads its body with the framework's
  streaming multipart reader, under the upload's own parts (the snapshot
  field, then one file, within the lane's `idleMs` and deadline): the
  component-only reader (`multipart-upload.ts`) and the lane's own stream
  guard are deleted, and a part after the file now fails the file with `413`
  instead of `400`. `RequestBody` gains `multipart()`, which throws
  `body.undeclared_read` in production too on a route that declares no
  `multipart` body. A lint rule (`jsails/no-buffered-body-parse`) bans
  `formData()` and `parseBody()` in shipped code outside the `form` reader;
  the admin form guard and the auth forms, which still parse their own form,
  are listed until they move onto `ctx.body`.
- **Handler deadlines.** Every route answers within its `timeoutMs`
  (`defineApi`, `definePage`, a legacy module export, `RouteSpec`,
  `MountOptions`) or the app's `server.handlerTimeoutMs` (`createApp({
  handlerTimeoutMs })`, default 30 s, `0` disables it), armed at route entry
  and covering the rate-limit hook, the claim, the gate, the middleware, the
  handler and the transforms. Past it the frame's signal (`ctx.signal`, now
  the client's abort combined with the deadline, built on first read) aborts
  with `deadline.handler_timeout`, the expiry is reported with the new phase
  `timeout`, and the request is answered `504` (the built-in page when the
  claim never settled); a response that arrives later has its body
  cancelled, and a later rejection is reported with phase `timeout`. A route
  declaring `stream: { timeoutMs }` bounds the gap between two chunks of its
  streamed answer instead (`deadline.stream_idle`); live streams are exempt.
  The server-components transport routes run under their lane's `totalMs`
  plus the app's deadline (`ServerComponentRoutes.laneTotalMs`), so a lane
  answers its own `503 timeout` and an upload's transfer is never cut at the
  app's deadline; `@jsails/admin` pages take `timeoutMs`, and the plugin
  manager's plugins page allows five minutes for an install.
  The route-registration snapshot lists each declared `body`, `timeout` and
  `stream-idle`.
- **`defineApi` and `definePage` (`jsails/api`).** An API module may
  default-export `defineApi(path, { access, credentials?, cacheControl?,
  body?, timeoutMs?, stream?, middleware?, GET, POST, ... })`, whose handlers take the
  request context with `params` typed from the path; the path must be the
  file's route (`route.pattern_mismatch`) and the module exports nothing else
  (`route.invalid_definition`). A page states its access with
  `export const route = definePage(path, { access })`; a denied request gets
  the error page (401 anonymous, 403 signed in) and nothing of the page runs.
  A method-export API module states its access with an `access` or an
  `authorize` export; a page without `definePage` is public.
- **Middleware is `(context, next) => Response`.** `RouteMiddleware` receives
  the route's request context and a single-use `next` resolving to the
  answer, and returns a `Response` (`route.next_called_twice`,
  `route.invalid_answer` otherwise); it no longer receives the Hono context
  and cannot stage headers. It runs after the access gate, and only on the
  route that lists it.
- **The HTTP registrar.** `createHttpRoutes({ owner, origin, confine?, allow })`
  and an extension's `routes` (`add`, `mount`, `guard`, `transform`) add routes
  with a required access, mount web-standard fetch handlers at a literal
  prefix (never at `/`, never for a managed plugin), add guards and add
  response transforms for `api`, `page`, `component` and `mount` routes, all
  passed to `createApp({ contributions })`; a call made on an extension's
  `routes` during a later extension's setup is kept. A managed plugin's `routes` need
  `http.routes` (add, mount), `http.guard` and `http.transform` (transform).
- **One route-module importer.** API, page, layout and error-boundary modules
  load through `loadRouteModule` (compiled `.js`/`.mjs` only, by file URL,
  validated once per path); an import failure is `route_module.import_failed`
  with the failure as its cause, a TypeScript path `route_module.invalid_path`.
  Production assembly (`preloadModules`, default under
  `NODE_ENV=production`) loads every layout, error boundary and not-found page
  through the renderer's new optional `preload(entry)`, so no request imports
  a module. `AppOptions.renderPage` and the `RenderPage` type are removed: a
  page renderer is a `PageRenderer`.
- **Live-only pages stay out of the static export.** `jsails build` never
  writes a page whose `definePage` access is not public (the export renders
  with no session, so the file would serve to anyone what the live route
  gates) or one that exports only a `stream` producer; both are listed in
  `GenerateStaticSiteResult.liveOnly`. A page may export only `stream`.
- **An optional catch-all owns its base path.** Discovery refuses an `index`
  (or a file named like the directory) beside `[[...slug]]`
  (`duplicate_route`), which assembly would otherwise register twice.
- **Errors answer in `application/problem+json`.** Every error answer is one
  RFC 9457 document (`type`, `title`, `status`, `detail`, `code`, `traceId`,
  extension members) built by the error kernel's `problemDocument`; the
  `{ error: { status, code, message } }` envelope is gone, `jsonError` included.
  One mapper (`toFailure`) covers registry errors, `ValidationError` (now `422`
  `request.invalid`, was `400 validation_error`), `HttpError` (which gains a
  `headers` argument), a Hono `HTTPException` (status and headers such as
  `WWW-Authenticate`, the framework's own body), and thrown non-Errors, and
  reports only failures of 500 and above to `onError`. Default-deny and
  resource denials are `request.forbidden`, missing records and routes
  `request.not_found`, oversized bodies `request.too_large`; a wrong method is
  `405 http.method_not_allowed` with `Allow` from a pattern-to-methods table.
  Every error answer is `private, no-store` and keeps its failure's headers;
  an app `errorPage` runs at most once per request, and the anonymous
  not-found page (no route matched: its 404, or the 405 of a path answering
  other methods) is kept for 60 seconds per URL and message (64 entries); a
  404 a route raises, and a render that read the request through its context
  or `currentRequestFrame()`, is never kept.
- **Cache policy.** A declared `cacheControl` applies only to a `GET`/`HEAD`
  answered 200, 203, 204, 301, or 308 for a request without a credential,
  identity, private scope, session or header partition, or cookie-chosen
  locale, and never to a live stream; `404`/`410`/`206` are no longer shared.
  A body too small to encode no longer carries `Vary: Accept-Encoding`.
- **Streaming responses.** `Respond.stream(source, init?, { live? })` and
  `Respond.eventStream(events, init?)` send progressive bodies read inside the
  request's context, compressed and flushed per chunk (event streams never
  compressed); a live stream (`Respond.eventStream`, or `{ live: true }` of
  any content type) is ended cleanly when a server drain starts instead of
  holding shutdown to its deadline. `Respond.withHeaders` and `Respond.withCookies`
  copy a response keeping its recorded body. `RequestContext.cspNonce` is a per-request nonce,
  drawn only when read.

- **Poll options.** `ComponentPollOptions` / `pollAttrs` take
  `whenHidden` and `whenOffline` (`PollPolicy`: `'pause'`, the default, or
  `'continue'`) in place of the `pauseWhenHidden` / `pauseWhenOffline`
  booleans, and an unknown policy is rejected. A cancelled confirm, a spent
  `.once`, or malformed args on a component trigger now prevents its default
  too: a JSails trigger never falls through to the browser.
- **Hono variables are one frame.** `HttpVariables` holds `frame` alone:
  `c.var.session`, `c.var.loadSession`, `c.var.origin`, `c.var.client`,
  `c.var.relayed`, `c.var.trustedPeer`, and the `locale` variable are gone;
  read `c.var.frame` (`origin`, `client`, `relayed`, `trustedPeer`, `id`) and,
  in a route, `c.var.frame.requestContext()` (`session`, `locale`). The session
  a route claimed cannot be swapped by a middleware. `RequestScope` (a
  `(c, next)` wrapper) is replaced by `RequestScopeSpec`.
  `I18nService.resolveRequestLocale` returns a `LocaleDecision`, and a
  `resolveLocale` callback may return `{ locale, vary?, cookie? }`. The
  request-error phase gains `frame`, `guard`, and `stream` (a streamed body
  failing after its head), and a late failure is reported inside the request's context
  and scope bindings.
- **Cache and lease contracts.** `CacheStore` (`jsails/cache`) is an evictable
  store of strings and bytes with no optional member: `get`, `getMany`, `set`,
  `add`, `delete`, `namespace` and `close`, every TTL whole milliseconds up to
  one year, every failure a value-free `cache.*` code. Locks move to a fenced
  `LeaseStore` (`acquire` → `{ key, token, fence }`, `renew`, `release`, and
  `withLease`, which aborts its work once a renewal finds the lease gone or
  none has succeeded within the TTL), so an expired holder can never extend
  or free the next holder's lease; `MutexStore` and its variants are gone.
  A namespace view is shared by everyone who asks for its name, so closing
  one is a no-op and only the store's own `close` stops its views. `@jsails/cache`'s
  `MemoryCacheStore` is a least-recently-used cache bounded by bytes, sweeping
  expired entries first, and `MemoryLeaseStore` never evicts a live lease;
  `ValkeyLeaseStore` runs one Lua script per operation, warns when its server
  may evict keys, and can live on its own server (`cachePlugin({ leases: {
  url } })`). `cacheToken` provides namespaced views only. The rate limiter
  counts apart from every cache, keyed by its limit and window, and the
  webhook replay guard claims deliveries with `add`, refusing at construction
  (or on entry to `verifyWebhookRequest`) any window, a custom verifier's
  included, that no cache entry can hold. `jsails/testing` adds
  `cacheStoreConformance` and `leaseStoreConformance`, and
  `npm run verify:integrations` a `cache` stage that runs them on Valkey.
- **Defined caches with tag tokens replace private TTL caches.**
  `defineCache(services, { name, ttlMs, staleMs?, tier: 'process' | 'shared',
  tags?, valueTags?, codec?, maxBytes?, maxEntries?, stampede? })`
  (`jsails/cache`) is the one way to cache a derived value: `get(key, load)`
  with single flight, caller-driven stale-while-refresh, capture-before-load
  (a load an invalidation overtook is returned, not stored), an optional
  cross-process lease (`stampede: 'cluster'`), per-cache `stats()`, and
  `invalidate(...tags)`. Tag versions are opaque random tokens in the app
  cache (`createCacheTags`, provided by `cachePlugin` under `cacheTagsToken`),
  so a lost token invalidates rather than revives; each process keeps the
  tokens it read, hears invalidations on the Valkey tag bus (`ValkeyTagBus`,
  `<app prefix>:cache:tags`), and re-reads its warm tags every `tags.syncMs`
  (5 s). New codes `cache.invalid_tag`, `cache.too_many_tags` and
  `cache.duplicate_cache`; `jsails/testing` adds `defineCacheConformance`.
  Authorization data must not use a defined cache. `@jsails/config` drops its
  own cache, `cacheTtlMs` and `now`, and `@jsails/flags` reads a scope's whole
  flag set once and checks in memory: both read through a defined cache bound
  in `setup` and invalidate on every write through the service, so both
  plugins now need `@jsails/cache` in the app. `flagsPlugin(...)` carries its
  service as `.flags`, and `flagsAdmin`/`defineFlagsAdminPage` take that
  service (`{ flags }`) instead of a store (`{ store }`), so an admin toggle
  invalidates the runtime cache; the `jsails-config` and `jsails-flags`
  manifests declare `jsails-cache` in `plugins`, and the `plugin-manifests`
  gate requires such an entry for every service a first-party plugin always
  requires from another. Reads wait for the tag bus subscription only until
  an attempt fails; failed attempts are retried with a backoff from the sync
  timer, and tags read meanwhile are re-read once it is live. The `cache`
  stage of `npm run verify:integrations` times an invalidation reaching a
  second process over the bus and, with the bus off, through the sync.

- **The MariaDB schema lock of `db:push` is named from the connected
  database.** `withSchemaLock` digests `SELECT DATABASE()` instead of the
  data source's `database` option, which a `url` configuration leaves
  empty: url-configured apps on one server no longer share one lock, and a
  url and a field-by-field configuration of one database now share it.
- **A `uuid` column takes no default** (`@jsails/database/model`). MariaDB
  stores it as `binary(16)` and reports a binary default through a character
  set that mangles it, so the schema core could never confirm one applied.

- **CLI failures explain their cause.** Under the `jsails:` line a failed
  command now prints the error's `cause` chain (and an AggregateError's first
  members), one `caused by:` line each, bounded and cycle-safe: a registry
  error in full, any other error only as its class name, Node error code (or
  a database driver's code), failed system call and `path:line:column`
  relative to the working directory. A syntax error in a config, command or
  job module, or in a module it imports, names its file, line and column,
  found by parsing the modules again without running them, because Node 26
  puts no location on the error `import()` throws. `JSAILS_DEBUG=1` adds each
  underlying message and stack; without it, a closing line says how to see
  them. Exit codes are unchanged. The app config's `load_failed` error, the
  job loader's and the jamal config loader's now keep the import failure as
  their `cause`, and every command's failure path uses the same report
  (`test`, `plugins`, `queue:*`, `build:meta`, `agents:setup`, `mcp`,
  `inject:auto-imports` and the `jamal` forwarder included), as do the dev MCP
  server's log and the `jamal` bin (`renderFailureReport` and
  `renderCauseChain` on `jsails/internal`). An environment file that cannot be
  read now says why (its errno code). `formatAppError` is replaced by
  `reportAppFailure`, and `config_module.load_failed` no longer suggests
  importing the module by hand.
- **One execution context per request.** Request id, locale, tenant, facade
  scope and server-component frames share one AsyncLocalStorage, and a request
  enters one context (one ALS run per request, down from two).
  `currentRequestId` (`jsails/app`) is removed: read
  `currentContext()?.requestId` from `jsails/context`. Trace continuation
  follows the peer's trust, not `client.via`, so an inbound `traceparent` from
  a trusted `{ cidrs }` proxy that sent no `X-Forwarded-For` is continued.
- **Jobs run in their dispatcher's context.** A job runs in the tenant and
  locale its dispatch carried (every job used to start with no tenant);
  `withoutTenantScope` is never carried, and a job's failure signals,
  `onJobFailed` and failed-history record run in the job's own context. The
  dispatch option `__jsailsRequestId` is replaced by `__jsailsContext`, and a
  carrier that does not restore fails the job terminally.
- **Environment names and removals.** `.env.testing` is renamed `.env.test`.
  `EnvironmentError` and `EnvironmentErrorCode` are removed
  (`EnvironmentErrors.is(error)` recognizes `environment.invalid_variable` and
  `environment.invalid_environment`), as are `credentials regenerate`,
  `--order`, credentials v1 documents (`credentials.unsupported_version`) and
  the `JSAILS_CREDENTIALS_LOADED`/`JSAILS_ENVIRONMENT_LOADED` markers. `jsails
  dev`'s serve child no longer defaults `NODE_ENV`; it inherits the parent's
  resolution.
- **Server-component lane boundaries.** Every transport endpoint is a lane
  boundary built by `componentRoute`: `update`, `refresh`, `upload` and
  `download`, each with concurrency slots per runtime and per principal and a
  total and idle deadline. Refusals are value-free, and 429/503 answers carry
  `retry-after`. A request past its deadline is answered `timeout` and never
  starts its handler afterwards; its slot is held until the handler settles.
  The runtime's `update`, `handleUpload` and `handleDownload` become
  `runtime.routes.{update,upload,download}`, which return a `Response`; upload
  limits move to `limits.upload`, and an upload past its deadline answers 503
  `timeout` (it was 400).
- **App-owned component registry.** The component registry is app-owned and
  keyed by the path-derived component id (`componentIdFor`); the build emits
  `{ id, definition }` entries, and a duplicate id, a malformed id, or a
  `name` that differs from its id fails assembly (`component_registry.*`).
  `registerComponent`, `registeredComponents`, `clearComponentRegistry` and
  `bootstrapComponents` are removed. `loadComponentEntries({ rootDir })` (the
  root is required) reads the generated `.jsails/components.registry` from the
  app root instead of the working directory, so `--config` pointing at a
  project elsewhere finds its components, and `jsails describe` lists them
  again: a plugin descriptor can declare `generatedComponents`, and static
  describe loads those entries from the app root without running setup.
- **Forms and URL binding.** `urlBinding` seeds a field only when the coerced
  value passes that field's schema, and the field's transforms then run once.
  `defineForm`'s `fromState` clears omitted keys, its `rules` option is
  removed, and unknown options are refused.
- **Disks.** `LocalDisk`, `MemoryDisk` and `S3Disk` implement the streaming
  contract, and listing is paged in UTF-8 byte order (a store such as
  SeaweedFS lists in its own). `LocalDisk` writes durably (temp file, fsync,
  rename, then a directory sync), prunes empty directories, sweeps stale temp
  files, and keeps its quota exact under concurrency. `@jsails/filesystem`
  errors are `filesystem.*` (`FilesystemErrors`) and `variant.*`
  (`VariantErrors`); `DiskVariantResolver` takes `sourceMaxBytes`.
  `@jsails/media` and `@jsails/admin` write through `Disk.write`, and
  `MediaLibrary.stream` always reads ranges from the disk. Removed: `put`,
  `get`, `exists`, `size`, unbounded `list`, `putStream`, `stream`,
  `listPage`, `StreamingDisk`/`isStreamingDisk`,
  `UrlDisk`/`isUrlDisk`/`diskUrl`,
  `DISK_URL_DEFAULT_EXPIRES_IN`/`DISK_URL_MAX_EXPIRES_IN`, `DiskError`,
  `DiskRangeError`, `S3Disk.url`, `FileSystemError`/`FileSystemErrorCode` and
  `VariantError`/`VariantErrorCode`.
- **`@jsails/jamal` and SeaweedFS.** With one `s3` service, the `dev` and
  `image` app containers get `S3_FORCE_PATH_STYLE=true` and
  `S3_CONDITIONAL_WRITES=false` beside `S3_ENDPOINT`, because the SeaweedFS
  store `jamal` provisions serves path-style requests only and ignores
  `If-None-Match`.
- **`PageProps` and the old `.jsails` emitter.** The loose `PageProps` type
  (`Record<string, unknown>`) is removed from `jsails` and `jsails/pages`:
  `PageProps` now means only `jsails/view`'s `PageProps<typeof load>`, and
  `PageModule` and `PageComponent` default their props to `Record<string,
  unknown>`. The experimental `.jsails` emitter (`sfc-emit`, `template-lower`,
  `resolve-components`, `source-map`) is removed, and so are the
  `clientComponents` convention directory and `CLIENT_COMPONENT_EXTENSIONS`.
- **Error-code gate.** The error-registry gate finds every `defineErrors`
  module in each workspace's sources and imports it, instead of importing
  public entries, so registries reached only from a bin (`jamal_credentials`)
  are recorded. A call that is not at module scope, has a non-literal domain,
  or registers no codes fails the gate.
- **Every app has its own Jamal project.** `jsails create` writes the app's
  name (scope joined with `-`, other punctuation as `-`; a name longer than
  63 characters is cut and ends with a digest of the whole name) as `service`
  and `image` in `jamal.config.ts`, instead of the shared `jsails-app`, so two
  apps on one machine no longer share containers, networks, and data volumes.
  Every local `jamal` verb also refuses, with `project_in_use`, a Compose
  project whose containers another directory created, so two apps that still
  share a `service` (an app not yet upgraded, or two created under one name)
  cannot replace, stop, or delete each other's containers and data. See
  UPGRADING.md for an existing app.
- **`npx jamal` resolves the project's environment.** The `jamal` bin resolves
  the project's environment as the `jsails` CLI does before any verb, so `npx
  jamal up` interpolates the managed Compose file exactly as `jsails jamal up`
  does, and `jsails jamal` forwards before resolving anything. Local verbs
  (`up`, `down`, `ps`, `logs`, `exec`, and the dev-container shortcuts)
  default to `JSAILS_ENV=development`; every other verb runs in the deployed
  app's environment, `JSAILS_ENV` (default `production`), and reads no `.env`
  file, so a `$NAME` in `.jamal/secrets*` never resolves to a development
  value. `@jsails/jamal` pins its `jsails` peer to the exact lockstep version.
- **Jamal delivers the credentials key.** When the environment a deploy acts
  for has sealed credentials, `jamal deploy` writes the key that opens them
  into the release's secrets file on the server (a rollback runs with the file
  its release was deployed with), with the app's other secrets (sent over ssh
  stdin), whether the
  key came from `JSAILS_CREDENTIALS_KEY` (a CI job) or the key file. What is
  delivered is the whole key ring that opened the document
  (`KeyRing.toVariable` on the resolution from `jsails/internal`); the
  resolution still removes the key from the process environment, so no
  secrets-file command or child process sees it. Nothing is delivered without
  a sealed file; accessories never receive it; a container whose clear
  `JSAILS_ENV` differs from the deploy's refuses with
  `jamal_credentials.environment_mismatch`, and a key a parent process
  consumed with `jamal_credentials.credentials_key_unavailable`.
  `JSAILS_CREDENTIALS_KEY` is reserved: a secrets file that defines it is
  refused (`reserved_secret`) before any of its commands run, `config.env` may
  not name it, `jamal secrets print` lists it as delivered, and
  `fetch`/`extract` refuse it. The `JSAILS_CREDENTIALS_KEY=$(cat
  config/credentials/production.key)` secrets entry the deploy guide used to
  recommend is gone. `jamal app details` and `jamal accessory details` print a
  fixed selection of `docker inspect` fields (state, image, labels, mounts,
  networks) instead of the whole document, whose `Config.Env` holds the key
  and every other delivered secret.
- `jsails build:meta`, `inject:auto-imports`, and `test` parse their flags
  strictly: `--help` prints the command's usage instead of running it, and an
  unknown flag, a flag without its value, or a positional argument is a usage
  error (exit 2) instead of being ignored.
- **Starters are developer mode.** Every preset loads plugins only from code
  and `jsails.plugins.lock`; none sets a managed mode or ships a plugin
  manager. The generated `jamal.config.ts`
  leaves the trusted-proxy setting to `jamal deploy` (with a commented `proxy`
  example for a CDN), `auth/README.md` teaches the same first run as
  the guide, and the static starter ignores `config/credentials/*.key`.
- **Admin is default-deny.** Resources, pages, and row/bulk actions without
  their own `authorize` are served to no one, and dashboard links hide what a
  session may not list. `withAdminAuthorize(plugin, gate)` gates a plugin's
  contributions; `configAdmin`, `flagsAdmin`, `blogAdmin`, `blogThemeAdmin`,
  the blog menus/revisions pages, `mediaAdmin`, and `jobsAdmin` take an
  `authorize` option.
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
  replaced. `?v=` is `immutable` only when it is the current content hash.
  `Response.redirect()` and proxied `fetch()` responses are accepted, and
  streamed responses are sent as produced.
- **Build.** A function-level `'use server'` is a build error (use a module
  whose first statement is `'use server'`).
  Routes load by file URL, so app paths with `#` or `%` work. `jsails dev`
  regenerates a stale `.jsails/` and re-runs `build:meta` on source changes.
  Bare `and`, `or`, and `when` resolve to the query builders. `create` prints
  the first run in an order that works.
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
- **Content.** A rich-text form submit carries the editor's state at that
  moment, list items included, and never an empty document in place of a
  body the editor could not read. A media `type/*` entry matches only that
  type.
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
- **jamal.** App containers run with `JSAILS_ENV=production` (a clear
  `JSAILS_ENV` in `config.env` deploys another environment, with the
  `NODE_ENV` it derives); loading the config refuses a `config.env` key or
  alias the environment resolver reserves (`NODE_ENV`,
  `JSAILS_CREDENTIALS_KEY`, `JSAILS_SECRETS_FILE`, `JSAILS_ENV_RESOLVED`,
  `JSAILS_DEBUG`, and `JSAILS_ENV` other than as a clear entry), naming the
  key, instead of the container refusing to boot; accessory env-file values
  are written verbatim, and a value Docker cannot read fails the deploy naming
  only its key; a deploy releases only the lock it holds; `deploy`
  refuses a project without a Dockerfile.
- **jamal: app secrets travel as a JSON secrets file.** App containers no
  longer receive `--env-file`. Each release's secrets are written as
  `{ "v": 1, "values": { NAME: value } }` to
  `~/.jamal/apps/<app>/releases/<release id>/secrets/secrets.json` (release
  directory `0700`, `secrets/` `0755`, file `0444`), mounted read-only at
  `/run/jsails/secrets`, and named by
  `JSAILS_SECRETS_FILE=/run/jsails/secrets/secrets.json`, so any value
  reaches the app byte for byte (a PEM block, backslashes, `$`, quotes,
  non-ASCII) whatever uid its image runs as. A value holding a NUL or an
  unpaired surrogate is refused before anything is built, naming only its key
  (`jamal_secrets_file.unrepresentable_value`). The JSails environment
  resolver accepts `JSAILS_CREDENTIALS_KEY` in a secrets file, lifting it out
  of the values to open the sealed credentials when the real environment
  holds no key ring, so the delivered key ring is never a container variable;
  every other reserved key is still refused there. Accessory env files keep
  Docker's format through the strict encoder, now also refusing an unpaired
  surrogate (`jamal_env_file.*`).
- **jamal: one atomic, checksummed remote write.** `writeRemoteFile` is the
  only way jamal writes a file on the server: the bytes go over ssh stdin
  behind a header with their size, SHA-256 and (under the deploy lock) the
  lock's token, into a `mktemp` file beside the destination that an EXIT trap
  removes on any failure; the server checks it with `sha256sum`, `shasum -a
  256` or `openssl dgst -sha256` (`jamal_remote_file.no_hasher` with none),
  checks the lock token (`jamal_remote_file.lock_lost`), sets the mode,
  flushes it and renames it into place, then flushes the directory. A dropped
  connection fails as `jamal_remote_file.checksum_mismatch` and leaves the
  previous file. The cache-proxy VCL moves to
  `~/.jamal/cache-proxy/default.vcl` and Varnish mounts that directory at
  `/etc/varnish`, since a renamed file never reaches a single-file bind
  mount; the in-place base64 overwrite in an argv is gone.
- **jamal: every bind mount is absolute.** A deploy, a rollback and
  `cacheProxyBoot` read the ssh user's home on the server once (`pwd -P` in
  the ssh session, the `host.home` op) and mount every host directory by
  absolute path below it: a release's `secrets/`, the cache proxy's VCL
  directory, and a `./` or `$PWD/` `config.volumes` source. A Docker CLI
  before 23 hands a `./` source to the daemon as a volume name, which it
  refuses, so the distro Docker 20.10 of Debian 11 and 12 or Ubuntu 20.04
  deploys too. A home that is not one absolute path free of `:` (a shell
  startup file printing a banner adds lines) stops the deploy under the lock
  before any step (`jamal_host_home.unusable_home`; a failed read is
  `jamal_host_home.read_failed`). `jamal deploy --dry-run` reads the home the
  same way, and a preview plan is refused by the release executor.
- **jamal: the server is the record of a deploy.** A release is named
  `YYYYMMDDHHMMSS-<sha12>` (the UTC time and the commit): `jamal deploy`
  refuses a tree with uncommitted changes (`jamal_release_source.dirty_tree`;
  `--allow-dirty` deploys it and records it as dirty) and a project with no
  commit (`not_a_checkout`), builds and pushes `<image>:<release id>`, reads
  the registry digest back from the local Docker (`digest_unknown` without
  one), and runs the image by digest. `--tag` is gone. Under the lock the run
  reads the server (`state.json`, every release manifest, which releases
  keep a secrets file, the app's containers by their `jsails.*` labels, the
  proxy's route and image), reconciles it with the proxy's target as the
  truth, and plans the release as data (`planRelease`, pure): a
  `repair-state` step when `state.json` disagrees with what serves, the
  release's secrets file and its immutable `releases/<id>/manifest.json`
  (image digest, commit and dirtiness, roles, secret names and digest, config
  digest, jsails version, the pinned kamal-proxy and cache-proxy images, the
  release it was deployed over) both create-only before the container runs,
  then run, health, switch, a compare-and-replace of `state.json` (live,
  previous, the lock's sequence number), and the retirement of every other
  container of the app, a killed run's included; a failed retirement is a
  warning. A routed release refuses to plan when kamal-proxy runs an
  unpinned image (`jamal_plan.unpinned_proxy`). `jamal rollback` runs the
  previous release the server records with its own digest, secrets file, and
  the web container and command its manifest records, whatever
  `config.command` says now, reusing its container when it still runs
  (`jamal_plan.no_previous`, `secrets_missing`, `no_web_role`). While
  kamal-proxy is stopped or missing, the release `state.json` records stands
  as live (a down proxy says nothing about what serves), a deploy or rollback
  of a routed app is refused before it changes the server
  (`jamal_plan.proxy_down`), and `jamal domain add` is refused. The local
  `.jamal/deploys.json` history is gone; `jamal
  app` and `jamal domain add` target the live release's container (`domain
  add` under the lock), `jamal app containers` filters by label, and
  `jamal cache-proxy plan` takes `--release <id>`. The default kamal-proxy and
  Varnish images are pinned by digest, and `cacheProxy.image` must be one.
- **jamal: a fenced deploy lock.** The lock moves to
  `~/.jamal/apps/<app>/lock` (`<app>` is `<service>` or
  `<service>.<destination>`), created under umask 077 with the token and an
  `owner.json` that carries a sequence number from `lock.seq`, which every
  acquisition increments. Every command a holder sends is fenced: the server
  checks the holder's token (sent as the first stdin line, never in an argv)
  before it runs the command, and refuses it once the lock holds another
  token or none (`jamal_lock.lock_lost`), so a run whose lock was
  force-released stops at its next command and never removes the next
  holder's lock. `jamal lock status` prints the sequence number.
- **Owned tables on MariaDB.** Stores built on owned tables (flags,
  sessions, config, notifications, blog, media) no longer crash on
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
  `JSAILS_TRUSTED_PROXIES=1` is now `hops=1`. A `jamal.config.ts` whose
  `env` names `JSAILS_TRUSTED_PROXIES` is refused (jamal sets it; describe
  upstream proxies under `proxy`). `@jsails/auth` rate limits key on
  the resolved client, and its `trustedProxies` option and the exports
  `resolveClientAddress`, `parseTrustedProxies`, `clientAddressKey`,
  `socketAddress`, `TRUSTED_PROXIES_ENV` and `CLIENT_ADDRESS_HEADER` are
  removed. `@jsails/admin` and `@jsails/blog` same-origin checks use the
  resolved origin, and the `@jsails/mail` preview's loopback gate refuses
  relayed requests.
- **Component authoring.** The `// #region` component dialect, the TSX
  multi-file component layout (`make:server-component --mfc`),
  `convert:component`, `compilerPlugin` in `jsails/build` and the web
  starters, `live:list` and the `@jsails/signals` package are removed;
  `UPGRADING.md` lists each with its replacement. `.jsails` single-file
  components stay and become the default authoring format, with a folder
  layout of the same component (`jsails convert`, `make --mfc`); a TSX file
  named after its directory (`components/card/card.tsx`) is the ordinary
  component `card/card`. A `<script>` block requires
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

- **Leaner CLI paths.** `jsails build` no longer loads the HTTP pipeline, Hono
  or `@hono/node-server` (an application loads its request stack on its first
  `fetch` or `serve`), so a static build loads 265 modules instead of 422.
  `db:diff` and `db:push` validate the database config before loading the
  schema layer, so a missing config is reported without TypeORM (23 modules
  instead of 373). `queue:failed --help` loads 23 modules instead of 58: the
  reserved dispatch-option keys live in one dependency-free module, still
  exported from `jsails/jobs`.
- **`jsails test` service boot.** A missing or unusable `@jsails/jamal` gives
  one message naming the install line and `--no-services`; a failing
  `jamal up` exits with jamal's own code and leaves the reason to its output.
- **`verify:integrations`.** The read-only `docker` probe stage is replaced by
  the `jamal` stage, and an enabled stage fails when the Docker daemon or its
  Compose plugin is unavailable; `--require docker` is now `--require jamal`.
- **Repository tooling.** CI actions move to their Node 24 releases (checkout
  v7.0.1, setup-node v7.1.0, upload-artifact v7.0.2), still pinned by commit
  SHA. The `.jsails` grammar property test runs a smaller seeded set locally
  that still reaches every generator branch, and the full set when `CI` or
  `JSAILS_TEST_FULL_PROPERTY=1` is set. `jamal deploy`'s `missing_dockerfile`
  preflight points at `npx jsails make:dockerfile`.
- **Errors come from registries.** `jsails/support`, `jsails/support/server`
  and the CLI command registry, signature, discovery and config loader raise
  registry errors with domain-qualified codes (`files.not_found`,
  `guarded_fetch.timeout`, `command.duplicate_name`); recognize them with
  `XErrors.is(error, code)`. A missing config reports `config <path> was not
  found`; a config that fails to import reports `failed to load config
  <path>`, with the import error kept on `cause` and not echoed. The CLI loads
  its failure reporter only when a command fails.
- **Every Valkey consumer uses the provider.** Cache, mutex, broadcast, the
  live change log and bus, jobs/BullMQ producers and workers, and the Valkey
  readiness probe take their connections from `valkeyToken`. `ioredis` may be
  imported or required only in `core/src/valkey` (lint rule
  `jsails/no-ioredis-import`). Default Valkey key prefixes move from
  `jsails:cache` / `jsails:mutex` / `jsails:live` to `<app key
  prefix>:cache|mutex|live`; the jobs producer's default queue prefix stays
  `defaultQueuePrefix()`, the one `jsails work` uses.
- **Rich-text documents are version 2 and must be canonical.** A version 1
  document is refused until upgraded. Removed: `EditorDocument`, the editor
  adapter registry and `native` payloads, the admin `richText` `editor`
  option, `blogAdmin`/`blogPlugin` `editor`,
  `blogEditorRendererToken`/`BlogEditorRenderer`, `BlogPost`/`BlogPage`
  `editor`/`native` and their columns, `editorJsAdapter`, and
  `richTextToPlainText`/`PLAIN_TEXT_MAX_LENGTH` from `@jsails/editor/server`
  (`richTextToPlainText` is now in `jsails/rich-text`, unbounded).
  `@jsails/blog` no longer depends on `@jsails/editor`.
- **Editor.js is gone; the editor is ProseMirror.** Removed:
  `editorJsToRichText`, `richTextToEditorJs`, `EditorConversionError` and the
  `EditorJs*` types from `@jsails/editor`, the six `@editorjs/*` dependencies,
  the island's `document` prop (the document travels in the field's source
  input), its hidden-input mirror and submit guard, and `RichTextEditor`'s
  `onInvalid`. `RichTextRenderError` is replaced by the
  `rich_text_render.*` registry `RichTextRenderErrors`. An admin `richText`
  value that is absent or blank reaches `save` as no key (an update keeps the
  stored body), and `required` is refused on the type.
- **Jamal's remote commands go through one RemoteOp layer**
  (`production/remote-op.ts`). A FakeHost model and whole-verb deploy
  scenarios record today's deploy defects in
  `scripts/expected-failures/jamal.json`; the test models are not published.
### Security

- No plugin route is outside the cross-site check: plugins add routes only
  through the registrar, so every route a plugin serves is behind the access
  chain and no surface accepting the session cookie takes a cross-site unsafe
  request. The `access` gate proves it for every first-party plugin and
  starter preset, sending each unsafe method a foreign `Origin` and no
  `Origin` as every actor, and fails unless the pipeline answers
  `403 access.cross_site` with no route code run and no body byte read.
- An anonymous unsafe request is no longer exempt from cross-site
  protection: a POST that names no origin at all (no `Origin`, no
  `Sec-Fetch-Site`) or names another one is refused `403 access.cross_site`
  on every surface accepting the session cookie, so a hostile page cannot
  sign a visitor in to its own account or drive an anonymous form. A denied
  answer is never stored by a shared cache and never sets a cookie.
- A failed command no longer prints the message of an error that is not a
  framework error (a database driver's error holding a connection string,
  whatever a seeder or project command threw): the top line is a fixed one
  and the error is summarised value-free under it, unless `JSAILS_DEBUG=1` is
  set. The same holds for the `jamal` bin and the dev MCP server's log, which
  also no longer copies a tool's underlying error messages or the stdio
  transport's error text.
- A registry error's message and hint are printed as its code's definition
  renders them from its validated context, never as the object holds them, so
  code that appends to a caught error's `message` cannot put a value in the
  report.
- `JSAILS_DEBUG` is a reserved key: `.env`, `.env.<name>`, the secrets file
  and the credentials may not set it, so a committed file cannot switch every
  run, CI and production included, to printing full error messages.
- The app config's failure messages name the config relative to the working
  directory, so an absolute `--config` no longer puts the home directory in
  the report.
- An inbound `traceparent`/`tracestate` from an untrusted caller is ignored;
  carried context values are validated on restore, and a carrier cannot be
  forged through job options; a new `AsyncLocalStorage` in framework sources
  fails lint.
- A production-named environment never reads a stray `.env` file, and sealing
  credentials reads only the named source, never the process environment
  (`PATH`, CI tokens, the credentials key itself).
- A throwing server-component or action `authorize` is a reported fault,
  answered 503 `unavailable` and reported as `component_authorize.*` with the
  cause, instead of a silent deny. Only an exact `true` admits.
- Server-component snapshots and download links share one envelope with page
  provenance, so the download lane re-runs `authorize` against the page the
  link was minted on. A reference signer refuses to mint a reference too large
  to verify, and download claims are capped at 8 KiB so the link fits in a
  URL.
- `LocalDisk` cannot be made to read outside its root by a symlink, including
  one swapped in between the check and the open. A missing S3 bucket is
  reported as `disk.io_failed`, never as a missing object. A write that fails,
  is aborted, or passes `maxBytes` leaves no partial object, temp file, or
  multipart upload. `S3Disk` checks the `Content-Range` a store answers with,
  so a store that serves an out-of-range request is reported as
  `disk.invalid_range`, and list cursors the disk did not issue are refused
  before any request.
- `js-html` is a `.jsails` template's only raw-HTML door: a
  `dangerouslySetInnerHTML` or `innerHTML` attribute is
  `sfc.raw_html_attribute`, and every `js-bind` spread drops both keys through
  `bindAttributes`.
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
  relation create/attach/detach authorize the relationship; cross-site checks
  compare with the resolved request origin.
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
- `@jsails/sessions` stores a SHA-256 of the session id and nothing else derived from it;
  `@jsails/cache` and the job overlap lock use owner-token leases; the memory
  cache bounds rate-limit counters; logs escape control characters and redact
  secret-looking keys; diagnostics record route patterns, not raw paths.
- Starters fail closed: admin access needs an admin role, the SaaS tenant
  resolver no longer trusts a client header, and
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
- Encrypted columns are encrypted on `Model.update()` too, and every written
  value is treated as plaintext, so a submitted ciphertext is sealed again
  rather than shown back decrypted.
- `jsails test` asks the server which database it is connected to and refuses
  unless it is a test database, and runs only as `JSAILS_ENV=test`.
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

- The production image takes no build arguments or secret mounts;
  `.dockerignore` keeps `.env*`, `.jamal/`, `config/credentials/*.key`,
  `storage/` and SQLite files out of the build context, and the runtime stage
  excludes them again. `make:dockerfile` writes `.dockerignore` first, and
  `--force` replaces a symbolic link itself, never its target.
- `jamal backup` and `restore` read accessory credentials only from the
  container's own environment (`MYSQL_PWD`, PostgreSQL's local socket,
  `REDISCLI_AUTH`); no credential is placed on a command line. A MariaDB
  restore loads the dump with `mariadb --sandbox`, so a crafted dump cannot run
  client shell or file commands.
- The release workflow never restores a dependency cache
  (`package-manager-cache: false`), so the job holding the npm token and OIDC
  identity installs only from the registry.
- Valkey clients no longer hang against an unreachable or silent server: every
  connect and every `command`-role reply has a deadline. A failed script run
  rejects with value-free `unavailable` or `script_failed` and never includes
  the server's reply text.
- Rich-text link and embed URLs are allowlisted by the schema (no
  `javascript:`, `data:`, scheme-relative, userinfo or upper-case schemes);
  text refuses control and bidi-override characters and unpaired surrogates;
  the renderer emits only URLs that passed the model's predicates.
### Performance

- `ModelQuery.in_batches` (`jsails/database`) leaves the query as it was:
  each page is a copy of its builder, and the cursor condition is built
  from the cursor's values instead of switching on a parameter, so every
  page after the first reads through the primary key on SQLite instead of
  scanning the table.
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
  app config loads no config at all. `jsails/app` loads 410 modules instead
  of 737 and no TypeORM, `jsails serve` of an app without a database
  reaches its first request with 422 modules instead of 798, and `jsails build`
  loads 422 instead of 799. `jsails mcp` answers its first `tools/list` with
  131 modules instead of 389. The import-graph gate holds a ceiling for each
  representative invocation.
- Sessions resolve lazily once per request; static files and health probes do
  no lookup. A public file is answered from the asset index before routing:
  a 304 and a miss cost no file system call, a file up to 64 KiB is served
  from memory and a larger one with a single open; dynamic responses use brotli when preferred and are finalized once, a small
  body with no zlib engine and no stream; ETags skip `no-store`, large, and
  streamed responses.
- Page and layout modules are imported once; static export renders with
  bounded concurrency and writes as it goes; eager loads chunk IN lists.
- The blog's public routes query only the page they show; the media admin is
  paged; live replaces its global write fence with per-entity snapshot buffers.
- The workspace runner builds and tests independent workspaces in parallel;
  `npm run bench` reports start-up and throughput. Its `api-post-json`
  scenario posts a 1 KiB JSON body read through the body budget, and
  `--timing` prints that route's throughput against a bare Hono app answering
  the same request.
- Disk writes stream: `LocalDisk` holds one chunk and `S3Disk` one part in
  memory, so a 64 MiB upload no longer buffers the whole body.
- `contentDisposition` and the `url.*` registry live apart from `Url`, so
  `jsails/app` and `jsails/server-components` no longer load `qs`. Assembling
  an app loads 390 modules (5 routes) instead of 432.

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
- SeaweedFS, the S3 store `jamal` provisions, ignores `If-None-Match` and
  lists in its own order: a disk on it needs `S3_CONDITIONAL_WRITES=false`
  (jamal sets it in its containers), and its listing is not in byte order.
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
