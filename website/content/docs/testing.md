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
through the normal access chain (session, cross-site check, access), so server HTML and
API behavior are the real output.

Importing `jsails/testing` pulls in the application runtime (Hono, page
rendering, the config loader), so it is never part of the browser-safe root
entry.

## The `createTestApp` surface

`createTestApp(options?)` resolves config like the runtime. Pass a raw `config`
object (validated by `validateAppConfig`, and locked unless it states
`plugins.activation`) **or** a `configPath` to a config module (loaded by
`loadApp`, default `jsails.app.js`) resolved against `cwd`. The two are
mutually exclusive. A config module reads the variables `env` passes
(`createTestApp({ configPath, env: { DATABASE_URL: '...' } })`); without
`env` it reads the environment resolved for `cwd` the way the `jsails` bin
resolves it, so a variable the test process has, or a `.env` file, reaches
it. A raw `config` reads no environment, so `env` beside it is refused.

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
  `render(name)` and `update(snapshot, updates, { action })`, and
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
    { action: { name: 'add' } },
  );
  assert.equal(result.status, 200);
});
```

The key passed to the harness is the component's id (its path under
`components/`, which its `name` field must equal), not the imported binding
name. An update goes through the runtime's update route, lane boundary
included; `result.reported` lists the failures it reported (a throwing action
or policy).

## Testing a plugin

`testPlugin(instance, options?)` runs one configured plugin's setup the way
the host does, with stand-ins for the services it requires, and fails when
setup is not inert. During the substrate declaration and setup (including the
evaluation of a `lazy(() => import(...))` setup module) it traps opening a
socket, listening, `fetch`, DNS lookups, file writes, subprocesses, recurring
timers, and opening a substrate resource. A trapped call throws and the run
fails with `plugin_harness.inert_violation`, naming the operation and its kind
(`network`, `fs_write`, `subprocess`, `timer`, `substrate`) but never its
arguments; a setup that catches the throw still fails. Calls made outside a
watched setup, by the test itself or by other tests in the process, are left
alone, and the traps come off when the last open run closes.

Setup must also leave nothing behind, and the verdict never depends on how
soon a test closes the run. A one-shot timer or immediate (`setTimeout`,
`setImmediate`) that setup scheduled and that is still pending when setup
resolves is cancelled, so it never acts, and fails the run as a `timer`
violation; a trap tripped inside such a callback while setup was still
running fails the run too, rather than surfacing as an uncaught exception.
The harness then lets one macrotask turn pass, so promise chains setup did not
await run under the traps before `testPlugin` returns. Work that waits on I/O
setup did not await is still trapped while the run is open, and what it tried
fails `run.close()`.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { definePlugin, envVar } from 'jsails/kernel';
import { createServiceToken } from 'jsails/kernel';
import { testPlugin } from 'jsails/testing';

const clockToken = createServiceToken<() => number>('clock');
const greetingToken = createServiceToken<string>('greeting');

const greetingPlugin = definePlugin({
  name: 'greeting',
  env: { GREETING_NAME: envVar.string().default('world') },
  requires: [clockToken],
  provides: [greetingToken],
  setup({ env, services }) {
    services.provide(greetingToken, `hello ${env.GREETING_NAME} at ${services.get(clockToken)()}`);
  },
});

test('greeting provides its service without side effects', async () => {
  const run = await testPlugin(greetingPlugin(), {
    services: [[clockToken, () => 0]],
    env: { GREETING_NAME: 'docs' },
  });
  try {
    assert.equal(run.services.get(greetingToken), 'hello docs at 0');
    assert.deepEqual(run.provided, [greetingToken]);
  } finally {
    await run.close();
  }
});
```

`options.env` is the only environment the plugin sees (the process
environment is never read), and its `NODE_ENV` gives setup its `mode`
(`production` without one); `options.roles` are the process roles (none by
default), and `options.rootDir` the app root. The run exposes the registry
(`services`), the tokens setup provided (`provided`), the substrate tokens it
declared (`substrate`, still closed, so a test can open one after setup), the
lifecycle units it registered (`units`), and the routes, transforms and guards
it registered through `routes` (`http`), none of them served. Failures the host would raise
(`plugin.missing_service`, `config.invalid_env`, a throwing setup) surface the
same way, after the plugin's cleanups ran.

### Checking a plugin for leaks

`measurePluginLeaks(entries, { rootDir, roles?, env?, cycles?, warmup?, tolerance? })`
opens a fresh set of plugin instances through the kernel stages, starts their
lifecycle units for `roles` (default `web` and `worker`), shuts them down, and
repeats: `warmup` cycles (default 5), then `cycles` measured ones (default 50).
It compares the process's active resources by kind (timers, sockets, servers,
file handles) and its listeners per event before and after the measured
cycles, and reports each kind that grew; growth above `tolerance` (default 2)
sets `leaked`. `measureLeaks(cycle, options)` does the same for any cycle, such
as an application served and closed.

```ts
import assert from 'node:assert/strict';
import { definePlugin } from 'jsails/kernel';
import { measurePluginLeaks } from 'jsails/testing';

const tickerPlugin = definePlugin({
  name: 'ticker',
  setup({ lifecycle }) {
    let timer: NodeJS.Timeout | undefined;
    lifecycle.register(['worker'], {
      name: 'ticker',
      start: () => {
        timer = setInterval(() => undefined, 1000);
      },
      drain: () => clearInterval(timer),
      abort: () => clearInterval(timer),
    });
  },
});

const report = await measurePluginLeaks(() => [tickerPlugin()], {
  rootDir: import.meta.dirname,
});
assert.equal(report.leaked, false, JSON.stringify(report.growth));
```

Every first-party plugin is held to it by the `plugin-leaks` gate.

## Testing a command

`runCommand(command, { args?, env, cwd?, prompter?, stages? })` from
`jsails/testing` runs a `defineCommand` value in-process, as the CLI would,
and resolves with `{ code, stdout, stderr }`. The arguments are parsed against
the command's own options, so an undeclared flag is exit code 2 with the
`jsails:` usage line on `stderr`. The test states the environment (`env`):
nothing is read from `.env` files or credentials. Without a `prompter` every
question fails, as under `--no-interaction`. A command that needs more than
the environment gets the stages the test opens itself, as `stages`. A throw
from the command rejects the returned promise, and so does a result that is
no integer from 0 to 255 (`cli.invalid_exit_code`), which `jsails` would
refuse with exit code 1.

```ts
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { defineCommand } from 'jsails';
import { runCommand } from 'jsails/testing';

// The command under test, usually imported from commands/hello.ts.
const hello = defineCommand({
  summary: 'Greet someone',
  positionals: [{ name: 'name', summary: 'Who to greet', required: true }],
  run(context) {
    context.stdout(`Hello, ${context.positionals[0] ?? 'world'}!`);
  },
});

it('greets by name', async () => {
  const result = await runCommand(hello, {
    args: ['Ada'],
    env: { JSAILS_ENV: 'test', NODE_ENV: 'test' },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ['Hello, Ada!']);
});
```

`jsails make:command <name>` writes a command and a test in this shape.

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

## The access matrix

`accessMatrix(app, options?)` asks every surface of an app (each route, mount,
component endpoint and the public files) as every canonical actor, through the
real request pipeline, and reports where the app breaks a hard access rule. The
app is the one `createTestApp` returns (or an `Application`).

Each request carries its actor's real credentials (the `jsails_access_matrix`
cookie, an `Authorization: Bearer` header, both, or none) and, for a write, a
small body of the kind the surface declares. A probe stands in for the route's
code: the access chain runs, and where the route's middleware and handler would
start, the probe answers instead, so no route code runs and nothing is written.
Every write is sent same-origin, from a foreign origin, and naming no origin.

The canonical actors are anonymous, a user without a role, an unverified user,
a user without a second factor, a user whose authorization is stale, a token
with no scope, with exactly the surface's scope, and for another tenant, a
cookie sent with a bearer token, and a rejected cookie and token. Add the app's
own actors as `personas` (`{ id, carrier: 'cookie' | 'token', data }`, where
`data` is the session data the app's checks read).

The app must resolve sessions through `accessMatrixSession`: it answers each
matrix request with its actor's session and counts the call, and answers any
other request with no session. Give it to the app's `resolveSession` and to every
plugin seam that resolves a session itself (the `auth` plugin's
`sessionResolver`, an admin panel's `resolveSession`).

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accessMatrix, accessMatrixSession, createTestApp } from 'jsails/testing';

test('every surface holds the access rules', async (t) => {
  const app = await createTestApp({
    config: { rootDir: '.', resolveSession: accessMatrixSession },
    lifecycle: t,
  });
  const { rows, violations } = await accessMatrix(app, {
    personas: [{ id: 'admin', carrier: 'cookie', data: { role: 'admin' } }],
  });
  assert.ok(rows.length > 0);
  assert.deepEqual(violations, []);
});
```

Each row records the surface, method, actor and origin variant, whether the
request was `admitted`, `denied` by the access chain, or `answered` by another
stage, which surface's chain decided it (`decidedBy`), its status and failure
code, whether the caller was identified, whether
the route's code would have run, the body bytes read, whether the session
resolver ran, and the `Cache-Control` and `Set-Cookie` of the answer. Rows come
in a fixed order and hold no ids or times, so two runs over the same app are
byte for byte the same.

`violations` lists every breach of `ACCESS_INVARIANTS`:

| Invariant | Rule |
| --- | --- |
| `own-chain-decides` | Every request to a surface is decided by that surface's own access chain. A request an earlier route decided says nothing about its surface and is judged by no other rule; a stage before the chain may answer only a public surface that reads no credential, or a host the app does not serve. |
| `denied-before-handler` | A denied request reaches no route code and has no body byte read. |
| `public-only-admits-anonymous` | Only a `publicAccess` surface admits a request with no identity. |
| `cross-site-refused` | A write to a cookie-accepting surface from a foreign origin, or naming none, is refused `403 access.cross_site`, unless a header token the surface accepts authenticated it. A refused credential the surface reads may be answered `401` instead, as `rejected-credential-401` demands. |
| `connection-origin-and-host` | A connection surface admits no handshake from a foreign origin or for a host the app does not serve. |
| `denied-no-store` | A denial is `no-store` and sets no cookie. |
| `identified-never-public` | An answer to an identified caller is never `public` for a shared cache. |
| `rejected-credential-401` | A credential the authenticator refuses is answered 401, never as anonymous. |
| `tokenless-management` | No admin, component-action or auth-management surface accepts a token. |
| `credential-free-never-authenticates` | A surface accepting no credential never calls the session resolver. |
| `anonymous-write-rate-limited` | Every write an anonymous caller reaches has a rate-limit rule. |
| `locked-no-code-activation` | An app whose plugins are locked has no surface that activates plugin code (`codeActivating` names them, and each id must name a registered surface or the matrix throws `access_matrix.unknown_surface`). |

Two of them cannot hold in an app today: a session resolver answers a rejected
credential with no session, so `rejected-credential-401` fails wherever a
surface admits anonymous callers, and a surface states no rate-limit rule yet,
so `anonymous-write-rate-limited` fails for every public write. Filter those two
out of an assertion until the actor model and the rate limiter land.

A surface kind needs a probe builder; every kind an app serves today has one,
and `probes` adds one for a kind that does not (a realtime connection's
handshake). A builder returns a request, or candidate requests in order: while
another surface's chain decides the one sent (an earlier `/docs/:slug` route
answers the `/docs/x` of `/docs/*`), the matrix sends the next, and the
built-in builders try a wildcard at one and at two segments. A surface no
candidate reaches breaks `own-chain-decides`. The framework's own apps run the
matrix in the `access` gate (`npm run check:access`), with the invariants that
do not hold yet listed in `scripts/expected-failures/access.json` with the
package that fixes each.

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

`respServer({ resetOn?, resetFirst?, silentOn? })` is the peer that does
answer: a minimal Redis-protocol server on an ephemeral loopback port that
stands in for Valkey where a client must connect but no data matters. It
answers the handshake a client sends on connect, `PING` and `SUBSCRIBE`, and
acknowledges every other command with `+OK`, so `valkeyPlugin({ url })` starts
against it. `resetOn` resets the connection whenever one of the named commands
arrives, `resetFirst` only the first time, and `silentOn` never answers them,
which puts the failure mid-command on a connection already in use. It reports
the `url` (`redis://127.0.0.1:<port>`) and the command names `received`, in
order; `close()` ends open connections.

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
external-service stages (database, jobs, broadcast, Jamal against real Docker
containers, S3, and the live change log) against real services
the operator points at via `JSAILS_TEST_*` variables. Every stage skips cleanly
when its variables are absent (the run exits 0), and a stage that is enabled but
then fails exits non-zero. It requires an already-built `dist/`.

## Next steps

- [Jobs](/docs/jobs) — the provider-neutral job runtime.
- [Deployment](/docs/deploy) — ship the app you just tested.
