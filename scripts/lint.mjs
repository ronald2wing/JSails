/**
 * Runs ESLint over the repository with a cache that is sound for type-aware
 * rules.
 *
 * ESLint's cache keys a file's result on that file's content and the config,
 * but a type-aware rule's verdict also depends on the types of everything the
 * file imports: another workspace through its emitted `dist/src` declarations,
 * a sibling module in the same workspace through its source, and the compiler
 * settings and installed packages behind both. So this runner fingerprints
 * every input a typed verdict can read (`typedLintInputs`) and clears the cache
 * when the fingerprint changes. Any TypeScript edit therefore relints
 * everything; the cache saves the run when no typed input changed (a re-run, a
 * change to scripts, templates, or docs). `--no-cache` (what `npm run check`
 * and CI use) lints everything from scratch. Other arguments are forwarded to
 * ESLint (for example `--fix`).
 *
 * Usage: node scripts/lint.mjs [--no-cache] [eslint args]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { exitStatus, run } from './subprocess.mjs';
import { repoRoot, workspaceDirs } from './workspaces.mjs';

export const CACHE_FILE = join(repoRoot, '.eslintcache');
export const STAMP_FILE = join(
  repoRoot,
  'node_modules',
  '.cache',
  'jsails-lint',
  'typed-inputs-fingerprint',
);

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
 * Clears `cacheFile` unless `stampFile` holds `fingerprint`, then records it.
 * Returns whether the cache was kept.
 */
export function prepareCache({ fingerprint, cacheFile, stampFile }) {
  const previous = existsSync(stampFile) ? readFileSync(stampFile, 'utf8') : undefined;
  const kept = previous === fingerprint && existsSync(cacheFile);
  if (!kept) rmSync(cacheFile, { force: true });
  mkdirSync(dirname(stampFile), { recursive: true });
  writeFileSync(stampFile, fingerprint);
  return kept;
}

async function main(argv) {
  const uncached = argv.includes('--no-cache');
  const forwarded = argv.filter((arg) => arg !== '--no-cache');
  const eslint = join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const args = [eslint, '.', ...forwarded];
  if (uncached) {
    args.push('--no-cache');
  } else {
    const fingerprint = inputFingerprint(typedLintInputs());
    const kept = prepareCache({ fingerprint, cacheFile: CACHE_FILE, stampFile: STAMP_FILE });
    if (!kept) console.log('lint: typed inputs changed since the cached run; linting everything.');
    args.push('--cache', '--cache-strategy', 'content', '--cache-location', CACHE_FILE);
  }
  return exitStatus(await run(process.execPath, args, { cwd: repoRoot }));
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
