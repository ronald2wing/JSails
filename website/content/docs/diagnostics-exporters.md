---
title: Diagnostics Exporters
order: 28
section: Reference
---

# Diagnostics Exporters

The `@jsails/diagnostics` package covers the in-memory diagnostics recorder
(documented in [Observability](/docs/observability)) plus an **export-only
exporter seam** for draining entries to an external destination.

Three primitives ship — a `DiagnosticsExporter` contract, two built-in exporters
(`consoleExporter` and `createHttpExporter`), and a one-shot drain helper
(`exportOnce`). Every exporter is value-free on failure (never echoes input,
secrets, or raw values): a delivery failure never throws back into the caller.

## The exporter contract

`DiagnosticsExporter` is a narrow interface — a single `send` method that
receives a batch of read-only `DiagnosticsEntry` objects and resolves when the
batch has been delivered (or swallowed on failure):

```ts
import type { DiagnosticsExporter, DiagnosticsEntry } from '@jsails/diagnostics';

// A custom exporter implements this contract:
const myExporter: DiagnosticsExporter = {
  async send(entries: readonly DiagnosticsEntry[]): Promise<void> {
    // Deliver entries to the destination; swallow failures.
  },
};
```

Implementations must never throw back into the caller — a delivery failure is an
implementation concern that stays internal (logged, reported via a callback, or
silently swallowed).

## `consoleExporter`

`consoleExporter(options?)` writes one JSON line per entry to `process.stdout`
(newline-delimited JSON / NDJSON). The writer is resolved inside `send()`, so
importing the package never touches `process.stdout`.

```ts
import { InMemoryDiagnosticsRecorder, consoleExporter, exportOnce } from '@jsails/diagnostics';

const recorder = new InMemoryDiagnosticsRecorder({ maxEntries: 1000 });
// ... entries are recorded by watchers or app code ...

// Drain to stdout as NDJSON:
await exportOnce(recorder, consoleExporter());
```

`ConsoleExporterOptions.write` overrides the line writer (useful in tests to
capture output):

```ts
const lines: string[] = [];
const exporter = consoleExporter({ write: (line) => lines.push(line) });
```

## `createHttpExporter`

`createHttpExporter(options)` returns an exporter that POSTs a JSON batch
`{ entries: [...] }` to an HTTP collector endpoint using an injectable `fetch`.
The exporter is value-free on failure: network errors, timeouts, and non-2xx
responses are all swallowed after an optional `onError` callback fires.

```ts
import { InMemoryDiagnosticsRecorder, createHttpExporter, exportOnce } from '@jsails/diagnostics';

const recorder = new InMemoryDiagnosticsRecorder({ maxEntries: 1000 });

const exporter = createHttpExporter({
  // Required: an absolute http(s) URL.
  endpoint: 'https://collector.example.com/v1/diagnostics',

  // Optional: injectable fetch (defaults to globalThis.fetch).
  fetch: globalThis.fetch,

  // Optional: called on failure with a DiagnosticsExporterError whose `code`
  // is 'request_failed', 'timed_out', or 'unexpected_status' (with `status`).
  // The message is fixed; the endpoint URL, entry data, and response body are
  // never echoed.
  onError: (error) => console.error('export failed:', error.code),

  // Optional: request timeout in ms (default 30_000; 0 disables).
  timeoutMs: 10_000,

  // Optional: extra headers, merged over content-type: application/json.
  headers: { authorization: 'Bearer token-abc' },
});

// Drain the recorder once — the caller owns the drain cadence.
await exportOnce(recorder, exporter);
```

Construction validates the options eagerly and throws a `TypeError` for a
malformed one (the endpoint must be an absolute http/https URL; the message
never echoes it). An empty entry batch is a no-op — `send([])` returns
immediately without a POST. The response body is never read; it is cancelled
as soon as the status is known, so the connection is freed at once.

## `exportOnce`

`exportOnce(recorder, exporter)` sends `exporter` the entries recorded since
the previous `exportOnce` call for the same recorder and exporter, so calling
it on an interval delivers each entry once rather than re-sending the whole
buffer. The cursor is the recorder's monotonic entry `id` and advances only
when `send` resolves: a custom exporter that throws gets the same entries on
the next call. The built-in HTTP exporter never throws, so a failed POST is
reported to `onError` and not retried. Entries the ring buffer overwrites
between two calls are never seen, so drain more often than the buffer fills.
Calls for the same recorder and exporter run one at a time: a call made while
an earlier `send` is still in flight (a slow collector on a short interval)
waits for it, then sends only what is newer.
This is the only scheduling primitive:
the module ships no timer, interval, or cron. The caller owns the drain cadence
— `setInterval`, `process.on('beforeExit')`, a request hook, or any other
trigger.

```ts
import { InMemoryDiagnosticsRecorder, createHttpExporter, exportOnce } from '@jsails/diagnostics';

const recorder = new InMemoryDiagnosticsRecorder();
const exporter = createHttpExporter({ endpoint: process.env.COLLECTOR_URL });

// Drain on an interval (app-owned scheduling):
setInterval(() => {
  void exportOnce(recorder, exporter);
}, 60_000);
```

The built-in exporters handle their own failures, so nothing propagates from
`exportOnce`; a custom exporter that throws does propagate.

## Honest limits

- **No telemetry SDK dependency.** The exporters import nothing beyond Node
  built-ins. They do not depend on `@opentelemetry/*` or any other
  observability SDK. Wire your own OpenTelemetry collector by pointing
  `createHttpExporter` at an OTLP-compatible HTTP endpoint — the JSON batch
  `{ entries }` is a plain payload any collector can ingest.
- **Export-only, no ingest.** The exporter drains entries *out* of JSails. To
  route entries into the diagnostics recorder, use the recorder's `record()`
  method directly or wire a [Watcher](/docs/observability#watchers).
- **No built-in scheduling.** `exportOnce` is a single drain. The caller owns
  every scheduling decision (interval, flush-before-exit, request hook).
- **No backpressure or retry.** If the HTTP exporter fails, the entries are
  dropped. The recorder's ring buffer holds entries until the next drain, but
  there is no durability guarantee between drains.

## Next steps

- [Observability](/docs/observability) — the recorder, watchers, logging, and
  signals.
- [Jobs](/docs/jobs) — the jobs dashboard and worker-owned metrics.