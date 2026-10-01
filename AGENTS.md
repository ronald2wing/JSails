# Contributing to JSails

Guidance for working on the JSails framework itself. The guide for apps built
on JSails is [`core/AGENTS.md`](core/AGENTS.md); it ships in the `jsails`
package and states the runtime and security invariants every change here must
keep. Read it first. The public API reference is the docs site
(<https://jsails.org/docs>, source under `website/content/docs/`), and
[`docs/CODEMAP.md`](docs/CODEMAP.md) is the annotated source map, generated
by `npm run codemap` from the file tree and each module's header comment.

## Repository layout

An npm-workspaces monorepo:

- `core/` — the `jsails` package: `core/src` (one directory per subpath; CLI
  commands live in `core/src/cli/commands/<command>.ts`), `core/test` (mirrors
  `core/src`), and `core/templates` (the `jsails create` starters).
- `packages/<name>/` — one `@jsails/<name>` package each, with its own `src/`,
  `test/`, and `package.json`. A package that describes itself to the
  framework's managed/marketplace surface does so in the `jsails` field of its
  `package.json`; libraries and code-only plugins have none.
- `website/` — the docs site, a separate package built with JSails. It is not
  a workspace: it installs `jsails` and `@jsails/content` through `file:`
  links.
- `scripts/` — repo tooling. `workspaces.mjs` (repo root, workspace
  discovery, manifest reader) and `subprocess.mjs` (`run`, `exitStatus`, the
  platform `npm`) are the primitives every other script builds on.
- `docs/` — the code map and design records.
- The root `LICENSE`, `README.md`, and `CHANGELOG.md` are git symlinks into
  `core/`. A Windows checkout needs `core.symlinks=true` (and symlink
  privileges) or they appear as one-line text files.

Every workspace compiles `src/` and `test/` into its own `dist/`.
`tsconfig.base.json` holds every compiler option and, through `${configDir}`,
the `rootDir`/`outDir`/`include` layout, so a workspace `tsconfig.json` is a
bare `extends`. `core/tsconfig.json` additionally maps `jsails/jsx-runtime` to
source, because core compiles its own JSX before that subpath exists in
`dist/`. `website/tsconfig.json` extends the same base with its own `include`.

## Commands

```sh
npm install
npm run check                          # the full gate
npm run verify:starter -- --skip-browser
npm --prefix website run check
```

- `npm run check` builds every workspace from clean, runs `lint`,
  `format:check`, `check:structure`, and `check:declared-types` in parallel,
  then runs every workspace's tests. The build comes first because typed lint
  resolves `jsails` through `core/dist` and the declared-types gate reads
  `dist/**/*.d.ts`.
- `npm test` also rebuilds every workspace from clean before running the
  tests; `npm run build`, `build:clean`, `typecheck`, and `test` run in every
  workspace through `scripts/run-workspaces.mjs`, which orders workspaces by
  their declared dependencies. A new package needs no root edit; an undeclared
  or cyclic dependency fails the run.
- `npm run check:structure` runs `scripts/check-src-structure.mjs` (naming
  invariants of every `src/` and `test/`), `scripts/check-licenses.mjs`
  (every workspace `LICENSE` equals `core/LICENSE`), and
  `scripts/build-codemap.mjs --check` (`docs/CODEMAP.md` matches the tree,
  every module has a `/** … */` header, every barrel-less directory has a
  summary in the script).
- `npm run check:declared-types` (`scripts/check-declared-types.mjs`) fails
  when a shipped `dist/**/*.d.ts` imports a package that is not in that
  workspace's `dependencies`/`peerDependencies`. The starters compile with
  `skipLibCheck`, so a type package that only lives in the root
  `devDependencies` would otherwise reach consumers as `any` without an error.
  A type-only package that a declaration imports (`schema-dts`,
  `socket.io-adapter`) is therefore a `dependency` of `core`.
- One workspace: `npm run build -w jsails`, `npm test -w @jsails/admin`.
  `test:watch` exists per workspace and reuses the existing `dist/`; restart it
  after adding a test file. Core also has `build:watch` and `test:coverage`.
- One test file: `npm run build && node --test core/dist/test/path/to/file.test.js`
  (or `packages/<name>/dist/test/...`). `scripts/run-tests.mjs` collects files
  itself and defaults `NODE_ENV=test`.
- The default suite opens no external service. `npm run verify:integrations`
  is the only live-service harness: it needs an existing build and is gated per
  stage on database, Valkey, and Docker variables.
- `npm run verify:starter` packs the framework and the packages the presets
  install, generates each preset, installs it, and runs its checks. Browser
  stages need Chromium (`JSAILS_BROWSER_PATH`, default `/usr/bin/chromium`);
  `--skip-browser` records them as skipped.
- `npm run website` builds `jsails` and `@jsails/content`, then installs and
  builds the docs site. It is the single definition of the site build:
  `netlify.toml` runs it, and Netlify reads the Node line from `.nvmrc`.
- `npm --prefix website run check` builds the docs site, typechecks its
  browser bundle, and validates every documented import against the package
  exports (`website/scripts/check-docs.mjs`).
- `jamal.config.js` declares the MariaDB and Valkey pair a checkout develops
  against; `jamal` is not on `PATH` here, so after a build use
  `node core/dist/src/cli/index.js jamal up`. If Docker access is denied, run
  it under `newgrp docker`.
- To try an unpublished framework in a fresh app, pack it and point `create` at
  the tarball:

  ```sh
  npm run build && npm pack -w jsails --pack-destination /tmp
  node core/dist/src/cli/index.js create my-app --install \
    --jsails-dependency "file:/tmp/jsails-1.0.0.tgz"
  ```

## Verification discipline

1. `npm run format`
2. `npm run check`
3. `npm run verify:starter -- --skip-browser` when starter templates, public
   subpaths, or generated files change.
4. `npm --prefix website run check` when docs or public exports change.

For template or ignored-file changes, also verify a clean checkout:
`git archive HEAD | tar -x -C /tmp/check && cd /tmp/check && npm ci && npm run check`.
A file that exists only because it is untracked passes locally and fails CI.

## Source boundaries

- `core/src/index.ts` is the root barrel. `core/package.json` `exports` defines
  every public subpath, each with its own barrel and a `{ types, default }`
  pair. Do not add a subpath casually.
- Substrate that must stay in core: CLI bootstrap, the app-config loader,
  `runExtensions`, route discovery, and plugin enablement. Everything above that
  line is plugin-shaped and belongs in `packages/`.
- A plugin's schema lives in `JsailsPlugin.schema.entities`; `db:push`/`db:diff`
  (configured by `jsails.database.js`) resolve `plugins.use` without calling
  `setup` (`core/src/plugins/schema.ts`).
- Keep the rich-text conversion and mount layers model-agnostic: `jsails/rich-text`
  (core) is the persisted schema, `@jsails/editor` the Editor.js UI and server
  renderer, and neither imports blog persistence.
- Do not add a dependency when an existing one or an in-repo implementation
  covers the domain.

## Starter presets

`jsails create` has five mutually exclusive presets: the default static site
(`core/templates/starter/`), `--admin` and `--saas` (server-rendered, from
`core/templates/starter-web/`), `--blog` (the standalone blog CMS), and `--cli`
(`core/templates/starter-cli/`).

- `createStarterFiles` reads a fixed template allowlist; a file in the tree is
  not copied just because it exists.
- When starter files change, update the expected key sets and counts in
  `core/test/app/starter.test.ts`, `core/test/cli/create-cli.test.ts`, and
  `scripts/verify-starter/starter-files.mjs`.
- The three `.gitignore.template`s share one order; `starter-web` is the
  superset and the other two are subsets of it. Each un-ignores
  `.env.*.example`, so a generated app keeps its committed env example.
- `core/templates/starter-web/.env.auth.example.template` is tracked on purpose;
  the root `.gitignore` un-ignores `core/templates/**/.env.*.template`. Keep
  that.
- Preset-specific guide text lives in `core/src/app/starter/guides.ts`; it is
  prefixed onto `core/AGENTS.md` in each generated app.

## Toolchain

- `tsc` is TypeScript 7 (`@typescript/native`); the `typescript` package is
  `@typescript/typescript6`, kept for typescript-eslint. Use the npm scripts or
  `node_modules/.bin/tsc`.
- `noUncheckedIndexedAccess`, strict mode, and no-unused locals/parameters are
  on everywhere, the docs site included. Relative ESM imports need `.js`.
- ESLint is type-checked for every workspace's `src/` and `test/` and for the
  docs site (`website/pages`, `website/src`, and `website/client`, the last
  through `website/tsconfig.client.json`); templates use the untyped preset;
  the repo tooling (`scripts/*.mjs`, `website/scripts/*.mjs`, and the JS
  configs) is linted with the core recommended rules. Do not add
  `eslint-disable` to hide a real issue — disable a rule in config, with a
  written reason, only when it conflicts with an established pattern.
- Prettier owns style (2 spaces, single quotes, semicolons, trailing commas,
  100 columns, LF) and reads `.gitignore`. Markdown is not formatted; edit it
  deliberately.
- `scripts/check-src-structure.mjs` rejects, in every `src/` and `test/`,
  file/directory basename collisions, generic names (`utils`, `helpers`,
  `misc`, `internal`) for files and directories alike, and role suffixes
  (`-helpers`, `-shared`, `-utils`, `-common`, `-misc`). A test file is also
  judged by its subject (`render-helpers.test.ts` fails like
  `render-helpers.ts`).
- `.nvmrc` is the one declaration of the Node line (26): CI sets up Node from
  it and Netlify reads it; every `engines` field states the same floor. When
  CI and a local run disagree, compare against a clean `npm ci` checkout.
- The root `.gitignore` lists what this repo's own tooling produces, plus
  secrets. Per-user editor and OS noise belongs in a global excludes file.

## Conventions

- Read before writing; match the surrounding naming, test style (`node:test` +
  `node:assert/strict`), and value-free error classes (`code`, no echoed secrets
  or input). Prefer frozen descriptors and plain data over method-heavy APIs.
- No catch-all files, dead code, commented-out code, empty catches, emoji, or
  new `any` (the deliberate existing sites are documented in
  `eslint.config.mjs`).
- Comments explain why, not what, and describe the code as it is — not the
  history of how it got there.

## Docs and release

- Update `website/content/docs/` when the public API or a subpath changes, and
  run `npm run codemap` after any file is added, moved, or renamed (the
  structure gate fails on a stale map).
- `npm run release` runs the full gate, then publishes every workspace with
  `--ignore-scripts`: publishing never runs lifecycle hooks, so the gate in
  `check` is the only code that runs. It is the only publish path; do not
  publish or deploy unless explicitly asked.
- Stage explicit paths only — never `git add -A`, `git reset --hard`, or
  `git clean -fd`. Never commit `dist/`, `test-results/`, `.content-cache/`, or
  generated reports.
