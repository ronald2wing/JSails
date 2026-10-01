/**
 * A small performance probe over the built framework: `npm run bench`.
 *
 * It measures, against `core/dist` (run `npm run build` first):
 *
 *  - CLI cold start: wall time of `jsails --help` in a fresh Node process,
 *    reported as the median and the slowest of several runs;
 *  - application assembly: `createTestApp` over a throwaway project with one
 *    API route and one public file;
 *  - in-process request throughput and latency for that API route and that
 *    static file, served through `Application.fetch` (no socket, so the
 *    numbers reflect the framework pipeline rather than the network stack).
 *
 * The throwaway project lives under the OS temp directory and is removed on
 * exit. Nothing listens on a port.
 *
 * Flags:
 *   --json                    print one JSON object instead of the table
 *   --runs <n>                CLI start samples (default 7)
 *   --requests <n>            requests per throughput case (default 2000)
 *   --max-cli-start-ms <ms>   fail when the median CLI start exceeds this
 *   --min-api-rps <n>         fail when API throughput drops below this
 *
 * The budgets are opt-in because absolute timings vary by machine; compare a
 * change against a run of the base commit on the same machine.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { run } from './subprocess.mjs';
import { repoRoot } from './workspaces.mjs';

const CLI = join(repoRoot, 'core', 'dist', 'src', 'cli', 'index.js');
const TESTING = join(repoRoot, 'core', 'dist', 'src', 'testing', 'index.js');

const { values } = parseArgs({
  options: {
    json: { type: 'boolean', default: false },
    runs: { type: 'string', default: '7' },
    requests: { type: 'string', default: '2000' },
    'max-cli-start-ms': { type: 'string' },
    'min-api-rps': { type: 'string' },
  },
  strict: true,
});

/** A positive integer flag value, or exit with a usage error. */
function positiveInteger(raw, name) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(`--${name} must be a positive integer`);
    process.exit(2);
  }
  return parsed;
}

const runs = positiveInteger(values.runs, 'runs');
const requests = positiveInteger(values.requests, 'requests');

if (!existsSync(CLI) || !existsSync(TESTING)) {
  console.error('Missing core/dist build output. Run "npm run build" first.');
  process.exit(1);
}

/** The value at fraction `q` of an ascending-sorted list. */
function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const round = (value) => Math.round(value * 100) / 100;

async function measureCliStart() {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const outcome = await run(process.execPath, [CLI, '--help'], {
      capture: true,
      forwardSignals: false,
    });
    samples.push(performance.now() - started);
    if (outcome.code !== 0) throw new Error('jsails --help exited non-zero');
  }
  samples.sort((a, b) => a - b);
  return { medianMs: round(quantile(samples, 0.5)), maxMs: round(samples.at(-1)) };
}

/** Sequential requests through `fetchOnce`: requests per second plus p50/p99 latency. */
async function measureThroughput(fetchOnce) {
  // Warm the route (module import, caches) before timing it.
  for (let index = 0; index < 20; index += 1) await (await fetchOnce()).arrayBuffer();
  const latencies = [];
  const started = performance.now();
  for (let index = 0; index < requests; index += 1) {
    const sent = performance.now();
    const response = await fetchOnce();
    await response.arrayBuffer();
    latencies.push(performance.now() - sent);
    if (response.status !== 200) throw new Error(`unexpected status ${response.status}`);
  }
  const elapsed = performance.now() - started;
  latencies.sort((a, b) => a - b);
  return {
    requestsPerSecond: Math.round((requests / elapsed) * 1000),
    p50Ms: round(quantile(latencies, 0.5)),
    p99Ms: round(quantile(latencies, 0.99)),
  };
}

function writeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-bench-'));
  mkdirSync(join(dir, 'api'));
  mkdirSync(join(dir, 'public'));
  writeFileSync(
    join(dir, 'api', 'hello.mjs'),
    `export async function GET() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
  });
}
`,
  );
  writeFileSync(join(dir, 'public', 'robots.txt'), 'User-agent: *\n');
  return dir;
}

async function measureApplication() {
  const dir = writeProject();
  const { createTestApp } = await import(pathToFileURL(TESTING).href);
  try {
    const started = performance.now();
    const app = await createTestApp({
      config: { rootDir: dir, port: 0, authorize: () => true },
    });
    const assemblyMs = round(performance.now() - started);
    try {
      return {
        assemblyMs,
        api: await measureThroughput(() => app.request('/api/hello')),
        staticFile: await measureThroughput(() => app.request('/robots.txt')),
      };
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const result = {
  node: process.version,
  cliStart: await measureCliStart(),
  application: await measureApplication(),
};

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const { cliStart, application } = result;
  console.log(`node ${result.node}`);
  console.log(
    `cli start (jsails --help)  median ${cliStart.medianMs} ms, max ${cliStart.maxMs} ms`,
  );
  console.log(`createTestApp              ${application.assemblyMs} ms`);
  for (const [label, stats] of [
    ['GET /api/hello', application.api],
    ['GET /robots.txt', application.staticFile],
  ]) {
    console.log(
      `${label.padEnd(26)} ${stats.requestsPerSecond} req/s, p50 ${stats.p50Ms} ms, p99 ${stats.p99Ms} ms`,
    );
  }
}

const failures = [];
if (values['max-cli-start-ms'] !== undefined) {
  const budget = positiveInteger(values['max-cli-start-ms'], 'max-cli-start-ms');
  if (result.cliStart.medianMs > budget) {
    failures.push(`CLI start ${result.cliStart.medianMs} ms exceeds ${budget} ms`);
  }
}
if (values['min-api-rps'] !== undefined) {
  const floor = positiveInteger(values['min-api-rps'], 'min-api-rps');
  if (result.application.api.requestsPerSecond < floor) {
    failures.push(`API ${result.application.api.requestsPerSecond} req/s is below ${floor}`);
  }
}
for (const failure of failures) console.error(`budget: ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
