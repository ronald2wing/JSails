---
title: Diagnostics
order: 27
section: Reference
---

# Diagnostics

The `jsails/diagnostics` subpath covers the in-memory diagnostics recorder
(document in [Observability](/docs/observability)) plus an **export-only neutral
exporter seam** for draining entries to an external destination.

Three primitives ship — a `DiagnosticsExporter` contract, two built-in exporters
(`consoleExporter` and `HttpExporter`), and a one-shot drain helper
(`exportOnce`). Every exporter is value-free on failure: a delivery failure
never throws back into the caller.

## The exporter contract

`DiagnosticsExporter` is a narrow interface — a single `send` method that
receives a batch of read-only `DiagnosticsEntry` objects and resolves when the
batch has been delivered (or swallowed on failure):

```ts
import type { DiagnosticsExporter, DiagnosticsEntry } from 'jsails/diagnostics';

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

`consoleExporter(options?)` writes one JSON line per entry to `process.stdout`,
one entry per line (newline-delimited JSON / NDJSON). The writer is resolved
lazily inside `send()`, so importing this module never touches `process.stdout`.

```ts
import { InMemoryDiagnosticsRecorder, consoleExporter, exportOnce } from 'jsails/diagnostics';

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

## `HttpExporter`

`HttpExporter` POSTs a JSON batch `{ entries: [...] }` to an HTTP collector
endpoint using an injectable `fetch`. The exporter is value-free on failure:
network errors, non-2xx responses, and timeouts are all swallowed after an
optional `onError` callback fires.

```ts
import { InMemoryDiagnosticsRecorder, HttpExporter, exportOnce } from 'jsails/diagnostics';

const recorder = new InMemoryDiagnosticsRecorder({ maxEntries: 1000 });

const exporter = new HttpExporter({
  // Required: a non-empty absolute http(s) URL.
  endpoint: 'https://collector.example.com/v1/diagnostics',

  // Optional: injectable fetch (defaults to globalThis.fetch).
  fetch: globalThis.fetch,

  // Optional: called on failure; the error carries only a fixed message,
  // never the endpoint URL, entry data, or response body.
  onError: (error) => console.error('export failed:', error.message),

  // Optional: request timeout in ms (default 30_000; 0 disables).
  timeoutMs: 10_000,

  // Optional: extra headers (default { 'content-type': 'application/json' }).
  headers: { authorization: 'Bearer token-abc' },
});

// Drain the recorder once — the caller owns the drain cadence.
await exportOnce(recorder, exporter);
```

Construction validates the endpoint eagerly (must be an absolute http/https URL)
and rejects invalid options with a value-free `DiagnosticsExporterError`. An
empty entry batch is a no-op — `send([])` returns immediately without a POST.

## `exportOnce`

`exportOnce(recorder, exporter)` drains every entry currently held in
`recorder` to `exporter` exactly once. This is the only scheduling primitive:
the module ships no timer, interval, or cron. The caller owns the drain cadence
— `setInterval`, `process.on('beforeExit')`, a request hook, or any other
trigger.

```ts
import {
  InMemoryDiagnosticsRecorder,
  consoleExporter,
  HttpExporter,
  exportOnce,
} from 'jsails/diagnostics';

const recorder = new InMemoryDiagnosticsRecorder();

// Drain on an interval (app-owned scheduling):
setInterval(() => {
  exportOnce(recorder, new HttpExporter({ endpoint: process.env.COLLECTOR_URL }));
}, 60_000);
```

Errors from the exporter are handled by the exporter itself and never propagate
from `exportOnce`.

## Honest limits

- **No telemetry SDK dependency.** The exporter module imports nothing beyond
  Node built-ins. It does not depend on `@opentelemetry/*` or any other
  observability SDK. Wire your own OpenTelemetry collector by pointing
  `HttpExporter` at an OTLP-compatible HTTP endpoint — the JSON batch
  `{ entries }` is a plain payload any collector can ingest.
- **Export-only, no ingest.** The exporter drains entries *out* of JSails. To
  route entries into the diagnostics recorder, use the recorder's `record()`
  method directly or wire a [Watcher](/docs/observability#watchers).
- **No built-in scheduling.** `exportOnce` is a single drain. The caller owns
  every scheduling decision (interval, flush-before-exit, request hook).
- **No backpressure or retry.** If `HttpExporter` fails, the entries are
  dropped. The recorder's ring buffer holds entries until the next drain, but
  there is no durability guarantee between drains.

## Next steps

- [Observability](/docs/observability) — the recorder, watchers, logging, and
  signals.
- [Jobs](/docs/jobs) — the jobs dashboard and worker-owned metrics.