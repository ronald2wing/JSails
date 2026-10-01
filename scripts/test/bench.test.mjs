/**
 * Tests for the bench (`scripts/bench/`, gate `bench`): the measurement engine
 * on synthetic requests (exact counters are exact, a varying counter is
 * refused, banded counters are medians), the budget comparison and ratchet,
 * scenario discovery, the module loader kept out of the fs counter, a hung
 * child killed at its deadline, and, when core is built, one real scenario
 * run in a bench child where a handler with one extra fs call fails its
 * budget.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { installCollectors } from '../bench/collectors/index.mjs';
import { EXACT, measureBanded, measureExact, measureOnce, median } from '../bench/harness.mjs';
import {
  bandOf,
  compare,
  compareTimings,
  costOf,
  jobLimit,
  jobsOf,
  loadScenarios,
  lowerBudget,
  medianResults,
  nodeLine,
  overBand,
  runJob,
  strictNodeLine,
} from '../bench/index.mjs';
import { isLoaderFrame, withoutLoaderFs } from '../bench/loader-fs.mjs';
import { repoRoot } from '../workspaces.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-bench-test-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('the measurement engine', () => {
  let collectors;
  before(() => {
    collectors = installCollectors();
  });
  after(() => collectors.uninstall());

  const statTimes = (count) => async () => {
    for (let index = 0; index < count; index += 1) statSync(repoRoot);
    return { status: 200, bytes: 3 };
  };

  it('counts exact work per request', async () => {
    const exact = await measureExact(collectors, statTimes(2), { expectStatus: 200, warmup: 2 });
    assert.deepEqual(Object.keys(exact), [...EXACT]);
    assert.equal(exact.fs, 2);
    assert.equal(exact.bytesOut, 3);
    assert.equal(exact.modules, 0);
  });

  it('fails a budget on one extra fs call', async () => {
    const options = { expectStatus: 200, warmup: 1 };
    const budget = lowerBudget(
      { scenarios: {} },
      { probe: { exact: await measureExact(collectors, statTimes(1), options) } },
    );
    const { failures } = compare(
      { probe: { exact: await measureExact(collectors, statTimes(2), options) } },
      budget,
    );
    assert.deepEqual(failures, [
      'probe: fs is 2, above its budget of 1; remove the extra work, or raise the budget in perf/budgets.json with the reason in the commit',
    ]);
  });

  it('refuses a counter that varies between identical requests', async () => {
    let calls = 0;
    const varying = async () => {
      calls += 1;
      if (calls % 2 === 0) statSync(repoRoot);
      return { status: 200, bytes: 0 };
    };
    await assert.rejects(
      measureExact(collectors, varying, { expectStatus: 200, warmup: 0 }),
      (error) => error.code === 'not_exact' && /fs varies/.test(error.message),
    );
  });

  it('refuses an unexpected status', async () => {
    await assert.rejects(
      measureExact(collectors, async () => ({ status: 500, bytes: 0 }), { expectStatus: 200 }),
      (error) => error.code === 'unexpected_status',
    );
  });

  it('takes banded counters as medians and reports timings', async () => {
    const send = async () => {
      await Promise.resolve();
      return { status: 200, bytes: 0 };
    };
    const { banded, timing } = await measureBanded(collectors, send, {
      expectStatus: 200,
      warmup: 5,
      samples: 21,
    });
    assert.ok(banded.promises >= 1, `promises ${banded.promises}`);
    assert.ok(banded.allocBytes >= 0);
    assert.ok(timing.rps > 0 && timing.p50Ms >= 0);
  });

  it('counts a one-off step', async () => {
    const { counts, ms } = await measureOnce(collectors, async () => {
      statSync(repoRoot);
      return 7;
    });
    assert.equal(counts.fs, 1);
    assert.equal(counts.bytesOut, 7);
    assert.ok(ms >= 0);
  });

  it('computes medians', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
  });
});

describe('budgets', () => {
  const result = { exact: { fs: 1, zlib: 0 }, banded: { promises: 100, allocBytes: 1000 } };

  it('band a median by 15% and name the Node line', () => {
    assert.equal(bandOf(100), 115);
    assert.equal(bandOf(101), 117);
    assert.equal(nodeLine('v26.13.1'), '26.13');
  });

  it('record budgets, lower exact ones, and take banded ones afresh', () => {
    const first = lowerBudget({ scenarios: {} }, { a: result }, { node: 'v26.13.1' });
    assert.deepEqual(first, {
      node: 'v26.13.1',
      band: 0.15,
      scenarios: { a: { exact: { fs: 1, zlib: 0 }, banded: { promises: 115, allocBytes: 1150 } } },
    });
    const next = { exact: { fs: 3, zlib: 0 }, banded: { promises: 200, allocBytes: 900 } };
    assert.deepEqual(lowerBudget(first, { a: next }, { node: 'v26.13.9' }).scenarios.a, {
      exact: { fs: 1, zlib: 0 },
      banded: { promises: 230, allocBytes: 1035 },
    });
  });

  it('merge runs: the first run for exact counters, the median of each banded counter', () => {
    const run = (promises, allocBytes) => ({
      a: { exact: { fs: 1 }, banded: { promises, allocBytes }, timing: { rps: promises } },
      assembly: { exact: { modules: 4 } },
    });
    assert.deepEqual(medianResults([run(10, 300), run(30, 100), run(20, 200)]), {
      a: { exact: { fs: 1 }, banded: { promises: 20, allocBytes: 200 }, timing: { rps: 10 } },
      assembly: { exact: { modules: 4 } },
    });
    const partial = medianResults([run(10, 300), { a: run(30, 100).a }]);
    assert.deepEqual(partial.a.banded, { promises: 20, allocBytes: 200 });
    assert.deepEqual(partial.assembly, { exact: { modules: 4 } });
  });

  it('report a banded counter over its band as a note when the run is contended', () => {
    const budget = lowerBudget({ scenarios: {} }, { a: result }, { node: process.version });
    const over = { a: { exact: { fs: 2, zlib: 0 }, banded: { promises: 100, allocBytes: 2000 } } };
    const alone = compare(over, budget);
    assert.equal(alone.failures.length, 2);
    const contended = compare(over, budget, { contended: true });
    assert.deepEqual(contended.failures, [
      'a: fs is 2, above its budget of 1; remove the extra work, or raise the budget in perf/budgets.json with the reason in the commit',
    ]);
    assert.ok(
      contended.notes.some((note) =>
        note.startsWith('a: median allocBytes per request is 2000, above its band of 1150'),
      ),
    );
  });

  it('name the jobs over a banded budget, ignoring exact counters and unbudgeted ones', () => {
    const budget = {
      scenarios: {
        a: { banded: { promises: 10, allocBytes: 100 } },
        b: { banded: { promises: 10, allocBytes: 100 } },
        c: { exact: { fs: 0 } },
      },
    };
    const results = {
      a: { banded: { promises: 10, allocBytes: 101 } },
      b: { exact: { fs: 9 }, banded: { promises: 10, allocBytes: 100 } },
      c: { exact: { fs: 1 } },
      d: { banded: { promises: 99, allocBytes: 999 } },
    };
    assert.deepEqual(overBand(results, budget), ['a']);
  });

  it('fail exact and banded growth, a missing budget and a stale one', () => {
    const budget = lowerBudget(
      { scenarios: {} },
      { a: result, gone: result },
      { node: 'v26.13.0' },
    );
    const { failures, notes } = compare(
      {
        a: { exact: { fs: 2, zlib: 0 }, banded: { promises: 116, allocBytes: 10 } },
        fresh: result,
      },
      budget,
      { line: '26.13' },
    );
    assert.deepEqual(notes, []);
    assert.equal(failures.length, 4);
    assert.match(failures[0], /^a: fs is 2, above its budget of 1/);
    assert.match(failures[1], /^a: median promises per request is 116, above its band of 115/);
    assert.match(failures[2], /^fresh: no budget/);
    assert.match(failures[3], /^gone has a budget but no scenario/);
    assert.deepEqual(compare({ a: result }, budget, { line: '26.13', partial: true }).failures, []);
  });

  it('price the check as its CPU time over the concurrent slots, or its longest child', () => {
    assert.equal(costOf({ a: { cpuMs: 3000 }, b: { cpuMs: 1000 }, c: {} }, 8), 3000);
    assert.equal(costOf({ a: { cpuMs: 3000 }, b: { cpuMs: 3000 }, c: { cpuMs: 2000 } }, 2), 4000);
    assert.equal(costOf({}, 4), 0);
    assert.equal(jobLimit(64, {}), 6);
    assert.equal(jobLimit(1, {}), 1);
    // Within a budget holder's CPU grant.
    assert.equal(jobLimit(64, { JSAILS_JOBS: '3' }), 3);
  });

  it('compare only exact counters on another Node line', () => {
    const budget = lowerBudget({ scenarios: {} }, { a: result }, { node: 'v26.13.0' });
    const { failures, notes } = compare(
      { a: { exact: { fs: 1, zlib: 0 }, banded: { promises: 999, allocBytes: 1 } } },
      budget,
      { line: '27.0' },
    );
    assert.deepEqual(failures, []);
    assert.match(notes[0], /taken on Node v26\.13\.0; this is 27\.0/);
  });

  it('fail on another Node line when strict, which CI is by default', () => {
    const budget = lowerBudget({ scenarios: {} }, { a: result }, { node: 'v26.13.0' });
    const { failures, notes } = compare({ a: result }, budget, { line: '26.14', strictLine: true });
    assert.deepEqual(notes, []);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /taken on Node v26\.13\.0; this is 26\.14.*--write/);
    assert.equal(strictNodeLine({ CI: 'true' }), true);
    assert.equal(strictNodeLine({ CI: '1' }), true);
    assert.equal(strictNodeLine({ CI: 'false' }), false);
    assert.equal(strictNodeLine({ CI: '0' }), false);
    assert.equal(strictNodeLine({}), false);
    assert.equal(strictNodeLine({}, true), true);
  });
});

describe('the module loader and the fs counter', () => {
  let collectors;
  before(() => {
    collectors = withoutLoaderFs(installCollectors());
  });
  after(() => collectors.uninstall());

  it('recognises a loader frame by its direct caller only', () => {
    assert.ok(isLoaderFrame('Error\n    at realpathSync (node:internal/modules/helpers:77:37)'));
    assert.ok(isLoaderFrame('Error\n    at node:internal/modules/esm/load:12:3'));
    assert.ok(!isLoaderFrame('Error\n    at walk (file:///r/core/dist/src/routing/routes.js:1:1)'));
    assert.ok(!isLoaderFrame('Error\n    at readFileSync (node:fs:441:20)'));
    assert.ok(!isLoaderFrame('Error'));
  });

  it("counts a module's own fs call and not the loader's work to load it", async () => {
    const dir = tempDir({
      'esm.mjs': "import { statSync } from 'node:fs';\nstatSync(import.meta.dirname);\n",
      // A CommonJS `require` of an installed package resolves outside the
      // resolve hooks; it is the loader's all the same.
      'cjs.cjs':
        "const { statSync } = require('node:fs');\nrequire('dep');\nstatSync(__dirname);\n",
      'node_modules/dep/package.json': '{ "name": "dep", "main": "index.js" }\n',
      'node_modules/dep/index.js': 'module.exports = 1;\n',
    });
    for (const file of ['esm.mjs', 'cjs.cjs']) {
      collectors.reset();
      await import(pathToFileURL(join(dir, file)).href);
      const counts = collectors.read();
      assert.equal(counts.fs, 1, file);
      assert.ok(counts.loaderFs > 0, `${file}: the loader's calls are set aside, not lost`);
    }
  });

  it("sets aside nothing of the measured code's own, nested calls included", () => {
    const file = join(tempDir({ 'a.txt': 'a' }), 'a.txt');
    collectors.reset();
    // Without an encoding, readFileSync opens, reads and closes through the
    // module object: nested counted calls that are the caller's, not the loader's.
    readFileSync(file);
    statSync(file);
    const counts = collectors.read();
    assert.equal(counts.loaderFs, 0);
    assert.ok(counts.fs >= 2);
  });
});

describe('a bench child', () => {
  it('is killed at its deadline and named', async () => {
    const dir = tempDir({
      'hang.mjs': 'setInterval(() => {}, 1000);\nawait new Promise(() => {});\n',
    });
    const scenario = { file: join(dir, 'hang.mjs'), name: 'hang' };
    await assert.rejects(
      runJob({ key: 'hang/fetch', scenario }, { root: dir, timeoutMs: 300 }),
      (error) => error.code === 'bench_timeout' && /^hang\/fetch: .*300 ms/.test(error.message),
    );
  });
});

describe('scenarios', () => {
  it('load from any depth and expand request scenarios per driver', async () => {
    const dir = tempDir({
      'a.mjs':
        "export const scenarios = [{ name: 'r', kind: 'request', drivers: ['fetch', 'listener'] }];\n",
      'http/b.mjs':
        "export const scenarios = [{ name: 'boot', kind: 'assembly' }, { name: 'cli', kind: 'process' }];\n",
    });
    const scenarios = await loadScenarios(dir);
    assert.deepEqual(
      jobsOf(scenarios).map((job) => job.key),
      ['r/fetch', 'r/listener', 'boot'],
    );
  });

  it('refuse two scenarios with one name', async () => {
    const dir = tempDir({
      'a.mjs': "export const scenarios = [{ name: 'x', kind: 'assembly' }];\n",
      'b.mjs': "export const scenarios = [{ name: 'x', kind: 'assembly' }];\n",
    });
    await assert.rejects(loadScenarios(dir), /two bench scenarios are named x/);
  });

  it('name every committed scenario once and give each a budget', async () => {
    const jobs = jobsOf(await loadScenarios());
    assert.ok(jobs.some((job) => job.key === 'api-small-json/listener'));
    const { scenarios } = JSON.parse(readFileSync(join(repoRoot, 'perf', 'budgets.json'), 'utf8'));
    assert.deepEqual(jobs.map((job) => job.key).sort(), Object.keys(scenarios).sort());
  });
});

const built = existsSync(join(repoRoot, 'core', 'dist', 'src', 'app', 'application.js'));

describe('a real scenario in a bench child', { skip: built ? false : 'core is not built' }, () => {
  function scenarioFile(statCalls) {
    const handler = [
      "import { statSync } from 'node:fs';",
      'export const authorize = () => true;',
      'export function GET() {',
      ...Array.from({ length: statCalls }, () => '  statSync(import.meta.dirname);'),
      '  return Response.json({ ok: true });',
      '}',
      '',
    ].join('\n');
    const dir = tempDir({
      'scenario.mjs': `export const scenarios = [${JSON.stringify({
        name: 'probe',
        kind: 'request',
        files: {
          'jsails.app.js': "export default { host: '127.0.0.1', port: 0 };\n",
          'api/probe.js': handler,
        },
        request: { path: '/api/probe', headers: { accept: 'application/json' } },
        expectStatus: 200,
        drivers: ['fetch'],
      })}];\n`,
    });
    return join(dir, 'scenario.mjs');
  }

  it('fails the budget when the handler makes one extra fs call', async () => {
    const options = { warmup: 5, samples: 20 };
    // Banded counters over 20 samples are too noisy to compare; the exact
    // counters are the point here.
    const job = async (calls) => {
      const [scenario] = await loadScenarios(dirname(scenarioFile(calls)));
      const { exact } = await runJob({ key: 'probe/fetch', scenario, driver: 'fetch' }, options);
      return { exact };
    };
    const one = await job(1);
    const budget = lowerBudget({ scenarios: {} }, { 'probe/fetch': one });
    assert.deepEqual(compare({ 'probe/fetch': await job(1) }, budget).failures, []);
    const { failures } = compare({ 'probe/fetch': await job(2) }, budget);
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      new RegExp(`^probe/fetch: fs is ${one.exact.fs + 1}, above its budget of ${one.exact.fs}`),
    );
  });

  it('records the facts a scenario reports about its request and gates them', async () => {
    const job = async (padding) => {
      const dir = tempDir({
        'scenario.mjs': [
          'export const scenarios = [{',
          "  name: 'sized',",
          "  kind: 'request',",
          '  files: {',
          `    'jsails.app.js': ${JSON.stringify("export default { host: '127.0.0.1', port: 0 };\n")},`,
          `    'api/probe.js': ${JSON.stringify('export const authorize = () => true;\nexport function GET() { return Response.json({ ok: true }); }\n')},`,
          '  },',
          `  request: { path: '/api/probe?pad=${'x'.repeat(padding)}', headers: { accept: 'application/json' } },`,
          '  requestFacts: (request) => ({ pathBytes: request.path.length }),',
          '  expectStatus: 200,',
          "  drivers: ['fetch'],",
          '}];',
          '',
        ].join('\n'),
      });
      const [scenario] = await loadScenarios(dir);
      const { exact } = await runJob(
        { key: 'sized/fetch', scenario, driver: 'fetch' },
        { warmup: 5, samples: 20 },
      );
      return { exact };
    };
    const short = await job(1);
    assert.equal(short.exact.pathBytes, '/api/probe?pad=x'.length);
    const budget = lowerBudget({ scenarios: {} }, { 'sized/fetch': short });
    const { failures } = compare({ 'sized/fetch': await job(2) }, budget);
    assert.deepEqual(failures, [
      `sized/fetch: pathBytes is ${short.exact.pathBytes + 1}, above its budget of ${short.exact.pathBytes}; remove the extra work, or raise the budget in perf/budgets.json with the reason in the commit`,
    ]);
  });
});

describe('compareTimings', () => {
  const jobs = [
    { key: 'old/fetch', scenario: { kind: 'request' } },
    { key: 'new/fetch', scenario: { kind: 'request' } },
  ];

  it('reports a scenario the base cannot run as not comparable and compares the rest', async () => {
    const run = async (job, { root }) => {
      if (root === 'base' && job.key === 'new/fetch') throw new Error('the page carries no marker');
      return { timing: { rps: root === 'head' ? 100 : 50 } };
    };
    const rows = await compareTimings(jobs, { head: 'head', base: 'base', rounds: 3, run });
    assert.deepEqual(rows, [
      { key: 'old/fetch', head: 100, base: 50, ratio: 2, spread: 0, slower: false },
      { key: 'new/fetch', head: 100, base: null, ratio: null, spread: 0, slower: false },
    ]);
  });

  it('still throws when the head cannot run a scenario', async () => {
    const run = async (_job, { root }) => {
      if (root === 'head') throw new Error('head broke');
      return { timing: { rps: 1 } };
    };
    await assert.rejects(
      compareTimings(jobs, { head: 'head', base: 'base', rounds: 1, run }),
      /head broke/,
    );
  });
});
