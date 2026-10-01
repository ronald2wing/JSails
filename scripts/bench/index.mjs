/**
 * The bench (`npm run bench`, needs a build): request and startup scenarios
 * measured by counters, with budgets in `perf/budgets.json`.
 *
 * Scenarios are modules under `scripts/bench/scenarios/` (any depth) that
 * export `scenarios`: request scenarios (`kind: 'request'`, measured through
 * each of their `drivers`, `fetch` and `listener`), assembly scenarios
 * (`kind: 'assembly'`), and process scenarios (`kind: 'process'`, timing
 * only). Each measurement runs in its own process (`run.mjs`), with the
 * collectors (`collectors/`) installed before the framework loads.
 *
 * Usage: node scripts/bench/index.mjs                   measure and print
 *        node scripts/bench/index.mjs --check           compare with the budgets (a gate)
 *        node scripts/bench/index.mjs --write           record budgets: exact ones lowered,
 *                                                       banded ones taken afresh
 *        node scripts/bench/index.mjs --timing          timings only: requests/s, startup ratios,
 *                                                       bare-Hono ratios
 *        node scripts/bench/index.mjs --compare <root>  timings of this checkout against
 *                                                       another built checkout, interleaved
 *        ... --only api-small-json,assemble-5-routes    restrict the scenarios
 *        ... --json                                     print JSON
 *        ... --strict-node                              fail banded budgets taken on
 *                                                       another Node line (default on CI)
 *
 * Exact counters are ceilings; `fs` counts the framework's file system calls,
 * not those of Node's module loader (`loader-fs.mjs`; module loads are
 * `modules`). Banded counters (promises and allocated bytes per request, a
 * median) are ceilings at the achieved value plus 15%, valid for the Node
 * line they were taken on: on another line they cannot be compared, which
 * fails a CI run (`CI` set) or `--strict-node` and is a note otherwise, until
 * a commit of its own re-baselines them with `--write`.
 *
 * Allocation per request is not stable to a few percent between runs: when
 * V8 optimizes a function, and so which allocations escape analysis removes,
 * varies from process to process, and a run's median moves by about ±8%
 * (more under load). So `--write` takes banded counters from the median of
 * `WRITE_ROUNDS` runs and records them afresh rather than keeping the lowest
 * value ever seen, which would sink the ceiling to the luckiest run plus 15%
 * and fail ordinary runs at random; and `--check` measures a scenario that is
 * over its band `CONFIRM_ROUNDS - 1` more times and judges the median, so one
 * unlucky run does not fail the gate while a real regression, over the band
 * in every run, still does.
 * A request scenario with `baseline: 'hono'` also runs, under `--timing`, a
 * plain Hono app answering the same request (`hono-baseline.mjs`), and its
 * `fetch` throughput is printed as a ratio of that.
 * Timings are never gated: `--compare` reports a scenario as slower when the
 * head is more than 10% below the base with a relative spread under 5%, and
 * fails only with `--strict`. `--check` must finish within `--max-ms`
 * (30000 by default), which is a budget of its own.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { runBounded } from '../import-graph/bounded-run.mjs';
import { pool } from '../import-graph/loaded-set.mjs';
import { jobShare } from '../machine-budget.mjs';
import { exitStatus, run } from '../subprocess.mjs';
import { repoRoot } from '../workspaces.mjs';
import { BenchError, median } from './harness.mjs';

export const SCENARIOS_DIR = join(import.meta.dirname, 'scenarios');
export const BUDGET_FILE = join(repoRoot, 'perf', 'budgets.json');
const RUNNER = join(import.meta.dirname, 'run.mjs');
export const BAND = 0.15;
/** Runs whose median `--write` records as a banded budget. */
export const WRITE_ROUNDS = 5;
/** Runs whose median `--check` judges for a scenario over its band. */
export const CONFIRM_ROUNDS = 3;
const DEFAULT_MAX_MS = 30_000;
/** How long one bench child may run before it is killed and reported. */
export const JOB_TIMEOUT_MS = 120_000;

/** `v26.13.1` -> `26.13`: the line banded budgets are valid for. */
export function nodeLine(version = process.version) {
  return version.replace(/^v/, '').split('.').slice(0, 2).join('.');
}

/** Every scenario module below `dir`, sorted. */
export function scenarioFiles(dir = SCENARIOS_DIR) {
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.mjs')) files.push(path);
    }
  };
  walk(dir);
  return files.sort();
}

/** Every scenario, as `{ ...scenario, file }`; a duplicate name throws. */
export async function loadScenarios(dir = SCENARIOS_DIR) {
  const all = [];
  for (const file of scenarioFiles(dir)) {
    const module = await import(pathToFileURL(file).href);
    for (const scenario of module.scenarios ?? []) all.push({ ...scenario, file });
  }
  const names = all.map((scenario) => scenario.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw new Error(`two bench scenarios are named ${duplicate}`);
  return all;
}

/** The measurement jobs of the gated scenarios: `{ key, scenario, driver? }`. */
export function jobsOf(scenarios) {
  const jobs = [];
  for (const scenario of scenarios) {
    if (scenario.kind === 'request') {
      for (const driver of scenario.drivers ?? ['fetch']) {
        jobs.push({ key: `${scenario.name}/${driver}`, scenario, driver });
      }
    } else if (scenario.kind === 'assembly') {
      jobs.push({ key: scenario.name, scenario });
    }
  }
  return jobs;
}

/** The environment of a bench child: production mode, no runner context. */
function childEnv() {
  const env = { ...process.env, NODE_ENV: 'production' };
  for (const key of ['NODE_TEST_CONTEXT', 'JSAILS_TEST_FILE_PID', 'JSAILS_HOST', 'JSAILS_PORT']) {
    delete env[key];
  }
  return env;
}

/**
 * Runs one job in a bench child against the checkout at `root`. A child still
 * running after `timeoutMs` is killed, and the job rejects with
 * `bench_timeout`.
 */
export async function runJob(
  job,
  { root = repoRoot, warmup, samples, exact = true, timeoutMs = JOB_TIMEOUT_MS } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-bench-'));
  try {
    const jobFile = join(dir, 'job.json');
    const outFile = join(dir, 'out.json');
    writeFileSync(
      jobFile,
      JSON.stringify({
        root,
        file: job.scenario.file,
        name: job.scenario.name,
        driver: job.driver,
        warmup,
        samples,
        exact,
      }),
    );
    const outcome = await runBounded([RUNNER, outFile, jobFile], {
      cwd: root,
      env: childEnv(),
      timeoutMs,
    });
    if (outcome.timedOut) {
      throw new BenchError(
        'bench_timeout',
        `${job.key}: the bench child was still running after ${timeoutMs} ms and was killed\n${outcome.output.trim()}`,
      );
    }
    const status = exitStatus(outcome);
    if (status !== 0)
      throw new Error(
        `${job.key}: the bench child exited with ${status}\n${outcome.output.trim()}`,
      );
    return JSON.parse(readFileSync(outFile, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * How many bench children run at once by default: at most 6, and within the
 * CPU grant a budget holder passed down (`jobShare`).
 */
export function jobLimit(cores = availableParallelism(), env = process.env) {
  return jobShare(6, { env, parallelism: cores });
}

/**
 * The bench's own cost: a lower bound on the wall time a check takes on an
 * otherwise idle machine with `limit` concurrent slots, from its children's
 * CPU time. It is the larger of the total spread over the slots and the
 * longest single child (the critical path: no slot count shortens it). Wall
 * time measured while other work shares the machine (the gate runner starts
 * every gate at once) says more about the neighbours than about the bench;
 * the wall-clock budget itself is `--check --max-ms`, run alone.
 */
export function costOf(results, limit = jobLimit()) {
  const cpu = Object.values(results).map((result) => result.cpuMs ?? 0);
  const total = cpu.reduce((sum, ms) => sum + ms, 0);
  return Math.round(Math.max(total / limit, ...cpu, 0));
}

/** Measures every job concurrently: `{ key: result }`. */
export async function measureJobs(jobs, options = {}) {
  const limit = options.limit ?? jobLimit();
  const results = await pool(
    jobs.map((job) => async () => [job.key, await runJob(job, options)]),
    limit,
  );
  return Object.fromEntries(results);
}

/**
 * One result per job from several runs of it: the exact counters, timing and
 * cost of the first run (exact counters agree between runs, or the run fails)
 * and, per banded counter, the median of the runs.
 */
export function medianResults(rounds) {
  const merged = {};
  for (const key of Object.keys(rounds[0] ?? {})) {
    const runs = rounds.map((round) => round[key]).filter((result) => result !== undefined);
    const first = runs[0];
    if (first.banded === undefined) {
      merged[key] = first;
      continue;
    }
    const banded = Object.fromEntries(
      Object.keys(first.banded).map((counter) => [
        counter,
        median(runs.map((result) => result.banded[counter])),
      ]),
    );
    merged[key] = { ...first, banded };
  }
  return merged;
}

/** The keys of the jobs whose banded counters are over their budget. */
export function overBand(results, budget) {
  return Object.entries(results)
    .filter(([key, result]) =>
      Object.entries(result.banded ?? {}).some(([counter, value]) => {
        const ceiling = budget.scenarios[key]?.banded?.[counter];
        return ceiling !== undefined && value > ceiling;
      }),
    )
    .map(([key]) => key);
}

/** Reads the budgets; a missing file is an empty budget. */
export function readBudget(file = BUDGET_FILE) {
  if (!existsSync(file)) return { node: undefined, scenarios: {} };
  const budget = JSON.parse(readFileSync(file, 'utf8'));
  return { ...budget, scenarios: budget.scenarios ?? {} };
}

/** A banded budget for a measured median. */
export function bandOf(value, band = BAND) {
  return Math.ceil(value * (1 + band));
}

/**
 * Whether a banded budget taken on another Node line fails the check
 * (`--strict-node`, or a CI run: `CI` set to anything but `false`/`0`). On
 * CI a silent skip would let the banded gate check nothing from the day the
 * runners move to the next 26.x minor; locally, a developer on another minor
 * gets a note.
 */
export function strictNodeLine(env = process.env, flag = false) {
  const ci = env.CI;
  return flag || (ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0');
}

/**
 * The gate's verdict for measured results against a budget:
 * `{ failures, notes }`. `line` is the running Node line; `partial` (a run of
 * some scenarios) skips the check for budgets without a measurement. Banded
 * budgets compare only on the line they were taken on; on another line they
 * are skipped, which `strictLine` makes a failure instead of a note.
 * `contended` (a run sharing the machine with other work) reports a banded
 * counter over its band as a note: allocation and promises per request rise
 * by about the width of the band when CPU is oversubscribed, because code is
 * optimized later relative to the requests, so only a run alone judges them.
 */
export function compare(
  results,
  budget,
  { line = nodeLine(), partial = false, strictLine = false, contended = false } = {},
) {
  const failures = [];
  const notes = [];
  const sameLine = budget.node !== undefined && nodeLine(budget.node) === line;
  if (!sameLine) {
    const message = `banded budgets were taken on Node ${budget.node ?? 'unknown'}; this is ${line}, so promises and allocation per request cannot be compared. Re-baseline them on Node ${line} in a commit of their own: node scripts/bench/index.mjs --write`;
    if (strictLine) failures.push(message);
    else notes.push(message);
  }
  for (const [key, result] of Object.entries(results)) {
    const limits = budget.scenarios[key];
    if (limits === undefined) {
      failures.push(`${key}: no budget; record it with node scripts/bench/index.mjs --write`);
      continue;
    }
    for (const [counter, value] of Object.entries(result.exact ?? {})) {
      const ceiling = limits.exact?.[counter];
      if (ceiling === undefined) {
        failures.push(`${key}: no budget for ${counter}; record it with --write`);
      } else if (value > ceiling) {
        failures.push(
          `${key}: ${counter} is ${value}, above its budget of ${ceiling}; remove the extra work, or raise the budget in perf/budgets.json with the reason in the commit`,
        );
      } else if (value < ceiling) {
        notes.push(
          `${key}: ${counter} is ${value}, below its budget of ${ceiling}; lower it with --write`,
        );
      }
    }
    if (!sameLine) continue;
    for (const [counter, value] of Object.entries(result.banded ?? {})) {
      const ceiling = limits.banded?.[counter];
      if (ceiling === undefined) {
        failures.push(`${key}: no budget for ${counter}; record it with --write`);
      } else if (value > ceiling) {
        const message = `${key}: median ${counter} per request is ${value}, above its band of ${ceiling} (+${BAND * 100}%)`;
        if (contended) {
          notes.push(
            `${message}, measured beside other work; node scripts/bench/index.mjs --check, run alone, judges it`,
          );
        } else {
          failures.push(`${message}; find the extra work, or re-baseline in a commit of its own`);
        }
      }
    }
  }
  if (!partial) {
    for (const key of Object.keys(budget.scenarios)) {
      if (results[key] === undefined)
        failures.push(`${key} has a budget but no scenario; remove it`);
    }
  }
  return { failures, notes };
}

/**
 * Budgets after a `--write`: exact ceilings are recorded or lowered; banded
 * ones are recorded afresh at the value plus the band, the value being the
 * median of `WRITE_ROUNDS` runs (see the module comment for why they are not
 * lowered like exact ones).
 */
export function lowerBudget(budget, results, { node = process.version } = {}) {
  const scenarios = {};
  for (const [key, result] of Object.entries(results).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const previous = budget.scenarios[key] ?? {};
    const entry = {};
    if (result.exact !== undefined) {
      entry.exact = Object.fromEntries(
        Object.entries(result.exact).map(([counter, value]) => {
          const before = previous.exact?.[counter];
          return [counter, before === undefined ? value : Math.min(before, value)];
        }),
      );
    }
    if (result.banded !== undefined) {
      entry.banded = Object.fromEntries(
        Object.entries(result.banded).map(([counter, value]) => [counter, bandOf(value)]),
      );
    }
    scenarios[key] = entry;
  }
  return { node, band: BAND, scenarios };
}

/** Wall times of `node <args>` in `rounds` fresh processes; the median in ms. */
async function processMs(args, rounds, cwd) {
  const samples = [];
  for (let index = 0; index < rounds; index += 1) {
    const started = performance.now();
    const outcome = await run(process.execPath, args, {
      cwd,
      capture: true,
      forwardSignals: false,
    });
    samples.push(performance.now() - started);
    if (exitStatus(outcome) !== 0) throw new Error(`node ${args.join(' ')} failed`);
  }
  return median(samples);
}

/** Startup timings: `jsails --help` against bare `node -e 0`, as a ratio. */
async function startupTimings(scenarios, root, rounds = 7) {
  const timings = {};
  const cli = join(root, 'core', 'dist', 'src', 'cli', 'bin.cjs');
  const bare = await processMs(['-e', '0'], rounds, root);
  for (const scenario of scenarios.filter((candidate) => candidate.kind === 'process')) {
    const ms = await processMs([cli, ...scenario.argv], rounds, root);
    timings[scenario.name] = {
      ms: Math.round(ms),
      bareNodeMs: Math.round(bare),
      ratio: Math.round((ms / bare) * 100) / 100,
    };
  }
  return timings;
}

/**
 * Bare-Hono baselines of the scenarios that name one: `{ [name]: { rps,
 * honoRps, ratio } }`, `rps` being the scenario's `fetch` throughput in
 * `results`. Each baseline runs in its own process, as the scenarios do.
 */
async function honoBaselines(scenarios, results, root) {
  const baselines = {};
  const script = join(root, 'scripts', 'bench', 'hono-baseline.mjs');
  for (const scenario of scenarios.filter((candidate) => candidate.baseline === 'hono')) {
    const outcome = await run(process.execPath, [script, scenario.name], {
      cwd: root,
      capture: true,
      forwardSignals: false,
    });
    if (exitStatus(outcome) !== 0) throw new Error(`the Hono baseline of ${scenario.name} failed`);
    const hono = JSON.parse(outcome.stdout);
    const rps = results[`${scenario.name}/fetch`]?.timing?.rps;
    baselines[scenario.name] = {
      rps,
      honoRps: hono.rps,
      ratio: rps === undefined ? null : Math.round((rps / hono.rps) * 100) / 100,
    };
  }
  return baselines;
}

/** Relative standard deviation of a list. */
function spread(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return mean === 0 ? 0 : Math.sqrt(variance) / mean;
}

/**
 * Head-versus-base requests/s, interleaved (head, base, head, base, ...) for
 * `rounds` rounds: `[{ key, head, base, ratio, spread, slower }]`. A scenario
 * the base build cannot run (it depends on behaviour the base does not have
 * yet) is a row with `base: null` and no ratio rather than the end of the
 * comparison; a failing head run still throws, since that is this checkout's
 * own defect. `run` is the job runner, replaceable in tests.
 */
export async function compareTimings(
  jobs,
  { head, base, rounds = 5, samples = 2000, run = runJob },
) {
  const rows = [];
  for (const job of jobs.filter((candidate) => candidate.scenario.kind === 'request')) {
    const headRps = [];
    const baseRps = [];
    let comparable = true;
    for (let round = 0; round < rounds && comparable; round += 1) {
      headRps.push((await run(job, { root: head, samples, exact: false })).timing.rps);
      try {
        baseRps.push((await run(job, { root: base, samples, exact: false })).timing.rps);
      } catch {
        comparable = false;
      }
    }
    if (!comparable) {
      rows.push({
        key: job.key,
        head: median(headRps),
        base: null,
        ratio: null,
        spread: 0,
        slower: false,
      });
      continue;
    }
    const headMedian = median(headRps);
    const baseMedian = median(baseRps);
    const worst = Math.max(spread(headRps), spread(baseRps));
    const ratio = Math.round((headMedian / baseMedian) * 1000) / 1000;
    rows.push({
      key: job.key,
      head: headMedian,
      base: baseMedian,
      ratio,
      spread: worst,
      slower: ratio < 0.9 && worst < 0.05,
    });
  }
  return rows;
}

function printResults(results) {
  for (const [key, result] of Object.entries(results)) {
    const exact = Object.entries(result.exact ?? {})
      .filter(([, value]) => value !== 0)
      .map(([counter, value]) => `${counter}=${value}`)
      .join(' ');
    const banded =
      result.banded === undefined
        ? ''
        : ` | promises=${result.banded.promises} allocBytes=${result.banded.allocBytes}`;
    const timing = Object.entries(result.timing ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join(' ');
    console.log(`${key.padEnd(34)} ${exact}${banded} | ${timing}`);
  }
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      timing: { type: 'boolean', default: false },
      compare: { type: 'string' },
      strict: { type: 'boolean', default: false },
      'strict-node': { type: 'boolean', default: false },
      only: { type: 'string' },
      json: { type: 'boolean', default: false },
      'max-ms': { type: 'string', default: String(DEFAULT_MAX_MS) },
    },
    strict: true,
  });
  const started = performance.now();
  const only = values.only?.split(',').map((name) => name.trim());
  const scenarios = (await loadScenarios()).filter(
    (scenario) => only === undefined || only.includes(scenario.name),
  );
  const jobs = jobsOf(scenarios);

  if (values.compare !== undefined) {
    const rows = await compareTimings(jobs, { head: repoRoot, base: values.compare });
    if (values.json) console.log(JSON.stringify(rows, null, 2));
    for (const row of rows) {
      console.log(
        row.base === null
          ? `${row.key.padEnd(34)} head ${row.head} req/s, base cannot run this scenario`
          : `${row.key.padEnd(34)} head ${row.head} req/s, base ${row.base} req/s, ratio ${row.ratio}, spread ${(row.spread * 100).toFixed(1)}%${row.slower ? '  SLOWER' : ''}`,
      );
    }
    return values.strict && rows.some((row) => row.slower) ? 1 : 0;
  }
  if (values.timing) {
    const results = await measureJobs(jobs, { exact: false, limit: 1 });
    const startup = await startupTimings(scenarios, repoRoot);
    const baselines = await honoBaselines(scenarios, results, repoRoot);
    if (values.json) {
      console.log(JSON.stringify({ node: process.version, results, startup, baselines }, null, 2));
      return 0;
    }
    printResults(results);
    for (const [name, timing] of Object.entries(startup)) {
      console.log(
        `${name.padEnd(34)} ${timing.ms} ms, bare node ${timing.bareNodeMs} ms, ratio ${timing.ratio}`,
      );
    }
    for (const [name, baseline] of Object.entries(baselines)) {
      console.log(
        `${name.padEnd(34)} fetch ${baseline.rps} req/s, bare Hono ${baseline.honoRps} req/s, ratio ${baseline.ratio}`,
      );
    }
    return 0;
  }

  const budget = readBudget();
  if (values.write) {
    if (only !== undefined) throw new Error('--write measures every scenario; drop --only');
    const rounds = [];
    for (let round = 0; round < WRITE_ROUNDS; round += 1) rounds.push(await measureJobs(jobs));
    const results = medianResults(rounds);
    writeFileSync(BUDGET_FILE, `${JSON.stringify(lowerBudget(budget, results), null, 2)}\n`);
    console.log(`wrote ${relative(repoRoot, BUDGET_FILE)}`);
    return 0;
  }
  let results = await measureJobs(jobs);
  if (values.check) {
    const suspects = jobs.filter((job) => overBand(results, budget).includes(job.key));
    if (suspects.length > 0) {
      const rounds = [results];
      for (let round = 1; round < CONFIRM_ROUNDS; round += 1)
        rounds.push(await measureJobs(suspects));
      results = { ...results, ...medianResults(rounds) };
    }
    const { failures, notes } = compare(results, budget, {
      partial: only !== undefined,
      strictLine: strictNodeLine(process.env, values['strict-node']),
    });
    const elapsed = Math.round(performance.now() - started);
    const maxMs = Number(values['max-ms']);
    if (elapsed > maxMs)
      failures.push(`bench --check took ${elapsed} ms, above its budget of ${maxMs} ms`);
    for (const note of notes) console.log(`note: ${note}`);
    for (const failure of failures) console.error(failure);
    console.log(`bench --check: ${jobs.length} measurements in ${elapsed} ms`);
    return failures.length === 0 ? 0 : 1;
  }
  if (values.json) console.log(JSON.stringify({ node: process.version, results }, null, 2));
  else printResults(results);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
