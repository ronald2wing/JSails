# Working with JSails

The framework guide for an application built on JSails. It ships inside the
`jsails` package and is copied into every generated app's `AGENTS.md`. The full
reference is <https://jsails.org/docs>; the framework source is
<https://github.com/ronald2wing/JSails>.

## What JSails is

- A TypeScript full-stack framework: an Active Record data layer plus a bounded
  runtime — plugins, filesystem pages and API routes, server components, jobs,
  broadcast, an admin panel, and a CLI. It is not a complete MVC framework.
- ESM only, Node `>=26`. The core is the `jsails` package with many subpaths
  (`jsails/models`, `jsails/database`, `jsails/server-components`, …); optional
  capabilities are `@jsails/*` packages (`@jsails/auth`, `@jsails/admin`,
  `@jsails/blog`, …).
- It builds on maintained libraries — TypeORM, Zod, BullMQ, Socket.IO, Preact,
  Hono — rather than replacing them.

## Data layer and migrations

- Author models with `jsails/models` (`ApplicationRecord` + `@jsails.*`) or
  TypeORM `BaseEntity`/`EntitySchema`. Use `defineData`/`@jsails.data` for JSON
  columns and `defineEntityValidation` for explicit validation; nothing is
  validated at load time.
- JSails owns schema history: `JsailsDataSource` rejects TypeORM's
  `synchronize`, `dropSchema`, `migrationsRun`, and `migrations` options.
- Migrations are desired state, not files. `jsails.database.js` default-exports
  the `JsailsDataSource`; `jsails db:push` diffs the declared models against the
  live schema and applies safe operations; a destructive
  plan is refused atomically unless `--allow-destructive`. `jsails db:diff`
  previews the plan.
- There is no applied-state ledger and no automatic rollback; you own backups.
  Data migrations run after schema reconciliation and must be idempotent;
  `down` is a manual escape hatch.
- The portable schema is deliberately narrow: no partial or expression indexes,
  enums, generated UUIDs, computed columns, or function defaults. On SQLite a
  structural change rebuilds the table and counts as destructive.
- `FileDataSource` is a read-only in-memory `sqljs` source for tests and demos;
  it is not a sandbox.

## Runtime and security invariants

- Authorization is default-deny: an `authorize` callback allows only on an
  exact `true`. Cookie-authenticated mutations require a same-origin `Origin`
  and a CSRF token.
- Server-component state is signed for integrity, **not encrypted**, and
  readable by the client — never put secrets in it. There is no exactly-once or
  replay protection, so actions must be idempotent. A static export renders only
  `staticFallback`.
- The built-in Socket.IO broadcast adapter enforces the framework's auth,
  origin, and channel checks; a custom adapter owns all of that itself.
- Never trust producer HTML. Rich text is persisted as block JSON
  (`jsails/rich-text`) and rendered through the allowlisted server renderer
  (`@jsails/editor/server`), which escapes text and URLs and rejects unsupported
  blocks instead of dropping them.

## Plugins

- `plugins.use` entries always run. `plugins.enabled` only gates what the
  managed/marketplace surface may expose; it never filters `plugins.use`.
- A plugin can own tables through `schema.entities`; `db:push` and `db:diff`
  collect them from `plugins.use` without calling `setup`.
- A plugin package describes itself in the `jsails` field of its
  `package.json` (id, version, `jsailsCompat`, `entry`, optional `autoload`).
- Browser-safe subpaths include `jsails/api`, `jsails/client`,
  `jsails/rich-text`, and `@jsails/theme`. `jsails/database`, `@jsails/blog`,
  `@jsails/media`, `@jsails/editor/server`, and most plugins are server-only —
  never import a server-only module into a client island.

## Jobs, commands, and autoload

- Jobs are `ApplicationJob` classes or `defineJob` results in
  `jobs/**/*.job.ts`; they register themselves, so there is no job registry.
  Schedules are data (`jsails.schedules.json`), not code.
- Commands are `Command` classes or `defineCommand` results under `commands/**`
  (compiled to `dist/commands/`), or declared on the app config or a plugin.
  `defineCommandJob` is the explicit bridge from a command to a job; commands
  never become jobs by name.
- `jsails build:meta` generates `.jsails/` — the framework and project symbol
  tables and their ambient declarations — so models, components, and helpers are
  usable without imports. Never hand-edit `.jsails/` or `dist/`.
  `jsails inject:auto-imports` applies the same pass to compiled server output.

## Code conventions

- TypeScript is strict with `noUncheckedIndexedAccess`: an indexed read can be
  `undefined`. Relative ESM imports need the `.js` extension.
- Reach for the support namespaces (`Str`, `Arr`, `Async`, `Files`,
  `HttpClient`, `CacheStore`, `JobsRuntime`, `I18n`) before writing a private
  helper.
- Errors extend `JsailsError` (from `jsails/support` or `jsails/plugin-sdk`),
  carry a stable snake_case `code` from the vocabulary `invalid_<thing>`,
  `missing_<thing>`, `unparseable`, `unsupported_<thing>`, `too_large`,
  `io_failed`, `not_found`, and never echo secrets or raw input.
- Tests use `node:test` with `node:assert/strict`. `jsails test` needs a live
  database, uses the `*_test` database, and `withTestTransaction` rolls back each
  test.
