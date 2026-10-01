---
title: Testing
order: 19
section: Operating
---

# Testing

JSails ships a **server-only** test subpath, `jsails/testing`, that assembles a
real `Application` in-process and routes requests through the **same Hono
pipeline `serve` uses**. No HTTP server listens, no broadcast transport is
attached, and no Valkey connection is opened automatically. Pages render through
the built-in Preact renderer (or the configured renderer) and API routes go
through the normal default-deny / session / CSRF pipeline, so server HTML and
API behavior are the real output.

Importing `jsails/testing` pulls in the application runtime (Hono, page
rendering, the config loader), so it is never part of the browser-safe root
entry.

## The `createTestApp` surface

`createTestApp(options?)` resolves config like the runtime. Pass a raw `config`
object (validated by `validateAppConfig`) **or** a `configPath` to a compiled
config module (loaded by `loadAppConfig`, default `jsails.app.js`) resolved
against `cwd`. The two are mutually exclusive.

The request origin is the explicit `origin` (a validated `http(s)` origin — no
credentials, path, query, or fragment) when given, else the configured
`server.origin`, else the `TEST_ORIGIN` environment variable, else
`http://localhost` (`DEFAULT_TEST_ORIGIN`).

- `fetch(request)` — route a native `Request` directly; the escape hatch for
  deliberately exercising a non-test origin in-process.
- `request(path, init?)` — build a `Request` **pinned to the resolved origin**
  and route it; rejects a path that resolves off-origin, carries credentials, or
  uses a non-`http(s)` scheme before any handler runs. Returns the `Response` for
  **any** status, so negative HTTP assertions use it.
- `json<T>(path, init?)` — `request` plus a 2xx check and JSON parse; rejects
  with `TestRequestError` on a non-2xx status or invalid JSON. Its message never
  embeds the response body, the underlying cause, or the request URL (which may
  carry secrets).
- `close()` — idempotent teardown. Pass `lifecycle: t` (a `node:test`
  `TestContext`) to register `t.after(...)`, so the app closes automatically when
  each test finishes.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

// No import: `createTestApp` is a projected global in app code.
test('home page is served as HTML', { timeout: 30_000 }, async (t) => {
  const app = await createTestApp({ lifecycle: t });

  const response = await app.request('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);

  // The response body is caller-owned: consume it explicitly.
  const html = await response.text();
  assert.match(html, /<title>JSails Starter<\/title>/);

  const missing = await app.request('/does-not-exist');
  assert.equal(missing.status, 404); // request() returns negative statuses.
});
```

## Direct handler and server-component tests

Two smaller helpers cover the cases where starting the whole application is
unnecessary or impossible:

- `createTestRequestContext(options?)` builds a real `RequestContext` with an
  absolute URL, a real `Request`, route params, a session, and an optional
  public origin. Use it to call a page `load` or an API handler directly.
- `renderToString(vnode)` from `jsails/render-to-string` renders a component
  tree to HTML synchronously (Preact's renderer and escaping), so a test can
  call a page's `load`, render its default export with the props, and assert
  on the markup.
- `createComponentTestHarness({ components, lifecycle })` drives the real
  server-component runtime without Hono, HTTP, or a browser. It returns
  `render(name)` and `update(snapshot, updates, { csrf, action })`, and
  `lifecycle: t` closes it automatically.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createComponentTestHarness, createTestRequestContext } from 'jsails/testing';

test('an API handler returns JSON', async () => {
  const { GET } = await import('../api/health.js');
  const context = createTestRequestContext({ url: 'http://localhost/api/health' });
  const response = GET(context.request, context);
  assert.equal(response.status, 200);
});

test('a server component saves a title', async (t) => {
  const { taskList } = await import('../components/task-list.js');
  const harness = createComponentTestHarness({
    components: { 'task-list': taskList },
    lifecycle: t,
  });
  const rendered = await harness.render('task-list');
  const result = await harness.update(
    rendered.snapshot,
    { title: 'Ship it' },
    { csrf: rendered.csrf, action: { name: 'add' } },
  );
  assert.equal(result.status, 200);
});
```

The registry key passed to the harness is the component's registered name (the
same value as its `name` field), not the imported binding name.

## Job doubles

`jsails/testing` re-exports the two job doubles from `jsails/jobs`, so a test
needs neither Valkey nor a second import:

- `createFakeJobs({ registry? })` returns a `JobsService` that records every
  dispatch instead of enqueuing it, with `assertDispatched(name, predicate?)`,
  `assertDispatchedTimes`, `assertNotDispatched`, `assertNothingDispatched`, and
  `clear()`. The recorded `{ name, payload, options }` entries are on
  `dispatched`, and `dispatchesOf(name)` filters them by job name. With a
  `registry`, each dispatch is validated as the runtime would.
  The `FakeJobs`, `FakeJobsOptions`, and `FakeDispatch` types are exported
  alongside.
- `MemoryJobsAdapter` is an in-process runtime adapter (attempts, backoff,
  delays, interval schedules) for running jobs inline; see [Jobs](/docs/jobs).

```ts
import { test } from 'node:test';

import { createFakeJobs } from 'jsails/testing';

test('sign-up sends a welcome email', async () => {
  const jobs = createFakeJobs();
  await jobs.dispatch('sendWelcomeEmail', { to: 'ada@example.test' });
  jobs.assertDispatched('sendWelcomeEmail');
  jobs.assertNotDispatched('chargeCard');
});
```

## No sandbox

Loading a trusted app config module and running its `setup` / extensions can open
whatever connections the app config selects — a database, Valkey, or any other
service. `close()` tears the app down (services and the extension registry are
fresh per call), but there is **no automatic database rollback**, no global
module reset, and no cookie jar. Point each test at isolated fixtures and seeds
it owns; cookies, sessions, and other state persist only when the test sets them
explicitly.

The test surface also does not exercise Socket.IO or any native broadcast-adapter
transport, because no transport is attached in-process. Core HTTP producer errors
remain sanitized, and the testing helpers add no JSON CLI flags.

## The native test suite

The generated starter's `npm test` is the default, browser-free path. It runs
`tsc -p tsconfig.json` (the server project) and then
`node scripts/run-tests.mjs`, which collects only compiled `*.test.js` files
under `dist/test/` (never a Playwright `*.spec.js`) and forwards extra flags to
`node --test`.

Tests use the built-in `node:test` runner and native `node:assert/strict` — no
third-party framework.

```sh
npm test
npm run test:report   # spec reporter on stdout + JUnit XML at test-results/junit.xml
```

`npm run test:report` runs the same tests with a spec reporter on stdout plus a
JUnit XML report at `test-results/junit.xml`; `--enable-source-maps` maps failure
stacks back to the original TypeScript source locations. `npm run check` remains
the compiler/client/static-build check (`typecheck` then `build`); it does **not**
execute the native app test suite.

The generated `test/app.test.ts` cases are shared by humans and AI agents: plain,
readable `node:test` examples that document server behavior both audiences can
extend. `jsails make:*` writes a companion test beside every code artifact by
default (for example `test/components/todo.test.ts`); pass `--no-test` to skip
it. Content, post, and doc generators write Markdown only.

## Regression, property, and hang helpers

`jsails/testing` also exports small helpers for tests that pin down one defect,
run a property over many inputs, or prove that a call cannot hang.

`auditCase(id, name, options?)` returns the arguments for `test()`: a title of
the form `<id>: <name>` and a bounded `timeout` (`DEFAULT_AUDIT_TIMEOUT_MS`,
20 seconds, unless `options.timeout` is given). The id is `<area>/<finding>` in
kebab case (`AUDIT_ID_PATTERN`), and one id may be used once per test process;
a malformed id, an empty name, or a reused id throws an `AuditTestError` with
code `invalid_id`, `invalid_name`, or `duplicate_id`. It returns arguments
instead of calling `test()` itself so that the test is still declared in your
file, which is where reporters and expected-failure lists attribute it.
`auditTitle(id, name)` builds the title alone.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditCase } from 'jsails/testing';

function cartTotal(prices: readonly number[]): number {
  return prices.reduce((sum, price) => sum + price, 0);
}

test(...auditCase('cart/empty-total', 'an empty cart totals zero'), () => {
  assert.equal(cartTotal([]), 0);
});
```

`settlesWithin(promise, timeoutMs, label)` resolves or rejects as `promise`
does, or rejects with a `SettleTimeoutError` (code `not_settled`, message
`<label> did not settle within <ms>ms`) when it is still pending after
`timeoutMs`. A hang becomes an ordinary, attributable failure instead of a test
timeout.

`blackholeServer({ mode?, resetAfterBytes?, host? })` listens on an ephemeral
loopback port for clients that must cope with an unresponsive peer. In
`silent` mode (the default) it accepts connections and reads but never
answers; in `reset` mode it resets each connection once it has received
`resetAfterBytes` (default 1). It reports `host`, `port`, `connections`, and
`bytesReceived`, builds a URL with `url(scheme)` (for example
`url('redis')`), and `close()` ends open connections.

```ts
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { test } from 'node:test';
import { blackholeServer, settlesWithin, SettleTimeoutError } from 'jsails/testing';

test('a read from a silent peer times out', async (t) => {
  const server = await blackholeServer();
  t.after(() => server.close());

  const socket = connect(server.port, server.host);
  t.after(() => socket.destroy());
  const reply = new Promise<Buffer>((resolve) => socket.once('data', resolve));
  socket.write('PING\r\n');

  await assert.rejects(settlesWithin(reply, 200, 'a reply'), SettleTimeoutError);
});
```

`seededRandom(seed)` is a deterministic generator (mulberry32) for a 32-bit
unsigned seed, with `next()` in `[0, 1)`, `int(min, max)` in `[min, max)`,
`pick(list)`, `shuffle(list)` (returns a new array), and `bytes(length)`.
`testSeeds()` lists the seeds a property runs over: `FIXED_SEEDS` plus one fresh
random seed, or only the seed in `JSAILS_TEST_SEED` (`TEST_SEED_ENV`) when it
is set. `forEachSeed(t, fn, options?)` runs `fn` once per seed in order; on the
first failure it adds a diagnostic naming the seed and the
`JSAILS_TEST_SEED=<seed>` replay, then rethrows the original error. Seeds run
inside the one test rather than as subtests, so the test title stays stable
across runs. Both take `{ fixed?, env?, fresh? }` (`TestSeedsOptions`) to
replace the fixed list, the environment read for the replay seed, and the
fresh-seed source.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Encoding } from 'jsails/support';
import { forEachSeed } from 'jsails/testing';

test('base64 round-trips', async (t) => {
  await forEachSeed(t, (random) => {
    const input = random.bytes(random.int(0, 256));
    assert.deepEqual(Encoding.base64Decode(Encoding.base64(input)), input);
  });
});
```

## Browser tests (optional)

`npm run test:browser` runs `npm run build && playwright test`. It is an optional
developer/AI UI tool, never part of the default `npm test` path:
`@playwright/test` is a starter devDependency, and there is **no automatic
browser download** — set `JSAILS_BROWSER_PATH` to an installed Chrome/Chromium or
run `npx playwright install chromium` yourself.

```sh
JSAILS_BROWSER_PATH=/path/to/chrome npm run test:browser
```

Playwright starts the already-built app on an isolated local server
(`127.0.0.1:4173` by default; override with `JSAILS_TEST_PORT`) and never reuses
an existing service. Screenshots and traces require a browser. Failure
screenshots are attached to the test; traces are opt-in only with
`JSAILS_TRACE=1`. The JSON report lands in `test-results/results.json` and the
HTML report in `playwright-report/`. Both directories are git-ignored because
reports, screenshots, and traces can embed private UI, console, and network data.

The generated browser specs cover the counter island, the native `<dialog>`,
Home/About soft navigation, adding a task through the `task-list` server action,
rejecting a blank task (422), a mid-edit in-flight navigation, and the native
opt-out / modified-click cases.

## End-to-end verification

Two opt-in harnesses exercise the framework beyond unit tests. Neither is
triggered by a CLI command, and neither is part of `check`/`test`.

```sh
npm run verify:starter              # pack + create --install + check + native tests + browser QA
npm run verify:starter -- --skip-browser
npm run verify:integrations         # env-gated live-service harness
```

`npm run verify:starter` builds the framework, `npm pack`s it, invokes the real
`jsails create --install` with a `file:` tarball dependency into a temp fixture,
imports the _packaged_ `createStarterFiles`, runs the fixture's `check`,
validates the exported `out/`, then runs the fixture's `test:report` native suite
(a **pass** plus an `expected-failure` negative proof) and, in the default full
run, drives browser QA against `jsails serve`, a pure static serve of `out/`, and
a live `jsails dev` run. `--skip-browser` runs that same
pack/install/check/native-test pipeline but records each of the five browser
stages as an explicit `skipped` — never run, never probed — and launches **0**
browsers.

`npm run verify:integrations` is **opt-in** and env-gated: it exercises the six
external-service stages (database, jobs, broadcast, Docker, S3, and the live
change log) against real services
the operator points at via `JSAILS_TEST_*` variables. Every stage skips cleanly
when its variables are absent (the run exits 0), and a stage that is enabled but
then fails exits non-zero. It requires an already-built `dist/`.

## Next steps

- [Jobs](/docs/jobs) — the provider-neutral job runtime.
- [Deployment](/docs/deploy) — ship the app you just tested.
