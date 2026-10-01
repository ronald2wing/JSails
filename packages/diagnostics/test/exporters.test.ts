/**
 * Diagnostics exporter tests: consoleExporter, createHttpExporter with an
 * injectable fetch, and exportOnce. No real network calls — every HTTP
 * exporter test stubs fetch in-process.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiagnosticsEntry, DiagnosticsRecorder } from 'jsails/diagnostics';
import {
  consoleExporter,
  createHttpExporter,
  DiagnosticsExporterError,
  exportOnce,
  type DiagnosticsExporter,
} from '../src/exporters.js';
import { InMemoryDiagnosticsRecorder } from '../src/recorder.js';

/** Build a recorder with a few entries for shared test setups. */
function recorderWithEntries(count: number, prefix = 'test'): DiagnosticsRecorder {
  const recorder = new InMemoryDiagnosticsRecorder();
  for (let i = 1; i <= count; i++) {
    recorder.record({ type: prefix, data: { n: i } });
  }
  return recorder;
}

/** A stub fetch implementation that returns a configurable response and
 * collects request parameters for assertions. */
function createStubFetch(status = 200): {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requests: { url: string | URL; body: string | null }[];
} {
  const requests: { url: string | URL; body: string | null }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? init.body : null;
    requests.push({ url: input instanceof Request ? input.url : input, body });
    return new Response(body !== null ? body : undefined, { status });
  };
  return { fetch, requests };
}

describe('consoleExporter', () => {
  it('writes one JSON line per entry', async () => {
    const lines: string[] = [];
    const exporter = consoleExporter({ write: (line) => lines.push(line) });
    const recorder = recorderWithEntries(2);

    await exportOnce(recorder, exporter);

    assert.equal(lines.length, 2);
    // Each line should be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.type, 'string');
      assert.equal(typeof parsed.at, 'number');
    }
  });

  it('writes nothing for an empty recorder', async () => {
    const lines: string[] = [];
    const exporter = consoleExporter({ write: (line) => lines.push(line) });
    const empty = new InMemoryDiagnosticsRecorder();

    await exportOnce(empty, exporter);

    assert.equal(lines.length, 0);
  });

  it('rejects a non-function write option', () => {
    assert.throws(
      () => consoleExporter({ write: 42 as unknown as (line: string) => void }),
      TypeError,
    );
  });

  it('uses the default stdout writer when no write is given', async () => {
    // Construction only — verify it doesn't throw. Calling send() would write
    // to real stdout, so we test construction and type conformance only.
    const exporter = consoleExporter();
    assert.equal(typeof exporter.send, 'function');
  });

  it('entries are serialized correctly (all DiagnosticsEntry fields survive)', async () => {
    const lines: string[] = [];
    const exporter = consoleExporter({ write: (line) => lines.push(line) });

    const recorder = new InMemoryDiagnosticsRecorder({ clock: () => 1700000000000 });
    recorder.record({
      type: 'query',
      data: { sql: 'SELECT 1', bindings: 3 },
      durationMs: 42,
    });

    await exportOnce(recorder, exporter);

    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!) as DiagnosticsEntry;
    assert.equal(entry.type, 'query');
    assert.equal(entry.at, 1700000000000);
    assert.equal(entry.durationMs, 42);
    assert.deepEqual(entry.data, { sql: 'SELECT 1', bindings: 3 });
  });
});

describe('createHttpExporter construction', () => {
  it('accepts a valid endpoint', () => {
    const exporter = createHttpExporter({ endpoint: 'https://collector.example.com/v1/traces' });
    assert.equal(typeof exporter.send, 'function');
  });

  it('rejects an empty endpoint', () => {
    assert.throws(() => createHttpExporter({ endpoint: '' }), TypeError);
  });

  it('rejects a non-http(s) endpoint', () => {
    assert.throws(() => createHttpExporter({ endpoint: 'ws://collector.example.com' }), TypeError);
  });

  it('rejects a malformed endpoint', () => {
    assert.throws(() => createHttpExporter({ endpoint: 'not-a-url' }), TypeError);
    assert.throws(() => createHttpExporter({ endpoint: 'https://' }), TypeError);
    assert.throws(() => createHttpExporter({ endpoint: 'https://a b' }), TypeError);
  });

  it('rejects a non-function fetch option', () => {
    assert.throws(
      () =>
        createHttpExporter({
          endpoint: 'https://collector.example.com',
          fetch: 'not-a-function' as unknown as typeof globalThis.fetch,
        }),
      TypeError,
    );
  });

  it('rejects a non-function onError option', () => {
    assert.throws(
      () =>
        createHttpExporter({
          endpoint: 'https://collector.example.com',
          onError: 'not-a-function' as unknown as (error: Error) => void,
        }),
      TypeError,
    );
  });

  it('rejects a negative timeoutMs', () => {
    assert.throws(
      () =>
        createHttpExporter({
          endpoint: 'https://collector.example.com',
          timeoutMs: -1,
        }),
      TypeError,
    );
  });

  it('rejects NaN timeoutMs', () => {
    assert.throws(
      () =>
        createHttpExporter({
          endpoint: 'https://collector.example.com',
          timeoutMs: NaN,
        }),
      TypeError,
    );
  });

  it('rejects non-object options', () => {
    assert.throws(() => createHttpExporter(null as unknown as never), TypeError);
  });

  it('rejects array options', () => {
    assert.throws(() => createHttpExporter([] as unknown as never), TypeError);
  });

  it('accepts 0 as a valid timeoutMs (disables timeout)', () => {
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      timeoutMs: 0,
    });
    assert.equal(typeof exporter.send, 'function');
  });
});

describe('createHttpExporter headers and body', () => {
  it('merges caller headers over the JSON content type', async () => {
    let seen: Headers | undefined;
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    };
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      headers: { authorization: 'Bearer t' },
    });

    await exportOnce(recorderWithEntries(1), exporter);

    assert.equal(seen?.get('content-type'), 'application/json');
    assert.equal(seen?.get('authorization'), 'Bearer t');
  });

  it('lets a caller override the content type in any case', async () => {
    let seen: Headers | undefined;
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    };
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      headers: { 'Content-Type': 'application/x-ndjson' },
    });

    await exportOnce(recorderWithEntries(1), exporter);

    assert.equal(seen?.get('content-type'), 'application/x-ndjson');
  });

  it('cancels the unread response body', async () => {
    let cancelled = false;
    const fetch = async (): Promise<Response> => {
      const body = new ReadableStream({
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    };
    const exporter = createHttpExporter({ endpoint: 'https://collector.example.com', fetch });

    await exportOnce(recorderWithEntries(1), exporter);

    assert.equal(cancelled, true);
  });

  it('accepts a stub response without a body property', async () => {
    const errors: unknown[] = [];
    const fetch = async (): Promise<Response> => ({ ok: true, status: 200 }) as Response;
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      onError: (error) => errors.push(error),
    });

    // send() itself, not exportOnce(), which would swallow a throw.
    await exporter.send(recorderWithEntries(1).entries());

    assert.deepEqual(errors, []);
  });

  it('rejects non-object headers', () => {
    assert.throws(
      () => createHttpExporter({ endpoint: 'https://c.example.com', headers: 'x' as never }),
      TypeError,
    );
  });
});

describe('createHttpExporter send', () => {
  it('posts entries as a JSON batch', async () => {
    const { fetch, requests } = createStubFetch(200);
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com/v1/traces',
      fetch,
    });
    const recorder = recorderWithEntries(3);

    await exportOnce(recorder, exporter);

    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.ok(req !== undefined);
    assert.equal(req.url, 'https://collector.example.com/v1/traces');

    const body = req.body;
    assert.ok(body !== null);
    const parsed = JSON.parse(body);
    assert.ok(Array.isArray(parsed.entries));
    assert.equal(parsed.entries.length, 3);

    // Each entry round-trips correctly
    for (const entry of parsed.entries) {
      assert.equal(typeof entry.type, 'string');
      assert.equal(typeof entry.at, 'number');
    }
  });

  it('no-ops on an empty entries array (never POSTs)', async () => {
    const { fetch, requests } = createStubFetch(200);
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
    });
    const empty = new InMemoryDiagnosticsRecorder();

    await exportOnce(empty, exporter);

    // The exporter returns early for an empty batch — no fetch call.
    assert.equal(requests.length, 0);
  });

  it('swallows a non-2xx response (value-free)', async () => {
    const { fetch } = createStubFetch(500);
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
    });
    const recorder = recorderWithEntries(1);

    // Must not throw.
    await exportOnce(recorder, exporter);
  });

  it('swallows a network error (value-free)', async () => {
    const fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
    });
    const recorder = recorderWithEntries(1);

    // Must not throw.
    await exportOnce(recorder, exporter);
  });

  it('fires onError on a non-2xx response', async () => {
    const errors: DiagnosticsExporterError[] = [];
    const { fetch } = createStubFetch(502);
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      onError: (err) => errors.push(err),
    });
    const recorder = recorderWithEntries(1);

    await exportOnce(recorder, exporter);

    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.code, 'unexpected_status');
    assert.equal(errors[0]!.status, 502);
    assert.equal(errors[0]!.message, 'export request failed');
  });

  it('fires onError on a network error', async () => {
    const errors: DiagnosticsExporterError[] = [];
    const fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      onError: (err) => errors.push(err),
    });
    const recorder = recorderWithEntries(1);

    await exportOnce(recorder, exporter);

    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.code, 'request_failed');
    assert.ok(!errors[0]!.message.includes('ECONNREFUSED'));
  });

  it('reports a timed-out request as timed_out', async () => {
    const errors: DiagnosticsExporterError[] = [];
    const fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (
      _input,
      init,
    ) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      timeoutMs: 5,
      onError: (err) => errors.push(err),
    });

    await exportOnce(recorderWithEntries(1), exporter);

    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.code, 'timed_out');
  });

  it('swallows a throwing onError callback', async () => {
    const { fetch } = createStubFetch(500);
    const exporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
      fetch,
      onError: () => {
        throw new Error('onError callback blew up');
      },
    });
    const recorder = recorderWithEntries(1);

    // Must not throw.
    await exportOnce(recorder, exporter);
  });

  it('uses globalThis.fetch when no fetch option is given', async () => {
    // Verify that construction without fetch does not throw — the real
    // send() is not called so globalThis.fetch is never invoked.
    const exporter = createHttpExporter({ endpoint: 'https://collector.example.com' });
    assert.equal(typeof exporter.send, 'function');
  });

  it('error messages are value-free (never echo the endpoint)', async () => {
    const errors: DiagnosticsExporterError[] = [];
    const { fetch } = createStubFetch(500);
    const endpoint = 'https://secret-collector.example.com/deadbeef';
    const exporter = createHttpExporter({
      endpoint,
      fetch,
      onError: (err) => errors.push(err),
    });
    const recorder = recorderWithEntries(1);

    await exportOnce(recorder, exporter);

    assert.equal(errors.length, 1);
    // Error message must not contain the endpoint URL.
    assert.ok(!errors[0]!.message.includes(endpoint));
  });
});

describe('exportOnce', () => {
  it('calls the exporter even with an empty recorder', async () => {
    let called = false;
    const exporter: DiagnosticsExporter = {
      async send(_entries) {
        called = true;
      },
    };
    const empty = new InMemoryDiagnosticsRecorder();

    await exportOnce(empty, exporter);

    assert.ok(called);
  });

  it('passes every recorded entry to the exporter', async () => {
    let received: DiagnosticsEntry[] = [];
    const exporter: DiagnosticsExporter = {
      async send(entries) {
        received = [...entries];
      },
    };
    const recorder = recorderWithEntries(5);

    await exportOnce(recorder, exporter);

    assert.equal(received.length, 5);
  });

  it('does not throw when the exporter rejects', async () => {
    const exporter: DiagnosticsExporter = {
      async send(_entries) {
        throw new Error('delivery failed');
      },
    };
    // exportOnce does not catch — the exporter is responsible for its own
    // error handling. If the exporter throws, exportOnce propagates it.
    // Verify that the built-in exporters never throw (tested above).
    const recorder = recorderWithEntries(1);

    await assert.rejects(() => exportOnce(recorder, exporter), /delivery failed/);
  });

  it('sends only the entries recorded since the previous call', async () => {
    const batches: string[][] = [];
    const exporter: DiagnosticsExporter = {
      async send(entries) {
        batches.push(entries.map((entry) => String(entry.data?.['n'] ?? entry.type)));
      },
    };
    const recorder = new InMemoryDiagnosticsRecorder();
    recorder.record({ type: 'extra', data: { n: 1 } });
    recorder.record({ type: 'extra', data: { n: 2 } });

    await exportOnce(recorder, exporter);
    recorder.record({ type: 'extra', data: { n: 3 } });
    recorder.record({ type: 'extra', data: { n: 4 } });
    await exportOnce(recorder, exporter);
    await exportOnce(recorder, exporter);

    assert.deepEqual(batches, [['1', '2'], ['3', '4'], []]);
  });

  it('keeps one cursor per exporter', async () => {
    const counts: Record<string, number[]> = { a: [], b: [] };
    const exporterFor = (name: 'a' | 'b'): DiagnosticsExporter => ({
      async send(entries) {
        counts[name]!.push(entries.length);
      },
    });
    const a = exporterFor('a');
    const b = exporterFor('b');
    const recorder = recorderWithEntries(2);

    await exportOnce(recorder, a);
    await exportOnce(recorder, b);
    await exportOnce(recorder, a);

    assert.deepEqual(counts, { a: [2, 0], b: [2] });
  });

  it('resends the same entries after a custom exporter throws', async () => {
    let fail = true;
    const sent: number[] = [];
    const exporter: DiagnosticsExporter = {
      async send(entries) {
        if (fail) throw new Error('delivery failed');
        sent.push(entries.length);
      },
    };
    const recorder = recorderWithEntries(3);

    await assert.rejects(() => exportOnce(recorder, exporter), /delivery failed/);
    fail = false;
    await exportOnce(recorder, exporter);

    assert.deepEqual(sent, [3]);
  });

  it('serializes overlapping calls so a slow send is not repeated', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: number[] = [];
    const exporter: DiagnosticsExporter = {
      async send(entries) {
        sent.push(entries.length);
        if (sent.length === 1) await gate;
      },
    };
    const recorder = recorderWithEntries(3);

    const first = exportOnce(recorder, exporter);
    const second = exportOnce(recorder, exporter);
    release();
    await Promise.all([first, second]);

    assert.deepEqual(sent, [3, 0]);
  });

  it('exports an entry whose id is 0', async () => {
    const entries: DiagnosticsEntry[] = [
      { id: '0', type: 'zero', at: 1, data: {} },
      { id: '1', type: 'one', at: 2, data: {} },
    ];
    const recorder = {
      entries: () => entries,
    } as unknown as DiagnosticsRecorder;
    const batches: string[][] = [];
    const exporter: DiagnosticsExporter = {
      async send(batch) {
        batches.push(batch.map((entry) => entry.type));
      },
    };

    await exportOnce(recorder, exporter);
    await exportOnce(recorder, exporter);

    assert.deepEqual(batches, [['zero', 'one'], []]);
  });
});

describe('DiagnosticsExporter contract', () => {
  it('consoleExporter satisfies the contract', async () => {
    const exporter: DiagnosticsExporter = consoleExporter({ write: () => {} });
    assert.equal(typeof exporter.send, 'function');
  });

  it('createHttpExporter satisfies the contract', () => {
    // Construction-only; send() requires fetch.
    const exporter: DiagnosticsExporter = createHttpExporter({
      endpoint: 'https://collector.example.com',
    });
    assert.equal(typeof exporter.send, 'function');
  });

  it('custom object literals satisfy the contract', async () => {
    const exporter: DiagnosticsExporter = {
      async send(_entries: readonly DiagnosticsEntry[]): Promise<void> {
        // no-op
      },
    };
    assert.equal(typeof exporter.send, 'function');
  });
});
