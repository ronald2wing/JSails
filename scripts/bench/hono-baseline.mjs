/**
 * The bare-Hono baseline of a request scenario (`baseline: 'hono'`): the same
 * request, answered by a plain Hono app that parses the JSON body and answers
 * the same JSON, measured in process with the bench's timing loop. `--timing`
 * prints the framework's `fetch` throughput as a ratio of it, so the cost of
 * the pipeline (frame, budget, boundary, finalizer) on a body-reading route
 * is visible next to what the router alone costs. Advisory, never gated.
 *
 * Usage: node scripts/bench/hono-baseline.mjs <scenario-name>   prints `{ rps, p50Ms }` as JSON
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../workspaces.mjs';
import { requestFor } from './app.mjs';
import { median } from './harness.mjs';
import { loadScenarios } from './index.mjs';

/** Requests measured, after as many again to warm up. */
const SAMPLES = 2000;

/** A Hono app answering `request` the way the scenario's route does. */
async function bareApp(request) {
  // Hono resolves from core, which depends on it: the same copy the framework runs on.
  const require = createRequire(join(repoRoot, 'core', 'package.json'));
  const { Hono } = await import(pathToFileURL(require.resolve('hono')).href);
  const app = new Hono();
  app.on(request.method ?? 'GET', request.path, async (c) => {
    const value = await c.req.json();
    return Response.json({ fields: Object.keys(value).length });
  });
  return app;
}

/** `{ rps, p50Ms }` of the bare app answering the scenario's request. */
export async function measureBaseline(scenario, samples = SAMPLES) {
  const app = await bareApp(scenario.request);
  const send = async () => {
    const response = await app.fetch(requestFor(scenario.request));
    await response.arrayBuffer();
    if (response.status !== scenario.expectStatus) {
      throw new Error(`bare Hono answered ${response.status} for ${scenario.name}`);
    }
  };
  for (let index = 0; index < samples; index += 1) await send();
  const latency = [];
  const started = performance.now();
  for (let index = 0; index < samples; index += 1) {
    const sent = performance.now();
    await send();
    latency.push(performance.now() - sent);
  }
  const elapsed = performance.now() - started;
  return {
    rps: Math.round((samples / elapsed) * 1000),
    p50Ms: Math.round(median(latency) * 1000) / 1000,
  };
}

if (import.meta.main) {
  const name = process.argv[2];
  const scenario = (await loadScenarios()).find((candidate) => candidate.name === name);
  if (scenario === undefined || scenario.baseline !== 'hono') {
    console.error(`no scenario named ${name} has a Hono baseline`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(await measureBaseline(scenario)));
  }
}
