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

- Every route states its access (`publicAccess(reason)` from `jsails/api`, or
  a check function: `defineApi({ access })`, an API module's `authorize`
  export); there is no default, and an API module that states none fails at
  startup. A check allows only on an exact `true`; an anonymous caller it
  denies is answered 401, a signed-in one 403, and a throwing check 503.
  Every route is a registered surface, and core runs one access chain for it
  before any body byte is read: an unsafe request (not GET, HEAD or OPTIONS)
  to a surface that accepts the session cookie must carry an `Origin` equal to
  the app's origin (or, without one, `Sec-Fetch-Site: same-origin`), signed in
  or not. There is no CSRF token. A route sees a session only from a
  credential kind it declares: a cookie session is no session on a
  `credentials: ['token']` route, a header token none on a cookie-only one,
  and a `credentials: []` route never resolves one. A denial carries no `Set-Cookie` and is
  `private, no-store`. Middleware is `(context, next) => Response`, wraps one
  route, and runs after the access chain; there is no app-wide chain (a wall
  is a guard, a rewrite of every answer a `routes.transform`).
- A plugin adds routes only through its registrar (`routes.add`,
  `routes.mount`), each with its access and the credentials it accepts; no
  plugin receives the router.
- The client address and the request's origin come from the socket and the
  proxies `server.trustedProxies` trusts, never from a header alone: read
  `context.client` and `context.origin`, not `Host`, `X-Forwarded-*`,
  `Forwarded` or `X-Real-IP`. With `server.origin` set, an unknown `Host` is
  answered 421, and rate limits key on `context.client.bucket`.
- Outbound HTTP to an address an operator or user can choose goes through
  `guardedFetch` (`jsails/support/server`), which refuses private and loopback
  addresses and re-checks every redirect.
- Redirects stay on the origin: `Respond.redirect`, a page's `reply.redirect`
  and a server-component action's `redirect` accept only a same-origin path.
  A target that came with the request goes through
  `safeRedirectPath(input, fallback)` (`jsails/api`); another origin needs
  the explicit `Respond.redirectExternal`, with a URL the code chose.
- Server-component state is signed for integrity, **not encrypted**, and
  readable by the client — never put secrets in it. There is no exactly-once or
  replay protection, so actions must be idempotent. A static export renders a
  component's static form: `staticFallback` (`<template static>`), or, with
  `staticRender: 'initial'`, its own render over `initialState` with inert
  tools when `authorize` returns exactly `true` for the session-less static
  context; a component with neither, or whose static form is denied or fails,
  fails the build.
- The built-in Socket.IO broadcast adapter enforces the framework's auth,
  origin, and channel checks; a custom adapter owns all of that itself.
- Never trust producer HTML. Rich text is persisted as a canonical block
  document (`jsails/rich-text`), read only through `parseRichText` (which
  refuses rather than repairs), stored only after `normalizeRichText`, and
  rendered through the allowlisted server renderer (`@jsails/editor/server`),
  which escapes every text and emits only URLs the model's predicates accepted.

## Plugins

- A new plugin is written with `definePlugin` from `jsails/kernel`. Its
  options are a Zod schema of data, `fn()`, `tokenRef()` and `moduleOption()`
  (never instances); its variables are declared in `env` with `envVar.*`, never
  read from `process.env`; its setup only wires services, and a connection is a
  substrate resource. Check it with `testPlugin` from `jsails/testing`.
- A `definePlugin` plugin cannot run long-running work (a worker, a
  listener, a poller) yet: `lifecycle.register` for a role the process runs
  fails boot with `plugin.lifecycle_unavailable` until the kernel starts
  lifecycle units, so such a plugin stays on the `JsailsPlugin` contract of
  `jsails/extensions` for now.
- A plugin configured more than once (two disks) declares `key`, a function
  of its options; each instance is named `<plugin>:<key>` and provides keyed
  tokens (`diskToken.named(key)`). Without `key`, two instances fail boot.
- `plugins.use` entries always run, and nothing else activates plugin code:
  no database row, file or admin page.
- A plugin owns tables through its `schema` contribution
  (`schema: lazy(() => import('./schema.js'))` default-exporting
  `{ models }`), or a `JsailsPlugin`'s `schema.entities`; `db:push` and
  `db:diff` collect them from `plugins.use` without calling `setup`.
- A plugin package describes itself in the `jsails` field of its
  `package.json`: a v1 manifest (id, version, name, summary, publisher,
  `jsailsCompat`, apiTier, registered `permissions`, `entry`, and optional
  settings, schema, admin and env). A bundle's `manifest.json` uses the same
  schema and may not declare commands, generators, autoload or env.
- Browser-safe subpaths include `jsails/api`, `jsails/client`,
  `jsails/rich-text`, `jsails/view`, and `@jsails/theme`. `jsails/database`, `@jsails/blog`,
  `@jsails/media`, `@jsails/editor/server`, and most plugins are server-only —
  never import a server-only module into a client island.

## Jobs, commands, and autoload

- Jobs are `ApplicationJob` classes or `defineJob` results in
  `jobs/**/*.job.ts`; they register themselves, so there is no job registry.
  Schedules are data (`jsails.schedules.json`), not code.
- A command is a module under `commands/**` that default-exports
  `defineCommand({ summary, options, positionals, needs, run })`; its path is
  its name (`commands/db/seed-demo.ts` is `jsails db:seed-demo`) and it runs
  from its build in `dist/commands/`. A package contributes commands through
  the `jsails.commands` field of its `package.json`. Commands are not part of
  the app config. `defineCommandJob` is the explicit bridge from a command to
  a job; commands never become jobs by name.
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
- Errors are declared with `defineErrors(domain, codes)` from `jsails/errors`
  (the error kernel: browser-safe, no dependencies), raised as
  `new Registry.Error(code, context)` and recognized with `Registry.is(error,
  code)`, never `instanceof`. Each code is snake_case (`invalid_<thing>`,
  `missing_<thing>`, `unsupported_<thing>`, `not_found`), declares its `kind`
  and its `audience` (`operator` unless the caller may see it), and renders its
  message from typed context (identifiers, counts, relative paths, enum
  members), so a message never echoes secrets or raw input.
- Wrap a failure with `{ cause }` rather than putting its text in your
  message. The CLI prints a failure's cause chain under its message, value-free:
  a registry error in full (rendered from its code and context, so appending to
  `error.message` adds nothing), any other error only as its class name, Node
  error code and `path:line:column`; a thrown error that is not a framework
  error gets a fixed top line, not its message. Set `JSAILS_DEBUG=1` in the
  shell to also print the underlying messages and stacks, which may hold values
  from your code or environment; a `.env` file or credentials may not set it.
  An `identifier` context slot admits any name-shaped string, so a registry
  author never puts a token, key or user input in one.
- Tests use `node:test` with `node:assert/strict`. `jsails test` needs a live
  database, uses the `*_test` database, and `withTestTransaction` rolls back each
  test.
