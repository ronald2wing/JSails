/**
 * One bench measurement in its own process: the collectors are installed
 * before anything of the framework loads, then one scenario (and, for a
 * request scenario, one driver) is measured and the result written as JSON.
 * A fresh process per measurement keeps module caches and warm state from one
 * scenario out of the next.
 *
 * Usage: node run.mjs <out.json> <job.json>
 *   job: { root, file, name, driver?, warmup?, samples? }
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { installCollectors } from './collectors/index.mjs';
import { withoutLoaderFs } from './loader-fs.mjs';

const [outFile, jobFile] = process.argv.slice(2);
// Wrapped right after installation, before the framework loads.
const collectors = withoutLoaderFs(installCollectors());
const job = JSON.parse(readFileSync(jobFile, 'utf8'));

const { scenarios } = await import(pathToFileURL(job.file).href);
const scenario = scenarios.find((candidate) => candidate.name === job.name);
if (scenario === undefined) throw new Error(`no scenario ${job.name} in ${job.file}`);

const { createProject, fetchDriver, listenerDriver, openApp } = await import('./app.mjs');
const { measureBanded, measureExact, measureOnce } = await import('./harness.mjs');

const dir = createProject(job.root, scenario.files);
let result;
try {
  if (scenario.kind === 'request') {
    const app = await openApp(job.root, dir);
    const driver =
      job.driver === 'listener'
        ? await listenerDriver(app, scenario.request, collectors)
        : fetchDriver(app, scenario.request);
    try {
      const options = { expectStatus: scenario.expectStatus };
      const exact =
        job.exact === false ? undefined : await measureExact(collectors, driver.send, options);
      const { banded, timing } = await measureBanded(collectors, driver.send, {
        ...options,
        ...(job.warmup === undefined ? {} : { warmup: job.warmup }),
        ...(job.samples === undefined ? {} : { samples: job.samples }),
      });
      result = { exact, banded, timing };
    } finally {
      await driver.close();
    }
  } else if (scenario.kind === 'assembly') {
    let app;
    let driver;
    const assembly = await measureOnce(collectors, async () => {
      app = await openApp(job.root, dir);
      driver = await listenerDriver(app, scenario.request, collectors);
    });
    try {
      const first = await measureOnce(collectors, async () => {
        const response = await driver.send();
        if (response.status !== scenario.expectStatus) {
          throw new Error(`the first request answered ${response.status}`);
        }
        return response.bytes;
      });
      result = {
        exact: Object.fromEntries([
          ...['fs', 'modules'].map((name) => [`assembly.${name}`, assembly.counts[name]]),
          ...['fs', 'modules', 'zlib', 'hashes'].map((name) => [
            `firstRequest.${name}`,
            first.counts[name],
          ]),
        ]),
        timing: { assemblyMs: assembly.ms, firstRequestMs: first.ms },
      };
    } finally {
      await driver.close();
    }
  } else {
    throw new Error(`run.mjs does not measure ${scenario.kind} scenarios`);
  }
} finally {
  collectors.uninstall();
  rmSync(dir, { recursive: true, force: true });
}
// The child's own CPU time is the bench's cost, independent of how loaded the
// machine is (`costOf` in index.mjs).
const usage = process.resourceUsage();
const cpuMs = Math.round((usage.userCPUTime + usage.systemCPUTime) / 1000);
writeFileSync(outFile, JSON.stringify({ ...result, cpuMs }));
