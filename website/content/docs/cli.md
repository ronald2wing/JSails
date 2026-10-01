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
- `work` — run a job worker and register schedules.
- `schedule` — register schedules once, then exit.
- `schedules` — list registered schedules (`--json` for machine-readable output).
- `queue` — a read-only queue dashboard.
- `build` — static export into `out/`.
- `build:meta` — generate the `.jsails/` artifacts before `tsc`.
- `inject:auto-imports` — inject scoped Preact imports into compiled `dist/` output.
- `serve` — listen until `SIGINT` / `SIGTERM`.
- `create` — scaffold a new project.
- `dev` — compile, watch, and serve.
- `seed` — run registered database seeders.
- `make:<page|api|job|model|command|server-component|serializer|middleware|content>`
  — generate a single conventional file.
- `jamal` — deployment planning (see [Deployment](/docs/deploy)).
- `plugins` — list, check, resolve, install, enable, disable, uninstall, roll
  back, export, and import plugins (see [Plugins](/docs/plugins)).
- `inspect`, `describe`, `explain` — read-only introspection (see
  [Introspection](/docs/introspection)).
- `app:shape` — report which enabled plugins are live-only and would be dropped
  under a static deployment shape.
- `mcp` — start the MCP introspection server over stdio (see [MCP](/docs/mcp)).
- `agents:setup` — write `.mcp.json`, `AGENTS.md`, and a JSails skill so an AI
  coding agent can drive the app.
- `i18n:missing` — report translation keys used in code but absent from the
  catalogs (see [Internationalization](/docs/i18n)).
- `live:list` — list the live publications an app serves (see [Live](/docs/live)).
- `test` — boot the test database, reconcile its schema, and run `node --test`.
- `console` — an interactive REPL against the app.
- `credentials` — `edit`, `show`, or `regenerate` the encrypted per-environment
  credentials (see [Configuration](/docs/configuration#environment-files-and-credentials)).
- `convert:component` — convert a component between single-file and multi-file
  shapes.

`jamal`, `plugins`, `make`, `inspect`, `describe`, `explain`, `app:shape`, `mcp`,
`agents:setup`, `i18n:missing`, `test`, `console`, and `convert:component` parse
their own arguments and flags; the other built-in commands share the global
flags, and a flag passed to a command that does not read it is rejected before
anything is loaded.

## Config modules and `--config`

Every command declares which compiled ESM config module it reads, and `--config
<path>` overrides the path of *that* module — so `--config` means the app config
for an app command and the database config for a schema command. The commands
reject `.ts` config paths; compile them first with `tsc`.

- `jsails.app.js` — `build`, `serve`, `dev`, `live:list`, `inspect`, `describe`,
  `explain`, `app:shape`, `mcp`, `i18n:missing`, and `plugins`.
- `jsails.database.js` — `db:push`, `db:diff`, `console`, and `test`.
- `jsails.runtime.js` — `work`, `schedule`, `queue`, and `schedules`.
- `jsails.seed.js` — `seed`.

A command that reads a second module takes a qualified flag for it: `db:push`
and `db:diff` take `--app-config` (to collect plugin-owned schema from the app
config without calling any plugin `setup`; an absent app config contributes no
plugin tables), `describe`, `mcp`, and `plugins` take `--db-config`, and
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
node dist/src/cli/index.js create my-app --install \
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

`make:<page|api|job|model|command|server-component|serializer|middleware|content> <name> [--dir <path>] [--mfc] [--no-test]`
generates conventional files using exclusive creation, so an existing file is
never overwritten:

- `pages/<name>.tsx`
- `api/<name>.ts`
- `jobs/<name>.job.ts`
- `models/<name>.ts`
- `commands/<name>.ts`
- `components/<name>.tsx` (or `components/<name>/` with `--mfc`, a multi-file
  component: `<name>.tsx`, `<name>.model.ts`, `<name>.style.ts`, and
  `<name>.server.ts` — view, state schema, style contract, and server actions —
  in one directory)
- `serializers/<name>.ts`
- `middleware/<name>.ts`
- `content/<collection>/<name>.md` (`make:content <collection> <name>`)

`--dir <path>` sets the base directory (default: the current directory);
`--mfc` is valid only for `make:server-component`.

Every code generator also writes `test/<kind>/<name>.test.ts` by default. The
tests use `createTestRequestContext`, `createComponentTestHarness`, or the real
job/model/command imports, so they run under the starter's native `npm test`
without a browser or external service. Pass `--no-test` to omit the companion
test; `make:content` never writes one because it produces Markdown.

Names must match `[A-Za-z][A-Za-z0-9_-]*` and are case-normalized. The templates
follow the starter's own conventions so they compile against a fresh scaffold.
The command never imports application code.

## User-defined commands

An application can add commands without touching the entry point by declaring
them on the app config (`commands: [...]`) or on an extension
(`extensions: [{ ..., commands: [...] }]`). `runCli` dispatches a leading
non-builtin token to the custom path.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
export default {
  commands: [
    {
      name: 'hello',
      summary: 'say hello',
      usage: 'hello [name]',
      run(rawArgs, ctx) {
        ctx.stdout(`hello ${rawArgs[0] ?? 'world'}`);
      },
    },
  ],
};
```

A file-level command is a class extending `Command` and default-exported from
`commands/*.ts`:

```ts
import { Command } from '../app/application-command.js';

export default class HelloCommand extends Command {
  static readonly signature = 'hello {name?}';
  static readonly summary = 'say hello';
  static readonly audience = 'user' as const;

  async handle(): Promise<number> {
    this.stdout(`hello ${this.argument('name') ?? 'world'}`);
    return 0;
  }
}
```

`handle` may return nothing (exit 0), a number in `0..255`, or a promise of
either. The base exposes `this.argument(name)`, `this.option(name)`,
`this.arguments`, `this.options`, `this.rawArgs`, `this.stdout`, `this.stderr`,
`this.context`, and `this.prompter`. `ctx.interactive` is `false` when the
caller passes `--no-interaction` (or `-n`); the prompter fails instead of
reading from stdin.

`defineCommand({ signature, summary?, usage?, audience?, prompter?, run })`
remains the inline object form for config-declared or very small commands.
Config arrays accept either a `Command` class or a `defineCommand(...)` object.

```sh
jsails hello --config jsails.app.js Ada
```

- Syntax is `<command> [--config <path>] [raw args]` — the command name comes
  first. The custom path is taken only when `--config` is explicit or the default
  `jsails.app.js` exists.
- Only `--config <value>` / `--config=<value>` **before** a `--` delimiter are
  parsed; every other token — including `--` itself and everything after it — is
  forwarded verbatim and in original order to `run`.
- `jsails <command> --help` prints that command's exact metadata
  (`name - summary`, `Usage: jsails <usage>`) without invoking `setup`, `run`, or
  `createApplication`. Global `jsails --help` imports no app config.
- `--no-interaction` / `-n` is stripped before the command sees its arguments;
  a command that prompts fails with a clear error instead of blocking.
- A command can be scheduled through `defineCommandJob` in `jsails/jobs`; the
  scheduler still runs a job, not a CLI process.
- No application is assembled for a custom command and no extension `setup` runs.
  A config module must still be imported to collect commands, so its own top-level
  code runs — trusted app JS side effects are not prevented.
- The built-in names above (including `jamal` and `plugins`) are always reserved
  and cannot be shadowed.

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

## Deployment shape — `app:shape`

`jsails app:shape <static|full|cli> [--config <path>] [--json]` reports which
enabled plugins declare `needsLive: true` and would therefore be excluded under
a `static` deployment shape. It composes the resolved app config with each
plugin's pure `describe()`: it never imports page or API modules, opens a
connection, or runs `setup`. The summary names the target shape, the current
shape from the config (default `full`), the live-only plugin ids, and — for a
`static` target — how many enabled plugins would be dropped. `--json` emits one
JSON line with the same fields.

```sh
jsails app:shape static
jsails app:shape static --json
```

## Live publications — `live:list`

`jsails live:list [--config <path>]` lists the publications the app serves over
the live layer, one line each: name, collection, and whether an `authorize`
callback is present. Publications are registered at runtime by application code
through `definePublication`, not declared in the config, so the CLI's default
path loads the app config, resolves `plugins.use`, and reports that
publications are registered at runtime; an embedding runtime that already holds
a registry renders the full list. See [Live](/docs/live).

```sh
jsails live:list --config jsails.app.js
```

## Next steps

- [Jobs](/docs/jobs) — `work`, `schedule`, and `queue`.
- [Introspection](/docs/introspection) — `inspect`, `describe`, `explain`, and the
  opt-in runtime endpoint.
- [Migrations](/docs/migrations) — `db:push` and `db:diff`.
