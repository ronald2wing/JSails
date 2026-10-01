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
  catch-all routes, loading/error boundaries, per-route and global middleware on
  Hono, strict default-deny authorization, CSRF/public-origin checks, security
  headers, ETag/compression, deep health checks, signed URLs, and
  content-hashed asset URLs.
- **API toolkit** — storage-agnostic resource handlers, list-query parsing,
  composable permissions, throttling, form parsing, deterministic OpenAPI,
  route manifests, version negotiation, nested serializers, and a browsable
  explorer.
- **Server components** — signed stateless HotView protocol, server and local
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
- **Starter presets** — five mutually exclusive scaffolds: a 27-file static
  site, a 53-file admin app, a 56-file blog CMS, a 53-file SaaS preset with
  opt-in tenancy/flags, and a 7-file CLI project. `jsails create` accepts local
  tarball overrides for every plugin dependency, and `verify:starter` installs
  and checks the admin, blog, and SaaS presets from packed workspace tarballs.
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
  actions, tabs, wizards, grouping, export, relation managers), blog, admin
  plugin manager with per-plugin settings, plugin tools, mail, filesystem
  (disks, variants, rich text), notifications, cache and mutex stores, feature
  flags with A/B scopes, diagnostics with watchers and an exporter seam,
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
- **Plugins** — two-source enablement, inert `jsails.plugin.json` declarations,
  build-time autoload projection with ambient types, marketplace discovery and
  install gates (SHA-256 checksum plus optional signature), managed state
  storage, and `activatePlugins`.
- **Jamal** — local Docker Compose and production deploy/rollback/status/logs/
  exec, app and accessory lifecycle verbs over ssh, domain routing, on-demand
  TLS allowlisting, an optional Varnish cache proxy, and pure registry/prune/
  audit/snapshot planners.
- **CLI** — `create` (default static `starter`, `--admin`, `--blog`, `--cli`; `--starter` selects the default explicitly),
  `dev`, `build`, `serve`, `db:push`, `db:diff`, `work`, `schedule`, `seed`,
  `queue`, `make:<page|api|job|model|command|server-component|serializer|middleware|content>`, `inspect`, `describe`,
  `explain`, `mcp`, `agents:setup`, `i18n:missing`, `app:shape`, `jamal`,
  `plugins`, and user-defined commands.
- **Support toolkit** — `Str`, `Num`, `Time`, `Arr`, `Async`, `Encoding`, `Url`,
  and `Cryptography`, plus the server-only `Files`, `Media`, `Cookie`, and
  frontmatter/error helpers.
- **Runtime** — extension/service/contract system with documented override
  rules, facades backed by AsyncLocalStorage, the shared signal bus, interceptors,
  a deployment-generator registry, environment readers, the `.env` bootstrap,
  system checks, seeders, and the in-process testing application.

### Changed

- **Node 26 is the runtime floor.** Every workspace and generated starter now
  requires `>=26.0.0`; CI, Docker, and generated deployment workflows target
  Node 26. Type, lint, format, and Vite tool floors were refreshed with it.
- **S3 storage.** `@jsails/filesystem` adds `S3Disk` over
  `@aws-sdk/client-s3` and `createDiskFromEnv()`, so generated apps switch
  between local and S3-compatible storage with `FILESYSTEM_DISK`.
- **Orama is the default blog search engine.** The previous database search
  remains available, and Meilisearch, Typesense, and OpenSearch stay opt-in
  through `SEARCH_DRIVER` and Jamal services. Jello Elementor ships as the
  functional default blog theme.
- **Development runtime.** `jsails dev` now uses Node's recursive `fs.watch`
  and a plain serve child instead of nodemon/chokidar. `Files.glob` uses
  `tinyglobby`, and `.env` parsing uses `util.parseEnv`.
- **Dependency cleanup.** Removed `dotenv`, `fast-glob`, and `nodemon`; upgraded
  the remaining direct dependencies (including `sitemap` 10). `npm audit`
  reports zero vulnerabilities.

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
- On-demand TLS requires kamal-proxy v0.10.0+ while Kamal still defaults to
  v0.9.2, and the application owns the authorization endpoint.
- Auth is authentication, not a policy engine: role checks are session-based.
- Windows teardown is covered by simulated protocol tests only, and the Varnish
  VCL is verified by construction rather than a live `varnish -C` compile.
