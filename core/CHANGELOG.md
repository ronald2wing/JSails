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
- **AI and agent tooling** — `jsails mcp` MCP server (describe, routes, explain,
  schema tools), the provider-neutral `ai()` runtime (chat, stream, tool loop),
  and `jsails agents:setup` for project AGENTS.md, skills, and MCP config.
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
  `app:shape`, `live:list`, `console`, `test`, `convert:component`, `jamal`,
  `plugins`, and user-defined commands. Every command declares the config module
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
- Windows teardown is covered by simulated protocol tests only, and the Varnish
  VCL is verified by construction rather than a live `varnish -C` compile.
