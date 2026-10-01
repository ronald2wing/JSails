---
title: CLI
order: 21
section: Operating
---

# CLI

The `jsails` binary is the single entry point for scaffolding, serving, schema
reconciliation, jobs, and deployment planning. It is human-first: it scaffolds
and serves, but decisions with domain impact — destructive schema changes,
deploy configuration — stay explicit human actions.

## Built-in commands

The CLI implements these built-ins:

- `db:push` — diff the declared model schema against the live database and apply
  the plan. Refuses destructive changes unless `--allow-destructive` is passed;
  `--dry-run` prints the plan without applying.
- `db:diff` — diff the declared model schema against the live database
  (read-only). `--sql` prints the driver-specific SQL instead of the operation
  summary.
- With a database config that default-exports `defineSchemaConfig()` from
  `@jsails/database`, both commands run the data layer's schema core instead.
  `db:push` applies every safe operation and defers the blocking and
  destructive ones. `db:diff` prints each deferred operation with a digest, and
  `db:push --approve <digest>` (repeatable) applies that operation and no other.
  Operations that only make sense together (an index or foreign key replaced
  under its name, a foreign key dropped so its columns can change type) apply
  as one unit: all of them, once each is safe or approved, or none.
  A digest whose table has changed since it was printed refuses the push.
  `--approve-all` applies everything, in development and test only.
  `--wait-lock <seconds>` bounds the wait for another push (default 60), and
  `--json` prints the plan or the push report. A push that deferred work exits
  3. The TypeORM-path flags (`--dry-run`, `--allow-destructive`, `--sql`,
  `--app-config`) are refused there, and the new flags are refused on a
  `JsailsDataSource` config.
- `work` — run the app's `worker` role: start the lifecycle units its plugins
  register for it (the `jobsPlugin` worker, which registers schedules), until
  `SIGINT` / `SIGTERM`.
- `schedule` — register schedules once, then exit.
- `schedules` — list registered schedules (`--json` for machine-readable output).
- `queue` — a read-only queue dashboard.
- `queue:failed`, `queue:retry`, `queue:forget` — list, re-dispatch, or delete
  the jobs recorded in the runtime config's failed-job history (see
  [Jobs](/docs/jobs#failed-job-history)).
- `build` — static export into `out/`.
- `build:meta` — generate the `.jsails/` artifacts before `tsc` (`--dir`
  selects the project root).
- `inject:auto-imports` — inject scoped Preact imports into compiled `dist/`
  output (`--dir` selects another output directory).
- `serve` — run the app's `web` role and listen until `SIGINT` / `SIGTERM`;
  `--with worker` runs the `worker` role in the same process. A second signal
  aborts what is still draining.
- `create` — scaffold a new project.
- `dev` — compile, watch, and serve. The served process runs the `web` and
  `worker` roles together (`serve --with worker`), so jobs dispatched in
  development run, over the in-memory adapter too.
- `seed` — run registered database seeders.
- `make:<page|api|job|model|command|server-component|serializer|middleware|content>`
  — generate a single conventional file.
- `convert <path>` — toggle a `.jsails` component between one file and a
  folder (see [Converting a component](#converting-a-component--convert)).
- `jamal` — runs the project's `@jsails/jamal` install with the same
  arguments and exit code: local services in development and single-host
  production deploys (see
  [Deployment](/docs/deploy)). Without the package it prints the install line
  and exits 1.
- `plugins` — list the plugin packages the app depends on and check them
  against the framework version (see
  [Plugins](/docs/plugins#discovery-and-check)). It reads `package.json`
  manifests and no config.
- `inspect`, `describe`, `explain` — read-only introspection (see
  [Introspection](/docs/introspection)).
- `mcp` — start the MCP introspection server over stdio (see [MCP](/docs/mcp)).
- `agents:setup` — write `.mcp.json`, `AGENTS.md`, and a JSails skill so an AI
  coding agent can drive the app.
- `i18n:missing` — report translation keys used in code but absent from the
  catalogs (see [Internationalization](/docs/i18n)).
- `test` — boot the test database, reconcile its schema, and run `node --test`.
  The reconcile is destructive (the test schema follows the models exactly), so
  it only ever targets a test database: a configured database whose name
  already looks like one (`test`, or ending in `_test`/`-test`/`.test`, such as
  `app_test` or `storage/app_test.sqlite`) is used as is — a leading segment
  such as `test_shop` does not count; otherwise the database config is re-evaluated with
  `DATABASE_NAME=<name>_test`, and the command refuses to run unless the result
  carries exactly that name. After connecting, the command also asks the
  server which database the connection actually uses (`current_database()` on
  PostgreSQL, `DATABASE()` on MySQL/MariaDB, the database file on SQLite) and
  refuses to reconcile unless that name looks like a test database too, so a
  `DATABASE_URL` cannot redirect the reconcile to another database; a driver
  whose database it cannot determine is refused as well.
  `--allow-non-test-database` skips both checks. The command runs as the
  `test` environment unless `JSAILS_ENV` or `--env` names another, and then
  refuses to run, because the guard must vet the same environment files the
  test run loads.
  `--app-config` selects the app config whose plugin schema is reconciled too
  (as `db:push` does, unmanaged tables included: they are left alone), and the command exits with the test run's status — a
  run killed by a signal is a failure, and Ctrl-C reaches the test process.
- `check` — load the app config and report whether it loads; `--deploy` also
  checks it for a deploy (`server.origin`, and the proxy trust against
  `JSAILS_TRUSTED_PROXIES`) in the `production` environment unless `--env` or
  `JSAILS_ENV` names another, exiting 1 on an error; `--json` prints one
  document. It reads the variables the deployed app receives, so it is run
  where they are set: `jamal deploy` runs it inside each new release image (see
  [Origin, hosts and proxies](/docs/deployment-proxies#jsails-check---deploy)).
- `console` — an interactive REPL against the app.
- `credentials` — `init`, `edit`, `set`, `unset`, `show`, `import`, or `rotate`
  the sealed per-environment credentials (see
  [Configuration](/docs/configuration#environment-files-and-credentials)).

Every command declares its options and arguments in one table, and
`jsails <command> --help` prints the help generated from it, without resolving
the environment or loading the command. An unknown flag, a missing argument,
or an extra one is a usage error (exit 2) that names the flag only, never a
value. `jsails --help` (or `jsails` alone) lists every command;
`jsails --version` prints the framework version.

`--env <name>` is the one option that comes before the command
(`jsails --env staging serve`): it names the environment, outranking
`JSAILS_ENV`. Before the command runs, the bin resolves that environment and
applies it to `process.env` (see
[Configuration](/docs/configuration#environment-files-and-credentials)).
Each command declares whether it uses the sealed credentials: one that runs
the app stops with `credentials.missing_key` when the document is sealed and
no key opens it, while `build`, `build:meta`, `inject:auto-imports`,
`make:*`, `credentials`, and help never open it. `create` resolves no
environment: the directory it runs in is not the project it scaffolds.

A command costs what its own path needs. The bin (`bin.cjs`, which checks the
Node major before it loads anything else and refuses an older Node with the
floor it needs) loads the command table, which imports only types, then only
the chosen command: `jsails --help`, a command's own `--help` and a usage
error load no third-party package and import nothing from the project, the
app config loader (and Zod, which
validates it) loads only when a command reads the app config and brings in
nothing else (no HTTP server), the application only when one is assembled
(`build`, `serve`), and the data layer only for the commands that open a
database. `jsails mcp` answers the handshake and
`tools/list` without loading the app config; each tool loads it on its call. The
repository's import-graph gate holds a module ceiling for representative
invocations, so a regression fails CI.

## Failure reports

A failed command prints one `jsails:` line, then the chain of underlying
failures, one indented `caused by:` line each. No line carries a value from
your code or environment unless you ask for it:

- The top line holds the error's message (and a `hint:` line when the error
  suggests a fix) when the error is a framework error. A registry error's
  message is rendered again from its code and context, so text code appended
  to it later is not printed. Any other error (a driver's, the operating
  system's, one your code threw) gets a fixed line such as
  `jsails: the command failed`, and an `error:` line under it with that
  error's facts, as for a cause below.
- A cause that is a registry error prints its message and hint. Any other
  cause prints only facts that cannot carry a value: its class name, a Node
  error code such as `ENOENT` (or a database driver's error code), the system
  call that failed, and where it was thrown as `path:line:column`, relative to
  the working directory. A hand-written framework error prints its class name
  and code.
- A message, a stack and a source line are left out, because that is where a
  key, a connection string or an offending token ends up.

A syntax error in a config module, or in a module it imports, is located by
parsing the modules again (never running them), since Node puts no location on
the error `import()` throws:

```text
jsails: failed to load app config "jsails.app.js"
  caused by: syntax error at lib/settings.js:1:26
  caused by: SyntaxError
  (set JSAILS_DEBUG=1 to print the underlying error messages; they may contain values from your code or environment)
```

Set `JSAILS_DEBUG=1` in the shell or the process manager to print each
summarised error's message and stack under its line as well; the closing note
is then left out. The output may hold values from your code or environment, so
keep it out of shared logs. A project file cannot set it: `.env`, `.env.<name>`,
the secrets file and the credentials refuse `JSAILS_DEBUG` as a reserved key,
so a committed file never turns full detail on for every run.

The exit code does not depend on the report. Commands that run your
configured code (`db:push`, `seed`, `work`, the `queue` commands, …) exit 1
for a failure, 75 for one a script may retry, and 130 for an interrupted
command, which prints nothing; the introspection commands (`inspect`,
`describe`, `explain`, `i18n:missing`) and your project's own
commands exit 1. The `jamal` bin and the `jsails mcp` server log report
failures the same way.

## Config modules and `--config`

Every command declares which compiled ESM config module it reads, and `--config
<path>` overrides the path of *that* module — so `--config` means the app config
for an app command and the database config for a schema command. The app
config may be `jsails.config.ts`, a `defineApp` module loaded by Node's type
stripping (see [Configuration](/docs/configuration#jsails-config-ts)); the other
config modules reject `.ts` paths, so compile them first with `tsc`.

- `jsails.app.js` (or `--config jsails.config.ts`) — `build`, `serve`, `work`,
  `dev`, `inspect`, `describe`, `explain`, `mcp`, and `i18n:missing`.
- `jsails.database.js` — `db:push`, `db:diff`, `console`, and `test`.
- `jsails.runtime.js` — `schedule`, `queue`, `schedules`, `queue:failed`,
  `queue:retry`, and `queue:forget`.
- `jsails.seed.js` — `seed`.

A command that reads a second module takes a qualified flag for it: `db:push`
and `db:diff` take `--app-config` (to collect plugin-owned schema from the app
config without calling any plugin `setup`; an absent app config contributes no
plugin tables, and the tables plugins declare as `schema.unmanagedTables`, plus
the database config's `unmanagedTables` export, are left out of the plan), `describe` and `mcp` take `--db-config`, and
`console` takes `--runtime-config`. `create` and `agents:setup` read no config.

`build`, `serve`, and `dev` take no host/port/output flags — those come from the
app config.

## Scaffolding with `create`

`create <dir>` generates the starter file set and writes it through
`writeProjectFiles`. It refuses an existing non-empty target, a symlink target,
and a non-directory target, and never overwrites an existing file.

```sh
npx jsails@latest create my-app --install
```

From a framework source checkout, use the built CLI and a packed dependency:

```sh
node dist/src/cli/bin.cjs create my-app --install \
  --jsails-dependency "file:/tmp/jsails-1.0.0.tgz"
```

Flags:

- `--name <pkg>` — the package name; defaults to the directory basename.
- `--jsails-dependency <spec>` — a `file:` tarball/path or an npm semver range
  for the generated `package.json`.
- `--install` — run `npm install` after writing. Nothing is installed unless this
  is passed; a failed install returns its exit code but keeps the scaffold so you
  can retry.
- `--no-git` — skip the initial commit. By default `create` runs `git init`,
  stages the whole scaffold, and commits it as `chore: scaffold with jsails`, so
  your first edit has a baseline to diff against. The commit runs after
  `npm install`, so the lockfile is part of it. It is skipped — never failed —
  when the target is already inside a git work tree (scaffolding into a monorepo
  must not create a nested repository), when `git` is not installed, or when no
  `user.name`/`user.email` is configured. A skipped commit still exits 0.
- `--starter` — select the default static-site starter explicitly.
- `--admin` — scaffold the server-rendered auth + admin web app.
- `--blog` — scaffold the standalone blog CMS (admin included).
- `--saas` — scaffold the server-rendered admin web app with multi-tenancy and
  feature flags enabled (admin included; no blog/plugin manager).
- `--cli` — scaffold a CLI-only project: commands, jobs, and plugins on the same
  framework, with no web surface.

There is no `--auth` flag: the `--admin`, `--blog`, and `--saas` presets include
auth; the default starter does not. All five preset flags are mutually exclusive.

## Generators — `make:*`

`make:<page|api|job|model|command|server-component|serializer|middleware|content> <name> [--dir <path>] [--no-test]`
generates conventional files using exclusive creation, so an existing file is
never overwritten:

- `pages/<name>.tsx`
- `api/<name>.ts`
- `jobs/<name>.job.ts`
- `models/<name>.ts`
- `commands/<name>.ts`
- `components/<name>.tsx`
- `serializers/<name>.ts`
- `middleware/<name>.ts`
- `content/<collection>/<name>.md` (`make:content <collection> <name>`)

`--dir <path>` sets the base directory (default: the current directory).

Every code generator also writes `test/<kind>/<name>.test.ts` by default. The
tests use `createTestRequestContext`, `createComponentTestHarness`, or the real
job/model/command imports, so they run under the starter's native `npm test`
without a browser or external service. Pass `--no-test` to omit the companion
test; `make:content` never writes one because it produces Markdown.

Names must match `[A-Za-z][A-Za-z0-9_-]*` and are case-normalized. The templates
follow the starter's own conventions so they compile against a fresh scaffold.
The command never imports application code.

`make:page <name> --mfc` and `make:server-component <name> --mfc` write a
`.jsails` component as a folder instead: `pages/<name>/<name>.jsails` and
`<name>.ts`, or the same under `components/` for a live component. The files
are the `.jsails` template split exactly as `convert` splits a file, and no
companion test is written. `--mfc` on another generator is a usage error, and
in a project that does not sync `.jsails` sidecars (no `.jsails/sfc`
directory, which no generated app has yet) it is refused as
`make.no_sidecars`, because there the folder's `<name>.ts` would be compiled
as a module of its own (see
[One file or a folder](/docs/view#one-file-or-a-folder)). A generator creates
its files all or none: when one cannot be created, the ones it already wrote
are removed again.

## Converting a component — `convert`

`convert <path>` toggles a `.jsails` component between its two layouts (see
[One file or a folder](/docs/view#one-file-or-a-folder)). Given a single file
(`pages/about.jsails`) it writes the folder `pages/about/` (`about.jsails`,
and `about.ts`, `about.css`, `about.scoped.css` for the blocks the file has);
given a folder (`pages/about`, or `pages/about/about.jsails`) it writes the
single file. A server module `about.server.ts` moves with the component.

Block bodies and comments move byte for byte, so a round trip gives back the
same bytes, and the relative imports of the moved TypeScript are rewritten so
each names the same file. The command refuses, with the diagnostics that
explain it and without writing anything, a component whose blocks do not scan
cleanly (`convert.invalid_blocks`), whose script does not parse
(`convert.script_syntax`), with more than one `<style>` or `<style scoped>`
(`convert.style_count`), a folder whose `.jsails` file holds a `<script>`
or `<style>` (`convert.folder_block`), and a folder whose `about.ts` holds
`</script`, or whose style file holds `</style`, which would end the block in
one file (`convert.end_tag`, positioned in the file that holds it). It turns
a file into a folder only in a project that syncs `.jsails` sidecars, its
working directory holding `.jsails/sfc` (`convert.no_sidecars` otherwise);
a folder becomes a file in any project. It never overwrites a file
(`convert.target_exists`): the new files are created all or none before an
old one is removed, so a failure leaves the component as it was. It formats
nothing and imports nothing.

## Commands of the app and of its dependencies

Besides the built-in commands, `jsails <name>` runs a command from one of two
places, found without importing anything:

- **The app.** `jsails a:b` runs `dist/commands/a/b.js`, the build of
  `commands/a/b.ts`: the module's path is its name, and a colon is a
  directory. Build first; help lists a source that has no build as not built.
- **A direct dependency.** A package lists its commands in the `jsails` field
  of its `package.json`, each with a `name`, a `summary` and the `module`
  (the package or one of its exported subpaths) that default-exports it.
  `@jsails/config` declares `config:export` and `config:import` this way;
  in a project that does not install it, `jsails config:export` says which
  package to install (`cli.missing_dependency`).

A name both sources declare, or two dependencies declare, is refused
(`cli.ambiguous_command`). Neither source can take a built-in name: while a
dependency or the app declares one, running that built-in is refused
(`cli.reserved_command`, naming the source) rather than letting it run in
place of the project's command, and `jsails --help` lists the clash under
Problems.

A command module default-exports one `defineCommand(...)`:

```ts
// commands/invoices/send.ts — `jsails invoices:send <id> [--force]`
import { defineCommand } from 'jsails';

export default defineCommand({
  summary: 'Send one invoice',
  options: { force: { type: 'boolean', summary: 'Send it again' } },
  positionals: [{ name: 'id', summary: 'The invoice id' }],
  needs: { services: [] },
  async run(context) {
    const [id] = context.positionals;
    context.stdout(`sending ${id}${context.values.force === true ? ' again' : ''}`);
  },
});
```

- `options` are declared by flag name, each a `string` or `boolean` with a
  `summary` (and an optional single-letter `short`, `multiple`, or the
  `value` placeholder help shows). Arguments are parsed with
  `node:util`'s `parseArgs`: an undeclared flag, a missing argument, or an
  extra one is a usage error (exit 2) that echoes no value.
- `needs` says how much of the app the command runs over: `environment` (the
  default: the resolved environment, no app code), `app` (the loaded app
  config), `plugins` (its resolved plugin graph), `{ services: [roles] }`
  (the plugins set up; `context.services.registry.get(token)`), or
  `{ kernel: [roles] }` (their units started too). Whatever was opened is
  closed after `run`, the last stage first. A close that fails fails the
  command, and when `run` failed too, the report shows both failures.
- `run(context)` returns nothing (exit 0) or an integer from 0 to 255. It
  gets `values`, `positionals`, the resolved `env` and `environment`,
  `cwd`, `stdout`/`stderr`, `usage(message)` for a usage error of its own,
  and a `prompter` (`text`, `confirm`, `select`). Under `--no-interaction`
  (`-n`) a question fails the command (`cli.interactive_unavailable`) instead
  of blocking.
- An error the command throws is reported as a fixed line; its message is not
  printed, since it may hold a value.
- `jsails <name> --help` prints the help generated from the definition,
  without resolving the environment. `jsails --help` imports no app or
  dependency code: it lists app commands by file name, with the summary
  recorded in `.jsails/commands.json` the last time each built file ran (a
  cache keyed by the file's digest, so an edited command shows none), and
  dependency commands with the summary their manifest declares.
- `--env <name>` before the command chooses the environment, as for every
  command.

Test a command in-process with `runCommand` from `jsails/testing`, which
parses the arguments the same way, reads the exit code the same way (a value
that is no integer from 0 to 255 throws `cli.invalid_exit_code`), and runs
without interaction unless the test passes a prompter (see
[Testing](/docs/testing)). A command that needs only the environment can be
scheduled through `defineCommandJob` in `jsails/jobs` (or `@jsails/jobs`);
the scheduler still runs a job, not a CLI process.

## Agent files — `agents:setup`

`jsails agents:setup` writes the files an AI coding agent needs to drive the
app: `.mcp.json` (registers `jsails mcp` as the `jsails` MCP server), `AGENTS.md`
(the framework guide shipped in the `jsails` package), and
`.agents/skills/jsails/SKILL.md` (a loadable JSails skill). Existing files are
left alone — `.mcp.json` is merged, the other two are skipped — unless `--force`
(`-f`) is passed, which overwrites `AGENTS.md` and the skill but never
`.mcp.json`. The command reads no config, opens no connection, and imports no
plugin code.

```sh
jsails agents:setup
jsails agents:setup --force   # refresh AGENTS.md and the skill after a framework upgrade
```

## Next steps

- [Jobs](/docs/jobs) — `work`, `schedule`, and `queue`.
- [Introspection](/docs/introspection) — `inspect`, `describe`, `explain`, and the
  opt-in runtime endpoint.
- [Migrations](/docs/migrations) — `db:push` and `db:diff`.
