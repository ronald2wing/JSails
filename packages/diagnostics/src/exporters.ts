/**
 * Diagnostics exporters: an export-only seam for draining
 * {@link DiagnosticsEntry}s out of the in-memory recorder to an external
 * destination.
 *
 * The contract is deliberately narrow — a single `send` method that receives a
 * batch of read-only entries and resolves when the batch has been delivered
 * (or swallowed on failure). Every built-in exporter is value-free: a failing
 * delivery never throws back into recording.
 *
 * - {@link consoleExporter} writes one JSON line per entry to stdout.
 * - {@link createHttpExporter} POSTs a JSON batch `{ entries }` to any
 *   HTTP/OTLP-compatible collector using an injectable `fetch`.
 * - {@link exportOnce} sends the entries recorded since its last successful
 *   call for the same recorder and exporter. There is no built-in timer or
 *   interval — the caller owns scheduling.
 */

import type { DiagnosticsEntry, DiagnosticsRecorder } from 'jsails/diagnostics';
import { ABSOLUTE_URL_PATTERN, isRecord, JsailsError } from 'jsails/plugin-sdk';
import { Async } from 'jsails/support';

/**
 * A diagnostics exporter accepts a batch of read-only entries and delivers
 * them to an external destination. Implementations must never throw back into
 * the caller — a delivery failure is an implementation concern that stays
 * internal (e.g. logged, reported via a callback, or silently swallowed).
 */
export interface DiagnosticsExporter {
  send(entries: readonly DiagnosticsEntry[]): Promise<void>;
}

/** Stable failure codes reported by the HTTP exporter's `onError`. */
export type DiagnosticsExporterErrorCode = 'request_failed' | 'timed_out' | 'unexpected_status';

/**
 * A delivery failure reported to `onError`. The message is fixed and
 * value-free: the endpoint URL, entry data, and response body are never
 * echoed. A non-2xx response carries its status in `status`.
 */
export class DiagnosticsExporterError extends JsailsError {
  constructor(
    readonly code: DiagnosticsExporterErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Options for {@link consoleExporter}. */
export interface ConsoleExporterOptions {
  /**
   * Writer for each serialized line (one JSON entry plus `\n`). Defaults to
   * `process.stdout.write`, resolved inside `send()` so importing this module
   * is safe in non-Node environments.
   */
  readonly write?: ((line: string) => void) | undefined;
}

/**
 * An exporter that writes one JSON line per entry to stdout. Each line is a
 * complete JSON value followed by a newline, so a collector can read it as
 * newline-delimited JSON (NDJSON).
 */
export function consoleExporter(options?: ConsoleExporterOptions): DiagnosticsExporter {
  const write = options?.write;
  if (write !== undefined && typeof write !== 'function') {
    throw new TypeError('consoleExporter.write must be a function');
  }

  return {
    async send(entries: readonly DiagnosticsEntry[]): Promise<void> {
      const writeLine = write ?? writeStdout;
      for (const entry of entries) {
        // A DiagnosticsEntry is JSON data by contract (primitives and nested
        // records/arrays of them), so `JSON.stringify` cannot throw here.
        writeLine(JSON.stringify(entry) + '\n');
      }
    },
  };
}

function writeStdout(line: string): void {
  process.stdout.write(line);
}

/** Options for {@link createHttpExporter}. */
export interface HttpExporterOptions {
  /**
   * The collector endpoint URL: a non-empty absolute http(s) URL. The
   * exporter POSTs a JSON body `{ entries: [...] }` to it.
   */
  readonly endpoint: string;
  /** Injectable `fetch`. Defaults to `globalThis.fetch`; pass a stub in tests. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  /**
   * Called when `send` fails (network error, timeout, or non-2xx response)
   * with a value-free {@link DiagnosticsExporterError}. The failure is
   * swallowed after the callback runs — the exporter never throws.
   */
  readonly onError?: ((error: DiagnosticsExporterError) => void) | undefined;
  /** Request timeout in milliseconds. Defaults to `30_000`; `0` disables it. */
  readonly timeoutMs?: number | undefined;
  /**
   * Extra headers sent with every POST (e.g. `authorization`). They are merged
   * over `content-type: application/json`, which applies unless overridden.
   */
  readonly headers?: Record<string, string> | undefined;
}

const DEFAULT_HTTP_EXPORTER_TIMEOUT_MS = 30_000;

/**
 * An exporter that POSTs a JSON batch `{ entries }` to an HTTP collector
 * endpoint. Delivery is value-free on failure: network errors, timeouts, and
 * non-2xx responses are reported to `onError` (when given) and swallowed.
 *
 * ```ts
 * const exporter = createHttpExporter({
 *   endpoint: 'https://collector.example.com/v1/traces',
 *   onError: (error) => console.error('exporter error:', error.code),
 * });
 * await exportOnce(recorder, exporter);
 * ```
 */
export function createHttpExporter(options: HttpExporterOptions): DiagnosticsExporter {
  const raw: unknown = options;
  if (!isRecord(raw)) {
    throw new TypeError('createHttpExporter requires an options object');
  }
  const { endpoint, onError } = options;
  if (typeof endpoint !== 'string' || !ABSOLUTE_URL_PATTERN.test(endpoint)) {
    throw new TypeError('createHttpExporter.endpoint must be an absolute http(s) URL');
  }
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new TypeError('createHttpExporter.fetch must be a function');
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('createHttpExporter.onError must be a function');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_EXPORTER_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('createHttpExporter.timeoutMs must be a non-negative finite number');
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (options.headers !== undefined && !isRecord(options.headers)) {
    throw new TypeError('createHttpExporter.headers must be an object');
  }
  // Header names are case-insensitive, so `Headers` resolves a caller's
  // `Content-Type` against the default instead of sending both.
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }

  function report(error: DiagnosticsExporterError): void {
    if (onError === undefined) {
      return;
    }
    try {
      onError(error);
    } catch {
      // A throwing callback is swallowed so the exporter never propagates.
    }
  }

  async function post(body: string): Promise<Response> {
    const init: RequestInit = { method: 'POST', headers, body };
    if (timeoutMs === 0) {
      return fetchFn(endpoint, init);
    }
    const timeout = Async.timeout(timeoutMs);
    try {
      return await fetchFn(endpoint, { ...init, signal: timeout.signal });
    } finally {
      timeout.clear();
    }
  }

  return {
    async send(entries: readonly DiagnosticsEntry[]): Promise<void> {
      // An empty batch is a no-op: never POST an empty array to a collector.
      if (entries.length === 0) {
        return;
      }
      let response: Response;
      try {
        response = await post(JSON.stringify({ entries }));
      } catch (error: unknown) {
        report(
          isAbort(error)
            ? new DiagnosticsExporterError('timed_out', 'export request timed out')
            : new DiagnosticsExporterError('request_failed', 'export request failed'),
        );
        return;
      }
      // The body is never read; cancelling it frees the connection now
      // instead of when the response is garbage-collected.
      response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        report(
          new DiagnosticsExporterError(
            'unexpected_status',
            'export request failed',
            response.status,
          ),
        );
      }
    },
  };
}

/** Whether a `fetch` rejection came from the timeout signal. */
function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

/**
 * Per recorder and exporter: the highest entry id sent so far (`undefined`
 * until a numbered entry has been sent, so a recorder numbering from `0` still
 * exports its first entry) and the settled tail of the calls queued so far.
 */
interface ExportState {
  cursor: number | undefined;
  tail: Promise<void>;
}

const exportStates = new WeakMap<DiagnosticsRecorder, WeakMap<DiagnosticsExporter, ExportState>>();

/** An entry's numeric id, or `undefined` for a recorder that assigns none. */
function entryId(entry: DiagnosticsEntry): number | undefined {
  if (entry.id === undefined) return undefined;
  const id = Number(entry.id);
  return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * Send `exporter` the entries recorded since the last `exportOnce` call for
 * the same recorder and exporter, so a call on an interval delivers each entry
 * once instead of re-sending the whole buffer. The cursor is the recorder's
 * monotonic entry `id`; it advances only when `send()` resolves, so a custom
 * exporter that throws gets the same entries again on the next call. (The
 * built-in exporters never throw: a failed HTTP delivery is reported to
 * `onError` and not retried.) Entries a recorder stores without an `id` are
 * sent on every call. The exporter's `send()` is called even when nothing is
 * new (an empty batch is a no-op in every built-in exporter).
 *
 * Calls for the same recorder and exporter run one at a time: a call started
 * while an earlier `send()` is still in flight (a slow collector on a short
 * interval) waits for it and then reads the advanced cursor, so it never
 * re-sends that batch.
 *
 * Entries the recorder's ring overwrote between two calls are never seen, so
 * call it more often than the buffer fills.
 *
 * This is the only scheduling primitive — the module ships no timer or
 * interval. The caller owns the drain cadence (e.g. `setInterval`,
 * `process.on('beforeExit')`, or a request hook). Errors from a custom
 * exporter propagate to the call that sent the batch.
 */
export async function exportOnce(
  recorder: DiagnosticsRecorder,
  exporter: DiagnosticsExporter,
): Promise<void> {
  let states = exportStates.get(recorder);
  if (states === undefined) {
    states = new WeakMap();
    exportStates.set(recorder, states);
  }
  let state = states.get(exporter);
  if (state === undefined) {
    state = { cursor: undefined, tail: Promise.resolve() };
    states.set(exporter, state);
  }
  const current = state;
  const run = current.tail.then(() => sendSinceCursor(recorder, exporter, current));
  current.tail = run.catch(() => undefined);
  await run;
}

async function sendSinceCursor(
  recorder: DiagnosticsRecorder,
  exporter: DiagnosticsExporter,
  state: ExportState,
): Promise<void> {
  const after = state.cursor;
  let highest: number | undefined;
  const batch = recorder.entries().filter((entry) => {
    const id = entryId(entry);
    if (id === undefined) return true;
    if (after !== undefined && id <= after) return false;
    highest = highest === undefined ? id : Math.max(highest, id);
    return true;
  });
  await exporter.send(batch);
  if (highest !== undefined && (state.cursor === undefined || highest > state.cursor)) {
    state.cursor = highest;
  }
}
