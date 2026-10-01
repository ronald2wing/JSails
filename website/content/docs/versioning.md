---
title: Versioning and Stability
order: 48
section: Reference
---

# Versioning and Stability

JSails has not reached 1.0. Until it does, a release may change any API. This
page states what 1.0 will commit to, and where each entry point stands today.

## What semantic versioning covers

From 1.0, a breaking change to any of the following needs a new major version:

- exports tagged `@public` in the published packages;
- the application config schema;
- CLI commands and their flags;
- error codes;
- the `application/problem+json` error envelope;
- wire and persisted formats: signed component snapshots, the job envelope, the
  stored plugin state, and broadcast messages.

By 1.0, each of these is held by a repository check that fails when it changes
without the matching version change. Today only the API report (below) is
enforced; the checks for the other items land before 1.0.

## Stability tiers

At 1.0, every export carries one TSDoc tier tag. Today most exports have no
tag yet; the API report lists each one that is missing.

- `@public`: covered by semantic versioning.
- `@experimental`: may change in a minor release. Experimental exports are
  imported only from an `/experimental` subpath, so the import path shows the
  tier. Before 1.0, a package that has any will also declare it in a
  `jsails.stability` field of its manifest.
- `@internal`: not covered. It may change or disappear in any release; do not
  import it from an app.

## Release policy

- **Lockstep versions.** Every first-party package (`jsails` and `@jsails/*`)
  shares one version number and is released together. Use the same version for
  all of them.
- **Node.js.** The supported floor is Node.js 26. It moves only in a major
  release.
- **Platforms.** Linux and macOS are supported. Windows is supported for
  development: `jsails create`, `dev`, `build`, `test`, and the local services
  (`jamal up`, `down`, `logs`, `ps`, `exec`) run there, and CI tests every
  change on Windows. Production is not: on Windows `jsails serve` runs only
  with `NODE_ENV` set to `development` or `test` (an unset `NODE_ENV` is
  production and refuses), and the `jamal` verbs that plan or reach a server
  (`deploy`, `rollback`, `status`, `lock`, `prune`, `secrets`, ...) refuse,
  each with an `unsupported_platform` error. Serve and deploy from Linux or
  macOS, for example in a container.

## The API report

Every published entry point has a generated report under `api/` in the
repository: one line per export with its kind, tier, whether it has a TSDoc
summary, and its declaration as the published `.d.ts` states it. A declaration
that a signature names but that no entry exports, such as an options type in an
internal file, is written out on the same line, so a change to it changes the
report too. Types that come from third-party packages are covered by the
dependency's version range instead. The report is checked against every build,
so a change to the public API is visible in review as a change to the report,
and the number of value exports of an entry cannot grow without an explicit
decision.

## The 1.0 inclusion criterion

An entry point ships as stable in 1.0 only if:

- a starter uses it, or a guide page has a code sample that imports it;
- it has a test in the default suite or the integrations harness;
- it has an owner-approved line in the table below, stating what 1.0 commits
  to for it. The line is written by hand; listing an entry in the table does
  not by itself approve it.

A package also needs a guide sample, an integration test, and coverage in the
starter verification run. An entry point or package that does not meet the
criterion is removed or not published. Today the check reads which packages the
code samples import; compiling every sample is planned before 1.0.

## Stability by entry point

<!-- stability-table:start (generated from api/criteria.json by scripts/api-report-criteria.mjs --write) -->

| Entry | At 1.0 | Notes |
| --- | --- | --- |
| `jsails` | Stable | |
| `jsails/plugin-sdk` | Moves | Split into `jsails/plugin-sdk/http`, `/validation` and `/build`. |
| `jsails/security` | Stable | |
| `jsails/semver` | Stable | |
| `jsails/api` | Stable | |
| `jsails/app` | Stable | |
| `jsails/broadcast` | Moves | Moves to `@jsails/broadcast`. |
| `jsails/broadcast/client` | Moves | Moves to `@jsails/broadcast/client`. |
| `jsails/build` | Moves | Moves to `@jsails/dev`, a development dependency. |
| `jsails/cache` | Stable | |
| `jsails/client` | Stable | |
| `jsails/client/model` | Stable | |
| `jsails/data` | Moves | Moves to `@jsails/database`. |
| `jsails/database` | Moves | Moves to `@jsails/database`. |
| `jsails/dev` | Moves | Moves to `@jsails/dev`, a development dependency. |
| `jsails/diagnostics` | Moves | Moves to `@jsails/diagnostics`. |
| `jsails/encryption` | Stable | |
| `jsails/extensions` | Stable | |
| `jsails/facades` | Removed | Removed; use the request context instead. |
| `jsails/filesystem` | Stable | |
| `jsails/http` | Stable | |
| `jsails/i18n` | Stable | |
| `jsails/i18n/loader` | Stable | |
| `jsails/i18n/server` | Stable | |
| `jsails/introspect` | Moves | Moves to `@jsails/dev`, a development dependency. |
| `jsails/jobs` | Moves | Moves to `@jsails/jobs`. |
| `jsails/jsx-runtime` | Removed | Removed; the JSX runtime is configured by the build. |
| `jsails/live` | Moves | Moves to `@jsails/live`. |
| `jsails/mcp` | Moves | Moves to `@jsails/mcp`. |
| `jsails/models` | Moves | Moves to `@jsails/database`. |
| `jsails/pages` | Stable | |
| `jsails/plugins` | Stable | |
| `jsails/render-to-string` | Stable | |
| `jsails/routing` | Stable | |
| `jsails/seo` | Moves | Moves to `@jsails/seo`. |
| `jsails/server-components` | Stable | |
| `jsails/services` | Stable | |
| `jsails/signals` | Removed | Removed; observe events through telemetry instead. |
| `jsails/support` | Moves | Split into one subpath per namespace (`jsails/support/strings`, `/collections`, ...). |
| `jsails/support/server` | Stable | |
| `jsails/symbols` | Removed | Removed; bare names are injected at compile time. |
| `jsails/symbols/client` | Removed | Removed; bare names are injected at compile time. |
| `jsails/testing` | Stable | |
| `jsails/validation` | Stable | |
| `jsails/zod` | Stable | |
| `jsails/rich-text` | Stable | |
| `@jsails/admin` | Stable | |
| `@jsails/admin-plugin-manager` | Stable | |
| `@jsails/ai` | Stable | |
| `@jsails/ai/client` | Stable | |
| `@jsails/ai/anthropic` | Stable | |
| `@jsails/ai/openai-compatible` | Stable | |
| `@jsails/ai/testing` | Stable | |
| `@jsails/ai/mcp` | Stable | |
| `@jsails/auth` | Stable | |
| `@jsails/blog` | Stable | |
| `@jsails/blog/admin` | Stable | |
| `@jsails/cache` | Stable | |
| `@jsails/config` | Stable | |
| `@jsails/config/admin` | Stable | |
| `@jsails/content` | Stable | |
| `@jsails/diagnostics` | Stable | |
| `@jsails/editor` | Stable | |
| `@jsails/editor/preact` | Stable | |
| `@jsails/editor/server` | Stable | |
| `@jsails/filesystem` | Stable | |
| `@jsails/flags` | Stable | |
| `@jsails/flags/admin` | Stable | |
| `@jsails/inertia` | Stable | |
| `@jsails/inertia/testing` | Stable | |
| `@jsails/jamal` | Stable | |
| `@jsails/live` | Stable | |
| `@jsails/live/client` | Stable | |
| `@jsails/logging` | Stable | |
| `@jsails/mail` | Stable | |
| `@jsails/mcp` | Stable | |
| `@jsails/media` | Stable | |
| `@jsails/media/admin` | Stable | |
| `@jsails/notifications` | Stable | |
| `@jsails/resources` | Removed | Removed; resources are declared through the API module. |
| `@jsails/sessions` | Removed | Removed; sessions are part of authentication. |
| `@jsails/tenancy` | Stable | |
| `@jsails/theme` | Stable | |
| `@jsails/webhook` | Stable | |

<!-- stability-table:end -->
