# JSails

[![CI](https://github.com/ronald2wing/JSails/actions/workflows/ci.yml/badge.svg)](https://github.com/ronald2wing/JSails/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jsails.svg)](https://www.npmjs.com/package/jsails)
[![npm downloads](https://img.shields.io/npm/dm/jsails.svg)](https://www.npmjs.com/package/jsails)
[![license](https://img.shields.io/npm/l/jsails.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/jsails.svg)](https://www.npmjs.com/package/jsails)

JSails is **a TypeScript application framework** with an Active Record data layer and
a bounded application runtime. It deliberately reuses maintained libraries (TypeORM,
Zod, BullMQ, Socket.IO, Preact, Hono) rather than implementing its own renderer, auth
stack, or queue.

Small utilities — duration parsing, byte formatting, deep equality, defaults
merging, concurrency limiting, retry scheduling, base64, error serialization,
cookie parsing — are implemented in-repo rather than added as dependencies. When
one big package already covers the need (`es-toolkit` for case/collection
helpers, for example), it is preferred over a collection of small packages;
large, protocol-level, or rule/data-heavy packages stay external.

The framework dogfoods its own helpers and runtime surfaces wherever it can.

Other frameworks and JavaScript best practices are references, not parity
targets: the API is designed for JSails and for the person reading it.

It is **not** a complete MVC framework. It ships the layers it can own properly and
leaves the rest to the ecosystem.

## Requirements

- Node `>=26.0.0`
- MariaDB (recommended), Postgres, MySQL, or SQLite for the data layer
- Valkey/Redis only if you use jobs or broadcast

## Quick start

```sh
npx jsails@latest create my-app --install
cd my-app
npm run build        # compile TS/assets and export a static site into out/
```

The default starter is a database-free static site. For the server-rendered
shapes, add `--admin` or `--blog` and start the backing services:

```sh
npx jsails@latest create my-app --admin --install
cd my-app
npx jsails jamal up   # MariaDB + Valkey for auth/admin
npm run dev           # compile + watch + serve (restarts the backend on changes)
```

`jsails create` flags select the starter shape:

- default (`--starter`) — a 27-file static site: a typed Markdown content blog
  using `@jsails/content`, Preact pages, the browser client runtime, and Vite, with
  `plugins: { use: [] }` and no auth/API/server components;
- `--admin` — a 53-file server-rendered web app with auth (Better Auth over
  MariaDB), the first-party admin panel at `/admin`, server components, and the
  Home/Tasks/Login/Dashboard/Device pages;
- `--blog` — a 56-file standalone blog CMS: the web base plus the first-party
  blog plugin, the `admin-plugin-manager`, and two blog pages (admin included);
- `--saas` — the 53-file server-rendered web base with the opt-in tenancy and
  feature-flag plugins, a documented demo tenant resolver, and no blog/plugin
  manager;
- `--cli` — a 7-file Laravel-Zero-style CLI-only project with **no web surface**
  but the same framework and plugin system.

All five shape flags are mutually exclusive.

### From a source checkout

```sh
npm install
npm run build
npm pack -w jsails --pack-destination /tmp

node core/dist/src/cli/index.js create my-app --install \
  --jsails-dependency "file:/tmp/jsails-1.0.0.tgz"
```

## What it gives you

| Area | Summary |
| --- | --- |
| **Data layer** | Active Record authoring DSL (`jsails/models`) or `BaseEntity`/`EntitySchema` over MariaDB (recommended), Postgres, MySQL, or SQLite; relation API (batch loading, EXISTS predicates, aggregates); polymorphic relations; composite keys and foreign keys; attribute encryption |
| **Data contracts** | `jsails/data` named schemas for validation, input/output JSON Schema, AI tools, and `@jsails.data` JSON columns; `aiTool` projects the same contract to a model-callable tool |
| **Schema** | Declarative desired-state reconciliation: `jsails db:push` diffs the model definitions against the live schema, applies safe operations, and refuses a destructive plan atomically unless `--allow-destructive`; `jsails db:diff` previews it |
| **Pages & APIs** | Filesystem-routed pages (Preact SSR) and Hono API routes; route groups `(name)`, nested `layout.js`, optional catch-all routes, loading/error boundaries; on-demand `revalidatePath`/`revalidateTag`; `jsails build` produces a static export |
| **Server components** | Signed, stateless HotView components with backend actions, nested components, forms, uploads, polling, and Turbo soft navigation |
| **Client runtime** | Turbo navigation plus hydrated Preact islands; Hotwire Native path-configuration groundwork (`jsails/client`) |
| **Auth** | First-party Better Auth plugin (`@jsails/auth`): email/password, device authorization, registration, password reset, email verification, OAuth/social providers, magic links, optional 2FA, and revocable API tokens |
| **Support toolkit** | `Str`/`Num`/`Time`/`Arr`/`Async`/`Encoding`/`Url`/`Cryptography` namespaces plus a server addendum (`Files`/`Media`/`Cookie`) |
| **Content** | Markdown/SSG collections, taxonomies, sections, versions, feeds, sitemap, blog helpers (`@jsails/content`) |
| **Editor & media** | General rich-text contract (`jsails/rich-text`), full Editor.js editor with all block kinds (`@jsails/editor`), allowlisted server renderer (`@jsails/editor/server`), and a Disk-backed media library with admin uploads (`@jsails/media`) |
| **Jobs** | Provider-neutral runtime over BullMQ: schedules, overlap control, retries/discards, chains, batches, failed-job store, metrics, lifecycle events, and a dashboard |
| **Broadcast** | Socket.IO transport on the app's own HTTP port, with origin/auth/channel checks |
| **i18n & flags** | Dependency-free translator with pluralization and catalogs; feature flags (`@jsails/flags`) with in-memory/database stores and A/B scopes |
| **Observability** | Record-first logging, in-memory diagnostics with watchers and an exporter seam, deep `/up?deep=1` system checks |
| **Plugins & admin** | Two-source plugin enablement, an admin panel with CRUD resources, and a plugin manager |
| **Tenancy** | Opt-in `@jsails/tenancy` plugin: plugin-owned tenant/membership tables discovered by `db:push`, auth-agnostic actor IDs, and tenant resolution |
| **AI & agents** | `jsails mcp` (MCP server), the provider-neutral `ai()` runtime, `aiTool` data-backed tools, and `jsails agents:setup` for project guidelines/skills |
| **Jamal** | Local Docker Compose via `jamal up`, production deploy/rollback, app/accessory lifecycle verbs over ssh, on-demand TLS, an optional Varnish cache proxy, and pure planners (`registry`, `prune`, `audit`, `snapshot`) |
| **CLI** | `create`, `dev`, `build`, `serve`, `db:push`, `db:diff`, `work`, `schedule`, `seed`, `queue`, `make:<page|api|job|model|command>`, `inspect`, `describe`, `explain`, `mcp`, `agents:setup`, `i18n:missing`, `app:shape`, `jamal`, `plugins`, plus user-defined commands |

## Verification

```sh
npm run check                 # typecheck, lint, format check, then the full test build
npm run verify:starter        # opt-in end-to-end starter verification
npm run verify:integrations   # opt-in live-service harness (env-gated)
```

`jsails test` runs a project's tests against an isolated `*_test` database with
per-test rollback via `withTestTransaction`.

See [`AGENTS.md`](./AGENTS.md) for the full reader guide and source layout.

## Known limits

This section states plainly what is and is not covered today:

- **Schema subset.** The portable schema covers scalar columns, single or composite
  primary keys, simple indexes and unique constraints, table-level `CHECK`
  constraints, and single- or multi-column foreign keys. Partial/expression/fulltext/
  spatial indexes, database enums, generated/computed columns, and function defaults
  are rejected. MySQL/MariaDB type ambiguity is resolved with the declared side as
  tiebreaker; SQLite introspection is best-effort and any SQLite `alter_column` is
  destructive (table recreate). There is **no automatic rollback** — a destructive
  change is refused, and backups remain the operator's responsibility.
- **Data migrations have no ledger.** They run on every `db:push`, so every data
  migration must be idempotent; `down` is a documented manual escape hatch.
- **Live services are opt-in.** The default `check` suite runs in process (including
  `FileDataSource` over WASM SQLite). Live MariaDB/Valkey/Docker coverage comes from
  `jsails test`, `verify:starter`, and `verify:integrations`; CI runs the integrations
  job only when `JSAILS_TEST_*` secrets are configured.
- **Server-component state is public.** Snapshots are signed, not encrypted. There is
  no exactly-once processing, no replay prevention, and no database rollback — actions
  must make their own persistence idempotent.
- **Custom broadcast transports need their own client.** The shipped browser client is
  Socket.IO-specific.
- **On-demand TLS needs a proxy image bump.** It requires kamal-proxy v0.10.0 while
  Kamal still defaults to v0.9.2, and the app must serve an authenticated
  `GET ?host=<hostname>` allowlist endpoint — an over-permissive endpoint can have
  certificates issued for unauthorized domains.
- **Auth is authentication, not a full authorization kit.** The plugin ships session
  roles (`sessionRole`/`requireRole`/`adminOnly`) but no policy engine.
- **Glob input is untrusted input.** `Files.glob` uses `tinyglobby`; a
  pathological caller-supplied pattern can consume CPU. Never pass untrusted
  input as a glob pattern. The dev toolchain uses Node's recursive `fs.watch`
  and has no package-watcher dependency.
- **No live Windows verification.** Windows-compatible teardown code is covered by
  argument/protocol tests only, and the Varnish VCL is verified by construction rather
  than a live `varnish -C` compile.

## Documentation

- [Architecture](https://jsails.org/docs/architecture) — how JSails is assembled: kernel
  vs plugins, the data layer, HTTP/pages/server components, the client runtime,
  the admin and plugin systems, Jamal, the CLI, testing, and security boundaries.
- [`docs/CODEMAP.md`](./docs/CODEMAP.md) — an annotated source-tree map (kernel /
  plugins / tooling) plus the package export subpaths and quick reference.
- [Deployment](https://jsails.org/docs/deploy) — Jamal, deploy config generators, the
  ONCE preset, server hardening, and on-demand TLS.

## Publishing

Publishing every package runs the full gate first, then publishes the workspace
tarballs without replaying the per-package lifecycle scripts:

```sh
npm login
npm run release
```

`npm publish --workspaces` alone runs the core `prepublishOnly` check while the
other workspaces build, which races on shared `dist/` output. `npm run release`
serializes the gate and then uses `--ignore-scripts` for the publish step.

## License

[MIT](./LICENSE)
