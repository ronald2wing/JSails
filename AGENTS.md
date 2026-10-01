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
- The root `LICENSE`, `README.md`, and `CHANGELOG.md` are regular-file copies
  of their `core/` originals, so a checkout needs no symlink support. The
  `licenses` gate fails when one differs, so every edit to `core/CHANGELOG.md`
  or `core/README.md` (changelog lines included) is followed by
  `node scripts/check-licenses.mjs --write`, before `npm run check`.
- Windows is supported for development: a Windows CI leg runs the build and
  tests, with Windows-only failures in `scripts/expected-failures/windows.json`
  (never under `core/test/app`, `core/test/cli` or a starter, enforced by
  `scripts/test/windows-ledger.test.mjs`); a test of a POSIX-only fact (file
  modes, graceful signals, `/bin/sh`) states its platform with a win32 skip
  instead. Path code in core goes through `core/src/support/project-paths.server.ts`
  (`eslint/paths.mjs` bans the hand-written forms). `jsails serve` outside
  development/test refuses on Windows with `unsupported_platform`
  (`core/src/cli/platform-guard.ts`), and so do the server-facing `jamal`
  verbs (`packages/jamal/src/platform.ts`).

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

- `npm run check` builds every workspace from clean, then runs one parallel
  group: `lint:ci` (uncached typed lint), `format:check`, `gates`,
  `test:scripts`, and `test:coverage` (every workspace's tests with coverage
  floors). The build comes first because typed lint resolves `jsails` through
  `core/dist` and the declared-deps gate reads `dist/src`.
- `npm test` runs an incremental `npm run build` (only `check` and `release`
  build from clean), then every workspace's tests (`test:workspaces`), then
  `test:scripts`. `npm run build`, `build:clean`, `typecheck`, and `test` run
  in every workspace through `scripts/run-workspaces.mjs`. Builds start a
  workspace once its declared dependencies finish (an undeclared or cyclic
  dependency fails the run; a new package needs no root edit); tests and
  typecheck wait on nothing, and the heaviest suite starts first. Up to
  `JSAILS_WORKSPACE_JOBS` workspaces run at once (default: available
  parallelism, at most 8; `1` for serial, stable-order runs), each one's output
  printed whole. A failed build stops the run; a failed test or typecheck does
  not, so every workspace finishes and each failed one is named (a new CI
  platform leg reports all its failures in one run). A run that a termination
  signal cuts short reports itself interrupted and is not reconciled. Each
  workspace's `--test-concurrency` is its share of one
  budget (twice the available parallelism, split by the previous run's test
  wall time); `JSAILS_TEST_CONCURRENCY` overrides it. Arguments after `--` go to
  every workspace (`node scripts/run-workspaces.mjs test -- --shard=1/4`).
- A test run writes `test-results/timings.json` (wall time per workspace;
  wall and own-process CPU per test file) and prints the slowest 20 files.
- `scripts/run-tests.mjs` runs one workspace's compiled tests and reconciles
  them with the expected-failure ledgers: it fails on a failure no ledger
  lists, on a listed test that fails for another reason than its entry
  states, on a listed test that passes, is skipped, or no longer exists, and
  on a test process that does not end cleanly. The `scripts/test-preload.mjs`
  preload records each process: an unhandled rejection or uncaught exception
  (even after the file's tests ended, and even in a file whose other failure
  is listed), `process.exit()` from test code, an exit status other than 0 or
  1, or no record at all is a file-level `processFailure`. A `{ todo }` marker
  does not excuse a failure. It skips a compiled test whose
  `test/**/*.test.ts(x)` source is gone, gives every test a timeout
  (`JSAILS_TEST_TIMEOUT_MS`, default 300000) unless `--test-timeout` is passed,
  stops a run that passes `JSAILS_TEST_RUN_TIMEOUT_MS` (default 900000; a file
  whose process outlives its tests would hang it) and names the files still
  running,
  and takes `--suite=default|database`, `--shard=<i>/<n>`, and `--coverage`
  (fail below the workspace's floor in `coverage-floors.json`; a workspace
  without a floor yet is measured and reported, not failed; record floors
  after a coverage run with `npm run coverage:floors`). Other flags go to
  `node --test`. A result belongs to the test file whose process ran it, so a
  suite declared in a shared module or a package's `src/` (a conformance
  suite) is listed under the test file that calls it. Every run writes its
  verdict to `test-results/reconcile/<run>.json` and its per-file timings to
  `test-results/timings/tests/<run>.json`, where `<run>` is the workspace
  plus `.database-<type>`, each declared service, and `.shard-<i>-of-<n>` as
  they apply, so a Valkey or a PostgreSQL run does not overwrite the default
  run's records. The verdict holds each unexpected failure (`file`, `path`,
  `failureType`, `errorName`, `message`), the mismatched, passing, and stale
  entries, and `drafts`, one ledger entry per unexpected failure scoped to the
  run. A draft's message is the failure's first line, literal except that
  absolute paths under the checkout, the temporary and the home directory
  become `.*` and loopback ports `\d+`; review it for other run-specific text
  (a generated name, a duration), then add `reason` and `fixedBy`. The macOS
  and Windows legs upload the directory.
- Expected failures: a harness states correct behaviour as an ordinary test
  and lists today's failing tests in `scripts/expected-failures/<name>.json`,
  whose shape `scripts/expected-failures.mjs` documents (`file`, `test` name
  path, `failure`, `reason`, `fixedBy`, optional `platforms`, `databases`, and
  `services`). An entry with `services` (today only `valkey`) applies only to
  a run that declares them in `JSAILS_TEST_SERVICES`, so an opt-in live test,
  skipped in the default suite, can list how it fails against the service.
  A per-test entry's `failure` is required and states how it fails today (a
  `message` regex, optionally the error `name` and node's failure `type`), so
  a listed test that starts failing differently, or times out, fails the run.
  An entry without `test` covers the whole file, including its process
  failures. A ledger only shrinks: the fix and the entry's removal land
  together. A ratcheting gate keeps its tolerated violations in a
  `kind: "gate"` ledger named after the gate and compares through
  `ratchet()`.
- Database tests: a `*.database.test.ts(x)` file runs in the default suite
  (on SQLite) and again in each CI database leg, where `npm run test:database`
  (`--suite=database`) runs only those files against the server named by
  `DATABASE_TYPE` (`mariadb` or `postgres`) and `DATABASE_*`, with
  `JSAILS_TEST_SUITE=database` set for the test process. The database suite
  fails when no workspace has such a file, so a misnamed one cannot leave the
  legs green.
- `npm run gates` runs every `scripts/gates/<name>.mjs` (each exports `name`,
  `description`, `needsBuild`, and `run`, which returns failure messages), each
  in its own process; `npm run gates -- <name>` runs one and `--list` lists
  them. A new check is a new gate file, not a root script; each gate's
  `description` says what it holds. Structure: `src-structure`
  (`scripts/check-src-structure.mjs`, naming invariants of every `src/` and
  `test/`), `licenses` (every workspace `LICENSE` equals `core/LICENSE`; the
  root copies equal their `core/` originals), `codemap` (`docs/CODEMAP.md`
  matches the tree, every module has a `/** … */` header, every barrel-less
  directory has a summary in `scripts/build-codemap.mjs`), `declared-deps`,
  `ledgers` (every ledger is well formed and lists each test once),
  `coverage-floors` (well formed, names only workspaces), and
  `plugin-manifests` (every first-party manifest is v1 and matches its
  plugin's declaration). API:
  `api-report` (`api/*.api.md` matches the built declarations; regenerate with
  `npm run api-report -- --write`), `api-untagged`, `inclusion-criterion`, and
  `isolated-declarations`. Performance: `bench`, `import-graph`,
  `import-direction`, `footprint`, and `bundle-size`. Docs: `docs`.
  `npm run check:structure` runs `src-structure`, `licenses`, `codemap`, and
  `plugin-manifests`;
  `npm run check:declared-deps` runs `declared-deps`.
- Lint rules that belong to one concern live in `eslint/<name>.mjs` fragments,
  loaded by `eslint.config.mjs` through `scripts/eslint-fragments.mjs`, which
  documents the contract (config objects, custom rules, and syntax bans as
  `jsails/<name>` rules). `eslint/promises.mjs` makes every `src/` promise be
  awaited, returned, ended with a rejection handler, or passed to
  `detach(promise, report)` (`jsails/support`); `void promise` fails lint, and
  so does a handler that drops the error without a comment saying why (an
  empty `.catch(() => {})`, `.catch(() => undefined)` whose promise is
  dropped, `.catch(noop)`, `detach(p, () => {})`). `npm run lint` keeps
  ESLint's cache but clears it when any typed input changes (every workspace's
  TypeScript sources and emitted declarations, the docs site's sources, the
  tsconfigs, the lockfile), because a type-aware verdict depends on everything
  a file imports.
- The declared-deps gate (`scripts/check-declared-deps.mjs`) compares
  each workspace's shipped `dist/src` with its manifest. It fails when a
  `.d.ts` imports a package (or its `@types/` package) that is not in
  `dependencies`/`peerDependencies`/`optionalDependencies`, when a `.js`
  imports a package that is not, and when a declared package is imported by
  no shipped file (an `@types/` package counts as used when a `.d.ts` imports
  the package it types). The starters compile with `skipLibCheck`, so a type
  package that only lives in the root `devDependencies` would otherwise reach
  consumers as `any` without an error; a type-only package that a declaration
  imports (`schema-dts`, `socket.io-adapter`) is therefore a `dependency` of
  `core`. A dependency loaded indirectly (a database driver TypeORM loads by
  name) goes in the script's `INDIRECT_DEPENDENCIES` with its reason. A
  workspace whose shipped code imports `jsails/internal` must declare `jsails`
  at exactly the lockstep version (core's `version`, never a range) in every
  field that declares it.
- `npm run test:scripts` runs the repo-tooling tests, `scripts/test/*.test.mjs`
  (`node:test`, no build needed). A script with logic worth testing exports it
  and runs its `main` only under `import.meta.main`, so a test can import it
  without side effects.
- `npm run bench` (`scripts/bench/index.mjs`, needs a build) measures request
  and assembly scenarios (`scripts/bench/scenarios/`) in one child process
  each, using REQ-01's collectors. `--check` compares exact counters and banded
  promises/allocBytes with `perf/budgets.json` and must finish under 30 s
  (`--max-ms`); `fs` counts the framework's file system calls, not those of
  Node's module loader (module loads are `modules`). Banded budgets are valid
  on the Node line they were recorded on; on another line they fail with
  `--strict-node`, which is the default on CI, so the CI jobs that run the
  bench (`check`, `bench`) set up the exact version `perf/budgets.json`
  records rather than `.nvmrc`'s latest; moving them to a new 26.x is a
  `--write` re-baseline on that version. `--write` records new budgets
  and only lowers existing ones. `--timing` prints advisory throughput and CLI
  start; `--compare <base-checkout>` runs ABAB rounds against another built
  checkout (`--strict` fails on a slowdown). The `bench`, `import-graph`,
  `import-direction`, `footprint` and `bundle-size` gates run through
  `scripts/run-gates.mjs`.
- One workspace: `npm run build -w jsails`, `npm test -w @jsails/admin`.
  `test:watch` exists per workspace and reuses the existing `dist/`; restart it
  after adding a test file. Core also has `build:watch` and `test:coverage`.
- One test file: `npm run build && node --test core/dist/test/path/to/file.test.js`
  (or `packages/<name>/dist/test/...`); that bypasses the ledgers, so a listed
  test shows as a plain failure. `scripts/run-tests.mjs` collects files itself
  and defaults `NODE_ENV=test`.
- The default suite opens no external service. `npm run verify:integrations`
  and `npm run test:database` are the live-service harnesses: both need an
  existing build; the first is gated per stage on database, Valkey, and Docker
  variables. Its jobs stage (`VALKEY_URL`) also runs the `@jsails/jobs` suite
  through `scripts/run-tests.mjs` with `JSAILS_TEST_VALKEY=1` and
  `JSAILS_TEST_SERVICES=valkey`, so the BullMQ conformance file runs and its
  `valkey`-scoped entries in `jobs.json` apply.
- CI (`.github/workflows/ci.yml`) runs `check` on Linux, build and tests on
  macOS and Windows (their own failures go in
  `scripts/expected-failures/macos.json` and `windows.json`, scoped by
  `platforms`; both upload `test-results/reconcile/`), a MariaDB 11.4 and a
  PostgreSQL 17 leg (the MariaDB user is granted the `jsails_m_%` matrix
  databases and stays unprivileged), `bench --check` alone on its own runner,
  the starter, website, and Valkey integration jobs, an advisory
  `perf-compare` job (`--compare` against the base commit, never failing the
  run), and one `gate` job that needs every job but the advisory one; branch
  protection requires `gate` only.
- `npm run verify:starter` packs the framework and the packages the presets
  install, generates each preset, installs it, and runs its checks. Browser
  stages need Chromium (`JSAILS_BROWSER_PATH`, default `/usr/bin/chromium`);
  `--skip-browser` records them as skipped.
- `npm run website` builds `jsails` and `@jsails/content`, then installs and
  builds the docs site. It is the single definition of the site build:
  `netlify.toml` runs it, and Netlify reads the Node line from `.nvmrc`.
- `npm --prefix website run check` builds the docs site, typechecks its
  browser bundle, and compiles every docs, core/AGENTS.md and starter-guide
  sample against the built workspaces (`website/scripts/check-docs.mjs`, gate
  `docs`, report-only against `scripts/expected-failures/docs.json`; re-record
  with `node website/scripts/check-docs.mjs --record` after a build).
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

After any edit to `core/CHANGELOG.md` or `core/README.md`, run
`node scripts/check-licenses.mjs --write` first, or the `licenses` gate fails.

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
  it (except `check` and `bench`, pinned to the version the bench budgets were
  recorded on, which a CI test keeps on this line) and Netlify reads it; every
  `engines` field states the same floor. When
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
- `npm run release` (`scripts/release.mjs`) refuses a dirty working tree
  (modified, staged, or untracked files), runs the full gate, then publishes
  every public workspace in dependency order with `--ignore-scripts` (no
  lifecycle hook runs, so the gate is the only code that runs), skipping
  versions already on the registry so a re-run resumes, and adds
  `--provenance` in GitHub Actions. It packs every tarball first, writes their
  SHA-256 digests into `@jsails/admin-plugin-manager`'s build
  (`dist/src/directory/first-party-digests.json`) before packing that package,
  and publishes the hashed tarball files, so first-party directory installs
  verify the published bytes. That package publishes last (no workspace may
  depend on it), so a failed run never leaves its digests on the registry
  ahead of the tarballs they name; a resumed run hashes what is already
  published from the registry. `--dry-run` does all of that except publish.
  `.github/workflows/release.yml` runs it on `v*` tags. It is the only publish
  path; do not publish or deploy unless explicitly asked.
- Stage explicit paths only — never `git add -A`, `git reset --hard`, or
  `git clean -fd`. Never commit `dist/`, `test-results/`, `.content-cache/`, or
  generated reports.
