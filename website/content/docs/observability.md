---
title: Observability
order: 27
section: Reference
---

# Observability

Observability covers logging, signals, diagnostics, and the pluggable request,
query, and exception watchers.

JSails ships three value-free observability surfaces (none of them ever echoes
input, secrets, or raw values) — a **record-first logging service**
(`@jsails/logging`), a **signal bus** (`@jsails/signals`), and a
**Telescope-style diagnostics recorder** (`@jsails/diagnostics`) with pluggable
watchers. Each is inert at construction: nothing connects and nothing is
recorded or emitted until a method is called.

## Logging

`@jsails/logging` is a record-first structured logging service. The record is the
API and the string is a rendering: `logger.info(msg, context?)` builds a frozen
`LogRecord { level, message, context, at }`, and each channel receives the
record.

```ts
import { RecordLogger, consoleChannel, jsonFormatter } from '@jsails/logging';

const logger = new RecordLogger({
  channels: [consoleChannel({ formatter: jsonFormatter() })],
});

logger.info('user signed in', { userId: 42 });
logger.error('payment failed', { orderId: 'ord_123' });
```

- **Levels** — `debug` | `info` | `warn` | `error`, ordered. Each channel
  carries its own `minLevel` threshold and receives only records at or above it.
- **Channels** are the pluggable seam (`{ name, minLevel, write(record) }`).
  Built-ins: `consoleChannel()` (default; `warn`/`error` → stderr, `debug`/`info`
  → stdout), `memoryChannel()` (tests; exposes raw `records()` and `clear()`),
  and `nullChannel()` (discard).
- **Formatters** are pluggable (`{ format(record) }`). Built-ins:
  `jsonFormatter()` (stable key order `level`/`message`/`context`/`at`) and
  `lineFormatter()` (`<ISO> <LEVEL> <message> <json context>`). Both never
  throw: a circular or `toJSON`-throwing value becomes `"[unserializable]"`, and
  functions/symbols/`undefined` are dropped. An `Error` in the context renders
  as `{ name, message, code }` (no stack, no cause), so
  `logger.error('payment failed', { error })` keeps what an operator needs.
  `lineFormatter` escapes control characters in the message (`\n`, `\r`,
  ANSI escapes as `\u001b`), so a message built from request data can neither
  forge a second log line nor drive the operator's terminal.
- **Redaction** — before any channel or observer sees a record, context values
  under secret-looking keys are replaced with `"[redacted]"`, at any depth of
  plain objects, arrays, and class instances (an ORM entity or DTO is copied
  as its own enumerable properties, which is what JSON output would show;
  objects with `toJSON`, `Error`, `Map`, `Set`, and typed arrays are kept as
  they are). A key matches when its lower-cased form, with `-`
  and `_` removed, ends with one of the `redact` names (default `password`,
  `passwd`, `secret`, `token`, `authorization`, `cookie`, `apikey`,
  `privatekey`, `credentials`), so `accessToken` and `set-cookie` are covered.
  Pass `redact: ['ssn', ...]` to choose the list, or `redact: []` to turn it off.
- **Cheap below threshold** — a call below every channel's `minLevel` (and the
  diagnostics level) returns before a record is built.
- **`child(context)`** returns a logger whose bound context is merged into every
  record (child overrides parent; nested children merge in order). The bound
  context is copied, never mutated.

The logger itself never throws: a throwing channel or sink never propagates to
the caller. Malformed logger or channel options throw a `TypeError` at
construction time.

### Plugin

`loggingPlugin(options?)` provides a `Logger` under the typed `loggingToken`
service. An optional `diagnostics` recorder receives a value-free
`{ type: 'log', data: { level, message } }` entry for every call at or above
`diagnosticsLevel` (default `'warn'`, so chatty `debug`/`info` logs cannot
evict request and exception entries from the ring; the record's `context` is
deliberately excluded), and an optional `signals` bus emits the
shared `logError` event for `error`-level records. Both sinks are
failure-isolated.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
export default {
  plugins: {
    use: ['@jsails/logging'],
  },
};
```

## Signals

`@jsails/signals` is a service-layer **signal bus** over the shared
interceptor/observer registry. `new RegistrySignalBus(registry)` (from
`jsails/signals`) wraps an `InterceptorRegistry` as a `SignalBus`
(`observe`/`emit`); `signalsPlugin()` exposes that bus under the typed
`signalsToken` service.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
export default {
  plugins: {
    use: ['@jsails/signals'],
  },
};
```

The bus adds no buffering, durability, or removal API — it delegates to the
registry, whose seal guard applies: registration closes after `setup`, while
`emit` stays callable. `emit` isolates observer errors — it never throws and
resolves to a `readonly unknown[]` of the errors thrown by observers. Because
the bus is the **shared** registry, an observer registered by one plugin fires
for events emitted by another.

`requestStarted` / `requestFinished` / `requestFailed` are built-in lifecycle
events emitted by both the API pipeline and the page pipeline when the signals
plugin is enabled. Their `RequestSignalPayload` is value-free: it carries the
`Request`, `URL`, params, method, route, and `session` (server-only), but never
the body, headers, or cookies. Emission is fire-and-forget and opt-in — without
the plugin the pipeline emits nothing and behaves identically. `SignalError`
(code `unavailable`) is raised when the shared registry is absent.

Page routes emit the same three events, so one observer sees every failure
regardless of route kind. A page whose `load`, component, or layout throws emits
`requestFailed` with the original error before the response is reduced to the
value-free 500 envelope — the error reaches observers, never the client. The
server-component update, upload, and download routes emit `requestFailed` the
same way when the runtime throws.

## Diagnostics recorder

`@jsails/diagnostics` is an in-memory recorder of typed, value-free
`DiagnosticsEntry` instances. `InMemoryDiagnosticsRecorder({ maxEntries?, clock? })`
builds a bounded ring buffer (default 1000 entries); `diagnosticsPlugin({
recorder?, enabled? })` exposes a `Diagnostics` service under `diagnosticsToken`.
`enabled: false` yields a no-op service.

```ts
import { InMemoryDiagnosticsRecorder } from '@jsails/diagnostics';

const recorder = new InMemoryDiagnosticsRecorder({ maxEntries: 1000 });

recorder.record('request', { route: 'GET /posts', status: 200 });
const entries = recorder.entries();
const stats = recorder.stats();
```

- `wrapAsync(type, fn)` wraps an async call and records its duration — the
  caller sees the error, the recorder observes it.
- `prune(options, now?)` evicts entries older than a cutoff, except the newest
  `keepExceptions` exception entries.
- `pause()` / `resume()` / `isPaused()` gate recording without flushing the
  buffer.

Each `DiagnosticsEntry` carries a monotonic `id` (a decimal string) and, when a
`family` discriminator is present, a `familyHash` (a 12-hex-char SHA-1 hash of
`type` + `data.family`). Neither is ever caller-supplied. No secrets,
credentials, or raw request bodies are recorded.

`DiagnosticsRecorderOptions.tags` lists the callbacks that attach `"name:value"`
tags to entries at record time; `DiagnosticsRecorderOptions.monitored` names tag keys counted in
`DiagnosticsStats.monitoredCounts`. `DiagnosticsRecorderOptions.filters` gates
entries at record time via `applyFilters` — a throwing filter is fail-closed
(drop).

## Watchers

`createWatcherRegistry()` builds a setup-scoped registry for pluggable
diagnostic watchers. Each `Watcher` owns its own subscription and returns an
unsubscribe from `register`; the registry is sealed after `start()`.

### Request watcher

`RequestWatcher({ signals, slowMs? })` observes the `requestFinished` and
`requestFailed` signals, recording value-free `'request'` / `'failed:request'`
entries with only `method`, `route`, `status`, `durationMs`, and a computed
`slow` flag. `route` is the matched pattern (`/invite/:code`), never the
concrete path: when the signal carries the raw pathname, every segment equal
to a route parameter's value is replaced by `:name` (a catch-all by `:name*`),
so a token or id in the path is never stored or exported. The exception
watcher records the same pattern in its context. Headers, body, URL, and
session details never appear.

### Query watcher

`QueryWatcher({ onQuery, slowMs? })` records every database query through
an injected subscriber. Only the parameterized SQL, a `bindingCount`, and a
computed `slow` flag are stored; bindings never appear in any entry. No TypeORM
import or connection is required.

### Exception watcher

`ExceptionWatcher({ capture, signals?, maxFamilies? })` captures unhandled
errors and records value-free `'exception'` entries keyed by a stable `family`
discriminator. Each entry carries `class`, `file`, `line`, `frames` (a frame
count only — the raw stack is never stored), and an optional `context`. A
bounded map keyed by family exposes occurrence counts via `counts()`.

```ts
import { ExceptionWatcher } from '@jsails/diagnostics';

const watcher = new ExceptionWatcher({
  capture: (subscribe) => subscribe((error) => ({ class: error.constructor.name })),
});
const unsubscribe = registry.register(watcher);
```

## Request errors

Every unexpected request failure — a throw from an API handler, a page render,
a session resolver, an `authorize` callback, the server-components runtime, or
an `errorPage` renderer — is reported, while the response stays the value-free
500 (or the deny it already was). By default the report is one stderr line,
`[jsails] <phase> failed: <METHOD> <route pattern> request_id=<id>`, followed
by the stack. `createApp({ onError })` replaces that sink with
`(error, { phase, method, route, requestId }) => void | Promise<void>`. The
route is the matched pattern (`/api/posts/:id`), never the raw URL, because a
path or query can carry a token. Expected answers — an `HttpError` below 500 and
a `ValidationError` — are not reported. A hook that throws is noted on stderr
without its error text and never changes the response.

The hook's types come from `jsails/http`, so a hook defined apart from the
`createApp` call can be named:

```ts
import type { RequestErrorHook } from 'jsails/http';

export const onError: RequestErrorHook = (error, { phase, route, requestId }) => {
  myLogger.error({ phase, route, requestId, error });
};
```

The same subpath exports `ErrorPageRenderer` and `PublicError` for the
`errorPage` option, and `ReadinessOptions` and `ReadinessProbe` for the
`readiness` option.

## Request id

Every response carries `X-Request-Id`: the inbound header when it is well
formed, otherwise a generated id. The same id is ambient for the whole request:
`currentRequestId()` returns it from
any code on the request's async path — a logger, a job dispatch, a watcher —
and `undefined` outside a request. Error reports carry it as `requestId`, so a
user-quoted id leads to the matching log line.

```ts
import { currentRequestId } from 'jsails/http';

function log(message: string): void {
  console.log(JSON.stringify({ message, requestId: currentRequestId() }));
}
```

## Next steps

- [Services & Utilities](/docs/services) — the cluster of small focused services.
- [Introspection](/docs/introspection) — `inspect`, `describe`, `explain`, and the
  opt-in runtime endpoint.
