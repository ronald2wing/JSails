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
- `make:<page|api|job|model|command|server-component|serializer|middleware|content|post|doc>`
  — generate a single conventional file.
- `jamal` — deployment planning (see [Deployment](/docs/deploy)).
- `plugins` — discover, check, install, enable, disable, uninstall, and roll back
  plugins.
- `inspect`, `describe`, `explain` — read-only introspection (see
  [Introspection](/docs/introspection)).
- `test` — boot the test database, migrate it, and run `node --test`.
- `console` — an interactive REPL against the app.
- `convert:component` — convert a component between single-file and multi-file
  shapes.

`jamal`, `plugins`, `make`, `inspect`, `describe`, `explain`, `test`, `console`,
and `convert:component` own their own subcommands and flags, so they are routed
before the shared flag-gating and never import an app config.

## Config-file defaults

Each command family reads a compiled ESM config module. The commands reject
`.ts` config paths; compile them first with `tsc`.

| Command family                                | Default config      |
| --------------------------------------------- | ------------------- |
| `db:push`, `db:diff` | `jsails.config.js` |
| `work`, `schedule`, `queue`                   | `jsails.runtime.js` |
| `seed`                                        | `jsails.seed.js`    |
| `build`, `serve`, `dev`                       | `jsails.app.js`     |

`build`, `serve`, and `dev` take no host/port/output flags — those come from the
app config. `create` takes no `--config`.

`db:push` and `db:diff` also accept `--app-config <path>` (default
`jsails.app.js`). They use it only to discover plugin-owned schema declared by
enabled plugins; plugin `setup` is never called. An app config that is absent
contributes no plugin tables.

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
- `--cli` — scaffold a Laravel-Zero-style CLI-only project with no web surface
  but the same framework and plugin system.

There is no `--auth` flag: the `--admin`, `--blog`, and `--saas` shapes include
auth; the default starter does not. All five shape flags are mutually exclusive.

## Generators — `make:*`

`make:<page|api|job|model|command|server-component|serializer|middleware|content|post|doc> <name> [--dir <path>] [--mfc] [--no-test]` generates
conventional files using exclusive creation, so an existing artifact is never
overwritten:

- `pages/<name>.tsx`
- `api/<name>.ts`
- `jobs/<name>.job.ts`
- `models/<name>.ts`
- `commands/<name>.ts`
- `components/<name>.tsx` (or `components/<name>/` with `--mfc`)
- `serializers/<name>.ts`
- `middleware/<name>.ts`
- `content/<collection>/<name>.md`, `content/blog/<name>.md`, `content/docs/<name>.md`

Every code generator also writes `test/<kind>/<name>.test.ts` by default. The
tests use `createTestRequestContext`, `createComponentTestHarness`, or the real
job/model/command imports, so they run under the starter's native `npm test`
without a browser or external service. Pass `--no-test` to omit the companion
test; content, post, and doc generators never write one because they produce
Markdown.

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
jsails hello --config jsails.app.js --rawargs
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

## Next steps

- [Jobs](/docs/jobs) — `work`, `schedule`, and `queue`.
- [Introspection](/docs/introspection) — `inspect`, `describe`, `explain`, and the
  opt-in runtime endpoint.
- [Migrations](/docs/migrations) — `db:push` and `db:diff`.
