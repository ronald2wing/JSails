/**
 * Install footprint: the production dependency closure of each workspace, as
 * `{ packages, bytes }`, from `package-lock.json` and the installed tree.
 *
 * The closure starts at a workspace's `dependencies`, `optionalDependencies`
 * and non-optional `peerDependencies` (npm installs those) and follows the
 * same fields of every package it reaches, resolving each name the way Node
 * does: from the requiring package's own `node_modules` up to the root. A
 * package restricted to another platform (`os`, `cpu`, `libc` in the lockfile)
 * is not installed here and is not counted. Another workspace reached through
 * a link is named in `workspaces` and its own dependencies are followed, but
 * its bytes are not counted: a published package's size is its tarball's
 * business, and a checkout carries build output.
 *
 * `bytes` is the size on disk of each counted package's files, without the
 * nested `node_modules` that hold other packages. It is exact for a given
 * lockfile and platform, so the budgets in `scripts/footprint-budget.json`
 * name the platform they were taken on and the gate compares only there.
 *
 * A generated app (verify:starter's installed presets) is measured the same
 * way from its own lockfile with `--project <dir>`.
 *
 * Usage: node scripts/footprint.mjs                 table of every workspace
 *        node scripts/footprint.mjs --check         compare with the budgets
 *        node scripts/footprint.mjs --write         record new budgets, lower the others
 *        node scripts/footprint.mjs --project <dir> [--preset <name>] [--check]
 *                                                   measure an installed app
 */
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { repoRoot } from './workspaces.mjs';

export const BUDGET_FILE = join(repoRoot, 'scripts', 'footprint-budget.json');

/** The libc of this process (`glibc`, `musl`), or undefined off Linux. */
function currentLibc() {
  if (process.platform !== 'linux') return undefined;
  const header = process.report?.getReport?.().header;
  return header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

/** The platform key budgets are recorded under, e.g. `linux-x64-glibc`. */
export function platformKey({
  platform = process.platform,
  arch = process.arch,
  libc = platform === process.platform ? currentLibc() : undefined,
} = {}) {
  return [platform, arch, libc].filter(Boolean).join('-');
}

/** Whether a lockfile constraint list (`["linux", "!win32"]`) admits `value`. */
function admits(list, value) {
  if (!Array.isArray(list) || list.length === 0 || value === undefined) return true;
  const denied = list.filter((item) => item.startsWith('!')).map((item) => item.slice(1));
  const allowed = list.filter((item) => !item.startsWith('!'));
  if (denied.includes(value)) return false;
  return allowed.length === 0 || allowed.includes(value);
}

/** Whether a lockfile entry installs on `target` (`{ platform, arch, libc }`). */
export function installsOn(entry, target) {
  return (
    admits(entry.os, target.platform) &&
    admits(entry.cpu, target.arch) &&
    admits(entry.libc, target.libc)
  );
}

/** The lockfile key a `name` required from location `from` resolves to, or undefined. */
export function resolveKey(lockPackages, from, name) {
  let dir = from;
  for (;;) {
    const key = `${dir === '' ? '' : `${dir}/`}node_modules/${name}`;
    if (lockPackages[key] !== undefined) return key;
    if (dir === '') return undefined;
    const at = dir.lastIndexOf('/node_modules/');
    if (at !== -1) {
      dir = dir.slice(0, at);
      continue;
    }
    if (dir.startsWith('node_modules/')) {
      dir = '';
      continue;
    }
    const slash = dir.lastIndexOf('/');
    dir = slash === -1 ? '' : dir.slice(0, slash);
  }
}

/** The names an entry needs installed, each with whether a missing one is tolerated. */
function requirements(entry) {
  const optionalPeers = entry.peerDependenciesMeta ?? {};
  return [
    ...Object.keys(entry.dependencies ?? {}).map((name) => [name, false]),
    ...Object.keys(entry.optionalDependencies ?? {}).map((name) => [name, true]),
    ...Object.keys(entry.peerDependencies ?? {})
      .filter((name) => optionalPeers[name]?.optional !== true)
      .map((name) => [name, false]),
  ];
}

/** Size in bytes of the files below `dir`, without nested `node_modules`. */
export function directoryBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += directoryBytes(path);
    else total += lstatSync(path).size;
  }
  return total;
}

/**
 * The production closure of the lockfile entry at `startKey` (`""` for an
 * app's root, `core` or `packages/<name>` for a workspace):
 * `{ packages, bytes, workspaces, missing }`. `root` holds the installed tree.
 */
export function productionClosure(lock, startKey, { root, target = defaultTarget() } = {}) {
  const lockPackages = lock.packages ?? {};
  const counted = new Set();
  const workspaces = new Set();
  const missing = new Set();
  const visited = new Set();
  const queue = [startKey];
  while (queue.length > 0) {
    const key = queue.shift();
    if (visited.has(key)) continue;
    visited.add(key);
    const entry = lockPackages[key];
    if (entry === undefined) continue;
    for (const [name, optional] of requirements(entry)) {
      let found = resolveKey(lockPackages, key, name);
      if (found === undefined) {
        if (!optional) missing.add(name);
        continue;
      }
      let resolved = lockPackages[found];
      if (resolved.link === true) {
        found = resolved.resolved;
        resolved = lockPackages[found];
        if (resolved === undefined) continue;
        workspaces.add(resolved.name ?? found);
        queue.push(found);
        continue;
      }
      if (!installsOn(resolved, target)) continue;
      counted.add(found);
      queue.push(found);
    }
  }
  let bytes = 0;
  for (const key of counted) bytes += directoryBytes(join(root, key));
  return {
    packages: counted.size,
    bytes,
    workspaces: [...workspaces].sort(),
    missing: [...missing].sort(),
  };
}

function defaultTarget() {
  return { platform: process.platform, arch: process.arch, libc: currentLibc() };
}

/** `{ name: closure }` for every workspace in the root lockfile. */
export function workspaceFootprints(root = repoRoot, target = defaultTarget()) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const result = {};
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === '' || key.includes('node_modules/') || entry.name === undefined) continue;
    result[entry.name] = productionClosure(lock, key, { root, target });
  }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The footprint of an installed app at `dir` (its own lockfile and `node_modules`). */
export function projectFootprint(dir, target = defaultTarget()) {
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  return productionClosure(lock, '', { root: dir, target });
}

/** Reads the budgets; a missing file is an empty budget for this platform. */
export function readBudget(file = BUDGET_FILE) {
  if (!existsSync(file)) return { platform: platformKey(), workspaces: {}, presets: {} };
  const budget = JSON.parse(readFileSync(file, 'utf8'));
  return {
    platform: budget.platform,
    workspaces: budget.workspaces ?? {},
    presets: budget.presets ?? {},
  };
}

/** Compares measured footprints (`{ name: closure }`) with one budget section. */
export function compare(measured, budgets, { section, missingIsFailure = false } = {}) {
  const failures = [];
  const notes = [];
  for (const [name, closure] of Object.entries(measured)) {
    if (closure.missing.length > 0) {
      failures.push(`${name}: the lockfile does not resolve ${closure.missing.join(', ')}`);
    }
    const budget = budgets[name];
    if (budget === undefined) {
      const message = `${name}: no ${section} budget yet (${closure.packages} packages, ${closure.bytes} bytes); record one with node scripts/footprint.mjs --write`;
      (missingIsFailure ? failures : notes).push(message);
      continue;
    }
    for (const metric of ['packages', 'bytes']) {
      if (closure[metric] > budget[metric]) {
        failures.push(
          `${name}: production closure has ${closure[metric]} ${metric}, above its budget of ${budget[metric]}; drop the dependency, or raise the budget in scripts/footprint-budget.json with the reason in the commit`,
        );
      } else if (closure[metric] < budget[metric]) {
        notes.push(
          `${name}: ${closure[metric]} ${metric}, below its budget of ${budget[metric]}; lower it with node scripts/footprint.mjs --write`,
        );
      }
    }
  }
  return { failures, notes };
}

/** Budgets after a `--write`: new names recorded, existing ones only lowered, gone ones dropped. */
export function lowerBudgets(budgets, measured) {
  const next = {};
  for (const [name, closure] of Object.entries(measured)) {
    const previous = budgets[name];
    next[name] = {
      packages:
        previous === undefined ? closure.packages : Math.min(previous.packages, closure.packages),
      bytes: previous === undefined ? closure.bytes : Math.min(previous.bytes, closure.bytes),
    };
  }
  return next;
}

/**
 * The workspace gate's verdict: `{ failures, notes }`. Off the budget's
 * platform nothing is compared, since the platform decides which packages
 * install.
 */
export function checkWorkspaces({ root = repoRoot, budget = readBudget(), target } = {}) {
  const key = platformKey(target ?? {});
  if (budget.platform !== key) {
    return {
      failures: [],
      notes: [
        `budgets were recorded on ${budget.platform}; this is ${key}, so nothing is compared`,
      ],
    };
  }
  const measured = workspaceFootprints(root, target ?? defaultTarget());
  const { failures, notes } = compare(measured, budget.workspaces, { section: 'workspace' });
  for (const name of Object.keys(budget.workspaces)) {
    if (measured[name] === undefined) {
      failures.push(
        `${name} has a budget but is no workspace; remove it from footprint-budget.json`,
      );
    }
  }
  return { failures, notes };
}

function format(name, closure) {
  return `${name.padEnd(32)} ${String(closure.packages).padStart(5)} packages ${(closure.bytes / 1e6).toFixed(1).padStart(8)} MB`;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      project: { type: 'string' },
      preset: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const budget = readBudget();
  if (values.project !== undefined) {
    const name = values.preset ?? 'project';
    const closure = projectFootprint(values.project);
    if (values.json) console.log(JSON.stringify({ [name]: closure }));
    else console.log(format(name, closure));
    if (values.write) {
      const next = {
        ...budget,
        presets: { ...budget.presets, ...lowerBudgets(budget.presets, { [name]: closure }) },
      };
      writeFileSync(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`);
      return 0;
    }
    if (!values.check || budget.platform !== platformKey()) return 0;
    const { failures, notes } = compare({ [name]: closure }, budget.presets, { section: 'preset' });
    for (const note of notes) console.log(`note: ${note}`);
    for (const failure of failures) console.error(failure);
    return failures.length === 0 ? 0 : 1;
  }
  if (values.write) {
    const measured = workspaceFootprints();
    const sameKey = budget.platform === platformKey();
    const next = {
      platform: platformKey(),
      workspaces: lowerBudgets(sameKey ? budget.workspaces : {}, measured),
      presets: sameKey ? budget.presets : {},
    };
    writeFileSync(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wrote ${relative(repoRoot, BUDGET_FILE)}`);
    return 0;
  }
  if (values.check) {
    const { failures, notes } = checkWorkspaces({ budget });
    for (const note of notes) console.log(`note: ${note}`);
    for (const failure of failures) console.error(failure);
    return failures.length === 0 ? 0 : 1;
  }
  const measured = workspaceFootprints();
  if (values.json) console.log(JSON.stringify(measured, null, 2));
  else for (const [name, closure] of Object.entries(measured)) console.log(format(name, closure));
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
