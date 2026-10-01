/**
 * Runs the repository gates: every module in `scripts/gates/`. A new check is a
 * new file there, never an edit to `package.json` or CI; `npm run check` runs
 * them all through `npm run gates`.
 *
 * Gate contract (`scripts/gates/<name>.mjs`, `<name>` kebab-case):
 *
 *   export const name = '<name>';             // equals the file name
 *   export const description = 'One line.';
 *   export const needsBuild = false;          // true: reads workspace dist/ output
 *   export async function run({ repoRoot }) { return []; }   // failure messages
 *
 * `run` returns (or resolves to) the list of failures; an empty list passes and
 * a throw fails. A ratcheting gate keeps today's violations in a gate ledger
 * (`scripts/expected-failures/<name>.json`, kind "gate") and compares through
 * `ratchet()` from `scripts/expected-failures.mjs`.
 *
 * Each gate runs in its own process (a crash or `process.exit` in one cannot
 * hide another's result), concurrently, with its output printed whole.
 *
 * Usage: node scripts/run-gates.mjs [<name> ...]   run all gates, or the named ones
 *        node scripts/run-gates.mjs --list         list gates
 */
import { existsSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { exitStatus, run } from './subprocess.mjs';
import { repoRoot, workspaceDirs } from './workspaces.mjs';

export const GATES_DIR = join(repoRoot, 'scripts', 'gates');
const GATE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Gate module files in `dir`, by name. */
export function gateFiles(dir = GATES_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.mjs'))
    .sort()
    .map((file) => join(dir, file));
}

/** Imports a gate module and checks it against the contract. */
export async function loadGate(file) {
  const module = await import(pathToFileURL(file).href);
  const expected = basename(file, '.mjs');
  const problems = [];
  if (!GATE_NAME.test(expected)) problems.push('the file name must be kebab-case');
  if (module.name !== expected) problems.push(`\`name\` must be "${expected}"`);
  if (typeof module.description !== 'string' || module.description === '') {
    problems.push('`description` is required');
  }
  if (typeof module.needsBuild !== 'boolean') problems.push('`needsBuild` must be a boolean');
  if (typeof module.run !== 'function') problems.push('`run` must be a function');
  if (problems.length > 0) {
    throw new Error(`${basename(file)} breaks the gate contract: ${problems.join('; ')}`);
  }
  return {
    file,
    name: module.name,
    description: module.description,
    needsBuild: module.needsBuild,
    run: module.run,
  };
}

/** Whether every workspace has its `dist/src` output. */
function isBuilt() {
  return workspaceDirs().every((dir) => existsSync(join(dir, 'dist', 'src')));
}

/** Runs one gate in this process; returns the exit status. */
export async function runGate(gate, { root = repoRoot, built = isBuilt } = {}) {
  if (gate.needsBuild && !built()) {
    console.error(`${gate.name}: needs built workspaces; run "npm run build" first`);
    return 1;
  }
  const failures = await gate.run({ repoRoot: root });
  if (!Array.isArray(failures)) {
    console.error(`${gate.name}: run() must return a list of failure messages`);
    return 1;
  }
  for (const failure of failures) console.error(`${gate.name}: ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

async function runAll(names) {
  const gates = [];
  for (const file of gateFiles()) gates.push(await loadGate(file));
  const unknown = names.filter((name) => !gates.some((gate) => gate.name === name));
  if (unknown.length > 0) {
    console.error(`Unknown gate(s): ${unknown.join(', ')}`);
    return 2;
  }
  const selected = names.length === 0 ? gates : gates.filter((gate) => names.includes(gate.name));
  const queue = [...selected];
  const failed = [];
  const limit = Math.max(1, availableParallelism());
  const worker = async () => {
    for (let gate = queue.shift(); gate !== undefined; gate = queue.shift()) {
      const started = Date.now();
      const outcome = await run(process.execPath, [import.meta.filename, '--run', gate.file], {
        cwd: repoRoot,
        capture: true,
      });
      const status = exitStatus(outcome);
      const verdict = status === 0 ? 'passed' : 'FAILED';
      process.stdout.write(`\n── gate ${gate.name} ${verdict} (${Date.now() - started} ms) ──\n`);
      if (outcome.output !== '') process.stdout.write(outcome.output);
      if (status !== 0) failed.push(gate.name);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, selected.length) }, worker));
  if (failed.length > 0) {
    console.error(`\nFailed gate(s): ${failed.sort().join(', ')}`);
    return 1;
  }
  console.log(`\nAll ${selected.length} gate(s) passed.`);
  return 0;
}

async function main(argv) {
  if (argv[0] === '--run') return runGate(await loadGate(argv[1]));
  if (argv[0] === '--list') {
    for (const file of gateFiles()) {
      const gate = await loadGate(file);
      console.log(`${gate.name}${gate.needsBuild ? ' (needs build)' : ''}: ${gate.description}`);
    }
    return 0;
  }
  return runAll(argv);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
