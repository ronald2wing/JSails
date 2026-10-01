/**
 * The loaded-set collector: what a fresh Node process really loads for one
 * public entry or one scenario.
 *
 * Each measurement spawns `probe.mjs` in its own process with the compile
 * cache off (so a warm cache can never hide a regression), and classifies the
 * URLs it reports:
 *
 * - a file under a `node_modules/` directory belongs to the package named by
 *   the last `node_modules/` segment of its path;
 * - a file under a workspace directory belongs to that workspace (first party);
 * - `node:` URLs are builtins, counted apart so a Node upgrade does not move a
 *   module budget;
 * - anything else (the probe, a scenario module, a temporary project) is the
 *   harness, not the measured graph.
 *
 * A third-party package is *entered* when a first-party module imports it.
 * Policy is judged on entered packages: the packages a dependency brings with
 * it are that dependency's business, and its own entry covers them.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { exitStatus } from '../subprocess.mjs';
import { runBounded } from './bounded-run.mjs';

export const PROBE = join(import.meta.dirname, 'probe.mjs');

/** How long one probe may run before it is killed and reported. */
export const PROBE_TIMEOUT_MS = 60_000;

/**
 * A path in the form module URLs carry, for comparison: real, the way Node's
 * loader resolves every module (a symlinked root such as macOS's `/var` ->
 * `/private/var`, a Windows short name such as `RUNNER~1`), absolute (a
 * drive letter on Windows), and case-folded where the default file system
 * ignores case (Windows, macOS). A path that does not exist is resolved
 * lexically.
 */
export function canonicalPath(path, platform = process.platform) {
  let real;
  try {
    // The JavaScript `realpathSync`, not `.native`: it is the one the loader uses.
    real = realpathSync(path);
  } catch {
    real = resolve(path);
  }
  return platform === 'win32' || platform === 'darwin' ? real.toLowerCase() : real;
}

/** `workspaces` with each `dir` replaced by its canonical form (`canonicalPath`). */
function canonicalWorkspaces(workspaces, platform) {
  return workspaces.map((workspace) => ({
    name: workspace.name,
    dir: canonicalPath(workspace.dir, platform),
  }));
}

/** Environment keys a test runner sets that must not reach a probe. */
const RUNNER_KEYS = ['NODE_TEST_CONTEXT', 'JSAILS_TEST_FILE_PID', 'NODE_COMPILE_CACHE'];

/** The child environment: compile cache off, no inherited test-runner context. */
export function probeEnv(env = process.env) {
  const next = { ...env, NODE_DISABLE_COMPILE_CACHE: '1' };
  for (const key of RUNNER_KEYS) delete next[key];
  return next;
}

/** `default` target of an `exports` value (`"./x.js"` or `{ types, default }`). */
function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    for (const key of ['import', 'default', 'node']) {
      const target = exportTarget(value[key]);
      if (target !== undefined) return target;
    }
  }
  return undefined;
}

/**
 * Every public entry of the given workspaces (`[{ name, dir, manifest }]`) as
 * `{ entry, workspace, file }`; `./package.json` is not an entry.
 */
export function publicEntries(workspaces) {
  const entries = [];
  for (const { name, dir, manifest } of workspaces) {
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      if (key === './package.json') continue;
      const target = exportTarget(value);
      if (target === undefined) continue;
      entries.push({
        entry: key === '.' ? name : `${name}${key.slice(1)}`,
        workspace: name,
        file: join(dir, target),
      });
    }
  }
  return entries.sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
}

/** The package that owns a file path below `node_modules`, or undefined. */
export function packageOfPath(path) {
  const marker = `${sep}node_modules${sep}`;
  const at = path.lastIndexOf(marker);
  if (at === -1) return undefined;
  const parts = path.slice(at + marker.length).split(sep);
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** `classify` against workspaces whose `dir` is already canonical. */
function classifyCanonical(url, owners, platform) {
  if (url.startsWith('node:')) return { kind: 'builtin', name: url };
  if (!url.startsWith('file:')) return { kind: 'harness' };
  const path = fileURLToPath(url);
  const name = packageOfPath(path);
  if (name !== undefined) {
    const workspace = owners.find((candidate) => candidate.name === name);
    return workspace === undefined ? { kind: 'package', name } : { kind: 'workspace', name };
  }
  // Module URLs are already real; only the case needs folding to compare.
  const folded = platform === 'win32' || platform === 'darwin' ? path.toLowerCase() : path;
  const owner = owners.find((candidate) => folded.startsWith(candidate.dir + sep));
  return owner === undefined ? { kind: 'harness' } : { kind: 'workspace', name: owner.name };
}

/**
 * Classifies one URL: `{ kind: 'builtin', name }`, `{ kind: 'package', name }`
 * (third party), `{ kind: 'workspace', name }`, or `{ kind: 'harness' }`.
 * Workspace directories are compared in canonical form (`canonicalPath`),
 * since Node reports real module paths.
 */
export function classify(url, workspaces, platform = process.platform) {
  return classifyCanonical(url, canonicalWorkspaces(workspaces, platform), platform);
}

/**
 * Summarises a probe record (`[[url, importerUrl | null], ...]`):
 * `{ modules, builtins, packages, entered, enteredBuiltins, firstParty }`.
 * `modules` counts first- and third-party modules (no builtins, no harness);
 * `entered` maps each third-party package a first-party module imports to one
 * such importer; `enteredBuiltins` the same for builtins.
 */
export function summarize(record, workspaces, platform = process.platform) {
  const owners = canonicalWorkspaces(workspaces, platform);
  const kindOf = (url) => classifyCanonical(url, owners, platform);
  let modules = 0;
  const builtins = new Set();
  const packages = new Map();
  const entered = new Map();
  const enteredBuiltins = new Map();
  const firstParty = new Set();
  for (const [url, importer] of record) {
    const target = kindOf(url);
    if (target.kind === 'harness') continue;
    if (target.kind === 'builtin') builtins.add(target.name);
    else modules += 1;
    if (target.kind === 'workspace') firstParty.add(target.name);
    if (target.kind === 'package') packages.set(target.name, (packages.get(target.name) ?? 0) + 1);
    if (importer === null || target.kind === 'workspace') continue;
    const from = kindOf(importer);
    if (from.kind !== 'workspace') continue;
    const map = target.kind === 'builtin' ? enteredBuiltins : entered;
    if (!map.has(target.name)) map.set(target.name, fileURLToPath(importer));
  }
  return { modules, builtins, packages, entered, enteredBuiltins, firstParty };
}

/**
 * Raised when a probe process fails (`probe_failed`) or outlives its deadline
 * (`probe_timeout`); carries its output.
 */
export class ProbeError extends Error {
  constructor(label, status, output, { timeoutMs } = {}) {
    super(
      timeoutMs === undefined
        ? `${label}: the probe exited with ${status}\n${output.trim()}`
        : `${label}: the probe was still running after ${timeoutMs} ms and was killed; something it loads keeps the process alive\n${output.trim()}`,
    );
    this.code = timeoutMs === undefined ? 'probe_failed' : 'probe_timeout';
  }
}

/**
 * Runs one probe: `target` is `{ mode: 'import', file }`, `{ mode: 'main',
 * file, argv, status }`, or `{ mode: 'scenario', file, args }`. Resolves to
 * the raw record. A `main` target exits with `status` (default 0; a CLI usage
 * error is 2), any other with 0. `cwd` is the child's working directory; a
 * probe still running after `timeoutMs` is killed and rejects with
 * `probe_timeout`.
 */
export async function probe(
  target,
  { cwd, env = process.env, label = target.file, timeoutMs = PROBE_TIMEOUT_MS } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-loaded-set-'));
  const out = join(dir, 'record.json');
  try {
    const args =
      target.mode === 'import'
        ? [pathToFileURL(target.file).href]
        : target.mode === 'main'
          ? [target.file, ...(target.argv ?? [])]
          : [pathToFileURL(target.file).href, ...(target.args ?? [])];
    const outcome = await runBounded([PROBE, out, target.mode, ...args], {
      cwd,
      env: probeEnv(env),
      timeoutMs,
    });
    if (outcome.timedOut) throw new ProbeError(label, undefined, outcome.output, { timeoutMs });
    const status = exitStatus(outcome);
    if (status !== (target.status ?? 0)) throw new ProbeError(label, status, outcome.output);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `tasks` (functions returning promises) with at most `limit` at once, in order. */
export async function pool(tasks, limit = Math.min(8, availableParallelism())) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}
