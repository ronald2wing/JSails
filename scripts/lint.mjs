/**
 * Runs ESLint over the repository, one group at a time per lane, with a cache
 * that is sound for type-aware rules.
 *
 * Groups (`lintGroups`): `core` (with `core/templates`, which the config lints
 * with the untyped preset), one per `packages/<name>`, `website`, and `rest`,
 * everything else (the repo tooling and the JS configs). Each group is its own
 * ESLint process, so only that group's TypeScript programs are in memory: one
 * process holding every workspace's programs passed 6 GiB, while core alone
 * peaks at 3.7 GiB and a package at 0.4-0.85 GiB, and the split is faster too.
 * The typescript-eslint project service picks the nearest tsconfig for each
 * file, so every file is checked against the same program and config as in a
 * single run. Two groups run at once (`jobShare(2)`), core first because it is
 * the long pole; each takes a lease from the machine budget
 * (`scripts/machine-budget.mjs`) sized from its recorded peak, and each
 * group's output is printed whole when it ends. The failed groups are named
 * in group order, and the exit status is the first of them in that order, so
 * neither depends on which group a loaded machine finished first.
 *
 * ESLint's cache keys a file's result on that file's content and the config,
 * but a type-aware rule's verdict also depends on the types of everything the
 * file imports: another workspace through its emitted `dist/src` declarations,
 * a sibling module in the same workspace through its source, and the compiler
 * settings and installed packages behind both. So this runner fingerprints
 * every input a typed verdict can read (`typedLintInputs`) and clears every
 * group's cache (`node_modules/.cache/jsails-lint/<group>.eslintcache`) when
 * the fingerprint changes. Any TypeScript edit therefore relints everything;
 * the cache saves the run when no typed input changed (a re-run, a change to
 * scripts, templates, or docs). `--no-cache` (what `npm run check` and CI use)
 * lints everything from scratch. Other arguments are forwarded to every group
 * (for example `--fix`).
 *
 * Each ESLint child has an old-space ceiling (`heapMb`: 6 GiB for core,
 * 3 GiB for any other group), well above what it uses, so a runaway
 * fails fast with a heap-exhaustion abort instead of a verdict-free hang.
 *
 * Usage: node scripts/lint.mjs [--no-cache] [eslint args]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { runBudgeted } from './budgeted.mjs';
import { jobShare } from './machine-budget.mjs';
import { DEFAULT_PEAK_MB } from './process-tree.mjs';
import { exitStatus } from './subprocess.mjs';
import { repoRoot, workspaceDirs } from './workspaces.mjs';

export const CACHE_DIR = join(repoRoot, 'node_modules', '.cache', 'jsails-lint');
export const STAMP_FILE = join(CACHE_DIR, 'typed-inputs-fingerprint');
/** How many ESLint groups run at once by default. */
export const LINT_LANES = 2;

const TS_SOURCE = /\.tsx?$/;
const DECLARATION = /\.d\.ts$/;

function filesUnder(dir, pattern) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && pattern.test(entry.name)) files.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

/** The repo-relative, `/`-separated form of `path`. */
function repoRelative(root, path) {
  return relative(root, path).split('\\').join('/');
}

/**
 * The lint groups: `{ name, targets, ignores, heapMb, defaultMb }` each, core
 * first, then each package, the docs site, and `rest`, which lints `.` while
 * ignoring exactly the other groups' roots, so every file belongs to one
 * group.
 */
export function lintGroups({ root = repoRoot, workspaces = workspaceDirs() } = {}) {
  const roots = [];
  const groups = [];
  for (const dir of workspaces) {
    const path = repoRelative(root, dir);
    const core = path === 'core';
    roots.push(path);
    groups.push({
      name: core ? 'core' : path.split('/').join('-'),
      targets: [path],
      ignores: [],
      heapMb: core ? 6144 : 3072,
      defaultMb: core ? DEFAULT_PEAK_MB['lint-core'] : DEFAULT_PEAK_MB['lint-package'],
    });
  }
  if (existsSync(join(root, 'website'))) {
    roots.push('website');
    groups.push({
      name: 'website',
      targets: ['website'],
      ignores: [],
      heapMb: 3072,
      defaultMb: DEFAULT_PEAK_MB['lint-package'],
    });
  }
  groups.sort((a, b) => (a.name === 'core' ? -1 : b.name === 'core' ? 1 : 0));
  groups.push({
    name: 'rest',
    targets: ['.'],
    ignores: roots.map((path) => `${path}/**`),
    heapMb: 3072,
    defaultMb: DEFAULT_PEAK_MB['lint-package'],
  });
  return groups;
}

/** A group's ESLint cache file. */
export function cacheFileOf(group, dir = CACHE_DIR) {
  return join(dir, `${group.name}.eslintcache`);
}

/** The ESLint arguments of a group (after `node --max-old-space-size=… eslint.js`). */
export function groupArgs(group, { cached, forwarded = [], cacheDir = CACHE_DIR }) {
  const args = [...group.targets];
  for (const pattern of group.ignores) args.push('--ignore-pattern', pattern);
  if (cached) {
    args.push(
      '--cache',
      '--cache-strategy',
      'content',
      '--cache-location',
      cacheFileOf(group, cacheDir),
    );
  } else {
    args.push('--no-cache');
  }
  return [...args, ...forwarded];
}

/**
 * Every file a type-aware lint verdict can depend on: per workspace its
 * `src/` and `test/` sources, its emitted `dist/src` declarations, and its
 * `tsconfig.json`; the docs site's typed sources and configs; the shared
 * compiler options; and the lockfile (the installed packages' types).
 */
export function typedLintInputs({ root = repoRoot, workspaces = workspaceDirs() } = {}) {
  const files = [];
  for (const dir of workspaces) {
    files.push(
      ...filesUnder(join(dir, 'src'), TS_SOURCE),
      ...filesUnder(join(dir, 'test'), TS_SOURCE),
      ...filesUnder(join(dir, 'dist', 'src'), DECLARATION),
      join(dir, 'tsconfig.json'),
    );
  }
  const website = join(root, 'website');
  for (const part of ['pages', 'src', 'client']) {
    files.push(...filesUnder(join(website, part), TS_SOURCE));
  }
  files.push(
    join(website, 'tsconfig.json'),
    join(website, 'tsconfig.client.json'),
    join(root, 'tsconfig.base.json'),
    join(root, 'package-lock.json'),
  );
  return files.filter((file) => existsSync(file));
}

/** A digest of the given files' repo-relative paths and contents. */
export function inputFingerprint(files, base = repoRoot) {
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    hash.update(relative(base, file).split('\\').join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Clears every group's cache in `cacheDir` unless `stampFile` holds
 * `fingerprint`, then records it. Returns whether the caches were kept.
 */
export function prepareCache({ fingerprint, cacheDir, stampFile }) {
  const previous = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : undefined;
  const kept = previous === fingerprint;
  if (!kept && existsSync(cacheDir)) {
    for (const name of readdirSync(cacheDir)) {
      if (name.endsWith('.eslintcache')) rmSync(join(cacheDir, name), { force: true });
    }
  }
  mkdirSync(dirname(stampFile), { recursive: true });
  writeFileSync(stampFile, fingerprint);
  return kept;
}

/**
 * Lints `groups` in order, `lanes` at a time, through `runGroup` (resolves
 * with a `run` outcome carrying `output`), printing each group's output whole
 * as it ends. Resolves with the failed groups' names and statuses, in the
 * order of `groups` rather than the order they ended in.
 */
export async function lintAll(
  groups,
  { lanes, runGroup, write = (text) => process.stdout.write(text) },
) {
  const queue = [...groups];
  const failures = [];
  const worker = async () => {
    for (let group = queue.shift(); group !== undefined; group = queue.shift()) {
      const position = groups.indexOf(group);
      const started = Date.now();
      const outcome = await runGroup(group);
      const status = exitStatus(outcome);
      const verdict = status === 0 ? 'passed' : 'FAILED';
      write(`\n── lint ${group.name} ${verdict} (${Date.now() - started} ms) ──\n`);
      if (outcome.output !== undefined && outcome.output !== '') write(outcome.output);
      if (status !== 0) failures.push({ position, name: group.name, status });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, queue.length)) }, worker));
  return failures
    .sort((left, right) => left.position - right.position)
    .map(({ name, status }) => ({ name, status }));
}

async function main(argv) {
  const uncached = argv.includes('--no-cache');
  const forwarded = argv.filter((arg) => arg !== '--no-cache');
  const eslint = join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!uncached) {
    const fingerprint = inputFingerprint(typedLintInputs());
    const kept = prepareCache({ fingerprint, cacheDir: CACHE_DIR, stampFile: STAMP_FILE });
    if (!kept) console.log('lint: typed inputs changed since the cached run; linting everything.');
  }
  const failures = await lintAll(lintGroups(), {
    lanes: jobShare(LINT_LANES),
    runGroup: (group) =>
      runBudgeted({
        label: `lint:${group.name}`,
        defaultMb: group.defaultMb,
        command: process.execPath,
        args: [
          `--max-old-space-size=${group.heapMb}`,
          eslint,
          ...groupArgs(group, { cached: !uncached, forwarded }),
        ],
        options: { cwd: repoRoot, capture: true },
      }),
  });
  if (failures.length === 0) return 0;
  console.error(`\nlint failed in: ${failures.map(({ name }) => name).join(', ')}`);
  return failures[0].status;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
