/**
 * The bench measurement engine. It runs inside a bench child process
 * (`run.mjs`) after the collectors (`collectors/`) are installed, and turns a
 * scenario into three metric classes:
 *
 * - exact counters, hard ceilings: fs operations (the framework's, without
 *   Node's module loader: `loader-fs.mjs`), zlib engines, `Response`
 *   and `ReadableStream` constructions, response bodies pumped through a
 *   stream, AsyncLocalStorage runs, modules loaded, hashes, renders, store
 *   round trips, and response bytes. One request is measured three times on a
 *   settled process; the three must agree, or the scenario is not measurable
 *   and fails.
 * - banded counters, ceilings with headroom: promises created and bytes
 *   allocated per request, the median of `samples` requests after `warmup`
 *   requests. Neither is exact across Node versions or JIT tiers, so a budget
 *   is the achieved value plus 15% and names the Node line it was taken on.
 * - timings, never gated: requests per second and the median latency of the
 *   banded loop, and process timings for startup scenarios.
 *
 * The engine is generic over a `send()` that performs one request and returns
 * `{ status, bytes }`; `app.mjs` builds `send` for the framework's two
 * drivers.
 */
import { getHeapStatistics } from 'node:v8';

/** The exact counters, in report order (`bytesOut` is the response body size). */
export const EXACT = Object.freeze([
  'fs',
  'zlib',
  'responses',
  'readableStreams',
  'bodyStreams',
  'alsRuns',
  'modules',
  'hashes',
  'renders',
  'stores',
  'bytesOut',
]);

/** The banded counters. */
export const BANDED = Object.freeze(['promises', 'allocBytes']);

/** Raised when a scenario cannot be measured; value-free, identified by `code`. */
export class BenchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The median of a numeric list. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function exactOf(counts, bytes) {
  return Object.fromEntries(
    EXACT.map((name) => [name, name === 'bytesOut' ? bytes : counts[name]]),
  );
}

/** Sends one request and checks its status. */
async function sendChecked(send, expectStatus) {
  const result = await send();
  if (result.status !== expectStatus) {
    throw new BenchError(
      'unexpected_status',
      `the scenario answered ${result.status}, expected ${expectStatus}`,
    );
  }
  return result;
}

/**
 * Exact counters of one request: measured `repeat` times on a settled process
 * after `warmup` requests. Throws `not_exact` when the repeats disagree.
 */
export async function measureExact(collectors, send, { expectStatus, warmup = 20, repeat = 3 }) {
  for (let index = 0; index < warmup; index += 1) await sendChecked(send, expectStatus);
  const runs = [];
  for (let index = 0; index < repeat; index += 1) {
    // Let the previous request's trailing work (a stream's close) finish
    // outside the measurement.
    await settle();
    collectors.reset();
    const { bytes } = await sendChecked(send, expectStatus);
    runs.push(exactOf(collectors.read(), bytes));
  }
  for (const name of EXACT) {
    const values = runs.map((run) => run[name]);
    if (new Set(values).size > 1) {
      throw new BenchError(
        'not_exact',
        `exact counter ${name} varies between identical requests (${values.join(', ')})`,
      );
    }
  }
  return runs[0];
}

/**
 * Banded counters and timings: `samples` requests after `warmup`, back to
 * back. Returns `{ banded: { promises, allocBytes }, timing: { rps, p50Ms } }`
 * with medians.
 */
export async function measureBanded(
  collectors,
  send,
  { expectStatus, warmup = 500, samples = 2000 },
) {
  for (let index = 0; index < warmup; index += 1) await sendChecked(send, expectStatus);
  const promises = [];
  const alloc = [];
  const latency = [];
  const started = performance.now();
  for (let index = 0; index < samples; index += 1) {
    collectors.reset();
    const heapBefore = getHeapStatistics().total_allocated_bytes;
    const sent = performance.now();
    await sendChecked(send, expectStatus);
    latency.push(performance.now() - sent);
    alloc.push(getHeapStatistics().total_allocated_bytes - heapBefore);
    promises.push(collectors.read().promises);
  }
  const elapsed = performance.now() - started;
  return {
    banded: { promises: median(promises), allocBytes: median(alloc) },
    timing: {
      rps: Math.round((samples / elapsed) * 1000),
      p50Ms: Math.round(median(latency) * 1000) / 1000,
    },
  };
}

/**
 * Exact counters of one step that runs once per process (assembly, the first
 * request after listening): `{ counts, ms }`.
 */
export async function measureOnce(collectors, step) {
  collectors.reset();
  const started = performance.now();
  const bytes = await step();
  const ms = Math.round((performance.now() - started) * 100) / 100;
  return { counts: exactOf(collectors.read(), bytes ?? 0), ms };
}
