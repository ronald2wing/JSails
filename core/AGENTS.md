# Working with JSails

Compact repository guidance. The full API reference is the docs site
(<https://jsails.org/docs>, source under `website/content/docs/`) and
[`docs/CODEMAP.md`](../docs/CODEMAP.md). This file is bundled into generated
starters by `createStarterFiles`, so keep it framework-level and stable.

## What this repo is

- JSails is a TypeScript full-stack framework: an Active Record data layer plus a
  bounded runtime (extensions, pages/API, server components, jobs, broadcast,
  admin, CLI). It is not a complete MVC framework.
- ESM only. Node `>=26.0.0`. Published as one package with many subpaths.
- It deliberately reuses maintained libraries (TypeORM, Zod, BullMQ, Socket.IO,
  Preact, Hono) and dogfoods its own helpers.
- Do not add a dependency when a big existing dependency or an in-repo
  implementation covers the domain. Do not add a package subpath casually.

## First commands

```sh
npm install
npm run check              # the full gate (builds first, then lint/format/structure/test)
npm run verify:starter -- --skip-browser
npm --prefix website run check
```

- `npm run check` runs `lint`, `format:check`, and `check-structure` in parallel,
  then `npm run test` (`build:clean` followed by compiled `node:test`).
- `npm run test` alone also does a clean build. There is no external service in
  the default suite.
- Run one compiled test with:
  `npm run build && node --test dist/test/path/to/file.test.js`
  Node's directory argument is not used here; pass files or a shell glob.
- `npm run test:watch` seeds from the existing `dist/` and does not clean it;
  restart it after adding test files.
- `npm run typecheck` is `tsc --noEmit`; `npm run build` emits `dist/`.
- `npm run verify:starter` packs and installs a generated app. Browser stages
  need an installed Chromium (`JSAILS_BROWSER_PATH`, default `/usr/bin/chromium`);
  `--skip-browser` records them as skipped and launches none.
- `npm run verify:integrations` requires an existing `dist/` and is env-gated;
  without database/Valkey/Docker variables every stage skips.
- The website is a separate package: `npm --prefix website run check` validates
  its docs pages against the package exports.

## Verification discipline

1. `npm run format`
2. `npm run lint`
3. `npm run build:clean`
4. `npm run check`
5. `npm run verify:starter -- --skip-browser` when starter templates, public
   subpaths, or generated files changed.
6. `npm --prefix website run check` when docs or public exports changed.

For template/ignored-file changes, also verify a clean checkout:
`git archive HEAD | tar -x -C /tmp/check && cd /tmp/check && npm ci && npm run check`.
A file that exists only because it is untracked/ignored passes locally and fails
CI; this caught the starter `.env.auth.example.template` regression.

## Source boundaries

- `src/index.ts` is the root public barrel. `package.json` `exports` defines
  every public subpath; each subpath has its own barrel.
- `jsails.plugin.json` `provides` must equal the package export list (a test
  enforces this). Adding a subpath requires both files plus any relevant symbol/
  autoload wiring.
- Browser-safe subpaths include `jsails/api`, `@jsails/theme`, `jsails/client`,
  and `jsails/rich-text`. Server-only subpaths include `jsails/database`,
  `@jsails/blog` (TypeORM persistence), `@jsails/editor/server`, `@jsails/media`,
  and most plugins. Never import
  a server-only module into a client island.
- Substrate (must stay core): CLI bootstrap, app-config loader, `runExtensions`,
  route discovery, plugin enablement. Everything above that line is
  plugin-shaped.
- `plugins.use` entries always run. `plugins.enabled` is the marketplace/
  managed-install gate only; it never filters developer `plugins.use` entries.
- A plugin can own schema through `JsailsPlugin.schema.entities`; `db:push`/
  `db:diff` resolve `plugins.use` without calling `setup`. `--app-config`
  overrides the app config. See `src/plugins/schema.ts`.
- Main areas: `src/app` (runtime/config/starter), `src/cli` (lazy dispatch),
  `src/database` + `src/migrations`, `src/pages`/`src/routing`/`src/server`/
  `src/server-components`, `src/client`, `src/extensions`/`src/plugins`/
  `src/admin`, `src/blog`, `src/support`, `src/testing`.

## Starter presets (current)

`jsails create` has five mutually exclusive presets; there is no `--static`:

- default / `--starter` — 29-file static site from `templates/starter/`
  (content collection, Preact pages, client runtime, Vite, `plugins.use: []`).
- `--admin` — 55-file server-rendered app from `templates/starter-web/`
  (auth + admin + server components).
- `--blog` — 58-file standalone blog CMS (admin + blog + plugin manager + media).
- `--saas` — 55-file server-rendered app (admin + multi-tenancy + feature flags).
- `--cli` — 7-file CLI-only project from `templates/starter-cli/`.

`createStarterFiles` reads a fixed template whitelist; never assume a template
is copied just because it exists in the tree. When changing starter files,
update `test/app/starter.test.ts`, `test/cli/create-cli.test.ts`, and
`scripts/verify-starter.mjs` expected key sets/counts.

`templates/starter-web/.env.auth.example.template` is deliberately tracked;
root `.gitignore` un-ignores `!templates/**/.env.*.template`. Do not remove that
negation. Starter-specific guide text lives in `src/app/starter/guides.ts`; this
file is the shared framework guide prefixed onto it.

## Data layer and migrations

- `JsailsDataSource` rejects `synchronize`, `dropSchema`, `migrationsRun`, and a
  TypeORM `migrations` config. JSails owns schema history.
- Migrations are desired-state, not files: `db:push` diffs declared models
  against the live schema. Safe operations auto-apply; a destructive plan is
  refused atomically unless `--allow-destructive`. `db:diff` previews it.
- There is no applied-state ledger and no automatic rollback. Operator owns
  backups. Data migrations run after schema reconciliation and must be
  idempotent; `down` is a manual escape hatch.
- The portable schema is deliberately narrow: no partial/expression indexes,
  enums, generated UUIDs, computed columns, or function defaults. SQLite
  structural changes rebuild the table and are destructive.
- `FileDataSource` is a read-only in-memory `sqljs` source for tests/demos; it is
  not a sandbox.
- Author models with `jsails/models` (`ApplicationRecord` + `@jsails.*`) or
  `BaseEntity`/`EntitySchema`; use `defineData`/`@jsails.data` for JSON columns
  and `defineEntityValidation` for explicit validation. No load-time validation.

## Runtime and security invariants

- Auth/authorization is default-deny: an `authorize` callback allows only on an
  exact `true`. Cookie mutations require same-origin `Origin` + CSRF.
- Server-component state is signed (integrity), **not encrypted** and public;
  never put secrets in it. There is no exactly-once/replay protection; actions
  must be idempotent. Static export renders only `staticFallback`.
- Custom broadcast adapters own their own auth/origin/channel security; the
  built-in Socket.IO adapter is the only one with the framework's checks.
- Never trust producer HTML. The editor persists block JSON; render it through
  the allowlisted server renderer and escape text/URLs.
- The persisted rich-text schema is `jsails/rich-text` (core). The Editor.js UI
  is `@jsails/editor` (source `plugins/editor/`); the blog consumes both. Keep
  the conversion/mount layers model-agnostic and free of blog persistence
  imports. The server renderer is `@jsails/editor/server`; the Preact island is
  `@jsails/editor/preact`. It supports paragraph/heading/list/quote/code/divider
  and rejects unsupported blocks rather than dropping them.

## Jobs, commands, autoload

- Jobs are classes (`ApplicationJob`) or `defineJob`; files live under
  `jobs/**/*.job.ts` and auto-register. No job registry. Schedules are data
  (`jsails.schedules.json`), not code.
- Commands are classes (`Command`) or `defineCommand`; discovered under
  `commands/**` (compiled to `dist/commands/`) or declared on the app config/
  extension. `defineCommandJob` is the explicit command-to-job bridge; commands
  do not become jobs by name.
- `jsails build:meta` generates `.jsails/framework-symbols.js`,
  `.jsails/project-symbols.js`, and the ambient declarations. Do not hand-edit
  `.jsails/` or `dist/`. `jsails inject:auto-imports` applies the same
  auto-import pass to compiled server output.

## Toolchain quirks

- TypeScript is aliased: `tsc` comes from `@typescript/native` (TypeScript 7);
  the `typescript` package is `@typescript/typescript6` for typescript-eslint.
  Use `node_modules/.bin/tsc` or npm scripts. `npx typescript@5 tsc` fails.
- `noUncheckedIndexedAccess` is on: indexed reads can be `undefined`. Strict,
  no-unused-locals/parameters are on. ESM relative imports need `.js`.
- ESLint is type-checked (`projectService`) for `src/`/`test/`; templates are
  linted by the untyped preset; `website/` has its own tsconfig. Do not add
  `eslint-disable` to hide a real issue; disable a rule in config with a written
  reason only when it conflicts with an established pattern.
- Prettier owns style: 2 spaces, single quotes, semicolons, trailing commas,
  100 columns, LF. `*.md` is not formatted; edit Markdown deliberately.
- `scripts/check-src-structure.mjs` rejects basename collisions, generic
  filenames (`utils.ts`/`helpers.ts`/`internal.ts`), and role suffixes
  (`-helpers`/`-shared`/`-utils`/`-common`/`-misc`).
- Node 26 is the CI dev leg; local Node may be 22.x. A clean `npm ci` checkout is
  the reliable comparison when CI differs from local.

## Conventions

- Read before writing. Match existing naming, test style (`node:test` +
  `node:assert/strict`), and value-free error classes (`code`, no echoes of
  secrets/input). Prefer frozen descriptors and plain data over method-heavy
  APIs. Comments explain why, not what.
- No catch-all files, no dead code, no `any` additions (existing deliberate
  `any` sites are documented in `eslint.config.mjs`), no emoji.
- Use `Str`/`Arr`/`Async`/`Files`/`HttpClient`/`CacheStore`/`JobsRuntime`/`I18n`
  before adding a parallel private helper.
- No comments that restate the code; no commented-out code; no empty catches.
- Tests: default suite opens no external service. `jsails test` requires a live
  database, uses the `*_test` database, and `withTestTransaction` rolls back each
  test. `verify:integrations` is the only live-service harness.
- In the framework checkout, `jamal` is not on `PATH`; use
  `node dist/src/cli/index.js jamal up` after a build. Generated apps use
  `npx jsails jamal up`. If Docker access is denied here, run it under
  `newgrp docker`.

## Docs and release

- Update `website/content/docs/` when public API/subpaths change; run the website
  check. `docs/CODEMAP.md` is the annotated source map.
- `prepublishOnly` runs `npm run check`. Do not `npm publish` or deploy unless
  explicitly asked. `npm pack` includes `dist`, `templates`, and this file.
- Stage explicit file paths only; never `git add -A`, `git reset --hard`, or
  `git clean -fd`. Do not commit `dist/`, `test-results/`, `.content-cache/`, or
  generated reports.
